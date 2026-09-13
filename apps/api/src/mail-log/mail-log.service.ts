import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  MailLogDetail,
  MailLogEntry,
  MailLogFilter,
  MailLogListResponse,
} from '@formsache/shared';

import { MailBodyRenderer } from '../mail/mail-body-renderer';
import { MailClock } from '../mail/mail-clock';
import { identitySourceOf } from '../mail/mail-identity.service';
import { HONEYPOT_SUPPRESSION_REASON } from '../public/mail-suppression';
import type { FormRestriction } from '../tenancy/form-restriction';
import { isUuid } from '../common/uuid';
import type {
  MailLogWithBody,
  MailLogWithNotification,
  TenantScope,
} from '../tenancy/tenant-scope';

/**
 * The mail log — reading it, and handing one line back to the worker.
 *
 * **Every statement in here goes through `scope.mailLog`, and that is the whole
 * security design of this module.** `mail_log` carries no composite foreign key
 * on `(form_id, tenant_id)` — Prisma cannot express one, because an optional
 * relation needs all of its scalar fields optional while `tenant_id` is
 * required. So unlike `response` or
 * `form_version`, a forgotten tenant binding here is caught by **nothing**
 * underneath: PostgreSQL would happily return another organisation's recipient
 * addresses. `ScopedMailLogDelegate` is the only boundary the table has.
 *
 * The consequences for anyone editing this file:
 *
 * - no `PrismaService` (this directory is deliberately **not** on the
 *   allow-list of `eslint.config.js`, so the build refuses it);
 * - no reach into the worker's repository in `src/mail/`, which legitimately
 *   works *across* tenants and whose allow-list entry exists only because the
 *   read side stays strictly scoped. A `MailLogService` that borrowed it
 *   because it was within arm's length would be the regression every test
 *   survives.
 *
 * `MailBodyRenderer` is the one exception, and a narrow one: it is injected
 * (see the constructor) purely to resolve `{{bearbeiten}}` in {@link detail}
 * with the worker's own code, not a second implementation of it. It renders
 * the row this service already read through `scope.mailLog` — it does not
 * hand this service a way to read a row of its own.
 */
@Injectable()
export class MailLogService {
  constructor(
    private readonly clock: MailClock,
    /**
     * The **same** renderer the worker sends with, injected for exactly one
     * reason: {@link detail} resolves `{{bearbeiten}}` (`MailBodySource`,
     * `mail/mail-body-renderer.ts`) rather than reading
     * `response`/`allowEdit` a second time. `MailModule` exports the
     * abstract token, not the worker's repository — this class still has no
     * `PrismaService` of its own.
     */
    private readonly bodyRenderer: MailBodyRenderer,
  ) {}

  /**
   * The log of the active Organisation, plus the four KPI counters of the design handoff.
   *
   * Tenant-wide with an optional prefilter on a form —
   * the tenant itself is never a parameter, it comes from the scope.
   *
   * Both halves are issued together so the window in which they can disagree is
   * one round trip instead of two. It is **not** a snapshot and does not claim
   * to be: two statements outside a transaction can still straddle a worker run,
   * and the tiles would then say „3 in Warteschlange" over a table showing two.
   * A `REPEATABLE READ` transaction would close that window and cost a
   * transaction per page view for a difference the next tick erases anyway —
   * so the window is named here rather than papered over.
   */
  async list(
    scope: TenantScope,
    filter: MailLogFilter,
    restriction: FormRestriction,
  ): Promise<MailLogListResponse> {
    /**
     * The fourth link, as a **condition** rather than as a decision after the
     * load (a review finding — see `ScopedMailLogDelegate.where`). It
     * reaches the counters too: tiles counted over rows the table below may not
     * show would say „7 gesendet" over four lines, and the number itself is
     * already a statement about a form somebody is locked out of.
     */
    const hiddenForms = await this.hiddenForms(scope, restriction);

    const [rows, counts] = await Promise.all([
      scope.mailLog.findMany({ ...filter, hiddenForms }),
      /**
       * The status is **not** passed on, deliberately: the KPI tiles *are* the
       * status filter, and clicking „Fehlgeschlagen" must not make the other
       * three tiles read zero. The form prefilter *is* passed on, because the
       * tiles have to agree with the table they sit above.
       */
      scope.mailLog.counts({ formId: filter.formId, hiddenForms }),
    ]);

    return { entries: rows.map(toEntry), counts };
  }

  /**
   * „↻ Erneut" : hands one failed line back to the worker.
   *
   * The row goes to `queued` with `attempts = 0` and `next_attempt_at = now`,
   * so the very next worker run claims it. Resetting
   * the counter is the point of the button rather than a detail: on a line that
   * has used up its five attempts, a retry that only recoloured the status
   * would be a click without effect, and the button's purpose says in as many words
   * „tatsächlich erneut versucht, nicht nur umgefärbt". `last_error` is left
   * standing until the next result replaces it, so the editor can still read
   * why it failed while it waits. **No second row** — one line per recipient is
   * the shape, and a retry is another attempt at the
   * same delivery.
   *
   * **Only a `failed` line may be retried.** A `sent` one would put a second
   * copy of a mail that already arrived into the queue, and a sent mail is the
   * one mistake this application cannot take back; a
   * `queued` one needs no help and would only get its backoff reset, which is
   * how a dead mail server ends up being asked once a second.
   *
   * **And a line the honeypot caught may not be retried at all** (a security
   * review finding). A baited submission writes a full row —
   * recipient and rendered body — as `failed` with
   * {@link HONEYPOT_SUPPRESSION_REASON}, deliberately, so the organisation can *see*
   * what was suppressed (`public/mail-suppression.ts`). Both halves of that row
   * come from a stranger: the body carries the answers they typed, and a
   * recipient derived from a question is an address they typed. „↻ Erneut"
   * would hand exactly that to the transport — turning the one button meant to
   * repair a delivery into the one that carries out the attack the defence just
   * stopped, pressed by an editor acting in good faith on a row the system told
   * them was a suspicion.
   *
   * That the *false* alarm (a password manager filling the decoy) is a real and
   * planned case is the argument **for** refusing rather than against it: an
   * editor cannot tell the two apart from the row, so a button that sends is a
   * button whose safety depends on a judgement nobody can make. What is not
   * lost is the registration — it is stored, visible under Antworten, and the
   * reason line says so in its second sentence. A resend, if an organisation really
   * wants one, is a new mail with a chosen recipient, not a replay of an
   * unauthenticated stranger's.
   *
   * The **budget**'s own capped lines stay retryable, and the asymmetry is the
   * point: those carry a mail the form itself produced for a recipient the form
   * configured, and „dieses eine ist mir wichtig genug" is a decision an editor
   * of that form is entitled to make. Only the honeypot's rows contain content
   * whose provenance is an anonymous caller.
   *
   * The check and the write are two statements, and that is sound here rather
   * than a race waiting to happen: `failed` is terminal for the worker — it
   * only ever claims `queued` rows — so nothing but another retry can move the
   * line between the two. Two administrators clicking at once therefore write
   * the same values twice and produce one queued line, not two.
   */
  async retry(
    scope: TenantScope,
    id: string,
    restriction: FormRestriction,
  ): Promise<void> {
    // The same shape check as in `detail()`, for the same reason: a
    // broken id ended up here in a 500 instead of in the one 404.
    if (!isUuid(id)) {
      throw new NotFoundException(MAIL_LOG_ENTRY_NOT_FOUND_MESSAGE);
    }
    const entry = await scope.mailLog.findById(id);
    if (entry === null) {
      // The same answer for „belongs to another organisation" as for „does not exist"
      //  — an id is not an oracle for what other Organisationen send.
      throw new NotFoundException(MAIL_LOG_ENTRY_NOT_FOUND_MESSAGE);
    }
    await this.requireUnrestricted(scope, entry.formId, restriction);
    if (entry.status !== 'failed') {
      throw new ConflictException(MAIL_LOG_NOT_RETRYABLE_MESSAGE);
    }
    // Read off the **one** constant the suppression writes, never a second
    // spelling here: `mail-suppression.ts` says why that reason exists exactly
    // once, and a copy of the sentence in this file is how a wording fix on one
    // side quietly reopens the channel on the other. The module it comes from
    // is a leaf — two string constants and two pure functions — so this costs
    // no dependency in either direction.
    if (entry.lastError === HONEYPOT_SUPPRESSION_REASON) {
      throw new ConflictException(MAIL_LOG_HONEYPOT_NOT_RETRYABLE_MESSAGE);
    }
    /**
     * **And a line whose data were physically deleted may not be retried
     * either** (a review finding).
     *
     * `recipient IS NULL` means exactly one thing (`MailLog.recipient` in the
     * schema): the row was blanked by physical deletion. Nothing would leave
     * the house — the queue statements exclude a null recipient — but that is
     * not what this refusal is for. {@link ScopedMailLogDelegate.requeue}
     * writes `status`, `sent_at`, `attempts`, `sender_identity` and
     * `sender_address`, which **is** the record the requirement promises to keep when it
     * empties the personal columns. One click and the line reads `queued`
     * forever, with no outcome, no time and no identity: the operational half
     * destroyed by the button meant to repair a delivery.
     *
     * The same shape as the honeypot refusal above and for the same reason: an
     * editor cannot tell an erased line from an ordinary failed one by looking
     * at it, so the boundary cannot be „the view hides the button". It does hide
     * it — that is comfort, and this is the boundary.
     */
    if (entry.recipient === null) {
      throw new ConflictException(MAIL_LOG_ERASED_NOT_RETRYABLE_MESSAGE);
    }

    /**
     * **A system mail is not sent again by this right** (ADR-0020,
     * ADR-0021, a review concern).
     *
     * `identitySourceOf(trigger) === 'system'` means: no form triggered this
     * row, but the application — today the reset mail, the
     * **invitation of a newly created account** (ADR-0024) and the notification
     * about an administratively set password. It is asked over
     * the same function as in the worker, so that „welche Zeile ist eine Systemmail"
     * keeps one version.
     *
     * Why it has to fail here: „↻ Erneut" is the **only** action in the
     * mail log that *sends*. Since ADR-0021 it stands behind
     * `can_manage_form_settings` + `can_view_responses`, so behind the
     * standard group `editor` — and that one has nothing to do with the account
     * at issue: the row hangs on this organisation only because
     * `mail_log.tenant_id` is NOT NULL and the *oldest* membership decided the
     * coin (ADR-0020 §8). An `editor` could thereby send a
     * stranger — up to the superadmin — a real,
     * correctly worded mail of the installation into their inbox repeatedly,
     * including a freshly built reset link. They do not read it (it goes to
     * the account's mailbox), but they trigger it, and that is exactly the
     * boundary that ADR-0020 draws everywhere else.
     *
     * **The price is none.** Whoever does not receive the reset mail requests
     * it anew themselves — „Passwort vergessen" is the way built for that,
     * reachable without a login and limited twice over. A repeat button
     * pressed by a third party replaces nothing that would not exist already.
     *
     * The same construction as the two refusals above: a 409 with a
     * readable reason, decided at the boundary and not by the
     * view hiding the button. The *visibility* of the row stays
     * untouched — ADR-0020 names it expressly as a named consequence.
     */
    if (identitySourceOf(entry.trigger) === 'system') {
      throw new ConflictException(MAIL_LOG_SYSTEM_NOT_RETRYABLE_MESSAGE);
    }

    /**
     * **The injected `MailClock`, the very one the worker claims against.**
     *
     * Not `new Date()`: the worker computes „what is due" from `MailClock.now()`
     * and compares it with the `next_attempt_at` written here, so if the two
     * sides read different calendars the line is claimed a moment too early or
     * — with a clock moved for a test — never at all. „One clock end to end" is
     * only true if it is literally one, which is why `MailModule` exports it and
     * this module imports it for nothing else.
     */
    const requeued = await scope.mailLog.requeue(id, this.clock.now());
    if (!requeued) {
      // Only reachable if the line disappeared between the two statements —
      // the retention purge is the one thing that deletes here. Same answer as
      // above; nothing was changed.
      throw new NotFoundException(MAIL_LOG_ENTRY_NOT_FOUND_MESSAGE);
    }
  }

  /**
   * One line, with the mail as it was rendered (the acceptance run: „Die
   * gerenderte Mail im Versandprotokoll ansehen").
   *
   * Same `404` for „not there" and for „another organisation's" as everywhere else
   * behind `ScopedMailLogDelegate.findById` — see the class
   * comment for why that delegate is the only tenant boundary this table has.
   *
   * ## `{{bearbeiten}}` is resolved, and **redacted** — never the live address
   *
   * `bodyText`/`bodyHtml` carry {@link EDIT_LINK_MARK} exactly where the send
   * step would fill it in — the mark means nothing outside that step, and
   * showing it raw would be the „verwirrend" the work item warns against. The
   * alternative to resolving it is not "show it as stored", it is a second
   * implementation of `editUrlFor` (whether a token still works, whether
   * `allowEdit` still holds) sitting next to the worker's — precisely the
   * drift `CONTRIBUTING.md` rules out. So this resolves it, through the
   * **injected** `MailBodyRenderer` and nothing else, which is also why the
   * „is there a link at all" answer is not frozen: `allowEdit` is evaluated
   * live everywhere in this system, and a line
   * viewed today shows whether the link *currently* works, same as a fresh
   * delivery would.
   *
   * **The address itself never leaves this route.** `render()` is called with
   * `'redacted'` (`EditLinkPresentation`), so the mark resolves to
   * {@link EDIT_LINK_REDACTED_LABEL} instead of the real URL whenever a link
   * exists, and to nothing when it does not — same distinction, different
   * value. The edit link is an **owner capability**: whoever holds it can
   * overwrite a stranger's answer, unattributed, and this route only proves
   * `can_view_responses` — read rights. Handing out the live address here
   * would turn that read into a write capability, and the concept treats a
   * leaked link as a reason to *revoke* it — this view would otherwise be a
   * standing leak of its own, into rows that live for 90 days.
   *
   * A `null` `bodyText` has **two** meanings since the requirement, and this
   * branch is right for both: the row predates the freeze of 2026-07-28, or it
   * was **emptied** by physical deletion along with `recipient`, `subject` and
   * `body_html`. `QueuedBodyRenderer` would refuse either as unrenderable, so
   * the detail route answers with `null`/`null` instead of asking the renderer
   * to fail — which is what „das Versandprotokoll rendert die geleerte Zeile,
   * ohne zu brechen" means on this route.
   */
  async detail(
    scope: TenantScope,
    id: string,
    restriction: FormRestriction,
  ): Promise<MailLogDetail> {
    /*
     * ⚠️ **The shape of the id is checked before PostgreSQL sees it**
     * (the requirement — „falsch geformt antwortet wie unbekannt"). Without this
     * line `findById` passes the literal through, the database objects, and the
     * caller gets **500** instead of 404: `GET /api/mail-log/nicht-echt` would
     * thereby tell them that their string got as far as the query. The
     * rest of the repository does that; this route and `retry()` were the
     * two that did not.
     */
    if (!isUuid(id)) {
      throw new NotFoundException(MAIL_LOG_ENTRY_NOT_FOUND_MESSAGE);
    }
    const entry: MailLogWithBody | null = await scope.mailLog.findById(id);
    if (entry === null) {
      throw new NotFoundException(MAIL_LOG_ENTRY_NOT_FOUND_MESSAGE);
    }
    await this.requireUnrestricted(scope, entry.formId, restriction);

    const rendered =
      entry.bodyText === null
        ? null
        : await this.bodyRenderer.render(
            {
              // The id goes along, since a reset mail resolves its link only
              // on delivery (ADR-0020). This route does not get to see it
              // anyway — `'redacted'` writes a label —,
              // but it has to *resolve* the marker, otherwise the
              // string would stand raw in the displayed mail.
              id: entry.id,
              // The condition the reset resolution hangs on — redacted here
              // anyway, but the marker has to be resolved even then,
              // otherwise the string would stand raw in the display.
              trigger: entry.trigger,
              tenantId: scope.tenantId,
              responseId: entry.responseId,
              bodyText: entry.bodyText,
              bodyHtml: entry.bodyHtml,
            },
            // Read rights, not the write capability the address carries —
            // see the class comment above `detail`.
            'redacted',
          );

    return {
      // `trigger` has come along from {@link toEntry} since the review finding — it
      // stands on the list, because the table row would otherwise offer the
      // retry button for a system row.
      ...toEntry(entry),
      bodyText: rendered?.text ?? null,
      bodyHtml: rendered?.html ?? null,
    };
  }

  /**
   * The fourth link on the two routes that address a **log line**, not a form
   * (review finding).
   *
   * `FormRestrictionGuard` cannot do this one. It reads the form off the
   * request, and here the form is not in the request at all — it hangs off
   * `mail_log.form_id`, one read further in. The routes therefore declare
   * `@NoFormIdInRequest(…)` and the check lands here, on the row that was just
   * resolved through the tenant-bound `findById`.
   *
   * **404, byte-identical to an unknown id**, and never a 403: a 404 that
   * differed in text or status would say „diese Zeile gibt es, du darfst sie
   * nur nicht sehen", which turns the id into an oracle over another form's
   * correspondence (the evidence). It is the *same* refusal
   * `findById` gives for a line of another organisation, from the same method.
   *
   * A line with `form_id = NULL` is untouched, for the reason
   * `ScopedMailLogDelegate.where` gives at length: it belongs to no form, so no
   * restriction can point at it.
   *
   * ## Both halves of the restriction, through the guard's own evaluation
   *
   * The first version of this method asked `stored?.accessRevoked === true` and
   * nothing else (review finding). That closed „gesperrt" and left
   * „gedeckelt" wide open: somebody capped on form X to a group **without**
   * `can_view_responses` still read X's rendered mail here — the answer values
   * a template put into it — and could hand the line back to the worker,
   * while the very same restriction answered 403 on
   * `GET /api/mail-log?formId=X`. One rule, two answers, and the weaker one on
   * the route that carries the body.
   *
   * So the decision is not made here at all: {@link FormRestriction.verdictFor}
   * is the one evaluation, and the guard reaches its verdict through the same
   * method — including „which permissions does *this* route require", which
   * travels on the restriction rather than being named a second time here.
   *
   * **Both verdicts answer 404**, unlike in the guard, where a cap is a 403.
   * The difference is the id: there, the caller named a form and already knows
   * it exists; here they named a *log line*, and a 403 would confirm that a
   * line with this id exists and belongs to a form they are restricted on —
   * the oracle the requirements the evidence close.
   */
  private async requireUnrestricted(
    scope: TenantScope,
    formId: string | null,
    restriction: FormRestriction,
  ): Promise<void> {
    const userId = restriction.restrictedUserId();
    if (userId === undefined || formId === null) {
      return;
    }
    const stored = await scope.formPermissions.findFor(formId, userId);
    const verdict = await restriction.verdictFor(stored, (id) =>
      scope.groups.findById(id),
    );
    if (verdict !== 'open') {
      throw new NotFoundException(MAIL_LOG_ENTRY_NOT_FOUND_MESSAGE);
    }
  }

  /**
   * Which forms this person may see no lines of — the list's half of the same
   * evaluation (review finding).
   *
   * A guard cannot narrow a result set, so the answer becomes a condition in
   * `ScopedMailLogDelegate.where`. What is read here to build it is the
   * person's own handful of `form_permission` rows, never a `mail_log` row:
   * every line a caller may not see stays in the database, which is what
   * the requirement's first reproduction asks for.
   *
   * An administrator's restrictions are not read at all — `restrictedUserId()`
   * is the one place that exception is turned into a value, and
   * it is inside {@link FormRestriction.hiddenFormIdsIn} rather than here: this
   * is no longer the only caller (a review finding gave „Papierkorb leeren"
   * the same need), and two spellings of that arm is two places to get the
   * administrator exception wrong.
   */
  private hiddenForms(
    scope: TenantScope,
    restriction: FormRestriction,
  ): Promise<string[]> {
    return restriction.hiddenFormIdsIn(scope);
  }
}

/** What a caller is told about a line that is not theirs, or not there. */
export const MAIL_LOG_ENTRY_NOT_FOUND_MESSAGE =
  'Diese Protokollzeile wurde nicht gefunden.';

/** What a caller is told when „↻ Erneut" would resend or duplicate. */
export const MAIL_LOG_NOT_RETRYABLE_MESSAGE =
  'Nur eine fehlgeschlagene Zeile kann erneut versendet werden.';

/**
 * What a caller is told when „↻ Erneut" would send what the honeypot caught
 * (a security review finding).
 *
 * It says what the row is and what is *not* lost, in that order — the editor's
 * two questions in the order they ask them, exactly like
 * {@link HONEYPOT_SUPPRESSION_REASON} itself. Naming the registration is the
 * load-bearing half: without it the honest reaction to a false alarm is to ask
 * the participant to register again.
 */
export const MAIL_LOG_HONEYPOT_NOT_RETRYABLE_MESSAGE =
  'Diese Zeile wurde als Spam-Verdacht zurückgehalten und kann nicht erneut ' +
  'versendet werden: Empfänger und Inhalt stammen aus einer öffentlichen ' +
  'Absendung. Die zugehörige Antwort ist gespeichert und unter „Antworten" ' +
  'einsehbar.';

/**
 * What a caller is told when „↻ Erneut" would overwrite what physical
 * deletion kept (a review finding).
 *
 * It says why there is nothing to send **and** what the row is still good for,
 * in that order — the same two questions {@link
 * MAIL_LOG_HONEYPOT_NOT_RETRYABLE_MESSAGE} answers, because they are the two an
 * editor asks about a button that just refused.
 */
export const MAIL_LOG_ERASED_NOT_RETRYABLE_MESSAGE =
  'Die Daten dieser Zeile wurden endgültig gelöscht; es gibt nichts mehr zu ' +
  'versenden. Der Versandnachweis — Status, Zeitpunkt, Versuche und ' +
  'Absenderidentität — bleibt erhalten.';

/**
 * What a caller is told when „↻ Erneut" would resend a **system** mail
 * (ADR-0020, a review concern).
 *
 * The same two questions in the same order as with the two refusals
 * above: what this row is, and what is to be done instead. The second one is
 * the more important here — the way exists, it is reachable without a login, and
 * it belongs to the person concerned rather than to an organisation.
 *
 * Without an id, without an address and without the hint *which* account is meant:
 * the row shows its recipient anyway, and this refusal is meant to add
 * nothing to it.
 */
export const MAIL_LOG_SYSTEM_NOT_RETRYABLE_MESSAGE =
  'Diese Zeile ist eine Systemnachricht der Installation und wird hier nicht ' +
  'erneut versendet. Wer sie erwartet, fordert sie über „Passwort vergessen" ' +
  'selbst neu an.';

/**
 * One database row as the wire contract states it (`mailLogEntrySchema`).
 *
 * **Field by field, never a spread.** The row carries `tenant_id`, and the
 * boundary this whole module is built around would be undone by a payload that
 * simply hands it out — a client would learn the internal id of its own Organisation,
 * and the day somebody widens the delegate's `select`, whatever it picks up
 * would travel too. Listing the fields makes „what leaves the server" a
 * decision in a diff rather than a consequence of a schema change.
 *
 * **The body stays out**, although the table has carried one since 2026-07-28.
 * The mail log answers „wer, welcher Betreff, wie ging es aus"; the
 * subject alone is already why this route demands `can_view_responses`, and a rendered
 * mail per line would put every answer of an organisation on a page whose permission
 * does not cover answers. `ScopedMailLogDelegate` does not even select it.
 */
function toEntry(row: MailLogWithNotification): MailLogEntry {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    sentAt: row.sentAt?.toISOString() ?? null,
    recipient: row.recipient,
    subject: row.subject,
    notificationName: row.notification?.name ?? null,
    formId: row.formId,
    status: row.status,
    attempts: row.attempts,
    lastError: row.lastError,
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
    // On the list, since the table row must be able to withhold „↻ Erneut"
    // for a system row — the same boundary that {@link retry} draws, visible
    // one display earlier.
    trigger: row.trigger,
    // The requirement. Null travels as null and is **not** turned into
    // „system" here: „noch kein Versuch" and „über den System-Block gegangen"
    // are the two states the whole column exists to tell apart, and a `??`
    // anywhere on this path would silently merge them again.
    senderIdentity: row.senderIdentity,
    senderAddress: row.senderAddress,
    // The requirement — the value from the **queueing**, passed on unchanged.
    // No fallback onto today's chain: the whole purpose of the column is that
    // it says what went out, and not what would apply today.
    replyTo: row.replyTo,
  };
}
