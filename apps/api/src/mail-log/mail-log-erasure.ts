import type { Prisma } from '@prisma/client';

import type { MailTx } from '../mail/mail-queue.repository';

/**
 * **The personal columns of the mail log — in one place**
 * (the promise).
 *
 * Physical deletion keeps the log row and empties what names a person. The
 * row that stays is the operational record — `status`, `created_at`, `sent_at`,
 * `attempts`, `sender_identity`, `sender_address` — and that is deliberate: „wie
 * ging es aus und über welchen Mailserver" is what an installation has to be
 * able to answer weeks later, and none of it is a participant's datum
 * (and the note at `MailLog.senderIdentity` says the same).
 *
 * **The list of columns lives here and nowhere else.** The retention rule asks the
 * test to name every one of them so that an additional one stands out; this
 * constant is the other half of that — a personal column added to `mail_log` is
 * added *here*, and every caller of the erasure inherits it instead of being
 * found later.
 *
 * ## `last_error` is the fifth, and it was found the hard way
 *
 * The first version of this constant listed four columns and the erasure wrote
 * `last_error` only on the lines it moved from `queued` to `failed` (a review
 * finding). A line that had **already** failed kept it — and a transport
 * error is the one operational string that routinely quotes the address it
 * could not reach: `550 5.1.1 <anton@…>: Recipient address rejected` is what
 * Postfix and Exim answer, and `MailError` stores it verbatim (credentials
 * stripped, 500 characters). So `recipient IS NULL` said „geleert" while the
 * same row carried the participant's address for the remaining 90 days.
 *
 * It goes to `null` rather than to a sentence, for the reason the wire contract
 * gives for `recipient`: an absence is a state. „Warum ist diese Zeile
 * gescheitert" is genuinely lost with it, and that is the price of the promise
 * rather than an oversight — the diagnosis quoted the person. What survives is
 * `status`, `attempts` and the sending identity, which is the operational half
 * the retention rule names. A still-`queued` line gets {@link
 * ERASED_MAIL_LOG_REASON} written back afterwards, because for that one the
 * reason *is* the erasure and names nobody.
 *
 * ## `reply_to` is the sixth column, and it deliberately does **not** stand here
 * (2026-08-04)
 *
 * The question was meant seriously — a reply address *is* an address. What
 * sets it apart from `recipient` is where it comes from, and that is what decides:
 * `recipient` can come from the answer itself (a
 * placeholder on a question), `subject` and the two body columns are
 * **rendered** from the answer. `reply_to` cannot do that: there is no
 * placeholder and no renderer for this field, the value comes exclusively
 * from the system settings, from the organisation's column or from the field
 * of a notification — that is, from configuration an editor types.
 * It names an office, not a participant, and thus belongs in
 * the same category as `sender_address`, which the concept deliberately leaves standing:
 * „wie ging es aus und über welchen Weg" is the operational record an
 * installation has to be able to answer weeks later.
 *
 * The counter-check is in the test: `permanent-delete.spec.ts` measures the **whole**
 * row with `to_jsonb` against the participant's address. Were it ever to reach this
 * column, the case would be red — so the promise does not hang on this reasoning
 * alone.
 */
export const ERASED_MAIL_LOG_COLUMNS = {
  recipient: null,
  subject: null,
  bodyText: null,
  bodyHtml: null,
  lastError: null,
} as const satisfies Prisma.MailLogUpdateManyMutationInput;

/**
 * German, because it lands in `mail_log.last_error` and is read by an operator
 * in the mail log.
 */
export const ERASED_MAIL_LOG_REASON =
  'Die zugehörigen Daten wurden endgültig gelöscht; diese Nachricht wird nicht mehr zugestellt.';

/**
 * Blanks the personal columns of every line matching `where` — and **ends the
 * ones that were still waiting**.
 *
 * ## Why a `queued` line has to change status
 *
 * The body of a queued mail is frozen in `body_text`/`body_html` when the answer
 * arrives, so the queue is the one path that still actively carries a
 * submission's values out of the house. While the answer sits in the trash
 * the row is simply withheld (`NOT_IN_TRASH` in `mail-queue.repository.ts`) —
 * but that condition reads `mail_log.response_id`, and physical deletion sets
 * that column to NULL through `ON DELETE SET NULL`. Without this step the row
 * would become claimable again *because* the answer was destroyed, and a
 * confirmation carrying the erased submission's answers would go out minutes
 * later.
 *
 * Blanking alone is not enough either. It would make the delivery fail — the
 * renderer refuses a row with no `body_text` — but only after the backoff
 * has burned the attempts this design asks to keep, and it would end on a
 * `last_error` about the freeze of 2026-07-28 that has nothing to do with what
 * happened. `failed` with the sentence above says it once, in the state that
 * means it.
 *
 * **`sent` and `failed` lines keep their status untouched.** Those have an
 * outcome; `queued` is a promise, and the promise is what erasure voids.
 *
 * ## Why the blanking comes first now
 *
 * It used to be the second statement, and `last_error` was written only by the
 * first one — which is exactly how a `failed` line kept a bounce message
 * quoting the recipient (a review finding, see {@link
 * ERASED_MAIL_LOG_COLUMNS}). Blanking **everything** first and re-stating the
 * reason for the one status that needs one is one statement fewer to reason
 * about: no line can leave this function with a `last_error` that predates the
 * erasure. The two `where`s stay independent — the blanking does not touch
 * `status`, so the second statement still sees the lines it is about.
 *
 * @returns how many lines were blanked.
 */
export async function eraseMailLogLines(
  tx: MailTx,
  where: Prisma.MailLogWhereInput,
): Promise<number> {
  const erased = await tx.mailLog.updateMany({
    where,
    data: ERASED_MAIL_LOG_COLUMNS,
  });

  await tx.mailLog.updateMany({
    where: { ...where, status: 'queued' },
    data: {
      status: 'failed',
      // Written back over the `null` above: for a line that was still waiting,
      // the reason it will never go out *is* the erasure, and that sentence
      // names nobody.
      lastError: ERASED_MAIL_LOG_REASON,
      // Nothing may pick it up again, and a stale schedule on a terminal row
      // would be a second thing to explain.
      nextAttemptAt: null,
    },
  });

  return erased.count;
}
