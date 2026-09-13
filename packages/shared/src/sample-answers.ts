import {
  DEFAULT_ADDRESS_COUNTRY,
  answerSchemaFor,
  isBlankAnswer,
  type AnswerValue,
  type ChoiceAnswer,
} from './response-validation.ts';
import {
  answerableQuestions,
  type AnswerableQuestion,
  type FormDefinition,
  type TableColumn,
} from './form-schema.ts';

/**
 * **Valid sample values for a whole form** — the generator of the test mode.
 *
 * It stands here and not in the view, because the concept demands exactly that:
 * „Die Werte kommen aus dem geteilten Schema, nicht aus einer zweiten Liste —
 * sie müssen Pflicht, Min/Max, Muster, Optionen und Datumsgrenzen *erfüllen*."
 * Next to the rules it has to satisfy, it can *ask* them; one storey higher it
 * could only rebuild them, and the rebuild is the second spelling that this
 * package removes everywhere else.
 *
 * ## Three properties, and all three of them are assurances
 *
 * 1. **No value leaves this file without having been checked.** Every candidate
 *    runs through {@link answerSchemaFor} of *this* question, with
 *    `enforceRequired: true` — the strictest reading there is. What comes out
 *    here is thereby valid for a draft as well, never the other way round.
 * 2. **Deterministic.** No `Math.random()`, no `Date.now()`, no time zone. The
 *    same form twice yields the same values twice — otherwise a trial run would
 *    not be repeatable and a screenshot not comparable (third boundary).
 * 3. **If it finds no valid value for a field, it does not fill it — it names
 *    it.** That is the actual yield of the matter: the rules of that field
 *    contradict each other then, and a generator that enters "anything" in this
 *    case swallows precisely the finding the specification demands it for.
 *
 * ## Why *generate and check* and not *derive from the rule*
 *
 * For most types the derivation would be possible (a number between two bounds,
 * a date between two dates). For a **pattern** it is not: generating a matching
 * string from a JavaScript `RegExp` — with lookahead, backreferences and
 * Unicode property classes — that *additionally* satisfies `minLength` is in
 * general not a solvable problem, and a library for it would be a dependency
 * that promises more than it can keep.
 *
 * Therefore **a ladder instead of a solver**: one short, ordered list of
 * plausible candidates per question type (for text additionally cut to the
 * length bounds), and the first one the schema of the question accepts wins.
 * That is honest in both directions — it finds the value when one of the usual
 * ones fits, and it *claims nothing* when none fits. A pattern like
 * `^[A-Z]{2}-\d{4}$` stands in the ladder (`AB-1234`); one that an organisation
 * has freely invented does not stand in it — and then the view says „für dieses
 * Feld ließ sich kein Wert erzeugen" instead of a value the server would
 * reject.
 */

/**
 * A field for which there is no valid sample value.
 *
 * That is a **finding about the form**, not an error message of the generator,
 * and the view shows it as such: either the rules of the field contradict each
 * other (a whole number between 0,2 and 0,8), or the pattern is so special that
 * the ladder does not hit it — which the editor judges best themselves, because
 * they wrote the pattern.
 */
export interface UnfillableQuestion {
  readonly questionId: string;
  /** Label of the question, so the finding is readable without an id. */
  readonly label: string;
}

/** The result of one run: what was entered and what was not. */
export interface SampleAnswers {
  /**
   * The answers, valid against `buildAnswersSchema` of the same definition.
   *
   * An **info text carries no key** : it is no
   * question, `buildAnswersSchema` gives it no place in the answer object, and
   * `.strict()` would reject a document carrying its key as a whole.
   * `answerableQuestions` takes care of that one level deeper — it only stands
   * here because it is the one place where "no question" becomes visible.
   */
  readonly answers: Record<string, AnswerValue>;
  /** The fields for which no valid value could be generated. */
  readonly unfillable: readonly UnfillableQuestion[];
}

/**
 * Sample values for every answerable question of a form.
 *
 * **For the voluntary questions as well**, not only for the mandatory fields:
 * the purpose is to be able to click through a form quickly, and a trial run
 * that leaves half the page empty shows neither the line breaks nor the columns
 * an evaluation would have later.
 *
 * Conditionally hidden questions are **not** left out. Which question stands on
 * the screen is decided by `visibleQuestionIds` out of the answers — that is,
 * out of the result of this function —, and `buildAnswersSchema` discards the
 * value of a hidden question anyway instead of rejecting it
 * . Leaving it out here would mean making the same evaluation a
 * second time and one round too early.
 */
export function sampleAnswers(definition: FormDefinition): SampleAnswers {
  const answers: Record<string, AnswerValue> = {};
  const unfillable: UnfillableQuestion[] = [];

  for (const question of answerableQuestions(definition)) {
    const value = firstValidCandidate(question);
    if (value === undefined) {
      unfillable.push({ questionId: question.id, label: question.label });
      continue;
    }
    answers[question.id] = value;
  }

  return { answers, unfillable };
}

/**
 * The first candidate the schema of *this* question accepts — or `undefined`.
 *
 * Two checks, and the first one is not superfluous: `answerSchemaFor` describes
 * a **given** answer and for several types accepts the empty form as well
 * (`{values: [], other: null}` is a valid choice object). Whether an answer is
 * *there* is decided by `isBlankAnswer` — the same function with which
 * `buildAnswersSchema` measures a mandatory question. A candidate that passes
 * both therefore carries even when the question is mandatory; a generator that
 * only asked the schema could enter an empty object for a mandatory choice and
 * would still be green against `answerSchemaFor`.
 *
 * `enforceRequired: true` independently of `question.required`: four types
 * carry the obligation *inside* the answer (address, matrix, table, event), and
 * the stricter reading is the one that holds in both worlds.
 */
function firstValidCandidate(
  question: AnswerableQuestion,
): AnswerValue | undefined {
  const schema = answerSchemaFor(question, true);
  return candidatesFor(question).find(
    (candidate) =>
      !isBlankAnswer(candidate) && schema.safeParse(candidate).success,
  );
}

/** „Beispieltext" — the base material of every text ladder. */
const SAMPLE_TEXT = 'Beispieltext';

/**
 * The text shapes the ladder tries through, in this order.
 *
 * Deliberately short and deliberately **the shapes a pattern in form building
 * hits at all**: postcode, date, telephone number, address, membership or
 * member number. A longer list would hardly raise the hit rate and would water
 * down the statement the finding makes — "no one of the usual shapes fits here"
 * is a sentence an editor can judge; "none of two hundred random strings fits
 * here" is not one.
 */
const TEXT_SHAPES: readonly string[] = [
  SAMPLE_TEXT,
  'Beispiel',
  'max.mustermann@example.de',
  '+49 30 1234567',
  '2026-03-01',
  '01.03.2026',
  '70173',
  '1234567890',
  'AB-1234',
  'ABCDEFGH',
  'abcdefgh',
];

/**
 * A string cut to `[minLength, maxLength]`.
 *
 * Lengthened by **repetition** instead of by spaces: a pattern that demands
 * `\S` would fail on padded spaces, and a `minLength` without a pattern is
 * indifferent to both. Shortening is done hard — what violates a pattern
 * afterwards falls through at the check and the next candidate is up.
 */
function fitLength(
  value: string,
  minLength: number | null,
  maxLength: number | null,
): string {
  let fitted = value;
  if (minLength !== null && fitted.length < minLength) {
    // `repeat` with a rounded-up factor, then cut: for minLength 0 or an
    // empty template it stays with the template.
    const factor =
      fitted.length === 0 ? 0 : Math.ceil(minLength / fitted.length);
    fitted = fitted.repeat(factor).slice(0, Math.max(minLength, fitted.length));
  }
  if (maxLength !== null && fitted.length > maxLength) {
    fitted = fitted.slice(0, maxLength);
  }
  return fitted;
}

/** The text ladder: every shape once raw and once brought to the length. */
function textCandidates(
  minLength: number | null,
  maxLength: number | null,
): string[] {
  const candidates: string[] = [];
  for (const shape of TEXT_SHAPES) {
    candidates.push(shape, fitLength(shape, minLength, maxLength));
  }
  return [...new Set(candidates)];
}

/**
 * Number candidates between `min` and `max`.
 *
 * 42 as the starting value, clamped to the allowed range, then the bounds
 * themselves and the middle — and for an integer question additionally the
 * rounded forms. The case that has no answer for this is exactly the finding:
 * "whole number between 0,2 and 0,8" has none, and the question is named
 * instead of filled with `0`, which the server would reject.
 */
function numberCandidates(
  min: number | null,
  max: number | null,
  integer: boolean,
): number[] {
  const lower = min ?? Number.NEGATIVE_INFINITY;
  const upper = max ?? Number.POSITIVE_INFINITY;
  const clamp = (value: number): number =>
    Math.min(Math.max(value, lower), upper);

  const middle =
    min !== null && max !== null ? (min + max) / 2 : (min ?? max ?? 42);
  const plain = [clamp(42), min, max, middle].filter(
    (value): value is number => value !== null && Number.isFinite(value),
  );

  if (!integer) {
    return [...new Set(plain)];
  }

  return [
    ...new Set(
      plain.flatMap((value) => [
        Math.round(value),
        Math.ceil(value),
        Math.floor(value),
      ]),
    ),
  ];
}

/**
 * Date candidates between `minDate` and `maxDate`.
 *
 * Clamped lexicographically — for `YYYY-MM-DD` that is the calendar order, and
 * that is exactly what the format is nailed down for in the form schema
 * (`dateAnswerSchema` compares the same way).
 */
function dateCandidates(
  minDate: string | null,
  maxDate: string | null,
): string[] {
  const base = '2026-03-01';
  const clamped =
    minDate !== null && base < minDate
      ? minDate
      : maxDate !== null && base > maxDate
        ? maxDate
        : base;
  return [...new Set([clamped, minDate, maxDate].filter((v) => v !== null))];
}

/** The free text of the „Sonstiges" choice, when one is needed. */
const SAMPLE_OTHER = 'Sonstiges Beispiel';

/**
 * Choice candidates for a checkbox question.
 *
 * The order is the statement: first exactly as many ticks as `minSelected`
 * demands (or one), then the forms that count „Sonstiges" as a choice — the
 * case in which a question demands more mandatory entries than it has options,
 * and the gap can only be closed through the free-text field
 * (`checkboxQuestionSchema` allows exactly that and counts it in).
 */
function checkboxCandidates(question: {
  readonly options: readonly { readonly value: string }[];
  readonly allowOther: boolean;
  readonly minSelected: number | null;
}): ChoiceAnswer[] {
  const available = question.options.length;
  const wanted = Math.min(Math.max(question.minSelected ?? 1, 0), available);
  const counts = [...new Set([wanted, Math.max(wanted - 1, 0), 1, available])];
  const values = (count: number): string[] =>
    question.options.slice(0, count).map((option) => option.value);

  const candidates: ChoiceAnswer[] = [];
  for (const count of counts) {
    candidates.push({ values: values(count), other: null });
    if (question.allowOther) {
      candidates.push({ values: values(count), other: SAMPLE_OTHER });
    }
  }
  return candidates;
}

/** One sample value per cell kind — the same four the column editor offers. */
function tableCell(column: TableColumn): string | number | boolean {
  switch (column.type) {
    case 'text':
      return SAMPLE_TEXT;
    case 'number':
      return 2;
    // The first **real** entry, never an invented one: a list column accepts
    // only its own values (`checkTableCell`), and an invented one would be the
    // sure way into the finding instead of into the sample value.
    case 'select':
      return column.options[0]?.value ?? '';
    // `true` or nothing at all — a stored `false` does not exist
    // (`TableCellValue`).
    case 'checkbox':
      return true;
  }
}

/**
 * The reference under which a sample file stands.
 *
 * **It is not an uploaded file, and in the test mode it does not have to be
 * one**: the trial run sends nothing, so no attachment is ever claimed
 * (ADR-0014 no. 13). The value exists so that a file upload as a *mandatory
 * question* gets a sample value — otherwise the only question type without a
 * generatable value would be one whose rules are perfectly in order, and the
 * finding would report something that is none. It has the shape
 * `fileAnswerSchema` demands (`isFileRef`), and it is readable as an example so
 * that nobody takes it for an address.
 */
const SAMPLE_FILE_REF = 'BEISPIEL-DATEI-OHNE-INHALT';

/**
 * The candidate ladder per question type — **a `switch` without `default`**.
 *
 * Without `default` and with `never` in the unreachable branch, so that a
 * seventeenth question type makes this file **not compile** instead of letting
 * it run silently into the finding: „für dieses Feld ließ sich kein Wert
 * erzeugen" would then be a statement about the generator that looks like one
 * about the form — exactly the confusion the concept rules out.
 */
function candidatesFor(question: AnswerableQuestion): AnswerValue[] {
  switch (question.type) {
    case 'text':
      return textCandidates(question.minLength, question.maxLength);
    case 'textarea':
      return [
        fitLength(
          'Beispieltext über\nmehrere Zeilen',
          question.minLength,
          question.maxLength,
        ),
        ...textCandidates(question.minLength, question.maxLength),
      ];
    case 'number':
      return numberCandidates(question.min, question.max, question.integer);
    case 'date':
      return dateCandidates(question.minDate, question.maxDate);
    case 'email':
      return ['max.mustermann@example.de'];
    case 'phone':
      return ['+49 30 1234567'];
    // One choice, never more: `choiceAnswerSchema` allows exactly one for
    // list and radio button.
    case 'select':
    case 'radio':
      return [
        ...question.options.map((option): ChoiceAnswer => ({
          values: [option.value],
          other: null,
        })),
        ...(question.allowOther
          ? [{ values: [], other: SAMPLE_OTHER } satisfies ChoiceAnswer]
          : []),
      ];
    case 'checkbox':
      return checkboxCandidates(question);
    // Four stars, capped at the maximum of *this* question — plausible for a
    // 2-step scale as for a 10-step one, never a value the question could not
    // accept.
    case 'rating':
      return [Math.min(4, question.max), question.max, 1];
    case 'address':
      return [
        {
          street: 'Musterstraße 12',
          zip: '70173',
          city: 'Stuttgart',
          // The default of the fill-in view, not a second spelling of it
          // (`FieldInput.tsx` bakes in the same value).
          country: DEFAULT_ADDRESS_COUNTRY,
        },
      ];
    // Every row answered — that is the mandatory reading of this type
    // (`matrixAnswerSchema`), and a matrix with one answered row would be
    // eleven empty columns next to a filled one in the export.
    case 'matrix':
      return question.columns.map((column) => ({
        rows: Object.fromEntries(
          question.rows.map((row) => [row.value, [column.value]]),
        ),
      }));
    // **One** row, not all: "mandatory" means for the table "at least one row
    // is filled in" (`tableAnswerSchema`), and the number of rows is the offer
    // of the form, not its demand.
    case 'table':
      return [
        {
          cells: [
            Object.fromEntries(
              question.columns.map((column) => [column.key, tableCell(column)]),
            ),
          ],
        },
      ];
    case 'file':
      return [
        { files: [{ ref: SAMPLE_FILE_REF, name: 'beispiel-nachweis.pdf' }] },
      ];
    // Two persons for the **first** event, not for all: the type carries a
    // number of persons and no registration marker, and
    // "at least one event is provided with a number" is its mandatory reading
    // (`eventAnswerSchema`). **Nothing of it is booked** — the trial run does
    // not send, and seats are allocated exclusively in the transaction that
    // writes an answer.
    //
    // **Clamped to the upper bound** (a later rework). This generator promises
    // a value that the form can accept; for fifteen types `answerSchemaFor`
    // checks that afterwards, and only here is the promise weaker, because
    // `eventAnswerSchema` deliberately does **not** check the capacity (the
    // submit transaction does that, `form-schema.ts` says why). With
    // `capacity: 1` two persons would be schema-valid and rejectable with 409
    // in a real submission — a sample value that demonstrates exactly what the
    // test mode is not supposed to demonstrate. `capacity: null` means "without
    // a bound" and stays at two.
    case 'event':
      return question.events.map((entry) => ({
        seats: {
          [entry.key]:
            entry.capacity === null ? 2 : Math.min(2, entry.capacity),
        },
      }));
  }

  // Unreachable as long as the switch is complete; a new question type
  // narrows here to itself instead of to `never` and is named.
  const unhandled: never = question;
  return unhandled;
}
