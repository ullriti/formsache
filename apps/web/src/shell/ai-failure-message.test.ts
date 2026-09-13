import { describe, expect, it } from 'vitest';
import { AI_FAILURE_KINDS } from '@formsache/shared';

import { aiFailureMessage } from './ai-failure-message';

/**
 * Every named failure has a sentence, and no two of them share one.
 *
 * The list is walked out of `AI_FAILURE_KINDS` rather than written down again:
 * a seventh kind added to the shared enumeration lands in this loop by itself.
 * The compiler already refuses a `Record` with a hole — this is the runtime
 * half, and it is what catches the *other* way of going wrong, where somebody
 * satisfies the compiler by copying a neighbouring sentence.
 *
 * The distinctness assertion is the point of the file. „Das hat nicht geklappt"
 * six times would pass every type check there is and would throw away the whole
 * reason `aiFailureKindSchema` is a closed union: „nochmal versuchen" helps
 * after a timeout and is useless after a refusal.
 */
describe('aiFailureMessage', () => {
  it('has one sentence per named failure', () => {
    for (const kind of AI_FAILURE_KINDS) {
      const message = aiFailureMessage(kind);
      expect(message.length).toBeGreaterThan(0);
      // No enum member leaks into the interface — an editor reads German,
      // not `rate_limited`.
      expect(message).not.toContain(kind);
    }
  });

  it('says something different for each of them', () => {
    const messages = AI_FAILURE_KINDS.map(aiFailureMessage);

    expect(new Set(messages).size).toBe(AI_FAILURE_KINDS.length);
  });

  /**
   * The two that decide whether a second attempt is worth anything — the
   * distinction the six cases exist for at all.
   */
  it('offers a retry after a timeout and a rewording after a refusal', () => {
    expect(aiFailureMessage('timeout')).toMatch(/Versuch/);
    expect(aiFailureMessage('refused')).toMatch(/anders beschreiben/);
  });
});
