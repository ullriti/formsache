import {
  isMatrixAnswer,
  type AnswerValue,
  type MatrixAnswer,
} from '@formsache/shared';

/**
 * The arithmetic between a Matrix's grid of controls and the answer shape
 *  — the counterpart of `choice-answer.ts` and
 * `address-answer.ts`, split out for the same reason: „welcher Wert kommt
 * heraus" is a calculation, and a calculation is asserted as a function rather
 * than through a rendered grid (`CONTRIBUTING.md` — jsdom is not a browser).
 */

/** Any stored value read as the Matrix answer it is supposed to be. */
export function asMatrix(value: AnswerValue | undefined): MatrixAnswer {
  return isMatrixAnswer(value) ? value : { rows: {} };
}

/** What is picked in one row — the empty list while nothing is. */
export function pickedIn(
  answer: MatrixAnswer,
  rowValue: string,
): readonly string[] {
  return answer.rows[rowValue] ?? [];
}

/**
 * The answer after a click on one cell.
 *
 * The two modes are two different gestures and behave the way their native
 * controls do:
 *
 * - **Single** (`multiple: false`) — the row's pick is *replaced*. Clicking the
 *   already-picked cell keeps it, exactly as a `<input type="radio">` does; a
 *   radio group has no "unpick" and inventing one here would make the Matrix
 *   behave differently from the Einfachauswahl right above it in the same form.
 * - **Multiple** — the cell is toggled, like a checkbox.
 *
 * A row whose last pick is removed loses its key rather than keeping an empty
 * array: „nicht beantwortet" is an absence ({@link MatrixAnswer}), and two
 * spellings of it would make `isBlankAnswer` and the Pflicht rule disagree
 * about a row nobody touched.
 */
export function toggleMatrixCell(
  answer: MatrixAnswer,
  rowValue: string,
  columnValue: string,
  multiple: boolean,
): MatrixAnswer {
  const current = pickedIn(answer, rowValue);
  const next = multiple
    ? current.includes(columnValue)
      ? current.filter((entry) => entry !== columnValue)
      : [...current, columnValue]
    : [columnValue];

  // Rebuilt by filtering rather than by `delete`: the key is computed, and a
  // dynamic `delete` is what the project's lint rule forbids — with reason,
  // since it is also the one operation that would mutate a value this function
  // promises to leave alone if the spread above were ever dropped.
  const withoutRow = Object.fromEntries(
    Object.entries(answer.rows).filter(([key]) => key !== rowValue),
  );
  return next.length === 0
    ? { rows: withoutRow }
    : { rows: { ...withoutRow, [rowValue]: next } };
}
