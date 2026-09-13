import { describe, expect, it } from 'vitest';

import {
  categoriseMailError,
  MAIL_CATEGORY_AUTH,
  MAIL_CATEGORY_REJECTED,
  MAIL_CATEGORY_UNREACHABLE,
} from './mail-error-category';
import { mailSendTimeoutReason } from './mail-timeouts';

/**
 * **What an organisation's own mail server may say about itself** (ADR-0013 no. 4).
 *
 * The file's promise is not „lesbar" — that would be satisfied by the
 * transcript — it is „lesbar *und* kein Orakel": the reader picks the host, so
 * every distinction the reason draws is a distinction they can ask for on
 * purpose.
 *
 * The case that carries this file is therefore the one that asserts two
 * *different* failures produce the **same** sentence. Until an earlier review,
 * `127.0.0.1:6379` (open, not an SMTP server) gave „nicht rechtzeitig
 * geantwortet" and `127.0.0.1:6380` (closed) gave „nicht erreichbar", so the
 * mail log answered „is this port open?" — while the file's own header
 * claimed that any finer distinction would be scanner information.
 */

const OWN_DEADLINE = mailSendTimeoutReason(90_000);

/** A `nodemailer` error, shaped like the real thing: message plus `code`. */
function smtpError(code: string, message: string): Error {
  const error: Error & { code?: string } = new Error(message);
  error.code = code;
  return error;
}

describe('categorising an organisation’s own mail server failure', () => {
  it('answers a closed port and an open one that stalls with the same sentence', () => {
    const refused = categoriseMailError(
      smtpError('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:6380'),
      OWN_DEADLINE,
    );
    const stalled = categoriseMailError(
      smtpError('ETIMEDOUT', 'Greeting never received 127.0.0.1:6379'),
      OWN_DEADLINE,
    );

    expect(refused).toBe(MAIL_CATEGORY_UNREACHABLE);
    expect(stalled).toBe(refused);
  });

  it('keeps the socket-level codes in that same category', () => {
    for (const code of ['ECONNECTION', 'ENOTFOUND', 'EDNS', 'ESOCKET']) {
      expect(categoriseMailError(smtpError(code, 'x'), OWN_DEADLINE)).toBe(
        MAIL_CATEGORY_UNREACHABLE,
      );
    }
  });

  it('says nothing the remote said', () => {
    const reason = categoriseMailError(
      smtpError('ECONNREFUSED', 'connect ECONNREFUSED 169.254.169.254:80'),
      OWN_DEADLINE,
    );
    expect(reason).not.toContain('169.254.169.254');
    expect(reason).not.toContain('ECONNREFUSED');
  });

  it('still tells an editor to look at the login, and at the mail', () => {
    // The two distinctions that survive, and both need a real SMTP server to
    // reach: they are answers to „was ist zu tun", not to „was steht offen".
    expect(categoriseMailError(smtpError('EAUTH', '535'), OWN_DEADLINE)).toBe(
      MAIL_CATEGORY_AUTH,
    );
    expect(
      categoriseMailError(smtpError('EENVELOPE', '550'), OWN_DEADLINE),
    ).toBe(MAIL_CATEGORY_REJECTED);
    // Fail closed: an unknown code becomes coarser, never more talkative.
    expect(categoriseMailError(new Error('anything'), OWN_DEADLINE)).toBe(
      MAIL_CATEGORY_REJECTED,
    );
  });

  it('keeps our own send deadline verbatim', () => {
    // The residual named in the file's header: it is our sentence about a budget
    // we chose, and it is the only reason that explains an attempt which ended
    // without any answer at all.
    expect(categoriseMailError(new Error(OWN_DEADLINE), OWN_DEADLINE)).toBe(
      OWN_DEADLINE,
    );
  });
});
