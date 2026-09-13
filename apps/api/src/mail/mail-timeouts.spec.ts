import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_MAIL_TIMEOUTS,
  mailSendTimeoutReason,
  withSendDeadline,
} from './mail-timeouts';

/**
 * The ordering of the shipped timeouts, and the deadline helper itself.
 *
 * A unit test rather than a comment, because the numbers are only correct
 * *relative to each other*: raising `socketMs` past `sendMs`, or `sendMs` past
 * `claimTransactionMs`, brings back the failure `mail-timeouts.ts` describes —
 * a delivery that outlives its own transaction, leaves the row untouched and is
 * therefore due again on the next tick, forever. Nothing else in the suite would
 * notice; that combination only shows itself against a mail server that hangs.
 */
describe('mail timeouts', () => {
  it('keeps every transport timeout below the send deadline', () => {
    const t = DEFAULT_MAIL_TIMEOUTS;
    expect(t.connectionMs).toBeLessThan(t.sendMs);
    expect(t.greetingMs).toBeLessThan(t.sendMs);
    expect(t.socketMs).toBeLessThan(t.sendMs);
  });

  it('keeps the send deadline clearly below the transaction budget', () => {
    const t = DEFAULT_MAIL_TIMEOUTS;
    // „Clearly" is the point: the status write happens *after* the send, inside
    // the same transaction, so the two must not be able to end together.
    expect(t.sendMs).toBeLessThanOrEqual(t.claimTransactionMs * 0.9);
  });

  it('rejects with a readable reason once the deadline passes', async () => {
    vi.useFakeTimers();
    try {
      const forever = new Promise<void>(() => undefined);
      const raced = withSendDeadline(forever, 5_000);
      const settled = raced.then(
        () => 'resolved',
        (error: unknown) => (error instanceof Error ? error.message : 'other'),
      );

      await vi.advanceTimersByTimeAsync(5_000);

      expect(await settled).toBe(mailSendTimeoutReason(5_000));
      // The sentence names seconds, not milliseconds: it is read by an editor
      // in the mail log, not by an operator in a log.
      expect(mailSendTimeoutReason(5_000)).toContain('5 Sekunden');
      // …and it is grammatical at a compressed test scale too.
      expect(mailSendTimeoutReason(500)).toContain('1 Sekunde ');
      expect(mailSendTimeoutReason(90_000)).toContain('90 Sekunden');
    } finally {
      vi.useRealTimers();
    }
  });

  it('hands a send that finishes in time straight through', async () => {
    await expect(withSendDeadline(Promise.resolve('ok'), 60_000)).resolves.toBe(
      'ok',
    );
  });

  /**
   * A send that rejects *after* its deadline must not become an unhandled
   * rejection — that would take the process down and trade an unbounded retry
   * loop for an unbounded restart loop.
   */
  it('swallows a rejection that arrives after the deadline', async () => {
    vi.useFakeTimers();
    try {
      let fail: (error: Error) => void = () => undefined;
      const late = new Promise<void>((_resolve, reject) => {
        fail = reject;
      });
      const raced = withSendDeadline(late, 1_000).catch(() => 'timed out');

      await vi.advanceTimersByTimeAsync(1_000);
      expect(await raced).toBe('timed out');

      fail(new Error('ECONNRESET, long after nobody was listening'));
      // Nothing to assert beyond „this run did not die": an unhandled rejection
      // fails the process, not this expectation.
      await vi.advanceTimersByTimeAsync(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
