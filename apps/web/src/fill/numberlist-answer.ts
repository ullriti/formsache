import {
  NUMBERLIST_VALUE_MAX,
  isNumberListAnswer,
  type AnswerValue,
  type NumberListAnswer,
} from '@formsache/shared';

/**
 * The arithmetic between the number boxes of a Zahlenliste and the answer shape
 * — the sibling of `event-answer.ts`, with the one difference of the type: a
 * `0` is an answer here and stays in the answer.
 */

/**
 * The answer after one line's number was edited.
 *
 * **Only an empty box removes the entry.** A typed `0` is stored, because
 * „Auswärtige Burschen: 0" is a statement and an untouched line is not one
 * (`NumberListAnswer`). The raw string is taken rather than `valueAsNumber`:
 * an empty `<input type="number">` yields `NaN`, which is neither a number the
 * answer may carry nor a spelling of „leer". Anything that is not a whole
 * number in range is left out — the box then reads empty, which is what a
 * participant did.
 */
export function withNumber(
  numbers: Readonly<Record<string, number>>,
  key: string,
  raw: string,
): NumberListAnswer {
  const next = new Map(Object.entries(numbers));
  const count = Number(raw.trim());

  if (
    raw.trim() === '' ||
    !Number.isInteger(count) ||
    count < 0 ||
    count > NUMBERLIST_VALUE_MAX
  ) {
    next.delete(key);
  } else {
    next.set(key, count);
  }

  return { numbers: Object.fromEntries(next) };
}

/** The numbers an answer carries right now — empty for any other shape. */
export function numbersRecordOf(
  value: AnswerValue | undefined,
): Readonly<Record<string, number>> {
  return isNumberListAnswer(value) ? value.numbers : {};
}

/**
 * The literal number sitting in one line's box — `0` included, `undefined`
 * for „nothing typed" and for anything that is not a whole number in range.
 */
export function rawNumberOf(
  value: AnswerValue | undefined,
  key: string,
): number | undefined {
  const raw = numbersRecordOf(value)[key];
  return typeof raw === 'number' &&
    Number.isInteger(raw) &&
    raw >= 0 &&
    raw <= NUMBERLIST_VALUE_MAX
    ? raw
    : undefined;
}
