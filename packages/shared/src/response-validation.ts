import { z } from 'zod';

import { emailAddressSchema } from './auth.ts';

// The cycle with this module is deliberate and safe — both directions are used
// inside functions only, never while a module is evaluated. The reason it is
// preferable to breaking it up is written down at the top of `condition.ts`:
// „ist ausgefüllt" and „diese Pflichtfrage ist beantwortet" are one statement,
// and this file owns it (`isBlankAnswer`).
import { visibleQuestionIds } from './condition.ts';
import { fileNameSchema, isFileRef } from './file-types.ts';
import {
  answerableQuestions,
  isAnswerableQuestion,
  tableRowLimit,
  type AnswerableQuestion,
  type ChoiceQuestion,
  type FormDefinition,
  type Question,
  type TableColumn,
  type TableQuestion,
} from './form-schema.ts';

/**
 * The answer validator, **derived** from a form definition.
 *
 * There is no second description of what an answer may look like: the rules a
 * participant is held to are read out of the same document the builder wrote
 * and the fill-in view renders. A question type added to `form-schema.ts`
 * without a branch here is a compile error, not a hole — `answerSchemaFor`
 * switches exhaustively over the union.
 *
 * The client runs this for the sake of the person filling in the form; the
 * server runs it because it is the only run that counts (`CONTRIBUTING.md`). Same
 * function, so "the client let it through" and "the server accepted it" cannot
 * come apart.
 */

/**
 * What a participant answered to one choice question.
 *
 * `values` holds **option values**, never labels — an admin renaming an option
 * must not rewrite what people already answered. `other` carries the free text
 * of the „Sonstiges" choice and is **null whenever no free text was written** —
 * the one canonical spelling of that state
 * ({@link canonicalAnswerValue}); older rows may still carry `''`, and every
 * reader here treats the two alike.
 *
 * One shape for all three choice types rather than a string for the
 * single-select ones: the export, the responses table and the detail panel
 * then have exactly one case to render, and switching a question from radio to
 * checkbox mid-life does not invalidate the answers already stored.
 */
export interface ChoiceAnswer {
  readonly values: readonly string[];
  readonly other: string | null;
}

/**
 * What a participant answered to an Adresse question.
 *
 * Four strings, never a composed one — see `form-schema.ts`'s
 * `addressQuestionSchema` for why. `country` carries exactly what was typed,
 * **never** the fallback: {@link DEFAULT_ADDRESS_COUNTRY} is applied where the
 * value is *written* (`FieldInput.tsx`'s address branch bakes it into the
 * first edit of any subfield), not read back here — so a stored answer always
 * says what a participant actually had on screen, and this type does not have
 * to guess whether an empty string means „cleared on purpose" or „never
 * touched".
 */
export interface AddressAnswer {
  readonly street: string;
  readonly zip: string;
  readonly city: string;
  readonly country: string;
}

/**
 * The fill-in view's starting value for Land — „Vorgabe, überschreibbar"
 * (decided 2026-07-31). Exported so the one client that
 * writes it (`FieldInput.tsx`) and the one that could plausibly want to show
 * it again cannot spell it two different ways.
 */
export const DEFAULT_ADDRESS_COUNTRY = 'Deutschland';

const addressAnswerObjectSchema = z.object({
  street: z.string(),
  zip: z.string(),
  city: z.string(),
  country: z.string(),
});

/**
 * Narrows an `AnswerValue` to an {@link AddressAnswer} — by **shape**, the way
 * `formatAnswerCell` already narrows a choice answer via `Array.isArray`.
 *
 * Needed because `AddressAnswer` and `ChoiceAnswer` are both plain objects and
 * `AnswerValue` carries no discriminant of its own; a value is read as one
 * shape or the other only once the *question* is known. This guard is the one
 * place that reads the shape instead — used where a value is handled before
 * (`FieldInput.tsx`) or without (`answer-columns.ts`, past the guard the
 * question already gave) its question, and safe precisely because the two
 * shapes share no key: `'street' in value` is never true for a `ChoiceAnswer`.
 *
 * **`unknown`, not `AnswerValue`**, since a review: every caller
 * either reads a JSONB column or a request body, so the parameter type was a
 * claim about the value that nothing had checked. It says nothing about what
 * is *under* `street` either — `{street: 5}` passes here, and the callers that
 * go on to treat it as a string say so themselves ({@link blankText},
 * `answer-columns.ts`).
 */
export function isAddressAnswer(value: unknown): value is AddressAnswer {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'street' in value
  );
}

/**
 * What a participant answered to a Matrix question.
 *
 * Keyed by **row value**, holding the **column values** picked in that row —
 * `{ organisation: ['sehr-gut'], programm: ['gut'] }`. Values, never labels,
 * for the reason {@link ChoiceAnswer} gives: renaming a scale step must not
 * rewrite what people already answered.
 *
 * **Always an array, even when „Mehrfachauswahl je Zeile" is off**, exactly
 * the way `ChoiceAnswer.values` is one shape for radio and checkbox alike: a
 * question switched from single to multiple mid-life would otherwise
 * invalidate every answer already stored, and the export, the table and the
 * detail panel would each need two cases instead of one. A row that was left
 * alone carries no key at all rather than an empty array — „nicht beantwortet"
 * is an absence, and writing it as `[]` would make two spellings of it.
 */
export interface MatrixAnswer {
  readonly rows: Readonly<Record<string, readonly string[]>>;
}

/**
 * One cell of a table answer.
 *
 * `true` is the only boolean: a Haken cell stores `true` or **nothing**. There
 * is deliberately no stored `false` — an unticked box is the absence of an
 * answer, the same way an unticked option is simply not in
 * `ChoiceAnswer.values`, and a second spelling of „nein" would make „blank"
 * ambiguous for both the Pflicht check and the export.
 */
export type TableCellValue = string | number | boolean;

/**
 * What a participant answered to a table question.
 *
 * One entry per row **in row order**, each keyed by column key. The array is
 * positional because the row *number* is what the export column is named after
 * (`Frage — Spalte (Zeile 2)`) and what a participant sees on screen; a record
 * keyed by row index would say the same thing in a shape that sorts
 * lexicographically („Zeile 10" before „Zeile 2").
 *
 * **Sparse on purpose:** a cell that was never filled carries no key, and a
 * trailing row that was never touched may be missing entirely. That is what
 * makes „leer" a single shape rather than a family of `''`, `null` and `false`
 * spellings.
 */
export interface TableAnswer {
  readonly cells: readonly Readonly<Record<string, TableCellValue>>[];
}

/**
 * One attachment of a file answer — **the reference and the name, never the
 * bytes** (ADR-0014).
 *
 * `ref` is the `public_ref` of the stored file (`isFileRef`); it is what a
 * submission claims (no. 13) and what the download address is built from
 * (`GET /api/responses/files/:ref`, behind the guard chain).
 *
 * `name` is a **copy** of the row's `file_name`, and it is a copy on purpose
 * rather than a second truth. The export is a pure function over stored answers
 * (`questionColumns`) and the responses table renders from the same map — both
 * are reached without a database in hand, so a name resolved at render time
 * would have to be joined in at four surfaces and would go *empty* for a row
 * the trash has since taken. What keeps the copy from drifting is that the
 * claim **checks** it: `claimAttachments` refuses a submission whose name does
 * not match the stored one, so a client may only ever repeat what the server
 * measured, never invent it.
 */
export interface FileAttachment {
  readonly ref: string;
  readonly name: string;
}

/**
 * What a participant answered to a Datei-Upload question.
 *
 * An object with one key rather than a bare array, so it has a **discriminant
 * of its own** in the shape sense the other three structured answers use:
 * `AnswerValue` carries no tag, and `structuredAnswerShape` tells the shapes
 * apart by a key none of the others has. An array would have had none — and
 * `Extract<AnswerValue, object>` would have swallowed it into the same branch
 * as every other object.
 *
 * **Ordered as the participant added them**, and the order is kept: it is what
 * they see in the fill-in view, what the detail panel lists and what the export
 * cell joins.
 */
export interface FileAnswer {
  readonly files: readonly FileAttachment[];
}

/**
 * What a participant answered to a Veranstaltung question.
 *
 * **A number per event — the Personenzahl, not a tick** . Keyed by
 * `EventEntry.key`, never by label and never by index: the key is what the
 * `event_registration` row, the export column and the refusal position all name,
 * and a renamed Veranstaltung must not move somebody's three seats onto another
 * one.
 *
 * **Sparse, and only positive numbers are in it.** „Wir kommen nicht" is the
 * *absence* of a key, not a stored `0` — the one spelling of that state, kept
 * that way by {@link canonicalAnswerValue}, which drops an entry a fill-in view
 * sent as `0` or `''` before anything reads it. Without that rule this type
 * would arrive in the column written two ways within a week of shipping the
 * number boxes, which is the double form the canonicalisation rule has just
 * finished removing for „Sonstiges".
 */
export interface EventAnswer {
  readonly seats: Readonly<Record<string, number>>;
}

/** Narrows an `AnswerValue` to an {@link EventAnswer} — `seats` is its own key. */
export function isEventAnswer(value: unknown): value is EventAnswer {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'seats' in value
  );
}

/**
 * The seat counts of a value that is supposed to be an {@link EventAnswer} —
 * **tolerantly**, and only the entries that are readable.
 *
 * The guard above narrows by the presence of one key, never by what is under it
 * (the rule every `is…Answer` in this file states), so `{seats: 5}` and
 * `{seats: {a: 'x'}}` both reach here. Both read as „keine Anmeldung" rather
 * than throwing, for the reason {@link attachmentsOf} gives: the callers are the
 * responses table, the export and the seat bookkeeping, and one damaged row must
 * not take a whole evaluation — or a whole registration — down.
 *
 * A non-positive number is dropped as well, so a row written before
 * {@link canonicalAnswerValue} (or by hand) cannot make an event look answered
 * with zero people.
 */
export function seatsOf(value: unknown): [string, number][] {
  if (!isEventAnswer(value)) {
    return [];
  }
  const seats: unknown = value.seats;
  if (typeof seats !== 'object' || seats === null || Array.isArray(seats)) {
    return [];
  }
  return Object.entries(seats as Record<string, unknown>).filter(
    (entry): entry is [string, number] =>
      typeof entry[1] === 'number' &&
      Number.isInteger(entry[1]) &&
      entry[1] > 0,
  );
}

/** Narrows an `AnswerValue` to a {@link FileAnswer} — `files` is its own key. */
export function isFileAnswer(value: unknown): value is FileAnswer {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'files' in value
  );
}

/**
 * The attachments of a value that is supposed to be a {@link FileAnswer} —
 * **tolerantly**, and only the entries that are readable.
 *
 * The guard above narrows by the presence of one key, never by what is under
 * it (the rule every `is…Answer` in this file states), so `{files: 5}` and
 * `{files: [{ref: 5}]}` both reach here. Both read as „keine Anhänge" rather
 * than throwing: the callers are the responses table, the detail panel and the
 * export, and one damaged row must not take a whole evaluation down — the very
 * failure `textOf` was introduced for in `answer-columns.ts`.
 */
export function attachmentsOf(value: unknown): FileAttachment[] {
  if (!isFileAnswer(value) || !Array.isArray(value.files)) {
    return [];
  }
  return value.files.filter(
    (entry: unknown): entry is FileAttachment =>
      typeof entry === 'object' &&
      entry !== null &&
      'ref' in entry &&
      'name' in entry &&
      typeof (entry as { ref: unknown }).ref === 'string' &&
      typeof (entry as { name: unknown }).name === 'string',
  );
}

/**
 * Narrows an `AnswerValue` to a {@link MatrixAnswer} — by shape, like
 * {@link isAddressAnswer}, and sound for the same reason: `rows` is a key no
 * other answer shape carries.
 */
export function isMatrixAnswer(value: unknown): value is MatrixAnswer {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'rows' in value
  );
}

/** Narrows an `AnswerValue` to a {@link TableAnswer} — `cells` is its own key. */
export function isTableAnswer(value: unknown): value is TableAnswer {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'cells' in value
  );
}

/**
 * Narrows an `AnswerValue` to a {@link ChoiceAnswer} — `values` is its key.
 *
 * The **weakest** of the four shape guards, and the one place that says so: a
 * document carrying `values` plus keys of its own passes here too. It is used
 * where the alternative is a property access on foreign JSONB, never as proof
 * that a value is *only* a choice answer — {@link structuredAnswerShape} is
 * where that question is answered, under a lock.
 */
export function isChoiceAnswer(value: unknown): value is ChoiceAnswer {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'values' in value
  );
}

export type AnswerValue =
  | string
  | number
  | ChoiceAnswer
  | AddressAnswer
  | MatrixAnswer
  | TableAnswer
  | FileAnswer
  | EventAnswer
  | null;

/**
 * The **object** shapes an answer may take — everything in `AnswerValue` that
 * is not a scalar and not `null`.
 *
 * Derived from the union rather than written out a second time, so it cannot
 * fall behind it; {@link StructuredAnswer} is what the tag list below is held
 * against.
 */
export type StructuredAnswer = Extract<AnswerValue, object>;

/**
 * One structured answer **with its shape named** — the discriminant
 * `AnswerValue` cannot carry.
 *
 * A stored answer has no `kind` field and must not grow one: it is JSONB that
 * has already been written by earlier versions, and a discriminant on the wire
 * would have to be migrated into every document ever stored. The tag is
 * therefore minted on the way *out* of {@link structuredAnswerShape}, and it is
 * what a `switch` can be exhaustive over.
 */
export type ShapedAnswer =
  | { readonly kind: 'choice'; readonly value: ChoiceAnswer }
  | { readonly kind: 'address'; readonly value: AddressAnswer }
  | { readonly kind: 'matrix'; readonly value: MatrixAnswer }
  | { readonly kind: 'table'; readonly value: TableAnswer }
  | { readonly kind: 'file'; readonly value: FileAnswer }
  | { readonly kind: 'event'; readonly value: EventAnswer };

/**
 * True exactly when `X` and `Y` are the **same** type — not merely assignable
 * to one another.
 *
 * The deferred-conditional trick rather than a pair of `extends` checks,
 * because assignability is what the lock below must *not* be built on: an
 * answer shape with `values`, `other` **and** a further key is assignable to
 * `ChoiceAnswer` in both directions of the naive test, which is precisely how a
 * new shape would slip past unnoticed.
 *
 * `T` looks unused to `no-unnecessary-type-parameters` and is the whole
 * mechanism: the two function types are compared **unresolved**, and that
 * comparison is by type identity rather than by assignability. Removing `T`
 * removes exactly the property this file needs.
 */
type Identical<X, Y> =
  /* eslint-disable @typescript-eslint/no-unnecessary-type-parameters */
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
/* eslint-enable @typescript-eslint/no-unnecessary-type-parameters */

/**
 * **The lock** (a review finding, measured 2026-07-31).
 *
 * `toStoredAnswers` on the public write path used to end in a shape test —
 * `'values' in value` — followed by a `never`. That reads as exhaustive and is
 * not: a future shape carrying `values` *and* extra keys — exactly what the
 * Veranstaltung feature needs (gewählte Termine plus Personenzahl) —
 * satisfies the test, compiles green, and loses its extra keys silently on the
 * way into JSONB. The `never` only ever caught shapes **without** `values`.
 *
 * A member added to `AnswerValue` without a tag in {@link ShapedAnswer} fails
 * **here**, in the file that owns the union, before any caller is compiled. The
 * new tag then makes every `switch (shape.kind)` incomplete — which is where
 * the write path notices.
 */
type EveryStructuredAnswerIsTagged<Same extends true> = Same;
export type StructuredAnswerTagLock = EveryStructuredAnswerIsTagged<
  Identical<StructuredAnswer, ShapedAnswer['value']>
>;

/**
 * Names the shape of one structured answer, so callers can `switch` instead of
 * asking `'…' in value` and hoping the list is complete.
 *
 * The **runtime** test is still by key, and it can be no other way while the
 * stored document carries no discriminant. What changed is where the
 * incompleteness surfaces: the tag list is pinned to the union by
 * {@link StructuredAnswerTagLock} above, so a new shape cannot arrive without
 * this function's `switch`-consumers going red.
 */
export function structuredAnswerShape(value: StructuredAnswer): ShapedAnswer {
  if (isAddressAnswer(value)) {
    return { kind: 'address', value };
  }
  if (isMatrixAnswer(value)) {
    return { kind: 'matrix', value };
  }
  if (isTableAnswer(value)) {
    return { kind: 'table', value };
  }
  if (isFileAnswer(value)) {
    return { kind: 'file', value };
  }
  if (isEventAnswer(value)) {
    return { kind: 'event', value };
  }
  return { kind: 'choice', value };
}

/** Answers of one submission, keyed by question id. */
export type AnswerMap = Record<string, AnswerValue | undefined>;

/**
 * Tolerant on purpose: German numbers are written with spaces, slashes and a
 * leading `+`, and an organisation's secretary typing `+49 (0)711 / 123-45` is not an
 * error to be corrected by software. The check is a shape, not a plausibility
 * claim about the number reaching anyone.
 */
const PHONE_ALLOWED = /^[+()/\s.\-\d]+$/u;
const PHONE_MIN_DIGITS = 3;
const PHONE_MAX = 40;

/** Longest free text accepted for a „Sonstiges" answer. */
const OTHER_MAX = 300;

const choiceAnswerObjectSchema = z.object({
  values: z.array(z.string().min(1).max(300)).max(500),
  other: z.string().max(OTHER_MAX).nullable(),
});

const matrixAnswerObjectSchema = z.object({
  rows: z.record(z.string(), z.array(z.string().min(1).max(300)).max(500)),
});

/**
 * A cell as it may be **stored** — deliberately wider than what may be
 * *written*: a Haken only ever stores `true` ({@link TableCellValue}), but a
 * `false` that a previous version left in the column has to stay readable
 * (the same tolerance {@link answerValueSchema} exists for).
 */
const tableCellValueSchema = z.union([z.string(), z.number(), z.boolean()]);

const tableAnswerObjectSchema = z.object({
  cells: z.array(z.record(z.string(), tableCellValueSchema)),
});

/**
 * The **shape** of a file answer, without the rules of the question it belongs
 * to — no `maxFiles`, no reference spelling, no name rules.
 *
 * Weak on purpose, like every other member of {@link answerValueSchema}: this
 * is the schema the *edit* view reads a stored answer back through, and holding
 * a stored attachment to today's rules would empty the form the participant
 * came to correct. The rules live on {@link fileAnswerSchema}, which is what
 * every **write** goes through.
 */
const fileAnswerObjectSchema = z.object({
  files: z.array(z.object({ ref: z.string(), name: z.string() })),
});

/**
 * The **shape** of a Veranstaltung answer, without the rules of the question it
 * belongs to — no known-key check, no bound.
 *
 * Weak on purpose, like every other member of {@link answerValueSchema} and for
 * the reason stated there: this is what the edit view reads a *stored* answer
 * back through, and holding a registration taken last month to a Veranstaltung
 * list that has since been reworked would empty the form its participant came to
 * correct.
 */
const eventAnswerObjectSchema = z.object({
  seats: z.record(z.string(), z.number()),
});

/**
 * The **shape** one stored answer may have — `AnswerValue` as a schema, without
 * any of the rules the question it belongs to imposes.
 *
 * Deliberately weaker than {@link safeParseAnswers}, and it exists for the one
 * case that one cannot serve: rendering a *stored* answer whose snapshot the
 * validator has since become stricter about (the edit view).
 * Holding those answers to today's rules would empty the form the participant
 * came to correct; handing them on unchecked would let whatever sits in the
 * JSONB column reach a `<input value=…>`. This is the middle: a value is either
 * a string, a number, a choice answer or null, or it is not shown.
 *
 * It is a schema rather than a hand-written type guard so that `AnswerValue`
 * and the thing that recognises it cannot drift — the union is written once,
 * here, and `z.infer` is checked against it in the tests.
 */
export const answerValueSchema = z.union([
  z.string(),
  z.number(),
  choiceAnswerObjectSchema,
  addressAnswerObjectSchema,
  matrixAnswerObjectSchema,
  tableAnswerObjectSchema,
  fileAnswerObjectSchema,
  eventAnswerObjectSchema,
  z.null(),
]);

function textAnswerSchema(question: Question & { type: 'text' | 'textarea' }) {
  let schema = z.string();
  if (question.minLength !== null) {
    schema = schema.min(question.minLength, {
      error: `Mindestens ${String(question.minLength)} Zeichen.`,
    });
  }
  if (question.maxLength !== null) {
    schema = schema.max(question.maxLength, {
      error: `Höchstens ${String(question.maxLength)} Zeichen.`,
    });
  }
  if (question.type === 'text' && question.pattern !== null) {
    // Compiled here, and only here: `form-schema.ts` proved it compiles when
    // the form was saved, so this cannot throw on a stored definition.
    schema = schema.regex(new RegExp(question.pattern, 'u'), {
      error: 'Eingabe entspricht nicht dem geforderten Muster.',
    });
  }
  return schema;
}

/**
 * A rating answer: a whole star count, never below 1 and never above the
 * question's own `max`.
 *
 * **`0` does not exist as an answer.** A rating has no "zero stars" click in
 * the fill-in view (`FieldInput.tsx` only ever calls `onChange` with `i + 1`),
 * so `min(1)` is not a stricter rule than the control offers — it is the same
 * rule, stated where the server can enforce it against a payload that skipped
 * the control entirely. "No value" is `blankSchemaFor`'s job, not this one's.
 *
 * The upper bound is read from **this question**, not a fixed 5 or 10: two
 * versions of the same question can carry different `max` values, and an
 * answer is only ever validated against the version it was given to
 * (`buildAnswersSchema` is built fresh per `FormDefinition`).
 */
function ratingAnswerSchema(question: Question & { type: 'rating' }) {
  return z
    .number()
    .int()
    .min(1)
    .max(question.max, {
      error: `Höchstens ${String(question.max)} Sterne.`,
    });
}

/** Longest a single Adresse subfield may be — same bound `OTHER_MAX` uses, for the same reason. */
const ADDRESS_FIELD_MAX = 300;

/**
 * One subfield of an Adresse answer, trimmed — and required exactly when the
 * caller says so.
 */
function addressFieldSchema(required: boolean): z.ZodString {
  const schema = z.string().trim().max(ADDRESS_FIELD_MAX);
  return required ? schema.min(1, { error: 'Pflichtfeld.' }) : schema;
}

/**
 * An Adresse answer: four subfields, three of them required exactly when the
 * question is.
 *
 * **Straße, PLZ and Ort — not Land.** The bound is taken from `question.
 * required` directly rather than from the surrounding `required`/`blank`
 * union `buildAnswersSchema` builds for every other type: there the union
 * decides *whether an answer is needed at all*, and once one is given every
 * type's „filled" schema applies the same rules regardless of that flag. An
 * Adresse is the first type where the flag has to reach *inside* the answer —
 * three of its four parts inherit „required", the fourth never does — so this
 * function reads it from the question instead of only from the caller's
 * blank/filled fork. That also makes a **partially filled Pflicht-Adresse
 * fail here**, with a field-specific message per empty subfield, rather than
 * only at the coarser „Pflichtfeld" the blank check gives an entirely
 * untouched one.
 *
 * **And that is exactly why `enforceRequired` has to reach in here too**
 * (a review finding). The flag that takes the Pflicht rule out of a
 * draft sits on the blank/filled fork in {@link fieldSchemaFor}, and a
 * half-typed Adresse is not blank — so it went straight past the fork into this
 * schema and was refused there. *Measured on 2026-08-05:* `POST …/drafts` with
 * `{street: "Hauptstraße 1"}` on a Pflicht-Adresse answered **400** with `zip:
 * Pflichtfeld., city: Pflichtfeld.`, i.e. the one request that saves somebody's
 * typing was the one it refused. „Pflicht" is one rule; it is dropped in one
 * place or in none.
 */
function addressAnswerSchema(
  question: Question & { type: 'address' },
  enforceRequired: boolean,
) {
  const required = question.required && enforceRequired;
  return z.object({
    street: addressFieldSchema(required),
    zip: addressFieldSchema(required),
    city: addressFieldSchema(required),
    // Default „Deutschland", overwritable — but never *required*: the
    // handoff's decision names exactly Straße, PLZ and Ort as Pflicht.
    country: addressFieldSchema(false),
  });
}

/**
 * The machine-readable reason a write was refused for naming a Matrix row the
 * question does not have.
 *
 * Same job as {@link TABLE_ROW_LIMIT_CODE}: `path` names the field
 * (`<frageId>.rows.<zeile>`), this names the rule, and a caller can tell
 * „unbekannte Zeile" from „unbekannte Option" without reading a German
 * sentence. It travels as `params.code` and reaches the wire through
 * `ValidationIssue.code`.
 */
export const MATRIX_UNKNOWN_ROW_CODE = 'matrix_unknown_row';

/**
 * **Every row key of a Matrix answer names a row this question has** — in one
 * place, and called from **two**, exactly like {@link checkRowCount}:
 *
 * - {@link preUnionGuardFor}, in front of the blank/filled union — the one that
 *   makes it a rule of the *request*. Until this it was a rule of the *filled*
 *   schema alone, and `{rows: {irgendwas: []}}` is a perfectly good **blank**
 *   Matrix answer: measured on 2026-08-07, a Matrix with one row accepted 5000
 *   invented row keys on the optional path and on the draft path (a Pflicht-
 *   Matrix included, because `enforceRequired: false` takes it down the very
 *   same branch), and **stored every one of them** — 9404 keys and 102 344
 *   bytes at the real transport bound, or a single key 90 000 characters long.
 * - {@link matrixAnswerSchema}, the filled schema itself, which the fill-in view
 *   parses field by field through `answerSchemaFor` to mark one input.
 *
 * ## Why this is a Datenschutz rule and not a size rule
 *
 * `questionColumns` plans a Matrix's columns from `question.rows` alone, so a
 * row nobody defined appears **neither in the responses table nor in the
 * export**. Whatever a stranger writes into such a key is stored, invisible,
 * and therefore not deletable by anybody who would want to delete it — which is
 * the DSGVO promise itself („endgültiges Löschen ist physisches Löschen") broken
 * at the entrance rather than at the exit. Refusing is the only answer that
 * keeps it: dropping the key silently would store nothing but would also let a
 * client believe an answer was taken.
 *
 * Returns whether every key was known, so the caller in front of the union can
 * stop rather than hand the value on to a union that will complain about it a
 * second time in a shape the wire cannot carry.
 */
function checkKnownRows(
  question: Question & { type: 'matrix' },
  rows: Record<string, unknown>,
  ctx: z.RefinementCtx,
): boolean {
  const known = new Set(question.rows.map((row) => row.value));
  let ok = true;
  for (const key of Object.keys(rows)) {
    if (known.has(key)) {
      continue;
    }
    ctx.addIssue({
      code: 'custom',
      path: ['rows', key],
      message: 'Unbekannte Zeile.',
      params: { code: MATRIX_UNKNOWN_ROW_CODE },
    });
    ok = false;
  }
  return ok;
}

/**
 * A Matrix answer, checked against the rows and the scale of *this* question —
 * and against the Pflicht rule that belongs to this type.
 *
 * **Pflicht means: every row is answered.** The rule sits here, on the
 * schema, and not in the fill-in view, because the fill-in view is UX and this
 * is the run that counts (`CONTRIBUTING.md`). The reason it is „alle" and not
 * „mindestens eine" is what the export does with the answer: `questionColumns`
 * gives **every row its own column** , so every row is a question
 * in its own right — a Matrix answered in one of twelve rows would fill one
 * column and leave eleven blank, in a file whose reader has no way to tell
 * „wurde nicht gefragt" from „wurde nicht beantwortet". An editor who wants
 * single rows to be optional splits them into single-choice questions, which
 * is exactly what a Matrix is a compression of.
 *
 * An unknown row or scale value is **rejected, not dropped** — the same
 * decision `choiceAnswerSchema` documents, for the same reason. The row half of
 * that promise is {@link checkKnownRows}, and it is stated **twice** for the
 * reason {@link checkRowCount} is: this schema is only one of the two doors an
 * answer can come through.
 *
 * `enforceRequired` reaches in for the reason {@link addressAnswerSchema}
 * spells out: a Matrix with one row ticked is not blank, so a draft of one used
 * to be refused with „Bitte ‚…' beantworten" for every row still open —
 * *measured on 2026-08-05* on a Pflicht-Matrix with two rows, of which
 * one was answered.
 */
function matrixAnswerSchema(
  question: Question & { type: 'matrix' },
  enforceRequired: boolean,
) {
  const knownRows = new Map(question.rows.map((row) => [row.value, row]));
  const knownColumns = new Set(question.columns.map((column) => column.value));

  return matrixAnswerObjectSchema.superRefine((answer, ctx) => {
    checkKnownRows(question, answer.rows, ctx);

    for (const [rowValue, picked] of Object.entries(answer.rows)) {
      if (!knownRows.has(rowValue)) {
        continue;
      }

      for (const [index, value] of picked.entries()) {
        if (!knownColumns.has(value)) {
          ctx.addIssue({
            code: 'custom',
            path: ['rows', rowValue, index],
            message: 'Unbekannte Option.',
          });
        }
      }

      if (new Set(picked).size !== picked.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['rows', rowValue],
          message: 'Doppelte Auswahl.',
        });
      }

      if (!question.multiple && picked.length > 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['rows', rowValue],
          message: 'Nur eine Auswahl je Zeile möglich.',
        });
      }
    }

    if (!question.required || !enforceRequired) {
      return;
    }
    for (const row of question.rows) {
      if ((answer.rows[row.value] ?? []).length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['rows', row.value],
          message: `Bitte „${row.label}" beantworten.`,
        });
      }
    }
  });
}

/** Longest a single table text cell may be — the bound `OTHER_MAX` uses. */
const TABLE_CELL_MAX = 300;

/**
 * The machine-readable reason a submission was refused for carrying too many
 * table rows.
 *
 * The 400 already names the **field** (`path` = `<frageId>.cells`); this names
 * the **rule**, so a caller can tell „zu viele Zeilen" from „unbekannte Spalte"
 * without reading a German sentence and without matching on one. It travels as
 * `params.code` of the Zod issue and reaches the wire through
 * `ValidationIssue.code` (`problem.ts`) — the client keeps working when it
 * ignores it, which is why it is added rather than substituted.
 */
export const TABLE_ROW_LIMIT_CODE = 'table_row_limit';

/**
 * **The row bound of one table answer, in one place.**
 *
 * Called from **two** places, and neither is redundant:
 *
 * - {@link preUnionGuardFor}, in front of the blank/filled union — the one that
 *   makes it a rule of the *request*. Until this package the bound sat in the
 *   filled schema alone, and `{cells: [{}, {}, …]}` is a perfectly good *blank*
 *   answer: measured on 2026-08-06, a table with two rows accepted **5000**
 *   empty rows on the optional path and on the draft path, because a blank
 *   answer never reaches the filled schema at all.
 * - {@link tableAnswerSchema}, the filled schema itself, which the fill-in view
 *   parses **field by field** through `answerSchemaFor` to mark one input. A
 *   bound the client cannot see would let it offer a row the server then
 *   refuses.
 *   ⚠️ **And it is the only server-side bound a *Pflicht* table has**: the
 *   Pflicht branch of {@link fieldSchemaFor} returns before the pre-union hook
 *   is ever reached, so for a required table this call is not the client's
 *   copy of the rule — it *is* the rule. Removing it leaves 1362 shared tests
 *   green (measured on 2026-08-07); the case that turns red is „refuses more
 *   rows than a **Pflicht**-Tabelle offers" in `response-validation.test.ts`.
 *
 * The limit itself is `tableRowLimit`, never `question.rows`: with „Zeilen
 * ergänzbar" the two differ, and reading the wrong one refuses exactly the rows
 * the form invited a participant to add.
 *
 * Returns whether the count was acceptable, so a caller can stop rather than
 * report „zu viele Zeilen" and a second, derived complaint about the same
 * answer.
 */
function checkRowCount(
  question: TableQuestion,
  rows: number,
  ctx: z.RefinementCtx,
): boolean {
  const limit = tableRowLimit(question);
  if (rows <= limit) {
    return true;
  }
  ctx.addIssue({
    code: 'custom',
    path: ['cells'],
    message: `Höchstens ${String(limit)} Zeilen.`,
    params: { code: TABLE_ROW_LIMIT_CODE },
  });
  return false;
}

/**
 * One cell, checked against the type of **its own column** .
 *
 * The guard the export gives that column (`questionColumns`) and the rule that
 * decides what may be stored in it are two halves of one statement, so the
 * column type decides both — a Zahl column that accepted „vier" would produce
 * a `'number'`-guarded cell whose content is free text.
 */
function checkTableCell(
  column: TableColumn,
  value: TableCellValue,
  ctx: z.RefinementCtx,
  path: (string | number)[],
): void {
  const reject = (message: string): void => {
    ctx.addIssue({ code: 'custom', path, message });
  };

  switch (column.type) {
    case 'text':
      if (typeof value !== 'string') {
        reject('Bitte Text eingeben.');
      } else if (value.length > TABLE_CELL_MAX) {
        reject(`Höchstens ${String(TABLE_CELL_MAX)} Zeichen.`);
      }
      return;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        reject('Bitte eine Zahl eingeben.');
      }
      return;
    case 'select':
      if (typeof value !== 'string') {
        reject('Unbekannte Option.');
      } else if (
        value !== '' &&
        !column.options.some((option) => option.value === value)
      ) {
        reject('Unbekannte Option.');
      }
      return;
    case 'checkbox':
      // `true` or nothing — see {@link TableCellValue}. A stored `false` is
      // refused rather than accepted and ignored, so „leer" keeps one spelling.
      if (value !== true) {
        reject('Ein Haken ist gesetzt oder gar nicht vorhanden.');
      }
      return;
  }

  const unhandled: never = column;
  throw new Error(
    `checkTableCell: unbekannte Spaltenart ${JSON.stringify(unhandled)}`,
  );
}

/**
 * A table answer: cells checked per column, rows bounded by what the form
 * **accepts** ({@link checkRowCount}) — and the Pflicht rule of *this* type.
 *
 * **Pflicht means: at least one row is filled in** — deliberately the
 * opposite of the Matrix above, and the pair is the point. A Matrix's rows are
 * statements the form *asked about*; a table's row count is what the form
 * *offers*. „Begleitpersonen" with three rows demanding three filled rows
 * would refuse the submission of everyone who brings one, and no editor
 * setting could express „bis zu drei" any more. Requiring one filled row keeps
 * the Pflicht flag meaningful („ohne Begleitperson kein Absenden" is not what
 * it says — „ohne *Angabe* kein Absenden" is).
 *
 * A row is „ausgefüllt" when any of its cells is; a *partly* filled row is
 * accepted, because which of several columns matters is the editor's business
 * and there is no per-column Pflicht in the handoff to read it from.
 *
 * `enforceRequired` reaches in for the reason {@link addressAnswerSchema}
 * spells out. The path here is one step longer and led to the same 400: the
 * *blank* schema of a table is „Zeilen ohne einen einzigen Schlüssel"
 * (`blankSchemaFor`), so a draft carrying the shape a fill-in view produces
 * after a cell was typed and cleared again — `{cells: [{c: ""}]}` — matches
 * neither the blank branch nor, under the Pflicht rule, the filled one.
 * *Measured on 2026-08-05:* 400 with `cells: Bitte mindestens eine Zeile
 * ausfüllen.`
 */
function tableAnswerSchema(question: TableQuestion, enforceRequired: boolean) {
  const columns = new Map(
    question.columns.map((column) => [column.key, column]),
  );

  return tableAnswerObjectSchema.superRefine((answer, ctx) => {
    checkRowCount(question, answer.cells.length, ctx);

    answer.cells.forEach((row, index) => {
      for (const [key, value] of Object.entries(row)) {
        const column = columns.get(key);
        if (column === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['cells', index, key],
            message: 'Unbekannte Spalte.',
          });
          continue;
        }
        checkTableCell(column, value, ctx, ['cells', index, key]);
      }
    });

    if (question.required && enforceRequired && isBlankTable(answer)) {
      ctx.addIssue({
        code: 'custom',
        path: ['cells'],
        message: 'Bitte mindestens eine Zeile ausfüllen.',
      });
    }
  });
}

/**
 * True while no cell of the table carries anything (see {@link isBlankAnswer}).
 *
 * `Array.isArray` and {@link objectValues} rather than a direct `.every`: this
 * runs on the **raw payload** of a required question, where `cells` is whatever
 * the request carried — see {@link blankText} for the 500 that cost.
 */
function isBlankTable(answer: TableAnswer): boolean {
  return (
    Array.isArray(answer.cells) &&
    answer.cells.every((row) =>
      objectValues(row).every((cell) => isBlankTableCell(cell)),
    )
  );
}

/**
 * One cell read as „nichts eingetragen".
 *
 * `false` counts as blank — and that is not a leftover: a Haken cell never
 * *stores* `false` ({@link TableCellValue}), so a `false` reaching here came
 * from a payload that skipped the control. Reading it as an answer would let a
 * Pflicht table be satisfied by ticking a box and unticking it again.
 * Whitespace goes the way it goes everywhere else in this file.
 */
function isBlankTableCell(cell: unknown): boolean {
  if (typeof cell === 'string') {
    return cell.trim() === '';
  }
  if (typeof cell === 'boolean') {
    return !cell;
  }
  // A number is an answer (zero included), and anything else came from a
  // payload the validator has not seen yet — „nicht leer", so the filled
  // schema gets to refuse it.
  return false;
}

/**
 * A file answer, checked against **this** question.
 *
 * Three rules, and none of them is the one that matters most:
 *
 * - **`maxFiles`**, read from this version of this question, exactly the way
 *   `ratingAnswerSchema` reads `max` — an answer is only ever validated against
 *   the version it was given to.
 * - **The reference has the shape of one** (`isFileRef`). Bounded and spelled
 *   before it reaches the claim, for the reason `isPublicSlug` carries: `%00`
 *   arrives decoded as a NUL byte, PostgreSQL refuses U+0000 in `text`, and the
 *   query throws — a 500 where every unknown reference answers the same
 *   refusal.
 * - **The name is a name** (`fileNameSchema`) — the same schema the upload held
 *   it to, so the copy in the answer cannot carry something the row could not.
 *   It normalises to NFC, which is what makes „is this the stored name?"
 *   comparable at all.
 *
 * **What this schema deliberately cannot say: whether the file exists, is this
 * organisation's, is this form's, or is still free.** All four are the claim's five
 * conditions (ADR-0014 no. 13), enforced in the transaction that writes the
 * answer, and a check here would be a second opinion that is stale the moment
 * it is given. This schema is the *spelling*; the claim is the *authority*.
 */
function fileAnswerSchema(question: Question & { type: 'file' }) {
  return z.object({
    files: z
      .array(
        z.object({
          ref: z.string().refine(isFileRef, {
            error: 'Kein gültiger Verweis auf eine hochgeladene Datei.',
          }),
          name: fileNameSchema,
        }),
      )
      .max(question.maxFiles, {
        error:
          question.maxFiles === 1
            ? 'Höchstens eine Datei.'
            : `Höchstens ${String(question.maxFiles)} Dateien.`,
      })
      .refine(
        (files) => new Set(files.map((file) => file.ref)).size === files.length,
        // The claim refuses a duplicate as well (it de-duplicates and then
        // finds a length mismatch), but it answers with the one opaque
        // „Anhang nicht verfügbar" for all five of its conditions. Said here,
        // where the answer can still name the field it happened in.
        { error: 'Dieselbe Datei ist mehrfach angehängt.' },
      ),
  });
}

/**
 * The most people **one answer** may register for **one** Veranstaltung.
 *
 * Not the Obergrenze — that is per event and lives in the definition
 * (`eventEntrySchema.capacity`). This is the bound on a single number a stranger
 * may put in the box: an organisation brings a delegation, not a stadium, and without a
 * bound one submission could occupy an event's whole capacity by typo and the
 * refusal a hundred others then get would be correct and useless.
 */
export const EVENT_SEATS_MAX = 1000;

/**
 * A Veranstaltung answer, checked against the events of *this* question and
 * against the Pflicht rule of this type.
 *
 * **What this schema deliberately cannot say: whether a seat is still free.**
 * That is the sum over every non-deleted answer of the form, taken behind
 * `SELECT … FOR UPDATE` in the transaction that writes the answer — a check here would be a second opinion, stale the moment it is given,
 * and it would answer 400 („Ihre Eingabe ist falsch") for a state the
 * participant did nothing wrong to reach. This schema is the *spelling*; the
 * transaction is the *authority*. The same division `fileAnswerSchema` makes
 * between itself and the claim.
 *
 * **Pflicht means: at least one Veranstaltung carries a number** —
 * the Tabelle's rule (`tableAnswerSchema`) rather than the Matrix's, and for the
 * Tabelle's reason: the list of events is what the form *offers*, not what it
 * demands. „Jede Veranstaltung" would force everyone who attends the Sommerfest
 * to the Stadtfest as well.
 *
 * An unknown event key is **rejected, not dropped** — the decision
 * `choiceAnswerSchema` documents: the difference between „hat sich für nichts
 * angemeldet" and „hat sich für etwas angemeldet, das wir weggeworfen haben" is
 * exactly what a Teilnehmerliste must not blur.
 *
 * **`enforceRequired` is threaded in although this type was the one of the four
 * composites the draft never tripped over** (a review finding):
 * „keine Veranstaltung genannt" *is* the blank shape here
 * ({@link isBlankAnswer}, {@link blankSchemaFor}), so the check below cannot
 * fire on the filled branch at all. It reads the flag all the same, because
 * „Pflicht wird im Entwurf nicht geprüft" is one rule, and three spellings of it
 * plus one exception is how the fourth becomes wrong the day a blank shape
 * changes.
 */
function eventAnswerSchema(
  question: Question & { type: 'event' },
  enforceRequired: boolean,
) {
  const known = new Map(question.events.map((event) => [event.key, event]));

  return z
    .object({
      seats: z.record(
        z.string(),
        z
          .number()
          .int({ error: 'Bitte eine ganze Zahl an Personen angeben.' })
          // `0` is not an answer, it is the absence of one — and
          // `canonicalAnswerValue` has already removed every entry that said so
          // before this schema sees the document. A `0` reaching here therefore
          // came from something other than a fill-in view, and saying so is
          // better than storing a second spelling of „nicht angemeldet".
          .min(1, { error: 'Mindestens eine Person, sonst bitte leer lassen.' })
          .max(EVENT_SEATS_MAX, {
            error: `Höchstens ${String(EVENT_SEATS_MAX)} Personen je Veranstaltung.`,
          }),
      ),
    })
    .superRefine((answer, ctx) => {
      for (const key of Object.keys(answer.seats)) {
        if (!known.has(key)) {
          ctx.addIssue({
            code: 'custom',
            path: ['seats', key],
            message: 'Unbekannte Veranstaltung.',
          });
        }
      }

      if (
        question.required &&
        enforceRequired &&
        Object.keys(answer.seats).length === 0
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['seats'],
          message: 'Bitte mindestens eine Veranstaltung angeben.',
        });
      }
    });
}

function numberAnswerSchema(question: Question & { type: 'number' }) {
  let schema = question.integer
    ? z.number().int({ error: 'Bitte eine ganze Zahl angeben.' })
    : z.number();
  if (question.min !== null) {
    schema = schema.min(question.min, {
      error: `Mindestens ${String(question.min)}.`,
    });
  }
  if (question.max !== null) {
    schema = schema.max(question.max, {
      error: `Höchstens ${String(question.max)}.`,
    });
  }
  return schema;
}

function dateAnswerSchema(question: Question & { type: 'date' }) {
  return z.iso.date().superRefine((value, ctx) => {
    // Lexicographic order is the calendar order for `YYYY-MM-DD`; the format
    // is pinned in `form-schema.ts` precisely so this comparison is sound.
    if (question.minDate !== null && value < question.minDate) {
      ctx.addIssue({
        code: 'custom',
        message: `Nicht vor dem ${question.minDate}.`,
      });
    }
    if (question.maxDate !== null && value > question.maxDate) {
      ctx.addIssue({
        code: 'custom',
        message: `Nicht nach dem ${question.maxDate}.`,
      });
    }
  });
}

/**
 * Choice answers, checked against the option list of *this* question.
 *
 * An unknown option value is rejected rather than dropped. Dropping would turn
 * a manipulated payload into a quietly incomplete answer — and the difference
 * between "chose nothing" and "chose something we discarded" is exactly what a
 * Teilnehmerliste must not blur.
 */
function choiceAnswerSchema(question: ChoiceQuestion) {
  const allowed = new Set(question.options.map((option) => option.value));
  const single = question.type !== 'checkbox';

  return choiceAnswerObjectSchema.superRefine((answer, ctx) => {
    for (const [index, value] of answer.values.entries()) {
      if (!allowed.has(value)) {
        ctx.addIssue({
          code: 'custom',
          path: ['values', index],
          message: 'Unbekannte Option.',
        });
      }
    }

    const duplicates = new Set(answer.values).size !== answer.values.length;
    if (duplicates) {
      ctx.addIssue({
        code: 'custom',
        path: ['values'],
        message: 'Doppelte Auswahl.',
      });
    }

    if (answer.other !== null && !question.allowOther) {
      ctx.addIssue({
        code: 'custom',
        path: ['other'],
        message: 'Für diese Frage ist „Sonstiges" nicht vorgesehen.',
      });
    }

    // „Sonstiges" counts as one selection, which is what makes the bounds
    // below mean the same thing to a participant as to the builder — but only
    // once something was **typed** into it. Counting the mere presence of the
    // box (`other !== null`) let one real tick plus an empty „Sonstiges" pass
    // „Mindestens 2 Auswahlen": the same hole `isBlankAnswer` closes for
    // `required`, one door further along. The two rules read emptiness the same
    // way on purpose — an answer that counts as blank cannot count as a
    // selection. One count serves all three bounds (`single`, `minSelected`,
    // `maxSelected`); splitting it is how the two rules came apart in the first
    // place. For a single-select question that means `{values:['a'], other:''}`
    // is now one selection rather than two — an option was chosen and the box
    // is empty, which is precisely one answer.
    const selected =
      answer.values.length + ((answer.other ?? '').trim() !== '' ? 1 : 0);

    if (single && selected > 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['values'],
        message: 'Nur eine Auswahl möglich.',
      });
    }

    if (question.type === 'checkbox') {
      if (question.minSelected !== null && selected < question.minSelected) {
        ctx.addIssue({
          code: 'custom',
          path: ['values'],
          message: `Mindestens ${String(question.minSelected)} Auswahl(en).`,
        });
      }
      if (question.maxSelected !== null && selected > question.maxSelected) {
        ctx.addIssue({
          code: 'custom',
          path: ['values'],
          message: `Höchstens ${String(question.maxSelected)} Auswahl(en).`,
        });
      }
    }
  });
}

/**
 * True when a value means "this question was left blank".
 *
 * **`other: ''` is as blank as `other: null`** — and now
 * nothing writes the first spelling any more ({@link canonicalAnswerValue}).
 * This branch stays, because the column still holds rows written before that
 * decision. Reading only `null` as blank
 * let a required choice question through with `{"values": [], "other": ""}`:
 * the shape a fill-in view produces the moment „Sonstiges" is on screen, for
 * every choice type, ending as an empty cell in the export that cannot be told
 * from a question nobody was asked.
 *
 * Whitespace goes the same way as for a string answer: a space bar is not an
 * answer, and a required question must not be satisfiable by one.
 *
 * **`unknown`, not `AnswerValue`** (a review finding): every branch below already
 * survives a value this application did not write — that is what {@link
 * blankText} and {@link objectValues} are for — and the old parameter type made
 * three call sites cast, which is the one thing `CONTRIBUTING.md` forbids. The
 * caller in `buildAnswersSchema` runs it on a **raw request body**, and the one
 * in `notification-render.ts` on a **raw JSONB document**; the signature now
 * says so.
 */
export function isBlankAnswer(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  if (typeof value === 'string') {
    return value.trim() === '';
  }
  if (typeof value === 'number') {
    return false;
  }
  if (isAddressAnswer(value)) {
    // Blank means **all four** subfields are — Land included, even though it
    // is never required: a Land typed on its own (default overwritten, three
    // other fields left alone) is something a participant did, not nothing.
    return (
      blankText(value.street) &&
      blankText(value.zip) &&
      blankText(value.city) &&
      blankText(value.country)
    );
  }
  if (isMatrixAnswer(value)) {
    // Blank means **no row carries a selection**. Not „nicht jede Zeile" —
    // that is the Pflicht rule (`matrixAnswerSchema`), a different question:
    // this one decides whether an *optional* Matrix counts as answered at all,
    // and one row ticked is something a participant did.
    return objectValues(value.rows).every(
      (picked) => Array.isArray(picked) && picked.length === 0,
    );
  }
  if (isTableAnswer(value)) {
    return isBlankTable(value);
  }
  // Blank means **no attachment is on it**. `Array.isArray` first, for the
  // reason {@link blankText} gives: this runs on the **raw payload** of a
  // required question, where `files` is whatever the request carried, and
  // `(5).length === 0` is `false` by accident rather than by decision. A
  // `files` that is not a list is therefore „nicht leer" and goes on to the
  // filled schema's field-specific 400.
  if (isFileAnswer(value)) {
    return Array.isArray(value.files) && value.files.length === 0;
  }
  // Blank means **no Veranstaltung carries a number**. The readable-object test
  // comes first for the reason {@link blankText} gives — this runs on the raw
  // payload of a required question, where `seats` is whatever the request
  // carried, and `Object.values(5)` is `[]`, i.e. „leer" by accident. A `seats`
  // that is not an object is therefore *not* blank and goes on to the filled
  // schema's field-specific 400.
  //
  // The entries themselves are read the same way: a `0`, an `''` or anything
  // unreadable is **not** counted as blank here, because
  // {@link canonicalAnswerValue} has already removed exactly the two spellings
  // of „keine Anmeldung" that a fill-in view produces. What is left is either a
  // real number or something nobody typed, and both belong to the filled schema.
  if (isEventAnswer(value)) {
    const seats: unknown = value.seats;
    return (
      typeof seats === 'object' &&
      seats !== null &&
      !Array.isArray(seats) &&
      Object.keys(seats).length === 0
    );
  }
  if (isChoiceAnswer(value)) {
    return (
      Array.isArray(value.values) &&
      value.values.length === 0 &&
      blankText(value.other ?? '')
    );
  }
  // A value of no recognisable shape is **not** blank — the same default the
  // four branches above take for what they cannot read. „Nicht lesbar" must
  // fail towards the filled schema's field-specific 400, never towards „war
  // eben leer".
  return false;
}

/**
 * `''`-or-whitespace, **checked before it is trusted to be a string**.
 *
 * This function and {@link objectValues} exist because of where
 * {@link isBlankAnswer} is called from: `buildAnswersSchema` runs it on the
 * **raw payload** of a required question, before any schema has looked at it
 * (that is the point — „Pflichtfeld" has to win over a length violation). The
 * three `is…Answer` guards narrow by the presence of one key, never by the
 * shape of what is under it, so `{"cells": "x"}` used to reach
 * `answer.cells.every` and throw a `TypeError` **inside** a Zod refinement —
 * which `safeParse` does not catch. Measured on 2026-07-31: a required table
 * and that body turned the public submission route into a **500** instead of a
 * 400.
 *
 * The bug is older than this package — a required **Adresse** with
 * `{"street": 5, …}` does the same thing, and a choice answer with
 * `{"other": 5}` does it too — so the hardening is applied to every branch
 * rather than only to the two this package adds; one function, one rule.
 *
 * A value that cannot be read is **not blank**, deliberately: the answer then
 * falls through to the filled schema, which rejects it with the field-specific
 * 400 it deserves, instead of being waved through as „nicht ausgefüllt".
 */
function blankText(value: unknown): boolean {
  return typeof value === 'string' ? value.trim() === '' : false;
}

/** `Object.values` that survives a `null` or a primitive from foreign JSONB. */
function objectValues(value: unknown): unknown[] {
  return typeof value === 'object' && value !== null
    ? Object.values(value as Record<string, unknown>)
    : [];
}

/**
 * **The canonical spelling of one answer** — decided
 * 2026-07-31 after the double form was measured against every reader.
 *
 * Today a choice answer's „Sonstiges" box arrives written two ways that mean
 * one thing: `other: ''` (the box is on screen and empty) and `other: null`
 * (no box). This function collapses the first into the second, and it is
 * applied by {@link buildAnswersSchema} — the validator every write goes
 * through — so the column only ever receives the second.
 *
 * ## Why the difference was given up rather than kept
 *
 * It was argued for here until this decision, and the argument was measured
 * instead of repeated: of the six readers of a stored answer, **five collapse
 * the two by hand** — `formatAnswerCell` (`answer-columns.ts`, and with it the
 * responses table, the export *and* the mail body), {@link isBlankAnswer}, the
 * selection count in {@link choiceAnswerSchema}, the blank schema in
 * {@link blankSchemaFor}, and the change block of an edit mail. The sixth is
 * the edit view's prefill, which reconstructs a **control state** from it: the
 * box comes back ticked and empty. That is not the answer — for a *required*
 * question the same state cannot be stored at all (it is refused as
 * „Pflichtfeld"), so the marker only ever survived where every reporting reader
 * already called the answer blank.
 *
 * ## What it does **not** do
 *
 * It does not invent an `other` key that is absent, and it does not trim a free
 * text somebody really wrote — only a string that is nothing but whitespace
 * becomes `null`, the same reading of „leer" {@link blankText} gives
 * everywhere else in this file. Widening it further would start repairing
 * payloads instead of spelling them, which is the drift `toStoredAnswers`
 * (`public-forms.service.ts`) refuses for the same reason.
 *
 * `unknown` in and `unknown` out, like {@link isBlankAnswer} and for the same
 * reason: its callers hold a raw request body or a raw JSONB document, never a
 * value anything has checked.
 */
export function canonicalAnswerValue(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value;
  }
  if ('seats' in value) {
    return canonicalSeats(value);
  }
  if (!('other' in value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  return blankText(record.other) ? { ...record, other: null } : record;
}

/**
 * **The second rule of the canonical form** , and it is the
 * „Sonstiges" rule one type further along.
 *
 * A Veranstaltung is answered in a number box, and a number box has two ways of
 * saying nothing: `''` while it has been cleared, `0` while somebody typed a
 * zero. Both mean „wir kommen zu dieser Veranstaltung nicht", which the stored
 * answer already spells by **not carrying the key at all** ({@link EventAnswer}
 * is sparse). Three spellings of one state is exactly the defect that was measured
 * across six readers and removed; this closes it *before* the second and third
 * one can reach the column, rather than after — and it is a collapse, not a
 * repair: zero people is not a registration in any reading.
 *
 * Everything else is left alone. A negative number, a string, an object: none of
 * them is a spelling of „nichts", so none of them is quietly deleted here — they
 * travel on to {@link eventAnswerSchema} and are refused with a message naming
 * the event they were sent for. Widening this to „drop what does not look like a
 * count" is the drift `toStoredAnswers` refuses for the same reason.
 */
function canonicalSeats(record: Record<string, unknown>): unknown {
  const seats: unknown = record.seats;
  if (typeof seats !== 'object' || seats === null || Array.isArray(seats)) {
    return record;
  }
  return {
    ...record,
    seats: Object.fromEntries(
      Object.entries(seats as Record<string, unknown>).filter(
        ([, count]) =>
          count !== 0 &&
          count !== null &&
          count !== undefined &&
          !(typeof count === 'string' && count.trim() === ''),
      ),
    ),
  };
}

/** {@link canonicalAnswerValue} over a whole submission, keys left alone. */
function canonicalAnswers(source: unknown): unknown {
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    return source;
  }
  return Object.fromEntries(
    Object.entries(source as Record<string, unknown>).map(([id, value]) => [
      id,
      canonicalAnswerValue(value),
    ]),
  );
}

/**
 * The schema for one question's answer, assuming an answer was actually given.
 *
 * The switch is exhaustive over the discriminated union, so adding a question
 * type without extending this function does not compile — which is the
 * point of deriving the validator instead of writing it a second time.
 *
 * **`enforceRequired` travels through here** (a review finding), and
 * it is a parameter rather than a default so that both call sites have to say
 * which reading they want. Four types read `question.required` *inside* the
 * answer — Adresse, Matrix, Tabelle, Veranstaltung — and for them the
 * blank/filled fork in {@link fieldSchemaFor} is not the only place the Pflicht
 * rule lives. Three of the four refused a half-filled draft until this
 * argument existed; what each of them measured stands at the four functions.
 *
 * **Exported**, and for a single purpose: the
 * sample-value generator of the test mode (`sample-answers.ts`) checks every
 * candidate against exactly this schema, instead of writing the rules down a
 * second time. The specification demands that expressly — „die Werte kommen aus
 * dem geteilten Schema, nicht aus einer zweiten Liste" —, and it is also the
 * only version in which the generator makes a statement about the *form*:
 * what it cannot satisfy is contradictory, and not merely
 * written differently from its replica.
 *
 * For an `info` it still throws; an Infotext is no question and has
 * no answer. Callers that hold an arbitrary question in
 * their hand filter beforehand with `answerableQuestions`.
 */
export function answerSchemaFor(
  question: Question,
  enforceRequired: boolean,
): z.ZodType<AnswerValue> {
  switch (question.type) {
    case 'text':
    case 'textarea':
      return textAnswerSchema(question);
    case 'number':
      return numberAnswerSchema(question);
    case 'date':
      return dateAnswerSchema(question);
    case 'email':
      // The one spelling from `auth.ts` (review finding 10) — an address
      // that a stranger types in is read exactly like one somebody logs in
      // with.
      return emailAddressSchema;
    case 'phone':
      return z
        .string()
        .trim()
        .max(PHONE_MAX)
        .regex(PHONE_ALLOWED, { error: 'Keine gültige Telefonnummer.' })
        .refine(
          (value) => (value.match(/\d/gu) ?? []).length >= PHONE_MIN_DIGITS,
          { error: 'Keine gültige Telefonnummer.' },
        );
    case 'select':
    case 'radio':
    case 'checkbox':
      return choiceAnswerSchema(question);
    case 'rating':
      return ratingAnswerSchema(question);
    case 'address':
      return addressAnswerSchema(question, enforceRequired);
    case 'matrix':
      return matrixAnswerSchema(question, enforceRequired);
    case 'table':
      return tableAnswerSchema(question, enforceRequired);
    case 'file':
      return fileAnswerSchema(question);
    case 'event':
      return eventAnswerSchema(question, enforceRequired);
    case 'info':
      // Never reached: `buildAnswersSchema` skips `info` questions before
      // either schema-builder function is called — an
      // `info` is a callout, not a question, and has no answer to validate.
      // The branch exists only so this switch stays exhaustive when a
      // further type arrives.
      throw new Error('answerSchemaFor: „info" hat keine Antwort.');
  }
}

/**
 * One answer **spelled the way the column will spell it** — the value a
 * Bedingung is evaluated over.
 *
 * ## Why the evaluation may not read the raw value
 *
 * A submission is written through {@link buildAnswersSchema}, and that pipeline
 * normalises twice: {@link canonicalAnswerValue} first (`other: ''` → `null`,
 * a `0` seat dropped), then the **field schema** of the question
 * ({@link answerSchemaFor}), which for an `email` is
 * `z.string().trim().toLowerCase()` and for an Adresse trims every subfield.
 * The stored answer is therefore regularly spelled differently from the one
 * that arrived — and *that* spelling is what the next request carries, because
 * the edit view prefills its form from the stored row.
 *
 * Evaluating a condition on the raw value made the two requests disagree: a
 * condition `equals 'Kanzlei@Example.org'` was true while submitting and false
 * while re-submitting the identical row, so an **edit that changed nothing**
 * dropped the dependent answer out of the column and reported it as a change in
 * the edit mail. Measured on the response row, both write paths.
 *
 * The normalisation is done **through the field schemas** rather than by
 * repeating `toLowerCase` here: what has to hold is „die Sichtbarkeit sieht,
 * was gespeichert wird", and a hand-written list of today's transformations
 * would fall behind the next one silently — the same failure one layer up, one
 * schema later.
 *
 * ## Why a failed parse is not an error
 *
 * `answers` reaches the evaluation as a **raw request body** and, in the
 * fill-in view, as half-typed draft state: `'4'` in a Zahlfeld, `''` in an
 * email box, an object where a string belongs. None of those parse, and none of
 * them may throw — the field schema is what answers a malformed payload, with
 * the message and the path it deserves, one step further down. A value that
 * does not parse is therefore handed on **canonicalised but otherwise
 * untouched**, which is exactly what the evaluation used to see for every
 * value, and {@link readingOf} is total over it.
 */
export function normalisedAnswer(question: Question, answer: unknown): unknown {
  const canonical = canonicalAnswerValue(answer);
  // An `info` has no answer schema at all (`answerSchemaFor` throws for it).
  // It is no condition source either — `conditionOperatorsFor('info')` is
  // empty — so this is the floor under that, not a second rule.
  if (!isAnswerableQuestion(question)) {
    return canonical;
  }
  // Enforcing, because this reads a **stored** answer: a Bedingung is evaluated
  // over what a submission put in the column, and „im Entwurf gilt Pflicht
  // nicht" is a statement about a write, not about a value that is already
  // there. A draft never reaches this function — `visibleQuestionIds` runs on
  // the raw answers inside `buildAnswersSchema`, which carries its own flag.
  const parsed = answerSchemaFor(question, true).safeParse(canonical);
  return parsed.success ? parsed.data : canonical;
}

/** The blank forms a question's answer may take when it was not filled in. */
function blankSchemaFor(question: Question): z.ZodType<AnswerValue> {
  switch (question.type) {
    case 'select':
    case 'radio':
    case 'checkbox':
      return z.object({
        values: z.array(z.never()).length(0),
        other: z.null(),
      });
    // A rating is read out of stars, not typed — the fill-in view never
    // produces `''` for it, only `null` for "no star clicked yet"
    // (`FieldInput.tsx`). The `default` branch below would still have let
    // `''` through as an alternate blank spelling for a *structured* answer
    // where none exists; a leftover finding (`blankSchemaFor` had no
    // branch of its own yet), closed here rather than where it was first found
    // because it is the answer *shape* — this file's concern — that decides it.
    case 'number':
    case 'rating':
      return z.null();
    // The `default` two lines down reads „leer heißt `'' | null`" — the shape
    // every scalar type in this file happens to share. An Adresse is not
    // scalar: the fill-in view never sends a bare `''` or `null` for it, only
    // an object, or — before any subfield is touched — no key at all (the
    // `.optional()` `buildAnswersSchema` wraps every non-required answer in
    // already covers that case without this function being asked). Falling
    // through to `default` would still *compile*, because `'' | null` is a
    // subtype of `AnswerValue` like every other blank shape here — it would
    // simply never match a real Adresse answer, which is exactly the kind of
    // branch that looks harmless and says nothing true.
    //
    // „Leer" for an Adresse is therefore stated as what it actually is: the
    // **one object shape** whose four subfields are all empty strings — the
    // same choice `select`/`radio`/`checkbox` make three cases up
    // (`{values: [], other: null}`), for the shape this type has. `z.literal
    // ('')` on each key rather than the field schema itself (`addressField
    // Schema(false)` would also accept `''`, and does, in the *filled* half of
    // the union): a blank schema exists to say what "nothing was typed" looks
    // like, not to duplicate a rule the filled schema already enforces.
    case 'address':
      return z.object({
        street: z.literal(''),
        zip: z.literal(''),
        city: z.literal(''),
        country: z.literal(''),
      });
    // The same trap the Adresse closed above, for the two structured shapes
    // — and it is worth saying **what „leer" is** for each, because the
    // two answer it differently:
    //
    // - **Matrix: `{ rows: {} }`** — no row carries a selection. Written as a
    //   record whose every value is the empty array so that the shape a
    //   fill-in view naturally produces (a key per row that was touched and
    //   then cleared) is blank too, not merely the pristine empty object.
    //   „Alle Zeilen leer" and not „keine Zeile beantwortet" is deliberate:
    //   the Pflicht rule („jede Zeile") lives on the *filled* schema, and a
    //   blank schema repeating it would state one rule in two places that can
    //   disagree.
    //   **Which rows may appear here is deliberately *not* stated below**, for
    //   the same reason the Tabelle's row bound is not (see the `table` branch):
    //   a key this question does not have would then fail **both** members of
    //   the union — and whether the path and the code survive that is up to
    //   Zod's internals rather than up to us. *Measured on 2026-08-07:* stating
    //   it here as a `.superRefine` loses them (both members fail continuably,
    //   Zod answers a bare `invalid_union` / „Invalid input"), while stating it
    //   as `z.record(z.enum(…), …)` keeps them (the blank member fails
    //   *fatally*, so Zod hands the one surviving member's issues on flat).
    //   Two spellings of one rule with two different answers on the wire is
    //   exactly the coin-flip the hook avoids: it is checked one level up
    //   instead, in front of the union — {@link checkKnownRows}.
    // - **Tabelle: `{ cells: [] }`** — or as many rows as the form offers,
    //   each of them an object without a single cell. Sparse storage is what
    //   makes that expressible at all: a cell that was never filled has no
    //   key, so „leer" is the absence of keys rather than a table full of
    //   `''`, `null` and `false`.
    //
    // Neither would have failed to compile under the `default` below — `'' |
    // null` is a perfectly good `AnswerValue` — and neither would ever have
    // matched a real answer. That is the whole failure mode: a branch that
    // looks harmless and says nothing true.
    case 'matrix':
      return z.object({
        rows: z.record(z.string(), z.array(z.never()).length(0)),
      });
    // **The row bound is deliberately *not* here** : an answer
    // of nothing but empty rows matches this branch, so the bound has to hold
    // for it — but stating it in *both* branches of the union makes Zod report
    // the failure as a bare `invalid_union` („Invalid input") with the reason
    // buried in `errors`, and the machine-readable code never reaches the wire.
    // It lives one level up instead, in front of the union:
    // {@link preUnionGuardFor}.
    case 'table':
      return z.object({
        cells: z.array(z.record(z.string(), z.never())),
      });
    // The same trap once more: „leer" for a Datei-Upload is the object
    // with **no attachments in it** — the shape the fill-in view produces after
    // the last file was removed again. Under the `default` below it would have
    // been `'' | null`, which compiles and never matches; `{files: []}` is what
    // actually arrives.
    case 'file':
      return z.object({ files: z.array(z.never()).length(0) });
    // The same trap once more: „leer" for a Veranstaltung is the object
    // with **no event in it** — the shape a fill-in view produces when every
    // number box is empty, once {@link canonicalAnswerValue} has taken the
    // cleared and zeroed entries out of it. `z.never()` as the record's value
    // type says exactly that: keys may not be present, rather than „may be
    // present holding nothing", which would be the second spelling all over
    // again.
    case 'event':
      return z.object({ seats: z.record(z.string(), z.never()) });
    case 'info':
      // The trap named: this switch has a `default`, so an `info`
      // left out here would silently inherit „leer heißt `'' | null`" — a
      // blank *form* for a question that has no answer at all. There is no
      // such thing to inherit: `buildAnswersSchema` never puts this question
      // in the shape in the first place, and this function is never called
      // for it. The explicit branch documents that rather than trusting the
      // `default` to keep meaning „ordinary optional field" forever.
      throw new Error('blankSchemaFor: „info" hat keine Antwort.');
    // An empty string is what a browser sends for an untouched input; `null`
    // is what a client that models "unanswered" explicitly sends. Both mean
    // the same thing and both are accepted, so neither client shape is wrong.
    //
    // **Written out rather than left to a `default:`** . This function
    // *had* one, and every branch above says in as many words what it costs —
    // „would still *compile*, because `'' | null` is a subtype of `AnswerValue`
    // like every other blank shape here — it would simply never match a real
    // answer". Measured on 2026-08-01, one type further along: adding `'file'`
    // made `answerSchemaFor` and `questionColumns` red and left **this**
    // function green, silently giving the new type a blank form no fill-in view
    // produces. Three of the five branches above were written precisely because
    // somebody noticed in time; that is not a mechanism. The `never` tail below
    // is.
    case 'text':
    case 'textarea':
    case 'date':
    case 'email':
    case 'phone':
      return z.union([z.literal(''), z.null()]);
  }

  // Unreachable while the switch is exhaustive; a new question type narrows to
  // itself instead of `never` here and the assignment names it.
  const unhandled: never = question;
  throw new Error(
    `blankSchemaFor: unhandled question type ${JSON.stringify(unhandled)}`,
  );
}

/**
 * Builds the validator for a whole submission.
 *
 * Two properties are worth naming, and both matter equally:
 *
 * - **Unknown questions are rejected, not ignored** (`.strict()`). A value for
 *   a question the form does not have would otherwise land in the JSONB column
 *   and reappear in the export as a column nobody defined.
 * - **Required means required**, and "answered with whitespace" is not
 *   answered. The blank check runs before the type check so a required text
 *   question reports "Pflichtfeld" rather than a length violation.
 * - **An `info` gets no key at all**  — not even an optional
 *   one. It is a callout, not a question, so there is nothing to validate;
 *   and because `.strict()` rejects a key that is not in `shape`, a value
 *   sent for it comes back as an *unrecognised field*, not as something
 *   quietly parsed and discarded.
 * - **The answer is brought into its canonical form first** (*   {@link canonicalAnswerValue}) — as a `preprocess` around the whole object
 *   rather than inside one of the two branches below, and that placement is
 *   the point: a **required** question is validated with
 *   `z.unknown().superRefine`, which hands its *input* back rather than a
 *   parsed value, so a transform on the filled schema would canonicalise
 *   optional answers and leave required ones spelled the old way. One rule,
 *   ahead of both branches, before `isBlankAnswer` and before the blank/filled
 *   fork — which is also what makes a **stored** `other: ''` on a question
 *   whose „Sonstiges" was since switched off still parse, instead of locking
 *   its own participant out of the edit view.
 *
 * ## `enforceRequired: false` — the **draft**
 *
 * A zwischengespeicherter Entwurf is half filled by definition, so running it
 * against the Pflicht rule would refuse the one request that saves somebody's
 * typing. That single rule is what the flag takes out, and it takes out nothing
 * else — which is the part worth writing down, because „ein Entwurf ist nicht
 * fertig" reads to a hurried reader like „an einem Entwurf wird nichts geprüft":
 *
 * | Rule | Submission | Draft |
 * |---|---|---|
 * | Pflichtfeld, **on every level** — the question itself *and* the required parts of composite types (Adresse: Straße/PLZ/Ort · Matrix: every row · Tabelle: at least one row · Veranstaltung: at least one entry) | enforced | **not enforced** |
 * | Type and bounds of a value that *is* there (length, pattern, min/max, options, date bounds, file references, Personenzahl) | enforced | enforced |
 * | A key for a question this form does not have (`.strict()`) | rejected | rejected |
 * | The value of a hidden question | discarded | discarded |
 * | Canonical form  | applied | applied |
 *
 * **The first row said „Pflichtfeld" alone until an earlier review, and that
 * was not merely imprecise — it described a rule the code did not have.** The
 * flag stopped at the blank/filled fork in {@link fieldSchemaFor}, while
 * Adresse, Matrix and Tabelle read `question.required` a second time *inside*
 * the filled schema; a half-typed one of any of the three is not blank, so it
 * went through the fork and was refused behind it. *Measured on 2026-08-05:*
 * a half-typed Pflicht-Adresse answered `POST …/drafts` with **400**
 * (`zip: Pflichtfeld., city: Pflichtfeld.`). The price of a halved
 * Zwischenspeichern thus fell due exactly where it helps most.
 *
 * The reasoning is the same one that puts the validation on the server at all:
 * this document goes into a JSONB column, comes back out through the fill-in
 * view and is submitted from there, so a value that could not be part of an
 * answer has no business being part of a draft either. What must **not** happen
 * is a draft becoming the way to store something a submission would refuse.
 *
 * The flag defaults to enforcing, so every existing caller keeps the behaviour
 * it had and the draft path is the one that has to say what it is doing.
 */
export interface AnswersSchemaOptions {
  /** Whether a Pflichtfrage has to be answered. `true` unless said otherwise. */
  readonly enforceRequired?: boolean;
}

export function buildAnswersSchema(
  definition: FormDefinition,
  options: AnswersSchemaOptions = {},
): z.ZodType<AnswerMap> {
  const enforceRequired = options.enforceRequired ?? true;
  // Built **once per definition**, not once per parse: a question's own
  // validator does not depend on the answers, only on which questions are on
  // screen does. `answerableQuestions` rather than a local `info` filter:
  // „keine Frage, keine Antwort" is one rule, and a review measured
  // what two spellings of it cost (see `form-schema.ts`).
  const fields = new Map<string, z.ZodType<AnswerValue | undefined>>(
    answerableQuestions(definition).map((question) => [
      question.id,
      fieldSchemaFor(question, enforceRequired),
    ]),
  );

  /**
   * The only keys this validator may ever *drop* — the questions that can carry
   * an answer at all.
   *
   * An `info` is deliberately **not** in here, although it is a question of the
   * form: it has no answer whether it is on screen or not, so a value sent for
   * it stays the unrecognised key this makes it. Were it in here, a
   * *hidden* Infotext would silently swallow a value that a visible one
   * rejects — one rule with two answers, decided by something the sender cannot
   * see.
   */
  const answerable = new Set(fields.keys());

  return z.preprocess(
    canonicalAnswers,
    z.unknown().transform((value, ctx): AnswerMap => {
      /*
       * **The Bedingungen, resolved before anything is required or kept**.
       *
       * The order is the whole point. Deciding Pflicht *without* the
       * conditions makes a form with a hidden required question unsubmittable;
       * deciding it the other way round — trusting the sender's word about
       * what was on screen — makes every Pflicht evadable by ticking the box
       * that hides it. What is trusted here is neither: the visibility is
       * recomputed on the server from the answers themselves, through the one
       * function the fill-in view renders from (`visibleQuestionIds`).
       *
       * From the **canonicalised** input (this runs inside the `preprocess`),
       * so a condition on „ist leer" reads the same spelling of „nichts
       * angemeldet" that `isBlankAnswer` does one step further down.
       */
      const visible = visibleQuestionIds(definition, asAnswerRecord(value));

      const shape: Record<string, z.ZodType<AnswerValue | undefined>> = {};
      for (const [questionId, field] of fields) {
        if (visible.has(questionId)) {
          shape[questionId] = field;
        }
      }

      /*
       * **The value of a hidden question is discarded** — not
       * stored, and not rejected either.
       *
       * Discarded and not rejected, because the sender is regularly right
       * to have sent it: a participant types an answer, changes the source
       * above it, and the field they had filled in disappears. A 400 would
       * make that form unsubmittable until they reloaded it — the same failure
       * the Pflicht direction of this rule is about, one door further
       * along. What must not happen is the value **surviving**: it would sit
       * in the JSONB column, come out in the CSV under a question this person
       * never saw, and read to the office like an answer they gave.
       *
       * Only keys of *this form's* questions are dropped. Anything else stays
       * and meets `.strict()` below, so „Frage gibt es nicht" and „Frage war
       * ausgeblendet" keep their two different answers.
       */
      const kept: Record<string, unknown> = {};
      for (const [questionId, answer] of Object.entries(
        asAnswerRecord(value),
      )) {
        if (!answerable.has(questionId) || visible.has(questionId)) {
          kept[questionId] = answer;
        }
      }

      const result = z
        .strictObject(shape)
        .safeParse(isAnswerRecord(value) ? kept : value);
      if (!result.success) {
        for (const issue of result.error.issues) {
          // Spread rather than passed through, exactly as in `fieldSchemaFor`:
          // the issue type Zod *reports* is narrower than the one it *accepts*,
          // and the copy is what makes the two meet without a cast.
          ctx.addIssue({ ...issue, path: issue.path });
        }
        return z.NEVER;
      }
      return result.data;
    }),
  );
}

/**
 * The validator for one question's key — required or optional, the shape it had
 * before conditions existed.
 *
 * Lifted out of {@link buildAnswersSchema} so that what varies per parse (which
 * questions are on screen) is separated from what does not (what an answer to
 * each of them may look like).
 *
 * `enforceRequired` is the **one** thing a draft changes:
 * with it off, a Pflichtfrage takes the same optional branch every other
 * question takes — blank *or* a value that passes its own schema. It is passed
 * down rather than read from a module-level flag so that the two readings can
 * exist side by side in one process, which is exactly what happens the moment a
 * draft is saved against a form somebody else is submitting to.
 */
function fieldSchemaFor(
  question: AnswerableQuestion,
  enforceRequired: boolean,
): z.ZodType<AnswerValue | undefined> {
  // **Handed down, not only branched on below** (a review finding):
  // four types carry a Pflicht rule *inside* the answer, where this fork cannot
  // reach — see {@link answerSchemaFor}.
  const filled = answerSchemaFor(question, enforceRequired);

  if (question.required && enforceRequired) {
    // The row bound reaches this branch through `filled` — there is no union
    // here, so the issue of `tableAnswerSchema` travels flat and keeps its
    // path and its code.
    return z.unknown().superRefine((value, ctx) => {
      if (isBlankAnswer(value)) {
        ctx.addIssue({ code: 'custom', message: 'Pflichtfeld.' });
        return;
      }
      const result = filled.safeParse(value);
      if (!result.success) {
        for (const issue of result.error.issues) {
          ctx.addIssue({ ...issue, path: issue.path });
        }
      }
    }) as unknown as z.ZodType<AnswerValue | undefined>;
  }

  const optional = z.union([blankSchemaFor(question), filled]).optional();
  // **This** is the branch where a rule about the *shape* of the document would
  // otherwise be lost in a union tie — a Tabelle or a Matrix that is not a
  // Pflichtfrage, and either of them in a draft.
  const guard = preUnionGuardFor(question);
  return guard === undefined ? optional : withPreUnionGuard(guard, optional);
}

/**
 * A check that runs on the **raw** answer before the blank/filled union does.
 *
 * Answers whether the value may go on. `false` stops the parse right there —
 * the guard has already said what was wrong, with a path and a code.
 */
type PreUnionGuard = (value: unknown, ctx: z.RefinementCtx) => boolean;

/**
 * The pre-union check of a question type, or `undefined` for the types that
 * need none.
 *
 * **Two types need one, and they need it for the same reason** (a requirement and a
 * security review): both carry a container whose *size* is the payload —
 * a Tabelle its rows, a Matrix its row keys — and for both the empty container
 * is a perfectly good **blank** answer. A rule stated inside the union
 * therefore never runs on exactly the documents it exists for, and a rule
 * stated in *both* members turns into `invalid_union` („Invalid input") with
 * path and `params.code` buried in `errors`.
 *
 * Written as a switch over the type rather than as a flag on the question, so
 * that a **new** question type with a container of its own shows up here as a
 * decision instead of inheriting „braucht keinen" in silence. The `default` is
 * the honest half of that: it says „every other type's blank form is bounded by
 * its own shape", which is true today for every scalar, for Adresse, Datei and
 * Veranstaltung — the last one because {@link canonicalAnswerValue} strips
 * cleared entries and `blankSchemaFor` gives it `z.never()` as the record's
 * value type, so an unknown key cannot be blank.
 */
function preUnionGuardFor(
  question: AnswerableQuestion,
): PreUnionGuard | undefined {
  switch (question.type) {
    case 'table':
      // `isTableAnswer` narrows on the presence of `cells`, never on its shape
      // (see its own comment), so the length is read defensively: a `cells`
      // that is a string is not „zu viele Zeilen", it is a shape the schema
      // below refuses with the message that fits.
      return (value, ctx) =>
        !isTableAnswer(value) ||
        !Array.isArray(value.cells) ||
        checkRowCount(question, value.cells.length, ctx);
    case 'matrix':
      return (value, ctx) =>
        !isMatrixAnswer(value) ||
        !isAnswerRecord(value.rows) ||
        checkKnownRows(question, value.rows, ctx);
    default:
      return undefined;
  }
}

/**
 * A guard **in front of** the blank/filled union.
 *
 * ## Why the rule is not simply stated in both branches
 *
 * It was, for the table, and it worked — until the case that matters most: an
 * answer whose every row is empty fails **both** branches for the same reason,
 * and Zod reports a tie between union members as one `invalid_union` issue with
 * the message „Invalid input" and the real reasons nested inside `errors`. The
 * client's field marker reads the flat list, the wire contract carries the flat
 * list, and `params.code` never gets out of the nesting. *Measured on
 * 2026-08-06:* `{cells: [{} × 1000]}` answered 400 with `Invalid input` on the
 * question and nothing on `cells`. In front of the union the answer is one
 * issue with the field, the sentence and the code, whatever the value contains.
 *
 * ## Why it stops rather than continues
 *
 * A refused guard returns `z.NEVER` instead of also running the shape beneath
 * it: „zu viele Zeilen" is the answer, and the twenty follow-up complaints
 * about cells nobody may send are noise a participant would have to read past.
 * The value only reaches the inner schema once it is acceptable — which is also
 * why this cannot be a `.superRefine` *after* the union: Zod skips a refinement
 * whose base already failed, so a rule stated there would never run on exactly
 * the payloads it is for.
 *
 * ## What this hook deliberately does **not** catch
 *
 * A malformed container — `{cells: "x"}`, `{rows: 5}` — passes the guard on
 * purpose (both guards fall through when the shape is not the one they read)
 * and is refused by the union behind it, which means it comes back as
 * `invalid_union` / „Invalid input" **without a path below the question**. It
 * is a wrong *shape*, not an oversized one, so no rule of this file has a
 * sentence for it; preempting it here would mean inventing a second German
 * spelling of Zod's own type message, which the Pflicht branch of
 * {@link fieldSchemaFor} — where the same payload travels flat — would not
 * share. Named rather than fixed: it costs a participant a vague message on a
 * document no fill-in view produces, and it costs nothing else.
 *
 * ## The `.optional()` at the end is load-bearing
 *
 * `z.unknown()` is **not** an optional object key in Zod 4 — not bare, not with
 * refinements, not with a transform. *Measured against Zod 4.4.3:*
 * `z.object({k: z.unknown()})`, `.superRefine(() => {})` and `.transform(v => v)`
 * all answer „Invalid input: expected nonoptional, received undefined" for `{}`.
 * The Pflicht branch of {@link fieldSchemaFor} survives a missing key anyway,
 * but not because its schema is optional: its **own** refinement fires on
 * `undefined` first and reports „Pflichtfeld.", and Zod does not add the
 * nonoptional issue on top of an issue the refinement already raised. This
 * wrapper has no such refinement — its transform hands the value to the inner
 * schema — so without the `.optional()` an answer object that simply does not
 * mention this question (the normal case, and what every draft of a form with
 * a table looks like) is refused with „expected nonoptional". *Measured on
 * 2026-08-06:* two cases of `draft.spec.ts` („wird gespeichert: eine Adresse mit
 * nur der Straße", „… eine Matrix mit einer offenen Zeile") turned red on
 * exactly that, because their form carries a table they leave alone.
 * `.optional()` restores what `z.union([…]).optional()` said before this wrapper
 * was put in front.
 */
function withPreUnionGuard(
  guard: PreUnionGuard,
  inner: z.ZodType<AnswerValue | undefined>,
): z.ZodType<AnswerValue | undefined> {
  return z
    .unknown()
    .transform((value, ctx) => {
      if (!guard(value, ctx)) {
        return z.NEVER;
      }
      const result = inner.safeParse(value);
      if (!result.success) {
        for (const issue of result.error.issues) {
          // Spread rather than passed through, exactly as above: the issue type
          // Zod *reports* is narrower than the one it *accepts*.
          ctx.addIssue({ ...issue, path: issue.path });
        }
        return z.NEVER;
      }
      return result.data;
    })
    .optional();
}

/**
 * A submission body as a record, **without asserting that it is one**.
 *
 * `buildAnswersSchema` runs on a raw request body, so „answers" may be an
 * array, a number or `null`. Neither the visibility nor the discard may throw
 * on one of those: the object schema below is what answers a body of the wrong
 * shape, with the message it deserves, and a `TypeError` thrown ahead of it
 * would come out of the public route as a 500 — the exact failure `blankText`
 * documents one function further down.
 */
function isAnswerRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asAnswerRecord(value: unknown): Record<string, unknown> {
  return isAnswerRecord(value) ? value : {};
}

/** Convenience wrapper: parse `source` against `definition`. */
export function parseAnswers(
  definition: FormDefinition,
  source: unknown,
): AnswerMap {
  return buildAnswersSchema(definition).parse(source);
}

export function safeParseAnswers(
  definition: FormDefinition,
  source: unknown,
): z.ZodSafeParseResult<AnswerMap> {
  return buildAnswersSchema(definition).safeParse(source);
}

/**
 * The same parse, **without the Pflicht rule** — what a zwischengespeicherter
 * Entwurf is held to.
 *
 * A named function rather than an options object at the two call sites: „ein
 * Entwurf wird anders geprüft" is a domain decision, and a boolean
 * spelled out at a call site is a boolean somebody flips there. Everything the
 * flag does and does **not** relax is written down at
 * {@link buildAnswersSchema}.
 */
export function safeParseDraftAnswers(
  definition: FormDefinition,
  source: unknown,
): z.ZodSafeParseResult<AnswerMap> {
  return buildAnswersSchema(definition, {
    enforceRequired: false,
  }).safeParse(source);
}
