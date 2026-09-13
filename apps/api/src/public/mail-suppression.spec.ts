import { describe, expect, it } from 'vitest';

import {
  HONEYPOT_SUPPRESSION_REASON,
  MAIL_BUDGET_EXCEEDED_REASON,
  budgetWindowStart,
  capMails,
} from './mail-suppression';
import { UNRESOLVED_RECIPIENT_REASON } from './submission-mail';
import type { PendingMail } from './submission-mail';

/**
 * The pure half of the two suppressions — the half that can be
 * exercised by calling it rather than by standing up a database.
 *
 * **What is deliberately *not* proven here:** that either measure ever fires.
 * That is a statement about `public-forms.service.ts` inside a transaction, and
 * it is made where it is measurable — `test/public/mail-budget.spec.ts` and
 * `test/public/honeypot-suppression.spec.ts`, both of which count rows in
 * `response` **first** and rows in `mail_log` second. A unit test that only
 * showed this function capping a list would be green with the call site missing
 * entirely, which is the failure mode this was built to avoid.
 */

function queued(recipient: string): PendingMail {
  return {
    notificationId: '019ffd00-0000-7000-8000-000000000001',
    trigger: 'submit',
    recipient,
    subject: 'Anmeldung eingegangen',
    bodyText: 'Danke.',
    bodyHtml: null,
    replyTo: null,
    status: 'queued',
    lastError: null,
  };
}

/** A row `submissionMails` already refused — it is not a mail. */
function alreadyFailed(): PendingMail {
  return {
    ...queued('nicht-lesbar'),
    status: 'failed',
    lastError: UNRESOLVED_RECIPIENT_REASON,
  };
}

describe('capMails', () => {
  it('lets everything through while the allowance covers it', () => {
    const capped = capMails(
      [queued('a@example.org'), queued('b@example.org')],
      5,
      MAIL_BUDGET_EXCEEDED_REASON,
    );

    expect(capped.map((mail) => mail.status)).toStrictEqual([
      'queued',
      'queued',
    ]);
    expect(capped.every((mail) => mail.lastError === null)).toBe(true);
  });

  it('caps per row, not per submission', () => {
    const capped = capMails(
      [
        queued('a@example.org'),
        queued('b@example.org'),
        queued('c@example.org'),
      ],
      1,
      MAIL_BUDGET_EXCEEDED_REASON,
    );

    expect(capped.map((mail) => mail.status)).toStrictEqual([
      'queued',
      'failed',
      'failed',
    ]);
    expect(capped[1]?.lastError).toBe(MAIL_BUDGET_EXCEEDED_REASON);
  });

  it('keeps recipient, subject and body on a capped row', () => {
    const [capped] = capMails(
      [queued('a@example.org')],
      0,
      MAIL_BUDGET_EXCEEDED_REASON,
    );

    // The mail log has to show *whom* it would have gone to — a line
    // without that says „irgendetwas wurde gedeckelt" and is unusable.
    expect(capped?.recipient).toBe('a@example.org');
    expect(capped?.subject).toBe('Anmeldung eingegangen');
    expect(capped?.bodyText).toBe('Danke.');
  });

  /**
   * A row that was never a mail neither consumes the allowance nor loses its
   * own reason — the specific „kein Empfänger" answer must not be replaced by
   * the general „Budget erreicht" one.
   */
  it('passes an already failed row through untouched and unbilled', () => {
    const capped = capMails(
      [alreadyFailed(), queued('a@example.org')],
      1,
      MAIL_BUDGET_EXCEEDED_REASON,
    );

    expect(capped[0]?.lastError).toBe(UNRESOLVED_RECIPIENT_REASON);
    expect(capped[1]?.status).toBe('queued');
  });

  it('caps everything at an allowance of zero — the honeypot case', () => {
    const capped = capMails(
      [queued('a@example.org'), queued('b@example.org')],
      0,
      HONEYPOT_SUPPRESSION_REASON,
    );

    expect(capped.map((mail) => mail.status)).toStrictEqual([
      'failed',
      'failed',
    ]);
    expect(capped.map((mail) => mail.lastError)).toStrictEqual([
      HONEYPOT_SUPPRESSION_REASON,
      HONEYPOT_SUPPRESSION_REASON,
    ]);
  });

  it('treats a negative allowance as zero', () => {
    // A budget lowered below what the window already holds. `<` against a
    // running count rather than a decrement, so nothing passes through zero.
    const capped = capMails(
      [queued('a@example.org')],
      -3,
      MAIL_BUDGET_EXCEEDED_REASON,
    );

    expect(capped[0]?.status).toBe('failed');
  });
});

describe('budgetWindowStart', () => {
  it('slides with the clock rather than starting at a fixed instant', () => {
    const settings = { mailBudgetWindowMin: 60 };
    const first = budgetWindowStart(new Date('2026-07-31T10:00:00Z'), settings);
    const later = budgetWindowStart(new Date('2026-07-31T12:00:00Z'), settings);

    expect(first.toISOString()).toBe('2026-07-31T09:00:00.000Z');
    // Two hours later the near edge has moved by exactly two hours — this is
    // the difference between „gleitend" and „seit Beginn" .
    expect(later.toISOString()).toBe('2026-07-31T11:00:00.000Z');
  });

  it('reads the window from the settings, never from a constant', () => {
    const now = new Date('2026-07-31T10:00:00Z');

    expect(
      budgetWindowStart(now, { mailBudgetWindowMin: 15 }).toISOString(),
    ).toBe('2026-07-31T09:45:00.000Z');
    expect(
      budgetWindowStart(now, { mailBudgetWindowMin: 180 }).toISOString(),
    ).toBe('2026-07-31T07:00:00.000Z');
  });
});
