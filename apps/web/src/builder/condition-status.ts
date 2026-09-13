import type {
  ConditionOperator,
  FormPage,
  Question,
  QuestionCondition,
} from '@formsache/shared';
import {
  allQuestions,
  findUnresolvableConditions,
  unresolvableConditionMessage,
} from '@formsache/shared';

/**
 * How a *Bedingte Anzeige* stands **in the document being edited** — what the
 * card's mark says and what the properties panel has to explain.
 *
 * Three ordinary builder actions leave a condition pointing nowhere: deleting
 * the source question, changing its type (Konzept no. 24 mints a new id), or
 * dragging it **behind** the question that depends on it. The builder allows
 * all three on purpose — an editor is mid-edit, not finished — but until this
 * module existed the surfaces showed a broken condition as a healthy one, and
 * the first word about it came from a `422` at publish time naming a question
 * the panel had never shown.
 *
 * **The sentence is not written here.** `findUnresolvableConditions` and
 * `unresolvableConditionMessage` in `packages/shared/src/condition.ts` are the
 * publish lock's own pair, and this module asks exactly them:
 * what the panel shows now is verbatim what the refusal will say later. A
 * second wording — even a friendlier one — would be a second answer to „ist
 * diese Bedingung auflösbar", free to drift from the one that decides.
 */
export interface ConditionMark {
  /**
   * Caption of the badge. Two values, because the mark has to tell a healthy
   * condition from a dead one: a single „Bedingt" on both is the defect this
   * module was written for.
   */
  readonly text: string;
  /** One sentence, for the badge's tooltip and its accessible name. */
  readonly description: string;
  /**
   * The publish refusal for this one condition, or `null` while it resolves —
   * what the properties panel puts in its `role="alert"`.
   */
  readonly problem: string | null;
}

const INTACT = 'Bedingt';
const BROKEN = 'Bedingt (Fehler)';

/** The handoff's own four words for each operator (`logicEditor`). */
export const OPERATOR_LABELS: Readonly<Record<ConditionOperator, string>> = {
  equals: 'ist gleich',
  notEquals: 'ist nicht',
  filled: 'ist ausgefüllt',
  empty: 'ist leer',
  greaterThan: 'größer als',
  lessThan: 'kleiner als',
  contains: 'enthält',
};

/**
 * The predicate half of „zeigt nur, wenn „Anreise" **ausgefüllt ist**".
 *
 * Deliberately not {@link OPERATOR_LABELS} above: those are the handoff's own
 * words for a `<select>` entry („ist ausgefüllt"), and a sentence built from
 * them reads „wenn „Anreise" ist ausgefüllt". Same seven operators, different
 * grammar — kept side by side so the difference is visible, and both are a
 * `Record<ConditionOperator, …>`, so an eighth operator is a compile error in
 * both rather than a silently missing phrase in one.
 */
const OPERATOR_PHRASES: Readonly<
  Record<ConditionOperator, (value: string) => string>
> = {
  equals: (value) => `gleich „${value}" ist`,
  notEquals: (value) => `nicht „${value}" ist`,
  filled: () => 'ausgefüllt ist',
  empty: () => 'leer ist',
  greaterThan: (value) => `größer als ${value} ist`,
  lessThan: (value) => `kleiner als ${value} ist`,
  contains: (value) => `„${value}" enthält`,
};

/** The compared value as text — `''` for the two operators that carry none. */
function valueOf(condition: QuestionCondition): string {
  switch (condition.operator) {
    case 'filled':
    case 'empty':
      return '';
    case 'greaterThan':
    case 'lessThan':
      return String(condition.value);
    case 'equals':
    case 'notEquals':
    case 'contains':
      return condition.value;
  }
}

/**
 * The mark for every question of this document that carries a condition —
 * computed **once per document**, not once per card.
 *
 * `findUnresolvableConditions` walks the whole form, so asking it per card
 * would be quadratic for no gain; the canvas builds this map and hands each
 * card its own entry.
 */
export function conditionMarks(
  pages: readonly FormPage[],
): ReadonlyMap<string, ConditionMark> {
  // A fresh array because `FormDefinition.pages` is mutable in the schema's
  // inferred type while the store hands out a readonly view; nothing here
  // writes to it.
  const draft = { pages: [...pages] };
  const defects = new Map(
    findUnresolvableConditions({ draft, published: null }).map((finding) => [
      finding.questionId,
      finding,
    ]),
  );
  const labels = new Map(
    allQuestions(draft).map((question) => [question.id, question.label]),
  );

  const marks = new Map<string, ConditionMark>();
  for (const question of allQuestions(draft)) {
    const condition = question.visibleIf;
    if (condition === undefined) {
      continue;
    }

    const defect = defects.get(question.id);
    if (defect !== undefined) {
      const problem = unresolvableConditionMessage([defect]);
      marks.set(question.id, {
        text: BROKEN,
        description: `${BROKEN}: ${problem}`,
        problem,
      });
      continue;
    }

    // Resolvable, so the source exists and stands earlier — the lookup cannot
    // miss, and `?? ''` is the spelling of that rather than a fallback with a
    // meaning of its own.
    const sourceLabel = labels.get(condition.questionId) ?? '';
    const phrase = OPERATOR_PHRASES[condition.operator](valueOf(condition));
    marks.set(question.id, {
      text: INTACT,
      description: `${INTACT}: zeigt nur, wenn „${sourceLabel}" ${phrase}`,
      problem: null,
    });
  }

  return marks;
}

/** The mark of one question — the panel's way in, where no map is at hand. */
export function conditionMarkOf(
  question: Question,
  pages: readonly FormPage[],
): ConditionMark | undefined {
  return conditionMarks(pages).get(question.id);
}
