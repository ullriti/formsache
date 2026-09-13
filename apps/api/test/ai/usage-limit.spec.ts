import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AI_FAILURE_KINDS,
  buildAiFormRequest,
  type AiFormOutcome,
} from '@formsache/shared';
import { AiOutcome, AiProvider } from '@prisma/client';

import { AiUsageService } from '../../src/ai/usage/ai-usage.service';
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
import { RecordedFormGenerator } from '../support/recorded-form-generator';

/**
 * **The usage limit: transactional, before the call, and one failure counts
 * once** (ADR-0015 no. 7).
 *
 * ## Why the test pair is sequential **and** parallel
 *
 * Because the wrong construction — `count()` and then `insert`, without a lock
 * — **passes** the sequential run. It only overbooks once two calls
 * read the same number before either of them has written, and that happens
 * only in parallel. Precisely that was measured once on this construction: 15
 * instead of 10. A test that checks only the sequential case is therefore green
 * against a counter that costs money.
 *
 * ## Why a spy and not just a 429
 *
 * „Refused" and „refused, **before** the request goes out" are two
 * different promises, and only the second one saves anything: the provider
 * charges for a call that our layer discards afterwards. `RecordedFormGenerator`
 * counts its calls, and with an exhausted quota this number has to stay
 * **zero**.
 *
 * ## And why one case reads the counter *in flight*
 *
 * The spy shows „not called"; it does not show that the row already stands
 * when the call is made. The callback itself therefore looks into the database
 * once: its own row is there, committed, with `outcome IS NULL`. A counter
 * behind the call turns exactly this case red.
 */

const SETUP_TIMEOUT_MS = 180_000;
const CASE_TIMEOUT_MS = 60_000;
const PARALLEL_TIMEOUT_MS = 120_000;

/** A fixed point in time far away from any month boundary. */
const EPOCH = new Date('2026-06-15T09:00:00.000Z');

/** The outcome the double plays when a case does not want anything else. */
const FAILURE: AiFormOutcome = {
  ok: false,
  failure: 'rate_limited',
  usage: null,
};

describe('das KI-Nutzungslimit ', () => {
  let database: TestDatabase;
  let testApp: TestApp;
  let prisma: PrismaService;
  let usage: AiUsageService;
  let clock: MutableClock;

  let tenant: TenantFixture;
  let userId: string;

  /** The scope a request of this organisation would get. */
  function scope(): TenantScope {
    return new TenantScope(prisma, tenant.id);
  }

  /**
   * One call through the bracket, with a double as the provider.
   *
   * Exactly the wiring the route takes: the counter gets the
   * request, the double gets it from the counter.
   */
  async function spend(
    double: RecordedFormGenerator,
    prompt = 'Ein Formular für die Bestandsmeldung',
  ) {
    const controller = new AbortController();
    return usage.spend(
      scope(),
      {
        userId,
        request: buildAiFormRequest({ prompt, language: 'de' }),
        provider: 'anthropic',
        model: 'claude-opus-5',
        modelResolved: null,
      },
      (request) => double.generate(request, controller.signal),
    );
  }

  /** Rows of this organisation, counted raw — not through the repository. */
  async function rowCount(): Promise<number> {
    const rows = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count
        FROM "ai_usage"
       WHERE "tenant_id" = ${tenant.id}::uuid`;
    return Number(rows[0]?.count ?? 0n);
  }

  async function outcomes(): Promise<(AiOutcome | null)[]> {
    const rows = await prisma.$queryRaw<{ outcome: AiOutcome | null }[]>`
      SELECT "outcome"
        FROM "ai_usage"
       WHERE "tenant_id" = ${tenant.id}::uuid
       ORDER BY "created_at"`;
    return rows.map((row) => row.outcome);
  }

  async function setLimit(limit: number): Promise<void> {
    await prisma.tenant.update({
      where: { id: tenant.id },
      data: { aiMonthlyCallLimit: limit },
    });
  }

  beforeAll(async () => {
    database = await acquireTestDatabase();
    clock = new MutableClock(EPOCH);
    testApp = await createTestApp({
      databaseUrl: database.url,
      clock,
      // The feature is set up — otherwise `spend` is a
      // programming error instead of a counter (ADR-0015 no. 9).
      ai: { provider: 'anthropic', apiKey: 'test-key-not-a-real-one' },
    });
    prisma = testApp.prisma;
    usage = testApp.app.get(AiUsageService);

    tenant = await createTenant(prisma, 'KILIMIT');
    const user = await createUser(prisma, {
      email: 'bearbeiter@kilimit.example.org',
      password: 'passwort-fuer-den-test',
      tenants: [tenant],
    });
    userId = user.id;
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await testApp.close();
    await database.release();
  });

  beforeEach(async () => {
    clock.set(EPOCH);
    await prisma.aiUsage.deleteMany({ where: { tenantId: tenant.id } });
  });

  /**
   * **The enumeration of the database is the shared enumeration** (ADR-0015
   * no. 2 and no. 8).
   *
   * `outcome` carries the `AiFailureKind` so that a permanently wrong
   * configuration is observable at all — otherwise every call fails as
   * `unavailable` and cannot be told apart from „provider away right now".
   * This promise only holds as long as both enumerations are the same.
   *
   * *Reproduction:* add a seventh `AiFailureKind` in `packages/shared`
   * without a migration → red here, instead of only at the first call that
   * hits it, with a constraint error in an application that has long been running.
   */
  it('kennt in der Datenbank genau die Ausgänge, die Naht kennt', () => {
    expect(new Set(Object.values(AiOutcome))).toStrictEqual(
      new Set<string>(['ok', ...AI_FAILURE_KINDS]),
    );
    expect(new Set(Object.values(AiProvider))).toStrictEqual(
      new Set<string>(['anthropic', 'mistral']),
    );
  });

  /**
   * **Sequential — and at the same time the case that nails down „one
   * failure counts once"** (ADR-0015 no. 7).
   *
   * Remaining budget 5, the double **always** fails: five calls go through, the
   * sixth is refused, the double has seen **five** calls, and
   * `ai_usage` carries five rows with `outcome != 'ok'`.
   *
   * ⚠️ This case is green under the wrong construction too — it stands here to
   * be compared with the parallel one.
   *
   * *Reproduction:* build in a return path for the error case (`catch` deletes
   * the row, or `spend` gives the quota back on `!outcome.ok`) → the
   * sixth call goes through, and all three numbers here are wrong.
   */
  it(
    'lässt genau fünf Fehlschläge durch und weist den sechsten ab',
    async () => {
      await setLimit(5);
      const double = new RecordedFormGenerator(FAILURE);

      for (let index = 0; index < 5; index += 1) {
        const result = await spend(double);
        expect(result.spent).toBe(true);
        expect(result.quota).toStrictEqual({ used: index + 1, limit: 5 });
      }

      const sixth = await spend(double);

      expect(sixth.spent).toBe(false);
      expect(sixth.quota).toStrictEqual({ used: 5, limit: 5 });
      // The spy: the sixth call **did not go out**.
      expect(double.attempts).toBe(5);
      expect(await rowCount()).toBe(5);
      expect(await outcomes()).toStrictEqual(
        Array.from({ length: 5 }, () => AiOutcome.rate_limited),
      );
    },
    CASE_TIMEOUT_MS,
  );

  /**
   * **Parallel — the only case that tells the lock apart from `count()` +
   * `insert`**.
   *
   * Twenty simultaneous calls with a remaining budget of 5 yield **exactly 5**.
   * All twenty are under way before a single one is awaited; only that way do
   * counting and writing really interleave.
   *
   * *Reproduction:* in the delegate, replace the `SELECT … FOR UPDATE` with a
   * plain `SELECT` → this case goes red (measured once on the same
   * construction: 15 instead of 10), the sequential one above stays green.
   */
  it(
    'lässt bei zwanzig gleichzeitigen Aufrufen und Restbudget fünf genau fünf durch',
    async () => {
      await setLimit(5);
      const double = new RecordedFormGenerator(FAILURE);

      const results = await Promise.all(
        Array.from({ length: 20 }, () => spend(double)),
      );

      expect(results.filter((one) => one.spent)).toHaveLength(5);
      expect(results.filter((one) => !one.spent)).toHaveLength(15);
      // The rows are the claim; the return values are how it was reported.
      expect(await rowCount()).toBe(5);
      // And the money: fifteen calls never went out.
      expect(double.attempts).toBe(5);
      // Every success saw a different number — 1…5, none twice. Two
      // identical ones would be two reservations that read the same state.
      expect(
        new Set(
          results.filter((one) => one.spent).map((one) => one.quota.used),
        ),
      ).toStrictEqual(new Set([1, 2, 3, 4, 5]));
    },
    PARALLEL_TIMEOUT_MS,
  );

  /**
   * **The expensive half: counting happens *before* the call**.
   *
   * The callback looks into the database while it runs: its row already
   * stands, committed, and carries **no** verdict yet.
   *
   * *Reproduction:* move the reservation behind the call → the callback
   * sees zero rows. That is the error that costs money and not just
   * state: a counter behind it prevents not a single paid call.
   */
  it(
    'hat die Zeile geschrieben, bevor der Anbieter überhaupt gerufen wird',
    async () => {
      await setLimit(3);
      let seenWhileCalling = -1;
      let outcomeWhileCalling: (AiOutcome | null)[] = [];

      const result = await usage.spend(
        scope(),
        {
          userId,
          request: buildAiFormRequest({
            prompt: 'Sterbefallmeldung',
            language: 'de',
          }),
          provider: 'anthropic',
          model: 'claude-opus-5',
          modelResolved: null,
        },
        async () => {
          seenWhileCalling = await rowCount();
          outcomeWhileCalling = await outcomes();
          return FAILURE;
        },
      );

      expect(result.spent).toBe(true);
      expect(seenWhileCalling).toBe(1);
      // No verdict while the call runs — exactly the state for which the
      // column is nullable.
      expect(outcomeWhileCalling).toStrictEqual([null]);
      // And afterwards it stands there.
      expect(await outcomes()).toStrictEqual([AiOutcome.rate_limited]);
    },
    CASE_TIMEOUT_MS,
  );

  /**
   * **A quota of 0 is the off switch per organisation** (ADR-0015 no. 7 and
   * no. 9) — and it takes effect **before** the call.
   */
  it(
    'ruft bei einem Kontingent von null gar nicht erst',
    async () => {
      await setLimit(0);
      const double = new RecordedFormGenerator(FAILURE);

      const result = await spend(double);

      expect(result).toStrictEqual({
        spent: false,
        quota: { used: 0, limit: 0 },
      });
      expect(double.attempts).toBe(0);
      // A refusal writes nothing: it has cost no call.
      expect(await rowCount()).toBe(0);
    },
    CASE_TIMEOUT_MS,
  );

  /**
   * **The consumption is that of a calendar month — read in Berlin**
   * (ADR-0015 no. 7).
   *
   * The clock stands at 1 August, 00:30 Berlin time; the row before it
   * comes from 31 July, 23:30 Berlin time. It no longer counts along.
   *
   * *Reproduction:* compute the start of the month in UTC — then „now" is
   * 31 July 22:30 UTC, the month begins on 1 July, and the July row
   * counts against the August budget. An organisation would thus lose, on every
   * first of the month, two hours' worth of calls that belong to it.
   */
  it(
    'zählt nur den laufenden Kalendermonat, in Berliner Zeit',
    async () => {
      await setLimit(1);
      // 31 July 2026, 23:30 CEST.
      await prisma.aiUsage.create({
        data: {
          tenantId: tenant.id,
          userId,
          createdAt: new Date('2026-07-31T21:30:00.000Z'),
          provider: AiProvider.anthropic,
          model: 'claude-opus-5',
          outcome: AiOutcome.ok,
          prompt: 'Aus dem Juli',
        },
      });

      // 1 August 2026, 00:30 CEST.
      clock.set(new Date('2026-08-01T00:30:00.000Z'));
      expect(await usage.quota(scope())).toStrictEqual({ used: 0, limit: 1 });

      const double = new RecordedFormGenerator(FAILURE);
      expect((await spend(double)).spent).toBe(true);
      expect(double.attempts).toBe(1);
      // Two rows in the table, but only one in August.
      expect(await rowCount()).toBe(2);
      expect(await usage.quota(scope())).toStrictEqual({ used: 1, limit: 1 });
    },
    CASE_TIMEOUT_MS,
  );

  /**
   * **What the provider says about itself is noted down — and what it says
   * that is implausible costs the note and nothing else** (ADR-0015 no. 7).
   *
   * The second half is the reason: `aiUsageSampleSchema` binds the tokens to
   * „integral, not negative" and to nothing else. A number beyond
   * `INTEGER` would pass the seam and let the `UPDATE` **after** the call
   * fail — a generated form would turn into an error because of an
   * observation that nobody asked for.
   */
  it(
    'schreibt Token und Modell mit — und lässt eine unmögliche Zahl fallen',
    async () => {
      await setLimit(4);

      const good = new RecordedFormGenerator({
        ok: true,
        draft: { pages: [] },
        usage: {
          provider: 'anthropic',
          model: 'claude-opus-5-1234',
          inputTokens: 812,
          outputTokens: 1_400,
        },
      });
      await spend(good, 'Erste Anfrage');

      const absurd = new RecordedFormGenerator({
        ok: true,
        draft: { pages: [] },
        usage: {
          provider: 'anthropic',
          model: 'claude-opus-5-1234',
          inputTokens: 1_000_000_000_000_000,
          outputTokens: 3,
        },
      });
      await spend(absurd, 'Zweite Anfrage');

      const rows = await prisma.aiUsage.findMany({
        where: { tenantId: tenant.id },
        orderBy: { createdAt: 'asc' },
        select: {
          model: true,
          outcome: true,
          inputTokens: true,
          outputTokens: true,
        },
      });

      expect(rows).toStrictEqual([
        {
          // The identifier reported back by the provider, not the configured
          // one: what is charged is what ran.
          model: 'claude-opus-5-1234',
          outcome: AiOutcome.ok,
          inputTokens: 812,
          outputTokens: 1_400,
        },
        {
          model: 'claude-opus-5-1234',
          outcome: AiOutcome.ok,
          inputTokens: null,
          outputTokens: 3,
        },
      ]);
    },
    CASE_TIMEOUT_MS,
  );

  /**
   * **An adapter that throws contrary to the contract still gives nothing
   * back** (ADR-0015 no. 7).
   *
   * The provider charges for a call that has been started, whether our layer
   * above it keeps it or not. The row stays, and it says `unavailable`.
   */
  it(
    'behält den Verbrauch, wenn der Adapter wirft',
    async () => {
      await setLimit(2);

      await expect(
        usage.spend(
          scope(),
          {
            userId,
            request: buildAiFormRequest({ prompt: 'Wirft', language: 'de' }),
            provider: 'anthropic',
            model: 'claude-opus-5',
            modelResolved: null,
          },
          () => Promise.reject(new Error('SDK kaputt')),
        ),
      ).rejects.toThrow('SDK kaputt');

      expect(await rowCount()).toBe(1);
      expect(await outcomes()).toStrictEqual([AiOutcome.unavailable]);
      expect(await usage.quota(scope())).toStrictEqual({ used: 1, limit: 2 });
    },
    CASE_TIMEOUT_MS,
  );
});
