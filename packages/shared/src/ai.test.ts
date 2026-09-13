import { describe, expect, it } from 'vitest';

import {
  AI_FAILURE_KINDS,
  AI_PROMPT_MAX,
  aiFailureKindSchema,
  aiUsageSampleSchema,
  buildAiFormRequest,
} from './ai.ts';

/**
 * The wire half of the AI seam (ADR-0015 no. 2 and no. 4): the closed failure
 * type, and the one function that builds what leaves this installation.
 */
describe('the closed failure type', () => {
  /**
   * **Six, and the number is the assertion.** The four of the requirement plus
   * `refused` and `unavailable`, each of which ADR-0015 no. 2 argues for
   * separately. A seventh kind is not forbidden — it is *conspicuous*: it
   * fails here, and whoever adds it has to say which sentence the dialogue
   * shows for it and whether a second attempt helps.
   */
  it('has exactly the six kinds the ADR names', () => {
    expect([...AI_FAILURE_KINDS].sort()).toEqual([
      'invalid_output',
      'rate_limited',
      'refused',
      'timeout',
      'truncated',
      'unavailable',
    ]);
  });

  it('is derived from the schema rather than written down twice', () => {
    // The array and the schema are the same list — a `switch` that is
    // exhaustive over one is exhaustive over the other.
    expect([...AI_FAILURE_KINDS].sort()).toEqual(
      [...aiFailureKindSchema.options].sort(),
    );
  });

  it('rejects a provider string that is not one of them', () => {
    expect(aiFailureKindSchema.safeParse('content_filter').success).toBe(false);
    expect(aiFailureKindSchema.safeParse('overloaded_error').success).toBe(
      false,
    );
  });
});

describe('buildAiFormRequest — what leaves this installation', () => {
  /**
   * **Two fields, and the key set is the assertion.** The canary search of
   * the requirement measures the serialised payload against a seeded Organisation, user,
   * form and answer (`apps/api/test/ai/payload-canaries.spec.ts`),
   * but it can only ever find what somebody thought to plant; this line
   * catches a *third field* of any name — including one nobody wrote a canary
   * for.
   */
  it('produces the free text and the language and nothing else', () => {
    const request = buildAiFormRequest({
      prompt: 'Bestandsmeldung',
      language: 'de',
    });
    expect(Object.keys(request).sort()).toEqual(['language', 'prompt']);
    expect(request).toEqual({ prompt: 'Bestandsmeldung', language: 'de' });
  });

  it('trims, because trailing whitespace is not a request', () => {
    expect(
      buildAiFormRequest({ prompt: '  Hallo  ', language: 'de' }).prompt,
    ).toBe('Hallo');
  });

  it('refuses an empty prompt', () => {
    expect(() =>
      buildAiFormRequest({ prompt: '   ', language: 'de' }),
    ).toThrow();
  });

  /**
   * **Rejected, never truncated.** A silently shortened prompt produces a form
   * nobody asked for — and costs a counted call to find out (ADR-0015 no. 7).
   */
  it('refuses a prompt over the shared limit instead of shortening it', () => {
    const tooLong = 'x'.repeat(AI_PROMPT_MAX + 1);
    expect(() =>
      buildAiFormRequest({ prompt: tooLong, language: 'de' }),
    ).toThrow(String(AI_PROMPT_MAX));
    expect(
      buildAiFormRequest({ prompt: 'x'.repeat(AI_PROMPT_MAX), language: 'de' })
        .prompt,
    ).toHaveLength(AI_PROMPT_MAX);
  });

  it('refuses a language that is not in the closed enumeration', () => {
    expect(() =>
      // The cast is the point: this is the shape a caller reaches for when it
      // wants a language the application does not have.
      buildAiFormRequest({ prompt: 'Hallo', language: 'en' as 'de' }),
    ).toThrow();
  });
});

/**
 * **The usage sample is the one value of this seam that comes from outside**
 * (ADR-0015 no. 7, `CONTRIBUTING.md`: foreign data is parsed, not cast).
 *
 * Both adapters read it off a provider answer, and only one of the two SDKs
 * validates that answer — the Anthropic one types it and no more. The schema is
 * what makes the two sides equally trustworthy before `ai-usage.ts` starts doing
 * arithmetic on these numbers and writing them into `ai_usage`.
 */
describe('the usage sample', () => {
  const VALID = {
    provider: 'anthropic',
    model: 'claude-opus-5',
    inputTokens: 412,
    outputTokens: 388,
  };

  it('accepts what a provider actually reports', () => {
    expect(aiUsageSampleSchema.parse(VALID)).toEqual(VALID);
  });

  it('accepts absent token counts, because not every provider reports them', () => {
    expect(
      aiUsageSampleSchema.parse({
        ...VALID,
        inputTokens: null,
        outputTokens: null,
      }).inputTokens,
    ).toBeNull();
  });

  it.each([
    { name: 'a token count that is a string', patch: { inputTokens: '412' } },
    { name: 'a fractional token count', patch: { outputTokens: 1.5 } },
    { name: 'a negative token count', patch: { inputTokens: -1 } },
    { name: 'an empty model identifier', patch: { model: '' } },
    {
      name: 'a model identifier of essay length',
      patch: { model: 'x'.repeat(129) },
    },
    {
      name: 'a provider nobody built an adapter for',
      patch: { provider: 'openai' },
    },
  ])('rejects $name', ({ patch }) => {
    expect(aiUsageSampleSchema.safeParse({ ...VALID, ...patch }).success).toBe(
      false,
    );
  });

  /**
   * **A provider-specific extra is stripped, not carried.** That is the second
   * job of this schema beside validation: it is the last place a `stop_reason`
   * or a `request_id` could ride along into `ai_usage` (ADR-0015 no. 2), and a
   * schema that passed unknown keys through would let it.
   */
  it('carries four fields and drops whatever else the provider sent', () => {
    const parsed = aiUsageSampleSchema.parse({
      ...VALID,
      stop_reason: 'end_turn',
      request_id: 'req_01',
    });
    expect(Object.keys(parsed).sort()).toEqual([
      'inputTokens',
      'model',
      'outputTokens',
      'provider',
    ]);
  });
});
