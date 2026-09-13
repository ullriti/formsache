import type { FormPage, Question } from '@formsache/shared';
import { canBeConditionSource } from '@formsache/shared';

/**
 * The questions a *Bedingte Anzeige* on `questionId` may point at
 * : every question that comes **before** it in the
 * document — page order, then position within the page — and whose type can
 * be a source at all.
 *
 * „Vorherige Frage" is enforced here at the point of choice, not only at
 * publish time or evaluation time (`visibleQuestionIds` in
 * `packages/shared/src/condition.ts`, which treats a source the participant
 * has not reached yet as unresolved and shows the question rather than hiding
 * it). Restricting the picklist is what stops an editor from ever *building*
 * that state through this panel — the fail-open branch inside
 * `visibleQuestionIds` stays the floor under a hand-authored payload, not the
 * everyday path.
 *
 * This is a **presentation** concern, not a second copy of the evaluation:
 * it only enumerates candidates, using {@link canBeConditionSource} —
 * itself read off the one operator table in `packages/shared/src/form-schema.ts`
 * — for "can this type be asked about at all". Nothing here decides whether a
 * condition *holds*.
 */
export function earlierConditionSources(
  pages: readonly FormPage[],
  questionId: string,
): Question[] {
  const earlier: Question[] = [];
  for (const page of pages) {
    for (const question of page.questions) {
      if (question.id === questionId) {
        return earlier;
      }
      if (canBeConditionSource(question.type)) {
        earlier.push(question);
      }
    }
  }
  // The loop never met `questionId`, so there is no „before it" to answer
  // with. Returning `earlier` here — every eligible question of the document —
  // was the review's finding: it offered the questions standing *behind* the
  // one being edited, which is precisely the state the publish lock refuses to
  // publish. The empty list is what „die Frage gibt es nicht" means, and the
  // caller already handles it (the toggle is disabled while no source exists).
  return [];
}
