import { describe, expect, it } from 'vitest';

import {
  MAIL_ERROR_MAX_LENGTH,
  MAIL_ERROR_REDACTION,
  describeMailError,
} from './mail-error';

/**
 * The reason a failed delivery leaves behind (the requirements).
 *
 * The redaction is covered **here** and not in `test/mail/smtp-credentials.spec.ts`,
 * and the reason is worth writing down: that integration test stays green with
 * the redaction removed, because the current `nodemailer` does not echo the
 * password into the message of a refused login. The end-to-end case therefore
 * proves „nothing leaked on this run"; only the unit case below proves that the
 * fence exists at all. Both are needed — a fence nobody tests is a fence that
 * disappears in the next refactor, and the day a library version starts
 * quoting the credentials it would take this guarantee with it.
 */
describe('describeMailError', () => {
  it('keeps the transport’s own wording', () => {
    expect(describeMailError(new Error('550 mailbox unavailable'))).toBe(
      '550 mailbox unavailable',
    );
  });

  it('replaces a configured credential wherever it appears', () => {
    const password = 'sehr-geheim-1234';
    const reason = describeMailError(
      new Error(`535 authentication failed for pass=${password} on host`),
      [password],
    );
    expect(reason).not.toContain(password);
    expect(reason).toContain(MAIL_ERROR_REDACTION);
    // The rest survives — a reason reduced to asterisks is unreadable, and an
    // editor has to be able to tell a rejected login from a rejected address.
    expect(reason).toContain('535 authentication failed');
  });

  it('leaves an absent or trivially short credential alone', () => {
    // A two-character password would match half of every message; blanking
    // those would destroy the reason without protecting anything.
    expect(
      describeMailError(new Error('no such host: ab'), [undefined, 'ab']),
    ).toBe('no such host: ab');
  });

  it('bounds the length', () => {
    const reason = describeMailError(new Error('x'.repeat(5_000)));
    expect(reason.length).toBe(MAIL_ERROR_MAX_LENGTH);
  });

  it('answers something readable for a non-Error', () => {
    expect(describeMailError('kaputt')).not.toBe('');
    expect(describeMailError(new Error('   '))).not.toBe('');
  });
});
