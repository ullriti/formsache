import { Logger } from '@nestjs/common';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  AI_PROMPT_RETENTION_DAYS,
  AI_USAGE_PERSON_RETENTION_DAYS,
} from '@formsache/shared';
import { AiProvider } from '@prisma/client';

import { AiPromptPurgeService } from '../../src/ai/purge/ai-prompt-purge.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { TenantScope } from '../../src/tenancy/tenant-scope';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import { MutableClock } from '../mail/mail-test-context';
import { createTestApp, type TestApp } from '../support/create-test-app';
import {
  createTenant,
  createUser,
  type TenantFixture,
} from '../support/fixtures';

/**
 * **The free text of an AI request expires after 30 days, physically — and the
 * usage counter survives it** (ADR-0015 no. 8).
 *
 * ## Measured at the boundary, with the clock moved forward
 *
 * A row that is a year old survives *no* retention period between one
 * minute and one year — it would be taken by a purge that keeps nothing
 * just as by one that keeps a day, and the case could not tell the
 * two apart. Both rows here lie one minute to the right and to the
 * left of the retention period, and the clock is set by hand: a test that waits thirty
 * days is none.
 *
 * ## Counted raw, never through the repository
 *
 * "Gone, not marked" is a raw `SELECT prompt` plus a `count(*)` **without
 * filter**. A test that asked the repository would only prove that the
 * repository filters — which a `deleted_at` implementation would do just as well.
 */

const SETUP_TIMEOUT_MS = 180_000;
const CASE_TIMEOUT_MS = 60_000;
const RESTART_TIMEOUT_MS = 120_000;

const MS_PER_DAY = 86_400_000;
const MINUTE_MS = 60_000;
const RETENTION_MS = AI_PROMPT_RETENTION_DAYS * MS_PER_DAY;

/**
 * An interval that no test can sit out — one hour, where as shipped
 * a day stands. What disappears below it disappeared at startup or not
 * at all.
 */
const HUGE_INTERVAL_MS = 3_600_000;

/** A fixed point in time far away from every boundary. */
const EPOCH = new Date('2026-06-15T09:00:00.000Z');

const SECRET = 'Ein Formular für den Jahrestagung, Kontakt: max@example.org';

describe('der 30-Tage-Purge der KI-Freitexte', () => {
  let database: TestDatabase;
  let testApp: TestApp;
  let prisma: PrismaService;
  let purge: AiPromptPurgeService;
  let clock: MutableClock;

  let alpha: TenantFixture;
  let beta: TenantFixture;

  /** A row with `created_at` = now − `ageMs`, with text. */
  async function row(options: {
    tenant: TenantFixture;
    ageMs: number;
    prompt?: string;
    userId?: string;
  }): Promise<string> {
    const created = await prisma.aiUsage.create({
      data: {
        tenantId: options.tenant.id,
        createdAt: new Date(clock.now().getTime() - options.ageMs),
        provider: AiProvider.anthropic,
        model: 'claude-opus-5',
        prompt: options.prompt ?? SECRET,
        ...(options.userId === undefined ? {} : { userId: options.userId }),
      },
      select: { id: true },
    });
    return created.id;
  }

  /** Organisation, person, model and usage — read raw. */
  async function rawRow(
    id: string,
  ): Promise<{ userId: string | null; model: string } | undefined> {
    const rows = await prisma.$queryRaw<
      { user_id: string | null; model: string }[]
    >`SELECT "user_id", "model" FROM "ai_usage" WHERE "id" = ${id}::uuid`;
    const found = rows[0];
    return found === undefined
      ? undefined
      : { userId: found.user_id, model: found.model };
  }

  /** The text, read raw — not through a delegate that could filter. */
  async function rawPrompt(
    id: string,
  ): Promise<{ prompt: string | null; erasedAt: Date | null } | undefined> {
    const rows = await prisma.$queryRaw<
      { prompt: string | null; prompt_erased_at: Date | null }[]
    >`
      SELECT "prompt", "prompt_erased_at"
        FROM "ai_usage"
       WHERE "id" = ${id}::uuid`;
    const found = rows[0];
    return found === undefined
      ? undefined
      : { prompt: found.prompt, erasedAt: found.prompt_erased_at };
  }

  /** All rows, without any filter — the counter as the database sees it. */
  async function rawRowCount(): Promise<number> {
    const rows = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM "ai_usage"`;
    return Number(rows[0]?.count ?? 0n);
  }

  beforeAll(async () => {
    database = await acquireTestDatabase();
    clock = new MutableClock(EPOCH);
    testApp = await createTestApp({ databaseUrl: database.url, clock });
    prisma = testApp.prisma;
    purge = testApp.app.get(AiPromptPurgeService);

    alpha = await createTenant(prisma, 'PURGEA');
    beta = await createTenant(prisma, 'PURGEB');
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await testApp.close();
    await database.release();
  });

  beforeEach(async () => {
    clock.set(EPOCH);
    await prisma.aiUsage.deleteMany({});
  });

  /**
   * **At the boundary, and the counter stays.**
   *
   * The row beyond the retention period loses its text and gets a stamp;
   * the one on this side keeps it. And `count(*)` without filter is **unchanged**:
   * both rows are still standing.
   *
   * *Reproduction:* in the purge, `deleteMany` instead of the `UPDATE` → the second
   * expectation ("the counter is still standing") turns red, and with it the promise that
   * an organisation does not get a second quota after thirty days.
   */
  it(
    'leert den Text jenseits der Frist und lässt die Zeile stehen',
    async () => {
      const old = await row({ tenant: alpha, ageMs: RETENTION_MS + MINUTE_MS });
      const young = await row({
        tenant: alpha,
        ageMs: RETENTION_MS - MINUTE_MS,
        prompt: 'Noch nicht fällig',
      });

      expect(await purge.runOnce()).toBe(1);

      expect(await rawPrompt(old)).toStrictEqual({
        prompt: null,
        erasedAt: EPOCH,
      });
      expect(await rawPrompt(young)).toStrictEqual({
        prompt: 'Noch nicht fällig',
        erasedAt: null,
      });
      // **The counter survives** : two rows, raw and without filter.
      expect(await rawRowCount()).toBe(2);
      // And it keeps counting both — including the one whose text is gone.
      expect(
        await new TenantScope(prisma, alpha.id).aiUsage.quota(new Date(0)),
      ).toStrictEqual({ used: 2, limit: 50 });
    },
    CASE_TIMEOUT_MS,
  );

  /**
   * **Idempotent, and the stamp does not wander.**
   *
   * A second run answers `0` — by that, and only by that, is "there was nothing
   * left" to be distinguished from "it fell over beforehand". And because the
   * predicate contains `prompt IS NOT NULL`, `prompt_erased_at` stays the
   * point in time of the *first* deletion, instead of wandering on with every day.
   */
  it(
    'antwortet beim zweiten Lauf mit null und lässt den Stempel stehen',
    async () => {
      const old = await row({ tenant: alpha, ageMs: RETENTION_MS + MINUTE_MS });
      expect(await purge.runOnce()).toBe(1);

      clock.advance(2 * MS_PER_DAY);
      expect(await purge.runOnce()).toBe(0);

      expect(await rawPrompt(old)).toStrictEqual({
        prompt: null,
        erasedAt: EPOCH,
      });
    },
    CASE_TIMEOUT_MS,
  );

  /**
   * **Across organisations, on purpose** — the job has no tenant parameter,
   * and a deletion promise that applied only to the organisation whose session is
   * currently open would be none.
   */
  it(
    'nimmt die fälligen Zeilen jeder Organisation',
    async () => {
      const one = await row({ tenant: alpha, ageMs: RETENTION_MS + MINUTE_MS });
      const other = await row({
        tenant: beta,
        ageMs: RETENTION_MS + MINUTE_MS,
      });

      expect(await purge.runOnce()).toBe(2);

      expect((await rawPrompt(one))?.prompt).toBeNull();
      expect((await rawPrompt(other))?.prompt).toBeNull();
      expect(await rawRowCount()).toBe(2);
    },
    CASE_TIMEOUT_MS,
  );

  /**
   * **Startup run *and* interval.**
   *
   * Reproduced as the requirement prescribes: the application is **restarted**,
   * with an interval (one hour) that never fires in this test.
   * What disappears here disappeared at startup.
   *
   * Without the startup run, an installation that is rolled out anew daily **never**
   * deletes — the operational bug, found at the `mail_log` purge — while the
   * surface keeps promising thirty days.
   *
   * *Reproduction:* remove the `void this.tick()` in `onModuleInit` → this
   * expectation turns red, all others of this file stay green (they call
   * `runOnce()` themselves).
   */
  it(
    'löscht schon beim Start, nicht erst ein Intervall später',
    async () => {
      const old = await row({ tenant: alpha, ageMs: RETENTION_MS + MINUTE_MS });

      const second = await createTestApp({
        databaseUrl: database.url,
        clock,
        env: { AI_USAGE_PURGE_INTERVAL_MS: HUGE_INTERVAL_MS },
      });
      try {
        const armed = second.app.get(AiPromptPurgeService);
        expect(armed.schedulerRunning).toBe(true);

        // The startup run is not awaited (`void this.tick()`), so its result is
        // waited for instead of guessing at a time span.
        const deadline = Date.now() + 10_000;
        for (;;) {
          const seen = await rawPrompt(old);
          if (seen?.prompt === null) {
            break;
          }
          if (Date.now() > deadline) {
            throw new Error('der Startlauf hat den Text nicht geleert');
          }
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 25).unref();
          });
        }

        expect(await rawRowCount()).toBe(1);
      } finally {
        await second.close();
      }
    },
    RESTART_TIMEOUT_MS,
  );

  /**
   * **The interval can be switched off, the retention period cannot.**
   *
   * `AI_USAGE_PURGE_INTERVAL_MS = 0` is the state of every test application of this
   * repository (otherwise a job would delete rows that another suite is currently
   * counting) — and it must **not** mean that deletion happens at startup.
   */
  it('armiert nichts, wenn das Intervall auf null steht', () => {
    expect(purge.schedulerRunning).toBe(false);
  });

  /**
   * **The second retention period of the same table** .
   *
   * Only the **free text** was decided. The row stayed standing
   * afterwards and kept carrying organisation, **person**, point in time, model and usage
   * — without any retention period, in a project with trash 30, prompts 30 and
   * `mail_log` 90.
   *
   * **Both together** are measured, because the decision is both:
   * the person goes, and the **counter stays**. An assurance that only
   * checks "`user_id` is `NULL`" would stay green if someone deleted the row
   * out of hand — and with it threw away the cost history in order to get rid of a
   * datum that can be got rid of on its own.
   */
  it(
    'nimmt der alten Zeile die Person und lässt den Zähler stehen',
    async () => {
      const person = await createUser(prisma, {
        email: 'bearbeiter@purge.example',
        password: 'passwort-fuer-den-test',
        tenants: [alpha],
      });
      const old = await row({
        tenant: alpha,
        ageMs: AI_USAGE_PERSON_RETENTION_DAYS * MS_PER_DAY + MINUTE_MS,
        userId: person.id,
      });
      const young = await row({
        tenant: alpha,
        ageMs: AI_USAGE_PERSON_RETENTION_DAYS * MS_PER_DAY - MINUTE_MS,
        userId: person.id,
      });

      expect(await purge.erasePersons()).toBe(1);

      // The old row has lost its person — **and is still standing there**, with
      // the model against which every cost attribution calculates.
      expect(await rawRow(old)).toStrictEqual({
        userId: null,
        model: 'claude-opus-5',
      });
      // The younger one on this side of the retention period is untouched.
      expect((await rawRow(young))?.userId).toBe(person.id);
      // And both rows are still there: counted without filter.
      expect(await rawRowCount()).toBe(2);
    },
    CASE_TIMEOUT_MS,
  );

  /**
   * **Idempotent, like the retention period next to it.** A second run answers `0` —
   * that is the number that distinguishes "there was nothing left" from "it fell
   * over beforehand". And it is the reason for the condition
   * `user_id IS NOT NULL`: without it every run would rewrite the same rows.
   */
  it('lässt einen zweiten Lauf nichts mehr finden', async () => {
    const person = await createUser(prisma, {
      email: 'zweitlauf@purge.example',
      password: 'passwort-fuer-den-test',
      tenants: [alpha],
    });
    await row({
      tenant: alpha,
      ageMs: AI_USAGE_PERSON_RETENTION_DAYS * MS_PER_DAY + MINUTE_MS,
      userId: person.id,
    });

    expect(await purge.erasePersons()).toBe(1);
    expect(await purge.erasePersons()).toBe(0);
  });

  /**
   * **The second retention period is booked along — before, it stood outside.**
   *
   * `erasePersons()` ran until 2026-08-12 *behind* `jobRuns.record(...)`,
   * while the comment next to it claimed it "counted along". It did
   * not: the `job_run` row had long been written with `outcome = 'ok'`
   * when the anonymisation failed. An `erasePersons()` that has been failing
   * every night for months thus left behind a **green** row every night —
   * and it is exactly this row that the operations watchdog reads.
   *
   * **Only the second half** is supposed to fail here: what is renamed is the column
   * `user_id`, which `runOnce()` does not touch. A mock on the service would prove
   * that a mock throws; a renamed column brings the error to where
   * it would arise in operation.
   *
   * *Reproduction:* pull `erasePersons()` behind `recordRun(...)` again →
   * this case turns red (`outcome` stands at `ok`), all others stay green.
   */
  it(
    'bucht ein Scheitern der Personen-Frist in die job_run-Zeile',
    async () => {
      await prisma.jobRun.deleteMany({});
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "ai_usage" RENAME COLUMN "user_id" TO "user_id_hidden"',
      );

      let second: TestApp | undefined;
      try {
        second = await createTestApp({
          databaseUrl: database.url,
          clock,
          env: { AI_USAGE_PURGE_INTERVAL_MS: HUGE_INTERVAL_MS },
        });

        const deadline = Date.now() + 10_000;
        let rows = await prisma.jobRun.findMany({
          where: { job: 'ai_prompt_purge' },
        });
        while (rows.length === 0 && Date.now() < deadline) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 25).unref();
          });
          rows = await prisma.jobRun.findMany({
            where: { job: 'ai_prompt_purge' },
          });
        }

        expect(rows).toHaveLength(1);
        const [row] = rows;
        expect(row?.outcome).toBe('failed');
        // The class, never the message — and the message would carry
        // the column name of the failed statement here.
        expect(row?.errorClass).not.toBeNull();
        expect(row?.errorClass).not.toContain('user_id');
      } finally {
        await second?.close();
        await prisma.$executeRawUnsafe(
          'ALTER TABLE "ai_usage" RENAME COLUMN "user_id_hidden" TO "user_id"',
        );
      }
    },
    RESTART_TIMEOUT_MS,
  );

  /**
   * **A run that fails says so** — review finding of the
   * security check (2026-08-10).
   *
   * `runTick` had an empty `catch`, and the class comment justified
   * that with a guard which, since an earlier change, no longer applies to this file
   * at all. What counts about it is not the log line: it is that a
   * permanently failing purge would otherwise be recognisable **only** by the rows
   * left lying around — while the surface keeps promising thirty
   * days.
   *
   * Two things at once, and both are the promise: the scheduled run **does not
   * reject** (a rejected promise from `setInterval` terminates the
   * process), and it leaves an error line behind.
   *
   * The error is produced **for real**: `ai_usage` is renamed, the startup run
   * of the second application runs against a table that does not exist, afterwards
   * it is renamed back. A mock on `$executeRaw` would only prove that a mock
   * throws. And it goes through the **scheduled** path, not through `runOnce()` —
   * the `catch` is the statement, and `runOnce()` does not drive into it at all.
   *
   * *Reproduction:* empty the `catch` again → `errors` stays empty and
   * this case red; all others stay green.
   */
  it(
    'meldet ein Scheitern, statt still weiterzulaufen',
    async () => {
      const errors: string[] = [];
      // The class's own logger, not a substituted one: what is measured is what
      // an operator finds in the log.
      const spy = vi
        .spyOn(Logger.prototype, 'error')
        .mockImplementation((message: unknown) => {
          errors.push(String(message));
        });
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "ai_usage" RENAME TO "ai_usage_hidden"',
      );

      let second: TestApp | undefined;
      try {
        second = await createTestApp({
          databaseUrl: database.url,
          clock,
          env: { AI_USAGE_PURGE_INTERVAL_MS: HUGE_INTERVAL_MS },
        });

        // Like the startup run above: wait for the result, do not guess at a
        // time span.
        const deadline = Date.now() + 10_000;
        while (errors.length === 0 && Date.now() < deadline) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 25).unref();
          });
        }
      } finally {
        await second?.close();
        await prisma.$executeRawUnsafe(
          'ALTER TABLE "ai_usage_hidden" RENAME TO "ai_usage"',
        );
        spy.mockRestore();
      }

      // The process is alive — `close()` above ran through without
      // `unhandledRejection` — and the failure stands in the log.
      expect(errors.join('\n')).toContain('ai prompt purge failed');
      // And **no** free text in it: the message carries the kind of the error,
      // not the parameters of the statement.
      expect(errors.join('\n')).not.toContain(SECRET);
    },
    RESTART_TIMEOUT_MS,
  );
});
