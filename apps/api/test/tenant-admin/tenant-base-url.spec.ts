import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PublicUrlService } from '../../src/common/public-url/public-url.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
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
import {
  createRestrictedMember,
  createTenant,
  createUser,
  type TenantFixture,
} from '../support/fixtures';
import { authedMutation, cookieHeader, openSession } from '../support/http';

/**
 * The organisation's own base address — the write path that a review found
 * missing (ADR-0013 no. 3).
 *
 * **Its own route, its own suite, next to `smtp-config.spec.ts` rather than
 * folded into it** — for the identical reason the route itself is separate:
 * the address is explicitly not part of the indivisible SMTP block, so it is
 * set and cleared independently of `source`, and the two routes' tests must
 * not be able to hide a leak between them.
 *
 * What is proven here is the **round trip through the chain a mail actually
 * uses**: `PublicUrlService.responseEditUrl`, the function
 * `queued-body-renderer.ts` calls to build the Bearbeiten-Link — not merely
 * that the column changed. A test that only checked the column would not
 * notice a write that landed in the wrong place or under the wrong key.
 */

const BASE_URL_PATH = '/tenant/base-url';

describe('the organisation’s own base address, through its route', () => {
  let database: TestDatabase | undefined;
  let testApp: TestApp | undefined;
  let prisma: PrismaService;

  let alpha: TenantFixture;
  let beta: TenantFixture;
  let alphaSession: string;
  let betaSession: string;
  /** All permissions but `can_view_responses` — the boundary under test. */
  let settingsOnlySession: string;
  /** The other half of the pair — all permissions but `can_manage_settings`. */
  let viewOnlySession: string;

  function app(): TestApp {
    if (testApp === undefined) {
      throw new Error('no test app');
    }
    return testApp;
  }

  function get(session: string): request.Test {
    return request(app().server)
      .get(apiPath(BASE_URL_PATH))
      .set('Cookie', cookieHeader(session));
  }

  function put(session: string, body: unknown): request.Test {
    return request(app().server)
      .put(apiPath(BASE_URL_PATH))
      .set(authedMutation(session))
      .send(body as object);
  }

  /** The address a mail to this organisation's participants would actually carry. */
  async function editLinkOf(tenantId: string): Promise<string | null> {
    return app().app.get(PublicUrlService).responseEditUrl(tenantId, 'tok');
  }

  beforeAll(async () => {
    database = await acquireTestDatabase();
    // The system default is seeded once, at boot, exactly like every other
    // suite that needs one (`create-test-app.ts`) — a fresh row per test
    // would also prove the fallback, but would no longer be „die
    // Systemvorgabe", just a second value nobody set on purpose.
    testApp = await createTestApp({
      databaseUrl: database.url,
      systemMail: { publicBaseUrl: TEST_PUBLIC_BASE_URL },
    });
    prisma = testApp.prisma;

    alpha = await createTenant(prisma, 'BURLA');
    beta = await createTenant(prisma, 'BURLB');

    const alphaAdmin = await createUser(prisma, {
      email: 'admin@burla.example.org',
      password: 'test-password',
      tenants: [alpha],
    });
    alphaSession = await openSession(app(), alphaAdmin.id, alpha.id);

    const betaAdmin = await createUser(prisma, {
      email: 'admin@burlb.example.org',
      password: 'test-password',
      tenants: [beta],
    });
    betaSession = await openSession(app(), betaAdmin.id, beta.id);

    const settingsOnly = await createRestrictedMember(prisma, alpha, {
      email: 'settings@burla.example.org',
      groupName: 'settings-only',
      permissions: {
        canBuild: true,
        canExport: true,
        canManageSettings: true,
        canManageFormSettings: true,
        canManageUsers: true,
        canViewResponses: false,
      },
    });
    settingsOnlySession = await openSession(app(), settingsOnly.id, alpha.id);

    const viewOnly = await createRestrictedMember(prisma, alpha, {
      email: 'view@burla.example.org',
      groupName: 'view-only',
      permissions: {
        canBuild: true,
        canExport: true,
        canManageSettings: false,
        canManageFormSettings: false,
        canManageUsers: true,
        canViewResponses: true,
      },
    });
    viewOnlySession = await openSession(app(), viewOnly.id, alpha.id);
  }, 180_000);

  afterAll(async () => {
    await testApp?.close();
    await database?.release();
  });

  beforeEach(async () => {
    await prisma.tenant.updateMany({ data: { publicBaseUrl: null } });
  });

  // -------------------------------------------------------------------------
  // The round trip the requirement asks for
  // -------------------------------------------------------------------------

  it('reads null on an organisation that never set one — die Systemvorgabe gilt', async () => {
    const response = await get(alphaSession);

    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({ baseUrl: null });
    expect(await editLinkOf(alpha.id)).toBe(`${TEST_PUBLIC_BASE_URL}/a/tok`);
  });

  it('sets an own address, reads it back, and a mail to this organisation uses it', async () => {
    const written = await put(alphaSession, {
      baseUrl: 'https://alpha.organisation.invalid/',
    });

    expect(written.status).toBe(200);
    // The trailing slash is gone — the same normalisation the system row and
    // `PublicUrlService` apply (`normaliseBaseUrl`).
    expect(written.body).toStrictEqual({
      baseUrl: 'https://alpha.organisation.invalid',
    });
    expect((await get(alphaSession)).body).toStrictEqual({
      baseUrl: 'https://alpha.organisation.invalid',
    });
    expect(await editLinkOf(alpha.id)).toBe(
      'https://alpha.organisation.invalid/a/tok',
    );
  });

  /**
   * **The load-bearing proof of the requirement**: two organisations, two addresses, and
   * a mail to the *second* one carries the *second* one's own address, not
   * the first's and not the system's — the exact isolation
   * `resolveBaseUrl(tenantId)`'s own doc names.
   */
  it('carries the address of the organisation a mail belongs to, not of any other', async () => {
    await put(alphaSession, {
      baseUrl: 'https://alpha.organisation.invalid',
    }).expect(200);
    await put(betaSession, {
      baseUrl: 'https://beta.organisation.invalid',
    }).expect(200);

    expect(await editLinkOf(alpha.id)).toBe(
      'https://alpha.organisation.invalid/a/tok',
    );
    expect(await editLinkOf(beta.id)).toBe(
      'https://beta.organisation.invalid/a/tok',
    );
  });

  it('clearing it falls back to the system default, not to nothing', async () => {
    await put(alphaSession, {
      baseUrl: 'https://alpha.organisation.invalid',
    }).expect(200);
    expect(await editLinkOf(alpha.id)).toBe(
      'https://alpha.organisation.invalid/a/tok',
    );

    const cleared = await put(alphaSession, { baseUrl: null });

    expect(cleared.status).toBe(200);
    expect(cleared.body).toStrictEqual({ baseUrl: null });
    expect(await editLinkOf(alpha.id)).toBe(`${TEST_PUBLIC_BASE_URL}/a/tok`);
  });

  it('refuses a value that is not an absolute http(s) address and names the field', async () => {
    const response = await put(alphaSession, { baseUrl: 'not-a-url' });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      issues: [{ path: 'baseUrl' }],
    });
    // Nothing was stored — the organisation still reads as „keine eigene".
    expect((await get(alphaSession)).body).toStrictEqual({ baseUrl: null });
  });

  // -------------------------------------------------------------------------
  // Who may do this — the same pair `SmtpConfigController` asks for, mirrored
  // -------------------------------------------------------------------------

  it('lets an admin of the active Organisation read and write it', async () => {
    await get(alphaSession).expect(200);
    await put(alphaSession, {
      baseUrl: 'https://alpha.organisation.invalid',
    }).expect(200);
  });

  it('refuses a member who may configure but may not see responses, and changes nothing', async () => {
    const before = await tenantRow(prisma, alpha.id);

    await get(settingsOnlySession).expect(403);
    const write = await put(settingsOnlySession, {
      baseUrl: 'https://sneaked.invalid',
    });

    expect(write.status).toBe(403);
    expect(await tenantRow(prisma, alpha.id)).toBe(before);
  });

  it('refuses a member who may see responses but may not configure', async () => {
    await get(viewOnlySession).expect(403);
    await put(viewOnlySession, {
      baseUrl: 'https://sneaked.invalid',
    }).expect(403);
  });

  // -------------------------------------------------------------------------
  // The organisation boundary — there is no organisation in the path, so the isolation is an
  // impossibility, not a refusal; the case worth writing is that a save
  // never reaches the other organisation's row.
  // -------------------------------------------------------------------------

  it('writes only the organisation of the session', async () => {
    await put(alphaSession, {
      baseUrl: 'https://alpha.organisation.invalid',
    }).expect(200);

    expect((await get(betaSession)).body).toStrictEqual({ baseUrl: null });
  });
});

async function tenantRow(
  prisma: PrismaService,
  tenantId: string,
): Promise<string | null> {
  const row = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { publicBaseUrl: true },
  });
  return row.publicBaseUrl;
}
