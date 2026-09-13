import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSessionUser } from '@formsache/shared';
import { startFakeIdp, type FakeIdp } from '@formsache/test-idp';

import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import {
  apiPath,
  createTestApp,
  TEST_PUBLIC_BASE_URL,
  type TestApp,
} from '../support/create-test-app';
import {
  createGroup,
  createTenant,
  type TenantFixture,
} from '../support/fixtures';
import { SESSION_COOKIE_NAME } from '../../src/auth/session-cookie';
import {
  TEST_REDIRECT_URI,
  configureOidc,
  outcomeOf,
  sessionSetCookie,
  sessionTokenOf,
  signInThrough,
} from './oidc-flow';

/**
 * **The load-bearing test of the requirement**: two organisations, two Issuer, and the
 * *same* `sub`.
 *
 * A `sub` is unique only inside its issuer (the OpenID Connect Core specification), and in this
 * application every organisation configures its own identity provider. Bind an account
 * to `sub` alone and the provider of any Organisation is a **Generalschlüssel**: whoever
 * creates a user with a foreign Mitglied's `sub` in their own Keycloak
 * *becomes* that person.
 *
 * ⚠️ **A test with two different `sub` measures nothing** — it establishes that
 * two users are two users, and it stays green against exactly the key this
 * requirement forbids. The shared `sub` is the whole assertion, and it is why this
 * file exists next to `oidc-login.spec.ts` rather than inside it.
 *
 * The reproduction: change {@link OidcIdentityService} to look up by
 * `oidcSubject` alone, and „meldet zwei verschiedene Konten an" below goes red.
 */

const SETUP_TIMEOUT_MS = 180_000;

/**
 * The one string both providers hand out. A UUID because that is what Keycloak
 * mints, and the point of the requirement is that such a value is neither secret
 * nor unpredictable across issuers — the *other* Organisation can simply read it off its
 * own user list and enter it.
 */
const SHARED_SUBJECT = randomUUID();

describe('OIDC binds to (issuer, subject), never to the subject alone', () => {
  let database: TestDatabase | undefined;
  let testApp: TestApp | undefined;

  let alphaIdp: FakeIdp | undefined;
  let betaIdp: FakeIdp | undefined;

  let alpha: TenantFixture;
  let beta: TenantFixture;
  /** The account ALPHA's provider vouches for, under the shared `sub`. */
  let alphaUserId: string;
  /** BETA's account — same `sub`, different issuer, different person. */
  let betaUserId: string;
  /** A row of BETA that must never surface in an answer to ALPHA's session. */
  let betaOnlyGroup: { id: string; name: string };
  let alphaOnlyGroup: { id: string; name: string };

  function app(): TestApp {
    if (testApp === undefined) {
      throw new Error('the application was not started');
    }
    return testApp;
  }

  function idpOf(which: 'alpha' | 'beta'): FakeIdp {
    const idp = which === 'alpha' ? alphaIdp : betaIdp;
    if (idp === undefined) {
      throw new Error('the identity provider was not started');
    }
    return idp;
  }

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({
      databaseUrl: database.url,
      // The installation's own address is a **row**, not
      // `PUBLIC_BASE_URL` of the environment. A suite
      // that asserts on absolute links has to put one there — which is also
      // what makes „fehlt sie, gibt es keinen Link" a state of its own.
      systemMail: { publicBaseUrl: TEST_PUBLIC_BASE_URL },
      // One trusted hop, so a suite can speak from more than one address —
      // see `nextCaller` in `oidc-flow.ts` for why the limits stay as shipped.
      env: { TRUST_PROXY_HOPS: 1 },
    });
    const prisma = app().prisma;

    // Two providers on two ports — two different issuers, which is the whole
    // setup. One provider serving both organisations would be a different (and much
    // less interesting) test.
    alphaIdp = await startFakeIdp('client-alpha', 'secret-alpha', {
      redirectUri: TEST_REDIRECT_URI,
    });
    betaIdp = await startFakeIdp('client-beta', 'secret-beta', {
      redirectUri: TEST_REDIRECT_URI,
    });

    alpha = await createTenant(prisma, 'ALPHA');
    beta = await createTenant(prisma, 'BETA');
    alphaOnlyGroup = await createGroup(prisma, alpha, {
      name: 'alpha-redaktion',
    });
    betaOnlyGroup = await createGroup(prisma, beta, { name: 'beta-redaktion' });

    await configureOidc(app(), alpha.id, idpOf('alpha'), {
      clientId: 'client-alpha',
      clientSecret: 'secret-alpha',
    });
    await configureOidc(app(), beta.id, idpOf('beta'), {
      clientId: 'client-beta',
      clientSecret: 'secret-beta',
    });

    // Two accounts, each bound to *its own* issuer and to the **same** subject.
    // The database has allowed exactly this —
    // `@@unique([oidcIssuer, oidcSubject])`, not `@unique(oidcSubject)` — and
    // that it does is half the requirement; the other half is that the
    // application looks the pair up rather than the subject.
    const alphaUser = await prisma.user.create({
      data: {
        email: 'praeside@alpha.invalid',
        name: 'Präside ALPHA',
        oidcIssuer: idpOf('alpha').issuer,
        oidcSubject: SHARED_SUBJECT,
      },
    });
    const betaUser = await prisma.user.create({
      data: {
        email: 'praeside@beta.invalid',
        name: 'Präside BETA',
        oidcIssuer: idpOf('beta').issuer,
        oidcSubject: SHARED_SUBJECT,
      },
    });
    alphaUserId = alphaUser.id;
    betaUserId = betaUser.id;

    await prisma.membership.create({
      data: {
        tenantId: alpha.id,
        userId: alphaUserId,
        groupId: alpha.adminGroupId,
      },
    });
    await prisma.membership.create({
      data: {
        tenantId: beta.id,
        userId: betaUserId,
        groupId: beta.adminGroupId,
      },
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await testApp?.close();
    await alphaIdp?.close();
    await betaIdp?.close();
    await database?.release();
  });

  /** Everything that identifies BETA — none of it may reach ALPHA's session. */
  function betaFingerprints(): string[] {
    return [
      beta.id,
      beta.adminGroupId,
      betaOnlyGroup.id,
      betaOnlyGroup.name,
      betaUserId,
      'praeside@beta.invalid',
      idpOf('beta').issuer,
    ];
  }

  async function signIn(which: 'alpha' | 'beta'): Promise<string> {
    const response = await signInThrough(
      app(),
      idpOf(which),
      which === 'alpha' ? alpha.id : beta.id,
      { sub: SHARED_SUBJECT, email: `praeside@${which}.invalid` },
    );
    expect(response.status).toBe(302);
    // No `?sso=` on the success path — the browser lands on the application
    // itself, not on the login page with an explanation.
    expect(outcomeOf(response)).toBeNull();
    return sessionTokenOf(response);
  }

  it(
    'signs the same `sub` in as two different accounts, one per issuer',
    async () => {
      const alphaToken = await signIn('alpha');
      const betaToken = await signIn('beta');

      const alphaMe = await request(app().server)
        .get(apiPath('/auth/me'))
        .set('Cookie', `${SESSION_COOKIE_NAME}=${alphaToken}`);
      const betaMe = await request(app().server)
        .get(apiPath('/auth/me'))
        .set('Cookie', `${SESSION_COOKIE_NAME}=${betaToken}`);

      expect(alphaMe.status).toBe(200);
      expect(betaMe.status).toBe(200);
      // Parsed through the shared contract rather than read off `any`: the
      // assertion below is about *which account* answered, and a body that no
      // longer matches the contract must fail here rather than compare
      // `undefined` with `undefined`.
      const alphaSelf = parseSessionUser(alphaMe.body);
      const betaSelf = parseSessionUser(betaMe.body);

      // The assertion the whole requirement rests on: **two rows**, although the
      // `sub` was identical. With a key on `sub` alone both sign-ins would land
      // on whichever row was written first, and these two ids would be equal.
      expect(alphaSelf.id).toBe(alphaUserId);
      expect(betaSelf.id).toBe(betaUserId);
      expect(alphaSelf.id).not.toBe(betaSelf.id);

      expect(alphaSelf.activeTenantId).toBe(alpha.id);
      expect(betaSelf.activeTenantId).toBe(beta.id);
    },
    SETUP_TIMEOUT_MS,
  );

  it(
    'lets neither session reach the other organisation — the whole payload is searched',
    async () => {
      const alphaToken = await signIn('alpha');
      const cookie = `${SESSION_COOKIE_NAME}=${alphaToken}`;

      // Every tenant-scoped list this session can reach. The **whole** body is
      // searched, not the fields a reader expects: „geladen und nur nicht
      // angezeigt" is exactly the failure a field-by-field assertion misses.
      const paths = [
        '/auth/me',
        '/groups',
        '/forms',
        '/tenant/users',
        '/tenant/groups',
        '/tenant/branding',
        '/tenant/oidc',
      ];

      for (const path of paths) {
        const response = await request(app().server)
          .get(apiPath(path))
          .set('Cookie', cookie);
        const payload = `${String(response.status)} ${response.text}`;
        for (const fingerprint of betaFingerprints()) {
          expect(
            payload,
            `${path} leaked a BETA fingerprint: ${fingerprint}`,
          ).not.toContain(fingerprint);
        }
      }

      // The counter-check: the same run *does* see its own Organisation. Without it the
      // loop above would stay green against an application that answers 500
      // everywhere.
      const groups = await request(app().server)
        .get(apiPath('/groups'))
        .set('Cookie', cookie);
      expect(groups.status).toBe(200);
      expect(groups.text).toContain(alphaOnlyGroup.name);
    },
    SETUP_TIMEOUT_MS,
  );

  it(
    'refuses a token whose `iss` is not the issuer configured for the organisation',
    async () => {
      // ALPHA's provider, but claiming BETA's issuer in the ID token. Without
      // the `iss` check the pair would be an assertion of the sender, and this
      // is how the *other* organisation's account would be reachable through one's own
      // provider — the pair-key would then buy nothing (ADR-0012 no. 2).
      const response = await signInThrough(
        app(),
        idpOf('alpha'),
        alpha.id,
        { sub: SHARED_SUBJECT, email: 'praeside@alpha.invalid' },
        { issuer: idpOf('beta').issuer },
      );

      expect(response.status).toBe(302);
      expect(outcomeOf(response)).toBe('fehlgeschlagen');
      expect(sessionSetCookie(response)).toBeUndefined();
    },
    SETUP_TIMEOUT_MS,
  );
});
