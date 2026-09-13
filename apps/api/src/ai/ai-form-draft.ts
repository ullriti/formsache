import { randomUUID } from 'node:crypto';

import { adoptAiFormDraft, buildAiFormRequest } from '@formsache/shared';
import type {
  AiFailureKind,
  AiUsageSample,
  FormDefinition,
  FormLanguage,
} from '@formsache/shared';

import type { AiFormGenerator } from './ai-form-generator';

/**
 * **One free text in, one form out — or one named failure** (* ADR-0015 no. 3 and no. 4).
 *
 * This is the whole of this mapping step on the API side: the step between the seam
 * (`AiFormGenerator`) and the route that will call it. It does three things and no fourth:
 *
 * 1. builds the outgoing payload with `buildAiFormRequest` — **the one place**
 *    it comes into being (ADR-0015 no. 4), so „was geht hinaus?" has a single
 *    answer to read;
 * 2. hands it to the seam together with the caller's deadline;
 * 3. runs the answer through `adoptAiFormDraft` — the derived parse, our own id
 *    assignment, the full `formSchema` judge and the publish-time condition
 *    check.
 *
 * **What it deliberately does not do** is the list that keeps it honest: it
 * knows no organisation and no user (ADR-0015 no. 1 — the seam has no tenant
 * parameter, and neither has this), it counts nothing (`ai_usage` is no. 7 and
 * belongs to the route, *before* the call), it stores nothing (no. 11 — the
 * form is created by the existing creation path when the editor presses
 * *Übernehmen*), and it logs nothing.
 *
 * That first absence is what `test/ai/payload-canaries.spec.ts` measures at the
 * bytes rather than at this sentence: an organisation, a user, a form and a submitted
 * answer exist, all four carrying unmistakable strings, and none of them
 * appears in the payload.
 */

/** What {@link generateAiFormDraft} hands back — a result, never an exception. */
export type AiFormDraftResult =
  | {
      readonly ok: true;
      readonly definition: FormDefinition;
      /**
       * The name the model suggested for the form, or `null`.
       *
       * It travels as a **suggestion**: the route hands it to the dialogue,
       * which prefills the name field with it, and the form is created through
       * `POST /api/forms`, whose `title` is the caller's — the same rule „aus
       * einer Vorlage anlegen" follows. Nothing here writes a title.
       */
      readonly title: string | null;
      readonly usage: AiUsageSample | null;
    }
  | {
      readonly ok: false;
      readonly failure: AiFailureKind;
      /**
       * What was wrong with an answer that *was* JSON — the German sentence
       * from `adoptAiFormDraft`, naming the field.
       *
       * `null` for every failure that happened before there was anything to
       * read (timeout, rate limit, refusal, unavailability) and for an answer
       * that was not JSON at all: there the adapter's `AiFailureKind` is the
       * whole of what is known, and inventing a sentence would suggest we saw
       * more than we did.
       *
       * It is **our** text about **our** schema — never the provider's prose,
       * which ends at the seam (ADR-0015 no. 2).
       */
      readonly detail: string | null;
      readonly usage: AiUsageSample | null;
    };

export interface AiFormDraftInput {
  readonly generator: AiFormGenerator;
  /**
   * The editor's free text, **already validated** by the caller.
   *
   * `buildAiFormRequest` throws on an empty or over-long one, and that is left
   * as a throw on purpose: the route parses its body against the shared
   * contract (`AI_PROMPT_MAX`) before it gets here, so reaching this line with
   * a bad prompt is a defect of ours and not news about the model. Turning it
   * into an `AiFailureKind` would file our own bug under „das Modell".
   */
  readonly prompt: string;
  readonly language: FormLanguage;
  /** Our deadline, minted by the caller (ADR-0015 no. 6) — never the SDK's. */
  readonly signal: AbortSignal;
  /**
   * How a fresh id is minted. Present so a test can hand in a broken one and
   * watch the judge catch it; production has exactly one answer.
   */
  readonly newId?: () => string;
}

export async function generateAiFormDraft(
  input: AiFormDraftInput,
): Promise<AiFormDraftResult> {
  const request = buildAiFormRequest({
    prompt: input.prompt,
    language: input.language,
  });

  const outcome = await input.generator.generate(request, input.signal);
  if (!outcome.ok) {
    return {
      ok: false,
      failure: outcome.failure,
      detail: null,
      usage: outcome.usage,
    };
  }

  // The answer is `unknown` here and has been through nothing but `JSON.parse`
  // (`model-json.ts`). This is the line the requirement is about.
  const adoption = adoptAiFormDraft(outcome.draft, input.newId ?? randomUUID);
  if (!adoption.ok) {
    return {
      // „JSON, das Schema nicht erfüllt" is `invalid_output` by definition
      // (ADR-0015 no. 2) — the same case a non-JSON answer lands in, because
      // the editor's next move is the same one: rephrase and try again.
      // What tells the two apart for a human is `detail`.
      ok: false,
      failure: 'invalid_output',
      detail: adoption.message,
      usage: outcome.usage,
    };
  }

  return {
    ok: true,
    definition: adoption.definition,
    title: adoption.title,
    usage: outcome.usage,
  };
}
