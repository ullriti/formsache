import {
  AI_MONTHLY_CALL_LIMIT_MAX,
  DEFAULT_AI_MONTHLY_CALL_LIMIT,
  parseTenantOverview,
} from '@formsache/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TENANT_NOT_FOUND_MESSAGE } from '../../src/admin/admin.service';
import { NOT_SUPERADMIN_MESSAGE } from '../../src/auth/superadmin.guard';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import {
  apiPath,
  createTestApp,
  type TestApp,
} from '../support/create-test-app';
import {
  createTenant,
  createUser,
  type TenantFixture,
} from '../support/fixtures';
import { authedMutation, cookieHeader, openSession } from '../support/http';

/**
 * **The AI quota is settable — by the superadmin, not by the organisation**
 * (Konzept no. 7 and no. 86).
 *
 * Konzept no. 7 demands „Nutzungslimit muss in der UI setzbar sein", Konzept
 * No. 86 decides **who**: the superadmin. The two sentences together are the
 * reason why this file exists and why half of its cases measure *refusals* — a
 * number that anybody can set is, for a service that costs money, not a limit
 * but a lever.
 *
 * ## The three assurances
 *
 * 1. The superadmin sets it, and the next `GET` carries it.
 * 2. An **organisation admin** does not get at it — 403, and the number stands
 *    unchanged in the column afterwards. The second part is the more important
 *    one: a 403 after which the value was written anyway is no guard.
 * 3. `0` is valid and means **switched off**, not „unlimited". That is the
 *    expensive misreading, and it falls in the wrong direction.
 *
 * ## Counter-checks that were run
 *
 * - `aiQuotaWriteSchema` set from `nonnegative()` to `positive()` →
 *   „nimmt 0 als Abschalter" red with 400 instead of 204.
 * - `SuperadminGuard` removed from the guard chain of the controller → „lässt
 *   einen Organisationsadmin nicht an das Budget seiner eigenen Organisation" red
 *   with 204 instead of 403, **and** the line below it red, because the column
 *   has moved.
 * - `deletedAt: null` removed from the `where` of `setAiMonthlyCallLimit` →
 *   „antwortet 404 für eine gelöschte Organisation" red with 204.
 */

const PASSWORD = 'test-password-c5';
const TENANTS = apiPath('/admin/tenants');

describe('das KI-Kontingent setzen ', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  let alpha: TenantFixture;
  let superadmin: string;
  let tenantAdmin: string;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });

    alpha = await createTenant(testApp.prisma, 'QUOTA');
    const root = await createUser(testApp.prisma, {
      email: 'root@quota.example',
      password: PASSWORD,
      tenants: [alpha],
      isSuperadmin: true,
    });
    superadmin = await openSession(testApp, root.id, alpha.id);

    // A perfectly ordinary organisation administrator: full permissions **in**
    // their organisation, and precisely therefore the right touchstone — if
    // anybody should be able to raise the budget of their own organisation,
    // then they.
    const admin = await createUser(testApp.prisma, {
      email: 'admin@quota.example',
      password: PASSWORD,
      tenants: [alpha],
    });
    tenantAdmin = await openSession(testApp, admin.id, alpha.id);
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  /** The quota as it stands in the database — not as it is reported. */
  async function storedLimit(tenantId: string): Promise<number> {
    const row = await app().prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { aiMonthlyCallLimit: true },
    });
    return row.aiMonthlyCallLimit;
  }

  /** The quota as the overview shows it — the way of the interface. */
  async function reportedLimit(tenantId: string): Promise<number | undefined> {
    const response = await request(app().server)
      .get(TENANTS)
      .set('Cookie', cookieHeader(superadmin));
    expect(response.status).toBe(200);
    return parseTenantOverview(response.body).tenants.find(
      (row) => row.tenant.id === tenantId,
    )?.aiMonthlyCallLimit;
  }

  function setQuota(session: string, tenantId: string, body: object) {
    return request(app().server)
      .put(`${TENANTS}/${tenantId}/ai-quota`)
      .set(authedMutation(session))
      .send(body);
  }

  it('fängt bei der Vorgabe an', async () => {
    // The number comes from the column default, not from a `create` of the
    // fixture — otherwise the case would run against itself here.
    expect(await storedLimit(alpha.id)).toBe(DEFAULT_AI_MONTHLY_CALL_LIMIT);
    expect(await reportedLimit(alpha.id)).toBe(DEFAULT_AI_MONTHLY_CALL_LIMIT);
  });

  it('lässt den Superadmin das Kontingent setzen, und die Übersicht trägt es', async () => {
    const response = await setQuota(superadmin, alpha.id, {
      monthlyCallLimit: 7,
    });

    expect(response.status).toBe(204);
    // Both ways: the column itself **and** the response the interface reads.
    // Checking only the column would let through an overview that shows a
    // different number than the one the counter refuses against.
    expect(await storedLimit(alpha.id)).toBe(7);
    expect(await reportedLimit(alpha.id)).toBe(7);
  });

  it('nimmt 0 als Abschalter dieser Organisation', async () => {
    // `0` is valid and means **off** (ADR-0015 no. 9) — not „unlimited". A
    // schema with `positive()` would answer 400 here and would block the only
    // way to switch the feature off per organisation.
    const response = await setQuota(superadmin, alpha.id, {
      monthlyCallLimit: 0,
    });

    expect(response.status).toBe(204);
    expect(await storedLimit(alpha.id)).toBe(0);
  });

  it('lässt einen Organisationsadmin nicht an das Budget seiner eigenen Organisation', async () => {
    await setQuota(superadmin, alpha.id, { monthlyCallLimit: 12 });

    const refused = await setQuota(tenantAdmin, alpha.id, {
      monthlyCallLimit: 9999,
    });

    expect(refused.status).toBe(403);
    expect(refused.text).toContain(NOT_SUPERADMIN_MESSAGE);
    // **The actual assurance.** A 403 after which the number nevertheless stands
    // in the column is no guard, but a message.
    expect(await storedLimit(alpha.id)).toBe(12);
  });

  it('weist eine Zahl über der Obergrenze und eine negative ab', async () => {
    await setQuota(superadmin, alpha.id, { monthlyCallLimit: 12 });

    const tooLarge = await setQuota(superadmin, alpha.id, {
      monthlyCallLimit: AI_MONTHLY_CALL_LIMIT_MAX + 1,
    });
    const negative = await setQuota(superadmin, alpha.id, {
      monthlyCallLimit: -1,
    });
    const fractional = await setQuota(superadmin, alpha.id, {
      monthlyCallLimit: 1.5,
    });

    expect(tooLarge.status).toBe(400);
    expect(negative.status).toBe(400);
    expect(fractional.status).toBe(400);
    expect(await storedLimit(alpha.id)).toBe(12);
  });

  it('antwortet 404 für eine unbekannte und für eine gelöschte Organisation', async () => {
    const doomed = await createTenant(app().prisma, 'GONE');
    await app().prisma.tenant.update({
      where: { id: doomed.id },
      data: { deletedAt: new Date() },
    });

    const unknown = await setQuota(
      superadmin,
      '019ff300-0000-7000-8000-0000000000ff',
      { monthlyCallLimit: 5 },
    );
    const deleted = await setQuota(superadmin, doomed.id, {
      monthlyCallLimit: 5,
    });

    expect(unknown.status).toBe(404);
    expect(unknown.text).toContain(TENANT_NOT_FOUND_MESSAGE);
    // The same response for „does not exist" and „lies in the trash", as with
    // every other route of this controller except `restore`.
    expect(deleted.status).toBe(404);
    expect(await storedLimit(doomed.id)).toBe(DEFAULT_AI_MONTHLY_CALL_LIMIT);
  });
});
