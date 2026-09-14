import { createHash, randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseOidcProviders } from '@formsache/shared';
import { startFakeIdp, type FakeIdp } from '@formsache/test-idp';

import { hashPassword } from '../../src/auth/password';
import { readOidcTransaction } from '../../src/auth/oidc/oidc-transaction';
import { SESSION_COOKIE_NAME } from '../../src/auth/session-cookie';
import { OIDC_CALLBACK_PATH } from '../../src/common/public-url/public-url.service';
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
import { OidcSecretsService } from '../../src/tenant-admin/oidc-secrets.service';
import {
  TEST_REDIRECT_URI,
  callback,
  configureOidc,
  locationOf,
  nextCaller,
  outcomeOf,
  sessionSetCookie,
  signInThrough,
  startFlow,
} from './oidc-flow';

/**
 * The OIDC login against a real provider — everything except
 * the account key, which has a file of its own because its whole assertion is a
 * setup two organisations wide (`oidc-two-issuers.spec.ts`).
 *
 * What is checked here: a manipulated `state`, a missing and a wrong `nonce`,
 * PKCE, the server-decided `redirect_uri`, and an organisation with `oidcEnabled: false`
 * that is **absent from the offer *and* refuses the direct call**. Plus the
 * three steps of ADR-0012 no. 3 and the dead end an account without an organisation runs
 * into.
 */

const SETUP_TIMEOUT_MS = 180_000;

const CLIENT_ID = 'formular-alpha';
const CLIENT_SECRET = 'client-secret-of-alpha';

describe('OIDC login', () => {
  let database: TestDatabase | undefined;
  let testApp: TestApp | undefined;
  let idp: FakeIdp | undefined;
  /** A second provider, for the organisation that has SSO switched off. */
  let otherIdp: FakeIdp | undefined;

  /** SSO on, fully configured. */
  let alpha: TenantFixture;
  /** Configured down to the last field — and `oidcEnabled: false`. */
  let stumm: TenantFixture;

  /** Bound account of ALPHA, member of ALPHA. */
  let member: { id: string; sub: string; email: string };
  /** Bound account of ALPHA with **no** membership anywhere. */
  let heimatlos: { id: string; sub: string; email: string };
  /** A local account — reachable by no provider (ADR-0012 no. 3). */
  let lokal: { id: string; email: string };

  function app(): TestApp {
    if (testApp === undefined) {
      throw new Error('the application was not started');
    }
    return testApp;
  }

  function provider(): FakeIdp {
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

    idp = await startFakeIdp(CLIENT_ID, CLIENT_SECRET, {
      redirectUri: TEST_REDIRECT_URI,
    });
    otherIdp = await startFakeIdp('formular-stumm', 'secret-of-stumm', {
      redirectUri: TEST_REDIRECT_URI,
    });

    alpha = await createTenant(prisma, 'ALPHA');
    stumm = await createTenant(prisma, 'STUMM');

    await configureOidc(app(), alpha.id, provider(), {
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      buttonLabel: 'Mit ALPHA-Konto anmelden',
    });
    // Everything filled in, and switched **off**. An organisation that is merely
    // unconfigured would prove nothing here: the requirement is about the flag,
    // not about missing fields.
    await configureOidc(app(), stumm.id, otherIdp, {
      clientId: 'formular-stumm',
      clientSecret: 'secret-of-stumm',
      enabled: false,
    });

    member = {
      sub: randomUUID(),
      email: 'schriftfuehrer@alpha.invalid',
      id: '',
    };
    const memberRow = await prisma.user.create({
      data: {
        email: member.email,
        name: 'Schriftführer ALPHA',
        oidcIssuer: provider().issuer,
        oidcSubject: member.sub,
      },
    });
    member.id = memberRow.id;
    await prisma.membership.create({
      data: {
        tenantId: alpha.id,
        userId: member.id,
        groupId: alpha.adminGroupId,
      },
    });

    heimatlos = { sub: randomUUID(), email: 'ohnebund@alpha.invalid', id: '' };
    const heimatlosRow = await prisma.user.create({
      data: {
        email: heimatlos.email,
        name: 'Ohne Organisation',
        oidcIssuer: provider().issuer,
        oidcSubject: heimatlos.sub,
      },
    });
    heimatlos.id = heimatlosRow.id;

    lokal = { email: 'lokal@alpha.invalid', id: '' };
    const lokalRow = await prisma.user.create({
      data: {
        email: lokal.email,
        name: 'Lokales Konto',
        passwordHash: await hashPassword(
          'korrektes-pferd-batterie-heftklammer',
        ),
      },
    });
    lokal.id = lokalRow.id;
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await testApp?.close();
    await idp?.close();
    await otherIdp?.close();
    await database?.release();
  });

  describe('the offer — which organisations show a button', () => {
    it('lists the configured Organisation and carries nothing about its provider', async () => {
      const response = await request(app().server).get(
        apiPath('/auth/oidc/providers'),
      );
      expect(response.status).toBe(200);

      const offers = parseOidcProviders(response.body);
      expect(offers.map((offer) => offer.tenantId)).toContain(alpha.id);
      expect(
        offers.find((offer) => offer.tenantId === alpha.id)?.buttonLabel,
      ).toBe('Mit ALPHA-Konto anmelden');

      // Positive-list style: the whole payload is searched, so a field
      // added later has to pass this test too.
      expect(response.text).not.toContain(provider().issuer);
      expect(response.text).not.toContain(CLIENT_ID);
      expect(response.text).not.toContain(CLIENT_SECRET);
    });

    /**
     * **Die Kette über den Draht** — Kopfzeile, Express' `trust proxy`,
     * Controller, Dienst. Die Einheitentests springen bei `providers({ host })`
     * ein und überspringen damit genau die Schicht, in der entschieden wird, ob
     * ein weitergereichter Host überhaupt geglaubt werden darf. Hier steht
     * `TRUST_PROXY_HOPS: 1` (oben im Aufbau), also wird er geglaubt.
     *
     * Der zweite `expect` ist der Nicht-Preisgabe-Test für den Fall, den die
     * Einheitentests nicht abdecken: eine **gesetzte** Basis-Adresse. Sie wird
     * verglichen und darf trotzdem nicht in der Antwort stehen.
     */
    it('marks the organisation reachable under the address the request came in on', async () => {
      const address = 'formulare.alpha.invalid';
      await app().prisma.tenant.update({
        where: { id: alpha.id },
        data: { publicBaseUrl: `https://${address}` },
      });

      const response = await request(app().server)
        .get(apiPath('/auth/oidc/providers'))
        .set('X-Forwarded-Host', address);
      expect(response.status).toBe(200);

      const offers = parseOidcProviders(response.body);
      expect(
        offers.find((offer) => offer.tenantId === alpha.id)?.atThisAddress,
      ).toBe(true);
      // Positivliste wie nebenan: verglichen wird serverseitig, die Adresse
      // selbst reist nicht mit.
      expect(response.text).not.toContain(address);

      await app().prisma.tenant.update({
        where: { id: alpha.id },
        data: { publicBaseUrl: null },
      });
    });

    it('leaves out an organisation whose SSO is switched off', async () => {
      const response = await request(app().server).get(
        apiPath('/auth/oidc/providers'),
      );
      expect(response.status).toBe(200);
      expect(response.text).not.toContain(stumm.id);
    });
  });

  describe('an organisation with `oidcEnabled: false` — absent *and* locked', () => {
    /**
     * The surface is convenience. This is the half that stays true
     * when nobody looks at the surface, and it is the requirement's fourth
     * reproduction: move the check into the UI and this goes red.
     */
    it('refuses the start route when it is called directly', async () => {
      const response = await request(app().server).get(
        apiPath(`/auth/oidc/start/${stumm.id}`),
      );
      expect(response.status).toBe(302);
      expect(outcomeOf(response)).toBe('fehlgeschlagen');
      // Nothing was started: no transaction cookie, and therefore no way to
      // continue with the code a provider might hand out anyway.
      expect(setCookieList(response)).toHaveLength(0);
    });

    it('refuses the callback when the flag is taken away mid-flow', async () => {
      // Start while SSO is on …
      const started = await startFlow(app(), alpha.id);
      const code = provider().authorize(started.authorizationUrl, {
        sub: member.sub,
        email: member.email,
      });

      // … switch it off, then come back. A check made only at the start would
      // let this through, and the direct call to the callback route is exactly
      // what the reproduction asks about.
      await app().prisma.tenant.update({
        where: { id: alpha.id },
        data: { oidcEnabled: false },
      });
      try {
        const response = await callback(
          app(),
          { code, state: started.state },
          started.cookie,
        );
        expect(response.status).toBe(302);
        expect(outcomeOf(response)).toBe('fehlgeschlagen');
        expect(sessionSetCookie(response)).toBeUndefined();
      } finally {
        await app().prisma.tenant.update({
          where: { id: alpha.id },
          data: { oidcEnabled: true },
        });
      }
    });

    it('refuses an unknown Organisation the same way it refuses a switched-off one', async () => {
      const unknown = await request(app().server).get(
        apiPath(`/auth/oidc/start/${randomUUID()}`),
      );
      const switchedOff = await request(app().server).get(
        apiPath(`/auth/oidc/start/${stumm.id}`),
      );
      // Byte-identical: whether an organisation exists, and whether it has SSO on, are
      // both facts about somebody else's Organisation.
      expect(unknown.status).toBe(switchedOff.status);
      expect(unknown.headers.location).toBe(switchedOff.headers.location);
    });

    it('refuses an id that is not a uuid without a database error', async () => {
      const response = await request(app().server).get(
        apiPath('/auth/oidc/start/nicht-einmal-eine-uuid'),
      );
      expect(response.status).toBe(302);
      expect(outcomeOf(response)).toBe('fehlgeschlagen');
    });
  });

  /**
   * **The two ways a well-configured Organisation used to answer wrongly** (review
   * findings). Both are about a comparison or a call that is *outside*
   * the run of `null`-returning checks the start route is built from, and both
   * were invisible because the fake provider is reachable and names itself the
   * way this application happens to store issuers.
   */
  describe('a provider the shipped code has to get right', () => {
    it('signs in at a provider whose issuer is a bare origin', async () => {
      // Auth0, Okta, Entra: the discovery document says
      // `http://host:port/` **with** the slash, while `acceptableIssuer` stores
      // the value without it. Comparing `claims.iss` against the stored value
      // with `!==` refuses this organisation's every login *after* a successful
      // discovery — fail closed, and therefore silent until somebody blames the
      // one check the whole account key of ADR-0012 no. 2 rests on.
      const rootIdp = await startFakeIdp(CLIENT_ID, CLIENT_SECRET, {
        redirectUri: TEST_REDIRECT_URI,
        trailingSlash: true,
      });
      const wurzel = await createTenant(
        app().prisma,
        `WURZEL-${randomUUID().slice(0, 8)}`,
      );
      const sub = randomUUID();
      try {
        expect(rootIdp.issuer.endsWith('/')).toBe(true);
        await configureOidc(app(), wurzel.id, rootIdp, {
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
        });

        // Bound to the **normalised** issuer, which is what the exchange builds
        // the account key from (`OidcSignIn.issuer`).
        const user = await app().prisma.user.create({
          data: {
            email: `wurzel-${sub}@alpha.invalid`,
            name: 'Mitglied mit Wurzel-Issuer',
            oidcIssuer: rootIdp.issuer.replace(/\/+$/, ''),
            oidcSubject: sub,
          },
        });
        await app().prisma.membership.create({
          data: {
            tenantId: wurzel.id,
            userId: user.id,
            groupId: wurzel.adminGroupId,
          },
        });

        const response = await signInThrough(app(), rootIdp, wurzel.id, {
          sub,
          email: user.email,
        });
        expect(outcomeOf(response)).toBeNull();
        expect(sessionSetCookie(response)).toBeDefined();
      } finally {
        await rootIdp.close();
      }
    });

    it('refuses an organisation whose provider is unreachable the way it refuses every other', async () => {
      // Configured down to the last field, and nothing answers at the address.
      // Discovery is the one step of `start()` that throws instead of returning
      // `null`, so this used to leave the route as a **500** — which tells an
      // unauthenticated caller „konfiguriert, IdP tot" where every other refusal
      // says nothing at all.
      const dead = await startFakeIdp('formular-tot', 'secret-of-tot', {
        redirectUri: TEST_REDIRECT_URI,
      });
      const deadIssuer = dead.issuer;
      await dead.close();

      const tot = await createTenant(
        app().prisma,
        `TOT-${randomUUID().slice(0, 8)}`,
      );
      await configureOidc(
        app(),
        tot.id,
        { ...dead, issuer: deadIssuer },
        { clientId: 'formular-tot', clientSecret: 'secret-of-tot' },
      );

      const response = await request(app().server)
        .get(apiPath(`/auth/oidc/start/${tot.id}`))
        .set('X-Forwarded-For', nextCaller());

      expect(response.status).toBe(302);
      expect(outcomeOf(response)).toBe('fehlgeschlagen');
      // Byte-identical to „gibt es nicht", so the two are not distinguishable.
      const unknown = await request(app().server)
        .get(apiPath(`/auth/oidc/start/${randomUUID()}`))
        .set('X-Forwarded-For', nextCaller());
      expect(response.headers.location).toBe(unknown.headers.location);
      // And nothing was started: no transaction cookie to continue with.
      expect(setCookieList(response)).toHaveLength(0);
    });
  });

  describe('the `redirect_uri` is a server function', () => {
    /**
     * The requirement's third reproduction. The address is built from
     * `PUBLIC_BASE_URL` — a host that is deliberately unreachable in the test
     * app — so a `redirect_uri` taken from the request would be visibly
     * different here rather than coincidentally equal.
     */
    it('sends the configured address, not one from the request', async () => {
      const started = await startFlow(app(), alpha.id);
      const sent = new URL(started.authorizationUrl).searchParams.get(
        'redirect_uri',
      );
      expect(sent).toBe(`${TEST_PUBLIC_BASE_URL}${OIDC_CALLBACK_PATH}`);
    });

    it('ignores a `redirect_uri` and a `Host` a caller sends', async () => {
      const response = await request(app().server)
        .get(
          `${apiPath(`/auth/oidc/start/${alpha.id}`)}?redirect_uri=${encodeURIComponent('https://angreifer.invalid/faengt-den-code')}`,
        )
        // `Host` is written by the caller. A link built from it would be a link
        // an outsider chooses — the argument `PublicUrlService` is built on.
        .set('Host', 'angreifer.invalid');

      expect(response.status).toBe(302);
      const sent = new URL(locationOf(response)).searchParams.get(
        'redirect_uri',
      );
      expect(sent).toBe(`${TEST_PUBLIC_BASE_URL}${OIDC_CALLBACK_PATH}`);
      expect(sent).not.toContain('angreifer.invalid');
    });
  });

  describe('`state` and `nonce`', () => {
    it('refuses a `state` that does not belong to the transaction', async () => {
      // A whole second flow, so the `state` presented is a *real* one — just
      // somebody else's. That is the login-CSRF shape: an attacker finishing
      // their own flow in another browser.
      const victim = await startFlow(app(), alpha.id);
      const attacker = await startFlow(app(), alpha.id);
      const code = provider().authorize(attacker.authorizationUrl, {
        sub: member.sub,
        email: member.email,
      });

      const response = await callback(
        app(),
        { code, state: attacker.state },
        victim.cookie,
      );

      expect(response.status).toBe(302);
      expect(outcomeOf(response)).toBe('fehlgeschlagen');
      expect(sessionSetCookie(response)).toBeUndefined();
    });

    it('refuses a `state` that is the only thing wrong', async () => {
      // Everything else is this browser's own: its cookie, its code, its PKCE
      // verifier and its nonce. So nothing *but* the state check can refuse
      // this — which is what makes it the witness of the requirement's second reproduction.
      // (The victim/attacker case above is caught by PKCE as well, so it would
      // stay green on its own; defence in depth is not a substitute for a test
      // that measures the rule in question.)
      const started = await startFlow(app(), alpha.id);
      const code = provider().authorize(started.authorizationUrl, {
        sub: member.sub,
        email: member.email,
      });
      const response = await callback(
        app(),
        { code, state: 'HL8FGmRkTWJkYnBWZW5yYmxvY2tlZFN0YXRlVmFsdWU' },
        started.cookie,
      );
      expect(outcomeOf(response)).toBe('fehlgeschlagen');
      expect(sessionSetCookie(response)).toBeUndefined();
      // And the code was never spent: the state is checked before anything is
      // fetched, so a callback that does not belong to this browser costs the
      // provider nothing.
      const again = await callback(
        app(),
        { code, state: started.state },
        started.cookie,
      );
      expect(outcomeOf(again)).toBeNull();
    });

    it('refuses a callback with no `state` at all', async () => {
      const started = await startFlow(app(), alpha.id);
      const code = provider().authorize(started.authorizationUrl, {
        sub: member.sub,
        email: member.email,
      });
      const response = await callback(app(), { code }, started.cookie);
      expect(outcomeOf(response)).toBe('fehlgeschlagen');
      expect(sessionSetCookie(response)).toBeUndefined();
    });

    it('refuses a callback with no transaction cookie', async () => {
      const started = await startFlow(app(), alpha.id);
      const code = provider().authorize(started.authorizationUrl, {
        sub: member.sub,
        email: member.email,
      });
      const response = await callback(
        app(),
        { code, state: started.state },
        undefined,
      );
      expect(outcomeOf(response)).toBe('fehlgeschlagen');
      expect(sessionSetCookie(response)).toBeUndefined();
    });

    it('refuses an ID token without a `nonce`', async () => {
      const response = await signInThrough(
        app(),
        provider(),
        alpha.id,
        { sub: member.sub, email: member.email },
        { omitNonce: true },
      );
      expect(outcomeOf(response)).toBe('fehlgeschlagen');
      expect(sessionSetCookie(response)).toBeUndefined();
    });

    it('refuses an ID token whose `nonce` is somebody else’s', async () => {
      const response = await signInThrough(
        app(),
        provider(),
        alpha.id,
        { sub: member.sub, email: member.email },
        { nonce: 'ein-fremder-nonce' },
      );
      expect(outcomeOf(response)).toBe('fehlgeschlagen');
      expect(sessionSetCookie(response)).toBeUndefined();
    });

    /**
     * **What is actually true about a transaction, in two tests that say it.**
     *
     * There used to be one named „does not let one transaction be spent twice",
     * and it ended on `expect(status).toBe(302)` — which every path of every
     * route in this package answers. The replay it performed **succeeded** and
     * installed a second session; the name, the comment and the assertion each
     * said something different (review finding).
     *
     * The property this application has is the first test: the cookie is gone
     * after one callback, so a **browser** cannot replay. The property it does
     * **not** have is the second: a transaction is browser-held bearer state,
     * not server-side single-use state, and whoever keeps the cookie by hand can
     * exchange a second code with it. That is the deliberate consequence of
     * ADR-0012 no. 8 (no table, no shared server state), and it costs little:
     * the cookie is `HttpOnly`, `SameSite=Lax`, `__Host-` behind TLS and lives
     * ten minutes, and a second code still has to be obtained from the provider
     * by authenticating — as **somebody**, whose account the second session then
     * belongs to. Making it truly single-use needs state shared across
     * instances, which is the thing that decision weighed and declined.
     */
    it('clears the transaction cookie on every path, so a browser cannot replay', async () => {
      const started = await startFlow(app(), alpha.id);
      const code = provider().authorize(started.authorizationUrl, {
        sub: member.sub,
        email: member.email,
      });

      const response = await callback(
        app(),
        { code, state: started.state },
        started.cookie,
      );
      expect(outcomeOf(response)).toBeNull();

      // Both names, because the browser may hold either one (`buildClearedOidcCookies`).
      const cleared = setCookieList(response).filter((value) =>
        /^(__Host-)?formsache_oidc=;/.test(value),
      );
      expect(cleared).toHaveLength(2);
    });

    it('is bearer state: a cookie kept by hand exchanges a second code', async () => {
      const started = await startFlow(app(), alpha.id);
      const first = provider().authorize(started.authorizationUrl, {
        sub: member.sub,
        email: member.email,
      });
      const second = provider().authorize(started.authorizationUrl, {
        sub: member.sub,
        email: member.email,
      });

      const one = await callback(
        app(),
        { code: first, state: started.state },
        started.cookie,
      );
      expect(sessionSetCookie(one)).toBeDefined();

      // Asserted rather than left unsaid — see the block comment. If this ever
      // goes red because a transaction became single-use, that is an
      // improvement, and this test is what points at the decision to revisit.
      const two = await callback(
        app(),
        { code: second, state: started.state },
        started.cookie,
      );
      expect(outcomeOf(two)).toBeNull();
      expect(sessionSetCookie(two)).toBeDefined();

      // And the *same* code twice is refused — by the provider, which spends an
      // authorization code once. That is the half that was always true.
      const again = await callback(
        app(),
        { code: second, state: started.state },
        started.cookie,
      );
      expect(outcomeOf(again)).toBe('fehlgeschlagen');
      expect(sessionSetCookie(again)).toBeUndefined();
    });
  });

  /**
   * **PKCE (RFC 7636), and the reason it needs a test of its own.**
   *
   * It is the net the `state` check leans on: the victim/attacker case above is
   * caught by PKCE as well, which is why that test had to be written with a
   * forged `state` on the browser's *own* flow to measure anything. But nothing
   * asserted that PKCE was there at all — the fake provider skipped the check
   * when `code_challenge` was **missing**, so deleting the two lines from
   * `OidcProviderService.authorizationRequest` left the whole suite green
   * (review finding). The provider now **requires** the challenge, and
   * this is the direct assertion on the request itself.
   */
  describe('PKCE', () => {
    it('sends the S256 challenge of this flow’s own verifier', async () => {
      const started = await startFlow(app(), alpha.id);
      const parameters = new URL(started.authorizationUrl).searchParams;

      expect(parameters.get('code_challenge_method')).toBe('S256');

      // Not „irgendein code_challenge": the challenge has to be the digest of
      // the verifier **this** transaction carries, or the code exchange would
      // present a verifier the provider cannot match — and a constant would
      // satisfy a weaker assertion while binding nothing.
      const transaction = readOidcTransaction(started.cookie, false);
      expect(transaction).toBeDefined();
      expect(parameters.get('code_challenge')).toBe(
        createHash('sha256')
          .update(transaction?.codeVerifier ?? '')
          .digest('base64url'),
      );
    });

    it('refuses the exchange when the verifier does not match the challenge', async () => {
      // The provider's half, asserted through the shipped routes: a callback
      // whose transaction cookie was swapped for another flow's carries the
      // wrong `code_verifier`, and the token endpoint refuses the grant. Both
      // cookies are real, and the `state` presented is the one that belongs to
      // the cookie — so nothing but PKCE can refuse this.
      const flow = await startFlow(app(), alpha.id);
      const other = await startFlow(app(), alpha.id);
      const code = provider().authorize(flow.authorizationUrl, {
        sub: member.sub,
        email: member.email,
      });

      const response = await callback(
        app(),
        { code, state: other.state },
        other.cookie,
      );
      expect(outcomeOf(response)).toBe('fehlgeschlagen');
      expect(sessionSetCookie(response)).toBeUndefined();
    });
  });

  describe('who gets in — ADR-0012 Nr. 3', () => {
    it('signs in an account already bound to (issuer, subject)', async () => {
      const response = await signInThrough(app(), provider(), alpha.id, {
        sub: member.sub,
        email: member.email,
      });
      expect(response.status).toBe(302);
      expect(outcomeOf(response)).toBeNull();
      expect(sessionSetCookie(response)).toBeDefined();

      // The session cookie carries the attributes the requirement names, and the
      // CSRF companion travels with it — without it every mutating
      // request after an SSO login would be a 403.
      const cookies = setCookieList(response);
      const session = cookies.find((value) =>
        value.startsWith(`${SESSION_COOKIE_NAME}=`),
      );
      expect(session).toContain('HttpOnly');
      expect(session).toContain('SameSite=Lax');
      expect(cookies.some((value) => value.startsWith('formsache_csrf='))).toBe(
        true,
      );
    });

    it('signs in without consulting the e-mail once the pair is bound', async () => {
      // The provider claims a *different*, unknown address for a `sub` that is
      // already bound. Step 1 of ADR-0012 no. 3 must not care.
      const response = await signInThrough(app(), provider(), alpha.id, {
        sub: member.sub,
        email: 'ganz-woanders@fremd.invalid',
      });
      expect(outcomeOf(response)).toBeNull();
      expect(sessionSetCookie(response)).toBeDefined();
    });

    it('refuses an unknown subject, and says nothing about the address', async () => {
      const unknownEmail = await signInThrough(app(), provider(), alpha.id, {
        sub: randomUUID(),
        email: 'niemand@alpha.invalid',
      });
      const localEmail = await signInThrough(app(), provider(), alpha.id, {
        sub: randomUUID(),
        email: lokal.email,
      });

      expect(outcomeOf(unknownEmail)).toBe('abgelehnt');
      // **Byte-identical.** „Es liegt keine Einladung vor" and „die Adresse
      // gehört einem lokalen Konto" must read the same, or the login page is a
      // directory of who has an account here (ADR-0012 no. 3 step 3).
      expect(localEmail.status).toBe(unknownEmail.status);
      expect(localEmail.headers.location).toBe(unknownEmail.headers.location);
      expect(sessionSetCookie(localEmail)).toBeUndefined();
    });

    it('never lets a provider claim a local account', async () => {
      await signInThrough(app(), provider(), alpha.id, {
        sub: randomUUID(),
        email: lokal.email,
      });

      // The raw row, not the API's opinion of it: `password_hash IS NULL` is
      // part of the redemption condition, so this account is out of reach of
      // **every** provider — including one an organisation configures itself.
      const row = await app().prisma.user.findUnique({
        where: { id: lokal.id },
        select: { oidcIssuer: true, oidcSubject: true, passwordHash: true },
      });
      expect(row?.oidcIssuer).toBeNull();
      expect(row?.oidcSubject).toBeNull();
      expect(row?.passwordHash).not.toBeNull();
    });

    it('refuses when the token carries no verified e-mail and no pair matches', async () => {
      const response = await signInThrough(app(), provider(), alpha.id, {
        sub: randomUUID(),
        email: 'unbestaetigt@alpha.invalid',
        emailVerified: false,
      });
      expect(outcomeOf(response)).toBe('abgelehnt');
      expect(sessionSetCookie(response)).toBeUndefined();
    });
  });

  describe('a secret that does not open here', () => {
    /**
     * The other half of that guarantee: the sealed value of one organisation is written
     * into another organisation's column by a raw write, and the login of that organisation
     * **fails visibly** instead of quietly working with a foreign secret.
     *
     * The organisation keeps `oidcEnabled: true` throughout — the point is that
     * „eingeschaltet" and „benutzbar" are different, and that the fail-closed
     * answer wins.
     */
    it('offers no button and refuses the start route', async () => {
      const foreign = app()
        .app.get(OidcSecretsService)
        // Sealed for STUMM, stored on ALPHA: the AAD names the tenant, so it
        // cannot be opened there.
        .seal(CLIENT_SECRET, stumm.id);
      const original = (
        await app().prisma.tenant.findUniqueOrThrow({
          where: { id: alpha.id },
          select: { oidcClientSecret: true },
        })
      ).oidcClientSecret;

      await app().prisma.tenant.update({
        where: { id: alpha.id },
        data: { oidcClientSecret: foreign },
      });
      try {
        const offers = await request(app().server).get(
          apiPath('/auth/oidc/providers'),
        );
        expect(offers.text).not.toContain(alpha.id);

        const start = await request(app().server)
          .get(apiPath(`/auth/oidc/start/${alpha.id}`))
          .set('X-Forwarded-For', nextCaller());
        expect(start.status).toBe(302);
        expect(outcomeOf(start)).toBe('fehlgeschlagen');
        // Visibly, and *without* a transaction: nothing was started, so no code
        // can ever be redeemed against this organisation while the secret is unreadable.
        expect(setCookieList(start)).toHaveLength(0);
      } finally {
        await app().prisma.tenant.update({
          where: { id: alpha.id },
          data: { oidcClientSecret: original },
        });
      }
    });
  });

  describe('the routes carry their own rate limit', () => {
    /**
     * There is exactly **one** `ThrottlerModule.forRoot` in this application
     * (`common/rate-limit.module.ts`); a second one would replace it silently,
     * which is how the login's limit disappeared. This asserts that the
     * numbers stated with `@Throttle` on the start route actually apply — the
     * suite otherwise never notices, because it speaks from a fresh address per
     * flow on purpose.
     */
    it('locks a caller out of the start route after ten attempts a minute', async () => {
      const caller = nextCaller();
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const response = await request(app().server)
          .get(apiPath(`/auth/oidc/start/${alpha.id}`))
          .set('X-Forwarded-For', caller);
        statuses.push(response.status);
      }
      expect(statuses.filter((status) => status === 302)).toHaveLength(10);
      expect(statuses.at(-1)).toBe(429);
    });
  });

  describe('signing in grants no rights', () => {
    /**
     * ADR-0012 no. 5 and the trap the coordinator named: a login without a
     * membership must be a **stated** dead end. Not an empty shell — the app
     * would render a header with no organisation and no explanation — and above all not
     * an account that quietly gains one.
     */
    it('turns an account without any Organisation into a dead end, not a session', async () => {
      const response = await signInThrough(app(), provider(), alpha.id, {
        sub: heimatlos.sub,
        email: heimatlos.email,
      });

      expect(response.status).toBe(302);
      expect(outcomeOf(response)).toBe('ohne-Organisation');
      expect(sessionSetCookie(response)).toBeUndefined();

      // And nothing was granted on the way: signing in through an organisation's
      // provider does not make anybody a member of that organisation.
      const memberships = await app().prisma.membership.count({
        where: { userId: heimatlos.id },
      });
      expect(memberships).toBe(0);
    });

    it('creates no account for somebody the provider vouches for', async () => {
      const before = await app().prisma.user.count();
      await signInThrough(app(), provider(), alpha.id, {
        sub: randomUUID(),
        email: 'frisch@alpha.invalid',
      });
      expect(await app().prisma.user.count()).toBe(before);
    });
  });

  /**
   * **The one step that turns a stranger into a member of an organisation** — ADR-0012
   * no. 3 step 2, and therefore the two tests in this file that must never be
   * excused.
   *
   * They were once introduced as „red until the migration
   * lands": redeeming an invitation needs a `user` row with an issuer, **no**
   * subject and **no** password, and two `CHECK` constraints forbade
   * exactly that shape. The migration landed
   * (`20260730154134_relax_user_credential_checks_for_oidc_invitation`, commit
   * `56dc7b0`) — one commit *before* the package this note survived into. A
   * comment that declares a test expectably red is how a real red goes
   * unnoticed, and these are the last two it may happen to; so it is gone, and
   * both cases are ordinary green tests with an ordinary obligation.
   */
  describe('redeeming an invitation (ADR-0012 Nr. 3 step 2)', () => {
    const invitedEmail = 'eingeladen@alpha.invalid';

    async function invite(): Promise<string> {
      const row = await app().prisma.user.create({
        data: {
          email: invitedEmail,
          name: 'Eingeladene Person',
          // Stamped with the **inviting** organisation's issuer, never with one from a
          // token: that is what keeps Organisation B's provider away from Organisation A's
          // invitation.
          oidcIssuer: provider().issuer,
          oidcSubject: null,
          passwordHash: null,
        },
      });
      await app().prisma.membership.create({
        data: {
          tenantId: alpha.id,
          userId: row.id,
          groupId: alpha.adminGroupId,
        },
      });
      return row.id;
    }

    it('binds the subject to the invited row on the first login', async () => {
      const userId = await invite();
      try {
        const response = await signInThrough(app(), provider(), alpha.id, {
          sub: randomUUID(),
          email: invitedEmail,
        });
        expect(outcomeOf(response)).toBeNull();
        expect(sessionSetCookie(response)).toBeDefined();

        const row = await app().prisma.user.findUnique({
          where: { id: userId },
          select: { oidcSubject: true, oidcIssuer: true },
        });
        expect(row?.oidcSubject).not.toBeNull();
        expect(row?.oidcIssuer).toBe(provider().issuer);
      } finally {
        await app().prisma.user.delete({ where: { id: userId } });
      }
    });

    /**
     * **ADR-0012 no. 3a — the reproduction the issuer alone cannot survive.**
     *
     * Both organisations use the *same* provider: one Keycloak realm, one client per
     * Organisation, which is the most natural way for an operator to run this and which
     * nothing in the data model forbids (`tenant.oidc_issuer` has no unique
     * index). The invitation belongs to ALPHA. If the redemption condition
     * carries only the issuer, BETA's login redeems it — an organisation helping itself
     * to another organisation's invited person, with a provider it is allowed to
     * configure.
     */
    it('does not let a second organisation on the same issuer redeem the invitation', async () => {
      const userId = await invite();
      const geteilt = await createTenant(
        app().prisma,
        `GETEILT-${randomUUID().slice(0, 8)}`,
      );
      try {
        // Same issuer, same client, same secret — a second client of the same
        // realm would be identical for this purpose.
        await configureOidc(app(), geteilt.id, provider(), {
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
        });

        const response = await signInThrough(app(), provider(), geteilt.id, {
          sub: randomUUID(),
          email: invitedEmail,
        });
        expect(outcomeOf(response)).toBe('abgelehnt');
        expect(sessionSetCookie(response)).toBeUndefined();

        // Untouched: still ALPHA's unclaimed invitation, still redeemable
        // where it belongs.
        const row = await app().prisma.user.findUnique({
          where: { id: userId },
          select: { oidcSubject: true },
        });
        expect(row?.oidcSubject).toBeNull();
      } finally {
        await app().prisma.user.delete({ where: { id: userId } });
      }
    });

    it('does not let a second provider redeem the same invitation', async () => {
      const userId = await invite();
      const foreign = await startFakeIdp(CLIENT_ID, CLIENT_SECRET, {
        redirectUri: TEST_REDIRECT_URI,
      });
      const beta = await createTenant(
        app().prisma,
        `FREMD-${randomUUID().slice(0, 8)}`,
      );
      try {
        await configureOidc(app(), beta.id, foreign, {
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
        });
        // Same address, same shape of flow — a different issuer. The invitation
        // carries ALPHA's issuer, so it is out of this provider's reach.
        const response = await signInThrough(app(), foreign, beta.id, {
          sub: randomUUID(),
          email: invitedEmail,
        });
        expect(outcomeOf(response)).toBe('abgelehnt');

        const row = await app().prisma.user.findUnique({
          where: { id: userId },
          select: { oidcSubject: true },
        });
        expect(row?.oidcSubject).toBeNull();
      } finally {
        await foreign.close();
        await app().prisma.user.delete({ where: { id: userId } });
      }
    });
  });
});

/** supertest types headers loosely; `set-cookie` is foreign data like any other. */
function setCookieList(response: request.Response): string[] {
  const headers = response.headers['set-cookie'];
  return Array.isArray(headers) ? (headers as string[]) : [];
}
