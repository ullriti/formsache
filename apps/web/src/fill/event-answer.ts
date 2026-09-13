import { EVENT_SEATS_MAX, type EventAnswer } from '@formsache/shared';

/**
 * The arithmetic between the number boxes of a Veranstaltung and the answer
 * shape — a sibling of `table-answer.ts`, split out for the
 * same reason.
 */

/**
 * The answer after one Veranstaltung's number was edited.
 *
 * **An empty box and a `0` remove the entry** rather than storing a value, and
 * that is what keeps „nicht angemeldet" a single shape: `EventAnswer` is sparse,
 * and an event nobody registered for carries no key at all. The rule is the one
 * `setTableCell` follows for a cleared cell, and the server holds the same one
 * from the other side — `canonicalAnswerValue` drops exactly these two spellings
 * before anything is validated, so a payload from another client cannot write
 * what this view refuses to.
 *
 * The raw string is taken rather than `valueAsNumber`, because the two disagree
 * about the case that matters: an empty `<input type="number">` yields `NaN`,
 * which is not a number the answer may carry and not a spelling of „leer"
 * either. Anything that is not a whole number is left out — the box then reads
 * empty, which is what a participant did.
 */
export function withSeats(
  seats: ReadonlyMap<string, number>,
  key: string,
  raw: string,
): EventAnswer {
  const next = new Map(seats);
  const count = Number(raw.trim());

  if (
    raw.trim() === '' ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > EVENT_SEATS_MAX
  ) {
    next.delete(key);
  } else {
    next.set(key, count);
  }

  return { seats: Object.fromEntries(next) };
}
