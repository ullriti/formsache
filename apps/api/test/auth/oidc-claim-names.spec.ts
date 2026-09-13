import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeIdp, type FakeIdp } from '@formsache/test-idp';

import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import {
  TEST_PUBLIC_BASE_URL,
  createTestApp,
  type TestApp,
} from '../support/create-test-app';
import { createTenant, type TenantFixture } from '../support/fixtures';
import {
  TEST_REDIRECT_URI,
  configureOidc,
  outcomeOf,
  sessionSetCookie,
  signInThrough,
} from './oidc-flow';

/**
 * **The two claim names are configurable per organisation** .
 *
 * Until then they stood in the code: the address came from `email` and counted
 * only with `email_verified === true`. A provider that names the address
 * differently could therefore not be connected at all — and the verification
 * obligation could not be deselected, not even for an organisation whose login
 * service simply does not report it.
 *
 * What is measured is the **behaviour**, not the configuration: in each case a
 * real invitation is redeemed over the whole round trip, with an ID token signed
 * by the test provider. Four cases:
 *
 *   (a) Defaults — everything as before.
 *   (b) Address claim `upn`, and **no** `email` stands in the token.
 *   (c) Verification claim empty — the address counts without a counter-check.
 *   (d) Verification claim set, token without it — refused, and indeed with
 *       **the same response** as „es liegt keine Einladung vor".
 *
 * ## The reproduction
 *
 * Ignore the verification claim when it is set — that is, in `readVerifiedEmail`
 * delete the condition `verifiedClaim !== ''` or discard its result —, and (d)
 * goes green where it has to be red: the invitation of the organisation STRENG
 * would then be redeemable by a token that claims nothing about the address.
 *
 * ⚠️ **(c) is the case that gives up a promise.** It stands here because it was
 * built, not because it would be harmless: whoever operates the login service of
 * this organisation can thereby pull an invitation of **this** organisation onto
 * a foreign address. What limits the damage is checked by the last test of this
 * file — the conditions in the `where` of `OidcIdentityService.resolve` stay in
 * place, even without a counter-check.
 */

const SETUP_TIMEOUT_MS = 180_000;

const CLIENT_SECRET = 'client-secret-fuer-die-claim-namen';

describe('OIDC claim names are per organisation ', () => {
  let database: TestDatabase | undefined;
  let testApp: TestApp | undefined;

  /** Defaults: `email` and `email_verified`. */
  let streng: TenantFixture;
  let strengIdp: FakeIdp | undefined;
  /** Address claim `upn`, verification as usual. */
  let upn: TenantFixture;
  let upnIdp: FakeIdp | undefined;
  /** Verification claim empty — without a counter-check. */
  let offen: TenantFixture;
  let offenIdp: FakeIdp | undefined;

  function app(): TestApp {
    if (testApp === undefined) {
      throw new Error('the application was not started');
    }
    return testApp;
  }

  function idpOf(idp: FakeIdp | undefined): FakeIdp {
    if (idp === undefined) {
      throw new Error('the identity provider was not started');
    }
    return idp;
  }

  /**
   * An unredeemed invitation of this organisation — account **and** membership,
   * exactly the row that `ScopedMembershipDelegate.createOidcInvitation` writes.
   * Without the membership this file would check one condition less than the
   * server has (ADR-0012 no. 3a).
   */
  async function invite(
    tenant: TenantFixture,
    idp: FakeIdp,
    email: string,
  ): Promise<string> {
    const row = await app().prisma.user.create({
      data: {
        email,
        name: `Eingeladen ${tenant.shortName}`,
        oidcIssuer: idp.issuer,
        oidcSubject: null,
        passwordHash: null,
      },
    });
    await app().prisma.membership.create({
      data: {
        tenantId: tenant.id,
        userId: row.id,
        groupId: tenant.adminGroupId,
      },
    });
    return row.id;
  }

  /** Is the invitation redeemed, that is, bound to a `sub`? */
  async function boundSubjectOf(userId: string): Promise<string | null> {
    const row = await app().prisma.user.findUnique({
      where: { id: userId },
      select: { oidcSubject: true },
    });
    return row?.oidcSubject ?? null;
  }

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({
      databaseUrl: database.url,
      systemMail: { publicBaseUrl: TEST_PUBLIC_BASE_URL },
      env: { TRUST_PROXY_HOPS: 1 },
    });
    const prisma = app().prisma;

    // A provider of its own per organisation: `(issuer, subject)` is the account
    // key, and three organisations on one issuer would unintentionally make the
    // same invitation reachable here. That is the subject of
    // `oidc-two-issuers.spec.ts`, not of this file.
    strengIdp = await startFakeIdp('formular-streng', CLIENT_SECRET, {
      redirectUri: TEST_REDIRECT_URI,
    });
    upnIdp = await startFakeIdp('formular-upn', CLIENT_SECRET, {
      redirectUri: TEST_REDIRECT_URI,
    });
    offenIdp = await startFakeIdp('formular-offen', CLIENT_SECRET, {
      redirectUri: TEST_REDIRECT_URI,
    });

    streng = await createTenant(prisma, 'STRENG');
    upn = await createTenant(prisma, 'UPN');
    offen = await createTenant(prisma, 'OFFEN');

    // **Without `emailClaim`/`emailVerifiedClaim`** — the organisation that has
    // never set anything, and thereby the yardstick for „behaves as before".
    await configureOidc(app(), streng.id, idpOf(strengIdp), {
      clientId: 'formular-streng',
      clientSecret: CLIENT_SECRET,
    });
    await configureOidc(app(), upn.id, idpOf(upnIdp), {
      clientId: 'formular-upn',
      clientSecret: CLIENT_SECRET,
      emailClaim: 'upn',
    });
    await configureOidc(app(), offen.id, idpOf(offenIdp), {
      clientId: 'formular-offen',
      clientSecret: CLIENT_SECRET,
      emailVerifiedClaim: '',
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await testApp?.close();
    await strengIdp?.close();
    await upnIdp?.close();
    await offenIdp?.close();
    await database?.release();
  });

  // -------------------------------------------------------------------------
  // (a) With the defaults everything behaves as before
  // -------------------------------------------------------------------------

  it('redeems an invitation on the shipped defaults, exactly as before', async () => {
    const email = 'vorgabe@streng.invalid';
    const userId = await invite(streng, idpOf(strengIdp), email);
    try {
      const response = await signInThrough(app(), idpOf(strengIdp), streng.id, {
        sub: randomUUID(),
        email,
      });

      expect(outcomeOf(response)).toBeNull();
      expect(sessionSetCookie(response)).toBeDefined();
      expect(await boundSubjectOf(userId)).not.toBeNull();
    } finally {
      await app().prisma.user.delete({ where: { id: userId } });
    }
  });

  // -------------------------------------------------------------------------
  // (b) An organisation with the address claim `upn`
  // -------------------------------------------------------------------------

  /**
   * The proof that the name really comes from the column: the token carries
   * **no** `email`. If the server still read a hard-coded `email`, there would be
   * no address here at all and the invitation would stay unredeemed.
   */
  it('reads the address from the claim this organisation named, with no email in the token', async () => {
    const email = 'mitglied@upn.invalid';
    const userId = await invite(upn, idpOf(upnIdp), email);
    try {
      const response = await signInThrough(app(), idpOf(upnIdp), upn.id, {
        sub: randomUUID(),
        email,
        emailClaim: 'upn',
      });

      expect(outcomeOf(response)).toBeNull();
      expect(sessionSetCookie(response)).toBeDefined();
      expect(await boundSubjectOf(userId)).not.toBeNull();
    } finally {
      await app().prisma.user.delete({ where: { id: userId } });
    }
  });

  /**
   * And the counter-check in the same organisation: the same provider, the same
   * address, but under `email` instead of under `upn`. The organisation reads
   * `upn`, so there is nothing to read there — otherwise the configured name
   * would only be an *additional* place instead of the one place.
   */
  it('does not fall back to email when the organisation named another claim', async () => {
    const email = 'zweit@upn.invalid';
    const userId = await invite(upn, idpOf(upnIdp), email);
    try {
      const response = await signInThrough(app(), idpOf(upnIdp), upn.id, {
        sub: randomUUID(),
        email,
      });

      expect(outcomeOf(response)).toBe('abgelehnt');
      expect(sessionSetCookie(response)).toBeUndefined();
      expect(await boundSubjectOf(userId)).toBeNull();
    } finally {
      await app().prisma.user.delete({ where: { id: userId } });
    }
  });

  // -------------------------------------------------------------------------
  // (c) Empty verification claim — the address counts unchecked
  // -------------------------------------------------------------------------

  it('counts an address without any email_verified when the organisation emptied the field', async () => {
    const email = 'ungeprueft@offen.invalid';
    const userId = await invite(offen, idpOf(offenIdp), email);
    try {
      const response = await signInThrough(app(), idpOf(offenIdp), offen.id, {
        sub: randomUUID(),
        email,
        // The claim is missing from the token **entirely** — not `false`, but
        // not there at all. „Absence is no consent" was the rule, and exactly
        // that is what this organisation gives up.
        emailVerifiedClaim: null,
      });

      expect(outcomeOf(response)).toBeNull();
      expect(sessionSetCookie(response)).toBeDefined();
      expect(await boundSubjectOf(userId)).not.toBeNull();
    } finally {
      await app().prisma.user.delete({ where: { id: userId } });
    }
  });

  /**
   * **What stays in place even without a counter-check** („the damage stays
   * limited"). The organisation OFFEN checks nothing any more — and still does
   * not reach the invitation of an *other* organisation, because it is stamped
   * with that one's issuer and a membership there.
   */
  it('still cannot reach another organisation’s invitation without the counter-check', async () => {
    const email = 'fremd@streng.invalid';
    const userId = await invite(streng, idpOf(strengIdp), email);
    try {
      const response = await signInThrough(app(), idpOf(offenIdp), offen.id, {
        sub: randomUUID(),
        email,
        emailVerifiedClaim: null,
      });

      expect(outcomeOf(response)).toBe('abgelehnt');
      expect(await boundSubjectOf(userId)).toBeNull();
    } finally {
      await app().prisma.user.delete({ where: { id: userId } });
    }
  });

  // -------------------------------------------------------------------------
  // (d) Verification claim set, token without it
  // -------------------------------------------------------------------------

  /**
   * The reproduction of this file: ignore the verification claim when it is set,
   * and this test goes green where it has to be red.
   *
   * It checks two things in one, and both belong together: the invitation is
   * **not** redeemed, and the caller does not learn what it was down to — the
   * response is byte for byte the one for „es liegt keine Einladung vor"
   * (ADR-0012 no. 3 step 3). The difference stands in the log, not in the
   * redirect.
   */
  it('refuses a token without the verification claim, indistinguishably from “no invitation”', async () => {
    const email = 'ohnepruefung@streng.invalid';
    const userId = await invite(streng, idpOf(strengIdp), email);
    try {
      const refused = await signInThrough(app(), idpOf(strengIdp), streng.id, {
        sub: randomUUID(),
        email,
        emailVerifiedClaim: null,
      });
      expect(outcomeOf(refused)).toBe('abgelehnt');
      expect(sessionSetCookie(refused)).toBeUndefined();
      expect(await boundSubjectOf(userId)).toBeNull();

      // The same response as for an address for which there was never an
      // invitation here — checked on status **and** redirect, not on the outcome
      // code alone.
      const unknown = await signInThrough(app(), idpOf(strengIdp), streng.id, {
        sub: randomUUID(),
        email: 'niemand@streng.invalid',
      });
      expect(refused.status).toBe(unknown.status);
      expect(refused.headers.location).toBe(unknown.headers.location);
    } finally {
      await app().prisma.user.delete({ where: { id: userId } });
    }
  });

  /**
   * And `false` is the same case as „missing" — the rule that applied before
   * Konzept no. 70 and keeps applying for every organisation with a set claim.
   */
  it('refuses a token whose verification claim says false', async () => {
    const email = 'verneint@streng.invalid';
    const userId = await invite(streng, idpOf(strengIdp), email);
    try {
      const response = await signInThrough(app(), idpOf(strengIdp), streng.id, {
        sub: randomUUID(),
        email,
        emailVerified: false,
      });
      expect(outcomeOf(response)).toBe('abgelehnt');
      expect(await boundSubjectOf(userId)).toBeNull();
    } finally {
      await app().prisma.user.delete({ where: { id: userId } });
    }
  });
});
