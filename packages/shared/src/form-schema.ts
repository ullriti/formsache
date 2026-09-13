import { z } from 'zod';

import { MAX_FILES_PER_RESPONSE } from './file-limits.ts';

/**
 * The form schema — the shared truth for builder, fill-in view and server.
 *
 * Everything about a form's *content* is described here and nowhere else: the
 * builder writes this shape, the server stores it as JSONB, the fill-in view
 * renders it and `response-validation.ts` derives the answer validator from
 * it. There is deliberately no hand-kept `interface` beside any of it — every
 * type below comes from `z.infer`, so a schema change cannot leave a type
 * behind.
 *
 * Two rules shape the design:
 *
 * - **A question carries only the validation its own type can have.** The
 *   variants are a discriminated union rather than one wide object with
 *   optional keys everywhere. A `minLength` on a date question is not a value
 *   to be ignored at render time, it is a document that never parses — and the
 *   error names the type it failed on.
 * - **Nothing is optional that the builder can state.** No `.default()`, so
 *   input and output types are identical and a stored document says exactly
 *   what it means. `null` is used where "not set" is a real value.
 *
 * Nine question types were the original set; the remaining seven (Adresse,
 * Tabelle, Matrix, Bewertung, Datei-Upload, Veranstaltung, Infotext) were
 * added later, to `questionSchema` below.
 */

/**
 * Upper bound on any free-text field of the *definition* (labels, hints,
 * option captions).
 *
 * These are admin-authored strings that end up in HTML, in CSV exports and in
 * mail bodies. The bound is not a UX rule — it keeps one pasted novel from
 * turning a form document into a payload the JSON body limit rejects on every
 * subsequent save.
 */
const LABEL_MAX = 300;
const HINT_MAX = 1000;

/**
 * Longest accepted validation pattern.
 *
 * A regular expression from the builder is executed on the server for every
 * submitted answer, so its cost is the participant's cost. Length is a blunt
 * proxy for that cost, but it is one an admin cannot argue with, and it bounds
 * the pathological cases that matter here (long alternations). It does not
 * make a catastrophically backtracking pattern impossible — see
 * `compilablePattern` for what is and is not promised.
 */
const PATTERN_MAX = 200;

/** The nine original question types (table "Die neun Fragetypen"). */
export const questionTypeSchema = z.enum([
  /** Text, single-line. */
  'text',
  /** Mehrzeilig. */
  'textarea',
  /** Zahl. */
  'number',
  /** Datum. */
  'date',
  /** E-Mail. */
  'email',
  /** Telefon. */
  'phone',
  /** Dropdown. */
  'select',
  /** Einfachauswahl. */
  'radio',
  /** Mehrfachauswahl. */
  'checkbox',
  /** Bewertung (Sterne). */
  'rating',
  /** Infotext — no field, no answer. */
  'info',
  /** Adresse — four subfields, one structured answer. */
  'address',
  /** Matrix — fixed statements (rows) × scale (columns). */
  'matrix',
  /** Tabelle — freely defined columns over a fixed row count. */
  'table',
  /** Datei-Upload — an attachment to the answer (ADR-0014). */
  'file',
  /** Veranstaltung with a participant limit — several dates, one number per date. */
  'event',
]);
export type QuestionType = z.infer<typeof questionTypeSchema>;

/** Half width is a desktop-only layout; below 1180 px every card is full width. */
export const questionWidthSchema = z.enum(['full', 'half']);
export type QuestionWidth = z.infer<typeof questionWidthSchema>;

/**
 * One choice of a select, radio or checkbox question.
 *
 * `value` and `label` are separate on purpose. The label is what a participant
 * reads and what an admin edits; the value is what a stored answer refers to.
 * Renaming "Ja, ich komme" to "Teilnahme" must not silently rewrite what
 * fifty people already answered — the value stays, so the old answers keep
 * meaning what they meant.
 */
export const questionOptionSchema = z.object({
  /**
   * Stable across renames. The builder generates it; it never has to be
   * readable, only unique within its question.
   */
  value: z.string().min(1).max(LABEL_MAX),
  label: z.string().min(1).max(LABEL_MAX),
});
export type QuestionOption = z.infer<typeof questionOptionSchema>;

/**
 * The comparisons a *Bedingte Anzeige* may make.
 *
 * The list is short on purpose: the prototype knows
 * a condition **per question** — one source, one operator, one value — and no
 * page jumps, no branching, no `und`/`oder`. Anything richer would have to
 * answer what a skipped page does to the progress bar, to the Pflichtprüfung
 * and to an export per version, all at once.
 */
export const conditionOperatorSchema = z.enum([
  /** „ist gleich" — the answer carries exactly this value. */
  'equals',
  /** „ist nicht" — the strict negation of {@link equals}, blank included. */
  'notEquals',
  /** „ist ausgefüllt" — anything counts as an answer except „leer". */
  'filled',
  /** „ist leer". */
  'empty',
  /** „größer als" — Zahl- and Bewertungsquellen only. */
  'greaterThan',
  /** „kleiner als" — Zahl- and Bewertungsquellen only. */
  'lessThan',
  /** „enthält" — Freitext ohne Optionen only. */
  'contains',
]);
export type ConditionOperator = z.infer<typeof conditionOperatorSchema>;

/** What every source type offers, whatever it is („immer"). */
const ALWAYS_AVAILABLE = [
  'equals',
  'notEquals',
  'filled',
  'empty',
] as const satisfies readonly ConditionOperator[];

/**
 * **The operator matrix for conditions, as one table** — which operators a question of
 * each type offers *as the source of a condition*.
 *
 * `satisfies Record<QuestionType, …>` rather than a lookup with a fallback, and
 * that is the whole mechanism: a seventeenth question type does not quietly
 * inherit „alle Operatoren" or „keine", it fails `pnpm typecheck` with the name
 * of the type nobody decided about. The gate is the typecheck, not Vitest —
 * SWC strips the annotation without ever reading it.
 *
 * The **empty** lists are the exclusion stated in prose elsewhere (`info`,
 * `file`, `table`, `matrix`, `address` are no sources), expressed as what it
 * actually means: there is no comparison one can offer over them. An Infotext
 * has no answer at all; an Adresse, eine Matrix, eine Tabelle and ein
 * Datei-Upload have structured ones, where „ist gleich <Text>" would have to
 * pick a subfield behind the editor's back — and the one it picked would be
 * invisible in the builder and wrong for half the forms.
 *
 * `date` deliberately has **no `contains`**, though a bare „Freitext ohne
 * Optionen" test would give it one (the handoff's own editor does): its answer
 * is a `YYYY-MM-DD` string, so „enthält 08" would match August *and* the eighth
 * of any month — a comparison that reads as a date question and answers as a
 * string search. `event` gets none for the same kind of reason: its answer is a
 * Personenzahl je Termin, and its values are event keys, not free text.
 */
const CONDITION_OPERATORS_BY_SOURCE = {
  text: [...ALWAYS_AVAILABLE, 'contains'],
  textarea: [...ALWAYS_AVAILABLE, 'contains'],
  email: [...ALWAYS_AVAILABLE, 'contains'],
  phone: [...ALWAYS_AVAILABLE, 'contains'],
  number: [...ALWAYS_AVAILABLE, 'greaterThan', 'lessThan'],
  rating: [...ALWAYS_AVAILABLE, 'greaterThan', 'lessThan'],
  date: ALWAYS_AVAILABLE,
  select: ALWAYS_AVAILABLE,
  radio: ALWAYS_AVAILABLE,
  checkbox: ALWAYS_AVAILABLE,
  event: ALWAYS_AVAILABLE,
  info: [],
  file: [],
  table: [],
  matrix: [],
  address: [],
} as const satisfies Record<QuestionType, readonly ConditionOperator[]>;

/**
 * The operators a source of this type offers — empty for a type that is no
 * source at all.
 *
 * One reader for {@link CONDITION_OPERATORS_BY_SOURCE}, so the builder's
 * operator list and the evaluation (`condition.ts`) cannot come apart:
 * an operator the editor can pick and the evaluation does not know would hide a
 * question forever, and the editor would never see why.
 */
export function conditionOperatorsFor(
  type: QuestionType,
): readonly ConditionOperator[] {
  return CONDITION_OPERATORS_BY_SOURCE[type];
}

/**
 * May a question of this type be the **source** of a condition?
 *
 * Derived from the same table rather than stated a second time as a list of
 * five names — two lists are two places to add the seventeenth type to, and the
 * one nobody edits is the one that decides. Those same five names are
 * asserted against this function in `condition.test.ts`, which is where a
 * restatement belongs.
 */
export function canBeConditionSource(type: QuestionType): boolean {
  return conditionOperatorsFor(type).length > 0;
}

const conditionQuestionShape = {
  /**
   * The **source** question — the one whose answer decides.
   *
   * Nothing is looked up by it *here*, exactly as with `replaces` below: a
   * condition pointing at a question that is gone, that comes later, or at its
   * own question is inert in this schema and is caught where it can be
   * explained — when the form is **published** . A schema that
   * refused it would refuse the draft in the middle of an edit: an editor who
   * drags the source below its dependant, or deletes it before adding the new
   * one, would be unable to save at all.
   */
  questionId: z.uuid(),
};

/**
 * The value a comparison is made against — an option value, an event key or a
 * typed piece of text, always as the string the builder shows.
 *
 * `trim().min(1)`: „ist gleich <nichts>" is „ist leer" said badly, and there is
 * an operator for that. Allowing the empty string would give one state two
 * spellings, and the second one reads in the builder as a condition nobody
 * finished.
 *
 * **The trim is what makes that sentence true**, and it was missing until a
 * review measured the second spelling: `' '` passes `min(1)`, and a condition
 * `equals ' '` is „ist leer" in every reading that matters — over a Textquelle
 * it matched the answer `''` (both sides are trimmed in `equalsReading`), over
 * a Zahlquelle it matched the answer `0` (`Number(' ')` is `0`). One state,
 * two spellings, and the second one is the one an editor produces by pressing
 * the space bar in a field they then leave. Trimming first turns it into the
 * refusal the comment always claimed; it also normalises the value the
 * evaluation compares against, so „Bahn " and „Bahn" cannot be two conditions.
 */
const conditionValueSchema = z.string().trim().min(1).max(LABEL_MAX);

/**
 * One Bedingung: **when** this question is shown.
 *
 * A discriminated union over the operator rather than one object with an
 * optional `value`, for the reason the whole file is built that way: „ist
 * ausgefüllt" has no comparison value, and a `value` sitting beside it would be
 * a field the builder shows, the editor fills and nothing ever reads.
 * „größer als" takes a **number** and nothing else — `{operator: 'greaterThan',
 * value: 'Ja'}` is not a condition that evaluates to `false`, it is a document
 * that never parses, and the editor hears about it while saving instead of the
 * participant hearing nothing at all.
 *
 * Which operators are *available* is a second question, decided by the type of
 * the source ({@link conditionOperatorsFor}) and enforced at publish time — the
 * schema cannot decide it, because it does not see the source from here.
 */
export const questionConditionSchema = z.discriminatedUnion('operator', [
  z.object({ ...conditionQuestionShape, operator: z.literal('filled') }),
  z.object({ ...conditionQuestionShape, operator: z.literal('empty') }),
  z.object({
    ...conditionQuestionShape,
    operator: z.literal('equals'),
    value: conditionValueSchema,
  }),
  z.object({
    ...conditionQuestionShape,
    operator: z.literal('notEquals'),
    value: conditionValueSchema,
  }),
  z.object({
    ...conditionQuestionShape,
    operator: z.literal('contains'),
    value: conditionValueSchema,
  }),
  z.object({
    ...conditionQuestionShape,
    operator: z.literal('greaterThan'),
    value: z.number(),
  }),
  z.object({
    ...conditionQuestionShape,
    operator: z.literal('lessThan'),
    value: z.number(),
  }),
]);
export type QuestionCondition = z.infer<typeof questionConditionSchema>;

/**
 * **The lock** between the operator list and the union above.
 *
 * An operator added to {@link conditionOperatorSchema} without a member here
 * would be a name the builder offers, the table above hands out and no document
 * can carry — and every runtime test would stay green, because nothing can
 * construct the value that would fail. This fails at `pnpm typecheck` instead,
 * in the file that owns both halves. Same idea as `StructuredAnswerTagLock` in
 * `response-validation.ts`, one union further along.
 */
type EveryOperatorIsAMember<Same extends true> = Same;
export type ConditionOperatorLock = EveryOperatorIsAMember<
  ConditionOperator extends QuestionCondition['operator']
    ? QuestionCondition['operator'] extends ConditionOperator
      ? true
      : false
    : false
>;

/** What every question has, whatever its type. */
const questionBaseShape = {
  id: z.uuid(),
  label: z.string().min(1).max(LABEL_MAX),
  /** Hinweistext under the label, or null when the builder left it empty. */
  hint: z.string().max(HINT_MAX).nullable(),
  required: z.boolean(),
  width: questionWidthSchema,
  /**
   * The question this one took the place of.
   *
   * Changing a question's type mints a **new id** (no. 24), so that „Ja" and
   * `42` never share a column. Without a reference back, the comparison before
   * publishing (`publishDiff`) sees one question disappear and an unrelated one
   * appear, and tells the editor about the same change twice. This field is
   * that reference — stated by the builder, not guessed from equal labels,
   * which fails the moment someone renames while retyping and mispairs two
   * questions that happen to share a text.
   *
   * It points at the state of the **last save**: text → number → date in one
   * sitting is one type change, so the reference skips the intermediate id.
   *
   * **`.optional()`, against the rule two paragraphs up**, and the exception is
   * the point: every question written before this feature existed — every
   * document stored before it — has no such predecessor, and most questions never will.
   * `.nullable()` would demand an explicit `replaces: null` in each of them and
   * turn a stored document into one that no longer parses. Absent therefore
   * means „stands on its own", which is what absence already meant.
   *
   * Nothing is looked up by it: it is compared against the ids of the same
   * document and of the version in force, never against the database, so a
   * value pointing nowhere is inert rather than dangerous.
   */
  replaces: z.uuid().optional(),
  /**
   * *Bedingte Anzeige*: this question is shown only while the condition holds.
   *
   * **`.optional()` and deliberately not `.nullable()`** — „keine Bedingung"
   * has exactly **one** spelling, the absent key. `replaces` above needs the
   * exception for stored documents and gets it for the same reason this field
   * does (every question written before conditions existed has no such key); what this one
   * adds is that there is no *second* way to say it. A `null` beside the
   * absence would be a third state for `sameDefinition` to tell apart —
   * measured once already on `pageSchema.description`: a question
   * whose switch is turned on and off again would report as „etwas zu
   * veröffentlichen" though no participant would see anything different.
   * `canonicalJson` drops `undefined`, so `{visibleIf: undefined}` from the
   * builder store and an absent key are already one state.
   *
   * It sits on the **base** shape, so an Infotext can carry one too: whether a
   * block is shown is a question about the *display*, and a callout that only
   * appears for those who answered „Ich komme mit dem Auto" is exactly what an
   * Infotext is for. That it has no answer changes nothing here — it changes
   * what happens downstream, where an `info` gets no key in the answer object
   * either way.
   */
  visibleIf: questionConditionSchema.optional(),
};

/**
 * A pattern that PostgreSQL never sees and the server has to run: it is
 * compiled here so a broken one is rejected when the form is **saved**, not
 * when the first participant submits.
 *
 * What this promises: the expression compiles. What it does **not** promise:
 * that it terminates quickly on every input. Catastrophic backtracking is not
 * decidable from the source in the general case, and pretending otherwise
 * would be worse than saying so — the mitigations that do exist are the length
 * bound above and the fact that only authenticated editors can write one.
 */
const compilablePattern = z
  .string()
  .min(1)
  .max(PATTERN_MAX)
  .refine(
    (source) => {
      try {
        // The value is *only* compiled, never executed here: compiling is what
        // decides validity, and running it against a probe input would be the
        // very denial of service this guard exists next to.
        new RegExp(source, 'u');
        return true;
      } catch {
        return false;
      }
    },
    { error: 'Kein gültiger regulärer Ausdruck.' },
  );

/**
 * `YYYY-MM-DD`, the format `<input type="date">` produces and the only one a
 * date bound is accepted in.
 *
 * `z.iso.date()` also rejects the calendar-impossible values a bare pattern
 * would let through (`2026-02-30`), which matters because a bound nobody can
 * satisfy is indistinguishable from a form that is simply broken.
 */
const isoDateSchema = z.iso.date();

/**
 * Rejects a range whose ends cross — `min > max` describes a question no
 * answer can satisfy, and the builder is the place to hear about it.
 *
 * Written once and applied per variant rather than as one check over the union,
 * so the error path names the field the builder can actually focus.
 */
function checkRange<T extends number | string>(
  ctx: z.RefinementCtx,
  min: T | null,
  max: T | null,
  minKey: string,
  maxKey: string,
): void {
  if (min === null || max === null) {
    return;
  }
  if (min > max) {
    ctx.addIssue({
      code: 'custom',
      path: [maxKey],
      message: `„${maxKey}" darf nicht kleiner sein als „${minKey}".`,
    });
  }
}

/**
 * A non-empty list of `{ value, label }` pairs with **unique values** — the
 * shape an option list is, and the shape a Matrix's statements and
 * its scale are too.
 *
 * A duplicate value is not a cosmetic problem: answers refer to values, so two
 * entries sharing one make a stored answer ambiguous forever — and the CSV
 * export would show whichever label the lookup happened to find first.
 *
 * A factory rather than one shared constant only because of the **messages**:
 * an editor reading „Mindestens eine Option." under a list captioned „Zeilen
 * (Aussagen)" would look for a control that is not there. The rule is one, the
 * wording is per caller.
 */
function labelledListSchema(emptyError: string, duplicateError: string) {
  return z
    .array(questionOptionSchema)
    .min(1, { error: emptyError })
    .max(500)
    .superRefine((options, ctx) => {
      const seen = new Set<string>();
      options.forEach((option, index) => {
        if (seen.has(option.value)) {
          ctx.addIssue({
            code: 'custom',
            path: [index, 'value'],
            message: duplicateError,
          });
        }
        seen.add(option.value);
      });
    });
}

const optionsSchema = labelledListSchema(
  'Mindestens eine Option.',
  'Doppelter Optionswert.',
);

/**
 * The statements of a Matrix — its **rows** .
 *
 * The same `{ value, label }` pair an option is, and for the same reason: a
 * stored answer refers to the row by value, so renaming „Organisation" into
 * „Organisation & Ablauf" must not orphan the answers already given — nor
 * rename the export column's *key*, which is what keeps a row's column stable
 * across published versions (`questionHistory`).
 *
 * **The 500-entry bound is inherited and is generous here**: every row becomes
 * its own export column, so a Matrix may contribute up to 500 of
 * them, where a Tabelle is deliberately capped at 20 × 20 ({@link
 * TABLE_ROWS_MAX}). Left as it is rather than tightened on a hunch — nobody
 * writes a 500-statement Matrix, and picking a lower number would be a limit
 * invented in a code review rather than one anybody asked for. Noted
 * so the asymmetry is a decision and not an oversight.
 */
const matrixRowsSchema = labelledListSchema(
  'Mindestens eine Zeile.',
  'Doppelter Zeilenwert.',
);

/** The scale of a Matrix — its **columns**, same pair for the same reason. */
const matrixColumnsSchema = labelledListSchema(
  'Mindestens eine Spalte.',
  'Doppelter Spaltenwert.',
);

/** The „Sonstiges" escape hatch of a choice question (design handoff). */
const otherShape = {
  /** Whether a free-text „Sonstiges" choice is offered at all. */
  allowOther: z.boolean(),
  /** Editable caption of that choice; null while `allowOther` is false. */
  otherLabel: z.string().min(1).max(LABEL_MAX).nullable(),
};

const textQuestionSchema = z
  .object({
    ...questionBaseShape,
    type: z.literal('text'),
    minLength: z.number().int().nonnegative().max(10_000).nullable(),
    maxLength: z.number().int().positive().max(10_000).nullable(),
    pattern: compilablePattern.nullable(),
  })
  .superRefine((question, ctx) => {
    checkRange(
      ctx,
      question.minLength,
      question.maxLength,
      'minLength',
      'maxLength',
    );
  });

const textareaQuestionSchema = z
  .object({
    ...questionBaseShape,
    type: z.literal('textarea'),
    minLength: z.number().int().nonnegative().max(50_000).nullable(),
    maxLength: z.number().int().positive().max(50_000).nullable(),
  })
  .superRefine((question, ctx) => {
    checkRange(
      ctx,
      question.minLength,
      question.maxLength,
      'minLength',
      'maxLength',
    );
  });

const numberQuestionSchema = z
  .object({
    ...questionBaseShape,
    type: z.literal('number'),
    min: z.number().nullable(),
    max: z.number().nullable(),
    /** Whole numbers only — Semesterzahl, Teilnehmerzahl, Jahrgang. */
    integer: z.boolean(),
  })
  .superRefine((question, ctx) => {
    checkRange(ctx, question.min, question.max, 'min', 'max');
  });

const dateQuestionSchema = z
  .object({
    ...questionBaseShape,
    type: z.literal('date'),
    minDate: isoDateSchema.nullable(),
    maxDate: isoDateSchema.nullable(),
  })
  .superRefine((question, ctx) => {
    // Lexicographic comparison is the correct one for `YYYY-MM-DD`, and it is
    // the reason the format is pinned rather than merely preferred.
    checkRange(ctx, question.minDate, question.maxDate, 'minDate', 'maxDate');
  });

const emailQuestionSchema = z.object({
  ...questionBaseShape,
  type: z.literal('email'),
});

const phoneQuestionSchema = z.object({
  ...questionBaseShape,
  type: z.literal('phone'),
});

const choiceShape = {
  ...questionBaseShape,
  options: optionsSchema,
  ...otherShape,
};

const selectQuestionSchema = z.object({
  ...choiceShape,
  type: z.literal('select'),
});

const radioQuestionSchema = z.object({
  ...choiceShape,
  type: z.literal('radio'),
});

const checkboxQuestionSchema = z
  .object({
    ...choiceShape,
    type: z.literal('checkbox'),
    /** How many options must be ticked at least; null means "no lower bound". */
    minSelected: z.number().int().nonnegative().nullable(),
    maxSelected: z.number().int().positive().nullable(),
  })
  .superRefine((question, ctx) => {
    checkRange(
      ctx,
      question.minSelected,
      question.maxSelected,
      'minSelected',
      'maxSelected',
    );
    // A lower bound above what the question offers is unsatisfiable. `+1` for
    // „Sonstiges", which is a choice a participant can pick like any other.
    const available = question.options.length + (question.allowOther ? 1 : 0);
    if (question.minSelected !== null && question.minSelected > available) {
      ctx.addIssue({
        code: 'custom',
        path: ['minSelected'],
        message: 'Mehr Pflichtangaben als Optionen.',
      });
    }
  });

/**
 * Bewertung (`rating`) — a fixed row of stars.
 *
 * `max` is the one setting the handoff gives an editor: how many stars the
 * row has, **2–10**, defaulting to **5** (Handoff, `inspectorExtra()`'s rating
 * branch). There are deliberately no endpoint captions — the prototype's
 * rating control has none, unlike a Matrix's column headers — and no
 * half-star step; a click always lands on a whole star.
 *
 * The answer itself is a plain `number` (see `response-validation.ts`), which
 * is what lets `questionColumns` give it the `'number'` guard and the export a
 * column Excel sorts numerically instead of lexicographically.
 */
const ratingQuestionSchema = z.object({
  ...questionBaseShape,
  type: z.literal('rating'),
  max: z.number().int().min(2).max(10),
});

/**
 * Infotext (`info`) — a callout, not a question.
 *
 * It carries the same base shape as every other variant (label, hint, id …),
 * because the builder, the publish diff and the drag-reorder all handle a
 * question generically through those fields and gain nothing from a second,
 * narrower base. What makes it „keine Frage" is decided **downstream**, once,
 * where each consequence lives:
 *
 * - `buildAnswersSchema` (`response-validation.ts`) gives it **no key at all**
 *   in the answer object — not an optional one, none — so a value submitted
 *   for it is an *unknown* field and `.strict()` rejects the whole submission
 *   rather than silently dropping it.
 * - `questionColumns` (`answer-columns.ts`) returns an **empty** column list —
 *   no cell in the responses table, no column in the export.
 * - `required` and `width` still parse (they are part of the shared base) but
 *   are inert: nothing ever reads `required` for an `info` question, and the
 *   builder does not offer the Pflichtfeld toggle for it (`QuestionProperties`).
 *   Carrying a value nobody acts on is the accepted cost of one shared base
 *   over a second one only this variant would use.
 */
const infoQuestionSchema = z.object({
  ...questionBaseShape,
  type: z.literal('info'),
});

/**
 * Adresse (`address`) — four subfields, one **structured** answer.
 *
 * No type-specific setting at all — the handoff's own `inspectorExtra()` has
 * no `q.type === 'address'` branch (unlike `rating`'s Sterne-Maximum), so this
 * question carries nothing beyond `questionBaseShape`. What is worth writing
 * down instead is what is **decided downstream, once**, because a structured
 * answer breaks assumptions every other type up to this one gets to make for
 * free:
 *
 * - The answer is an object (`AddressAnswer`, `response-validation.ts`), not a
 *   composed string. A string would have to be taken apart again to reach „nur
 *   die PLZ", and taking a free-form string apart reliably is not possible —
 *   the whole reason `response-validation.ts` stores the four parts
 *   separately.
 * - **Pflicht binds only three of the four subfields**:
 *   Straße, PLZ and Ort are required exactly when the question itself is,
 *   Land never is. That rule is stated in `addressAnswerSchema`, not here —
 *   `required` on this type means exactly what it means on every other one
 *   (`buildAnswersSchema` reads it the same way), and the *distribution* of
 *   that one flag over four subfields is the answer schema's concern, not the
 *   question schema's.
 * - **`questionColumns` gives it four columns**, keyed by part (`answer-
 *   columns.ts`) — the export is mehrspaltig while the table and
 *   the detail panel keep the folded single line (`formatAnswerCell`).
 */
const addressQuestionSchema = z.object({
  ...questionBaseShape,
  type: z.literal('address'),
});

/**
 * Matrix (`matrix`) — fixed statements × scale.
 *
 * One question that asks the same scale about several statements: the rows are
 * the statements („Organisation", „Programm", „Verpflegung"), the columns are
 * the scale („Sehr gut" … „Schlecht"), and a participant picks **one** per row
 * — or several, when {@link multiple} is on.
 *
 * **Pflicht means here: every row is answered**, and the rule is stated on
 * the answer schema (`matrixAnswerSchema` in `response-validation.ts`) with the
 * reason. It belongs on this type rather than on the other structured one
 * because of what the export does with it: every row becomes **its own column**
 * , so every row is a question in its own right — and „mindestens
 * eine" would let ten of twelve columns stay empty in an evaluation that reads
 * like complete data.
 */
const matrixQuestionSchema = z.object({
  ...questionBaseShape,
  type: z.literal('matrix'),
  /** The statements, one per row — the export's column headers. */
  rows: matrixRowsSchema,
  /** The scale, one per column — the values an answer may carry. */
  columns: matrixColumnsSchema,
  /** „Mehrfachauswahl je Zeile" (Handoff, `inspectorExtra()`'s matrix branch). */
  multiple: z.boolean(),
});

/**
 * What one table column collects — Text, Zahl, Liste, Haken (Handoff's own
 * four entries in the column editor's `<select>`).
 */
export const tableCellTypeSchema = z.enum([
  'text',
  'number',
  'select',
  'checkbox',
]);
export type TableCellType = z.infer<typeof tableCellTypeSchema>;

const tableColumnBaseShape = {
  /**
   * Stable across renames, exactly like an option's `value` — a stored cell is
   * keyed by it, and so is the export column it produces.
   */
  key: z.string().min(1).max(LABEL_MAX),
  label: z.string().min(1).max(LABEL_MAX),
};

/**
 * One column of a table — a discriminated union, not one object with an
 * optional `options`.
 *
 * A „Liste" column without an option list is the defect the handoff itself
 * has: its dropdown cell renders a single `<option>—</option>` and is bound to
 * nothing, so the column looks configurable and collects nothing. Making the
 * option list part of the *variant* means a Liste column cannot exist without
 * one, and the other three cannot carry a list nobody reads.
 */
const tableColumnSchema = z.discriminatedUnion('type', [
  z.object({ ...tableColumnBaseShape, type: z.literal('text') }),
  z.object({ ...tableColumnBaseShape, type: z.literal('number') }),
  z.object({
    ...tableColumnBaseShape,
    type: z.literal('select'),
    options: optionsSchema,
  }),
  z.object({ ...tableColumnBaseShape, type: z.literal('checkbox') }),
]);
export type TableColumn = z.infer<typeof tableColumnSchema>;

/**
 * Highest row count an editor may set — **and the number the file can write**.
 *
 * The bound is not cosmetic: a table contributes `columns × rows` columns to
 * the export, so the two multiply. 20 × 20 is 400 columns from a
 * single question, which is already past what a spreadsheet is pleasant to
 * read; beyond it the file stops being an evaluation and becomes a denial of
 * one.
 *
 * It is also the ceiling of the **column plan**: `tableRowCount`
 * (`answer-columns.ts`) clamps what a stored answer may decide about the width
 * of everybody's file at this number, and rows above it have no header, no
 * column and no marker — they simply are not in the file. That makes this
 * constant the ceiling of {@link tableRowLimit} too, checked by the schema
 * rather than by a habit: a document whose Obergrenze exceeded it would be
 * „breiter beantwortbar als schreibbar", and the difference would be answers
 * the application took and cannot show.
 */
export const TABLE_ROWS_MAX = 20;

/**
 * Highest column count a Tabelle may have — die zweite Hälfte derselben
 * Rechnung.
 *
 * **Exportiert seit Review-Runde 5 Nr. 4** („Warum maximal 20 Zeilen in der
 * Tabelle?"). Die Antwort ist das Produkt der beiden Zahlen, und sie steht
 * seitdem am Feld im Editor (`QuestionProperties.tsx`): 20 × 20 sind 400
 * Spalten, die eine einzige Frage in die Auswertung schreibt. Wer die Zahl dort
 * nennen will, muss sie hier lesen können — die Alternative wäre eine zweite
 * Schreibweise derselben Obergrenze in der Oberfläche, und die zweite ist die,
 * an die beim Ändern niemand denkt.
 */
export const TABLE_COLUMNS_MAX = 20;

/**
 * „Zeilen ergänzbar" — the participant may add rows, up to `maxRows` of them
 * in total.
 *
 * **An object rather than two fields beside each other**, and that is the whole
 * design: „ergänzbar" and „Obergrenze" are one decision, so the shape does not
 * let them come apart. A boolean plus a number could say „ergänzbar, ohne
 * Grenze" — the exact hole this design closes — or „Grenze, aber
 * nicht ergänzbar", a limit nobody can reach. Neither is expressible here: the
 * bound is *inside* the switch, the same way a „Liste" column carries its
 * option list (`tableColumnSchema` above).
 *
 * **`maxRows` counts all rows, the Startzeilen included** — it is what an
 * answer may carry, not how many may be added to it. That is why it is checked
 * against `rows` below rather than added to it: one number to compare a
 * `cells.length` against, in the validator and in the fill-in view alike
 * ({@link tableRowLimit}).
 *
 * **Bounded by {@link TABLE_ROWS_MAX}, and this is the load-bearing line of the
 * package.** The export writes at most that many row blocks; a form that
 * accepted more would take answers it cannot show — measured directly:
 * a stored answer with 25 rows loses `N21`–`N25` from the file without a
 * header, without a marker, without a word. The document stops parsing instead.
 */
const tableRowGrowthSchema = z.object({
  maxRows: z.number().int().min(1).max(TABLE_ROWS_MAX),
});

/**
 * Tabelle (`table`) — freely defined columns over a row count **settable in
 * the editor**, **extendable**.
 *
 * `rows` is the number of rows the form **starts** with; `addRows` decides
 * whether a participant may add more and where that stops. Without `addRows`
 * the question is exactly what this type originally was — a fixed row count
 * nobody can grow — which is what makes every stored document from before
 * this feature keep its meaning rather than merely keep parsing.
 *
 * **`.optional()` and deliberately not `.nullable()`**, the same exception
 * `questionBaseShape.visibleIf` documents and for both of its reasons: every
 * table written before this package has no such key, and „nicht ergänzbar"
 * gets exactly **one** spelling. A `null` beside the absence would be a third
 * state for `sameDefinition` to tell apart — a switch turned on and off again
 * would report as „etwas zu veröffentlichen" though no participant would see
 * anything different (measured once already on `pageSchema.description`).
 *
 * **`rows ≥ 1` stays, and it is a decision rather than a leftover** .
 * „Beliebig viele Begleitpersonen" would be spelled `rows: 0` plus `addRows`,
 * and it is refused for two reasons that point the same way:
 *
 * - A table with no row is a header over nothing. „+ Zeile" is then the only
 *   thing on screen that hints there is anything to fill in at all, and one
 *   start row costs a participant who brings nobody exactly nothing — an
 *   untouched row is blank (`isBlankTable`), so it neither satisfies nor
 *   violates the Pflicht rule and exports as empty cells.
 * - `responseColumns` (`form-history.ts`) asks for the columns of a form
 *   **without any answer in hand**, and a table is on that list because
 *   `rows ≥ 1` and „mindestens eine Spalte" make its plan non-empty. With
 *   `rows: 0` a question nobody has answered yet would drop out of the field
 *   menu and the responses table while the export — which *does* hold the
 *   answers — writes columns for it. That consequence is stated at that
 *   function and shown by the test beneath it; what guards the bound itself is
 *   „refuses a Tabelle without a start row" in `form-schema.test.ts`.
 *
 * **Pflicht means here: at least one row is filled in** — the opposite
 * of the Matrix above, stated in `tableAnswerSchema` with the reason. The row
 * count is what the form *offers*, not what it demands: a „Begleitpersonen"
 * table with three rows would otherwise force three companions on everybody
 * who has one.
 */
const tableQuestionSchema = z.object({
  ...questionBaseShape,
  type: z.literal('table'),
  columns: z
    .array(tableColumnSchema)
    .min(1, { error: 'Mindestens eine Spalte.' })
    .max(TABLE_COLUMNS_MAX)
    .superRefine((columns, ctx) => {
      const seen = new Set<string>();
      columns.forEach((column, index) => {
        if (seen.has(column.key)) {
          ctx.addIssue({
            code: 'custom',
            path: [index, 'key'],
            message: 'Doppelter Spaltenwert.',
          });
        }
        seen.add(column.key);
      });
    }),
  /**
   * How many rows the form **starts** with — never how many a participant must
   * fill, and never how many the answer may end up with either
   * ({@link tableRowLimit}).
   */
  rows: z.number().int().min(1).max(TABLE_ROWS_MAX),
  /** „Zeilen ergänzbar", or absent while the row count is fixed. */
  addRows: tableRowGrowthSchema.optional(),
});

/**
 * The Obergrenze may not sit **below** the Startzeilen.
 *
 * A cross-field rule, so it lives on the object rather than on either field: a
 * form offering three rows and accepting two would refuse its own untouched
 * submission — the fill-in view renders what `rows` says, and the validator
 * counts what arrives. Refusing the *document* is the only place that failure
 * can be caught before a participant runs into it.
 */
const tableQuestionWithBounds = tableQuestionSchema.superRefine(
  (question, ctx) => {
    if (
      question.addRows !== undefined &&
      question.addRows.maxRows < question.rows
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['addRows', 'maxRows'],
        message: 'Die Obergrenze liegt unter der Zahl der Startzeilen.',
      });
    }
  },
);

/**
 * How many rows an answer to this question may carry — the **one** number
 * `response-validation.ts` refuses above, the fill-in view is to hide
 * „+ Zeile" at (the maxRows bound) and the editor writes.
 *
 * Written once, here, because it is read on three sides of a wire: a bound the
 * client computed differently from the server would be a „+ Zeile" offering a
 * row the submission is then refused for. Everything it is allowed to be is already
 * decided by the schema above — `rows ≥ 1`, `maxRows ≤ TABLE_ROWS_MAX`,
 * `maxRows ≥ rows` — so this function has no opinion of its own and cannot
 * drift from one.
 */
export function tableRowLimit(question: TableQuestion): number {
  return question.addRows?.maxRows ?? question.rows;
}

/**
 * Datei-Upload (`file`) — one or more attachments to the answer
 * (ADR-0014).
 *
 * **`maxFiles` is the only setting, and the two the handoff offers are
 * deliberately absent.** Its own inspector has „Erlaubte Dateitypen" (a free
 * text box, default `PDF, JPG, PNG`) and „Maximale Größe (MB)" — both of them
 * an editor's opinion about a rule this application does not let an editor
 * decide. The accepted types are the allow list of ADR-0014 no. 5, checked
 * against the **signature** of the content on the server (`file-types.ts`), and
 * the size limit is no. 6; a per-question box for either would be a promise the
 * server refuses to keep — an editor who typed „DOCX" would produce a field
 * that rejects every file a participant picks, and one who typed „100 MB" a
 * field that rejects everything above ten. What an editor *can* decide without
 * contradicting the server is **how many** files this question collects.
 *
 * Bounded by {@link MAX_FILES_PER_RESPONSE} rather than by a number of its own:
 * ten files is what one *answer* may carry (no. 6, enforced when it is
 * submitted), so a question offering eleven would be a field whose full use is
 * refused at the last step. One constant, read in both places.
 *
 * What is decided downstream, once, and named here because a file answer breaks
 * assumptions the scalar types get for free:
 *
 * - The answer is an object carrying **reference and name per file**
 *   (`FileAnswer`, `response-validation.ts`). The bytes are not in it — they
 *   live behind `GET /api/responses/files/:ref`, behind the guard chain.
 * - `questionColumns` gives it **one** column holding the file **names**
 *   (ADR-0014 no. 17): no URL, no reference, because an export is the document
 *   that gets mailed on and put on network drives.
 * - The references are what a submission claims (`attachment-refs.ts`), and
 *   claiming is what makes the uploaded bytes belong to the answer at all.
 */
const fileQuestionSchema = z.object({
  ...questionBaseShape,
  type: z.literal('file'),
  /** How many attachments this question collects — never more than one answer may carry. */
  maxFiles: z.number().int().min(1).max(MAX_FILES_PER_RESPONSE),
});

/**
 * How many Veranstaltungen one question may carry.
 *
 * The BT template has six („Teilnehmeranzahl je Veranstaltung") and
 * every entry becomes its own export column, so the bound is the table's kind
 * of bound rather than the option list's 500: an organisation that needs fifty separate
 * events on one form is describing a programme, not a registration.
 */
const EVENTS_MAX = 50;

/**
 * The largest Obergrenze an editor may set.
 *
 * Not a technical limit — it is the number above which „Obergrenze" stops
 * meaning anything, and the field where „ohne Grenze" is the honest answer. The
 * switch for that is `capacity: null`, so nobody has to type a big number to say
 * „unbegrenzt".
 */
export const EVENT_CAPACITY_MAX = 100_000;

/**
 * One Veranstaltung of an `event` question.
 *
 * **`key` and `label` are separate, exactly like an option's `value` and its
 * caption** (`questionOptionSchema`), and for the identical reason twice over: a
 * stored answer is keyed by `key`, and so is the export column and the
 * `event_registration` row that holds the seats. Renaming „Sommerfest" into
 * „Sommerfest (Aula)" must not orphan the registrations already taken, and it
 * must not silently mint a second, empty event next to a full one.
 *
 * **`capacity: number | null` is „Pflicht *oder* ohne Grenze"**, and
 * `null` is the second half of it rather than a missing value:
 * an event without an upper bound is a normal event (the Umzug that everyone may
 * join), not one whose limit somebody forgot. Nothing else can express it —
 * a `0` would read as „ausgebucht ab dem ersten Tag" and a very large number
 * would be a limit that exists and is a lie.
 *
 * **`when` is free text, not a date.** The handoff's own entries read „Fr,
 * 19:00" and „So, 11:00" — a Termin here is what a participant reads next to the
 * name, and pinning it to `YYYY-MM-DD` would refuse exactly the spellings the
 * BT template uses. Nothing computes with it.
 *
 * **`registered` from the prototype is deliberately absent.** Its editor lets an
 * admin type the number of registrations by hand; here that number is the sum of
 * the `event_registration` rows and can only ever be *read*. A settable one
 * would be a second truth about the same seats, and the one that drifts is
 * always the one nobody looks at.
 */
export const eventEntrySchema = z.object({
  key: z.string().min(1).max(LABEL_MAX),
  label: z.string().min(1).max(LABEL_MAX),
  /** „Fr, 19:00" — shown, never computed with. `null` while none was given. */
  when: z.string().max(LABEL_MAX).nullable(),
  /** The Obergrenze in **people**, or `null` for „ohne Grenze" . */
  capacity: z.number().int().min(1).max(EVENT_CAPACITY_MAX).nullable(),
  /**
   * „Restplätze anzeigen" — per event, because
   * the number is a statement about an organisation's registration state and leaves the house
   * without a session. „Ausgebucht" is always visible; the *number* is this
   * switch.
   */
  showRemaining: z.boolean(),
});
export type EventEntry = z.infer<typeof eventEntrySchema>;

/**
 * Veranstaltung with a participant limit (`event`).
 *
 * **One question carries several Veranstaltungen**, which is the form
 * the old BT template already had: six lines under one heading. Six separate
 * questions would be laborious in the builder and unreadable in the export, and
 * they could not share the sentence „Bitte die Teilnehmeranzahl je Veranstaltung
 * eintragen".
 *
 * What is decided **downstream** and named here, because this type breaks two
 * assumptions every earlier one could make for free:
 *
 * - **The answer is a number per event** (`EventAnswer`,
 *   `response-validation.ts`) — the *Personenzahl*, not a tick. The specification is
 *   explicit and it is the whole point of the type: an organisation registers „3 Personen
 *   zum Sommerfest", and three seats are gone. **This deviates from the
 *   prototype**, whose event field is a checkbox list (`renderPreview`'s event
 *   branch toggles membership in a set): a tick can say „wir kommen" and cannot
 *   say with how many, so the limit it feeds counts registrations instead of
 *   people.
 * - **The Obergrenze is enforced in a transaction, never here** — the sum over
 *   all non-deleted answers of the form, behind `SELECT … FOR UPDATE` on the
 *   form row (`public-forms.service.ts`). This schema knows
 *   what an event *holds*; only the database knows what is *left*, and a second
 *   opinion about that in the validator would be stale the moment it is given.
 *   That is why {@link eventEntrySchema}'s `capacity` does **not** bound the
 *   number a participant may enter: „mehr als frei ist" is one rule, in one
 *   place, and it answers 409 with the position it fired on.
 */
const eventQuestionSchema = z.object({
  ...questionBaseShape,
  type: z.literal('event'),
  events: z
    .array(eventEntrySchema)
    .min(1, { error: 'Mindestens eine Veranstaltung.' })
    .max(EVENTS_MAX)
    .superRefine((events, ctx) => {
      const seen = new Set<string>();
      events.forEach((event, index) => {
        if (seen.has(event.key)) {
          ctx.addIssue({
            code: 'custom',
            path: [index, 'key'],
            message: 'Doppelte Veranstaltung.',
          });
        }
        seen.add(event.key);
      });
    }),
});

/**
 * One question, of exactly one of the types `questionTypeSchema` lists.
 *
 * A discriminated union rather than a wide optional object: a document naming
 * a type the schema does not know fails on `type` with the list of what is allowed,
 * instead of parsing into a question the renderer has no branch for.
 */
export const questionSchema = z.discriminatedUnion('type', [
  textQuestionSchema,
  textareaQuestionSchema,
  numberQuestionSchema,
  dateQuestionSchema,
  emailQuestionSchema,
  phoneQuestionSchema,
  selectQuestionSchema,
  radioQuestionSchema,
  checkboxQuestionSchema,
  ratingQuestionSchema,
  infoQuestionSchema,
  addressQuestionSchema,
  matrixQuestionSchema,
  tableQuestionWithBounds,
  fileQuestionSchema,
  eventQuestionSchema,
]);
export type Question = z.infer<typeof questionSchema>;

/** A Veranstaltung question — narrowed once here rather than at every reader. */
export type EventQuestion = Extract<Question, { type: 'event' }>;

/** A Tabelle question — same reason, and what {@link tableRowLimit} reads. */
export type TableQuestion = Extract<Question, { type: 'table' }>;

/** A question that offers a fixed set of choices. */
export type ChoiceQuestion = Extract<
  Question,
  { type: 'select' | 'radio' | 'checkbox' }
>;

/**
 * The most questions **one page** may carry.
 *
 * Named rather than left as a literal because a second reader now depends on
 * it: `MAX_VALIDATION_ISSUES` (`problem.ts`) is the number of field messages a
 * 400 carries back, and „so viele Eingaben, wie eine Seite überhaupt haben
 * kann" is the reason that number is what it is. Two literals would drift, and
 * the drift would show as field markers quietly going missing.
 */
export const QUESTIONS_PER_PAGE_MAX = 200;

export const pageSchema = z.object({
  id: z.uuid(),
  title: z.string().min(1).max(LABEL_MAX),
  /**
   * A short paragraph under the page title — the BT
   * template's „Bitte geben Sie die Teilnehmeranzahl je Veranstaltung ein."
   * belongs here, not in a question's hint, because it explains the *page*
   * before any question on it is read.
   *
   * `null`, not `''`, while the builder has left it empty — the same choice
   * `hint` makes, for the same reason: a stored document says what it means,
   * and „no description" and „description of zero characters" are one state.
   *
   * **Normalised to `null` on the way out of the schema, not only in the
   * builder store** (a review finding). The web store already turned
   * `''` back into `null` on every edit, but a document that reached this
   * schema with `description: ''` by some other route — an old API
   * response replayed, a hand-built fixture, a future second caller of this
   * schema that does not share the store's habit — parsed as a **third**
   * spelling of "keine Beschreibung", indistinguishable from `null` to every
   * reader except the one comparison that is built to notice: `sameDefinition`
   * (`form-history.ts`) treats `description: ''`, `description: null` and an
   * absent key as three different documents, so a page published before this
   * finding, touched once and left empty again, reports as "etwas zu
   * veröffentlichen" though no participant would see anything different. The
   * `.transform` below is what closes that: every input the schema accepts
   * comes out as the same `string | null`, so the three spellings cannot
   * reach a comparison that tells them apart. It is *not* moved into
   * `sameDefinition` instead, because that function compares whatever shape
   * the schema hands it — fixing the shape here fixes every comparison over
   * it at once, present and future, rather than the one that was noticed.
   *
   * **`.optional()`, next to the `.nullable()`, stays — as an input-only
   * exception, not an output shape any more.** It is the same exception
   * `questionBaseShape.replaces` documents, for the same reason: every page
   * saved before this normalisation — every older document — has no such
   * key, and demanding one would turn every one of those stored documents
   * into one that no longer parses. What changes here is that the *parsed*
   * value is no longer allowed to stay absent: Zod still runs a field's
   * `.transform` when the input object omits the key (verified against this
   * project's Zod version — the transform sees `undefined` and is not
   * skipped), so the output type is `string | null`, never `| undefined`.
   * `FormPage['description']` therefore reads as "always decided", and a
   * caller can no longer write a third `?? ''` fallback that quietly accepts
   * a fourth spelling nobody chose.
   */
  description: z
    .string()
    .max(HINT_MAX)
    .nullable()
    .optional()
    .transform((value) => (value === undefined || value === '' ? null : value)),
  questions: z.array(questionSchema).max(QUESTIONS_PER_PAGE_MAX),
});
export type FormPage = z.infer<typeof pageSchema>;

/**
 * A whole form definition.
 *
 * At least one page, because a form without pages has no state the builder can
 * render or the fill-in view can show — what is required is that case to
 * be *defined*, and this is the definition: deleting the last page is refused
 * by the schema rather than left to the UI to remember.
 *
 * Question ids are unique across the **whole form**, not per page. Answers are
 * keyed by question id and pages get reordered and merged; a form where two
 * pages each own a question with the same id has answers that cannot be
 * attributed, and no later validation could repair it.
 */
export const formDefinitionSchema = z
  .object({
    pages: z.array(pageSchema).min(1).max(100),
  })
  .superRefine((definition, ctx) => {
    const seenPages = new Set<string>();
    const seenQuestions = new Set<string>();

    definition.pages.forEach((page, pageIndex) => {
      if (seenPages.has(page.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['pages', pageIndex, 'id'],
          message: 'Doppelte Seiten-ID.',
        });
      }
      seenPages.add(page.id);

      page.questions.forEach((question, questionIndex) => {
        if (seenQuestions.has(question.id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['pages', pageIndex, 'questions', questionIndex, 'id'],
            message: 'Doppelte Frage-ID.',
          });
        }
        seenQuestions.add(question.id);
      });
    });
  });
export type FormDefinition = z.infer<typeof formDefinitionSchema>;

export function parseFormDefinition(source: unknown): FormDefinition {
  return formDefinitionSchema.parse(source);
}

/** Every question of a form, in page order — the order answers are exported in. */
export function allQuestions(definition: FormDefinition): Question[] {
  return definition.pages.flatMap((page) => page.questions);
}

/**
 * The caption of a question's „Sonstiges" choice.
 *
 * Not decoration: in the Dachorganisation's own form this is „Nicht Mitglied der Dachorganisation – Name
 * der Organisation", i.e. the sentence that tells a participant what to type. The
 * fallback is the handoff's default caption.
 *
 * **Shared, because four places show that caption** — the builder preview, the
 * dropdown, the checkbox/radio list and the CSV export — and a default that
 * lives in four `?? 'Sonstiges'` drifts the moment one of them is touched. A
 * form exported with a different word than it was filled in with is a bug
 * nobody sees until the spreadsheet is read.
 */
export function otherLabelOf(question: ChoiceQuestion): string {
  return question.otherLabel ?? 'Sonstiges';
}

/**
 * A question that can carry an answer — every type except `info`.
 *
 * The `info` block is a callout, not a question: it has no
 * answer to validate, no column in the export and nothing to say in a mail.
 * „Keine Frage, keine Antwort" is therefore a rule three surfaces have to
 * apply, and {@link answerableQuestions} is the one place that states it.
 */
export type AnswerableQuestion = Exclude<Question, { type: 'info' }>;

/** Narrowing helper for {@link AnswerableQuestion} — the negative of `info`. */
export function isAnswerableQuestion(
  question: Question,
): question is AnswerableQuestion {
  return question.type !== 'info';
}

/**
 * Every question of a form that can carry an answer, in page order.
 *
 * **One function rather than a `filter` per surface**, and the drift it closes
 * was measured on 2026-07-31: the mail preview in the builder filtered `info`
 * out of `{{antworten}}` while the *sent* confirmation mail did not, so a
 * participant received a table row `Bitte pünktlich erscheinen. | ` for a
 * callout nobody was asked about — and the editor writing the template never
 * saw it. Two filters for one rule is one filter too many.
 */
export function answerableQuestions(
  definition: FormDefinition,
): AnswerableQuestion[] {
  return allQuestions(definition).filter(isAnswerableQuestion);
}

/** Narrowing helper, so callers do not repeat the three-way type test. */
export function isChoiceQuestion(
  question: Question,
): question is ChoiceQuestion {
  return (
    question.type === 'select' ||
    question.type === 'radio' ||
    question.type === 'checkbox'
  );
}
