import { aiFormDraftSchema } from '@formsache/shared';
import { z } from 'zod';

/**
 * **The derived form, in the language the providers speak** (* ADR-0015 no. 3).
 *
 * The concept doc names „Structured Output → Formular-Schema (Zod-validiert)".
 * Until this file existed only the second half was built: the answer was parsed
 * hard against `formSchema` and anything else refused, but **no schema was ever
 * handed to the provider** — the model was asked for JSON in prose. That is a
 * hit-rate problem, not a safety one, and it is the one this file addresses.
 *
 * ⚠️ **The parse is untouched, and that is the point.** What
 * leaves here is a *hint*: it tells the model what shape to aim for. The judge
 * is still `adoptAiFormDraft` — the derived Zod parse, our own id assignment,
 * the full `formSchema` with every refinement, and `findUnresolvableConditions`.
 * A provider that answers nonsense with the schema set is refused exactly as it
 * was before (`test/ai/form-draft.spec.ts` measures that for both adapters, on
 * a request whose body carries the schema).
 *
 * ## Derived, never written a second time
 *
 * `z.toJSONSchema(aiFormDraftSchema)` — one call, no second description of a
 * form anywhere. `aiFormDraftSchema` is itself derived from `formSchema`
 * (`packages/shared/src/ai-form-draft.ts`), so a seventeenth question type
 * reaches the provider without anybody remembering this file. The runtime
 * half of that guard is {@link AI_FORM_JSON_SCHEMA_TYPES}, checked as an
 * **equality** against `questionTypeSchema.options` in
 * `test/ai/form-json-schema.spec.ts`.
 *
 * ## Two mechanical normalisations, and why each
 *
 * 1. **`$schema` is dropped.** Zod stamps the meta-schema URI on the root.
 *    Neither provider's field is a standalone JSON-Schema document — one is a
 *    tool's `input_schema`, the other a `response_format` payload — and a
 *    dialect declaration in there is at best ignored and at worst rejected.
 * 2. **`oneOf` becomes `anyOf`.** Zod renders a discriminated union as `oneOf`;
 *    both providers' documented keyword lists name `anyOf` and neither names
 *    `oneOf`. For a *discriminated* union the two are equivalent — the branches
 *    are mutually exclusive by construction, so „exactly one matches" and „at
 *    least one matches" select the same branch. This is a rename, not a
 *    loosening of anything the judge checks.
 *
 * Both are applied by {@link normalise} to the tree Zod produced. Neither adds
 * a fact about the form; a test asserts that no `oneOf` and no `$schema`
 * survive, so „mechanisch" is measured rather than claimed.
 *
 * ## What is deliberately **not** done: `strict` / enforced structured output
 *
 * Both providers offer a stricter mode (Anthropic `strict: true` on the tool,
 * Mistral `strict: true` on the JSON schema) in which the provider *validates*
 * the schema and constrains decoding to it. Both require a schema this one is
 * not: every object closed with `additionalProperties: false` and **every**
 * property listed in `required`. The derived form has genuinely optional fields
 * (`title`, `visibleIf`, `addRows`) and carries the length and range bounds
 * that strict mode rejects outright, so turning the flag on would mean either a
 * rejected request on **every** call — mapped to `unavailable`, the least
 * informative of the six failures — or a second, hand-shaped schema, which is
 * the duplication this whole file exists to avoid.
 *
 * ⚠️ And the honest half: **nothing here has ever run against a live
 * provider** (no key in this environment, `ai-form-generator.ts`), so „strict
 * would be rejected" is read off the providers' documented constraints, not
 * measured. Switching it on is therefore a decision for a future test run with a
 * configured key, not one to take blind. Until then the schema travels as a
 * hint and the judge does the work — which is the arrangement chosen here.
 */

/** The name both providers see for the document they are asked to produce. */
export const AI_FORM_TOOL_NAME = 'emit_form';

/**
 * What the tool is for, in one sentence.
 *
 * Static, like everything else that leaves (ADR-0015 no. 4) — nothing about
 * this organisation, this user or this installation is interpolated.
 */
export const AI_FORM_TOOL_DESCRIPTION = [
  'Hand back the finished form.',
  'Call this exactly once, with the complete form document as its input,',
  'and write nothing else.',
].join(' ');

/**
 * The shape the outgoing schema has to hold — checked at startup, not assumed.
 *
 * `looseObject` rather than the strict default: unknown top-level keys are
 * **kept**, because a future Zod release that adds one would otherwise have it
 * silently stripped from what goes out. What the four named keys buy is the
 * type: an object type (not an interface) with these members is assignable to
 * the Anthropic SDK's `Tool.InputSchema` without a cast.
 */
const generatedJsonSchema = z.looseObject({
  type: z.literal('object'),
  properties: z.record(z.string(), z.unknown()),
  required: z.array(z.string()),
  /** Where `reused: 'ref'` puts the shared sub-schemas — see the size note. */
  $defs: z.record(z.string(), z.unknown()).optional(),
});

export type AiFormJsonSchema = z.infer<typeof generatedJsonSchema>;

/**
 * Rewrites the tree Zod produced — see the file comment for both rules.
 *
 * A fresh object per node rather than a mutation, so the value Zod handed back
 * stays untouched and the result is plain JSON with no prototype of its own.
 */
function normalise(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(normalise);
  }
  if (typeof node !== 'object' || node === null) {
    return node;
  }
  const rewritten: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === '$schema') {
      continue;
    }
    rewritten[key === 'oneOf' ? 'anyOf' : key] = normalise(value);
  }
  return rewritten;
}

function buildFormJsonSchema(): AiFormJsonSchema {
  /**
   * `io: 'input'` is the side that matters: the model produces what the schema
   * *accepts*, not what it yields. The output side is not even expressible —
   * `aiFormDraftSchema` carries transforms, and `z.toJSONSchema(…, { io:
   * 'output' })` throws („Transforms cannot be represented in JSON Schema").
   *
   * `reused: 'ref'` lifts every shared sub-schema into `$defs`. It is a size
   * decision and a large one: inlined, the same schema is **38 017 bytes**;
   * with refs it is **12 142** (re-measured 2026-08-14). That difference rides
   * on every single call, in tokens the organisation pays for.
   *
   * ⚠️ **`reused: 'ref'` hoists by *object identity*, which makes it a
   * constraint on the derivation and not only on this line.** When
   * `aiFormDraftSchema` gained its tolerance for missing keys
   * (`ai-form-draft.ts`, `tolerantField`), the first version rebuilt every
   * field per call site — the one shared option list became three separate
   * instances, was inlined three times instead of standing once behind a
   * `$ref`, and this figure went from 12 171 to 13 115 bytes for no gain. The
   * memo in that function is what holds the identity together; the number above
   * is the measurement that says it works (the tolerance itself is *free* here:
   * every `"default": null` it adds is paid for by a name it removes from a
   * `required` list).
   */
  const generated = normalise(
    z.toJSONSchema(aiFormDraftSchema, { io: 'input', reused: 'ref' }),
  );
  const parsed = generatedJsonSchema.safeParse(generated);
  if (!parsed.success) {
    // Not a `null` fallback: a schema we cannot vouch for must not travel as
    // though we could, and a start that fails here names a defect of ours
    // rather than producing calls that quietly lost their schema.
    throw new Error(
      `The derived AI form JSON schema is not an object schema: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/**
 * **The JSON Schema both adapters put on the wire** — Anthropic as the
 * `input_schema` of the one tool it offers, Mistral as the `schema` of its
 * `response_format`.
 *
 * Built once at module load (~9 ms, measured) because it never varies: it is a
 * function of `aiFormDraftSchema` and of nothing else — no tenant, no user, no
 * configuration.
 */
export const AI_FORM_JSON_SCHEMA: AiFormJsonSchema = buildFormJsonSchema();

/**
 * Every question type the outgoing schema offers, read **out of the schema**.
 *
 * The guard of ADR-0015 no. 3(c), extended one step further: the shared test
 * compares this against `questionTypeSchema.options` as an **equality**, so a
 * question type that reaches `aiFormDraftSchema` but not the JSON rendering —
 * or the other way round — turns red instead of silently narrowing what a
 * model may propose.
 */
export const AI_FORM_JSON_SCHEMA_TYPES: readonly string[] =
  collectQuestionTypes(AI_FORM_JSON_SCHEMA);

/**
 * Walks the schema for the `const` values sitting on a `type` property.
 *
 * That is precisely where a discriminated union puts its discriminator, and
 * asking the *rendered* schema rather than a list beside it is the whole point:
 * a list would go stale, the walk cannot.
 */
function collectQuestionTypes(schema: AiFormJsonSchema): readonly string[] {
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== 'object' || node === null) {
      return;
    }
    const record: Record<string, unknown> = { ...node };
    const discriminator = record.type;
    if (
      typeof discriminator === 'object' &&
      discriminator !== null &&
      typeof (discriminator as { const?: unknown }).const === 'string'
    ) {
      found.add((discriminator as { const: string }).const);
    }
    Object.values(record).forEach(walk);
  };
  walk(schema);
  return [...found];
}
