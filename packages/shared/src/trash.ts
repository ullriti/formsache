import { z } from 'zod';

import { submissionRefusalPositionSchema } from './public-form.ts';

/**
 * Wire contract of the trash.
 *
 * Two halves that are one contract because they are read by one view: what
 * stands in the trash, and why something refused to come back out of it.
 *
 * **Deleting is a reversal, not a loss** — every payload here names the
 * moment of deletion, because that is what makes „noch 23 Tage" sayable at all
 * (physical deletion after 30 days). The countdown itself is
 * not on the wire: it is a subtraction from a timestamp the client already
 * has, and a server-computed „daysLeft" would be a second description of the
 * same fact that starts drifting the first time one of the two rounds
 * differently.
 */

/** Timestamps travel as ISO-8601 strings; the client formats, the server states. */
const timestampSchema = z.iso.datetime();

/**
 * **How long the trash holds** — 30 days, for a form, an answer *and* a
 * Organisation.
 *
 * One number, in `@formsache/shared`, because three places count from it: the
 * countdown a client subtracts from a `deletedAt`, the purge,
 * and the physical deletion of an organisation. The specification spells out
 * why it is one number and not three — „Papierkorb, gelöschte Organisation und
 * Entwurf sind aus Sicht eines Nutzers dasselbe Versprechen", and three
 * constants are three things that drift apart.
 *
 * It sits next to `MAIL_LOG_RETENTION_DAYS` in shape but deliberately not next
 * to it in value: 90 days is the *operational* record of the mail log,
 * 30 is how long a deletion stays undoable.
 */
export const TRASH_RETENTION_DAYS = 30;

const MS_PER_DAY = 86_400_000;

/**
 * The instant a deletion has to be **older than** to be removed physically.
 *
 * A pure function over an injected `now` rather than a reader of the clock:
 * the requirement („nach 30 Tagen ist alles physisch weg, gemessen mit
 * injizierter Uhr") is only measurable if the boundary can be handed a time,
 * and `MailClock` is the one clock that hands it one (`mail-clock.ts`).
 *
 * Shared with the client so „noch 23 Tage" and „jetzt fällig" are the same
 * subtraction on both sides; the same reason `trashViewSchema` carries
 * `deletedAt` and not a server-computed `daysLeft`.
 */
export function trashCutoff(now: Date): Date {
  return new Date(now.getTime() - TRASH_RETENTION_DAYS * MS_PER_DAY);
}

/**
 * A deleted form as the trash lists it (design handoff, „Gelöschte
 * Formulare").
 *
 * Deliberately **not** `FormSummary`: that shape carries `permissions`, which
 * is the per-form verdict of the guard chain for a form somebody is about to
 * *work on*. Nothing in the trash is worked on — a row offers exactly two
 * verbs, both of which the route decides on its own — and a permissions object
 * here would be a second, weaker place to read a right from.
 *
 * `responseCount` counts the answers that are **not themselves deleted**, the
 * same count the dashboard card shows. An answer somebody moved to the
 * trash before deleting the form is its own row in the section below, and
 * counting it twice would make the two sections add up to more than there is.
 */
export const deletedFormSchema = z.object({
  id: z.uuid(),
  title: z.string().min(1),
  responseCount: z.number().int().nonnegative(),
  deletedAt: timestampSchema,
});
export type DeletedForm = z.infer<typeof deletedFormSchema>;

/**
 * A deleted answer as the trash lists it (design handoff, „Gelöschte
 * Antworten").
 *
 * `formTitle` travels with it because the section is **tenant-wide**: a row
 * that named only a `formId` would be unreadable without loading every form
 * the organisation ever had. The answers themselves stay out — the trash is a
 * list of what can be brought back, not a second view onto personal data, and
 * a payload of full answer documents would hand every `can_build` holder the
 * contents of deleted registrations in one response.
 */
export const deletedResponseSchema = z.object({
  id: z.uuid(),
  formId: z.uuid(),
  formTitle: z.string().min(1),
  submittedAt: timestampSchema,
  deletedAt: timestampSchema,
});
export type DeletedResponse = z.infer<typeof deletedResponseSchema>;

/** The two sections of the trash, newest deletion first in each. */
export const trashViewSchema = z.object({
  forms: z.array(deletedFormSchema),
  responses: z.array(deletedResponseSchema),
});
export type TrashView = z.infer<typeof trashViewSchema>;

/**
 * **How many items one „Papierkorb leeren" touches at most** (a review
 * finding).
 *
 * Emptying the trash is one HTTP request that opens one transaction per
 * item, against a pool of `DB_POOL_MAX` connections. Unbounded, an organisation with
 * thousands of answers turns a single click into thousands of serial
 * transactions in one request: a dropped connection does not stop the run, the
 * report is lost, and nothing about what happened is recoverable from the
 * outside.
 *
 * So a call takes at most this many items and says how many are left
 * ({@link trashPurgeResultSchema}'s `remaining`). Pressing again continues —
 * the run is resumable **because** it is a fresh listing each time, not because
 * anything is remembered between the two.
 *
 * In `@formsache/shared` because the client has to be able to say „es bleibt etwas
 * übrig" without guessing the server's step size.
 */
export const TRASH_PURGE_BATCH_SIZE = 100;

/**
 * **What „Papierkorb leeren" actually removed** .
 *
 * A count and not 204, because emptying the trash is the one verb here
 * that acts on rows the caller never named: the view showed a list, the server
 * walks it, and between the two somebody else may have restored a form or the
 * purge may have taken an answer. „Fertig" would leave an editor to
 * infer from a refreshed list what happened; the numbers say it.
 *
 * **`failed` is the honest half.** Physical deletion removes a file's bytes
 * before its row, one file per transaction (ADR-0014 no. 16, the shape an
 * earlier package arrived at): a storage that refuses one file leaves that one item
 * standing and the run goes on. A count that folded those into „nicht gelöscht"
 * would be indistinguishable from „war schon weg", and only one of the two is
 * worth telling somebody about.
 */
export const trashPurgeResultSchema = z.strictObject({
  /** Forms physically deleted by this call. */
  forms: z.number().int().nonnegative(),
  /** Answers physically deleted by this call, outside the forms above. */
  responses: z.number().int().nonnegative(),
  /**
   * Items this call could not delete and left in the trash — a file whose
   * bytes the storage would not release, or a database error on that one item.
   * They are still listed afterwards and the next attempt takes them again.
   */
  failed: z.number().int().nonnegative(),
  /**
   * **How many items are still in the trash afterwards** — counted after
   * the run, not derived from it (a review finding).
   *
   * It is what makes {@link TRASH_PURGE_BATCH_SIZE} sayable to an editor: a
   * call that hit the batch limit answers with a number greater than zero, and
   * pressing again continues. It counts what *this* caller may empty, so a form
   * they are revoked from or capped out of is not in it — otherwise the number
   * would never reach zero and „nochmal drücken" would be advice that never
   * ends.
   *
   * `failed` items are counted in it too: they are still there, which is the
   * question this number answers.
   */
  remaining: z.number().int().nonnegative(),
});
export type TrashPurgeResult = z.infer<typeof trashPurgeResultSchema>;

/**
 * **How many answers one „Löschen" of the action bar names at most**.
 *
 * A payload limit in the sense `CONTRIBUTING.md` states, stated where both sides can
 * read it: the bar's „alle" ticks every row the search left standing, and the
 * responses list has no page size yet. Without a ceiling one
 * click on an organisation with ten thousand registrations would send a request that
 * `JSON_BODY_LIMIT_BYTES` (100 KiB) cuts off mid-array — a 413 with nothing to
 * say about *why*, where a named limit says it in one sentence.
 *
 * 1000 ids are roughly 39 KiB of request line-free JSON body, comfortably
 * inside that limit and far above what a Jahrestagung produces.
 */
export const RESPONSE_BULK_DELETE_MAX = 1000;

/**
 * **Which answers are to go into the trash**  — the body of
 * `POST /forms/:id/responses/delete`.
 *
 * **Ids as plain strings, not `z.uuid()`**, and that is a decision rather than
 * laziness: the single-answer route answers **404** for an id of the wrong
 * shape, for an id of another organisation and for one that is not in this form — one
 * door, so no caller can tell the three apart. Validating the shape here would
 * open a second door (400) for the first of the three, and the route would
 * start distinguishing „das ist keine Id" from „das ist nicht deine Id".
 * `TrashService.deleteResponses` therefore keeps the verdict, exactly as it
 * does for one id.
 *
 * What *is* decided here is the **shape and the size** of the request: at least
 * one id (an empty array is a request that means nothing, never „alle"), at
 * most {@link RESPONSE_BULK_DELETE_MAX}, and no unknown keys.
 */
export const bulkDeleteResponsesRequestSchema = z.strictObject({
  responseIds: z
    .array(z.string().min(1))
    .min(1, { error: 'Bitte mindestens eine Antwort auswählen.' })
    .max(RESPONSE_BULK_DELETE_MAX, {
      error: `Höchstens ${String(RESPONSE_BULK_DELETE_MAX)} Antworten auf einmal.`,
    }),
});
export type BulkDeleteResponsesRequest = z.infer<
  typeof bulkDeleteResponsesRequestSchema
>;

/**
 * What the server says when it could not release a file's bytes (ADR-0014 no. 16).
 *
 * A **repeatable** refusal — 503, like the unreadable settings document.
 *
 * **It says what is true and not one word more** (a review finding). The
 * sentence used to read „Es wurde nichts endgültig gelöscht", and from the
 * second attachment onwards that was false: the files go one transaction each,
 * so a run that breaks on the third of five has already destroyed the first two
 * irreversibly. What the refusal *can* promise is the row — the answer, the
 * form, the mail log — and that is what it now promises. An editor
 * who restores afterwards has to be able to expect a registration that is
 * missing some of its attachments; being told „nichts wurde gelöscht" is what
 * would make that discovery a surprise with no trace behind it.
 */
export const PURGE_STORAGE_UNAVAILABLE_MESSAGE =
  'Die Dateien konnten gerade nicht vollständig entfernt werden. Der Eintrag bleibt im Papierkorb; bereits entfernte Anlagen sind allerdings endgültig gelöscht. Bitte später erneut versuchen.';

/**
 * **Why a restore was refused** .
 *
 * Two reasons, and both are the same shape of fact: while the answer was away,
 * somebody else took the room it needs. The trash frees a seat
 * immediately and the answer limit stops counting a deleted
 * answer — that is the whole point of both rules, and this enum is the
 * price they name.
 *
 * A **narrow enum of its own**, not `submissionRefusalReasonSchema`. The nine
 * reasons of a submission are about a *participant* meeting a form's rules —
 * deadline, Zugangswort, time limit — and none of them can fire here: an
 * editor restoring an answer is not filling anything in, and a form whose
 * deadline has passed must not become a trash bin whose contents are stuck. Two
 * of the nine are shared because they are genuinely the same rule counted the
 * same way; reusing the other seven would have widened the contract with cases
 * no route can produce, and the first client to `switch` over it would write
 * seven branches nobody can reach.
 */
export const restoreRefusalReasonSchema = z.enum([
  /** The form's Antwortlimit is full again. */
  'limit_reached',
  /** A Veranstaltung this answer registers for is booked out. */
  'event_full',
]);
export type RestoreRefusalReason = z.infer<typeof restoreRefusalReasonSchema>;

/**
 * The German sentence behind each refusal — one constant per reason, written
 * out rather than assembled.
 *
 * **Both say that the answer stayed in the trash**, because that is the
 * half an editor has to be able to act on: „abgelehnt" and
 * „abgelehnt, und weg" would be read the same way in the moment, and only one
 * of them is true. Naming *which* Veranstaltung is left to the client, which
 * has the form in front of it and gets the position machine-readable
 * ({@link restoreRefusalSchema}) — the same split `SUBMISSION_REFUSAL_MESSAGES`
 * makes, and for the same reason: a label an editor renames must not be
 * baked into a constant.
 */
export const RESTORE_REFUSAL_MESSAGES: Readonly<
  Record<RestoreRefusalReason, string>
> = {
  limit_reached:
    'Das Antwortlimit dieses Formulars ist inzwischen erreicht. Die Antwort bleibt im Papierkorb.',
  event_full:
    'Eine Veranstaltung dieser Antwort ist inzwischen ausgebucht. Die Antwort bleibt im Papierkorb.',
};

/**
 * The body of a refused restore — the sentence, the reason, and for
 * `event_full` the position it fired on.
 *
 * `position` is `.optional()` for the reason `submissionRefusalSchema` states:
 * absence means „diese Ablehnung hat keine Position", and demanding an
 * explicit `null` would make every body without one fail to parse.
 */
export const restoreRefusalSchema = z.object({
  message: z.string().min(1),
  reason: restoreRefusalReasonSchema,
  position: submissionRefusalPositionSchema.optional(),
});
export type RestoreRefusal = z.infer<typeof restoreRefusalSchema>;

/**
 * Reads a refusal body, or answers `undefined` — tolerant like
 * `readSubmissionRefusal`, and for the same reason: the body of a failed
 * request may be a proxy's HTML page, and that must not become a sentence
 * shown to an editor as if the server had said it.
 */
export function readRestoreRefusal(
  source: unknown,
): RestoreRefusal | undefined {
  const parsed = restoreRefusalSchema.safeParse(source);
  return parsed.success ? parsed.data : undefined;
}
