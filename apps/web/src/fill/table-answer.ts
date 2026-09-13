import {
  isTableAnswer,
  tableRowLimit,
  type AnswerValue,
  type TableAnswer,
  type TableCellValue,
  type TableQuestion,
} from '@formsache/shared';

/**
 * The arithmetic between a table's cells and the answer shape (grown) — a sibling of `matrix-answer.ts`, split out for the
 * same reason.
 *
 * Everything here counts rows **positionally**, because the stored answer is a
 * positional array (`{ cells: [...] }`) and stays one: row ids on the wire
 * would be a change to every answer ever filed. The stable identity a removal
 * needs lives in `TableField`, in the browser, and never leaves it.
 */

/**
 * Any stored value read as the table answer it is supposed to be, at the row
 * count this question and this answer agree on.
 *
 * Three bounds, and the order between them is the whole function:
 *
 * 1. **At least `question.rows`** — the rows the form *offers*. Padding here
 *    rather than per cell lets the grid render `answer.cells[rowIndex]` without
 *    a fallback, and makes a question whose row count was raised between two
 *    versions show the new empty rows instead of nothing.
 * 2. **As many as the answer carries**, which may be more than the
 *    form starts with: a participant added them. Reading the count from the
 *    *question* alone — what this used to do — cut off exactly the rows
 *    somebody had just added, on the next keystroke and without a word.
 * 3. **Never above {@link tableRowLimit}**, the one bound the server refuses
 *    above (`TABLE_ROW_LIMIT_CODE`). Rows past it are dropped rather than
 *    carried along: they are cells this form does not offer, and sending them
 *    back would fail a submission the participant can see nothing wrong with.
 *
 * Bound 1 is also why {@link canRemoveTableRow} stops at `question.rows`: a
 * removal below it would be padded straight back here, and the row a
 * participant just took away would reappear — empty, at the end, with the
 * values below it moved up one.
 */
export function asTable(
  value: AnswerValue | undefined,
  question: TableQuestion,
): TableAnswer {
  const stored = isTableAnswer(value) ? value.cells : [];
  const rowCount = Math.min(
    Math.max(question.rows, stored.length),
    tableRowLimit(question),
  );
  return {
    cells: Array.from({ length: rowCount }, (_, index) => stored[index] ?? {}),
  };
}

/**
 * Whether „+ Zeile" belongs on screen.
 *
 * The limit is {@link tableRowLimit} and nothing else — the client must not
 * compute a second one, or „+ Zeile" would offer a row the server then refuses
 * the whole submission for.
 *
 * A question without `addRows` needs no case of its own: its limit *is* its
 * start row count, and {@link asTable} has already filled the answer to that,
 * so this is `false` for every table without `addRows`.
 */
export function canAddTableRow(
  question: TableQuestion,
  answer: TableAnswer,
): boolean {
  return answer.cells.length < tableRowLimit(question);
}

/**
 * Whether a row may be taken away again.
 *
 * The floor is `question.rows` — the rows the form offers are the form's, the
 * ones above them are the participant's to add and to take back. Not a taste:
 * {@link asTable} pads back up to `question.rows` on the very next render, so a
 * removal below the floor would visibly undo itself. Making the floor the same
 * number keeps the two rules from contradicting each other by construction
 * rather than by a special case in one of them.
 *
 * For the canonical shape the schema recommends — „beliebig viele
 * Begleitpersonen" as `rows: 1` plus `addRows` — the floor is one row, which is
 * also the lowest a table may go at all: a table with no row is a header over
 * nothing.
 */
export function canRemoveTableRow(
  question: TableQuestion,
  answer: TableAnswer,
): boolean {
  return answer.cells.length > question.rows;
}

/** The answer with one more empty row at the end. */
export function addTableRow(answer: TableAnswer): TableAnswer {
  return { cells: [...answer.cells, {}] };
}

/**
 * The answer without the row at `rowIndex` — **taken out**, not blanked.
 *
 * The difference is the one the evidence measures on the
 * Bearbeiten-Pfad: a row cleared instead of removed goes back to the server as
 * an empty row, and the evaluation then shows a line the participant deleted.
 * A row removed here is a row the `response` document no longer has.
 */
export function removeTableRow(
  answer: TableAnswer,
  rowIndex: number,
): TableAnswer {
  return { cells: answer.cells.filter((_, index) => index !== rowIndex) };
}

/**
 * The answer after one cell was edited.
 *
 * `undefined` **removes** the cell rather than storing an empty value, and
 * that is what keeps „leer" a single shape: a cleared text box, an unticked
 * Haken and a Liste set back to „—" all end as the same absence, which is what
 * `isBlankAnswer` and the Pflicht rule („mindestens eine Zeile ausgefüllt")
 * both read. Storing `''`, `false` and `null` instead would give one state
 * three spellings — the very Doppelform the requirement spends a package
 * removing for `other`.
 */
export function setTableCell(
  answer: TableAnswer,
  rowIndex: number,
  columnKey: string,
  cell: TableCellValue | undefined,
): TableAnswer {
  return {
    cells: answer.cells.map((row, index) => {
      if (index !== rowIndex) {
        return row;
      }
      if (cell !== undefined) {
        return { ...row, [columnKey]: cell };
      }
      // Rebuilt by filtering rather than by `delete` on a computed key — the
      // same reason `matrix-answer.ts` gives.
      return Object.fromEntries(
        Object.entries(row).filter(([key]) => key !== columnKey),
      );
    }),
  };
}
