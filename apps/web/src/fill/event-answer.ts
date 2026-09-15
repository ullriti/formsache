import {
  EVENT_SEATS_MAX,
  isEventAnswer,
  type AnswerValue,
  type EventAnswer,
} from '@formsache/shared';

/**
 * The arithmetic between the number boxes of a Veranstaltung and the answer
 * shape — a sibling of `table-answer.ts`, split out for the
 * same reason.
 */

/**
 * The answer after one Veranstaltung's number was edited.
 *
 * **Only an empty box removes the entry; a `0` is stored like any other
 * number.** Both still mean „nicht angemeldet" — `canonicalAnswerValue`
 * (`@formsache/shared`) drops a `0` the same way it drops an absent key,
 * before anything is validated or persisted, so a payload from another
 * client cannot write what this view would not. What changed is only what
 * the box shows while somebody is looking at it: a participant who types
 * „0" should see „0", not have it vanish under their cursor as though the
 * keystroke never landed ({@link rawSeatOf} reads it back for exactly that).
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
    count < 0 ||
    count > EVENT_SEATS_MAX
  ) {
    next.delete(key);
  } else {
    next.set(key, count);
  }

  return { seats: Object.fromEntries(next) };
}

/**
 * The literal number sitting in one Veranstaltung's box right now.
 *
 * Unlike `seatsOf` (`@formsache/shared`), which drops a `0` because it never
 * means a registration, this keeps it — the box has to show what was typed,
 * `0` included, even though the stored answer treats it exactly like empty
 * everywhere else. Anything that is not a whole number in range is
 * `undefined`, the same „show nothing" a cleared box gets.
 */
export function rawSeatOf(
  value: AnswerValue | undefined,
  key: string,
): number | undefined {
  if (!isEventAnswer(value)) {
    return undefined;
  }
  const raw = value.seats[key];
  return typeof raw === 'number' &&
    Number.isInteger(raw) &&
    raw >= 0 &&
    raw <= EVENT_SEATS_MAX
    ? raw
    : undefined;
}
