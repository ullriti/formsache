import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildAiFormRequest, type AiFormOutcome } from '@formsache/shared';
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
 * **The limit is bound to the tenant** (ADR-0015 no. 7, the evidence).
 *
 * Every case here is the **forbidden** one: a test that only shows that an
 * organisation spends and reads its own budget stays green against a delegate
 * without any binding at all. What is measured is therefore that ALPHA
 *
 * - does **not spend** BETA's budget,
 * - does **not read** BETA's rows, and
 * - **cannot write to** a row of BETA.
 *
 * `ai_usage` carries no composite foreign key that would catch a forgotten
 * binding (the way `mail_log` does): `ScopedAiUsageDelegate` **is** the tenant
 * boundary of this table.
 */

const SETUP_TIMEOUT_MS = 180_000;
const CASE_TIMEOUT_MS = 60_000;

const EPOCH = new Date('2026-06-15T09:00:00.000Z');

const OK: AiFormOutcome = { ok: true, draft: { pages: [] }, usage: null };

describe('KI-Verbrauch über die Organisationsgrenze', () => {
  let database: TestDatabase;
  let testApp: TestApp;
  let prisma: PrismaService;
  let usage: AiUsageService;
  let clock: MutableClock;

  let alpha: TenantFixture;
  let beta: TenantFixture;
  let alphaUserId: string;
  let betaUserId: string;

  const alphaScope = (): TenantScope => new TenantScope(prisma, alpha.id);
  const betaScope = (): TenantScope => new TenantScope(prisma, beta.id);

  async function spend(scope: TenantScope, userId: string) {
    const controller = new AbortController();
    const double = new RecordedFormGenerator(OK);
    const result = await usage.spend(
      scope,
      {
        userId,
        request: buildAiFormRequest({ prompt: 'Anmeldung', language: 'de' }),
        // Provider and model are passed in by the caller — from the same
        // resolution the adapter came out of.
        provider: 'anthropic',
        model: 'claude-opus-5',
        modelResolved: null,
      },
      (request) => double.generate(request, controller.signal),
    );
    return { result, attempts: double.attempts };
  }

  async function rawCount(tenantId: string): Promise<number> {
    const rows = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count
        FROM "ai_usage"
       WHERE "tenant_id" = ${tenantId}::uuid`;
    return Number(rows[0]?.count ?? 0n);
  }

  beforeAll(async () => {
    database = await acquireTestDatabase();
    clock = new MutableClock(EPOCH);
    testApp = await createTestApp({
      databaseUrl: database.url,
      clock,
      ai: { provider: 'anthropic', apiKey: 'test-key-not-a-real-one' },
    });
    prisma = testApp.prisma;
    usage = testApp.app.get(AiUsageService);

    alpha = await createTenant(prisma, 'KIALPHA');
    beta = await createTenant(prisma, 'KIBETA');
    alphaUserId = (
      await createUser(prisma, {
        email: 'alpha@ki.example.org',
        password: 'passwort-fuer-den-test',
        tenants: [alpha],
      })
    ).id;
    betaUserId = (
      await createUser(prisma, {
        email: 'beta@ki.example.org',
        password: 'passwort-fuer-den-test',
        tenants: [beta],
      })
    ).id;
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await testApp.close();
    await database.release();
  });

  beforeEach(async () => {
    clock.set(EPOCH);
    await prisma.aiUsage.deleteMany({});
    await prisma.tenant.updateMany({ data: { aiMonthlyCallLimit: 50 } });
  });

  /**
   * **Organisation A does not spend organisation B's budget.**
   *
   * BETA has a quota of 1 and spends it. ALPHA is untouched by that — even
   * though there is a row in the table.
   */
  it(
    'lässt ALPHA aufrufen, nachdem BETA sein Kontingent aufgebraucht hat',
    async () => {
      await prisma.tenant.update({
        where: { id: beta.id },
        data: { aiMonthlyCallLimit: 1 },
      });

      expect((await spend(betaScope(), betaUserId)).result.spent).toBe(true);
      const second = await spend(betaScope(), betaUserId);
      expect(second.result.spent).toBe(false);
      // The spy: BETA's second call did not go out.
      expect(second.attempts).toBe(0);

      const forAlpha = await spend(alphaScope(), alphaUserId);
      expect(forAlpha.result.spent).toBe(true);
      expect(forAlpha.result).toMatchObject({
        quota: { used: 1, limit: 50 },
      });
    },
    CASE_TIMEOUT_MS,
  );

  /**
   * **Organisation A does not read organisation B's budget.**
   *
   * BETA has three rows; ALPHA sees zero. Counted raw, alongside it stands the
   * fact that the rows really do exist — otherwise a zero would only prove
   * that nothing was written.
   */
  it(
    'zeigt ALPHA nichts von BETAs Verbrauch',
    async () => {
      for (let index = 0; index < 3; index += 1) {
        await spend(betaScope(), betaUserId);
      }

      expect(await rawCount(beta.id)).toBe(3);
      expect(await rawCount(alpha.id)).toBe(0);
      expect(await usage.quota(alphaScope())).toStrictEqual({
        used: 0,
        limit: 50,
      });
      expect(await usage.quota(betaScope())).toStrictEqual({
        used: 3,
        limit: 50,
      });
    },
    CASE_TIMEOUT_MS,
  );

  /**
   * **The resolved version lands on the row — and `null` is an answer**
   * (2026-08-12).
   *
   * Since the selection list is built on aliases, the provider reports the
   * *alias* back in its response; `model` alone could therefore never say which
   * version ran. The second column separates observed from derived.
   *
   * The case runs both values through the same seam, because only that proves
   * anything: that `null` arrives would also be true of a column that *always*
   * stays `null` — exactly the state a forgotten field in the `create`
   * produces.
   *
   * *Reproduction:* take `modelResolved` out of the `create` in `reserve` →
   * the second half turns red and reports `null` instead of the version.
   */
  it(
    'schreibt die aufgelöste Modellfassung auf die Zeile, auch als null',
    async () => {
      const rowFor = async (resolved: string | null) => {
        await prisma.aiUsage.deleteMany({});
        const controller = new AbortController();
        const double = new RecordedFormGenerator(OK);
        await usage.spend(
          alphaScope(),
          {
            userId: alphaUserId,
            request: buildAiFormRequest({
              prompt: 'Anmeldung',
              language: 'de',
            }),
            provider: 'anthropic',
            model: 'mistral-large-latest',
            modelResolved: resolved,
          },
          (request) => double.generate(request, controller.signal),
        );
        return prisma.aiUsage.findFirstOrThrow({
          where: { tenantId: alpha.id },
          select: { model: true, modelResolved: true },
        });
      };

      expect(await rowFor('mistral-large-2512')).toStrictEqual({
        // **Both**, and that is the point: the alias the provider names, and
        // next to it the version it meant.
        model: 'mistral-large-latest',
        modelResolved: 'mistral-large-2512',
      });
      expect(await rowFor(null)).toStrictEqual({
        model: 'mistral-large-latest',
        modelResolved: null,
      });
    },
    CASE_TIMEOUT_MS,
  );

  /**
   * **Organisation A writes to no row of organisation B.**
   *
   * The forbidden write access, with the identifier of a foreign row in hand:
   * `recordVerdict` hits nothing, because `tenant_id` is in the predicate of
   * the statement. The row keeps its verdict.
   *
   * *Reproduction:* in the delegate write `updateMany({ where: { id } })`
   * without `tenantId` — which with `update` would even be the obvious version,
   * because `id` is the unique key → this case turns red.
   */
  it(
    'lässt ALPHA das Urteil einer BETA-Zeile nicht überschreiben',
    async () => {
      const foreign = await prisma.aiUsage.create({
        data: {
          tenantId: beta.id,
          userId: betaUserId,
          createdAt: EPOCH,
          provider: AiProvider.anthropic,
          model: 'claude-opus-5',
          outcome: AiOutcome.ok,
          prompt: 'BETAs Text',
        },
        select: { id: true },
      });

      await alphaScope().aiUsage.recordVerdict(foreign.id, {
        outcome: 'refused',
        usage: {
          provider: 'anthropic',
          model: 'fremdes-modell',
          inputTokens: 99,
          outputTokens: 99,
        },
      });

      const after = await prisma.aiUsage.findUniqueOrThrow({
        where: { id: foreign.id },
        select: { outcome: true, model: true, inputTokens: true },
      });
      expect(after).toStrictEqual({
        outcome: AiOutcome.ok,
        model: 'claude-opus-5',
        inputTokens: null,
      });
    },
    CASE_TIMEOUT_MS,
  );

  /**
   * **A deleted organisation spends nothing** — and the call does not happen.
   *
   * The guard chain keeps it away anyway; this here is the floor beneath it.
   * The answer is the same as for "switched off": 0 of 0.
   */
  it(
    'ruft für eine gelöschte Organisation gar nicht erst',
    async () => {
      await prisma.tenant.update({
        where: { id: beta.id },
        data: { deletedAt: EPOCH },
      });
      try {
        const attempt = await spend(betaScope(), betaUserId);

        expect(attempt.result).toStrictEqual({
          spent: false,
          quota: { used: 0, limit: 0 },
        });
        expect(attempt.attempts).toBe(0);
        expect(await rawCount(beta.id)).toBe(0);
      } finally {
        await prisma.tenant.update({
          where: { id: beta.id },
          data: { deletedAt: null },
        });
      }
    },
    CASE_TIMEOUT_MS,
  );
});
