import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  effectiveReplyTo,
  formDefinitionSchema,
  recipientQuestionIds,
  type FormDefinition,
  type Notification as NotificationView,
  type NotificationCreate,
  type NotificationListResponse,
  type NotificationUpdate,
  type ReplyToLevel,
} from '@formsache/shared';
import type { Notification, Prisma } from '@prisma/client';

import { requireFullForm } from '../forms/forms.service';
import { SystemMailSettingsService } from '../system-settings/system-mail-settings.service';
import { TenantNotificationTemplatesService } from '../tenant-admin/tenant-notification-templates.service';
import type { NotificationWrite, TenantScope } from '../tenancy/tenant-scope';
import { isUuid } from '../common/uuid';
import {
  addressQuestions,
  parseStoredRecipients,
} from './notification-questions';

/**
 * The one answer for a notification the caller may not see.
 *
 * The same string for „gibt es nicht" and „gehört einer anderen Organisation", for the
 * reason `FORM_NOT_FOUND_MESSAGE` spells out: a 403 on the second would confirm
 * that the id exists somewhere on the platform.
 */
export const NOTIFICATION_NOT_FOUND_MESSAGE =
  'Benachrichtigung nicht gefunden.';

/** A recipient naming a question the form does not have — or not one with an address. */
export function unknownRecipientQuestionMessage(questionId: string): string {
  return (
    `Der Empfänger verweist auf eine Frage, die es in diesem Formular nicht ` +
    `gibt oder die keine E-Mail-Adresse liefert (${questionId}).`
  );
}

/**
 * Notifications of one form.
 *
 * **No `PrismaService` in the constructor**, like `FormsService` and
 * `FormSettingsService`: the only way to a *tenant* row is the `TenantScope`
 * the guard chain hands in, so „den Tenant vergessen" would be a visible change
 * to this constructor rather than a missing `where` key.
 *
 * **`TenantNotificationTemplatesService`** reads the **calling**
 * organisation's own row (ADR-0032) — the `scope` is passed in on every call,
 * the same as every other tenant-bound read in this class.
 *
 * **`SystemMailSettingsService`** is the one dependency left that reads an
 * installation-wide row and is *installationsweit* by construction: it cannot
 * be asked about an organisation.
 * `SystemMailSettingsService.replyToDefaults` does take the values of an
 * organisation as an argument, but reads no
 * `tenant` row itself for that (ADR-0011 no. 7). This class passes those values in out of the
 * `TenantScope` and out of nothing else
 * ({@link NotificationsService.inheritedReplyTo}).
 *
 * **What this service deliberately does not do: send anything.** It stores what
 * a mail will say. The trigger at the submission and the queue live in
 * separate packages — and the separation is the reason the non-goal below is provable at all.
 *
 * **„Bei Zwischenspeichern" is absent, not disabled.** The write schemas accept
 * only `submit` (`notificationTriggerInputSchema` in `@formsache/shared`), so the
 * refusal is the server's and not the editor's — a non-goal enforced only in
 * the UI is a non-goal until somebody uses curl. Reading stays wide: a `save`
 * row written straight into the database is listable, because a read that
 * refused it would turn a row the application correctly ignores into a page
 * nobody can open.
 */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly templates: TenantNotificationTemplatesService,
    /**
     * The two **lower** levels of the `Reply-To` chain — the
     * only way this service ever gets at an installation-wide row,
     * and the same seam the public sending path and the
     * Testmail use.
     *
     * Without them this module could not name the **effective** reply address
     * (the requirement): it knows only the topmost level, and that was exactly
     * the state this change ends. No `PrismaService` comes
     * in through it — the service reads no `tenant` row but only the
     * one `system_setting` row (ADR-0011 no. 7); the organisation's values
     * are passed in by this class out of the `TenantScope`.
     */
    private readonly systemMail: SystemMailSettingsService,
  ) {}

  /**
   * Every notification of one form, oldest first — **and the templates this
   * organisation currently offers** (ADR-0032).
   *
   * The templates come from `tenant.notification_templates`, not from a
   * constant: this organisation edits them and the editor has to be offered
   * what it wrote. They travel with this response rather than on a route of
   * their own so that the offer and the rows it sits beside come from one
   * moment; the permission is the same either way.
   *
   * **They are handed out, never written into a row here.** A template becomes
   * a notification when somebody applies it and saves — `create` below stores
   * the text the request carries and nothing else. That is the copy the design
   * asks for, and it is why changing a template afterwards leaves every existing
   * notification exactly as it was.
   */
  async listOfForm(
    scope: TenantScope,
    formId: string,
  ): Promise<NotificationListResponse> {
    await this.requireFormRow(scope, formId);
    const rows = await scope.notifications.findManyOfForm(formId);
    // **Once per request, not per row**: the two lower levels are
    // the same for every notification of a form, and a read per
    // row would be one query per row for an answer that does not change.
    const inherited = await this.inheritedReplyTo(scope);
    return {
      notifications: rows.map((row) => toView(row, inherited)),
      templates: await this.templates.forEditor(scope),
      /*
       * **The same two levels once more, raw** (the requirement) — for the
       * question `effectiveReplyTo` *cannot* answer per row: „what
       * applies if I save the field like this?", and „what applies to a
       * notification that does not exist yet?". The editor puts its
       * topmost level in front of them and calls the same shared function; no
       * second chain comes into being in doing so (`notificationListResponseSchema`).
       *
       * `undefined` does not come out here — `replyToDefaults` delivers
       * `string | null` for both levels —, but the type of `ReplyToLevel` allows
       * it, so it is normalised to `null` here instead of disappearing out of the
       * JSON.
       */
      inheritedReplyTo: inherited.map((level) => ({
        origin: level.origin,
        value: level.value ?? null,
      })),
    };
  }

  /** Adds a notification to a form of this organisation. */
  async create(
    scope: TenantScope,
    formId: string,
    request: NotificationCreate,
  ): Promise<NotificationView> {
    const draft = await this.requireDraft(scope, formId);
    this.checkRecipients(draft, request);

    const row = await scope.notifications.create(formId, toWrite(request));
    return toView(row, await this.inheritedReplyTo(scope));
  }

  /**
   * Replaces one notification — `PUT`, so what a request does not say is not
   * kept. The same whole-document semantics the settings and the form
   * definition already use; a partial write of a mail text is how half a
   * template survives an edit nobody reviewed.
   */
  async replace(
    scope: TenantScope,
    formId: string,
    notificationId: string,
    request: NotificationUpdate,
  ): Promise<NotificationView> {
    const draft = await this.requireDraft(scope, formId);
    await this.requireNotification(scope, formId, notificationId);
    this.checkRecipients(draft, request);

    const written = await scope.notifications.update(
      notificationId,
      toWrite(request),
    );
    if (!written) {
      // Resolved one statement ago, so a miss here means it was deleted in
      // between — which is the same answer an outsider gets.
      throw new NotFoundException(NOTIFICATION_NOT_FOUND_MESSAGE);
    }

    const row = await this.requireNotification(scope, formId, notificationId);
    return toView(row, await this.inheritedReplyTo(scope));
  }

  /**
   * Deletes a notification. Physically — it is configuration, not personal
   * data, and the trash is about forms and answers only. The
   * `mail_log` rows it produced survive (`notification_id` is `SetNull`).
   */
  async remove(
    scope: TenantScope,
    formId: string,
    notificationId: string,
  ): Promise<void> {
    await this.requireFormRow(scope, formId);
    await this.requireNotification(scope, formId, notificationId);

    const removed = await scope.notifications.remove(notificationId);
    if (!removed) {
      throw new NotFoundException(NOTIFICATION_NOT_FOUND_MESSAGE);
    }
  }

  /**
   * The two **lower** levels of the `Reply-To` chain of this organisation
   * (the requirement) — the organisation, then the installation.
   *
   * **The organisation comes from the scope, never from a parameter.** `scope.tenant`
   * is bound to the session, so „which organisation" is not a question here that
   * anybody could answer wrongly — the same shape `TenantReplyToService`
   * has for the write side of the same field, and the narrow projection
   * (`replyTo` alone) is the one that already stands there.
   *
   * The **evaluation** is not here: what comes back are the raw values
   * of two levels. Together with the topmost one, {@link toView} evaluates them in
   * a single `effectiveReplyTo`.
   *
   * ## Why `can_manage_form_settings` alone is enough here although
   * `/tenant/reply-to` demands two rights — decided in the review of package
   * 0-A (2026-08-06)
   *
   * It is the same row: `tenant.reply_to` is read here, and
   * `TenantReplyToController` demands `can_manage_settings` **and**
   * `can_view_responses` for it (on reading *and* writing). The asymmetry is
   * intended, and it arises exactly here — which is why the reasoning stands here
   * and not there.
   *
   * Since ADR-0021 the distance is even **greater** than when
   * this reasoning was written down: the notifications hang off the right *per form*,
   * the reply address of the organisation off the organisation-wide one. The two
   * rights are now different, no longer the same one under two
   * additional conditions — and the reasoning below carries that unchanged, because
   * it never hung off the name of the right but off the fact that a
   * `Reply-To` line is not a secret.
   *
   * **What the pair protects against there.** `SmtpConfigController` gives the reason and
   * the two neighbouring routes mirror it explicitly („gespiegelt statt neu
   * entschieden", `TenantBaseUrlController`): whoever names the *mail server* of an
   * organisation names the machine every notification runs
   * through — bodies included, and those carry answers. So the pair guards
   * the **tab** and the **writing** at this sending identity, not
   * the confidentiality of this one value.
   *
   * **The reply address is not a secret.** It stands as the `Reply-To` header in
   * *every* mail this organisation sends, so it is known to every recipient
   * — and this caller is the one who writes those mails. They can learn it
   * today already without a second right: hang a literal recipient address on
   * a notification of a published form
   * (`can_manage_form_settings`), fill in the public form (anybody
   * may do that) — the mail arrives with the header line. Hiding it from them on the page
   * where they set it prevented nothing and cost exactly
   * what the requirement ends: the detour over a Testmail.
   *
   * **And the opposite would be expensive.** Demanding `can_view_responses` here
   * would mean demanding a right to **answer data** for a configuration
   * row — „rights that are asked for without reason are the ones that get
   * handed out" (`NotificationsController`). The read document of this route
   * carries a template, never an answer; the inherited address changes nothing
   * about that, for it is typed configuration and taken from no answer
   * (the same category from which `mail_log.reply_to` does **not** belong to the columns
   * physical deletion empties, `mail-log-erasure.ts`).
   *
   * Proved rather than claimed: „gives a settings-only member the effective
   * address" in `test/notifications/notifications.spec.ts` measures both halves
   * — the 200 here and the 403 at `GET /tenant/reply-to` of the same session.
   */
  private async inheritedReplyTo(
    scope: TenantScope,
  ): Promise<readonly ReplyToLevel[]> {
    const row = await scope.tenant.replyTo();
    return this.systemMail.replyToDefaults({
      id: scope.tenantId,
      // `null` for an organisation that no longer exists: the chain then falls
      // one level deeper, instead of the reading of a notification failing on a
      // deleted row.
      replyTo: row?.replyTo ?? null,
    });
  }

  /**
   * The recipient rules — the only place they are decided.
   *
   * Checked against the **draft**, not against the version in force: the editor
   * configures the form they are building, and the published document is what
   * the requirement guards on the way out. Validating against the union of both
   * would accept a recipient that publishing then refuses, which is the same
   * rule stated twice with two answers.
   *
   * The count limit is not repeated here — `notificationCreateSchema` carries
   * `MAIL_RECIPIENT_LIMIT`, and a second bound is a second number to keep in
   * step.
   */
  private checkRecipients(
    draft: FormDefinition,
    request: NotificationWriteRequest,
  ): void {
    const addressable = new Set(
      addressQuestions(draft).map((question) => question.id),
    );

    for (const questionId of recipientQuestionIds(request.recipients)) {
      if (!addressable.has(questionId)) {
        throw new UnprocessableEntityException(
          unknownRecipientQuestionMessage(questionId),
        );
      }
    }
    // Participant delivery used to be checked here through a second,
    // independent `toSubmitter` flag on the way in: „no addressable question
    // at all in the form" and „the flag is set without a question recipient".
    // Both are unreachable now that `toSubmitter` is gone from the write
    // schema and `addressesSubmitter` is exactly `recipientQuestionIds(
    // request.recipients).length > 0` (see below). If that is true, the loop
    // above has already walked at least one such question id through
    // `addressable.has` without throwing — which makes `addressable`
    // non-empty by construction, so „no addressable question" can never
    // co-occur with „has a question recipient". And „has a question recipient
    // but the count of question recipients is zero" contradicts itself.
    // There is nothing left to check past the loop: a question recipient
    // *is* participant delivery, unconditionally.
  }

  /**
   * The form, or the single 404 every form surface answers with.
   *
   * `requireFullForm` rather than the lean settings projection: this surface
   * needs `draft_schema` — the recipient rules are decided against the
   * questions the editor is actually looking at — and one lookup that carries
   * it is better than a second projection nobody else asks for.
   */
  private requireFormRow(scope: TenantScope, formId: string) {
    return requireFullForm(scope, formId);
  }

  /** The form's draft definition — what the recipient rules are checked against. */
  private async requireDraft(
    scope: TenantScope,
    formId: string,
  ): Promise<FormDefinition> {
    const form = await this.requireFormRow(scope, formId);
    const parsed = formDefinitionSchema.safeParse(form.draftSchema);
    if (!parsed.success) {
      throw new BadRequestException(
        'Die gespeicherte Formulardefinition ist ungültig.',
      );
    }
    return parsed.data;
  }

  /**
   * One notification of this form, or the single 404.
   *
   * The **form** binding is checked here rather than left to the delegate: the
   * delegate binds the tenant (and the composite key binds the form to the
   * Organisation), but nothing stops `/forms/A/notifications/<id of a notification of
   * form B>` from resolving inside the same organisation. Two forms of one organisation are not
   * a security boundary, but they are a correctness one — a `PUT` under the
   * wrong form would edit a mail the editor is not looking at.
   */
  private async requireNotification(
    scope: TenantScope,
    formId: string,
    notificationId: string,
  ): Promise<Notification> {
    if (!isUuid(notificationId)) {
      // An unparseable uuid literal makes PostgreSQL raise, and a 500 would
      // tell the sender their string got that far.
      throw new NotFoundException(NOTIFICATION_NOT_FOUND_MESSAGE);
    }

    const row = await scope.notifications.findById(notificationId);
    if (row?.formId !== formId) {
      // Covers both „no such row" and „a row of another form of this organisation" —
      // `undefined !== formId` is true, and the answer to the two is the same.
      throw new NotFoundException(NOTIFICATION_NOT_FOUND_MESSAGE);
    }
    return row;
  }
}

/**
 * What a create and an update alike say — today the very same shape.
 *
 * `NotificationCreate` stands in for both rather than a union of the two,
 * because a union of two identical types is not a union. The two *schemas* stay
 * separate on purpose (a `replyTo` belongs elsewhere), and the day they differ this
 * alias stops accepting an update — a compile error exactly where the two rules
 * would otherwise have quietly become one.
 */
type NotificationWriteRequest = NotificationCreate;

/**
 * Whether this notification is addressed to the person who filled the form in
 * — **derived from the recipients**, entirely.
 *
 * A recipient of kind `question` reads its address out of the answer, so it is
 * the participant's address by construction. There used to be a second,
 * independent `toSubmitter` flag a client could set on the way in; the two
 * could disagree — a notification could carry the chip and clear the flag, and
 * the effective setting *Bestätigung an Teilnehmer senden* — which is
 * **the** switch — then did not apply to it. `toSubmitter` is no longer
 * part of `notificationCreateSchema`/`notificationUpdateSchema`,
 * so there is nothing left to disagree with: the chip is the only statement.
 *
 * Derived rather than refused, deliberately. A 422 („bitte auch das Häkchen
 * setzen") would ask an editor to state twice what they said once, and it would
 * make a correct client a precondition for a correct row. Here the chip *is*
 * the statement, so the stored row is self-consistent no matter which client
 * wrote it.
 *
 * The **enforcement** does not depend on this either way: `submissionMails`
 * derives the same property again at send time — tolerating a row written
 * straight into the database, where a hand-set `toSubmitter` column is still
 * read (the column itself was never removed, only the input schema).
 */
export function addressesSubmitter(request: NotificationWriteRequest): boolean {
  return recipientQuestionIds(request.recipients).length > 0;
}

/** A request as the delegate takes it — the one place the two shapes meet. */
function toWrite(request: NotificationWriteRequest): NotificationWrite {
  return {
    name: request.name,
    triggers: request.triggers,
    format: request.format,
    toSubmitter: addressesSubmitter(request),
    // Validated by `notificationCreateSchema` on the way in, so what is stored
    // is what the shared schema describes — never an unchecked body.
    recipients: request.recipients satisfies Prisma.InputJsonValue,
    subject: request.subject,
    body: request.body,
    // `null` is not an empty entry here but the inheritance —
    // „what the organisation or the system prescribes applies". The chain itself is
    // in `effectiveReplyTo` and is applied at enqueue time, not here.
    replyTo: request.replyTo,
    active: request.active,
  };
}

/**
 * A row as the wire describes it.
 *
 * The recipients are **parsed** on the way out, not cast: JSONB accepts any
 * JSON, so a hand-edited row could hold anything. A row this application did
 * not write is reported — with its name, so it can be found — rather than shown
 * as „keine Empfänger", which is the variant where the editor presses „Speichern"
 * and silently deletes addresses nobody could see. The cost is named: one
 * damaged row makes the list of that form unreadable until it is repaired.
 */
function toView(
  row: Notification,
  /**
   * The two levels below this notification, in the order in which
   * they apply ({@link NotificationsService.inheritedReplyTo}).
   */
  inheritedReplyTo: readonly ReplyToLevel[],
): NotificationView {
  const recipients = parseStoredRecipients(row.recipients);
  if (recipients === null) {
    throw new BadRequestException(
      `Die gespeicherten Empfänger der Benachrichtigung „${row.name}" sind ungültig.`,
    );
  }

  return {
    id: row.id,
    formId: row.formId,
    name: row.name,
    triggers: row.triggers,
    format: row.format,
    toSubmitter: row.toSubmitter,
    recipients,
    subject: row.subject,
    body: row.body,
    replyTo: row.replyTo,
    /*
     * **The effective value and its origin — delivered by the chain, not
     * computed here** (the requirement).
     *
     * The obvious shortcut would be `row.replyTo ?? …`; it would be a second
     * version of the rule and would not know the second gate at which a set
     * but unusable value falls through — it would say `notification` about a
     * mail that carries the organisation's address. Hence: one call, three levels.
     */
    effectiveReplyTo: effectiveReplyTo([
      { origin: 'notification', value: row.replyTo },
      ...inheritedReplyTo,
    ]),
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
