import { describe, expect, it } from 'vitest';

import {
  MAIL_BACKOFF_BASE_MS,
  MAIL_BACKOFF_MAX_MS,
  mailBackoffMs,
} from './mail-backoff';

/**
 * The backoff as arithmetic.
 *
 * The queue-side proof — „does the claim actually honour `next_attempt_at`" —
 * lives in `test/mail/mail-queue.spec.ts` against a real database. This file
 * covers the half that needs no database, and the assertion that matters is
 * the **relation between two consecutive waits**: „liegt in der Zukunft"
 * survives any constant, and a constant is exactly what a backoff must not be
 * („Falle 1").
 */
describe('mailBackoffMs (the growing-gap proof)', () => {
  it('waits the base interval after the first failure', () => {
    expect(mailBackoffMs(1)).toBe(MAIL_BACKOFF_BASE_MS);
  });

  it('grows from one failure to the next', () => {
    const waits = [1, 2, 3, 4].map((attempt) => mailBackoffMs(attempt));
    for (let index = 1; index < waits.length; index += 1) {
      const previous = waits[index - 1];
      const current = waits[index];
      expect(previous).toBeDefined();
      expect(current).toBeDefined();
      expect(current ?? 0).toBeGreaterThan(previous ?? 0);
    }
  });

  it('never exceeds the ceiling, however many failures there were', () => {
    expect(mailBackoffMs(50)).toBe(MAIL_BACKOFF_MAX_MS);
  });

  it('treats a nonsensical attempt count as the first one', () => {
    // Defensive rather than reachable: the worker counts from one. A negative
    // exponent would produce a wait *shorter* than the base — the one failure
    // mode of an exponential backoff that turns it into a hot loop.
    expect(mailBackoffMs(0)).toBe(MAIL_BACKOFF_BASE_MS);
  });
});
