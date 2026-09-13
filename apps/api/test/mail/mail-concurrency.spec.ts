import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

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
 * Two workers on one queue („zwei Worker greifen dieselbe Zeile
 * nicht doppelt").
 *
 * ## Why there are two cases here and not one
 *
 * The obvious test — „lass zwei Läufe los und prüfe, dass keine Mail doppelt
 * rausgeht" — **proves nothing about `SKIP LOCKED`**. Take that clause away and
 * the second worker does not deliver twice; it *blocks* on the row the first
 * one holds, and once the first commits it finds the row `sent` and moves on.
 * No duplicate, green test, clause gone.
 *
 * So the two halves are separated:
 *
 * 1. **`SKIP LOCKED`** is about work being *shared*. It is measured as „the
 *    second run finished its row while the first one was still inside its
 *    delivery" — with a barrier in the transport so the runs genuinely overlap.
 *    Removing `SKIP LOCKED` makes the second run wait for the first, and the
 *    case fails on exactly that.
 * 2. **`FOR UPDATE`** is about work not being *duplicated*. It is measured as
 *    „each recipient was handed to the transport exactly once". Removing the
 *    locking altogether makes the same row go out twice, and the case fails on
 *    that.
 *
 * Case 2 stays green when only `SKIP LOCKED` is removed. That is stated here
 * rather than discovered later: it is the reason case 1 exists.
 */

const SETUP_TIMEOUT_MS = 180_000;

/**
 * How long the second run is given to finish while the first one is parked.
 *
 * Generous against a slow machine and still far below the point at which
 * „waited for the other worker" could pass for „was merely slow": with the
 * clause in place the second run only has to claim one row and hand one mail to
 * an in-memory double.
 */
const OVERLAP_BUDGET_MS = 2_000;

const FIRST_RECIPIENT = 'erste@example.invalid';
const SECOND_RECIPIENT = 'zweite@example.invalid';

describe('mail queue concurrency (SKIP LOCKED, FOR UPDATE)', () => {
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

  /** Two queued rows in a known order, plus a transport that can be parked. */
  async function twoQueuedMails(): Promise<{
    readonly ctx: MailContext;
    readonly transport: SmtpDouble;
  }> {
    if (database === undefined) {
      throw new Error('no test database');
    }
    const transport = new SmtpDouble();
    context = await createMailContext({ databaseUrl: database.url, transport });
    await resetMailTables(context.prisma);
    const tenantId = await createMailTenant(context.prisma);
    // Explicit, distinct `created_at`: the claim orders by it, so without them
    // „which worker took which row" would be up to the storage order.
    await enqueueMail(context.prisma, {
      tenantId,
      recipient: FIRST_RECIPIENT,
      createdAt: new Date(MAIL_TEST_EPOCH.getTime() - 2_000),
    });
    await enqueueMail(context.prisma, {
      tenantId,
      recipient: SECOND_RECIPIENT,
      createdAt: new Date(MAIL_TEST_EPOCH.getTime() - 1_000),
    });
    return { ctx: context, transport };
  }

  it('lets a second run take the next row while the first one is still delivering', async () => {
    const { ctx, transport } = await twoQueuedMails();

    // The first delivery parks inside its transaction — still holding its row.
    const gate = transport.hold();
    const first = ctx.worker.runOnce();
    await gate.arrived;

    const second = ctx.worker.runOnce();
    const overlapped = await Promise.race([
      second,
      new Promise<'blocked'>((resolve) => {
        setTimeout(() => {
          resolve('blocked');
        }, OVERLAP_BUDGET_MS).unref();
      }),
    ]);

    gate.release();
    const firstRun = await first;
    const secondRun = await second;

    // **The measurement.** Without `SKIP LOCKED` the second run is still stuck
    // behind the first one's row lock at this point and `overlapped` is
    // `'blocked'`.
    expect(overlapped).not.toBe('blocked');
    // And the work was split — one row each, rather than one worker doing both.
    expect(firstRun.attempted).toBe(1);
    expect(secondRun.attempted).toBe(1);
    expect(firstRun.sent).toBe(1);
    expect(secondRun.sent).toBe(1);

    expect(await ctx.prisma.mailLog.count({ where: { status: 'sent' } })).toBe(
      2,
    );
  });

  it('hands each row to the transport exactly once', async () => {
    const { ctx, transport } = await twoQueuedMails();

    const gate = transport.hold();
    const first = ctx.worker.runOnce();
    await gate.arrived;
    const second = ctx.worker.runOnce();
    await Promise.race([
      second,
      new Promise<void>((resolve) => {
        setTimeout(resolve, OVERLAP_BUDGET_MS).unref();
      }),
    ]);
    gate.release();
    await first;
    await second;

    // Two rows in, two deliveries out — no address twice. This is what breaks
    // when the row is not locked at all; it does **not** break when only
    // `SKIP LOCKED` is removed, which is why the case above exists.
    expect([...transport.recipients].sort()).toEqual([
      FIRST_RECIPIENT,
      SECOND_RECIPIENT,
    ]);
    expect(await ctx.prisma.mailLog.count()).toBe(2);
  });
});
