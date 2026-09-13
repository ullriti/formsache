import type { AnswerValue, FormDefinition } from '@formsache/shared';
import { answerValueSchema, safeParseAnswers } from '@formsache/shared';

/**
 * Answers read back off the wire, as values `FillIn` may render — **parsed,
 * not asserted** (`CONTRIBUTING.md`).
 *
 * Shared by `ResponseEditView` (a submitted answer, `response.answers`) and
 * `ResponseDraftView` (a saved draft, `response_draft.answers`): both are
 * `Record<string, unknown>` on the wire for the same reason — the shape
 * belongs to the form's definition, not to a second, weaker description here
 * that an attacker would aim at — and both hand `FillIn` the very values it is
 * about to prefill. Casting either straight to `Record<string, AnswerValue>`
 * would be a claim neither side had checked: a stray object in one key would
 * reach an `<input>` as `[object Object]` and be saved back that way.
 *
 * Two steps, and the second is the one that matters:
 *
 * 1. **Against the snapshot** (`safeParseAnswers`), which is what the server
 *    validated the document against on the way in. Normally this succeeds and
 *    nothing else runs.
 * 2. **Per entry, by shape**, if it does not. The server deliberately does not
 *    re-validate a stored document on the way out — „weil ein strenger
 *    gewordener Schnappschuss sonst eine Antwort ergäbe, die niemand mehr
 *    öffnen kann" — and dropping every prefilled value at that point would
 *    hand the participant an empty form to retype, which is worse than the
 *    strictness it came from. So each value is kept if it is *a* possible
 *    answer, and left out if it is not.
 */
export function storedAnswers(
  definition: FormDefinition,
  stored: Record<string, unknown>,
): Record<string, AnswerValue> {
  const parsed = safeParseAnswers(definition, stored);
  const source: Record<string, unknown> = parsed.success ? parsed.data : stored;

  const answers: Record<string, AnswerValue> = {};
  for (const [id, value] of Object.entries(source)) {
    const answer = answerValueSchema.safeParse(value);
    if (answer.success) {
      answers[id] = answer.data;
    }
  }
  return answers;
}
