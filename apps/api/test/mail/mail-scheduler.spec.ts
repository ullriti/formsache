import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { ApiEnv } from '@formsache/shared';

import { API_ENV } from '../../src/config/env';
import { MailLogPurgeService } from '../../src/mail/mail-log-purge.service';
import { MailWorkerService } from '../../src/mail/mail-worker.service';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import { createTestApp, type TestApp } from '../support/create-test-app';
import {
  createMailContext,
  createMailTenant,
  enqueueMail,
  MAIL_TEST_EPOCH,
  resetMailTables,
  type MailContext,
} from './mail-test-context';

/**
 * When the two background jobs run, and when they must not.
 *
 * Two separate promises live here, and both were unprovable until this package
 * existed:
 *
 * 1. **The test application starts no scheduler** .
 *    `create-test-app.ts` sets both intervals to `0`, and until there *was* a
 *    scheduler nothing would have gone red if somebody had removed those zeros
 *    — a worker draining a queue another suite is counting is the kind of
 *    non-determinism that gets blamed on flakiness for a week.
 * 2. **The purge starts again after a restart** . A test that
 *    only calls `runOnce()` says nothing about that: it is the *arming* on
 *    module init, per process, that the requirement is about.
 * 3. **And it runs at once, not one interval later.** The two cases above are
 *    both driven with a 25 ms interval, where „sofort" and „ein Intervall
 *    später" are indistinguishable — which is exactly how the first deletion
 *    came to be a day after the process start without anything turning red. The
 *    third case therefore uses a **large** interval, so only an immediate run
 *    can make it pass.
 *
 * These are the only cases in this folder that use real time. They have to: the
 * subject is a timer.
 */

const SETUP_TIMEOUT_MS = 180_000;
/** Short enough for a test, long enough not to hammer the database. */
const FAST_INTERVAL_MS = 25;
/**
 * An interval no test can wait out — an hour, where the shipped value is a day.
 * A row that disappears under it did so at startup or not at all.
 */
const HUGE_INTERVAL_MS = 3_600_000;
const WAIT_BUDGET_MS = 5_000;
/** Two module boots plus two waits — comfortably above Vitest's default 5 s. */
const RESTART_TIMEOUT_MS = 40_000;
const MS_PER_DAY = 86_400_000;

/** A row far past the retention, so this file never touches the retention boundary. */
const ANCIENT = new Date(MAIL_TEST_EPOCH.getTime() - 200 * MS_PER_DAY);

async function waitUntil(
  condition: () => Promise<boolean>,
  budgetMs = WAIT_BUDGET_MS,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (await condition()) {
      return true;
    }
    if (Date.now() > deadline) {
      return false;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10).unref();
    });
  }
}

describe('mail schedulers', () => {
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

  function url(): string {
    if (database === undefined) {
      throw new Error('no test database');
    }
    return database.url;
  }

  it('arms nothing in the test application', async () => {
    let testApp: TestApp | undefined;
    try {
      testApp = await createTestApp({ databaseUrl: url() });

      // The mechanism …
      const env = testApp.app.get<ApiEnv>(API_ENV);
      expect(env).toMatchObject({
        MAIL_WORKER_INTERVAL_MS: 0,
        MAIL_PURGE_INTERVAL_MS: 0,
      });
      // … and the promise. Both, because the zeros in `create-test-app.ts` are
      // what a future edit would remove, and „nothing is scheduled" is what
      // every other suite in this repository silently depends on.
      expect(testApp.app.get(MailWorkerService).schedulerRunning).toBe(false);
      expect(testApp.app.get(MailLogPurgeService).schedulerRunning).toBe(false);
    } finally {
      await testApp?.close();
    }
  });

  it('works the queue on its own once an interval is configured', async () => {
    context = await createMailContext({
      databaseUrl: url(),
      env: { MAIL_WORKER_INTERVAL_MS: FAST_INTERVAL_MS },
    });
    const ctx = context;
    expect(ctx.worker.schedulerRunning).toBe(true);
    await resetMailTables(ctx.prisma);

    const tenantId = await createMailTenant(ctx.prisma);
    const id = await enqueueMail(ctx.prisma, { tenantId });

    // Nobody calls `runOnce()` here — that is the whole assertion.
    const delivered = await waitUntil(async () => {
      const row = await ctx.prisma.mailLog.findUniqueOrThrow({ where: { id } });
      return row.status === 'sent';
    });
    expect(delivered).toBe(true);
    expect(ctx.double?.attemptCount).toBe(1);
  });

  it(
    'starts purging again after a restart',
    async () => {
      const first = await createMailContext({
        databaseUrl: url(),
        env: { MAIL_PURGE_INTERVAL_MS: FAST_INTERVAL_MS },
      });
      let tenantId: string;
      try {
        expect(first.purge.schedulerRunning).toBe(true);
        await resetMailTables(first.prisma);
        tenantId = await createMailTenant(first.prisma);
        await enqueueMail(first.prisma, { tenantId, createdAt: ANCIENT });
        const gone = await waitUntil(
          async () => (await first.prisma.mailLog.count()) === 0,
        );
        expect(gone).toBe(true);
      } finally {
        await first.close();
      }

      // A second process comes up — nothing outside remembers that a purge was
      // due, so if the job did not re-arm on module init, this row would stay.
      context = await createMailContext({
        databaseUrl: url(),
        env: { MAIL_PURGE_INTERVAL_MS: FAST_INTERVAL_MS },
      });
      const restarted = context;
      await enqueueMail(restarted.prisma, { tenantId, createdAt: ANCIENT });
      // **No `count() === 1` control here.** It used to stand for „the row is
      // really there", and it raced the very scheduler this case is about: a
      // tick between the insert and the count deleted the row and turned the
      // control — not the assertion — red. What the case claims is `goneAgain`.

      const goneAgain = await waitUntil(
        async () => (await restarted.prisma.mailLog.count()) === 0,
      );
      expect(goneAgain).toBe(true);
    },
    RESTART_TIMEOUT_MS,
  );

  /**
   * **The first purge happens at startup, not one interval later** .
   *
   * The shipped interval is a day. „Armed on module init" alone therefore means
   * the first deletion is twenty-four hours after the process came up — and an
   * installation that is redeployed daily, one in a crash loop, or one on a host
   * that reboots each night would never delete a row while the view went on
   * promising ninety days. The two cases above cannot see that: with a 25 ms
   * interval, „sofort" and „ein Intervall später" are the same instant.
   *
   * So the row is seeded through a context whose purge is **off** (interval 0
   * arms nothing and runs nothing), and the second context comes up with an
   * interval it could not possibly reach inside this test. Nothing is fast
   * forwarded and nothing calls `runOnce()`.
   *
   * *Reproduction:* dropping the immediate run from `onModuleInit` leaves the
   * row standing and this case red, while the two above stay green — which is
   * what makes them a control rather than a duplicate.
   */
  it(
    'purges once at startup, without waiting for the first interval',
    async () => {
      const seed = await createMailContext({
        databaseUrl: url(),
        env: { MAIL_PURGE_INTERVAL_MS: 0 },
      });
      try {
        expect(seed.purge.schedulerRunning).toBe(false);
        await resetMailTables(seed.prisma);
        const tenantId = await createMailTenant(seed.prisma);
        await enqueueMail(seed.prisma, { tenantId, createdAt: ANCIENT });
        // The seeding context deletes nothing — that is what makes the next
        // context's result attributable to its own startup.
        expect(await seed.prisma.mailLog.count()).toBe(1);
      } finally {
        await seed.close();
      }

      context = await createMailContext({
        databaseUrl: url(),
        env: { MAIL_PURGE_INTERVAL_MS: HUGE_INTERVAL_MS },
      });
      const started = context;
      expect(started.purge.schedulerRunning).toBe(true);

      const gone = await waitUntil(
        async () => (await started.prisma.mailLog.count()) === 0,
      );
      expect(gone).toBe(true);
    },
    RESTART_TIMEOUT_MS,
  );
});
