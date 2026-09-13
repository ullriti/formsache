import {
  isAddressAnswer,
  isEventAnswer,
  isFileAnswer,
  isMatrixAnswer,
  isTableAnswer,
  otherLabelOf,
  type AnswerValue,
  type ChoiceAnswer,
  type ChoiceQuestion,
} from '@formsache/shared';

/**
 * The arithmetic between a choice question's controls and the answer shape.
 *
 * Split out of `FieldInput.tsx` because it is exactly the part jsdom cannot
 * check honestly: „welcher Wert kommt heraus" is a calculation, and a
 * calculation is asserted as a function, not through a rendered `<select>`
 * (`CONTRIBUTING.md` — jsdom is not a browser). What stays in the component is
 * „der Klick ruft sie richtig auf".
 *
 * All three choice types share it. A `<select>` carries **one string**, a radio
 * group carries one checked box, a checkbox group carries several — but the
 * stored answer is `{ values, other }` for all of them, and the rule that turns
 * one into the other must not exist in two versions.
 */

/**
 * Starting point for the value a `<select>` uses for the „Sonstiges" entry.
 *
 * A sentinel is needed because a native select carries one string, while the
 * answer is `{ values, other }`. It never leaves this module — `toChoice`
 * turns it into the shape the validator expects.
 */
const OTHER_SENTINEL_BASE = '__other__';

/**
 * The „Sonstiges" entry's value for **this** question — derived, not fixed.
 *
 * Option values are editable („wert = Beschriftung" in the bulk import), so an
 * option may genuinely be called `__other__`. With a fixed sentinel that form
 * rendered two `<option value="__other__">`, and since a real option has to win
 * the lookup, the „Sonstiges" entry became **unselectable**: a control that
 * offers something and then drops it — the very failure mode the investigation
 * found in the dropdown.
 *
 * Underscores are appended until nothing claims the value any more. That
 * terminates: every round makes the candidate one character longer, so it can
 * only collide with a longer option value, and the list is finite.
 */
export function otherSentinelOf(question: ChoiceQuestion): string {
  const taken = new Set(question.options.map((option) => option.value));
  let sentinel = OTHER_SENTINEL_BASE;
  while (taken.has(sentinel)) {
    sentinel += '_';
  }
  return sentinel;
}

/**
 * Any stored value read as the choice answer it is supposed to be.
 *
 * The three `is…Answer` guards narrow out the other object shapes
 * `AnswerValue` can hold — this function is only ever called
 * for a choice question, so a structured answer reaching it would be foreign
 * data, not a real case to handle; falling back to the empty choice is the
 * same defensive read `formatAnswerCell` gives a shape it does not recognise.
 *
 * **Each new structured shape has to be named here**, and the compiler asks:
 * without the guards added for Matrix, Tabelle, Datei-Upload and Veranstaltung
 * the return type
 * no longer matches `ChoiceAnswer` (TS2322). That is the whole reason the
 * fallback is written as a narrowing chain rather than as a cast.
 */
export function asChoice(value: AnswerValue | undefined): ChoiceAnswer {
  return value === undefined ||
    value === null ||
    typeof value !== 'object' ||
    isAddressAnswer(value) ||
    isMatrixAnswer(value) ||
    isTableAnswer(value) ||
    isFileAnswer(value) ||
    isEventAnswer(value)
    ? { values: [], other: null }
    : value;
}

/**
 * The accessible name of the free-text box.
 *
 * The caption alone would be ambiguous — it already names the *choice*, and a
 * screen reader would announce two different controls identically. The suffix
 * says which of the two has the focus.
 */
export function otherFieldLabel(question: ChoiceQuestion): string {
  return `${otherLabelOf(question)}: Freitext`;
}

/** Which entry a `<select>` shows for a given answer. */
export function singleValue(
  value: AnswerValue | undefined,
  question: ChoiceQuestion,
): string {
  const answer = asChoice(value);
  if (answer.other !== null) {
    return otherSentinelOf(question);
  }
  return answer.values[0] ?? '';
}

/**
 * The answer a `<select>` produces for the entry that was picked.
 *
 * **Picking a real option drops the free text** (`other: null`), the same way
 * the radio branch does: the two are alternatives, and an answer carrying both
 * a chosen option and a leftover „Sonstiges" text is a shape nobody can read
 * back — the export would have to guess which of the two the participant meant.
 *
 * The question is passed in because the sentinel is derived from its option
 * list ({@link otherSentinelOf}). No option can carry that value, so „real
 * option or „Sonstiges"" is decided rather than arbitrated — an option called
 * `__other__` keeps its own entry and „Sonstiges" keeps a selectable one.
 */
export function toChoice(
  selected: string,
  question: ChoiceQuestion,
): ChoiceAnswer {
  if (selected === '') {
    return { values: [], other: null };
  }
  if (selected === otherSentinelOf(question)) {
    return { values: [], other: '' };
  }
  return { values: [selected], other: null };
}
