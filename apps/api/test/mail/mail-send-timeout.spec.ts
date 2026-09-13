import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { MAIL_MAX_ATTEMPTS } from '@formsache/shared';

import { mailBackoffMs } from '../../src/mail/mail-backoff';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import { SmtpDouble } from '../support/smtp-double';
import {
  createMailContext,
  createMailTenant,
  enqueueMail,
  MAIL_TEST_EPOCH,
  resetMailTables,
  type MailContext,
} from './mail-test-context';

/**
 * **A mail server that goes quiet must not turn one queued row into an endless
 * send loop** (ADR-0004, `src/mail/mail-timeouts.ts`).
 *
 * ## The failure this file is the regression test for
 *
 * The worker claims a row inside an interactive transaction and writes the
 * outcome inside that same transaction — that is what makes „ein Versuch fand
 * statt" and „`attempts` wurde erhöht" one event. Until this was fixed, nothing
 * bounded the send: `nodemailer`'s socket timeout defaults to **600 s**, five
 * times the transaction budget. A relay that accepted the connection and then
 * stopped answering in the `DATA` dialogue produced this chain:
 *
 * 1. Prisma rolls the transaction back when its budget runs out and releases
 *    the row lock;
 * 2. the send finally comes back, and `markRetry` runs into a closed
 *    transaction (P2028) and throws;
 * 3. `runTick` catches and logs — and the row is exactly as it was found:
 *    `queued`, `attempts = 0`, no `next_attempt_at`.
 *
 * It is therefore due again immediately, and the next tick sends it again,
 * fifteen seconds later, forever. `MAIL_MAX_ATTEMPTS` is never reached because
 * no attempt is ever recorded. That is not the at-least-once duplicate
 * ADR-0004 accepts — it is an unbounded loop against the installation's own
 * sender domain.
 *
 * ## The reproduction, run while writing this file
 *
 * Removing `withSendDeadline` from `MailWorkerService.deliver` turns the first
 * case below red exactly as described: `runOnce()` rejects with P2028, and the
 * row is still `queued` with `attempts = 0` and `next_attempt_at = null` — the
 * second and third assertions of the „vorher" state. It stays red with the
 * deadline restored and the transport timeouts removed from
 * `buildTransporter`, because the deadline is what this file measures; the
 * transport timeouts are the first fence and are asserted in
 * `mail-timeouts.spec.ts` by their order.
 *
 * ## Real time, on purpose
 *
 * The deadline is a `setTimeout`, the transaction budget is Prisma's own timer,
 * and the point is that the first fires **before** the second. That relation is
 * not expressible against an injected clock — so the numbers are scaled down
 * instead, keeping their order (see `MailContextOptions.timeouts`).
 */

const SETUP_TIMEOUT_MS = 180_000;
const CASE_TIMEOUT_MS = 40_000;

/** The compressed scale — the shipped order, in seconds instead of minutes. */
const SEND_DEADLINE_MS = 500;
const CLAIM_TRANSACTION_MS = 2_000;
/**
 * Longer than the transaction budget on purpose: this is the answer that
 * arrives too late, and the whole failure lives in that gap.
 */
const STALL_MS = 5_000;

describe('a mail server that stops answering (ADR-0004)', () => {
  let database: TestDatabase | undefined;
  let context: MailContext | undefined;

  beforeAll(async () => {
    database = await acquireTestDatabase();
  }, SETUP_TIMEOUT_MS);

  afterEach(async () => {
    await context?.close();
    context = undefined;
  });

  afterAll(async () => {
    await database?.release();
  });

  async function open(): Promise<MailContext> {
    if (database === undefined) {
      throw new Error('no test database');
    }
    const ctx = await createMailContext({
      databaseUrl: database.url,
      transport: new SmtpDouble({ stallMs: STALL_MS }),
      timeouts: {
        sendMs: SEND_DEADLINE_MS,
        claimTransactionMs: CLAIM_TRANSACTION_MS,
        claimMaxWaitMs: CLAIM_TRANSACTION_MS,
      },
    });
    context = ctx;
    await resetMailTables(ctx.prisma);
    return ctx;
  }

  it(
    'records the attempt instead of leaving the row untouched',
    async () => {
      const ctx = await open();
      const tenantId = await createMailTenant(ctx.prisma);
      const id = await enqueueMail(ctx.prisma, { tenantId });

      // Does not reject, and does not wait for the mail server: the deadline
      // ends the attempt while the claiming transaction is still open.
      const run = await ctx.worker.runOnce();
      expect(run).toMatchObject({ attempted: 1, sent: 0, deferred: 1 });

      const row = await ctx.prisma.mailLog.findUniqueOrThrow({ where: { id } });
      // `queued`, because nothing was refused — but **counted**, which is the
      // whole difference to the loop described above.
      expect(row.status).toBe('queued');
      expect(row.attempts).toBe(1);
      expect(row.nextAttemptAt).not.toBeNull();
      expect(row.nextAttemptAt?.getTime()).toBe(
        MAIL_TEST_EPOCH.getTime() + mailBackoffMs(1),
      );
      // A reason an editor can act on, not „unknown error" (the requirements).
      expect(row.lastError).toContain('nicht innerhalb');
      expect(row.lastError).toContain('Sekunde');
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'does not send the same row again on the very next run',
    async () => {
      const ctx = await open();
      const tenantId = await createMailTenant(ctx.prisma);
      await enqueueMail(ctx.prisma, { tenantId });

      expect((await ctx.worker.runOnce()).attempted).toBe(1);
      // Immediately again, without moving the clock: the backoff this file
      // measures is only real if the claim asks for it. Before the fix this run attempted the
      // row a second time, which is the loop the file is named after.
      expect((await ctx.worker.runOnce()).attempted).toBe(0);
      expect(ctx.double?.attemptCount).toBe(1);
    },
    CASE_TIMEOUT_MS,
  );

  /**
   * **A lane whose peer stays silent stops after *one* row**
   * (ADR-0013 no. 7, a security finding).
   *
   * The case this stands against: the rows of a queue arise from **public**
   * submissions — their number is not that of the organisation the wrongly
   * entered host belongs to. Without this abort the lane would buy the same
   * silence at the same price for every further row, and because `runOnce`
   * waits for all lanes and `tick` coalesces, **no new run started** in that
   * time — **not for the other organisations either**.
   *
   * ⚠️ **The lane budget alone does not prove that.**
   * `MAIL_WORKER_LANE_BATCH_MAX` is checked (`mail-worker-lanes.spec.ts`, S1)
   * and caps the damage at the share of one lane — here it is about the row
   * *before* that: with a silent peer even the share is too expensive. Until
   * 2026-08-12 the abort was built and **measured by no case**; ADR-0013 on
   * top of that still carried it as open.
   *
   * *Counter-check:* take the `if (outcome.stalled === true) return;` out of
   * `drainLane` → this case turns red and reports two attempts instead of one.
   */
  it(
    'stops a lane after the first stalled row instead of buying the same silence again',
    async () => {
      const ctx = await open();
      const tenantId = await createMailTenant(ctx.prisma);
      await enqueueMail(ctx.prisma, { tenantId });
      await enqueueMail(ctx.prisma, { tenantId });

      const run = await ctx.worker.runOnce();
      // **One**, although two are due and the lane budget would allow more.
      expect(run).toMatchObject({ attempted: 1, sent: 0, deferred: 1 });
      expect(ctx.double?.attemptCount).toBe(1);

      // And nothing is lost: the second row waits untouched and goes as soon
      // as the deferral time of the first no longer overtakes it.
      const waiting = await ctx.prisma.mailLog.count({
        where: { status: 'queued', attempts: 0 },
      });
      expect(waiting).toBe(1);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'gives up after the attempt ceiling instead of retrying for ever',
    async () => {
      const ctx = await open();
      const tenantId = await createMailTenant(ctx.prisma);
      const id = await enqueueMail(ctx.prisma, { tenantId });

      // One run per attempt, each past the previous backoff. The ceiling is
      // only reachable at all because every stalled attempt is *recorded*; with
      // the row left untouched this loop would run for ever.
      for (let attempt = 1; attempt <= MAIL_MAX_ATTEMPTS; attempt += 1) {
        expect((await ctx.worker.runOnce()).attempted).toBe(1);
        ctx.clock.advance(mailBackoffMs(attempt) + 1_000);
      }

      const row = await ctx.prisma.mailLog.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe('failed');
      expect(row.attempts).toBe(MAIL_MAX_ATTEMPTS);

      // And it stays failed: nothing claims it again.
      expect((await ctx.worker.runOnce()).attempted).toBe(0);
      expect(ctx.double?.attemptCount).toBe(MAIL_MAX_ATTEMPTS);
    },
    CASE_TIMEOUT_MS,
  );
});
