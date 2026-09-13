import {
  PASSWORD_RESET_RETENTION_DAYS,
  SESSION_RETENTION_DAYS,
} from '@formsache/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { SessionPurgeService } from '../../src/auth/purge/session-purge.service';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import { createTestApp, type TestApp } from '../support/create-test-app';

/**
 * **The clean-up run over dead session rows (a review finding).**
 *
 * The finding was not that a retention period had been too long — there was
 * **none at all**. `session` grew monotonically, and `schema.prisma` promised
 * at `@@index([expiresAt])` a job that `JobKind` did not know.
 *
 * ## Measured at the boundary, not in the middle
 *
 * A row that has been dead for 200 days survives **no** retention period
 * between 1 and 200 — so it proves nothing about the seven. Both cases here
 * therefore stand one day to the left and to the right of the promise.
 *
 * ## Both kinds of death, and the second is the one people forget
 *
 * Expired **and** revoked. Purging only by `expires_at` would be the obvious
 * half: whoever logs out leaves behind a revoked row whose `expires_at` still
 * lies up to 720 hours in the future.
 *
 * ## Counted without a filter
 *
 * „Gone, not marked" is checked with a raw `count(*)` over the whole table.
 * Asking the repository would only have proved that the repository filters.
 */

const SETUP_TIMEOUT_MS = 180_000;
const MS_PER_DAY = 86_400_000;

/** One day beyond the promise — must be gone. */
const OVER_RETENTION_DAYS = SESSION_RETENTION_DAYS + 1;
/** One on this side — must remain. */
const UNDER_RETENTION_DAYS = SESSION_RETENTION_DAYS - 1;

/** The clock of this case; the rows and the run read the same one. */
const NOW = new Date('2026-08-12T12:00:00.000Z');

describe('session purge', () => {
  let database: TestDatabase | undefined;
  let app: TestApp | undefined;

  beforeAll(async () => {
    database = await acquireTestDatabase();
  }, SETUP_TIMEOUT_MS);

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  afterAll(async () => {
    await database?.release();
  });

  async function open(): Promise<TestApp> {
    if (database === undefined) {
      throw new Error('no test database');
    }
    app = await createTestApp({ databaseUrl: database.url });
    await app.prisma.session.deleteMany({});
    await app.prisma.passwordResetToken.deleteMany({});
    return app;
  }

  function daysBefore(days: number): Date {
    return new Date(NOW.getTime() - days * MS_PER_DAY);
  }

  /** Creates a user that sessions can hang off. */
  async function createUser(context: TestApp, email: string): Promise<string> {
    const user = await context.prisma.user.create({
      data: { email, name: 'Purge Prüfer', passwordHash: 'x' },
    });
    return user.id;
  }

  async function createSession(
    context: TestApp,
    userId: string,
    row: { expiresAt: Date; revokedAt?: Date },
  ): Promise<string> {
    const session = await context.prisma.session.create({
      data: {
        // The digest is `@unique`; it has to differ per row.
        tokenHash: Buffer.from(
          crypto.getRandomValues(new Uint8Array(32)).buffer,
        ),
        userId,
        expiresAt: row.expiresAt,
        revokedAt: row.revokedAt ?? null,
      },
    });
    return session.id;
  }

  /** A reset row, just as `PasswordResetService` would write it. */
  async function createReset(
    context: TestApp,
    userId: string,
    row: { expiresAt: Date; usedAt?: Date },
  ): Promise<string> {
    const reset = await context.prisma.passwordResetToken.create({
      data: {
        // No default in the table — the id is the signed message
        // (`password-reset-token.ts`), so the writer supplies it. Nothing is
        // redeemed here, so a random one suffices.
        id: crypto.randomUUID(),
        userId,
        tokenHash: Buffer.from(
          crypto.getRandomValues(new Uint8Array(32)).buffer,
        ),
        expiresAt: row.expiresAt,
        usedAt: row.usedAt ?? null,
      },
    });
    return reset.id;
  }

  /** The same counting as above, for the second population. */
  async function rawResetRowCount(context: TestApp): Promise<number> {
    const result = await context.prisma.$queryRaw<
      { count: number }[]
    >`SELECT count(*)::int AS "count" FROM "password_reset"`;
    return result[0]?.count ?? -1;
  }

  /** Rows that physically stand there — without any `where`. */
  async function rawRowCount(context: TestApp): Promise<number> {
    const result = await context.prisma.$queryRaw<
      { count: number }[]
    >`SELECT count(*)::int AS "count" FROM "session"`;
    return result[0]?.count ?? -1;
  }

  function purgeOf(context: TestApp): SessionPurgeService {
    return context.app.get(SessionPurgeService);
  }

  it('löscht eine abgelaufene Zeile jenseits der Frist und lässt die diesseits stehen', async () => {
    const context = await open();
    const userId = await createUser(context, 'abgelaufen@example.invalid');

    const tooOld = await createSession(context, userId, {
      expiresAt: daysBefore(OVER_RETENTION_DAYS),
    });
    const youngEnough = await createSession(context, userId, {
      expiresAt: daysBefore(UNDER_RETENTION_DAYS),
    });

    expect(await purgeOf(context).runOnce(NOW)).toBe(1);

    expect(await rawRowCount(context)).toBe(1);
    expect(
      await context.prisma.session.findUnique({ where: { id: tooOld } }),
    ).toBeNull();
    expect(
      await context.prisma.session.findUnique({ where: { id: youngEnough } }),
    ).not.toBeNull();
  });

  /**
   * The half that a version „only by `expires_at`" would leave lying — and
   * that for up to 720 hours after logging out.
   */
  it('löscht auch eine widerrufene Zeile, deren Ablauf noch in der Zukunft liegt', async () => {
    const context = await open();
    const userId = await createUser(context, 'abgemeldet@example.invalid');

    await createSession(context, userId, {
      expiresAt: new Date(NOW.getTime() + 30 * MS_PER_DAY),
      revokedAt: daysBefore(OVER_RETENTION_DAYS),
    });

    expect(await purgeOf(context).runOnce(NOW)).toBe(1);
    expect(await rawRowCount(context)).toBe(0);
  });

  it('lässt eine lebende Sitzung unangetastet', async () => {
    const context = await open();
    const userId = await createUser(context, 'lebt@example.invalid');

    await createSession(context, userId, {
      expiresAt: new Date(NOW.getTime() + MS_PER_DAY),
    });

    expect(await purgeOf(context).runOnce(NOW)).toBe(0);
    expect(await rawRowCount(context)).toBe(1);
  });

  it('ist idempotent: der zweite Lauf löscht nichts mehr', async () => {
    const context = await open();
    const userId = await createUser(context, 'zweimal@example.invalid');
    await createSession(context, userId, {
      expiresAt: daysBefore(OVER_RETENTION_DAYS),
    });

    expect(await purgeOf(context).runOnce(NOW)).toBe(1);
    expect(await purgeOf(context).runOnce(NOW)).toBe(0);
    expect(await rawRowCount(context)).toBe(0);
  });

  /**
   * the requirement: the run keeps a record — otherwise one that does not even
   * start leaves nothing behind. Measured against the `job_run` row, not
   * against the `JobKind` enumeration: precisely that mix-up was the finding
   * the review found at the watchdog.
   */
  /**
   * **The second population of the same run** (ADR-0020).
   *
   * A reset link is a sign-in artefact like a session: the same retention
   * period, the same run, no second `JobKind` (see the comment at
   * `SessionPurgeService`). Measurement is again at the boundary and in both
   * kinds of death — **expired** and **redeemed** —, for the second is the one
   * that a version „only by `expires_at`" would leave lying for up to an hour.
   */
  it('löscht tote Rücksetz-Zeilen jenseits der Frist und lässt die diesseits stehen', async () => {
    const context = await open();
    const userId = await createUser(context, 'ruecksetzung@example.invalid');

    const expiredTooOld = await createReset(context, userId, {
      expiresAt: daysBefore(PASSWORD_RESET_RETENTION_DAYS + 1),
    });
    const redeemedTooOld = await createReset(context, userId, {
      // It would only expire tomorrow — it has been dead for eight days
      // because it was redeemed. Exactly the case „only `expires_at`" misses.
      expiresAt: new Date(NOW.getTime() + MS_PER_DAY),
      usedAt: daysBefore(PASSWORD_RESET_RETENTION_DAYS + 1),
    });
    const youngEnough = await createReset(context, userId, {
      expiresAt: daysBefore(PASSWORD_RESET_RETENTION_DAYS - 1),
    });
    const stillOpen = await createReset(context, userId, {
      expiresAt: new Date(NOW.getTime() + MS_PER_DAY),
    });

    // Two — and the number is the **sum** of both populations; there are no
    // sessions in this case.
    expect(await purgeOf(context).runOnce(NOW)).toBe(2);

    expect(await rawResetRowCount(context)).toBe(2);
    for (const id of [expiredTooOld, redeemedTooOld]) {
      expect(
        await context.prisma.passwordResetToken.findUnique({ where: { id } }),
      ).toBeNull();
    }
    for (const id of [youngEnough, stillOpen]) {
      expect(
        await context.prisma.passwordResetToken.findUnique({ where: { id } }),
      ).not.toBeNull();
    }
  });

  it('schreibt eine job_run-Zeile über seinen eigenen Lauf', async () => {
    const context = await open();
    await context.prisma.jobRun.deleteMany({ where: { job: 'session_purge' } });

    // `tick()` is private — the timer path is exactly the one that carries the
    // record, and bypassing it via `runOnce()` would mean measuring past the
    // subject (the lesson from the finding at the watchdog).
    const purge: { tick: () => Promise<void> } =
      context.app.get(SessionPurgeService);
    await purge.tick();

    const runs = await context.prisma.jobRun.findMany({
      where: { job: 'session_purge' },
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.outcome).toBe('ok');
  });
});
