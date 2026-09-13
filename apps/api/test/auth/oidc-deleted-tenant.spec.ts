import { randomUUID } from 'node:crypto';

import { startFakeIdp, type FakeIdp } from '@formsache/test-idp';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import {
  TEST_PUBLIC_BASE_URL,
  apiPath,
  createTestApp,
  type TestApp,
} from '../support/create-test-app';
import { createTenant, type TenantFixture } from '../support/fixtures';
import { TEST_REDIRECT_URI, configureOidc, outcomeOf } from './oidc-flow';

/**
 * **Filter 3 of the six of the requirement — the SSO-Anmeldung**
 * (`OidcTenantsService`).
 *
 * ## Why this is a file of its own and not a case in `tenant-trash.spec.ts`
 *
 * „Anmeldung" is **two** queries, not one. The local login reads the person and
 * their memberships (filter 1, `membershipInclude`); the SSO login reads the
 * *Organisation* — by id, from a route reachable **without a session**, before anybody
 * is signed in at all. Filter 1 cannot reach it: there is no membership list
 * yet. So it needs its own condition, and a condition needs its own test.
 *
 * It lives here because it needs a fake identity provider, and the trash
 * suite does not.
 *
 * ## What „unbenutzbar" has to mean on this path
 *
 * Both halves, and the requirement's own reading applies unchanged:
 * **abwesend *und* verschlossen**. The button disappears from
 * `GET /api/auth/oidc/providers` — that is the Komfort half — and
 * `GET /api/auth/oidc/start/:tenantId`, called directly with the id somebody
 * noted down last week, refuses. If only the list filtered, the deleted Organisation
 * would still mint sessions for anybody who kept the URL.
 *
 * *Reproduction, measured on 2026-08-03:* `deletedAt: null` removed from
 * `OidcTenantsService.findById` **and** `findOfferable` → both cases below red;
 * removing it from `findOfferable` alone leaves the offer list red and the
 * start route green, which is exactly the split „abwesend *und* verschlossen"
 * exists to forbid.
 */

const SETUP_TIMEOUT_MS = 180_000;
const CLIENT_ID = 'formular-geloescht';
const CLIENT_SECRET = 'secret-of-geloescht';

describe('SSO-Anmeldung an einer gelöschten Organisation (filter 3)', () => {
  let database: TestDatabase | undefined;
  let testApp: TestApp;
  let idp: FakeIdp;
  let Organisation: TenantFixture;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({
      databaseUrl: database.url,
      systemMail: { publicBaseUrl: TEST_PUBLIC_BASE_URL },
    });
    idp = await startFakeIdp(CLIENT_ID, CLIENT_SECRET, {
      redirectUri: TEST_REDIRECT_URI,
    });

    Organisation = await createTenant(testApp.prisma, 'SSOWEG');
    // Fully configured and switched **on**. A half-configured Organisation would prove
    // nothing: this requirement is about `deleted_at`, not about missing fields.
    await configureOidc(testApp, Organisation.id, idp, {
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      buttonLabel: 'Mit SSOWEG-Konto anmelden',
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await idp.close();
    await testApp.close();
    await database?.release();
  }, 120_000);

  /** `deleted_at` written the way the route writes it — the column, one value. */
  async function setDeleted(at: Date | null): Promise<void> {
    await app().prisma.tenant.update({
      where: { id: Organisation.id },
      data: { deletedAt: at },
    });
  }

  it('offers the button while the organisation lives', async () => {
    const response = await request(app().server).get(
      apiPath('/auth/oidc/providers'),
    );
    expect(response.status).toBe(200);
    expect(
      (response.body as { tenantId: string }[]).map((row) => row.tenantId),
    ).toContain(Organisation.id);
  }, 120_000);

  it('filter 3 — the deleted Organisation offers no login button', async () => {
    await setDeleted(new Date('2026-08-03T12:00:00.000Z'));
    try {
      const response = await request(app().server).get(
        apiPath('/auth/oidc/providers'),
      );
      expect(response.status).toBe(200);
      expect(
        (response.body as { tenantId: string }[]).map((row) => row.tenantId),
      ).not.toContain(Organisation.id);
    } finally {
      await setDeleted(null);
    }
  }, 120_000);

  /**
   * The half that stays true when nobody looks at the surface — and the one a
   * filter applied only to the list would leave wide open.
   */
  it('filter 3 — the start route refuses it, exactly as it refuses an invented Organisation', async () => {
    await setDeleted(new Date('2026-08-03T12:00:00.000Z'));
    try {
      const deleted = await request(app().server).get(
        apiPath(`/auth/oidc/start/${Organisation.id}`),
      );
      const invented = await request(app().server).get(
        apiPath(`/auth/oidc/start/${randomUUID()}`),
      );

      expect(deleted.status).toBe(302);
      expect(outcomeOf(deleted)).toBe('fehlgeschlagen');
      // Byte-identical with an id that never existed: whether an organisation exists is
      // a fact about somebody else's Organisation.
      expect(deleted.status).toBe(invented.status);
      expect(outcomeOf(deleted)).toBe(outcomeOf(invented));
      // Nothing was started — no transaction cookie, so there is no way to
      // continue with a code a provider might hand out anyway.
      expect(deleted.headers['set-cookie']).toBeUndefined();
    } finally {
      await setDeleted(null);
    }
  }, 120_000);

  it('works again after the restore ', async () => {
    const started = await request(app().server).get(
      apiPath(`/auth/oidc/start/${Organisation.id}`),
    );
    expect(started.status).toBe(302);
    expect(outcomeOf(started)).toBeNull();
  }, 120_000);
});
