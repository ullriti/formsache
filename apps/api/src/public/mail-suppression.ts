import type { PendingMail } from './submission-mail';

/**
 * The two measures that suppress a **mail** without touching the
 * **submission** — the sending budget and the honeypot.
 *
 * ## The one rule both of them stand on
 *
 * **Neither may let a submission fail.** They are not a sixth link of the
 * refusal chain (`public-forms.service.ts`): that chain refuses *before*
 * anything is written, these two run *after* the answer is stored and change
 * only what happens to the `mail_log` rows the submission would have queued.
 * A budget that threw, or a decoy that discarded the answer, would have turned
 * a spam defence into an outage of the registration — which is precisely the
 * one confusion that would invert the whole measure.
 *
 * So the shape of both is the same and it is the shape of this file: a row is
 * still written, it carries recipient, subject and body exactly as it would
 * have, and only its `status` and its `last_error` differ. An organisation reading the
 * mail log sees **that** it was capped and **why**; nobody has to
 * notice a missing line.
 *
 * ## Why a module of its own, and a pure function
 *
 * The same reason `honeypot.ts` and `settings-enforcement.ts` are separate
 * files: `public-forms.service.ts` is the file every submission of this
 * application goes through, and a rule written there can only be exercised by
 * standing up a database, a form and a request. Here it is exercised by calling
 * it. What is *not* here is the counting — that is a query and belongs where the
 * transaction is.
 */

/**
 * What stands in `mail_log.last_error` for a line the sending budget capped.
 *
 * German, because the reader is an editor of the organisation looking at the
 * mail log (`CONTRIBUTING.md`), and **one** constant, because the
 * reproduction this test needs — „den Grund weggelassen" — is only
 * expressible against a single source. Two spellings in two call sites would
 * make the assertion pass on one path while the other said nothing.
 *
 * It names the measure and the outcome and deliberately not the configured
 * number: the value lives in the settings page, where it can be changed, and a
 * log line quoting a limit that has since been raised would be worse than one
 * that does not. What the line has to answer is „warum ging das nicht raus" and
 * „habe ich eine Anmeldung verloren" — the second sentence answers the second
 * question, which is the one an editor actually panics about.
 */
export const MAIL_BUDGET_EXCEEDED_REASON =
  'Versandbudget erreicht: Für dieses Formular wurden im eingestellten ' +
  'Zeitfenster bereits so viele Mails eingereiht, wie erlaubt sind. Diese ' +
  'Mail wurde nicht versendet. Die Antwort selbst ist gespeichert.';

/**
 * What stands in `mail_log.last_error` for a line the honeypot suppressed.
 *
 * Same reasoning as {@link MAIL_BUDGET_EXCEEDED_REASON}, and the second
 * sentence carries even more weight here: a password manager filling a hidden
 * field is a real case, so a *false* alarm is a real case too. The line is the
 * only place an organisation can ever notice one, and it has to say in the same breath
 * that the registration itself is safe — otherwise the honest reaction to the
 * first such line would be to ask the participant to register again.
 */
export const HONEYPOT_SUPPRESSION_REASON =
  'Spam-Verdacht: Das versteckte Prüffeld dieses Formulars war ausgefüllt. ' +
  'Diese Mail wurde nicht versendet. Die Antwort selbst ist gespeichert.';

/**
 * „Wie viel darf noch hinaus, und was steht sonst in der Zeile" — the verdict
 * of one budget read, carried from **outside** the transaction into it.
 *
 * The two travel together because they are one decision: an allowance of `0`
 * under the honeypot's reason and an allowance of `0` under the budget's are
 * different answers to „warum ging das nicht raus", and separating them into
 * two parameters is how a call site ends up pairing the wrong two. Since a review
 * finding the read and the application happen at different times — the count
 * before the `BEGIN`, {@link capMails} inside it — which is exactly the distance
 * over which a loose pair drifts.
 */
export interface MailAllowance {
  /** How many deliverable rows may still be queued; may be negative. */
  readonly allowance: number;
  /** What the rows beyond it carry in `last_error`. */
  readonly reason: string;
}

const MINUTE_MS = 60_000;

/**
 * The earliest instant a `mail_log` row may carry and still count against the
 * budget — i.e. the near edge of the **sliding** window.
 *
 * „Gleitend", not „seit Beginn": the window is always the last
 * `mailBudgetWindowMin` minutes counted backwards from *now*, so a form that
 * used up its budget an hour ago sends again, and a Jahrestagung registration
 * that ran hot at 20:00 is not silent for the rest of the week. Computing a
 * fixed start — of the day, of the form's publication — would be the shape in
 * which a busy hour permanently disables a form's mails, and it is the
 * reproduction the fourth proof exists to catch.
 *
 * `now` is handed in rather than read, and it is `MailClock`'s (the queue's one
 * calendar) at every call site: the proof that the window slides is a test that
 * moves the clock an hour forward, and the alternative — a test that sleeps for
 * an hour — is not one (`mail-clock.ts`).
 */
export function budgetWindowStart(
  now: Date,
  settings: { readonly mailBudgetWindowMin: number },
): Date {
  return new Date(now.getTime() - settings.mailBudgetWindowMin * MINUTE_MS);
}

/**
 * Lets the first `allowance` deliverable rows through and turns the rest into
 * `failed` ones carrying `reason`.
 *
 * **Only rows that would actually be delivered are counted and capped.** A row
 * `submissionMails` already marked `failed` — an unreadable recipient list, an
 * optional address question left blank — is passed through untouched with its
 * own reason: it is not a mail, so it neither consumes the budget nor needs a
 * second explanation. Overwriting its `last_error` would replace the answer to
 * „warum ging das nicht raus" with a less specific one.
 *
 * **Per row, not per submission.** A submission whose three notifications meet
 * a remaining allowance of one queues that one and caps two, rather than
 * queueing all three (which would make the limit meaningless at a fan-out of
 * twenty) or capping all three (which would throw away mails the budget still
 * covered). The order is the order `submissionMails` produced, which is the
 * notifications' own — nothing here re-ranks recipients, because „welche Mail
 * ist wichtiger" is not a question this application has an answer to.
 *
 * `allowance` of `0` is the honeypot's case and needs no second function: every
 * deliverable row is capped, with the honeypot's own reason. A negative
 * allowance — a budget lowered below what the window already holds — behaves
 * the same, which is why the comparison is `<` against a running count rather
 * than a decrement that could pass through zero.
 */
export function capMails(
  pending: readonly PendingMail[],
  allowance: number,
  reason: string,
): PendingMail[] {
  let allowed = 0;

  return pending.map((mail) => {
    if (mail.status !== 'queued') {
      return mail;
    }
    if (allowed < allowance) {
      allowed += 1;
      return mail;
    }
    return { ...mail, status: 'failed', lastError: reason };
  });
}
