/**
 * **The one place a model's text becomes `unknown`** — shared by both
 * adapters, so the `invalid_output` row of the contract table means the same
 * thing in both columns.
 *
 * It does exactly two things and neither of them is validation: it peels a
 * markdown fence if the model wrapped one around its answer, and it runs
 * `JSON.parse`. Whether the result *is* a form is decided by `formSchema` in
 * `adoptAiFormDraft`, against the full schema including every refinement — this
 * function must never grow an opinion about that, or there would be two places
 * that judge a draft.
 *
 * ## One thing measured here, to be checked once more in `adoptAiFormDraft`
 *
 * A `"__proto__"` key in the model's answer survives `JSON.parse` as an
 * **own, enumerable** property; the object's prototype stays clean (measured:
 * `Object.getPrototypeOf` unchanged, `({}).polluted === undefined`). So there
 * is no finding at this line — `JSON.parse` is the safe reader, unlike an
 * object literal assignment.
 *
 * It is written down because **this application has an inheritance merge**
 * (Tenant-Vorgabe ↔ `settings_override`), and a draft is the first foreign
 * object that will travel towards one. The check point for `adoptAiFormDraft` is therefore
 * not this function but what happens *after* the `formSchema` parse: Zod drops
 * unknown keys, so `__proto__` should not survive it — and that is worth one
 * assertion in the package that introduces the parse, not a claim here.
 */

/**
 * The result of one parse.
 *
 * A tagged pair rather than „the value, or a sentinel": `unknown | Sentinel`
 * collapses back to `unknown` in TypeScript, so the caller would have had no
 * type-level way to tell a failed parse from a draft that happens to be a
 * symbol. The same reason `AiFormOutcome` is a union rather than a nullable
 * draft.
 */
export type ParsedModelJson =
  { readonly ok: true; readonly value: unknown } | { readonly ok: false };

/**
 * Strips a leading ```/```json fence and its closing counterpart.
 *
 * Present because the alternative is a class of production failures that no
 * test would ever see: a model that obeys „a single JSON document" and still
 * wraps it, as models routinely do, would turn every call into
 * `invalid_output` — a counted, paid call that failed on punctuation. The
 * schema included in the outgoing request makes this redundant for the providers that support
 * it; it stays because `AI_MODEL` is operator-configurable and not every
 * pinned model does.
 *
 * Only a fence that opens on the **first** line and closes on the **last** is
 * removed. Anything more forgiving would start reassembling text, and text
 * reassembly is how a partial answer turns into a document that parses.
 */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```') || !trimmed.endsWith('```')) {
    return trimmed;
  }
  const firstBreak = trimmed.indexOf('\n');
  if (firstBreak === -1) {
    return trimmed;
  }
  // The opening line may carry a language tag (```json) and nothing else; a
  // line with more on it is not a fence and is left alone.
  const opener = trimmed.slice(3, firstBreak).trim();
  if (opener !== '' && !/^[A-Za-z0-9_-]+$/.test(opener)) {
    return trimmed;
  }
  return trimmed.slice(firstBreak + 1, trimmed.length - 3).trim();
}

/**
 * Parses the model's answer, or reports that it is not JSON.
 *
 * Returns `unknown` on purpose — the value has been through no schema and must
 * not look as though it has (CONTRIBUTING.md: foreign data arrives as `unknown`).
 */
export function parseModelJson(text: string): ParsedModelJson {
  const candidate = stripCodeFence(text);
  if (candidate === '') {
    return { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(candidate) as unknown };
  } catch {
    return { ok: false };
  }
}
