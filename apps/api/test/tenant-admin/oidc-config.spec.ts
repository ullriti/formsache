import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_OIDC_EMAIL_CLAIM,
  DEFAULT_OIDC_EMAIL_VERIFIED_CLAIM,
  DEFAULT_OIDC_SCOPES,
  type ApiEnv,
} from '@formsache/shared';

import { GLOBAL_API_PREFIX } from '../../src/app.module';
import {
  OIDC_CALLBACK_PATH,
  PUBLIC_BASE_URL_MISSING_MESSAGE,
  PublicBaseUrlMissingError,
  type PublicUrlService,
} from '../../src/common/public-url/public-url.service';
import { hashPassword } from '../../src/auth/password';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { TenantScope } from '../../src/tenancy/tenant-scope';
import type { OidcSecretsService } from '../../src/tenant-admin/oidc-secrets.service';
import {
  BAD_ISSUER_MESSAGE,
  MISSING_CLIENT_SECRET_MESSAGE,
  UNREADABLE_OIDC_MESSAGE,
  OidcConfigService,
} from '../../src/tenant-admin/oidc-config.service';
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
  createTenant,
  createUser,
  type TenantFixture,
} from '../support/fixtures';
import { authedMutation, cookieHeader, openSession } from '../support/http';

/**
 * The OIDC configuration route of the tenant administration (the specification) — the guard chain, the two issuer gates, and the fail-closed
 * rule that decides whether SSO may be switched on at all.
 *
 * The **secret** has a file of its own (`oidc-secret.spec.ts`), because its four
 * pieces of evidence are about what does *not* travel rather than about what the route
 * answers.
 */

const SETUP_TIMEOUT_MS = 180_000;

const OIDC_PATH = '/tenant/oidc';

interface Member {
  readonly id: string;
  readonly email: string;
}

/**
 * A member with **exactly** the permissions named — no group of convenience.
 *
 * Built here rather than through `createRestrictedMember` because the 403 cases
 * below need `canManageUsers`, which that fixture cannot express, and because
 * the whole value of a 403 case is that the refused caller holds *the other*
 * rights: a user with no permission at all only shows that some guard fired.
 */
async function memberWith(
  prisma: PrismaService,
  tenant: TenantFixture,
  email: string,
  permissions: {
    readonly canBuild?: boolean;
    readonly canViewResponses?: boolean;
    readonly canExport?: boolean;
    readonly canManageSettings?: boolean;
    readonly canManageFormSettings?: boolean;
    readonly canManageUsers?: boolean;
  },
): Promise<Member> {
  const group = await prisma.group.create({
    data: {
      tenantId: tenant.id,
      name: `group-${email}`,
      color: '#5b6b52',
      rank: 20,
      isSystem: false,
      canBuild: permissions.canBuild ?? false,
      canViewResponses: permissions.canViewResponses ?? false,
      canExport: permissions.canExport ?? false,
      canManageSettings: permissions.canManageSettings ?? false,
      canManageFormSettings: permissions.canManageFormSettings ?? false,
      canManageUsers: permissions.canManageUsers ?? false,
    },
  });
  const user = await prisma.user.create({
    data: {
      email: email.toLowerCase(),
      name: `Test ${email}`,
      passwordHash: await hashPassword('test-password'),
    },
  });
  await prisma.membership.create({
    data: { tenantId: tenant.id, userId: user.id, groupId: group.id },
  });
  return { id: user.id, email: user.email };
}

describe('OIDC configuration of one organisation', () => {
  let database: TestDatabase | undefined;
  let testApp: TestApp | undefined;
  let prisma: PrismaService;

  let tenant: TenantFixture;
  /** Holds every right — the caller the happy paths use. */
  let adminSession: string;
  /** Holds the other four rights, but not `can_manage_users`. */
  let withoutUsersSession: string;
  /** Holds the other four rights, but not `can_manage_settings`. */
  let withoutSettingsSession: string;

  function app(): TestApp {
    if (testApp === undefined) {
      throw new Error('no test app');
    }
    return testApp;
  }

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({
      databaseUrl: database.url,
      // The redirect URI the tab shows is built from the installation's own
      // address, which is a row .
      systemMail: { publicBaseUrl: TEST_PUBLIC_BASE_URL },
    });
    prisma = testApp.prisma;

    tenant = await createTenant(prisma, 'OIDCA');
    const admin = await createUser(prisma, {
      email: 'admin@oidc.example.org',
      password: 'test-password',
      tenants: [tenant],
    });
    adminSession = await openSession(app(), admin.id, tenant.id);

    const withoutUsers = await memberWith(
      prisma,
      tenant,
      'ohne-nutzerrecht@oidc.example.org',
      {
        canBuild: true,
        canViewResponses: true,
        canExport: true,
        canManageSettings: true,
        canManageFormSettings: true,
        canManageUsers: false,
      },
    );
    withoutUsersSession = await openSession(app(), withoutUsers.id, tenant.id);

    const withoutSettings = await memberWith(
      prisma,
      tenant,
      'ohne-einstellungsrecht@oidc.example.org',
      {
        canBuild: true,
        canViewResponses: true,
        canExport: true,
        canManageSettings: false,
        canManageFormSettings: false,
        canManageUsers: true,
      },
    );
    withoutSettingsSession = await openSession(
      app(),
      withoutSettings.id,
      tenant.id,
    );
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await testApp?.close();
    await database?.release();
  });

  /** The stored OIDC columns, straight out of PostgreSQL. */
  async function storedOidc(tenantId: string): Promise<{
    enabled: boolean;
    issuer: string | null;
    clientId: string | null;
    scopes: string[];
  }> {
    const rows = await prisma.$queryRaw<
      {
        oidc_enabled: boolean;
        oidc_issuer: string | null;
        oidc_client_id: string | null;
        oidc_scopes: string[];
      }[]
    >`SELECT oidc_enabled, oidc_issuer, oidc_client_id, oidc_scopes
        FROM "tenant" WHERE id = ${tenantId}::uuid`;
    const row = rows[0];
    if (row === undefined) {
      throw new Error('tenant row missing');
    }
    return {
      enabled: row.oidc_enabled,
      issuer: row.oidc_issuer,
      clientId: row.oidc_client_id,
      scopes: row.oidc_scopes,
    };
  }

  function read(session: string): request.Test {
    return request(app().server)
      .get(apiPath(OIDC_PATH))
      .set('Cookie', cookieHeader(session));
  }

  function write(session: string, body: object): request.Test {
    return request(app().server)
      .put(apiPath(OIDC_PATH))
      .set(authedMutation(session))
      .send(body);
  }

  /**
   * **The one thing this requirement must not spell a second time.** A provider
   * compares `redirect_uri` byte for byte against what was registered, so the
   * address shown in the tab and the address the callback route is mounted on
   * have to be the same string. They are, because there is only one — and this
   * pins it to the prefix the application actually serves under, which is the
   * part the constant has to repeat rather than import.
   */
  it('builds the redirect URI from configuration, under the served prefix', async () => {
    expect(OIDC_CALLBACK_PATH.startsWith(`/${GLOBAL_API_PREFIX}/`)).toBe(true);

    const response = await read(adminSession);
    expect(response.status).toBe(200);
    expect((response.body as { redirectUri: string }).redirectUri).toBe(
      `${TEST_PUBLIC_BASE_URL}${OIDC_CALLBACK_PATH}`,
    );
  });

  /**
   * `redirectUri` is in the **read** schema and in no write schema, so there is
   * no field in which to send one — the floor under the requirement's third
   * reproduction („`redirect_uri` taken from the request"). A request that
   * tries is refused by the strict object rather than quietly ignored.
   */
  it('has no field in which a caller could send a redirect URI', async () => {
    const response = await write(adminSession, {
      enabled: false,
      issuer: null,
      clientId: null,
      scopes: [...DEFAULT_OIDC_SCOPES],
      emailClaim: DEFAULT_OIDC_EMAIL_CLAIM,
      emailVerifiedClaim: DEFAULT_OIDC_EMAIL_VERIFIED_CLAIM,
      buttonLabel: null,
      redirectUri: 'https://angreifer.invalid/callback',
    });
    expect(response.status).toBe(400);

    const after = await read(adminSession);
    expect((after.body as { redirectUri: string }).redirectUri).toBe(
      `${TEST_PUBLIC_BASE_URL}${OIDC_CALLBACK_PATH}`,
    );
  });

  /** An organisation that has never been configured: off, empty, and the standard scopes. */
  it('reads a fresh Organisation as switched off with the shipped scopes', async () => {
    const fresh = await createTenant(prisma, 'OIDCFRESH');
    const user = await createUser(prisma, {
      email: 'frisch@oidc.example.org',
      password: 'test-password',
      tenants: [fresh],
    });
    const session = await openSession(app(), user.id, fresh.id);

    const response = await read(session);
    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({
      enabled: false,
      issuer: null,
      clientId: null,
      scopes: [...DEFAULT_OIDC_SCOPES],
      emailClaim: DEFAULT_OIDC_EMAIL_CLAIM,
      emailVerifiedClaim: DEFAULT_OIDC_EMAIL_VERIFIED_CLAIM,
      buttonLabel: null,
      clientSecretSet: false,
      redirectUri: `${TEST_PUBLIC_BASE_URL}${OIDC_CALLBACK_PATH}`,
    });
  });

  describe('the guard chain', () => {
    it('refuses a caller without a session', async () => {
      await request(app().server).get(apiPath(OIDC_PATH)).expect(401);
    });

    /**
     * **The refused caller holds the other four rights.** A member with no
     * permission at all would only show that *some* guard fired; what has to be
     * shown is that this route needs `can_manage_users` even from somebody who
     * may already configure every form of the organisation.
     */
    it('refuses a caller who may manage settings but not users', async () => {
      await read(withoutUsersSession).expect(403);
      const refused = await write(withoutUsersSession, {
        enabled: false,
        issuer: null,
        clientId: null,
        scopes: [...DEFAULT_OIDC_SCOPES],
        emailClaim: DEFAULT_OIDC_EMAIL_CLAIM,
        emailVerifiedClaim: DEFAULT_OIDC_EMAIL_VERIFIED_CLAIM,
        buttonLabel: null,
      });
      expect(refused.status).toBe(403);
    });

    it('refuses a caller who may manage users but not settings', async () => {
      await read(withoutSettingsSession).expect(403);
      await write(withoutSettingsSession, {
        enabled: false,
        issuer: null,
        clientId: null,
        scopes: [...DEFAULT_OIDC_SCOPES],
        emailClaim: DEFAULT_OIDC_EMAIL_CLAIM,
        emailVerifiedClaim: DEFAULT_OIDC_EMAIL_VERIFIED_CLAIM,
        buttonLabel: null,
      }).expect(403);
    });

    /** And a refused write leaves the row exactly as it was — raw query. */
    it('changes no row when it refuses a write', async () => {
      const before = await storedOidc(tenant.id);
      await write(withoutUsersSession, {
        enabled: true,
        issuer: 'https://angreifer.invalid',
        clientId: 'uebernommen',
        scopes: [...DEFAULT_OIDC_SCOPES],
        emailClaim: DEFAULT_OIDC_EMAIL_CLAIM,
        emailVerifiedClaim: DEFAULT_OIDC_EMAIL_VERIFIED_CLAIM,
        buttonLabel: 'Fremd',
        clientSecret: 'ein-geheimnis',
      }).expect(403);
      expect(await storedOidc(tenant.id)).toStrictEqual(before);
    });
  });

  describe('the issuer, at both gates', () => {
    /**
     * **Gate one**, on the way in. `z.url()` accepts `javascript:` — this is
     * the check that does not.
     */
    it('refuses a scheme that is not a discovery base, naming the field', async () => {
      const before = await storedOidc(tenant.id);
      const response = await write(adminSession, {
        enabled: false,
        issuer: 'javascript:alert(1)',
        clientId: 'formsache',
        scopes: [...DEFAULT_OIDC_SCOPES],
        emailClaim: DEFAULT_OIDC_EMAIL_CLAIM,
        emailVerifiedClaim: DEFAULT_OIDC_EMAIL_VERIFIED_CLAIM,
        buttonLabel: null,
      });
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        issues: [{ path: 'issuer', message: BAD_ISSUER_MESSAGE }],
      });
      expect(await storedOidc(tenant.id)).toStrictEqual(before);
    });

    /**
     * **Gate two**, on the way out, with its own precondition: the value is
     * written straight into the column, so it never met gate one. Without this
     * case the two gates could not be told apart at all (the requirement's ⚠️).
     */
    it('does not deliver a stored issuer that could not have been saved', async () => {
      const hostile = await createTenant(prisma, 'OIDCRAW');
      const user = await createUser(prisma, {
        email: 'roh@oidc.example.org',
        password: 'test-password',
        tenants: [hostile],
      });
      const session = await openSession(app(), user.id, hostile.id);

      await prisma.$executeRaw`
        UPDATE "tenant"
           SET oidc_issuer = 'javascript:alert(1)', oidc_client_id = 'formsache'
         WHERE id = ${hostile.id}::uuid`;

      const response = await read(session);
      expect(response.status).toBe(200);
      const body = response.body as Record<string, unknown>;
      // Reported as „not configured" — fail closed and repairable …
      expect(body.issuer).toBeNull();
      // … and the value itself never reaches the payload in any form.
      expect(JSON.stringify(body)).not.toContain('javascript:');
      // The control: the rest of the row still arrives, so the null above is
      // this field being refused rather than the whole read failing.
      expect(body.clientId).toBe('formsache');
    });
  });

  describe('switching SSO on', () => {
    it('refuses to switch on without a stored secret, and stores nothing', async () => {
      const before = await storedOidc(tenant.id);
      const response = await write(adminSession, {
        enabled: true,
        issuer: 'https://idp.example.org/realms/demo',
        clientId: 'formsache',
        scopes: [...DEFAULT_OIDC_SCOPES],
        emailClaim: DEFAULT_OIDC_EMAIL_CLAIM,
        emailVerifiedClaim: DEFAULT_OIDC_EMAIL_VERIFIED_CLAIM,
        buttonLabel: null,
      });
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        issues: [
          { path: 'clientSecret', message: MISSING_CLIENT_SECRET_MESSAGE },
        ],
      });
      expect(await storedOidc(tenant.id)).toStrictEqual(before);
    });

    it('accepts a complete configuration and normalises the issuer', async () => {
      const response = await write(adminSession, {
        enabled: true,
        issuer: 'https://idp.example.org/realms/demo/',
        clientId: 'formsache',
        scopes: ['openid', 'profile', 'email'],
        emailClaim: DEFAULT_OIDC_EMAIL_CLAIM,
        emailVerifiedClaim: DEFAULT_OIDC_EMAIL_VERIFIED_CLAIM,
        buttonLabel: 'Mit Organisation-Login anmelden',
        clientSecret: 'ein-hinreichend-langes-client-secret',
      });
      expect(response.status).toBe(200);
      expect(response.body).toStrictEqual({
        enabled: true,
        issuer: 'https://idp.example.org/realms/demo',
        clientId: 'formsache',
        scopes: ['openid', 'profile', 'email'],
        emailClaim: DEFAULT_OIDC_EMAIL_CLAIM,
        emailVerifiedClaim: DEFAULT_OIDC_EMAIL_VERIFIED_CLAIM,
        buttonLabel: 'Mit Organisation-Login anmelden',
        clientSecretSet: true,
        redirectUri: `${TEST_PUBLIC_BASE_URL}${OIDC_CALLBACK_PATH}`,
      });
      expect((await storedOidc(tenant.id)).issuer).toBe(
        'https://idp.example.org/realms/demo',
      );
    });

    /**
     * The ordinary save: the page never held the secret, so it cannot send it
     * back, and an absent field must not silently delete it.
     */
    it('keeps the stored secret when the field is absent', async () => {
      const response = await write(adminSession, {
        enabled: true,
        issuer: 'https://idp.example.org/realms/demo',
        clientId: 'formsache',
        scopes: ['openid', 'profile', 'email'],
        emailClaim: DEFAULT_OIDC_EMAIL_CLAIM,
        emailVerifiedClaim: DEFAULT_OIDC_EMAIL_VERIFIED_CLAIM,
        buttonLabel: 'Anderer Text',
      });
      expect(response.status).toBe(200);
      expect(
        (response.body as { clientSecretSet: boolean }).clientSecretSet,
      ).toBe(true);
    });

    /** Removing the secret while SSO is on is the same refusal from the other side. */
    it('refuses to remove the secret while SSO stays on', async () => {
      const response = await write(adminSession, {
        enabled: true,
        issuer: 'https://idp.example.org/realms/demo',
        clientId: 'formsache',
        scopes: ['openid', 'profile', 'email'],
        emailClaim: DEFAULT_OIDC_EMAIL_CLAIM,
        emailVerifiedClaim: DEFAULT_OIDC_EMAIL_VERIFIED_CLAIM,
        buttonLabel: null,
        clientSecret: null,
      });
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        issues: [
          { path: 'clientSecret', message: MISSING_CLIENT_SECRET_MESSAGE },
        ],
      });
      const still = await read(adminSession);
      expect((still.body as { clientSecretSet: boolean }).clientSecretSet).toBe(
        true,
      );
    });

    it('removes the secret together with switching SSO off', async () => {
      const response = await write(adminSession, {
        enabled: false,
        issuer: 'https://idp.example.org/realms/demo',
        clientId: 'formsache',
        scopes: ['openid', 'profile', 'email'],
        emailClaim: DEFAULT_OIDC_EMAIL_CLAIM,
        emailVerifiedClaim: DEFAULT_OIDC_EMAIL_VERIFIED_CLAIM,
        buttonLabel: null,
        clientSecret: null,
      });
      expect(response.status).toBe(200);
      expect(
        (response.body as { clientSecretSet: boolean }).clientSecretSet,
      ).toBe(false);
    });

    /**
     * **The empty verification claim stays empty** .
     *
     * The trap this test stands against is the display default that
     * `scopes` has right next to it: an empty field there means „nothing
     * decided" and reads itself back as the default. Here the same
     * behaviour would mean that the interface shows a check that the login
     * does not do — and that a second save switches it silently
     * on again. Hence writing down *and* reading back in one test.
     */
    it('keeps an emptied verification claim empty, on the way in and out', async () => {
      const response = await write(adminSession, {
        enabled: false,
        issuer: 'https://idp.example.org/realms/demo',
        clientId: 'formsache',
        scopes: ['openid', 'profile', 'email'],
        emailClaim: 'upn',
        emailVerifiedClaim: '',
        buttonLabel: null,
      });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        emailClaim: 'upn',
        emailVerifiedClaim: '',
      });

      const again = await read(adminSession);
      expect(again.body).toMatchObject({
        emailClaim: 'upn',
        emailVerifiedClaim: '',
      });
    });

    /** An address claim on the other hand cannot be empty — it then names nothing. */
    it('refuses an empty address claim, naming the field', async () => {
      const response = await write(adminSession, {
        enabled: false,
        issuer: 'https://idp.example.org/realms/demo',
        clientId: 'formsache',
        scopes: ['openid', 'profile', 'email'],
        emailClaim: '',
        emailVerifiedClaim: DEFAULT_OIDC_EMAIL_VERIFIED_CLAIM,
        buttonLabel: null,
      });
      expect(response.status).toBe(400);
      const issues = (response.body as { issues: { path: string }[] }).issues;
      // Every complaint names the field — the number of rules at which an
      // empty name fails is not the promise; that the interface can hang them
      // on this field is.
      expect(issues.length).toBeGreaterThan(0);
      expect(issues.every((issue) => issue.path === 'emailClaim')).toBe(true);
    });
  });
});

/**
 * **A review-gate finding.** Two things closed by 28cb572 had no
 * proof: that a missing base address answers 503 with
 * {@link PUBLIC_BASE_URL_MISSING_MESSAGE}, and that `toConfig` lets
 * {@link PublicBaseUrlMissingError} through rather than folding it into
 * {@link UNREADABLE_OIDC_MESSAGE}. Without either, a merge that moved the
 * `await this.publicUrl.oidcCallbackUrl()` line back inside the `try` — or
 * that changed the base class of the error back to a plain `Error` — left the
 * whole suite green while the OIDC tab of a fresh installation answered 500
 * with the wrong cause again, silenced for the rest of the process by
 * `reportOnce`.
 *
 * Its own database rather than the shared fixture above: that one seeds
 * `systemMail: { publicBaseUrl: TEST_PUBLIC_BASE_URL }` in its own `beforeAll`,
 * so „the installation has no base address" cannot be expressed against it —
 * the requirement's own suites make exactly this point for the same reason (see
 * `system-settings.spec.ts`, „a missing row is the usable state").
 */
describe('a missing base address answers 503, not 500 with the wrong cause', () => {
  /**
   * The integration half: a real request against a real, freshly booted
   * application whose `system_setting` row has never been written — the
   * ordinary state of a fresh installation, not a database fault.
   *
   * Reproduction: put the `await this.publicUrl.oidcCallbackUrl()` of
   * `toConfig` back inside its neighbouring `try` (or move it below the
   * `parseOidcConfig` call it precedes today) and this turns red — 500 with
   * {@link UNREADABLE_OIDC_MESSAGE} instead of 503 with
   * {@link PUBLIC_BASE_URL_MISSING_MESSAGE}.
   */
  it(
    'answers 503 with PUBLIC_BASE_URL_MISSING_MESSAGE on GET /tenant/oidc',
    async () => {
      const database = await acquireTestDatabase();
      let booted: TestApp | undefined;
      try {
        // No `systemMail` option — the row stays absent, exactly the state
        // the promise is a fresh installation starts in.
        booted = await createTestApp({ databaseUrl: database.url });
        const tenant = await createTenant(booted.prisma, 'OIDCNOBASE');
        const user = await createUser(booted.prisma, {
          email: 'ohne-basis@oidc.example.org',
          password: 'test-password',
          tenants: [tenant],
        });
        const session = await openSession(booted, user.id, tenant.id);

        const response = await request(booted.server)
          .get(apiPath(OIDC_PATH))
          .set('Cookie', cookieHeader(session));

        expect(response.status).toBe(503);
        expect(response.body).toMatchObject({
          message: PUBLIC_BASE_URL_MISSING_MESSAGE,
        });
      } finally {
        await booted?.close();
        await database.release();
      }
    },
    SETUP_TIMEOUT_MS,
  );

  /**
   * The unit half, one call site closer to the code: `OidcConfigService`
   * assembled directly, with a `PublicUrlService` double that always throws
   * {@link PublicBaseUrlMissingError} and a `TenantScope` double that hands
   * back a fresh, unconfigured tenant row. No database and no HTTP layer —
   * the whole point is that the exception surviving `toConfig`'s `try`/`catch`
   * is a property of that one method, not of the transport around it.
   *
   * Reproduction: the same code change as above turns this red too, and does
   * so with the sharper signal — `rejects.toBeInstanceOf` fails outright
   * rather than merely asserting on a stringified body.
   */
  it('propagates PublicBaseUrlMissingError out of toConfig instead of UNREADABLE_OIDC_MESSAGE', async () => {
    const publicUrl = {
      oidcCallbackUrl: () => Promise.reject(new PublicBaseUrlMissingError()),
    } as unknown as PublicUrlService;
    const secrets = { isUsable: () => false } as unknown as OidcSecretsService;
    const service = new OidcConfigService(secrets, publicUrl, {
      OIDC_ISSUER_ALLOWLIST: undefined,
    } as unknown as ApiEnv);
    const scope = {
      tenant: {
        find: () =>
          Promise.resolve({
            id: 'tenant-under-test',
            oidcEnabled: false,
            oidcIssuer: null,
            oidcClientId: null,
            oidcClientSecret: null,
            oidcScopes: [],
            oidcButtonLabel: null,
          }),
      },
    } as unknown as TenantScope;

    await expect(service.ofTenant(scope)).rejects.toBeInstanceOf(
      PublicBaseUrlMissingError,
    );
    const error: unknown = await service
      .ofTenant(scope)
      .catch((e: unknown) => e);
    expect((error as Error).message).toBe(PUBLIC_BASE_URL_MISSING_MESSAGE);
    expect((error as Error).message).not.toBe(UNREADABLE_OIDC_MESSAGE);
  });
});
