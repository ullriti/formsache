import { z } from 'zod';

import {
  effectiveReplyToSchema,
  replyToAddressSchema,
  replyToLevelSchema,
} from './reply-to.ts';

/**
 * Notifications, placeholders and the mail log — the wire contract both
 * sides are built against.
 *
 * Everything in here is shared on purpose. The placeholder grammar decides what
 * an editor may write *and* what the renderer resolves; the retention period
 * decides what the purge deletes *and* what the view promises. Two spellings of
 * either is the drift `pickDefaultColumns` was shared against — a rule
 * that holds in one half of the application and not in the other is worse than
 * no rule, because it looks enforced.
 *
 * The rendering itself is **not** here: `mail-template.ts` turns a notification
 * plus an answer into subject and body. This module only says what the pieces
 * are.
 */

// ---------------------------------------------------------------------------
// Limits and constants — each spelled exactly once
// ---------------------------------------------------------------------------

/**
 * How long a `mail_log` row is kept, in days.
 *
 * **The single source for both halves of that promise.** The purge job
 * deletes against this number and the mail log view says „Protokoll
 * wird 90 Tage aufbewahrt" from the same one. A second literal would be exactly
 * the drift `pickDefaultColumns` was shared against: the day somebody
 * changes the retention, one of the two would keep telling the old story — and
 * the one that keeps telling it is the one an organisation reads, while the one that
 * changed is the one that deletes.
 *
 * Counted from `created_at`, not `sent_at`: a row
 * that never went out would otherwise never expire, and that is precisely the
 * row still carrying an address nobody reached.
 */
export const MAIL_LOG_RETENTION_DAYS = 90;

/**
 * How often the worker retries one recipient before the row goes to `failed`.
 *
 * Deliberately a constant and **not** an environment variable. It is not a
 * deployment property — every installation wants the same answer to „when do we
 * stop asking a mail server that keeps saying no" — and every knob in the
 * environment is a knob an operator can set to a value no test ever ran with.
 * The backoff between attempts lives with the worker; only the ceiling is
 * shared, because the mail log describes it („nach 5 Versuchen aufgegeben").
 */
export const MAIL_MAX_ATTEMPTS = 5;

/**
 * Most addresses one notification may fan out to.
 *
 * One log row per recipient is the decided shape, so this is also the ceiling
 * on rows a single submission can produce — which is what makes it a limit
 * worth having rather than a tidiness rule: without it a form with a
 * question-placeholder recipient hands the fan-out size to whoever fills the
 * form in.
 */
export const MAIL_RECIPIENT_LIMIT = 20;

/** Longest editor-facing name of a notification. */
export const NOTIFICATION_NAME_MAX = 120;

/**
 * Longest subject template — **and longest rendered subject**.
 *
 * Generous, because placeholders expand. The rendered subject is bounded
 * against this same number by `renderMailSubject` (`truncateSubject`), which
 * also strips CR/LF, and that second bound is not a nicety: a
 * subject is built from answers, an answer is only as short as its question
 * says (`maxLength` defaults to `null`), and the result becomes an SMTP header
 * and a `mail_log.subject` row. The recipient address has carried the same kind
 * of ceiling since the beginning (`.max(320)`); the subject went without one.
 */
export const MAIL_SUBJECT_MAX = 300;

/** Longest body template. A mail is not a document; this is a typo guard. */
export const MAIL_BODY_MAX = 50_000;

// ---------------------------------------------------------------------------
// Placeholder grammar — the only definition in the project
// ---------------------------------------------------------------------------

/**
 * The placeholders that do **not** come from a question.
 *
 * Exactly six, and the list is closed.
 *
 * **`{{vorname}}`, `{{nachname}}` and `{{email}}` are deliberately absent.**
 * The wording of the requirement still names them; Konzept replaced
 * them on 2026-07-27 and the reason is not cosmetic: those three are *guessed
 * labels*. There is no first name in this system — there is a question whose
 * caption happens to read „Vorname", and which one that is differs per form and
 * per organisation. A form has whatever questions its author wrote, and binding a
 * placeholder to a caption fails the moment somebody renames „E-Mail" to
 * „E-Mail-Adresse" — or, worse, silently pairs two unrelated questions that
 * happen to share a caption (the same failure already ruled out for
 * the responses table). Everything personal is therefore a **question**
 * placeholder, addressed by question id.
 *
 * So: **do not add them here.** If a form needs a first name in its
 * confirmation mail, the editor inserts the chip of the question that asks for
 * one — `{{frage:<questionId>}}`.
 */
export const SYSTEM_PLACEHOLDERS = [
  /** Display name of the organisation the form belongs to. */
  'formularorganisation',
  /** Title of the form. */
  'formular',
  /** Submission date, already formatted by the caller (Europe/Berlin). */
  'datum',
  /** Table of **all** answers — its own render path, see `renderAnswerTable`. */
  'antworten',
  /**
   * What **this** edit changed — caption, old value, new value, one line per
   * question that really moved.
   *
   * The sibling of `antworten` and deliberately not a variant of it: an
   * unchanged answer does **not** appear here, or this would be „alle
   * Antworten mit zwei Spalten mehr" and the one sentence a change mail has to
   * carry — „das hier ist anders als in der Mail, die ihr abgeheftet habt" —
   * would be buried in the forty lines that are not.
   *
   * **Its content is decided at the enqueue, like everything except
   * `{{bearbeiten}}`** , and it has to be: there
   * is no history of answers in this system, so the previous values exist for
   * exactly as long as the `UPDATE` has not run. Rendering this later would
   * have nothing left to compare against — see `mailContextOf` in
   * `apps/api/src/notifications/notification-render.ts`, which reads them
   * before the write and hands them in.
   *
   * **In a mail that is not a correction it renders to empty text** — the same
   * rule `bearbeiten` follows when there is no link. A notification may fire on
   * `submit` *and* on `edit` since 2026-07-28, so „dieser Platzhalter hat hier
   * nichts zu sagen" is the ordinary case and not an exotic one; the editor's
   * preview says which trigger leaves it blank.
   */
  'aenderungen',
  /**
   * The participant's own edit link.
   *
   * **The only placeholder that is not resolved when the mail is queued**, and
   * the only one whose value is not in the answer at all. What is required is
   * the link „auf der Bestätigungsseite und — sofern eine Bestätigungs-Mail
   * konfiguriert ist — zusätzlich in dieser Mail"; without a token for it, only
   * the first half of that sentence could ever be built.
   *
   * Everything else about a mail is frozen at the enqueue precisely so that a
   * confirmation confirms what held when it was sent. This one cannot be: the
   * link is only a link while `allowEdit` is on and `response.edit_token` still
   * exists (it is cleared when the access word is switched on), and both
   * are read **on every access** by the route behind it. Freezing a link that
   * has since been revoked would put a dead address in a stranger's inbox,
   * where it cannot be taken back. So it is a hole in the stored body that the
   * send step fills — see `EDIT_LINK_MARK` in `mail-template.ts`.
   *
   * **It resolves to nothing when there is no link**, rather than to an address
   * that is guaranteed to fail: `allowEdit` off, a revoked token, a deleted
   * answer. The rest of the mail stays exactly as it was written.
   */
  'bearbeiten',
] as const;

export const systemPlaceholderSchema = z.enum(SYSTEM_PLACEHOLDERS);
export type SystemPlaceholder = z.infer<typeof systemPlaceholderSchema>;

/**
 * What a question placeholder is written with: `{{frage:<questionId>}}`.
 *
 * German in the template because the editor reads it, English in the
 * identifiers around it.
 *
 * **The id is stored, the caption is displayed** . The editor shows
 * the question's text on the chip; what lands in the database is the uuid, so
 * renaming a question is free and only *removing* one breaks the reference —
 * which is exactly the case the publish lock is meant to catch.
 */
export const QUESTION_PLACEHOLDER_PREFIX = 'frage:';

/** What one `{{…}}` token means. */
export type Placeholder =
  | { readonly kind: 'system'; readonly name: SystemPlaceholder }
  | { readonly kind: 'question'; readonly questionId: string }
  /**
   * A token that looks like a placeholder and names nothing we know.
   *
   * It is a case rather than an error because the requirement says what has
   * to happen to it: it stays in the text **unchanged** and the preview marks
   * it. Turning it into empty text is the variant nobody notices until the mail
   * is out.
   */
  | { readonly kind: 'unknown'; readonly name: string };

/** One token found in a template, with where it sits. */
export interface PlaceholderMatch {
  /** The token exactly as written, braces included. */
  readonly raw: string;
  /** Index of the first `{` in the source text. */
  readonly start: number;
  /** Index just past the last `}`. */
  readonly end: number;
  readonly placeholder: Placeholder;
}

/**
 * A **fresh** regular expression matching one `{{…}}` token.
 *
 * A function rather than an exported constant, and that is the whole point: a
 * module-scope `RegExp` with the `g` flag carries `lastIndex` between calls, so
 * two callers — or one caller iterating twice — silently skip matches depending
 * on what ran before them. It is the classic shared-mutable-state bug and it
 * only shows up under a second consumer, which is exactly the situation this
 * package is in.
 *
 * Inner whitespace is tolerated and trimmed: `{{ formularorganisation }}` is the same
 * token as `{{formularorganisation}}`. An editor typing one by hand should not get an
 * „unknown placeholder" for a space.
 *
 * It deliberately matches names this module does **not** know, `{{vorname}}`
 * among them: an unknown placeholder has to be *recognised* in order to be left
 * alone and marked in the preview. A pattern that only
 * matched the four known names would leave `{{vorname}}` looking like ordinary
 * text, and then nothing could tell the administrator that it will never be
 * filled in.
 */
export function placeholderPattern(): RegExp {
  return /\{\{\s*([A-Za-z0-9_.:-]+)\s*\}\}/g;
}

/** What a `{{…}}` token with this inner name refers to. */
export function classifyPlaceholder(name: string): Placeholder {
  const system = systemPlaceholderSchema.safeParse(name);
  if (system.success) {
    return { kind: 'system', name: system.data };
  }
  if (name.startsWith(QUESTION_PLACEHOLDER_PREFIX)) {
    const questionId = name.slice(QUESTION_PLACEHOLDER_PREFIX.length);
    // `{{frage:}}` names no question. It is unknown rather than a question with
    // an empty id, so it survives rendering verbatim instead of resolving to
    // nothing at all.
    if (questionId !== '') {
      return { kind: 'question', questionId };
    }
  }
  return { kind: 'unknown', name };
}

/** Every placeholder token in a template, in the order it appears. */
export function scanPlaceholders(text: string): PlaceholderMatch[] {
  const pattern = placeholderPattern();
  const found: PlaceholderMatch[] = [];
  for (const match of text.matchAll(pattern)) {
    const [raw, name] = match;
    // The group is not optional in the pattern, so this never fires; it is how
    // the type stays honest without a non-null assertion.
    if (name === undefined) {
      continue;
    }
    found.push({
      raw,
      start: match.index,
      end: match.index + raw.length,
      placeholder: classifyPlaceholder(name),
    });
  }
  return found;
}

/** The token that inserts a system value — spelled once, for the chips. */
export function systemPlaceholderToken(name: SystemPlaceholder): string {
  return `{{${name}}}`;
}

/** The token that inserts one question's answer. Stores the **id**, not the caption. */
export function questionPlaceholderToken(questionId: string): string {
  return `{{${QUESTION_PLACEHOLDER_PREFIX}${questionId}}}`;
}

/**
 * The question ids one template refers to, without duplicates.
 *
 * This is what the publish lock is checked with: publishing is refused while a
 * notification still points at a question the new version drops. Reading it off
 * the text rather than off a stored list is deliberate — a stored list would be
 * a second truth that can disagree with what the editor actually wrote.
 */
export function questionPlaceholderIds(text: string): string[] {
  const ids = scanPlaceholders(text)
    .map((match) => match.placeholder)
    .filter((placeholder) => placeholder.kind === 'question')
    .map((placeholder) => placeholder.questionId);
  return [...new Set(ids)];
}

/**
 * A template with every `{{frage:<id>}}` whose id is in `idMap` rewritten to
 * the mapped id — what duplicating a form does to its notifications.
 *
 * Without this, a duplicated form's confirmation mail would still say
 * `{{frage:<the original's id>}}` — an id that names no question on **this**
 * form, because every question of it just got a new one. A question id the
 * answer's context does not carry renders **verbatim**
 * (`renderPlaceholder`/`neutraliseLiteral`, `mail-template.ts`) — the same
 * fallback an unrecognised token gets — so an unrewritten placeholder would
 * not fail loudly; it would sit in a delivered mail exactly as an editor never
 * wrote it, `{{frage:…}}` and all.
 *
 * An id **not** in `idMap` is left exactly as written — a system placeholder,
 * an already-unknown token, or a question this rewrite was not asked to
 * account for. That is not „this token is broken", it is the caller's
 * business (`questionPlaceholderIds`/the publish lock already catch a
 * placeholder that resolves to nothing).
 *
 * Matches are rewritten back to front so that an earlier match's `start`/`end`
 * — read off the **original** text — stays correct while later ones are
 * replaced; a forward pass would shift everything after the first rewrite.
 */
export function rewriteQuestionPlaceholders(
  text: string,
  idMap: ReadonlyMap<string, string>,
): string {
  const matches = scanPlaceholders(text);
  let result = text;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    if (match?.placeholder.kind !== 'question') {
      continue;
    }
    const mapped = idMap.get(match.placeholder.questionId);
    if (mapped === undefined) {
      continue;
    }
    result =
      result.slice(0, match.start) +
      questionPlaceholderToken(mapped) +
      result.slice(match.end);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------

/**
 * One address a notification goes to — literal, or read out of an answer.
 *
 * A discriminated union rather than a bare string, and that is why the column
 * is JSONB instead of `text[]` (the reason is repeated at the column in
 * `apps/api/prisma/schema.prisma`): a recipient may *be* a
 * placeholder, so an entry carries a kind and a value and can grow a third
 * kind later without a migration over live rows.
 *
 * A literal address is validated **here and per address** .
 * `z.email()` refuses `Max <evil@example.com>`, `a@b.de, c@d.de` and anything
 * carrying CR/LF, so one entry can never become two recipients or a second
 * SMTP header. Splitting a comma-separated string is the shape that fails that
 * test, and the editor's comma-separated input box is therefore split and
 * validated in the client *before* it becomes entries — never here.
 */
export const notificationRecipientSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('literal'),
    address: z.email().max(320),
  }),
  z.strictObject({
    kind: z.literal('question'),
    questionId: z.uuid(),
  }),
]);
export type NotificationRecipient = z.infer<typeof notificationRecipientSchema>;

/** The question ids a recipient list refers to, without duplicates. */
export function recipientQuestionIds(
  recipients: readonly NotificationRecipient[],
): string[] {
  const ids = recipients
    .filter((recipient) => recipient.kind === 'question')
    .map((recipient) => recipient.questionId);
  return [...new Set(ids)];
}

/**
 * A recipient list with every `question` entry whose id is in `idMap`
 * rewritten to the mapped id — the recipients' half of the same rewrite,
 * `rewriteQuestionPlaceholders` above being the templates' half.
 *
 * A `literal` entry is untouched (it names no question, so there is nothing
 * to remap); a `question` entry whose id is **not** in `idMap` is untouched
 * too, for the reason {@link rewriteQuestionPlaceholders} gives — a reference
 * this rewrite was not asked to account for is left exactly as written rather
 * than guessed at.
 */
export function rewriteRecipientQuestionIds(
  recipients: readonly NotificationRecipient[],
  idMap: ReadonlyMap<string, string>,
): NotificationRecipient[] {
  return recipients.map((recipient) => {
    if (recipient.kind !== 'question') {
      return recipient;
    }
    const mapped = idMap.get(recipient.questionId);
    return mapped === undefined
      ? recipient
      : { ...recipient, questionId: mapped };
  });
}

// ---------------------------------------------------------------------------
// Notifications — wire contract
// ---------------------------------------------------------------------------

/**
 * Every trigger the **schema** knows.
 *
 * `save` is in here because a row written directly into the database has to
 * stay readable. It is **not** in {@link notificationTriggerInputSchema}: the
 * trigger is „abwesend, nicht deaktiviert", and a control that offers something
 * nothing can fire promises a function the application does not have.
 *
 * **This is now permanent, and the sentence that used to stand here was wrong
 * about the future.** It read „turning ‚Bei Zwischenspeichern' on must be an
 * additive change" — and it was built *without* a mail
 * : the participant is shown the address and copies
 * it, so there is no message for the trigger to carry. Nothing is planned to
 * move `save` into the input schema. The value stays in the enum for the one
 * reason above and for the second one below (`notificationSchema` has to stay
 * able to list a hand-written row), not as a placeholder for something coming.
 *
 * **`edit` was added on 2026-07-28.** Until then a
 * correction made through the edit link sent nothing at all, and that was
 * not a forgotten line but a decision nobody had taken: the one trigger was
 * called „Bei Absendung", and an edit is not a submission. Two things pay for
 * it. An organisation's office files the registration mail and then the participant
 * changes their answers — the filed mail is wrong and **nothing says so**, which
 * is the silent divergence, the expensive direction. And the edit link is an
 * **owner capability**: a mail on every change is the only way a participant
 * ever learns that their link has leaked.
 */
export const notificationTriggerSchema = z.enum([
  'submit',
  'save',
  'edit',
  /**
   * **System mail** (ADR-0020) — a row that no form triggered, but the
   * application did: the reset link and the notice about an administratively
   * set password.
   *
   * Stands here because the mail log displays the value. It does **not** stand
   * in {@link notificationTriggerInputSchema}: a notification cannot carry it,
   * and what does carry it is written by the server itself. What hangs on it
   * is no label but the sending identity and the base address — see
   * `schema.prisma`, `NotificationTrigger.system`.
   */
  'system',
]);
export type NotificationTrigger = z.infer<typeof notificationTriggerSchema>;

/**
 * The triggers the **API** accepts — the narrower half of the pair above.
 *
 * The server refuses `save` on the way in rather than hiding it in the editor:
 * a non-goal that is only enforced in the UI is a non-goal until somebody uses
 * curl.
 */
export const notificationTriggerInputSchema = z.enum(['submit', 'edit']);
export type NotificationTriggerInput = z.infer<
  typeof notificationTriggerInputSchema
>;

/**
 * What a client may write into `triggers`: **a non-empty set**, no duplicates.
 *
 * A list rather than a single value since 2026-07-28, and stored as a Postgres
 * enum array rather than JSONB: the array is type-safe at the database level,
 * whereas JSONB would have been the **third** unchecked column next to
 * `recipients` and `answers` — each of which needs its own parse-instead-of-cast
 * discipline. The price is that a new trigger needs a migration, and that is
 * exactly the ceremony one wants around the thing that decides when mail leaves
 * the building.
 *
 * **Non-empty**, because a notification that fires on nothing is a text nobody
 * can explain: the switch for that is `active`, and it keeps the reason
 * readable. **Without duplicates**, because `['submit', 'submit']` is not a
 * second mail — the send path asks `includes()` — so allowing it would store two
 * spellings of one statement.
 */
export const notificationTriggersInputSchema = z
  .array(notificationTriggerInputSchema)
  .min(1)
  // Bounded before the duplicate check so a huge array is refused by length
  // rather than walked into a `Set`. Derived, so a fourth trigger does not need
  // a number changed here as well.
  .max(notificationTriggerInputSchema.options.length)
  .refine((triggers) => new Set(triggers).size === triggers.length, {
    message: 'Ein Auslöser darf nur einmal vorkommen.',
  });

export const mailFormatSchema = z.enum(['html', 'text']);
export type MailFormat = z.infer<typeof mailFormatSchema>;

/** Timestamps travel as ISO-8601 strings, as everywhere else on this wire. */
const timestampSchema = z.iso.datetime();

/** What a create and an update alike may say about a notification. */
const notificationWriteShape = {
  name: z.string().trim().min(1).max(NOTIFICATION_NAME_MAX),
  triggers: notificationTriggersInputSchema.default(['submit']),
  format: mailFormatSchema.default('html'),
  // `toSubmitter` is deliberately **absent** here. It never created a recipient — it only marked a
  // notification as participant delivery, and it is what the derivation at
  // `addressesSubmitter` (`apps/api/src/notifications/notifications.service.ts`)
  // and `submissionMails` (`apps/api/src/public/submission-mail.ts`) compute from
  // `recipients` instead: a question recipient reads the participant's own
  // address out of the answer, so it *is* participant delivery whatever a
  // second, independent flag said. Removing the field from the write schema
  // stops a client from setting the two out of step — the column itself stays
  // (`notificationSchema` below still reads it), and the tolerant server-side
  // derivation stays exactly as it was, because a row written straight into the
  // database has no `recipients`-based signal to fall back on.
  recipients: z
    .array(notificationRecipientSchema)
    .max(MAIL_RECIPIENT_LIMIT)
    .default([]),
  subject: z.string().trim().min(1).max(MAIL_SUBJECT_MAX),
  body: z.string().max(MAIL_BODY_MAX),
  /**
   * The reply-to address of this notification, or `null` for „es gilt, was
   * die Organisation bzw. das System vorgibt" .
   *
   * **`null` is no empty field but the inheritance.** The chain stands at one
   * place (`effectiveReplyTo` in `@formsache/shared`): notification →
   * organisation → system; if nothing is set anywhere, the mail goes out
   * without a header instead of inventing an address or refusing to send.
   *
   * Checked with `replyToAddressSchema` — literally the `from` of the SMTP
   * block, so that „was ist eine Adresse?" gets no second answer here.
   * `Name <adresse>`, two comma-separated addresses and everything with CR/LF
   * therefore already fall through here and can never become a second header.
   *
   * **Required and nullable, explicitly without `.default(null)`** — unlike
   * the four fields around it, and that is the point. The route replaces the
   * whole document (`PUT`), and a default value would mean here: whoever
   * leaves the key out *deletes* a configured reply-to address, without saying
   * so and without finding out. That is exactly what the comment on
   * `ScopedNotificationDelegate`'s write shape one level down rules out, and
   * exactly how the two sister routes of the same field decide
   * (`updateSystemMailSettingsRequestSchema`, `tenantReplyToWriteSchema`):
   * three places, one field, one answer to „was heißt weggelassen?" — namely
   * 400.
   *
   * That `triggers`, `format`, `recipients` and `active` still have defaults is
   * no silent agreement to the opposite: they are older than this rule and
   * carry the same half-measure on. Here it is not continued.
   */
  replyTo: replyToAddressSchema.nullable(),
  active: z.boolean().default(true),
};

export const notificationCreateSchema = z.strictObject(notificationWriteShape);
export type NotificationCreate = z.infer<typeof notificationCreateSchema>;

/**
 * A full replacement, `PUT` semantics — the same shape as the create.
 *
 * Spelled as its own schema rather than aliased, so the day one of the two
 * grows a field (a `replyTo` belongs to a later addition) the other does not silently follow.
 */
export const notificationUpdateSchema = z.strictObject(notificationWriteShape);
export type NotificationUpdate = z.infer<typeof notificationUpdateSchema>;

/**
 * A notification as the API hands it out.
 *
 * `triggers` is the **wide** enum here, unlike on the way in: a row somebody
 * wrote straight into the database — the very fixture the non-goal of „Bei
 * Zwischenspeichern" is proven with — has to remain listable. A read schema
 * that refused it would turn a row the server correctly ignores into a page
 * that cannot be opened.
 *
 * And it is deliberately **not** `.min(1)` either, unlike
 * {@link notificationTriggersInputSchema}: the empty array is the same kind of
 * row. It fires on nothing, which is what an unreadable trigger set should do,
 * and refusing to *display* it would hide the one thing an editor needs in order
 * to repair it.
 */
export const notificationSchema = z.strictObject({
  id: z.uuid(),
  formId: z.uuid(),
  name: z.string().min(1),
  triggers: z.array(notificationTriggerSchema),
  format: mailFormatSchema,
  toSubmitter: z.boolean(),
  recipients: z.array(notificationRecipientSchema),
  subject: z.string(),
  body: z.string(),
  /**
   * As on the way in, but **loose** — a `z.string().nullable()`, not a
   * `replyToAddressSchema`.
   *
   * For the same reason that `triggers` is the wide enumeration here: a row
   * somebody wrote straight into the database has to stay displayable so that
   * it can be repaired. An unusable value sends nothing wrong — the chain lets
   * it fall through (`effectiveReplyTo`) —, but a page that cannot be opened
   * because of it would take away from the editor exactly what it needs for
   * the repair.
   */
  replyTo: z.string().nullable(),
  /**
   * **What actually applies — and why.**
   *
   * `replyTo` one line further up is the *topmost level*, not the answer:
   * `null` means there „es gilt, was die Organisation bzw. das System
   * vorgibt", and the two other levels stand in rows this document does not
   * contain. An editor that only gets `replyTo` therefore **cannot** work out
   * the effective address — it knows exactly one third of the chain. Formerly
   * a test mail was the only way to find it out.
   *
   * Derived, never written: the route works it out from `effectiveReplyTo` on
   * every read (`NotificationsService`), there is no column for it, and the
   * write schemas do not know it.
   *
   * **The effective value of a mail that is already queued does not stand
   * here**, but in `mail_log.reply_to` ({@link
   * mailLogEntrySchema.shape.replyTo}): this field says what the *next* mail
   * will carry, and changes along with every level.
   */
  effectiveReplyTo: effectiveReplyToSchema,
  active: z.boolean(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Notification = z.infer<typeof notificationSchema>;

/** How long a template key may be — see the field's own note. */
const TEMPLATE_ID_MAX = 64;

/**
 * One ready-made notification, as the system layer stores it and as the API
 * hands it out.
 *
 * Deliberately **not** a `notificationCreateSchema`: a template says nothing
 * about recipients. Who a mail goes to depends on the form's own questions
 *  — „Bestätigung an Teilnehmer" needs the e-mail question *of this
 * form*, and an id cannot be written into an installation-wide document. The
 * editor fills that in, which is also why applying a template leaves the
 * recipient chips alone.
 *
 * **Strict, and the same schema on both ends.** It validates the stored
 * `system_setting.notification_templates` document *and* the `templates` the
 * list route below hands out, so „was der Superadmin schreiben darf" and „was
 * der Editor angeboten bekommt" cannot describe two different things. The
 * bounds are the ones a notification is bound by (`notificationWriteShape`), so
 * a template can never be a text the API would then refuse to store.
 */
export const notificationTemplateSchema = z.strictObject({
  /**
   * Stable key — for `key` props and test fixtures, never stored on a row.
   *
   * Bounded like every other field here, and for the reason
   * `NOTIFICATION_TEMPLATE_LIMIT` gives: a document written straight into the
   * database has never seen a request schema, and this one is handed to every
   * editor who opens the page. Sixty-four characters is far more than a key
   * anybody types and far less than a payload worth worrying about.
   */
  id: z.string().min(1).max(TEMPLATE_ID_MAX),
  /** What the picker offers it as; also the name the new notification gets. */
  name: z.string().trim().min(1).max(NOTIFICATION_NAME_MAX),
  /**
   * One line saying when this one is the right choice.
   *
   * Bounded by the same number as the name: both are picker text, both are
   * rendered on one line, and a second limit would be a second number to keep
   * in step.
   */
  description: z.string().trim().min(1).max(NOTIFICATION_NAME_MAX),
  triggers: notificationTriggersInputSchema,
  format: mailFormatSchema,
  subject: z.string().trim().min(1).max(MAIL_SUBJECT_MAX),
  body: z.string().min(1).max(MAIL_BODY_MAX),
  /**
   * Whether this template's mail goes to the person who filled the form in.
   *
   * A hint for the editor, not a recipient: it decides whether the picker
   * suggests the form's e-mail question as recipient. The decision that
   * actually matters is taken server-side from the stored recipients
   * (`submissionMails`, `apps/api/src/public/submission-mail.ts`).
   */
  toSubmitter: z.boolean(),
});
export type NotificationTemplate = z.infer<typeof notificationTemplateSchema>;

/**
 * The list route's payload.
 *
 * **The templates travel with the notifications** . They are
 * an installation-wide setting, so the editor cannot hold them as a
 * constant any more — a superadmin change has to reach the picker, and the
 * request that opens the picker is this one. Delivered here rather than through
 * a route of their own so that the offer and the rows it will sit next to
 * cannot come from two different moments in time; the permission is the same
 * either way (`can_manage_settings` on this form).
 *
 * ## `templates` is required, and that couples the two halves of a deploy
 *
 * This object is `strict` and the key has no default, so a **stale browser tab**
 * on the previous bundle throws on this payload, and a **new bundle against an
 * old API** throws on the missing key. Both are loud, both are confined to the
 * Benachrichtigungen page, and both are cured by a reload.
 *
 * That is the deliberate half of the trade. The alternative, `.default([])`,
 * would silence the second case — and silence it by producing **exactly the
 * answer that means something else**: `[]` is „diese Installation bietet keine
 * Vorlagen an" (`systemNotificationTemplatesSchema`), so an old server would
 * become indistinguishable from a superadmin who deleted every template. A
 * default that fabricates a decision nobody took is worse than a parse error
 * that names its cause — the same trade this application already refuses one
 * layer down, where „unlesbar" must never become „nichts entschieden"
 * (`settings-enforcement.ts`).
 *
 * The coupling is affordable because the two halves ship together: `web` and
 * `api` are built from one repository and started by one `docker compose up`
 * (`docs/kb/04-build-run.md`), so „alter Client, neuer Server" is a tab left
 * open across a deploy rather than a supported configuration. The day that
 * stops being true — a separately deployed front end, or outside clients — this
 * key is the first one that has to become optional, and then with a reading
 * that can tell „nicht geliefert" from „leer".
 */
export const notificationListResponseSchema = z.strictObject({
  notifications: z.array(notificationSchema),
  templates: z.array(notificationTemplateSchema),
  /**
   * **The two inherited levels of the `Reply-To` chain — organisation, then
   * system**, raw and in the order in which they apply.
   *
   * They stand **once per list** and not per row: they are the same for every
   * notification of a form, and one copy per row would be the same answer
   * several times over, with the possibility of drifting apart.
   *
   * **Why at all, when `effectiveReplyTo` already stands there.** That field
   * answers the question for the **stored** row. The editor, however, asks it
   * over a *draft* — „was gilt, wenn ich das hier so speichere?" —, and for a
   * notification that has not even been created there is no
   * `effectiveReplyTo`, although the answer exists. With these two levels the
   * editor puts its own topmost one in front of them and calls
   * `effectiveReplyTo` from `@formsache/shared`: the same function, the same
   * precedence, no second chain.
   *
   * **No secret** — the same reasoning that
   * `NotificationsService.inheritedReplyTo` sets out at length: the reply-to
   * address stands as a header in every mail this organisation sends, and
   * whoever writes the notifications causes exactly those mails.
   */
  inheritedReplyTo: z.array(replyToLevelSchema),
});
export type NotificationListResponse = z.infer<
  typeof notificationListResponseSchema
>;

/** Parses what the API answered; the client validates too. */
export function parseNotificationList(
  input: unknown,
): NotificationListResponse {
  return notificationListResponseSchema.parse(input);
}

/**
 * Every question id one notification refers to — subject, body **and**
 * recipients.
 *
 * All three in one function because one question („zeigt hier
 * noch etwas ins Leere?") and three call sites would be three chances to check
 * two of them.
 */
export function notificationQuestionIds(notification: {
  readonly subject: string;
  readonly body: string;
  readonly recipients: readonly NotificationRecipient[];
}): string[] {
  return [
    ...new Set([
      ...questionPlaceholderIds(notification.subject),
      ...questionPlaceholderIds(notification.body),
      ...recipientQuestionIds(notification.recipients),
    ]),
  ];
}

// ---------------------------------------------------------------------------
// Sending log — wire contract
// ---------------------------------------------------------------------------

export const mailStatusSchema = z.enum(['queued', 'sent', 'failed']);
export type MailStatus = z.infer<typeof mailStatusSchema>;

/**
 * **Under whose identity a line actually left** (a review finding) — the
 * installation's mail server, or the organisation's own block.
 *
 * Two values and not three, because there is no third: the identity is
 * resolved per row from the *row's own* Organisation (`MailIdentityService.resolve`),
 * so `own` can only ever mean the organisation the line belongs to. A name would be a
 * second, ageing copy of `tenant.name`; the pair „welche Art von Block" plus
 * {@link mailLogEntrySchema}'s `senderAddress` says the same thing without one.
 *
 * **Written when the row is sent, never when it is queued.** A `queued` line
 * carries `null` here, and that is a statement rather than a gap: the identity
 * is resolved at send time, so one frozen at enqueue would be a lie the moment
 * an organisation switches System→eigen and presses „↻ Erneut". The view says „noch
 * nicht versandt" for `null` and must not say „System" — that is the whole
 * distinction this column exists to make.
 */
export const mailSenderIdentitySchema = z.enum(['system', 'own']);
export type MailSenderIdentity = z.infer<typeof mailSenderIdentitySchema>;

/**
 * One line of the mail log — **one recipient**, not one mail.
 *
 * **No body — on the wire, and only on the *list*.** The table has carried one
 * since 2026-07-28 (`mail_log.body_text`, `body_html`): a confirmation has to
 * confirm what held at the moment it was sent, so the text is frozen when the
 * answer arrives instead of being re-rendered at send time. This payload
 * deliberately does not follow. `ScopedMailLogDelegate.findMany` reads up to 200
 * rows at once for the table; 200 rendered mails would put a whole organisation's answer
 * values on the wire for one page view, which is not what „wer, welcher Betreff,
 * wie ging es aus" needs — the subject alone is already why the requirement demands
 * `can_view_responses`. A single row is a different trade-off and gets its own
 * schema, {@link mailLogDetailSchema} below, for the work item „die gerenderte
 * Mail ansehen".
 *
 * It is a `strictObject`, so this is enforced from both ends: a server that
 * started sending the body on *this* route would make `parseMailLogList` throw
 * in the client and take the whole view down, rather than quietly widening what
 * the page shows.
 *
 * **`mail_log.trigger` *is* here, and it used to not be** (a review finding).
 * The argument for leaving it to the detail — „warum ging das raus" is a
 * question about one row — held only as long as nothing in the *table* depended
 * on the answer. Since ADR-0021 something does: „↻ Erneut" refuses a
 * `trigger = 'system'` line with a 409 (`MailLogService.retry`), so the detail
 * panel could tell that the line is not retryable and the row above it could
 * not — it offered the button and walked the editor into the refusal. The
 * boundary stays where it is; what changes is that the offer can now agree with
 * it. The column is a four-value enum carrying nothing personal, which is the
 * same reason {@link mailLogEntrySchema.shape.senderIdentity} travels with the
 * list.
 */
export const mailLogEntrySchema = z.strictObject({
  id: z.uuid(),
  /** When the line was queued. Also what the 90-day purge is counted from. */
  createdAt: timestampSchema,
  /** When it actually left, or null while it has not. */
  sentAt: timestampSchema.nullable(),
  /**
   * Who the line was addressed to — **or `null`, meaning the address has been
   * erased** .
   *
   * ## The decision behind this field, and why it went this way
   *
   * This field was `z.string().min(1)` until 2026-08-03, and the review
   * named it as an open point: „**Diese Entscheidung** muss fallen: Platzhalter
   * schreiben oder das Feld nullable machen, sonst bricht das Leeren der
   * personenbezogenen Spalten den Parse." Physical deletion blanks four
   * columns of `mail_log` — `recipient`, `subject`, `body_text`, `body_html` —
   * and leaves the row, so the wire has to be able to say „diese Zeile hat
   * keinen Empfänger mehr" without an empty string failing `min(1)` and taking
   * a whole organisation's mail log down with a parse error.
   *
   * **Decided: `null`, not a placeholder.** Four reasons, in order of weight:
   *
   * 1. **The project has already decided this exact question shape.** That decision
   *    (2026-07-31) ruled on `other: ''` against `other: null` — „weil ‚kein
   *    Freitext' ein Zustand ist und kein leerer Text" — and made `null` the
   *    canonical form. An erased recipient is an absence, not a value, and the
   *    two answers ought to be spelled the same way.
   * 2. **A placeholder is display text in a data column.** `'(gelöscht)'` is a
   *    German sentence that only one view ever renders; frozen into a column it
   *    ages, cannot be worded differently, and is indistinguishable in SQL from
   *    a row whose recipient genuinely was that string.
   * 3. **`recipient IS NULL` is checkable, `= ''` is not.** „Zeig mir jede
   *    anonymisierte Zeile" is the query the DSGVO promise is
   *    demonstrated with, and an empty string collides with any other way a
   *    recipient could end up empty.
   * 4. **The column already has one sentinel and must not get a second.**
   *    `'(kein Empfänger)'` (`apps/api/src/public/submission-mail.ts`) means
   *    „diese Zeile hatte nie eine Adresse". That is a *different* state from
   *    „sie hatte eine, und sie ist weg", and two sentinels in one column are
   *    two things a reader has to know by heart. `null` beside one sentinel is
   *    a flag the type system carries.
   *
   * The price is named rather than hidden: `mail_log.recipient` and
   * `mail_log.subject` had to lose their `NOT NULL` (migration
   * `20260803120000_mail_log_erasable_columns`), and every reader of the two
   * columns now handles the null. There are **three** of them, not the two this
   * paragraph used to count (a review finding): the mail log, the mail
   * worker — and `MailLogService.retry`, which refuses a blanked line outright
   * (a review finding). Miscounting them is what let „↻ Erneut" overwrite the
   * delivery record this very erasure promises to keep.
   *
   * **`null` here implies `subject`, `bodyText`, `bodyHtml` and `lastError` are
   * null too**: they are blanked by one statement (`ERASED_MAIL_LOG_COLUMNS` in
   * the API). The view needs no separate flag.
   */
  recipient: z.string().min(1).nullable(),
  /** The subject, or `null` once erased — see {@link mailLogEntrySchema.shape.recipient}. */
  subject: z.string().nullable(),
  /** Name of the notification behind it, or null once that one was deleted. */
  notificationName: z.string().nullable(),
  /**
   * What triggered this row — see the head of this schema for the reason why
   * it travels with the list and not only with the detail.
   *
   * The **wide** enumeration, as in {@link notificationSchema}: a row that was
   * written into the database by hand or is older than this column has to stay
   * readable, instead of letting a whole mail log fail at the parse.
   */
  trigger: notificationTriggerSchema,
  /** The form it went out for — what the prefilter selects on. */
  formId: z.uuid().nullable(),
  status: mailStatusSchema,
  attempts: z.number().int().nonnegative(),
  /** Readable reason for `failed`, and the reason for `queued` without SMTP. */
  lastError: z.string().nullable(),
  nextAttemptAt: timestampSchema.nullable(),
  /**
   * Which identity the last attempt went out under, or `null` while there has
   * been none. See {@link mailSenderIdentitySchema}.
   *
   * On the **list** and not only on the detail, unlike `trigger`: „über welchen
   * Mailserver ging das raus" is the question an organisation asks about a *batch* when
   * SPF or DKIM stops working after a switch — one line at a time would be the
   * wrong instrument for it. It costs two scalar columns in the projection and
   * carries nothing personal: an installation's or an organisation's own
   * sending address is neither a participant's datum nor a secret.
   */
  senderIdentity: mailSenderIdentitySchema.nullable(),
  /**
   * The `From` **address** the attempt used — the block's, not the display
   * name (the display name is always the organisation's, ADR-0013 no. 3).
   *
   * Travels with {@link mailLogEntrySchema.shape.senderIdentity} and is null in
   * exactly the same cases: both are written by the same statement at send
   * time. It is the half that is actually actionable — „System" narrows the
   * search to one of two blocks, the address names the domain whose SPF record
   * is being asked about.
   */
  senderAddress: z.string().nullable(),
  /**
   * The reply-to address **this** row carries — `mail_log.reply_to`.
   *
   * **Frozen at queueing time, like recipient, subject and body** — and in
   * that respect precisely *unlike* {@link
   * mailLogEntrySchema.shape.senderIdentity} and `senderAddress`, which are
   * written at send time. The difference is content against transport: the
   * reply-to address stands in the body of the message, the mail server in the
   * connection. A reader of this field therefore learns what **went out**, not
   * what the three levels would yield today — the difference is the whole
   * purpose of the freezing, and the origin deliberately does not stand beside
   * it: which level won back then is a question about a configuration that may
   * no longer exist in that form.
   *
   * `null` means „diese Mail trägt keine Kopfzeile" — the effective value
   * `effectiveReplyTo` yields for „nirgends etwas gesetzt", and **not**
   * „nicht aufgezeichnet".
   *
   * On the schema of the **list** and not only on that of the detail, like the
   * pair `senderIdentity`/`senderAddress` and unlike `trigger`: it is a short
   * scalar that carries nothing personal — it is configuration an editor
   * typed, never a value out of an answer; that is why the physical deletion
   * does not blank the column either (`MailLog.replyTo` in `schema.prisma`).
   * `mailLogDetailSchema` extends this one, so every row carries the value
   * once and the detail does not have to fetch it again.
   *
   * **Today it is shown in the detail panel, not as a column of the table**
   * (`MailLogView`), and this comment once claimed the opposite — „eine Frage
   * an einen *Schwung* Zeilen". Where it stands is a question about the column
   * set of the handoff and not about this schema; the statement here is only
   * that the value **comes along with every row**.
   */
  replyTo: z.string().nullable(),
});
export type MailLogEntry = z.infer<typeof mailLogEntrySchema>;

/**
 * The four KPI tiles of the design handoff, counted **server-side over the whole
 * tenant**, not over the page that happens to be loaded.
 *
 * `total` is not the sum of the other three by accident but by definition of
 * the three states; it is carried anyway so the tile does not have to be
 * computed differently from its siblings.
 */
export const mailLogCountsSchema = z.strictObject({
  total: z.number().int().nonnegative(),
  sent: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
});
export type MailLogCounts = z.infer<typeof mailLogCountsSchema>;

export const mailLogListResponseSchema = z.strictObject({
  entries: z.array(mailLogEntrySchema),
  counts: mailLogCountsSchema,
});
export type MailLogListResponse = z.infer<typeof mailLogListResponseSchema>;

/**
 * What the view may narrow the log by.
 *
 * Both keys optional and both meaning „no restriction" when absent: the KPI
 * tiles are clickable filters and „Gesamt" is the absence of a status, not a
 * fifth status. `formId` is the prefilter one arrives with from a form
 *  — the log itself stays tenant-wide.
 *
 * The **tenant** is deliberately not in here. It is never a parameter; it comes
 * from the session through `ScopedMailLogDelegate`, which for this table is the
 * only tenant boundary there is.
 */
export const mailLogFilterSchema = z.strictObject({
  status: mailStatusSchema.optional(),
  formId: z.uuid().optional(),
});
export type MailLogFilter = z.infer<typeof mailLogFilterSchema>;

/** Parses what the API answered; the client validates too. */
export function parseMailLogList(input: unknown): MailLogListResponse {
  return mailLogListResponseSchema.parse(input);
}

/**
 * One line **with the mail as it was rendered** — the detail route
 * („Die gerenderte Mail im Versandprotokoll ansehen").
 *
 * **`.extend()` on {@link mailLogEntrySchema}, not a second, hand-copied field
 * list.** The two are not independent shapes that happen to overlap — a detail
 * *is* an entry plus what only a single row may carry — so the day the entry
 * grows a field, this grows it too instead of silently falling one behind
 * (unlike {@link notificationCreateSchema}/{@link notificationUpdateSchema},
 * which really are two independent shapes and are spelled out separately for
 * exactly the opposite reason, see the comment there). `strictObject.extend()`
 * stays strict — an unrecognised key on a detail payload is refused, same as on
 * the list.
 *
 * `trigger` is **not** added here any more: it moved onto
 * {@link mailLogEntrySchema} (a review finding — the table row needs it to
 * decide whether „↻ Erneut" may be offered at all), and this schema inherits it
 * through the `.extend()` above. Restating it here would be the hand-copied
 * second field list this comment exists to argue against.
 *
 * `bodyText`/`bodyHtml` are the frozen columns (`mail_log.body_text`,
 * `body_html`) — **with `{{bearbeiten}}` resolved**, not the raw
 * `EDIT_LINK_MARK` the row stores it as (`apps/api/src/mail-log/mail-log.service.ts`
 * says why and with which code). Both nullable: `bodyHtml` for a plain-text
 * notification, and both together for a row written before the freeze of
 * 2026-07-28, which has nothing stored to show.
 */
export const mailLogDetailSchema = mailLogEntrySchema.extend({
  bodyText: z.string().nullable(),
  bodyHtml: z.string().nullable(),
});
export type MailLogDetail = z.infer<typeof mailLogDetailSchema>;

/** Parses what the API answered; the client validates too. */
export function parseMailLogDetail(input: unknown): MailLogDetail {
  return mailLogDetailSchema.parse(input);
}
