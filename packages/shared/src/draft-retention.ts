import { closingInstant } from './form-availability.ts';
import { type FormSettings } from './form-settings.ts';
import { TRASH_RETENTION_DAYS } from './trash.ts';

/**
 * **How long a saved draft lives** .
 *
 * A module of its own rather than a function in `form-settings.ts`: this is the
 * one rule that reads a *setting* and a *retention constant* together, and both
 * of its inputs already own a file. Putting it in either would make that file
 * import the other for one line.
 */

const MS_PER_DAY = 86_400_000;

/**
 * The instant a draft saved at `now` disappears.
 *
 * Two branches, and which one applies is a product decision rather than this
 * function's:
 *
 * - **A form with a deadline:** the draft dies with the deadline. „Denn er nützt
 *   danach niemandem mehr" — after the deadline there is nothing left to submit
 *   it into, so keeping personal data past that instant buys nobody anything.
 * - **A form without one:** thirty days, **the same number as the trash**
 *   and deliberately not a second one. Konzept no. 63 spells out why: trash,
 *   deleted organisation and draft are one promise from a participant's side, and
 *   three constants are three things that drift apart. It is imported from
 *   `trash.ts` rather than written out again for exactly that reason.
 *
 * **What the first branch costs, stated rather than glossed over:** a form whose
 * deadline is six months away keeps its drafts for six months, i.e. longer than the
 * thirty days the other branch calls short enough for data minimisation. That is
 * what „verschwindet mit ihr" says, and capping it at thirty days would be this
 * function quietly overruling a decision that was written down — so it is left
 * as a named consequence instead.
 *
 * `now` is a parameter and never `new Date()`: the boundary has to be handed a
 * time or „29 Tage bleibt, 31 ist weg" is not measurable without waiting a month
 * (the same reason {@link trashCutoff} takes one). The API hands it the one
 * injected clock.
 *
 * The deadline is read from the **effective** settings — the merge of system, Organisation
 * and form — so an organisation that sets a deadline for all its forms shortens the
 * life of their drafts without anything here knowing which layer decided it.
 */
export function draftExpiresAt(settings: FormSettings, now: Date): Date {
  const deadline = draftDeadline(settings);
  return (
    deadline ?? new Date(now.getTime() + TRASH_RETENTION_DAYS * MS_PER_DAY)
  );
}

/**
 * **How many drafts one form may carry at the same time** (a review finding).
 *
 * The rate limit bounds how *fast* one address may write drafts; nothing
 * bounded how *many* exist. *Measured on 2026-08-05:* 30 drafts per minute out
 * of one address, a textarea without `maxLength` → **101 462 bytes** of stored
 * JSONB payload per row, i.e. around 3 MiB per minute and address, without a
 * session, visible to nobody and with a lifetime of thirty days.
 *
 * **2 000, and the number is deliberately conservative.** The concept expects around
 * twenty people filling in at once and a few hundred registrations for the
 * largest form there is; a Jahrestagung with two thousand
 * *unfinished* forms lying about at the same time does not exist. It is roughly
 * an order of magnitude above the busiest honest form and still bounds one form
 * at a few hundred megabytes rather than at whatever the disk holds.
 *
 * **Per form and not per address**, although that makes it a lever: whoever
 * fills the counter keeps the next participant from saving a draft. The other
 * grain would be no bound at all — the addresses of a CGNAT'ed carrier are one
 * address, and a script that changes address every request is the ordinary case
 * this is written against. What keeps the lever small is that it stops *drafts*
 * only: the form keeps taking answers, which is the thing an organisation needs.
 *
 * A **submission** empties the draft it came out of, and the expiry empties the
 * rest, so an honest form never approaches this. It is a ceiling, not a quota.
 */
export const MAX_DRAFTS_PER_FORM = 2_000;

/**
 * The deadline of a form as an instant, or `null` where it has none — the boundary
 * a draft of *this* form may never outlive.
 *
 * Exported since an earlier review found that the settings write paths
 * had to pull existing rows down to a deadline that had just been shortened. They
 * ask for the **deadline**, not for {@link draftExpiresAt}: applying that
 * function on a settings write would hand every draft of a form *without* a
 * deadline thirty fresh days measured from an editor's click, i.e. lengthen a
 * retention because somebody changed a display flag. The rule may move a stored
 * boundary **down** and never up.
 */
export function draftDeadline(settings: FormSettings): Date | null {
  return closeInstant(settings);
}

/**
 * The deadline as an instant, or `null`.
 *
 * „Gibt es eine Frist" is {@link closingInstant}'s answer and not a second
 * reading here — that rule is not simply `settings.closeAt`, because the
 * instants survive the switch being turned off. What this wrapper adds is the
 * one thing that function cannot say: a stored string that is not a date at all.
 *
 * Such a value reads as **no** deadline, which is the direction that keeps a
 * draft alive rather than deleting it early. It cannot open anything: whether a
 * form still accepts a draft is decided by `availabilityOf` on every access,
 * from the same document, and this function is only ever asked how long to keep
 * one.
 */
function closeInstant(settings: FormSettings): Date | null {
  const closeAt = closingInstant(settings);
  if (closeAt === null) {
    return null;
  }
  const instant = new Date(closeAt);
  return Number.isNaN(instant.getTime()) ? null : instant;
}
