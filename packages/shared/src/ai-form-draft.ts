import { z } from 'zod';

import {
  findUnresolvableConditions,
  unresolvableConditionMessage,
} from './condition.ts';
import {
  formDefinitionSchema,
  pageSchema,
  questionConditionSchema,
  questionSchema,
  type FormDefinition,
} from './form-schema.ts';
import { formTitleSchema } from './forms.ts';

/**
 * **What a language model is allowed to hand back, and what happens to it**
 * (ADR-0015 no. 3 and no. 11).
 *
 * The one sentence this file exists for: *the target language is the shared
 * `formSchema`, not a second one for the AI.* Everything below is either
 * **derived** from that schema or is the walk that turns a derived document
 * back into one — there is no second list of question types, no second option
 * shape, no second translation table. A „KI-Schema" with its own translation
 * would be a third place where the sixteen question types have to stay true,
 * and this project has paid for that shape four times already.
 *
 * ## Three steps, and the third is the judge
 *
 * 1. {@link aiFormDraftSchema} — the **derived** form: `formSchema` minus every
 *    `id`, minus `replaces`, with the one reference a document without ids
 *    cannot express replaced by a position ({@link AI_DRAFT_CONDITION_TARGET}),
 *    and with one rule laid over every remaining field: a key a model simply
 *    left out means „nicht gesetzt" rather than „ungültig"
 *    ({@link tolerantField}). It decides *shape* and nothing else.
 * 2. **IDs are minted here, never taken from the model** — page ids, question
 *    ids, and the `questionId` of every condition, resolved from the position
 *    the draft named.
 * 3. `formDefinitionSchema` — **the judge**, with every refinement the derived
 *    form had to drop (`minLength ≤ maxLength`, duplicate option values,
 *    duplicate question ids, the Tabellen-Obergrenze …), followed by
 *    `findUnresolvableConditions` — *the same function the publish route runs*,
 *    so „ohne Nacharbeit veröffentlichbar" is a property and not a hope.
 *
 * That order is why step 1 may be as thin as it is: a rule it does not enforce
 * is not a rule that goes unenforced, it is a rule the judge owns. Bounds are
 * therefore deliberately **not** restated here — `pages.max(100)`,
 * `questions.max(QUESTIONS_PER_PAGE_MAX)`, `TABLE_ROWS_MAX` and friends all
 * live in `form-schema.ts` and are applied in step 3. Two numbers would drift;
 * one number applied late is merely late.
 *
 * ## Why the derivation is loose where it is loose
 *
 * The variants are rebuilt from `.shape` rather than through `.omit()`: Zod 4
 * refuses `.omit()` on an object carrying refinements („cannot be used on
 * object schemas containing refinements"), and six of the sixteen question
 * variants carry one. Rebuilding drops exactly those **cross-field** checks —
 * the intended loss, not a workaround, because they are the judge's in step 3
 * and a JSON schema could not carry them anyway (ADR-0015 no. 3(a)). Every
 * *field-level* bound survives, because it lives on the field.
 *
 * The price is TypeScript's: a shape assembled at runtime infers as a record
 * rather than as sixteen precise variants. That is answered rather than
 * suffered — **the two fields this file rewrites are re-attached with their
 * precise schemas** ({@link AI_DRAFT_CONDITION_TARGET} and `visibleIf`), so the
 * walk below reads them typed and merely *carries* everything else. Nothing
 * here decides what a question means; the judge does.
 */

/** The keys of a question the model never gets to decide (ADR-0015 no. 3(a)). */
const QUESTION_KEYS_WITHHELD = ['id', 'replaces', 'visibleIf'] as const;

/**
 * Rebuilds a shape without the named keys.
 *
 * A plain object operation rather than `.omit()`, for the reason the file
 * comment gives. It is applied to a shape that came **out of the shared
 * schema**, so nothing is written down here that `form-schema.ts` does not
 * already say.
 */
function shapeWithout(
  shape: z.ZodRawShape,
  withheld: readonly string[],
): z.ZodRawShape {
  return Object.fromEntries(
    Object.entries(shape).filter(([key]) => !withheld.includes(key)),
  );
}

/**
 * **What a *missing* key means** — the one place the derived form is more
 * forgiving than `formSchema`, and it is a rule rather than a list.
 *
 * ⚠️ **Measured, like `visibleIf` below** (2026-08-14, Mistral Large): a draft
 * was refused with
 * `pages.0.questions.0.pattern: expected string, received undefined ·
 * pages.1.questions.0.allowOther: expected boolean, received undefined ·
 * minSelected … maxSelected …`. Every one of those fields is *optional in
 * meaning* — `pattern: null` is „kein Muster", `allowOther: false` is „kein
 * Sonstiges" — but `shapeWithout` copies the field **as written**, and
 * `.nullable()` alone keeps the *key* mandatory. So a model that says „nicht
 * gesetzt" by leaving the key out rather than by writing `null` lost the whole
 * form, and the editor paid a counted call for it (ADR-0015 no. 7).
 *
 * The rule, applied to every field of every shape the model fills in:
 *
 * - **A field that accepts `null` gets `.default(null)`** — an absent key is
 *   then the same „nicht gesetzt" the schema already had a spelling for. The
 *   *output* is unchanged (`null` was always in it), so nothing downstream
 *   gains a state it did not have.
 * - **A field that accepts `false` gets `.default(false)`** — the off position
 *   of a switch (`allowOther`, `required`, `integer`, `multiple`,
 *   `showRemaining`). „Nicht erwähnt" is „nicht eingeschaltet", which is the
 *   only reading that cannot invent content.
 *
 * **Two probes, not two lists.** The decision is asked of the field's own
 * `safeParse`, so a seventeenth question type — or one more `.nullable()` on an
 * existing one — is covered the day it is written, without anybody remembering
 * this file. A hand-kept list of field names is exactly what came apart above.
 *
 * **It descends into objects and arrays** (the walk below), because the same
 * failure sits one level down: an `event` question's Veranstaltung carries
 * `when` and `capacity` as `.nullable()` and `showRemaining` as a boolean, and
 * a model writing `{ "key": "…", "label": "…" }` would have lost the form for
 * the identical reason. A list is **cloned** rather than rebuilt, so its bounds
 * and its duplicate-key check travel along untouched; a nested object is
 * rebuilt and therefore drops its own cross-field refinements — the same
 * intended loss the file comment describes for the sixteen variants, and the
 * same owner in step 3.
 *
 * A nested *union* is handed on whole (the derived form has one: a table's
 * columns), which is a boundary rather than an oversight — none of its members
 * carries a field of either kind today, and the lock named below is what says
 * so the day one does.
 *
 * **What stays mandatory, and the half of it that is a known gap.** Every field
 * with no „nicht gesetzt" spelling at all keeps its key: `label`, `options`,
 * `width`, a Bewertung's `max`. For the first two that is right — a made-up
 * caption or a made-up option list is *invented content*, and a model that
 * names neither has not designed the question.
 *
 * ⚠️ For `width` and `max` it is a **residual refusal, acknowledged rather than
 * argued away**: a model that leaves `width` out still loses the form, and
 * layout is the one thing no prompt ever mentions. The builder does have
 * defaults for both (`question-defaults.ts`) — but they live in `apps/web`,
 * which `packages/shared` cannot read and must not copy: a table of per-field
 * defaults *here* is exactly the hand-kept second list this rule replaced.
 * Closing it needs the builder's defaults to move into this package first, and
 * that is a change with its own reasons and its own reviewers.
 *
 * `ai-form-draft.test.ts` locks the boundary from the other side: it walks the
 * rendered JSON schema and refuses any *required* property that accepts `null`
 * or is a boolean, so a field of that kind added anywhere in the tree turns red
 * here instead of turning into a refusal in front of an editor.
 *
 * ⚠️ **The judge is untouched.** This makes the *acceptance* tolerant, never the
 * *result*: step 3 (`formDefinitionSchema` plus `findUnresolvableConditions`)
 * runs on the document *after* the defaults have been filled in, so a draft
 * that is still not a valid form is refused exactly as before.
 */
function tolerantField(field: z.core.$ZodType): z.core.$ZodType {
  // **One result per input schema, and it is a size decision.**
  // `z.toJSONSchema(…, { reused: 'ref' })` lifts a sub-schema into `$defs` by
  // *object identity*, and `optionsSchema` is one instance shared by `select`,
  // `radio` and `checkbox` (`choiceShape` spreads it). Without this memo each
  // of the three would get its own clone, the identity would be gone and the
  // 500-entry option list would be **inlined three times** in what goes out —
  // measured at ~450 bytes on every single call (`ai-form-json-schema.ts`).
  const carried = TOLERATED.get(field);
  if (carried !== undefined) {
    return carried;
  }
  const tolerant = deriveTolerantField(field);
  TOLERATED.set(field, tolerant);
  return tolerant;
}

/**
 * The memo of {@link tolerantField} — weak, so nothing here holds a schema
 * alive that the module it came from has let go.
 */
const TOLERATED = new WeakMap<z.core.$ZodType, z.core.$ZodType>();

function deriveTolerantField(field: z.core.$ZodType): z.core.$ZodType {
  // A shape is typed as the *core* schema interface, which carries neither
  // `safeParse` nor `.default`. A runtime check rather than a cast, the same
  // way `isRecord` below keeps the walk honest: a field this branch cannot
  // reach travels on unchanged instead of crashing.
  if (!(field instanceof z.ZodType)) {
    return field;
  }
  // Order matters: a field that already has a spelling for „nicht gesetzt"
  // gets that spelling as its default and is not descended into — there is
  // nothing below a `null` to make tolerant.
  if (field.safeParse(null).success) {
    return field.default(null);
  }
  if (field.safeParse(false).success) {
    return field.default(false);
  }
  if (field instanceof z.ZodArray) {
    // A **clone with one member replaced**, not a rebuilt `z.array(…)`: the
    // bounds and the duplicate-value refinements of a list (`options`,
    // `events`, a table's `columns`) live on the array itself, and handing
    // the model a schema without them would be a widening this function has no
    // business doing. Cloning carries the whole `def` over, so nothing has to
    // be enumerated here — and nothing can be forgotten when Zod adds a member.
    return z.core.clone(field, {
      ...field._zod.def,
      element: tolerantField(field._zod.def.element),
    });
  }
  if (field instanceof z.ZodObject) {
    return z.object(tolerantShape(field._zod.def.shape));
  }
  // Everything else — enums, literals, strings, numbers, the `.optional()`
  // fields that already say „darf fehlen" — is handed on untouched.
  return field;
}

/**
 * {@link tolerantField} over a whole shape.
 *
 * The cast is about the **input** side only and is deliberate: every rule above
 * leaves `z.output` exactly as it was (`null` was already in the type,
 * `.default` only removes `undefined` from the *input*), so the shape still
 * describes the parsed value truthfully — which is what keeps `page.title` a
 * `string` for the walk below instead of collapsing to `unknown`. What
 * TypeScript is not told is that fewer keys are *required on the way in*, and
 * nothing reads that side: `z.toJSONSchema(…, { io: 'input' })` asks the
 * runtime schema, not the type.
 */
function tolerantShape<Shape extends z.ZodRawShape>(shape: Shape): Shape {
  return Object.fromEntries(
    Object.entries(shape).map(([key, field]) => [key, tolerantField(field)]),
  ) as unknown as Shape;
}

/**
 * Narrowing for a value the derived schema has already vouched for.
 *
 * The walk below reads two fields out of a shape TypeScript only knows as a
 * record (see the file comment), and this keeps that honest: a runtime check
 * rather than a cast, so a future change to the derived form fails as a
 * refusal instead of as a crash in a `...spread`.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Where a *Bedingte Anzeige* of a draft points — **a position, not an id**.
 *
 * This is the one place the derived form cannot be a pure subtraction, and the
 * reason is arithmetic rather than taste: ADR-0015 no. 3(a) takes `id` out
 * everywhere, and `questionConditionSchema`'s `questionId` is a `z.uuid()`
 * naming one of exactly those ids. A reference into a document that has no ids
 * must name its target some other way, and the cheapest way that invents
 * nothing is the position the target already has: **the index of the source
 * question in document order** (pages in order, each page's questions in order
 * — `allQuestions`' order).
 *
 * *Rejected:* giving every question a model-chosen `key` and referencing that.
 * It would add a field to sixteen question types that no stored document
 * carries, i.e. exactly the „zweite Niederschrift" this file exists to avoid.
 *
 * **A forward reference is expressible on purpose.** The index may name a
 * question that comes *later*, and nothing here refuses it: that is the
 * document a model produces when it plans a form top-down and then reorders,
 * and it is the case that must be rejected *with a reason*. It is rejected
 * in step 3, by `findUnresolvableConditions`, whose
 * message names the affected question — the same sentence the 422 of
 * *Veröffentlichen* carries.
 */
export const AI_DRAFT_CONDITION_TARGET = 'questionIndex';

/** One comparison, with the id reference swapped for a position. */
function draftConditionOf(variant: { readonly shape: z.ZodRawShape }) {
  return z
    .object(tolerantShape(shapeWithout(variant.shape, ['questionId'])))
    .extend({ [AI_DRAFT_CONDITION_TARGET]: z.number().int().nonnegative() });
}

// Head and tail rather than one `.map()`: `z.discriminatedUnion` wants a
// non-empty tuple, and `Array.prototype.map` over a tuple hands back a plain
// array. Destructuring keeps the derivation mechanical *and* keeps the
// „mindestens eine Variante" promise at the type level, where an empty options
// list would otherwise only fail at runtime.
const [firstCondition, ...moreConditions] = questionConditionSchema.options;

/**
 * Derived from the operator union, so an eighth operator reaches the model
 * without anybody remembering this file.
 */
const aiDraftConditionSchema = z.discriminatedUnion('operator', [
  draftConditionOf(firstCondition),
  ...moreConditions.map(draftConditionOf),
]);

/**
 * One question as a model may hand it over — {@link aiFormDraftSchema}'s leaf.
 *
 * ⚠️ **`visibleIf` is `.nullish()`, not `.optional()`, and that one token was
 * worth a measurement** (2026-08-12). „Keine Bedingung" has two spellings a
 * model reaches for — leaving the key out, and writing `null` — and only the
 * first was accepted. It is not a hypothetical: over nine drafts from three
 * Anthropic models, **four of the five failures were exactly this**, and for
 * one of the three models it was *every* attempt. Accepting `null` moved the
 * run from 4/9 to 8/9; the one remaining failure is the condition judge doing
 * its job.
 *
 * The refusal was the more embarrassing kind, too: {@link adoptAiFormDraft}
 * below has always been ready for it (`if (!isRecord(visibleIf))` drops
 * anything that is not an object), so the schema in front rejected a document
 * the walk behind it would have handled correctly.
 *
 * **A tolerance, not a meaning.** `null` is dropped rather than carried — in
 * `formSchema` the absence of a condition *is* the absence of the key, and a
 * `visibleIf: null` in a stored form would be a third state nobody renders.
 *
 * The same measurement was made a second time, on the fields *around* this one,
 * and answered as a rule instead of as a token: {@link tolerantField}.
 */
function draftQuestionOf(variant: { readonly shape: z.ZodRawShape }) {
  return z
    .object(tolerantShape(shapeWithout(variant.shape, QUESTION_KEYS_WITHHELD)))
    .extend({ visibleIf: aiDraftConditionSchema.nullish() });
}

const [firstQuestion, ...moreQuestions] = questionSchema.options;

const aiDraftQuestionSchema = z.discriminatedUnion('type', [
  draftQuestionOf(firstQuestion),
  ...moreQuestions.map(draftQuestionOf),
]);

/**
 * **The derived form** — `formSchema` minus what the model must not decide.
 *
 * What is taken out, and why each:
 *
 * - **`id`, everywhere.** IDs are minted when a draft is adopted
 *   ({@link adoptAiFormDraft}), never read off the answer. What is not in the
 *   schema cannot be delivered, which is cheaper than a filter that removes it
 *   afterwards (ADR-0015 no. 3(a)) — and cheaper still, an `id` a disobedient
 *   model sends anyway is **stripped** by Zod rather than carried, so „zwei
 *   Aufrufe derselben Eingabe" cannot produce two forms sharing a question id
 *   even when the model repeats itself word for word.
 * - **`replaces`.** It names the question a type change retired *inside the
 *   same form* — bookkeeping for `publishDiff`. A form that did not exist a
 *   second ago has no such history, and the same reasoning already removes it
 *   from a duplicated question (`question-duplicate.ts`).
 *
 * **Unknown keys are dropped, not refused**, which is Zod's default and is a
 * decision here rather than an omission: a model garnishes. A `description` on
 * a question, a `placeholder`, an `id` it was not asked for — none of that is a
 * reason to throw away an otherwise good form and charge the editor a
 * second counted call (ADR-0015 no. 7). What a form *is* stays decided by the
 * fields that are here, and every rule that matters is applied in step 3.
 *
 * ⚠️ **A `"__proto__"` key survives `JSON.parse` as an own, enumerable
 * property** (measured in `model-json.ts`, and again here). It does **not**
 * survive this parse: Zod builds a fresh result object out of the keys it
 * knows, so the key is gone from the value that travels on towards the
 * inheritance merge (Tenant default ↔ `settings_override`). Worth one
 * assertion rather than one sentence — it is in `ai-form-draft.test.ts`,
 * together with the second half of the measurement: Zod's *strict* mode does
 * **not** reject it, it only fails to copy it. „Abgeworfen" here means dropped,
 * not refused.
 */
export const aiFormDraftSchema = z.object({
  /**
   * **The one field that is not a subtraction: the name the model suggests for
   * the form.**
   *
   * A generated document had nowhere to put a title — `formDefinitionSchema` is
   * pages and questions, and the title of a form lives on the *record*, next to
   * its public address and its version. So the model proposed one and the
   * derived form threw it away, which left three ways out and one of them is
   * built:
   *
   * - **rejected: taking the editor's free text as the title.** The prompt
   *   is up to {@link AI_PROMPT_MAX} characters of instructions to a model; the
   *   first sentence of it is not a name, and truncating it produces a form
   *   called „Ich brauche ein Formular für die Anmeldung zum Jahrestagung, mit…".
   * - **rejected: an invented default name** („KI-Formular vom 7.8."). It
   *   names nothing about the form, and every editor would rename it — so
   *   it is a field that is always wrong and always has to be corrected.
   * - **built: the model suggests, the human names.** Exactly the rule
   *   „aus einer Vorlage anlegen" already follows (`createFormRequestSchema`:
   *   „the dialog prefills it from the template's name, but the person creating
   *   the form is the one naming it"). The suggestion travels back as a
   *   *suggestion* and is never written by itself — adoption goes through
   *   `POST /api/forms`, whose `title` is the caller's, so nothing here can
   *   name a form without a human having seen the name.
   *
   * **Optional, and that is the same decision as „unknown keys are dropped"
   * above.** A model that answers with a perfectly good form and no title must
   * not cost the editor a second counted call (ADR-0015 no. 7) — the route
   * hands back `null` and the dialogue asks for a name, which it has to be able
   * to do anyway.
   *
   * Bounded by {@link formTitleSchema}, the *same* rule the create route
   * applies, because that is where this string is going. Bounding is all that
   * happens to it: escaping stays the renderer's job,
   * exactly as for the model identifier in `aiUsageSampleSchema`.
   */
  title: formTitleSchema.optional(),
  pages: z
    .object(tolerantShape(pageSchema.omit({ id: true, questions: true }).shape))
    .extend({ questions: z.array(aiDraftQuestionSchema) })
    .array()
    .min(1),
});

/**
 * How many variants the derived question union carries — the runtime half of
 * the guard of ADR-0015 no. 3(c).
 *
 * The guard itself is in `ai-form-draft.test.ts` and is an **equality**: this
 * number against `questionTypeSchema.options.length`, plus one probe per shared
 * type showing the derived union accepts it as a discriminator, plus one
 * showing an invented type is refused. Without it „abgeleitet, nicht parallel
 * gepflegt" is an intention — a seventeenth question type that never
 * reached this file would leave the model unable to produce it and nothing
 * would say so. Same construction as `env-contract.test.ts`, which checks its
 * four shores as an equality rather than as a superset.
 */
export const AI_DRAFT_QUESTION_VARIANTS = aiDraftQuestionSchema.options.length;

/**
 * Does the derived form accept this string as a question type?
 *
 * Asked of the **schema's behaviour** rather than of a list beside it: the
 * discriminated union answers a document whose `type` it does not know with an
 * issue *on the `type` field*, and a document whose type it does know with
 * issues about the fields that are missing. That difference is the whole test,
 * and it cannot go stale the way a second list can.
 */
export function aiDraftAcceptsQuestionType(type: string): boolean {
  const result = aiDraftQuestionSchema.safeParse({ type });
  if (result.success) {
    // A question consisting of nothing but its type has no required fields
    // left to miss — that would be a question type this application does not
    // have, and the caller should hear about it rather than get a `true`.
    return false;
  }
  return !result.error.issues.some(
    (issue) => issue.path.length === 1 && issue.path[0] === 'type',
  );
}

/**
 * Why a model answer was refused — and the sentence an editor reads.
 *
 * Three reasons rather than one „ungültig", because they are three different
 * pieces of news: `shape` says the answer is not a form at all, `definition`
 * says it is a form that breaks a rule of the schema, `condition` says it is a
 * form whose *Bedingte Anzeige* points nowhere. Only the last is a document a
 * human could plausibly have written too.
 */
export type AiFormDraftRefusal = 'shape' | 'definition' | 'condition';

/** What {@link adoptAiFormDraft} hands back — a result, never an exception. */
export type AiFormDraftAdoption =
  | {
      readonly ok: true;
      readonly definition: FormDefinition;
      /**
       * The name the model suggested, or `null` when it named none — never a
       * substitute one. See {@link aiFormDraftSchema}'s `title`: a suggestion
       * the dialogue prefills, not a title anything writes on its own.
       */
      readonly title: string | null;
    }
  | {
      readonly ok: false;
      readonly refusal: AiFormDraftRefusal;
      /** German, names *what* was wrong — never „das Modell hat Unsinn geliefert". */
      readonly message: string;
    };

/**
 * Longest refusal this file produces.
 *
 * A model answer can break a hundred rules at once, and a message assembled
 * from all of them would be a wall nobody reads and a log line nobody greps.
 * The cap is on the assembled sentence rather than on the number of issues, so
 * the first ones — the ones an editor acts on — always arrive whole.
 */
const MESSAGE_MAX = 400;

/** The lead every schema refusal opens with — one place, so three tests can name it. */
export const AI_DRAFT_INVALID_LEAD =
  'Die Antwort des Modells ist kein gültiges Formular';

/**
 * Turns a `ZodError` over the model's answer into one German sentence naming
 * the **path** and the rule.
 *
 * ⚠️ **This is the deliberate exception to „kein Zod-Pfad verlässt das Haus"**
 * (`FormsService.overrideFromTemplate` states the rule). ADR-0015 no. 3(b) is
 * explicit about it: *„Die Ablehnung ist die Zod-Fehlerpfadangabe, nicht ein
 * pauschales ‚das Modell hat Mist gebaut'."* The difference to the rule's own
 * case is who is being told and about what — here the reader is an editor
 * with `can_build` who just pressed a button, the paths name **our** field
 * names in a document **the model** wrote, and the one useful next step („den
 * Text anders formulieren, oder das Feld von Hand nachtragen") depends on
 * knowing which field it was.
 *
 * A Zod issue *message* can echo a key the model invented (Zod spells an
 * unrecognised key into its text). That is foreign text and is bounded like all
 * foreign text here: {@link MESSAGE_MAX} over the whole sentence.
 */
function describeDraftFailure(error: z.ZodError): string {
  const named = error.issues.map((issue) => {
    const path = issue.path.map(String).join('.');
    return path === '' ? issue.message : `${path}: ${issue.message}`;
  });
  const body = named.join(' · ');
  return `${AI_DRAFT_INVALID_LEAD} — ${
    body.length > MESSAGE_MAX ? `${body.slice(0, MESSAGE_MAX)}…` : body
  }`;
}

/**
 * **Takes a model answer and makes a form of it — or says why not** .
 *
 * `source` is `unknown` and stays `unknown` until the derived schema has had
 * it: this is foreign data, and `CONTRIBUTING.md` is not a style rule here but the
 * whole point.
 *
 * `newId` is handed in rather than taken from `node:crypto`, for the reason
 * every clock in this repository is handed in: a test that wants to see the
 * judge catch a **defective id assignment** has to be able to supply one, and
 * `packages/shared` has no business knowing which runtime it is in.
 *
 * Nothing is stored and nothing is sent — this is a pure function over one JSON
 * value. Where the result goes (a **new** form, never an open draft) is
 * ADR-0015 no. 11 and belongs to the route.
 */
export function adoptAiFormDraft(
  source: unknown,
  newId: () => string,
): AiFormDraftAdoption {
  const parsed = aiFormDraftSchema.safeParse(source);
  if (!parsed.success) {
    return {
      ok: false,
      refusal: 'shape',
      message: describeDraftFailure(parsed.error),
    };
  }

  // One id per question, minted **before** the walk, because a condition may
  // name a question that has not been reached yet — including one that comes
  // later, which is a document this function builds and the judge refuses.
  const questionIds = parsed.data.pages
    .flatMap((page) => page.questions)
    .map(() => newId());

  let cursor = 0;
  const pages = parsed.data.pages.map((page) => ({
    id: newId(),
    title: page.title,
    description: page.description,
    questions: page.questions.map((question) => {
      const { visibleIf, ...carried } = question;
      const id = questionIds[cursor] ?? newId();
      cursor += 1;
      if (!isRecord(visibleIf)) {
        return { ...carried, id };
      }
      const { [AI_DRAFT_CONDITION_TARGET]: target, ...comparison } = visibleIf;
      return {
        ...carried,
        id,
        visibleIf: {
          ...comparison,
          // An index naming no question resolves to a **freshly minted,
          // dangling** id, and that is the trick: the document then parses and
          // `findUnresolvableConditions` reports it as `missing`, with the
          // message that names the affected question. Refusing it here would
          // need a second refusal text saying the same thing in other words,
          // and the two would drift.
          questionId:
            (typeof target === 'number' ? questionIds[target] : undefined) ??
            newId(),
        },
      };
    }),
  }));

  // **The judge** (ADR-0015 no. 3(b)): the full schema with every refinement
  // the derived form had to drop. It also governs the id assignment above — a
  // `newId` that repeats itself is caught here as „Doppelte Frage-ID." rather
  // than trusted because we minted it ourselves.
  const definition = formDefinitionSchema.safeParse({ pages });
  if (!definition.success) {
    return {
      ok: false,
      refusal: 'definition',
      message: describeDraftFailure(definition.error),
    };
  }

  // The **same** function `FormsService.publish` runs, asked of the same
  // document. A form that reaches the editor from
  // here is one *Veröffentlichen* will not refuse for a condition.
  const unresolvable = findUnresolvableConditions({
    draft: definition.data,
    published: null,
  });
  if (unresolvable.length > 0) {
    return {
      ok: false,
      refusal: 'condition',
      message: unresolvableConditionMessage(unresolvable),
    };
  }

  return {
    ok: true,
    definition: definition.data,
    // `?? null` rather than leaving the field absent: „das Modell hat keinen
    // Namen vorgeschlagen" is an answer the dialogue acts on (it asks for one),
    // and an optional property would make that state indistinguishable from a
    // caller who forgot to read it.
    title: parsed.data.title ?? null,
  };
}
