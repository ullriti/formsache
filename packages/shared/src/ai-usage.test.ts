import { describe, expect, it } from 'vitest';

import {
  AI_MONTHLY_CALL_LIMIT_MAX,
  AI_PROMPT_RETENTION_DAYS,
  DEFAULT_AI_MONTHLY_CALL_LIMIT,
  aiQuotaRemaining,
  aiQuotaWriteSchema,
} from './ai-usage.ts';

/**
 * **The two numbers of the AI usage — pinned down, not merely used.**
 *
 * ## Why this file exists
 *
 * It is a **review finding** (security check, 2026-08-10). `AI_PROMPT_RETENTION_DAYS` is the only source for the
 * purge *and* for the hint the dialogue makes about the retention — that is
 * built correctly and is covered by tests. What was not covered was only **the
 * number itself**. The counter-check: `30` set to `3650`, everything green —
 * 50 files and 1463 assertions in `packages/shared`, the five cases of the
 * purge, the nineteen of the dialogue. Not a single signal.
 *
 * What breaks in the process is no display: it is the deletion promise from
 * the specification towards everybody who has typed a free text into this field — and
 * the interface **dutifully writes along** the new number, because it reads the
 * same constant. A tool that extends a period and on top of that pulls the
 * promise along with it is exactly the build shape a pinned number stands
 * against.
 *
 * Both sister periods have carried this line for a long time
 * (`trash.test.ts`, `mail.test.ts`); this is the third.
 */
describe('AI_PROMPT_RETENTION_DAYS', () => {
  it('sind 30 Tage — dieselbe Frist wie der Papierkorb', () => {
    // The number stands in the concept, in ADR-0015 no. 8 and in the record
    // of processing activities. Whoever changes it here changes a promise
    // towards people, not a setting.
    expect(AI_PROMPT_RETENTION_DAYS).toBe(30);
  });
});

/**
 * **The quota** (ADR-0015 no. 7 and no. 9).
 *
 * The server-side enforcement is measured by
 * `apps/api/test/admin/ai-quota.spec.ts` at the real route. What stands here
 * are the statements of the *contract* — the places at which a second reader
 * (the interface) has to assume the same meaning as the counter.
 */
describe('das Kontingent', () => {
  it('fängt bei 50 an und lässt sich nicht auf 0 vorbelegen', () => {
    // ADR-0015 no. 7: the default is an **assumption**, not a measurement —
    // and it is deliberately not 0, because a zero as the default would be the
    // quiet variant of the very error this default protects against:
    // everything set up, everything reachable, every call against a 429.
    expect(DEFAULT_AI_MONTHLY_CALL_LIMIT).toBe(50);
    expect(DEFAULT_AI_MONTHLY_CALL_LIMIT).toBeGreaterThan(0);
  });

  it('nimmt 0 an — der Aus-Schalter je Organisation', () => {
    // **The expensive misreading would be „unlimited".** A schema with
    // `positive()` would block the only way to switch the feature off for an
    // organisation without somebody having to touch the environment
    // (ADR-0015 no. 9).
    expect(aiQuotaWriteSchema.safeParse({ monthlyCallLimit: 0 }).success).toBe(
      true,
    );
  });

  it('weist ab, was eine Rechnung wäre statt einer Zahl', () => {
    for (const monthlyCallLimit of [
      -1,
      1.5,
      AI_MONTHLY_CALL_LIMIT_MAX + 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(aiQuotaWriteSchema.safeParse({ monthlyCallLimit }).success).toBe(
        false,
      );
    }
  });

  it('lässt kein zweites Feld einreisen', () => {
    // `strictObject`: a `used` or a `tenantId` in the body would be a write
    // path onto a number the server keeps itself.
    expect(
      aiQuotaWriteSchema.safeParse({ monthlyCallLimit: 5, used: 0 }).success,
    ).toBe(false);
  });

  it('rechnet den Rest nie negativ, auch nach einer Senkung', () => {
    // A lowered quota does not undo calls that have been used up — `used` may
    // lie above `limit`. The display then says „0 übrig", not „-7 übrig", and
    // the counter refuses.
    expect(aiQuotaRemaining({ used: 12, limit: 5 })).toBe(0);
    expect(aiQuotaRemaining({ used: 2, limit: 5 })).toBe(3);
  });
});
