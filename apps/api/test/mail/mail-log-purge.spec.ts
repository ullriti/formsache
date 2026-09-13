import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MAIL_LOG_RETENTION_DAYS } from '@formsache/shared';

import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import {
  createMailContext,
  createMailTenant,
  enqueueMail,
  MAIL_TEST_EPOCH,
  resetMailTables,
  type MailContext,
} from './mail-test-context';

/**
 * The 90-day purge.
 *
 * ## Measured at the boundary, not in the middle
 *
 * A single row aged 200 days survives **every** limit between 1 and 200 — it
 * would be deleted by a purge that keeps nothing and by one that keeps three
 * months, and the test could not tell the two apart. So both cases here sit one
 * day either side of the promise: 91 days must be gone, 89 must still be there.
 *
 * ## One clock
 *
 * The rows' `created_at` is written explicitly, derived from the same injected
 * clock the purge computes its cut-off from. Anchoring rows on the database's
 * `now()` while measuring against Node's is harmless at ±1 day and wrong the
 * moment the case tightens — they are two machines' opinions and nothing makes
 * them agree (the clock-mismatch trap).
 *
 * ## Counted without a filter
 *
 * „Verschwunden, nicht markiert" is checked with a raw `count(*)` over the
 * whole table. Asking the repository would only prove that the repository
 * filters — which is exactly what a `deleted_at` implementation would also do
 * (the filter-blind-spot trap).
 */

const SETUP_TIMEOUT_MS = 180_000;
const MS_PER_DAY = 86_400_000;

/** One day past the promise — must be gone. */
const OVER_RETENTION_DAYS = MAIL_LOG_RETENTION_DAYS + 1;
/** One day short of it — must survive. */
const UNDER_RETENTION_DAYS = MAIL_LOG_RETENTION_DAYS - 1;

describe('mail log purge (three traps)', () => {
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
    context = await createMailContext({ databaseUrl: database.url });
    // Every assertion here is a raw `count(*)` over the whole table.
    await resetMailTables(context.prisma);
    return context;
  }

  /** Rows still physically present, asked without any `where` at all. */
  async function rawRowCount(ctx: MailContext): Promise<number> {
    const result = await ctx.prisma.$queryRaw<
      { count: number }[]
    >`SELECT count(*)::int AS "count" FROM "mail_log"`;
    return result[0]?.count ?? -1;
  }

  function daysBefore(days: number): Date {
    return new Date(MAIL_TEST_EPOCH.getTime() - days * MS_PER_DAY);
  }

  it('deletes what is over the retention period and keeps what is not', async () => {
    const ctx = await open();
    const tenantId = await createMailTenant(ctx.prisma);

    const tooOld = await enqueueMail(ctx.prisma, {
      tenantId,
      recipient: 'alt@example.invalid',
      createdAt: daysBefore(OVER_RETENTION_DAYS),
    });
    const youngEnough = await enqueueMail(ctx.prisma, {
      tenantId,
      recipient: 'jung@example.invalid',
      createdAt: daysBefore(UNDER_RETENTION_DAYS),
    });

    const deleted = await ctx.purge.runOnce();
    expect(deleted).toBe(1);

    // Physically gone, counted over the whole table.
    expect(await rawRowCount(ctx)).toBe(1);
    expect(
      await ctx.prisma.mailLog.findUnique({ where: { id: tooOld } }),
    ).toBeNull();
    expect(
      await ctx.prisma.mailLog.findUnique({ where: { id: youngEnough } }),
    ).not.toBeNull();
  });

  it('deletes a row that never went out, too', async () => {
    const ctx = await open();
    const tenantId = await createMailTenant(ctx.prisma);
    await enqueueMail(ctx.prisma, {
      tenantId,
      recipient: 'nie-zugestellt@example.invalid',
      createdAt: daysBefore(OVER_RETENTION_DAYS),
    });

    // The retention is a deletion promise, not a delivery guarantee
    //  — and a row still `queued` after three months
    // is the one that most certainly still carries an address.
    expect(await ctx.purge.runOnce()).toBe(1);
    expect(await rawRowCount(ctx)).toBe(0);
  });

  it('is idempotent: a second run deletes nothing and leaves the young row alone', async () => {
    const ctx = await open();
    const tenantId = await createMailTenant(ctx.prisma);
    await enqueueMail(ctx.prisma, {
      tenantId,
      createdAt: daysBefore(OVER_RETENTION_DAYS),
    });
    const youngEnough = await enqueueMail(ctx.prisma, {
      tenantId,
      createdAt: daysBefore(UNDER_RETENTION_DAYS),
    });

    expect(await ctx.purge.runOnce()).toBe(1);

    // **The return value.** Without it „idempotent" cannot be told apart from
    // „did nothing because it fell over on the way in" (the silent-failure trap).
    expect(await ctx.purge.runOnce()).toBe(0);
    expect(await rawRowCount(ctx)).toBe(1);
    expect(
      await ctx.prisma.mailLog.findUnique({ where: { id: youngEnough } }),
    ).not.toBeNull();
  });
});
