import {
  MAIL_RECIPIENT_LIMIT,
  effectiveReplyTo,
  type notificationTriggerInputSchema,
  questionPlaceholderToken,
  recipientQuestionIds,
  renderMailSubject,
  resolveRecipients,
  type MailFormat,
  type MailTemplateContext,
  type NotificationTrigger,
  type ReplyToLevel,
} from '@formsache/shared';
import type { Prisma } from '@prisma/client';
import type { z } from 'zod';

import { parseStoredRecipients } from '../notifications/notification-questions';
import { renderNotificationBody } from '../notifications/notification-render';

/**
 * Which mails one accepted submission produces (the requirements, 30, 31).
 *
 * A pure function over rows that have already been read, deliberately: what
 * goes out is a **policy** — which notifications fire, whether the participant
 * is written to at all, how many addresses one notification may reach — and a
 * policy that can only be exercised through an HTTP request and a database is a
 * policy nobody re-reads. The writing itself is one `createMany` in
 * `PublicFormsService`, inside the transaction that stores the answer.
 *
 * **Nothing here decides whether a submission is accepted.** It is called after
 * the last link of the enforcement chain and inside its transaction; a mail
 * hangs on an *accepted* submission, which is the whole reason this package
 * came last.
 */

/**
 * What may *set off* a mail — the trigger side of `submit` and `edit`.
 *
 * Inferred from the shared **input** schema rather than written out, so this and
 * what the API accepts cannot drift: `save` belongs to the draft flow and no caller here can
 * be one. A second literal union spelling `'submit' | 'edit'` is exactly the
 * drift `pickDefaultColumns` was shared against.
 */
export type SubmissionTrigger = z.infer<typeof notificationTriggerInputSchema>;

/** A notification row, in the shape this module reasons about. */
export interface SubmissionNotification {
  readonly id: string;
  /**
   * Everything this notification fires on — the enum array of the column, read
   * as it comes out (the acceptance run).
   *
   * A set rather than one value since 2026-07-28, which is why the filter below
   * is an `includes()`. It is deliberately typed with the **wide** enum: a row
   * written straight into the database may say `save`, and this module's job is
   * to be silent about it rather than to refuse to read it.
   */
  readonly triggers: readonly NotificationTrigger[];
  readonly format: MailFormat;
  readonly toSubmitter: boolean;
  /** Raw JSONB, exactly as the column hands it out — parsed here, never cast. */
  readonly recipients: Prisma.JsonValue;
  readonly subject: string;
  /**
   * The body template — read here since the body is frozen at the enqueue
   * . Before that the send step fetched the
   * notification again and rendered whatever it said by then.
   */
  readonly body: string;
  /**
   * The reply address of this notification, or `null` for „es gilt, was
   * die Organisation bzw. das System vorgibt" — the topmost of the three
   * levels.
   *
   * Raw from the column: it is checked once, in {@link effectiveReplyTo},
   * together with the two levels below it.
   */
  readonly replyTo: string | null;
  readonly active: boolean;
}

/**
 * One `mail_log` row waiting to be written — everything about it that is *not*
 * the tenant, the form or the response.
 *
 * Those three are deliberately absent: they come from the **one** resolved form
 * row at the write site, never from here. `mail_log`
 * has no composite foreign key, so nothing under the application would catch a
 * row pairing Organisation A's `tenant_id` with Organisation B's `form_id`.
 */
export interface PendingMail {
  readonly notificationId: string;
  /**
   * Which trigger produced this row — written to `mail_log.trigger`.
   *
   * Carried on the row rather than passed a second time at the write site, so
   * the value in the column and the value the filter matched are **one**
   * statement. Two parameters could be handed `'submit'` and `'edit'` by
   * mistake, and the column that says „warum ging das raus" would then be the
   * one thing nothing checks.
   */
  readonly trigger: NotificationTrigger;
  readonly recipient: string;
  readonly subject: string;
  /**
   * The rendered body, with the `{{bearbeiten}}` slot still open
   * (`EDIT_LINK_MARK`) — see {@link renderNotificationBody}.
   *
   * The same two strings for every recipient of one notification: they are
   * rendered once per notification, because one submission's confirmation says
   * the same thing to the participant and to the organisation's office, and rendering
   * per row would be the shape in which the two could ever differ.
   */
  readonly bodyText: string;
  /** Only for `format: 'html'`; null for a plain-text notification. */
  readonly bodyHtml: string | null;
  /**
   * The **effective** `Reply-To` value of this row, or `null` for „diese Mail
   * trägt keine Kopfzeile" .
   *
   * **Resolved here and thereby frozen at the enqueue**, like recipient,
   * subject and body — the reasoning stands at `MailLog.replyTo` in
   * `schema.prisma`, and the short version is: `notification_id` is
   * `SetNull`, so a value resolved at sending would disappear silently as soon as
   * somebody deletes the notification. What is decided at *sending*
   * is the transport (`sender_identity`/`sender_address`) — that is the
   * record of an attempt, this here is part of the message.
   */
  readonly replyTo: string | null;
  /**
   * `queued` for an address, `failed` for an entry that is not one.
   *
   * A rejected recipient gets a row rather than being dropped, which is the
   * same promise the requirement no. 3 makes about the editor's input box:
   * „ungültige werden abgelehnt statt stillschweigend weggelassen". The
   * expensive failure of this whole package is „die Bestätigung wurde nie
   * erzeugt und niemand merkt es", and a mail log that says nothing
   * about the address it could not use is exactly that.
   */
  readonly status: 'queued' | 'failed';
  readonly lastError: string | null;
}

/**
 * Longest string stored as a `recipient`.
 *
 * Only reachable on the `failed` branch — a valid address is bounded by
 * `z.email().max(254)` in `mail-template.ts` — and it is there because that
 * branch is the one fed by an answer a stranger typed. `mail_log.recipient` is
 * `TEXT`, so without a bound a public form would decide how much of a log row a
 * submission gets to write. 320 is the longest address RFC 5321 allows.
 */
const RECIPIENT_MAX = 320;

/** German, because it lands in `mail_log.last_error`. */
export const UNRESOLVED_RECIPIENT_REASON =
  'Der Empfänger konnte aus dieser Antwort nicht gelesen werden: kein gültiger E-Mail-Empfänger.';

/**
 * What stands in the `recipient` column of a line that never had an address.
 *
 * The column is `NOT NULL` and the wire contract asks for a non-empty string
 * (`mailLogEntrySchema`), so a line without an address still needs *something*
 * — and it has to be something no address parser would accept, or the
 * mail log would show a destination that was never one. The reason
 * lives in `last_error`, where the view already reads it.
 */
export const NO_RECIPIENT_PLACEHOLDER = '(kein Empfänger)';

/**
 * Why a notification that resolved to **no** recipient still leaves a line
 * (the requirement's „im Versandprotokoll lesbar").
 *
 * The ordinary way to get here is the ordinary form: an optional e-mail
 * question the participant left blank. Nothing is wrong with the notification,
 * nothing is wrong with the answer — and yet the confirmation everybody expects
 * does not exist. Dropping that case silently is exactly the failure this whole
 * package is built against („die Bestätigung wurde nie erzeugt und niemand
 * merkt es"), and it is the *same* failure the `invalid` branch below already
 * refuses to commit for an address that could not be parsed.
 */
export function noRecipientReason(questionLabels: readonly string[]): string {
  if (questionLabels.length === 0) {
    return (
      'Kein Empfänger: diese Benachrichtigung hat keine Empfänger, an die ' +
      'gesendet werden könnte.'
    );
  }
  const named = questionLabels.map((label) => `„${label}"`).join(', ');
  return questionLabels.length === 1
    ? `Kein Empfänger: die Frage ${named} wurde nicht beantwortet.`
    : `Kein Empfänger: die Fragen ${named} wurden nicht beantwortet.`;
}

/**
 * Why a notification whose stored recipient list cannot be read sends nothing.
 *
 * Guessing a list would mean sending to addresses nobody can see on screen —
 * the notification editor refuses to display such a row until it is repaired
 * (`NotificationsService`), so the repair has a place. What it must not do is
 * disappear: an unreadable column is the one state in which „es ging keine Mail
 * raus" has no other trace at all.
 */
export const UNREADABLE_RECIPIENTS_REASON =
  'Kein Empfänger: die gespeicherte Empfängerliste dieser Benachrichtigung ' +
  'ist ungültig und wurde nicht verwendet.';

export interface SubmissionMailInput {
  readonly notifications: readonly SubmissionNotification[];
  /**
   * What just happened — `submit` for a first submission, `edit` for a
   * correction through the edit link (the acceptance run).
   *
   * Narrower than {@link NotificationTrigger} on purpose: `save` is the trigger
   * of the draft flow and no caller can be one. A notification carrying it is read and
   * kept silent (the `includes` below); nothing may *ask* for it.
   */
  readonly trigger: SubmissionTrigger;
  readonly context: MailTemplateContext;
  /**
   * The two **lower** levels of the `Reply-To` chain, in this order:
   * the default of the organisation, then that of the installation.
   *
   * Read by the caller and not here, because this module is a pure function
   * over rows already read. The **chain itself** is nevertheless evaluated only
   * once — below in a single {@link effectiveReplyTo}, in front of which
   * the level of the notification is placed. Two calls would be two
   * descriptions of the same rule, and the second would be the one that drifts.
   */
  readonly replyToDefaults: readonly ReplyToLevel[];
}

/**
 * The rows one submission adds to `mail_log`.
 *
 * The four rules, in the order they are applied:
 *
 * 1. **`active`** — a paused notification keeps its text and sends nothing.
 * 2. **`triggers` contains what just happened** — one `includes()` over the
 *    stored set (the acceptance run). „Bei Zwischenspeichern" is *absent, not
 *    disabled*, and stays so — an earlier package built the Zwischenspeichern **without** a
 *    mail. The write schema already refuses `save`
 *    (`notificationTriggersInputSchema`), so a `save` row can only be written
 *    straight into the database — and it must stay silent there too, or the
 *    non-goal holds only for as long as nobody uses `psql`. The `includes` keeps
 *    that: `['save'].includes('submit')` and `['save'].includes('edit')` are
 *    both false, so **no** path sends it.
 * 3. **A participant delivery needs nothing else** (review finding 24,
 *    2026-08-14). There used to be a third rule here: a second switch,
 *    *Nach dem Absenden → Bestätigung an Teilnehmer senden*, sitting in the
 *    settings of the form and deciding whether a notification addressed to the
 *    participant went out at all. It is gone. Setting up such a notification
 *    *is* the decision that it goes out, and a switch that silently swallows a
 *    configured, active notification is a state the editor had to explain in
 *    three places to be understandable at all.
 *
 *    What it means for a form that had it **off**: the migration
 *    `20260814120000_two_layer_form_settings` deactivated exactly those
 *    notifications (`active = false`), so „es geht nichts raus" stayed true and
 *    is now visible in the list where it belongs rather than hidden in a
 *    different section of a different page.
 * 4. **`MAIL_RECIPIENT_LIMIT`** — twenty addresses per notification, as **one** budget over valid and rejected entries alike. Two
 *    separate `slice`s made the documented twenty into forty rows, and the
 *    number that matters is how many lines one public submission may write.
 *    `notificationCreateSchema` bounds what the API accepts and
 *    `parseStoredRecipients` bounds what this module will read back, so this
 *    cap is the last floor rather than the first — kept because it is the one
 *    that sits directly in front of `createMany`, and because a public form
 *    must not be able to decide its own fan-out even if a bound above it is
 *    ever loosened.
 *
 * **A notification that reaches nobody leaves a `failed` line** rather than
 * nothing — an unreadable recipient column, or a list that resolves to no
 * address at all because the optional e-mail question was left blank. Silence
 * is the one outcome this module may not produce (see {@link noRecipientReason}).
 *
 * Where the participant's address comes from is **not** decided here: it is the
 * question the editor named through a recipient placeholder (which
 * replaced the „erste E-Mail-Frage" of an earlier draft). `resolveRecipients` reads
 * it out of the answer, one entry to at most one address — never two, which is
 * what keeps a public form from being an open relay.
 */
export function submissionMails(input: SubmissionMailInput): PendingMail[] {
  const mails: PendingMail[] = [];

  for (const notification of input.notifications) {
    if (
      !notification.active ||
      !notification.triggers.includes(input.trigger)
    ) {
      continue;
    }
    // **Read before the switch is applied, not after.** Whether this
    // notification is a participant delivery is a property of its recipient
    // list, so the list has to be parsed first — and parsed, never cast, since
    // JSONB accepts any JSON.
    const recipients = parseStoredRecipients(notification.recipients);
    const subject = renderMailSubject({
      template: notification.subject,
      context: input.context,
    });
    /*
     * **The body is rendered here, once, and never again** . Recipient and subject were always settled at the enqueue;
     * the body followed the notification and the answer as they stood at send
     * time, which is a different mail whenever anything moved in between — and
     * no mail at all once the answer was deleted. A confirmation confirms what
     * held at the moment it was sent.
     *
     * Rendered even for a line that will never leave (`failed` below): one code
     * path, and a mail log row whose body is missing for a reason that
     * has nothing to do with the body would be a second thing to explain.
     */
    const body = renderNotificationBody(notification, input.context);
    /*
     * **The whole chain, in one place and once per notification**
     * : notification → organisation → system. The first usable
     * address wins; if none is set, the result is `null` and the mail
     * goes out without that header — never a guessed address and never a
     * refusal to send (`effectiveReplyTo` gives the reason for both).
     *
     * Here and not at sending, for the same reason for which the body is
     * rendered here: a deleted notification must not silently take the value
     * with it.
     *
     * Computed for a row that never goes out as well (`failed` below) — one
     * code path, as with the body.
     *
     * **Only the address travels into the row, not the origin** (the requirement):
     * `mail_log.reply_to` says what went out; which level won back then
     * would be a statement about a configuration that need not exist that way
     * in 90 days any more. The origin is visible where it supports a decision
     * — on the read document of the notification.
     */
    const replyTo = effectiveReplyTo([
      { origin: 'notification', value: notification.replyTo },
      ...input.replyToDefaults,
    ]).address;

    if (recipients === null) {
      // Written **whatever the switch says**, and that is not a leak: a
      // `failed` line delivers nothing to anybody. It cannot be decided here
      // whether an unreadable list was a participant delivery, and a broken
      // column is worth a line either way — this is the one state in which „es
      // ging keine Mail raus" would otherwise have no trace at all.
      mails.push({
        notificationId: notification.id,
        trigger: input.trigger,
        recipient: NO_RECIPIENT_PLACEHOLDER,
        subject,
        bodyText: body.text,
        bodyHtml: body.html,
        replyTo,
        status: 'failed',
        lastError: UNREADABLE_RECIPIENTS_REASON,
      });
      continue;
    }

    const questionIds = recipientQuestionIds(recipients);

    const resolved = resolveRecipients(recipients, input.context);
    const entries: readonly Pick<
      PendingMail,
      'recipient' | 'status' | 'lastError'
    >[] = [
      ...resolved.addresses.map((address) => ({
        recipient: address,
        status: 'queued' as const,
        lastError: null,
      })),
      ...resolved.invalid.map((entry) => ({
        recipient: entry.slice(0, RECIPIENT_MAX),
        status: 'failed' as const,
        lastError: UNRESOLVED_RECIPIENT_REASON,
      })),
      // One budget over both lists, not one each (rule 4).
    ].slice(0, MAIL_RECIPIENT_LIMIT);

    if (entries.length === 0) {
      mails.push({
        notificationId: notification.id,
        trigger: input.trigger,
        recipient: NO_RECIPIENT_PLACEHOLDER,
        subject,
        bodyText: body.text,
        bodyHtml: body.html,
        replyTo,
        status: 'failed',
        lastError: noRecipientReason(
          questionLabels(questionIds, input.context),
        ),
      });
      continue;
    }

    for (const entry of entries) {
      mails.push({
        notificationId: notification.id,
        trigger: input.trigger,
        subject,
        bodyText: body.text,
        bodyHtml: body.html,
        replyTo,
        ...entry,
      });
    }
  }

  return mails;
}

/**
 * How the reason names the questions that supplied no address.
 *
 * The **caption**, because that is what the editor sees in the builder and in
 * the notification's recipient chip; the placeholder token only stands in when
 * the answer document does not carry the question at all, which is the case the
 * publish lock of C1a exists to prevent.
 */
function questionLabels(
  questionIds: readonly string[],
  context: MailTemplateContext,
): string[] {
  const byId = new Map(
    context.answers.map((row) => [row.questionId, row.label]),
  );
  return questionIds.map(
    (questionId) =>
      byId.get(questionId) ?? questionPlaceholderToken(questionId),
  );
}
