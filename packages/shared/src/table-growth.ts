import { tableRowLimit, type TableQuestion } from './form-schema.ts';

/**
 * **Whether a table can grow at all** — the question-level rule behind
 * „+ Zeile" .
 *
 * `tableRowLimit` is the *bound*; this is the *consequence* of the bound being
 * reached before anybody has typed anything. Two screens ask it, and they are
 * in directories that must not import each other: the builder's Live-Vorschau
 * (`QuestionPreview`) decides whether to draw the inert „+ Zeile", and the
 * fill-in view (`TableField`) decides whether the grid carries an
 * action column at all.
 *
 * **It is here rather than written out twice** for the reason `question-rows.ts`
 * gives for the half-width rule: a rule written twice is a rule that will
 * eventually disagree with itself. It already had — the preview excluded the
 * state below, the fill-in view did not, and the same table answered the
 * question differently on the two screens (a review finding).
 *
 * **The state it is about**: Startzeilen already at the Obergrenze
 * (`rows: 20, maxRows: 20`, or any table without `addRows` at all, whose
 * limit *is* its start row count). There a participant can neither add — the
 * answer starts at the limit — nor remove, because the floor of a removal is
 * `question.rows` and the answer is already on it. Every control that belongs
 * to growing is dead, so none of them is drawn.
 *
 * **Not the same question as `canAddTableRow`** in `apps/web/src/fill/`: that
 * one reads the *answer* and changes as rows come and go, which is exactly what
 * an action column must not do — a column appearing on the first added row
 * would move the grid sideways under the thumb filling it in. This one is
 * constant for the lifetime of the question.
 */
export function tableCanGrow(question: TableQuestion): boolean {
  return question.rows < tableRowLimit(question);
}
