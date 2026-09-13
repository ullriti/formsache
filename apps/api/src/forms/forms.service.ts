import { randomBytes, randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  FORM_PRIVACY_TEMPLATE,
  chooseColumns,
  csvColumns,
  duplicateFormDefinition,
  findUnresolvableConditions,
  formDefinitionSchema,
  formSettingsOverrideSchema,
  hasUnpublishedChanges,
  legalPageStatus,
  parseStoredFormPrivacyNotice,
  parseStoredTenantLegalPages,
  publishDiff,
  renderRow,
  renderSchemalessRow,
  responseColumnGroups,
  responseColumns,
  rewriteQuestionPlaceholders,
  rewriteRecipientQuestionIds,
  rowMatchesSearch,
  tenantLegalStatus,
  unresolvableConditionMessage,
  writeExport,
  type AnswerMap,
  type CreateFormRequest,
  type CsvRow,
  type ExportBody,
  type ExportFormat,
  type FormDefinition,
  type FormDetail,
  type FormListQuery,
  type FormListPage,
  type FormSummary,
  type FormVersionSnapshot,
  type Permissions,
  type PublishBlocked,
  type PublishPreview,
  type ResponseColumnSet,
  type ResponseDetail,
  type UpdateFormRequest,
} from '@formsache/shared';
import type { Form, FormVersion, Prisma } from '@prisma/client';

import { FORM_NOT_FOUND_MESSAGE } from '../common/form-not-found';
import {
  FORM_TEMPLATE_NOT_A_FORM_MESSAGE,
  FORM_TEMPLATE_SETTINGS_INVALID_MESSAGE,
  parseStoredTemplateContent,
  requireTemplate,
} from '../form-templates/form-template-content';
import { isUuid } from '../common/uuid';
import {
  findOrphanedPlaceholders,
  orphanedPlaceholderMessage,
  parseStoredRecipients,
} from '../notifications/notification-questions';
import { stripOverridePassword } from '../settings/settings-document';
import type { FormRestriction } from '../tenancy/form-restriction';
import type {
  FormWithCounts,
  NotificationWrite,
  TenantScope,
} from '../tenancy/tenant-scope';

/**
 * A published snapshot together with the row it came from.
 *
 * The `id` never leaves this module — it is what tells the answered versions
 * apart from the merely published ones — and is stripped before the set goes
 * on the wire.
 */
type StoredSnapshot = FormVersionSnapshot & { readonly id: string };

/**
 * The one answer for a form the caller may not see — „no such form", „a form of
 * another organisation", „in the trash" and, since the requirement, „der Zugriff
 * ist Ihnen entzogen", all through the same door.
 *
 * Re-exported rather than declared here since the fourth link of the guard
 * chain started answering with it as well: the two answers have to be
 * byte-identical, and the reasoning lives with the constant in
 * `common/form-not-found.ts`.
 */
export { FORM_NOT_FOUND_MESSAGE };

/**
 * Answer to a save that started from a state someone else has already
 * replaced.
 *
 * A message the editor can act on, not a constraint name: it says what
 * happened and what to do, because the alternative — silently winning — is the
 * bug this whole path exists to prevent.
 */
export const STALE_REVISION_MESSAGE =
  'Das Formular wurde zwischenzeitlich geändert. Bitte neu laden.';

/**
 * Answer to a publish that would mint a second, identical version (client
 * decision, 2026-07-27).
 *
 * **Deliberately not {@link STALE_REVISION_MESSAGE}, and deliberately not 409.**
 * The two refusals mean opposite things and ask for opposite reactions: „bitte
 * neu laden, jemand war schneller" against „es gibt schlicht nichts zu tun".
 * The client can only tell them apart by the status code — `ApiError` carries
 * no error code beyond it — and telling an editor to reload because their form
 * is already up to date is exactly the kind of wrong advice this whole work
 * item is about. 422 is the honest reading: the request is well-formed, carries
 * the right revision and comes from someone allowed to publish; it simply asks
 * for a state the resource is already in.
 */
export const NOTHING_TO_PUBLISH_MESSAGE =
  'Es gibt nichts zu veröffentlichen: Der Entwurf entspricht bereits der veröffentlichten Fassung.';

/**
 * Bytes of randomness behind a public form URL.
 *
 * 16 bytes → 128 bits, base64url-encoded. The address of a public form is the
 * only thing standing between a draft-turned-active Jahrestagung registration
 * and anyone who guesses; the row id would have been the obvious choice and is
 * exactly wrong, because UUIDv7 is time-ordered and therefore partly
 * predictable from a single known value.
 */
const PUBLIC_SLUG_BYTES = 16;

/**
 * **The order of the form list — and the reason it has two fields**.
 *
 * „Zuletzt geändert zuerst" is the dashboard's order and stays the dashboard's
 * order; `id` is a **tiebreaker**, not a second sort anybody reads. Without it
 * the order is only *partially* defined, and PostgreSQL is free to return rows
 * with equal `updated_at` in whatever order the plan produces — which for a
 * `LIMIT`/`OFFSET` query is a top-N heapsort whose result genuinely differs
 * between `LIMIT 5` and `LIMIT 10`. Two forms saved in the same millisecond are
 * then not a curiosity but a wrong list: one of them appears on two pages and
 * the other on none, and the payload is the right *length* both times, which is
 * why nothing notices.
 *
 * `id` rather than `title` or `created_at`: it is the primary key, so it is
 * unique by construction and the total order is guaranteed rather than likely.
 * That it is a UUIDv7 — time-ordered — makes the tie itself read sensibly
 * (newer form first) instead of arbitrarily, but the tiebreaker would do its
 * job with any unique column.
 *
 * ⚠️ **`descending`, matching `updatedAt`.** A tiebreaker that ran the other
 * way would still be stable; it would simply order ties confusingly. What it
 * must never be is *absent*.
 */
const FORM_LIST_ORDER: Prisma.FormOrderByWithRelationInput[] = [
  { updatedAt: 'desc' },
  { id: 'desc' },
];

/**
 * „Formulare, deren Titel den Suchbegriff enthalten" — as a **condition**, not
 * as a filter over the loaded page.
 *
 * The whole point of the search living here is that it runs before `LIMIT`: a
 * client-side filter searches the twenty-four forms it happens to hold and
 * reports „keine Treffer" for a form on page three. That is not a narrower
 * answer, it is a false one — and it is the failure most likely to go
 * unnoticed.
 *
 * `mode: 'insensitive'` because a person typing „jahrestagung" is looking for
 * „Jahrestagung". `contains` and not a full-text search: titles are one short
 * line, the concept plans for ~50 organisations with dozens of forms each,
 * and a `tsvector` index would be machinery in front of a table that fits in
 * memory.
 *
 * An empty term is **no condition at all** rather than `contains: ''`. The two
 * select the same rows today; only one of them still says what it means if the
 * column ever becomes nullable.
 *
 * ⚠️ **The term is escaped, because `contains` is `LIKE` and Prisma does not
 * escape it** (review finding). `contains: x` compiles to
 * `title ILIKE '%' || x || '%'` with the term inserted **verbatim**, so
 * `LIKE`'s two wildcards travel with it: a search for `%` matched every form of
 * the organisation and the dashboard announced „2748 Treffer für „%"", and a literal
 * search for `50%` reported „500 Jahre" as a hit. Neither is a security hole —
 * the tenant and the restriction are conditions of their own and a wildcard
 * cannot widen past them — but both are wrong answers to a question a person
 * asked, which is what {@link searchFilter} exists to prevent.
 */
function searchFilter(search: string): Prisma.FormWhereInput {
  return search === ''
    ? {}
    : { title: { contains: escapeLikeTerm(search), mode: 'insensitive' } };
}

/**
 * Makes a search term mean **itself** inside a `LIKE`/`ILIKE` pattern.
 *
 * PostgreSQL's `LIKE` treats `%` as „any run of characters" and `_` as „any one
 * character", and escapes both with a backslash — the default escape character
 * when no `ESCAPE` clause is given, which is the shape Prisma emits. The
 * backslash therefore has to be escaped **first**, or escaping `%` afterwards
 * would produce the escape for a backslash somebody typed rather than for the
 * percent sign next to it.
 */
function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/gu, (character) => `\\${character}`);
}

/**
 * Resolves a form of the scope, or raises the one 404 .
 *
 * A module-level function rather than a method, because a second surface needs
 * it: the settings routes live in their own module and must answer a
 * foreign form **byte-identically** to an unknown id. Re-implementing the
 * lookup there would have been two places to keep in step — and the way that
 * drift shows up is a 403 or a 500 where a 404 was promised, which is exactly
 * the leak the single message exists to prevent.
 *
 * The **projection** is the caller's, the **refusal** is not: `find` says which
 * columns are wanted (the settings routes need neither the published version
 * nor the answer count), while the malformed id, the foreign id, the unknown
 * id and the one in the trash all leave through the same door.
 */
export async function requireForm<T extends { deletedAt: Date | null }>(
  id: string,
  find: (id: string) => Promise<T | null>,
): Promise<T> {
  // Checked before the database sees it: an unparseable uuid literal makes
  // PostgreSQL raise, and a 500 tells the sender their string got that far.
  if (!isUuid(id)) {
    throw new NotFoundException(FORM_NOT_FOUND_MESSAGE);
  }

  const form = await find(id);
  if (form === null) {
    throw new NotFoundException(FORM_NOT_FOUND_MESSAGE);
  }
  if (form.deletedAt !== null) {
    // Deleted forms are in the trash and answer like unknown ones.
    throw new NotFoundException(FORM_NOT_FOUND_MESSAGE);
  }
  return form;
}

/** {@link requireForm} with the full projection the form routes use. */
export function requireFullForm(
  scope: TenantScope,
  id: string,
): Promise<FormWithCounts> {
  return requireForm(id, (formId) => scope.forms.findById(formId));
}

/**
 * Forms of the current tenant.
 *
 * **No `PrismaService` here**, and that is load-bearing: no method in this
 * class can reach a *fachliche* row except through the `TenantScope` a caller
 * hands in — and that object carries the tenant into every statement it issues
 * . Forgetting the tenant would mean acquiring a client
 * first, which is a visible change to this constructor rather than an omitted
 * `where` key; the ESLint fence in `eslint.config.js` makes it a build error
 * besides.
 *
 * **And no dependency at all any more.** This class used to hold one, a reader
 * of the installation-wide settings layer, so that {@link FormsService.create}
 * could judge the settings a template carries against it. That layer is gone
 * (ADR-0011, continuation 2026-08-14): a section nobody decided falls to the
 * shipped constant, which is a value and not a row, so the judgement needs no
 * read and the constructor no argument.
 */
@Injectable()
export class FormsService {
  /**
   * Every form of the organisation the caller may see, newest change first — the
   * dashboard's order.
   *
   * **The per-form restriction is part of the statement, not a filter after it**
   * (first reproduction). `FormRestrictionGuard` cannot narrow
   * a list — a guard answers yes or no to one request — so it hands the handler
   * a query fragment instead, and the fragment goes into the `where`. A form
   * somebody is locked out of therefore never leaves PostgreSQL: it is not in
   * the payload to be hidden by a client, which is the difference between a
   * boundary and an Anzeigefrage.
   *
   * The restriction is a **parameter and not a lookup**, for the reason the
   * tenant is: a method that resolved „who is asking" itself would be a method
   * that can resolve it differently from the guard, or forget to.
   */
  async list(
    scope: TenantScope,
    restriction: FormRestriction,
    query: FormListQuery,
  ): Promise<FormListPage> {
    // **One `where`, built once, used by both statements.** The count and the
    // page have to answer under identical conditions or „24 von 2748" is a
    // sentence about two different lists — and the half that would be wrong is
    // always the one nobody looks at.
    //
    // Every narrowing lives in here, which is what makes the guarantee
    // hold *per page*: `skip`/`take` below select a window **out of
    // this statement**, so page seven is filtered by exactly what page one was.
    // The failure mode being avoided — „den Filter nur auf die erste
    // Abfrage anwenden" — has no spelling here that is not visibly a special
    // case.
    const where = {
      // The trash: a deleted form is gone from every list, and the
      // filter states that rather than assuming no row carries the column.
      deletedAt: null,
      // The per-form restriction as part of the statement, not as a filter
      // after it (first reproduction). `FormRestrictionGuard`
      // cannot narrow a list — a guard answers yes or no to one request — so it
      // hands the handler a query fragment instead. A form somebody is locked
      // out of therefore never leaves PostgreSQL.
      ...restriction.formFilter(),
      ...searchFilter(query.q),
      ...(query.id === undefined ? {} : { id: query.id }),
    };

    const [total, activeTotal, responseTotal, forms] = await Promise.all([
      scope.forms.countMatching(where),
      // „Aktiv" — the same statement with one more condition, deliberately not
      // `items.filter(...)`: the page is twenty-four cards and the tile is about
      // the organisation.
      scope.forms.countMatching({ ...where, status: 'active' }),
      scope.forms.countResponsesIn(where),
      scope.forms.findManyWithCounts({
        where,
        orderBy: FORM_LIST_ORDER,
        skip: query.offset,
        take: query.limit,
      }),
    ]);

    // The **effective** rights per card (the requirement): one read of
    // this person's `form_permission` rows for the whole list, weighed by the
    // same `FormRestriction` the guard chain decides with. A cap does not hide
    // a form — it answers 403, not 404 — so a capped form *is* in this list and
    // has to say what may be done with it.
    const byForm = await restriction.effectivePermissionsIn(scope);

    return {
      items: forms.map((form) => ({
        ...toSummary(form, form.publishedVersion),
        responseCount: form._count.responses,
        permissions: byForm.get(form.id) ?? restriction.heldPermissions,
      })),
      total,
      activeTotal,
      responseTotal,
      // Echoed **as applied**, never as asked for: `query` has already been
      // through `formListQuerySchema`, so a `limit=100000` arrives here as the
      // ceiling and leaves as the ceiling.
      limit: query.limit,
      offset: query.offset,
    };
  }

  /** One form with the definition the builder edits. */
  async byId(
    scope: TenantScope,
    id: string,
    restriction: FormRestriction,
  ): Promise<FormDetail> {
    const form = await requireFullForm(scope, id);
    const definition = parseStoredDefinition(form.draftSchema);
    return {
      ...toSummary(form, form.publishedVersion),
      responseCount: form._count.responses,
      permissions: await this.permissionsOn(scope, id, restriction),
      definition,
      revision: form.revision,
      publicSlug: form.publicSlug,
      // The same function `publish()` refuses on, so the button the builder
      // offers and the answer it gets cannot disagree (client decision,
      // 2026-07-27). No extra query: the snapshot in force is already joined.
      hasUnpublishedChanges: hasUnpublishedChanges(
        publishedDefinition(form),
        definition,
      ),
    };
  }

  /**
   * The effective rights on **one** form (the requirement) — the
   * single-form counterpart of the batch `list` makes.
   *
   * The read lives here and the decision does not: this method fetches the row
   * and hands it to `FormRestriction`, which is the one place that knows what a
   * row *means*. That split is the same one `FormRestrictionGuard` makes, and
   * it is why the detail payload and the guard on the very next request cannot
   * answer differently.
   */
  private async permissionsOn(
    scope: TenantScope,
    formId: string,
    restriction: FormRestriction,
  ): Promise<Permissions> {
    const restricted = restriction.restrictedUserId();
    if (restricted === undefined) {
      // An administrator: their rows are not read (`isRestrictable`).
      return restriction.heldPermissions;
    }
    return restriction.effectivePermissionsFor(
      await scope.formPermissions.findFor(formId, restricted),
      (groupId) => scope.groups.findById(groupId),
    );
  }

  /**
   * Creates a form: empty — one page, no questions — or **from a template of
   * this organisation** .
   *
   * Empty rather than blank — `formDefinitionSchema` requires at least one
   * page, so "no definition yet" is not a state that could be stored and would
   * have to be handled everywhere downstream.
   *
   * **A template is a branch here and not a second door.** A form comes into
   * existence in exactly one place, so „mit oder ohne Vorlage" is decided here
   * rather than by a second route that would have to remember the public
   * address, the first page, the response count and the permissions all over
   * again. What the template contributes is the definition — **with fresh ids**,
   * so two forms made from one template never share a question id — and the
   * settings document it was saved with.
   *
   * The **title stays the caller's**, even though the template carries one: the
   * dialog prefills from it, but a template used twice would otherwise produce
   * two identically named forms on the dashboard.
   *
   * **The settings of the template are checked, not passed through**
   * — added later. Until then this method cast the stored
   * document straight into the column, on the argument that the write path had
   * already validated it — and the write path is not the only source of a row.
   * *Measured on 2026-08-05:* a hand-written `form_template` line carrying
   * `{values:{passwordEnabled:true,password:"KLARTEXT-GEHEIM"}}` plus an
   * unknown key produced a **201**, stored both byte for byte, and left
   * `GET /forms/:id/settings` answering **500** for good — the one page that
   * could have repaired it. What runs here now is the same pair the settings
   * write path runs, in this order and each for its own reason:
   *
   * 1. `stripOverridePassword` — the access word cannot travel, and now that is
   *    true of *this* method as well as of `FormTemplatesService.save`. A word
   *    in a stored template is either plaintext (hand-written) or a blob sealed
   *    under some other row's context (`formOverrideContext`), and neither may
   *    become this form's password: the first is a secret nobody set, the
   *    second is a value nothing can ever open. Afterwards there is provably no
   *    word left, which is why the document below needs no sealing — sealing is
   *    `mapOverridePassword` over an entry that is no longer there.
   * 2. `formSettingsOverrideSchema` — the cross-field rules
   *    (`checkSettingsConsistency`), which the wire contract of a template
   *    deliberately does not state: it describes the *shape* of the document
   *    and stops there, because whether a document holds together is a
   *    question about the sections it takes over. A document that does not
   *    hold together answers 422 rather than becoming a row.
   */
  async create(
    scope: TenantScope,
    request: CreateFormRequest,
    restriction: FormRestriction,
  ): Promise<FormDetail> {
    const template =
      request.templateId === undefined
        ? null
        : parseStoredTemplateContent(
            (await requireTemplate(scope, request.templateId)).content,
          );
    if (template !== null && template.kind !== 'form') {
      throw new UnprocessableEntityException(FORM_TEMPLATE_NOT_A_FORM_MESSAGE);
    }

    const definition =
      template === null
        ? { pages: [{ id: randomUUID(), title: 'Seite 1', questions: [] }] }
        : duplicateFormDefinition(template.definition, () => randomUUID())
            .definition;

    const settingsOverride =
      template === null
        ? null
        : this.overrideFromTemplate(template.settingsOverride);

    const form = await scope.forms.create({
      title: request.title,
      draftSchema: definition satisfies Prisma.InputJsonValue,
      publicSlug: randomBytes(PUBLIC_SLUG_BYTES).toString('base64url'),
      ...(settingsOverride === null ? {} : { settingsOverride }),
    });

    return {
      ...toSummary(form, null),
      // Genuinely zero — the form was created one statement ago. Unlike the
      // detail route, this is a value and not a placeholder.
      responseCount: 0,
      // No `form_permission` row can stand on a form that did not exist one
      // statement ago, so the membership's own permissions are the effective
      // ones. Stated rather than looked up, for the same reason
      // `responseCount` is: there is nothing yet to read.
      permissions: restriction.heldPermissions,
      definition: formDefinitionSchema.parse(definition),
      revision: form.revision,
      publicSlug: form.publicSlug,
      // Nothing is in force yet, so the first publish is always something to
      // do — stated rather than computed, since there is no snapshot to read.
      hasUnpublishedChanges: true,
    };
  }

  /**
   * The settings a form template contributes — **checked here, on the way into
   * the column** (added later, a review finding; see {@link FormsService.create}
   * for the measurement that made it necessary).
   *
   * `safeParse` and an explicit throw rather than letting the `ZodError` out:
   * a Zod issue path leaving the house would name internal field names, and the
   * caller can do exactly one thing with either answer — save the template
   * again (`CONTRIBUTING.md`: no internal detail in an outward message).
   */
  private overrideFromTemplate(stored: unknown): Prisma.InputJsonValue {
    const parsed = formSettingsOverrideSchema.safeParse(
      stripOverridePassword(stored),
    );
    if (!parsed.success) {
      throw new UnprocessableEntityException(
        FORM_TEMPLATE_SETTINGS_INVALID_MESSAGE,
      );
    }
    // No cast: since the wire contract describes this document, its type *is*
    // JSON-compatible — strings, numbers, booleans and nulls, nothing else.
    // And it carries no access word (`stripOverridePassword` above), so there
    // is nothing here that would have to be sealed first.
    return parsed.data;
  }

  /**
   * „⧉ Duplizieren" on the dashboard card (the design handoff).
   *
   * The result is a **draft**: no `FormVersion`, no `Response`, its own fresh
   * `publicSlug` — the same starting point `create()` gives a brand new form,
   * reached by a different door. What is copied, and what is not, is the
   * whole of what this method decides; there is no second list anywhere else
   * that could disagree with it.
   *
   * **Copied:** title (with a suffix, see below), the draft definition (every
   * page and question, with fresh ids — {@link duplicateFormDefinition}),
   * `settingsOverride` (with its access word taken out, see below), every
   * notification (name, triggers, format, `toSubmitter`, `replyTo`, `active`,
   * and `subject`/`body`/`recipients` rewritten onto the new question ids).
   *
   * **Not copied, each for its own reason:**
   * - **The access word.** It is sealed under *this* form's id
   *   (`formOverrideContext`, `secret-context.ts`) and would be neither
   *   readable nor meaningful under the new one — `stripOverridePassword`
   *   also switches password protection off, because „an" with no word is a
   *   state `checkSettingsConsistency` refuses to store at all.
   * - **`FormVersion`, `Response`, `EventRegistration`, `File`,
   *   `ResponseDraft`.** Nothing was ever submitted to this row; it did not
   *   exist a moment ago.
   * - **`response.editToken`.** There is no `Response` to carry one.
   * - **`FormPermission`.** A duplicate starts under group rights alone, the
   *   same as any form `create()` makes — copying a cap from the original
   *   would silently apply somebody else's restriction to a form they never
   *   named.
   * - **`MailLog`.** It records what was actually sent, by a notification
   *   that, for this form, was never configured until this statement ran.
   *
   * **The title gets " (Kopie)"** — the prototype's own wording
   * (`Formular-Builder.dc.html`, `duplicateSurvey`) — so two cards are
   * distinguishable at a glance rather than reading identically until opened.
   *
   * `canBuild` guards the route (`FormsController`): „duplizieren darf, wer
   * bauen darf", the same right `create()` needs.
   */
  async duplicate(
    scope: TenantScope,
    id: string,
    restriction: FormRestriction,
  ): Promise<FormDetail> {
    const form = await requireFullForm(scope, id);
    const definition = parseStoredDefinition(form.draftSchema);

    const { definition: duplicatedDefinition, idMap } = duplicateFormDefinition(
      definition,
      () => randomUUID(),
    );

    const notifications = await scope.notifications.findManyOfForm(id);
    const duplicatedNotifications: NotificationWrite[] = notifications.map(
      (notification) => {
        // A row this application wrote always parses; a `null` here would be
        // one that does not (`parseStoredRecipients`' own comment) — carried
        // over exactly as stored rather than guessed at, the same rule
        // `rewriteQuestionPlaceholders`/`rewriteRecipientQuestionIds` apply to
        // a single reference they do not recognise.
        const recipients = parseStoredRecipients(notification.recipients);
        return {
          name: notification.name,
          triggers: notification.triggers,
          format: notification.format,
          toSubmitter: notification.toSubmitter,
          recipients: (recipients === null
            ? notification.recipients
            : rewriteRecipientQuestionIds(
                recipients,
                idMap,
              )) as Prisma.InputJsonValue,
          subject: rewriteQuestionPlaceholders(notification.subject, idMap),
          body: rewriteQuestionPlaceholders(notification.body, idMap),
          replyTo: notification.replyTo,
          active: notification.active,
        };
      },
    );

    const duplicated = await scope.forms.duplicate({
      title: `${form.title} (Kopie)`,
      draftSchema: duplicatedDefinition satisfies Prisma.InputJsonValue,
      publicSlug: randomBytes(PUBLIC_SLUG_BYTES).toString('base64url'),
      settingsOverride: stripOverridePassword(
        form.settingsOverride,
      ) as Prisma.InputJsonValue,
      /*
        **The privacy notice is copied along** (ADR-0028 no. 4).

        Unlike the access word one line above, and the reasoning runs
        in the other direction: the word is a secret sealed under the id of the
        *source* and would be neither readable nor harmless in the copy.
        The notice is a text the same Organisation wrote for the same kind of
        collection — whoever duplicates a form as a rule repeats
        the same processing („Anmeldung 2026" → „Anmeldung
        2027"). Throwing it away would be the silent loss of a mandatory statement.

        ⚠️ **And it is thereby a statement that can go stale.** The copy is
        a draft; before it becomes public, the hint before
        publishing stops when *nothing* stands there — not when something
        outdated stands there. That is the deliberate price of this decision and
        stands in the ADR as such.

        Into the **template drawer**, by contrast, it does not travel
        (`form-templates`): a template is expressly a building block for
        different purposes, and a purpose travelling along would certainly be
        wrong there sooner or later.
      */
      ...(form.privacyNotice === null
        ? {}
        : { privacyNotice: form.privacyNotice }),
      notifications: duplicatedNotifications,
    });

    return {
      ...toSummary(duplicated, null),
      // Genuinely zero, for the reason `create()` states it as one: the row
      // was created one statement ago.
      responseCount: 0,
      // Same reasoning as `create()`: no `form_permission` row can stand on a
      // form that did not exist a moment ago.
      permissions: restriction.heldPermissions,
      definition: formDefinitionSchema.parse(duplicatedDefinition),
      revision: duplicated.revision,
      publicSlug: duplicated.publicSlug,
      hasUnpublishedChanges: true,
    };
  }

  /**
   * Saves the draft, refusing to overwrite a state the editor never saw.
   *
   * The order matters: the form is resolved first (so an unknown or foreign id
   * answers 404 rather than 409), and only then is the revision claimed. A
   * caller who gets 409 knows the form exists and is theirs — which is the
   * only situation in which "please reload" is useful advice.
   */
  async update(
    scope: TenantScope,
    id: string,
    request: UpdateFormRequest,
    restriction: FormRestriction,
  ): Promise<FormDetail> {
    await requireFullForm(scope, id);

    const saved = await scope.forms.updateDraft(id, request.revision, {
      title: request.title,
      draftSchema: request.definition satisfies Prisma.InputJsonValue,
    });
    if (!saved) {
      throw new ConflictException(STALE_REVISION_MESSAGE);
    }

    return this.byId(scope, id, restriction);
  }

  /**
   * Publishes the draft as the next immutable version.
   *
   * The definition is re-validated here even though it was validated when it
   * was saved. Not paranoia about our own writer: the row may predate a schema
   * change, and publishing is the moment a form becomes something participants
   * are held to. A snapshot that no longer parses must not become the thing
   * answers are validated against.
   *
   * **A draft identical to the version in force is refused** (client decision,
   * 2026-07-27), and refused *before* the transaction opens, so no
   * `form_version` row is written and `form.revision` is not bumped either —
   * a refusal that still moved the revision would log every editor out of their
   * next save.
   *
   * Checked against `hasUnpublishedChanges()` and **not** against
   * `publishDiff()`: the diff reports only what can hurt a stored answer, so a
   * reworded label, an edited option list or a reordered page produce no entry
   * at all. Refusing on an empty diff would lock an editor out of publishing
   * real work — a silent loss, and a worse defect than the extra version.
   *
   * The check runs **before** the revision guard rather than after it, so a
   * second tab pressing publish on an already-published draft is told the
   * truth („nichts zu veröffentlichen") instead of being sent to reload.
   *
   * **The price of that order, named rather than argued away:** the two
   * overlap when the draft is identical *and* the revision has moved — someone
   * else saved and published in between. That editor's canvas now shows a
   * document that is no longer in force, and „schon aktuell" lets them keep
   * building on it until their next save trips the 409. The order is kept
   * because the common case is the same person's second tab, where a reload
   * would be wrong advice; the rarer case still surfaces, one step later.
   *
   * Concurrency is unaffected either way: publishing increments `revision`, so
   * two presses racing on the same document still leave exactly one of them
   * with a matching revision.
   *
   * **A placeholder must not be left pointing into thin air** . A notification that still names a question the new
   * version drops blocks the publish, and it blocks it **here** — before
   * `scope.forms.publish()` opens its transaction, so no `form_version` row is
   * written and `form.revision` does not move either. A refusal that had
   * already minted a version would leave the very lock in place for the next
   * try, only with the damage done.
   *
   * The check sits next to the „nichts zu veröffentlichen" one on purpose: both
   * are verdicts about the draft, and both cost one refusal rather than one
   * rollback. The order between them is free — a draft identical to the version
   * in force removes no question — and stated this way round so that the
   * cheaper answer stays the first one.
   *
   * **A Bedingung must not point into thin air either** . Same
   * shape, same 422, same „before the transaction": a condition whose source the
   * new version drops, retypes or moves behind its dependant blocks the publish
   * and the refusal names the question. „Auflösbar" is asked with the very
   * function the fill-in view and the answer validation resolve conditions with
   * (`findUnresolvableConditions` → `resolveConditionSource` in `@formsache/shared`),
   * and **not** derived from `publishDiff().removed`: a retyped source mints a
   * new id, the diff pairs the two into one line, and the
   * condition naming the old id would sail through.
   */
  async publish(
    scope: TenantScope,
    id: string,
    revision: number,
    restriction: FormRestriction,
  ): Promise<FormDetail> {
    const form = await requireFullForm(scope, id);
    const definition = parseStoredDefinition(form.draftSchema);

    if (!hasUnpublishedChanges(publishedDefinition(form), definition)) {
      throw new UnprocessableEntityException(NOTHING_TO_PUBLISH_MESSAGE);
    }

    // The requirement. First of the two locks because it needs no query at all —
    // the draft answers it on its own, where the placeholder lock below has to
    // read this organisation's notifications first.
    const unresolvable = findUnresolvableConditions({
      draft: definition,
      published: publishedDefinition(form),
    });
    if (unresolvable.length > 0) {
      throw new UnprocessableEntityException(
        unresolvableConditionMessage(unresolvable),
      );
    }

    // The requirement. Read through the scope like everything else here, so the
    // lock sees this organisation's notifications and no others.
    const orphaned = findOrphanedPlaceholders({
      draft: definition,
      published: publishedDefinition(form),
      notifications: await scope.notifications.findManyOfForm(id),
    });
    if (orphaned.length > 0) {
      throw new UnprocessableEntityException(
        orphanedPlaceholderMessage(orphaned),
      );
    }

    const version = await scope.forms.publish(
      id,
      revision,
      definition satisfies Prisma.InputJsonValue,
    );
    if (version === null) {
      throw new ConflictException(STALE_REVISION_MESSAGE);
    }

    return this.byId(scope, id, restriction);
  }

  /**
   * What publishing again would change.
   *
   * A **verdict, not a gate**: it says how many answers are on file and which
   * questions are removed, added or change type, and then gets out of the way.
   * `POST /publish` is untouched — the editor still decides, they merely no
   * longer decide it by accident.
   *
   * Compared against the version **in force**, not against the union of all
   * published ones: a question retired three versions ago is not being removed
   * again, and a warning that repeats itself stops being read.
   *
   * **`blocked` is the one part that is not advice** (the requirements).
   * The refusals themselves live in {@link publish}; this only carries
   * the same findings forward, computed by the **same** two functions —
   * `findUnresolvableConditions()` and `findOrphanedPlaceholders()`, not a
   * second reading of „zeigt das ins Leere?". A preview that answered that
   * question for itself would be free to disagree with the endpoint that
   * enforces it, and the half that says „no" is the half an editor believes.
   *
   * Both are therefore deliberately *not* derived from `publishDiff().removed`
   * sitting right above them: a retyped question mints a new id, the diff pairs
   * the two into one line and reports **no removal at all**,
   * while the placeholder and the condition naming the old id both find nothing.
   * A lock hung on `removed` publishes exactly that case — measured in
   * `test/forms/condition-publish-lock.spec.ts`.
   */
  async publishPreview(
    scope: TenantScope,
    id: string,
  ): Promise<PublishPreview> {
    const form = await requireFullForm(scope, id);
    const draft = parseStoredDefinition(form.draftSchema);
    const published = publishedDefinition(form);

    // The requirement. The **draft** is what is asked, exactly as in
    // {@link publish} — and first, in the order the refusals themselves come,
    // so the dialog lists what the button would hit first at the top.
    const unresolvable = findUnresolvableConditions({ draft, published });

    // The second read is the one this route gained for `organisationLegal`
    // below — the same narrow projection the tab *Rechtstexte* takes, and
    // through the same scope as everything else here. **Together**, because
    // neither depends on the other and one dialog should not cost two round
    // trips in sequence.
    const [notifications, legal] = await Promise.all([
      scope.notifications.findManyOfForm(id),
      scope.tenant.legal(),
    ]);

    const orphaned = findOrphanedPlaceholders({
      draft,
      published,
      notifications,
    });

    // Mapped rather than passed through: `notificationId`, `questionId` and
    // `sourceId` are this module's business. What the editor gets is what they
    // have to act on — the notification and the token, the question to open and
    // why its condition no longer resolves.
    const blocked: PublishBlocked[] = [
      ...unresolvable.map((finding) => ({
        kind: 'condition' as const,
        questionLabel: finding.questionLabel,
        sourceLabel: finding.sourceLabel,
        defect: finding.defect,
      })),
      ...orphaned.map((finding) => ({
        kind: 'placeholder' as const,
        notificationName: finding.notificationName,
        token: finding.token,
        label: finding.label,
        places: [...finding.places],
      })),
    ];

    return {
      revision: form.revision,
      publishedVersion: form.publishedVersion?.version ?? null,
      responseCount: form._count.responses,
      changes: publishDiff(published, draft),
      blocked,
      /*
        **How far along this form's privacy notice is** (ADR-0028
        no. 4) — a traffic light, never the text.

        The hint before publishing is the place at which somebody stands
        shortly before going public (`docs/legal/README.md` 5.5 no. 2);
        here the question is answered, the legal text is not delivered.
        Exactly for that reason it may stand behind `can_build`: `can_build` is the
        right that publishes, `can_manage_form_settings` the one that writes the
        text — and without this one figure the first person would never learn what
        the second one has failed to do.

        `legalPageStatus` and not `renderLegalPage`: what is asked for is a traffic light,
        and building a whole legal text to colour it would be work for
        nothing (the same sentence with which `legalPageStatus` in
        `@formsache/shared` is justified).

        The context is the same narrow one as on the public path: the
        template uses neither the name of the operator nor the AI condition.

        ⚠️ **`redirectTarget: null`, and this light does not read it either
        way** (ADR-0028 no. 5). The sentence about the redirect stands in the
        template's `fixed` part, which `legalPageStatus` never resolves, and
        the address it names is an `APP_` slot, which never counts as an open
        one. Both halves are deliberate: a form that redirects must not be
        „unvollständig" for a field nobody was asked to fill in, and one that
        does not redirect must not be either. Reading the settings here to
        pass a target would be a query for a value this answer cannot
        express.
      */
      privacyNotice: legalPageStatus(
        FORM_PRIVACY_TEMPLATE,
        parseStoredFormPrivacyNotice(form.privacyNotice),
        {
          organisationName: null,
          organisationShortName: null,
          operatorName: null,
          aiActive: false,
          redirectTarget: null,
        },
      ),
      /*
        **How far along the legal texts of this organisation are** (ADR-0028,
        open item 3) — one traffic light over both pages, worst state winning.

        Read through `scope.tenant`, and that is the whole of the tenant
        boundary here: the scope is built by `TenantScopeGuard` from a
        membership the caller actually holds, `requireFullForm` above found
        the form through the same scope, and the delegate takes no tenant as
        an argument. „Die Rechtstexte der Organisation dieses Formulars" is
        therefore not a rule this function follows but the only statement it
        can express.

        The fold itself stands in `@formsache/shared` and no longer here: the
        same two documents are judged in the list of open items of an
        organisation and in the notice before publishing, and three copies of
        one judgement are three chances for them to disagree about what
        „fertig" means. ⚠️ Why it hands out a status and never a page — the
        decision this call site must not undo — stands at `tenantLegalStatus`
        and, in full, at the field it feeds.
      */
      organisationLegal: tenantLegalStatus(
        parseStoredTenantLegalPages(legal?.legalPages),
      ),
    };
  }

  /**
   * The columns of the responses view, and the snapshots its cells are
   * rendered against.
   *
   * **Not `form.draftSchema`.** The columns are the union of every published
   * version, which is what keeps a removed question's answers reachable — they
   * are still in the database, and reading the columns off the current document
   * made them unreachable through the interface, which is data loss nobody
   * notices until the data is needed. Reading the *draft* on top of that meant
   * that merely trying something out in the builder changed the responses view,
   * with nothing saved and nothing published.
   *
   * The snapshots travel with the columns because a cell is rendered against
   * the version its row was submitted under: sent once per version
   * rather than once per row, since a form has a handful of versions and may
   * have hundreds of answers.
   *
   * **Columns from every version, snapshots only from the answered ones.** The
   * two sets differ on purpose: a question that existed for one afternoon still
   * earns a column, but a version nobody ever submitted against renders no cell
   * and would be a whole form document sent for nothing. A form republished
   * twenty times over a semester is the case that makes the difference matter.
   */
  async responseColumnSet(
    scope: TenantScope,
    id: string,
  ): Promise<ResponseColumnSet> {
    await requireFullForm(scope, id);
    const snapshots = await this.publishedSnapshots(scope, id);
    const answered = new Set(await scope.forms.answeredVersionIds(id));

    return {
      columns: responseColumns(snapshots),
      // Mapped rather than passed through: the stored row id is this module's
      // business and has no place on the wire.
      versions: snapshots
        .filter((snapshot) => answered.has(snapshot.id))
        .map(({ version, definition }) => ({ version, definition })),
    };
  }

  /**
   * Answers to one form, each carrying the version it was validated against
   *  — the table renders a row against *its* snapshot, not
   * against whatever the form looks like today.
   */
  async responses(scope: TenantScope, id: string): Promise<ResponseDetail[]> {
    await requireFullForm(scope, id);
    const rows = await scope.forms.responsesOf(id);

    return rows.map((row) => ({
      id: row.id,
      formId: row.formId,
      submittedAt: row.submittedAt.toISOString(),
      formVersion: row.formVersion.version,
      answers: toAnswerRecord(row.answers),
    }));
  }

  /**
   * The export of the **filtered view**, in the requested format.
   *
   * Filtering and column selection happen here rather than in the database,
   * and that is a deliberate limit: the search runs over formatted answers, so
   * it finds what a reader sees in the table (`Ja, ich komme`, not `ja`) —
   * which is what makes "the export follows the visible view" true rather than
   * approximately true. The cost is that the whole form's answers are loaded
   * to build the file. At the scale the concept states (~50 organisations, a
   * Jahrestagung registration in the hundreds) that is the right trade; a form
   * with a hundred thousand answers would need a streaming export, and that is
   * a different feature, not a tweak.
   *
   * **The format is the last thing this method looks at** . Rows and
   * columns are worked out once, above; `writeExport` builds the sheet and then
   * branches. There is deliberately no `if (format === 'csv')` anywhere in this
   * file — a route that chose the rows per format would eventually choose them
   * differently, which is the defect that has happened twice before.
   */
  async exportResponses(
    scope: TenantScope,
    id: string,
    view: {
      format: ExportFormat;
      columns?: readonly string[] | undefined;
      search: string;
    },
  ): Promise<{ filename: string; contentType: string; body: ExportBody }> {
    const form = await requireFullForm(scope, id);
    const rows = await scope.forms.responsesOf(id);

    // **One parse per version, not one per row.** Hundreds of answers to a
    // Jahrestagung registration point at a handful of snapshots, so parsing each
    // row's version separately does the same Zod walk over the same document
    // hundreds of times — and it hands the seam a fresh object every time, which
    // is exactly what `buildExportSheet` keys its per-version column plan by.
    // Cached by the version's id, so two rows of the same version share one
    // document.
    const definitions = new Map<string, FormDefinition | null>();
    const definitionOf = (version: {
      id: string;
      schema: unknown;
    }): FormDefinition | null => {
      const known = definitions.get(version.id);
      if (known !== undefined) {
        return known;
      }
      // A snapshot that no longer parses cannot be formatted — but the row
      // stays, with its timestamp and otherwise empty cells, exactly as the
      // table keeps it. The seam writes it through `renderSchemalessRow`, the
      // function the table renders such a row with; the reasoning for keeping
      // it (and the objection weighed against it) is written down there.
      const parsedVersion = formDefinitionSchema.safeParse(version.schema);
      const definition = parsedVersion.success ? parsedVersion.data : null;
      definitions.set(version.id, definition);
      return definition;
    };

    const parsed = rows.map((row) => ({
      submittedAt: row.submittedAt.toISOString(),
      answers: toAnswerRecord(row.answers) as AnswerMap,
      definition: definitionOf(row.formVersion),
    }));

    const filtered =
      view.search.trim() === ''
        ? parsed
        : parsed.filter((row) => matchesSearch(row, view.search));

    // The union of every published version, never the draft. A
    // removed question keeps its column here, so the answers to it stay in the
    // file that an editor exports six months later — and `csvColumns` is what
    // says so in the header, since a file has no way to show a marker.
    // Chosen at question level, written at column level: `columns=` names
    // questions (that is what the field menu offers and what the table shows),
    // and `csvColumns` expands each of them into the columns the file carries —
    // one for every type that exists today, four for an Adresse.
    //
    // **Built from `filtered`, and after the filtering for that reason**: since a table's row blocks come from the answers as well
    // as from the document, the header list and the cells have to be built over
    // the *same* rows. `buildExportSheet` takes its plan from the rows it is
    // handed — so
    // handing it the filtered rows while asking the header list about all of them
    // would put a „Zeile 5" column into a file whose rows stop at three. „Der
    // Export folgt der sichtbaren Sicht"  reaches the column *count*
    // here, not just the column selection.
    const columns = chooseColumns(
      responseColumnGroups(
        await this.publishedSnapshots(scope, id),
        filtered.map((row) => row.answers),
      ),
      view.columns,
      // **The default preselection of the export is „alle Spalten"** . It only decides the case where the client named no
      // columns at all — a hand-built URL, a script, a bookmark from before the
      // field menu existed. A stated selection is still honoured as stated, so
      // „der Export folgt der sichtbaren Sicht"  is untouched: the view
      // states what it shows.
      //
      // Same function as the responses table, different argument — never a
      // second `pickExportColumns`, which is what `single-source.test.ts` now
      // enforces by name.
      'export',
    );

    // One call, and the branch is inside it: the rows above and the columns
    // beside them are what **every** format gets, whatever it does with them.
    //
    // The fourth argument is the printed head of the evidence
    // („Kopf mit Formulartitel, Organisation und Zeitpunkt"). CSV and Excel ignore it —
    // they have nowhere to put it — but it is passed unconditionally, because
    // a head that only *some* callers supply is how the served file used to keep the
    // neutral title for a long stretch of this feature's early development, with
    // the writer's own tests green.
    const written = await writeExport(
      view.format,
      csvColumns(columns),
      filtered,
      {
        formTitle: form.title,
        // Never null through the normal chain (the scope came from a
        // membership), but an organisation deleted mid-request costs the header line, not
        // the export.
        tenantName: (await scope.tenant.name())?.name ?? '',
        // The moment of *this* download, taken here rather than in the writer:
        // a writer that reaches for the clock produces a different file on every
        // run and cannot be held still by a golden test.
        exportedAt: new Date().toISOString(),
      },
    );

    return {
      filename: `${slugifyFilename(form.title)}.${written.extension}`,
      contentType: written.contentType,
      body: written.body,
    };
  }

  /**
   * Every published version of a form, parsed, oldest first.
   *
   * A snapshot that no longer parses is left out rather than raising: one
   * damaged snapshot must not take the whole responses view down, because the
   * view is the only way to the answers behind the *other* versions. What is
   * lost is the *column*, never the row — an answer given under the damaged
   * version keeps its line in the table and in the file (`exportResponses`),
   * with its timestamp and empty cells.
   *
   * **What is degraded when that happens**, spelled out because it is not
   * obvious and it is now pinned by a test:
   *
   * - columns that existed **only** in the damaged version disappear. Every
   *   other question survives, since a question is normally carried by several
   *   snapshots;
   * - if the damaged one is the **newest**, the one before it is taken for the
   *   current form — so a question that was removed in the newest version is
   *   reported as still active (`retired: false`). That is the safe direction
   *   (a column too many, never one too few), but it is wrong, and it is the
   *   reason a damaged snapshot is a defect to repair rather than a state to
   *   live in;
   * - **its answers still decide how wide the file is** . The row is
   *   rendered through `renderSchemalessRow` and writes nothing but empty cells,
   *   yet `exportResponses` hands its `answers` to `responseColumnGroups` like
   *   every other row's — the two are separate paths, and only the first one asks
   *   whether the snapshot parsed. So a damaged row carrying a table with
   *   twenty rows widens **everybody's** file by eighteen columns that are empty
   *   in every line, its own included. Left as it is rather than filtered:
   *   dropping such a row from the column set would make the file's width depend
   *   on which rows happen to be repairable, and a repaired snapshot would then
   *   change the shape of an export that was already handed out.
   *
   * The caller has already resolved the form through `requireFullForm`, so this
   * never sees an id of another organisation; the query carries the tenant regardless
   * (`ScopedFormDelegate.versionsOf`).
   */
  private async publishedSnapshots(
    scope: TenantScope,
    id: string,
  ): Promise<StoredSnapshot[]> {
    const versions = await scope.forms.versionsOf(id);
    return versions.flatMap((version) => {
      const parsed = formDefinitionSchema.safeParse(version.schema);
      return parsed.success
        ? [
            {
              id: version.id,
              version: version.version,
              definition: parsed.data,
            },
          ]
        : [];
    });
  }
}

/**
 * The document participants are filling in right now, or `null`.
 *
 * A snapshot that no longer parses reads as **"nothing is published"**, and
 * that direction is chosen rather than inherited. It is what both callers need
 * and for the same reason:
 *
 * - `publishPreview` then reports every question as an addition, which
 *   overstates the change and never understates it — and the alternative,
 *   failing the preview, would leave the editor with no verdict at all on
 *   exactly the form that needs one most;
 * - `publish` then lets the publish through. Also the safe direction: an
 *   editor whose form is damaged must be able to replace it with a readable
 *   snapshot, and a refusal would leave the broken one in force with no way out.
 *   The cost is one superfluous version in a case that is already a defect.
 */
function publishedDefinition(form: FormWithCounts): FormDefinition | null {
  if (form.publishedVersion === null) {
    return null;
  }
  return (
    formDefinitionSchema.safeParse(form.publishedVersion.schema).data ?? null
  );
}

function toSummary(
  form: Form,
  publishedVersion: FormVersion | null,
): Omit<FormSummary, 'responseCount' | 'permissions'> {
  return {
    id: form.id,
    title: form.title,
    status: form.status,
    publishedVersion: publishedVersion?.version ?? null,
    updatedAt: form.updatedAt.toISOString(),
  };
}

/**
 * Reads a definition back out of JSONB.
 *
 * Parsed, not cast. The column accepts any JSON — a hand-edited row, a
 * migration, a future writer that skipped validation — and a definition the
 * builder cannot render is better reported here, where the form is named, than
 * as an exception three layers up in a React component.
 */
export function parseStoredDefinition(stored: Prisma.JsonValue) {
  const parsed = formDefinitionSchema.safeParse(stored);
  if (!parsed.success) {
    throw new BadRequestException(
      'Die gespeicherte Formulardefinition ist ungültig.',
    );
  }
  return parsed.data;
}

/** Answers come back as an object; anything else is a row we did not write. */
function toAnswerRecord(stored: Prisma.JsonValue): Record<string, unknown> {
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) {
    return {};
  }
  return stored;
}

/**
 * Full-text search over the **rendered** row — answers *and* timestamp.
 *
 * The same rendering the table uses (`renderRow` in `@formsache/shared`), so a search
 * for "Ja, ich komme" finds the row a reader sees rather than the stored `ja`.
 * The timestamp is part of it: leaving it out meant a search for a date listed
 * rows on screen and produced a file with nothing but a header.
 *
 * A row whose snapshot no longer parses is searched over the one cell it has —
 * again the same way the table does it (`toRow` in `response-rows.ts`). It is
 * therefore findable by its date and by nothing else, on screen and in the file
 * alike; a filtered export that kept it under a term the table does not match
 * would break the very promise the row was kept for.
 */
function matchesSearch(row: CsvRow, search: string): boolean {
  return rowMatchesSearch(
    row.definition === null
      ? renderSchemalessRow(row.submittedAt)
      : renderRow(row.definition, row.submittedAt, row.answers),
    search,
  );
}

/**
 * A file name from a form title.
 *
 * Reduced to a conservative set, because the value ends up in a
 * `Content-Disposition` header: a title with a quote or a newline in it would
 * otherwise let an admin-authored string break the header apart.
 */
function slugifyFilename(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/ä/gu, 'ae')
    .replace(/ö/gu, 'oe')
    .replace(/ü/gu, 'ue')
    .replace(/ß/gu, 'ss')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 80);
  return base === '' ? 'antworten' : base;
}
