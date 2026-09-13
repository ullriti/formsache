import { createHash } from 'node:crypto';

import { loginResponseSchema, sessionUserSchema } from '@formsache/shared';
import request from 'supertest';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { z } from 'zod';

import { JSON_BODY_LIMIT_BYTES } from '../../src/app-setup';
import { INVALID_CREDENTIALS_MESSAGE } from '../../src/auth/auth.service';
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SECURE_CSRF_COOKIE_NAME,
  deriveCsrfToken,
} from '../../src/auth/csrf';
import { LOGIN_RATE_LIMIT } from '../../src/auth/login-rate-limit';
import { NO_STORE } from '../../src/common/no-store';
import {
  SECURE_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  readSessionToken,
} from '../../src/auth/session-cookie';
import { NOT_AUTHENTICATED_MESSAGE } from '../../src/auth/session.guard';
import { digestSessionToken } from '../../src/auth/session-token';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import { resetRateLimit } from '../support/rate-limit';
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
import {
  compareInterleaved,
  expectSameOrderOfTime,
} from '../support/timing-comparison';

/**
 * The requirements, measured against a real PostgreSQL database.
 *
 * The suite is built around the negative case throughout: a test that only
 * shows the allowed path proves nothing. Every promise here has
 * its counterpart — the wrong password, the unknown address, the revoked
 * cookie, the expired one.
 */

const SETUP_TIMEOUT_MS = 180_000;

const PASSWORD = 'korrektes-pferd-batterie-heftklammer';
const WRONG_PASSWORD = 'korrektes-pferd-batterie-heftklammeR';

/** supertest types headers loosely; set-cookie is foreign data like any other. */
const setCookieSchema = z.array(z.string()).default([]);

function setCookies(response: request.Response): string[] {
  return setCookieSchema.parse(response.headers['set-cookie']);
}

function sessionCookie(response: request.Response): string {
  const [header] = setCookies(response);
  expect(header).toBeDefined();
  // `false`: the test app runs without TLS, so the cookie carries the bare
  // name. The production spelling is covered where it belongs — the app booted
  // with `NODE_ENV=production` further down, and `session-cookie.spec.ts`.
  const token = readSessionToken(header, false);
  expect(token).toBeDefined();
  // Checked above; the assertion is what makes this safe, not the operator.
  return token ?? '';
}

function cookieHeader(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}`;
}

/**
 * The CSRF header a mutating request has to carry.
 *
 * Derived with the application's own function, never restated: a second
 * implementation here would keep agreeing with itself after the derivation
 * changed, which is exactly what a test of a token must not do.
 */
function csrfHeader(token: string): Record<string, string> {
  return { [CSRF_HEADER_NAME]: deriveCsrfToken(token) };
}

/**
 * Everything a comparison of two failed logins must ignore.
 *
 * Short list on purpose. `x-powered-by` used to be in here and is not any
 * more — twice over: it was the same on every answer, so listing it made the
 * set's name a lie, and it is now gone entirely. Server and tests share one
 * `configureApp()` (`src/app-setup.ts`), so the header this suite would have
 * had to ignore is the header the application no longer sends.
 *
 * The rate limiter runs with `setHeaders: false`, which is what keeps this
 * comparison honest: `X-RateLimit-Remaining` counts down between two requests
 * and would otherwise have had to be added to this very list.
 */
/*
 * `x-request-id` came along later and is **random per request**. It is up for
 * debate here and not in the application: the assurance of this file is that
 * two answers reveal **nothing about their occasion** — not that they are
 * equal byte for byte. A random number reveals nothing; it merely tells two
 * calls apart, which a timestamp would do as well.
 */
const VOLATILE_HEADERS = new Set(['date', 'etag', 'x-request-id']);

function stableHeaders(response: request.Response): Record<string, string> {
  const headers = z.record(z.string(), z.unknown()).parse(response.headers);
  const stable: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!VOLATILE_HEADERS.has(name.toLowerCase())) {
      stable[name.toLowerCase()] = JSON.stringify(value);
    }
  }
  return stable;
}

describe('authentication', () => {
  let database: TestDatabase | undefined;
  let testApp: TestApp | undefined;
  let dach: TenantFixture;
  let other: TenantFixture;

  const login = (email: string, password: string): request.Test =>
    request(app().server)
      .post(apiPath('/auth/login'))
      .send({ email, password });

  function app(): TestApp {
    if (testApp === undefined) {
      throw new Error('the application was not started');
    }
    return testApp;
  }

  /**
   * Fails loudly rather than handing on an empty connection string.
   *
   * `database?.url ?? ''` would start a second application against no database
   * at all, and the pg adapter connects lazily — so the failure would surface
   * as some unrelated assertion much further down, in a test about cookies.
   */
  function databaseUrl(): string {
    if (database === undefined) {
      throw new Error('the test database was not acquired');
    }
    return database.url;
  }

  /**
   * Resets the login rate limit to zero — counters **and** the timers that go
   * with them ({@link resetRateLimit}).
   *
   * It counts per origin address, and every case of this file comes from the
   * same loopback address: without the reset the suite would be one caller
   * with dozens of attempts per minute, and the case that happens to run
   * eleventh would go red.
   *
   * The helper has lived in `support/rate-limit.ts` since security finding 2
   * and no longer here: the invitation routes now carry a limit as well, and
   * the reach into the library's private storage belongs in **one** place.
   */
  function resetLoginRateLimit(): void {
    resetRateLimit(app());
  }

  beforeEach(() => {
    if (testApp !== undefined) {
      resetLoginRateLimit();
    }
  });

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });

    dach = await createTenant(app().prisma, 'Dachorganisation');
    other = await createTenant(app().prisma, 'OTHER');

    await createUser(app().prisma, {
      email: 'Admin@Example.ORG',
      password: PASSWORD,
      tenants: [dach],
    });
    await createUser(app().prisma, {
      email: 'oidc@example.org',
      // No password at all — this user signs in through their tenant's IdP.
      tenants: [dach],
    });
    await createUser(app().prisma, {
      email: 'zwei@example.org',
      password: PASSWORD,
      tenants: [dach, other],
    });
    await createUser(app().prisma, {
      email: 'ohne@example.org',
      password: PASSWORD,
      isSuperadmin: true,
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await testApp?.close();
    await database?.release();
  }, SETUP_TIMEOUT_MS);

  describe('POST /api/auth/login', () => {
    it('answers 200 with a body the shared contract accepts', async () => {
      const response = await login('admin@example.org', PASSWORD);

      expect(response.status).toBe(200);
      const body = loginResponseSchema.parse(response.body as unknown);
      expect(body.user.email).toBe('admin@example.org');
      expect(body.user.memberships).toHaveLength(1);
      expect(body.user.memberships[0]?.tenant.shortName).toBe(
        'Dachorganisation',
      );
      expect(body.user.memberships[0]?.tenant.branding.accent).toBe('#cea967');
      expect(body.user.memberships[0]?.permissions.canManageUsers).toBe(true);
    });

    it('sets a session cookie that is HttpOnly and SameSite=Lax', async () => {
      const response = await login('admin@example.org', PASSWORD);
      const [header] = setCookies(response);

      expect(header).toBeDefined();
      expect(header).toContain('HttpOnly');
      expect(header).toContain('SameSite=Lax');
      expect(header).toContain('Path=/');
      expect(header).toContain('Max-Age=43200');
    });

    /**
     * `Secure` over plain http would be dropped by the browser without a word,
     * and the login would look successful while every following request stayed
     * anonymous. It has to appear in production **by default** — see the test
     * below for the installation that says otherwise on purpose.
     */
    it('marks the cookie Secure only in production', async () => {
      expect(
        setCookies(await login('admin@example.org', PASSWORD))[0],
      ).not.toContain('Secure');

      const production = await createTestApp({
        databaseUrl: databaseUrl(),
        env: { NODE_ENV: 'production' },
      });
      try {
        const response = await request(production.server)
          .post(apiPath('/auth/login'))
          .send({ email: 'admin@example.org', password: PASSWORD });
        expect(setCookies(response)[0]).toContain('; Secure');
        // The name goes with it: `__Host-` is only usable together with
        // `Secure`, and it is what keeps a subdomain from writing a cookie of
        // the same name for the parent domain.
        expect(setCookies(response)[0]).toContain(
          `${SECURE_SESSION_COOKIE_NAME}=`,
        );
      } finally {
        await production.close();
      }
    });

    /**
     * **The installation without TLS, end to end** (Review-Runde 5 Nr. 5).
     *
     * `docker-compose.prod.yml` pins `NODE_ENV: production`, so an installation
     * reached over plain http in its own network used to have no way to say so:
     * the login answered 200, the browser discarded the `Secure` cookie on
     * every address but `localhost`, and every request afterwards was anonymous.
     * `SESSION_COOKIE_SECURE=false` is that way — and what makes it worth an
     * integration test rather than a unit test is the **agreement** between the
     * writer and the reader. The login has to write the bare name *and*
     * `SessionGuard` has to accept it; a fix that moved only one of the two
     * would leave a 200 followed by 401s, which is the same symptom one door
     * further along.
     */
    it('drops Secure in production when the installation runs without TLS', async () => {
      const httpOnly = await createTestApp({
        databaseUrl: databaseUrl(),
        env: { NODE_ENV: 'production', SESSION_COOKIE_SECURE: false },
      });
      try {
        const loggedIn = await request(httpOnly.server)
          .post(apiPath('/auth/login'))
          .send({ email: 'admin@example.org', password: PASSWORD });
        const [header] = setCookies(loggedIn);
        expect(header).toBeDefined();
        expect(header).not.toContain('Secure');
        expect(header).toContain(`${SESSION_COOKIE_NAME}=`);
        expect(header).not.toContain('__Host-');

        // …and the reader agrees, which is the half a one-sided fix would miss.
        const token = readSessionToken(header, false);
        expect(token).toBeDefined();
        const me = await request(httpOnly.server)
          .get(apiPath('/auth/me'))
          .set('Cookie', `${SESSION_COOKIE_NAME}=${token ?? ''}`);
        expect(me.status).toBe(200);
      } finally {
        await httpOnly.close();
      }
    });

    /**
     * What the `__Host-` prefix is actually worth, seen failing.
     *
     * The reader is unit-tested, but nothing proved that the *guard* hangs off
     * that reader — and that wiring is exactly what broke once already while
     * this was being built. So: log in under TLS, take the real token out of
     * the `__Host-` cookie, and present the very same token under the bare
     * name. A subdomain can write that cookie; no one but the host can write
     * the other. It has to come back 401, and the same token under the right
     * name has to come back 200 — otherwise the difference is decorative.
     */
    it('refuses a valid token presented under the bare cookie name', async () => {
      const production = await createTestApp({
        databaseUrl: databaseUrl(),
        env: { NODE_ENV: 'production' },
      });
      try {
        const loggedIn = await request(production.server)
          .post(apiPath('/auth/login'))
          .send({ email: 'admin@example.org', password: PASSWORD });
        const [header] = setCookies(loggedIn);
        expect(header).toBeDefined();
        const token = readSessionToken(header, true);
        expect(token).toBeDefined();

        const tossed = await request(production.server)
          .get(apiPath('/auth/me'))
          .set('Cookie', `${SESSION_COOKIE_NAME}=${token ?? ''}`);
        expect(tossed.status).toBe(401);

        const genuine = await request(production.server)
          .get(apiPath('/auth/me'))
          .set('Cookie', `${SECURE_SESSION_COOKIE_NAME}=${token ?? ''}`);
        expect(genuine.status).toBe(200);
      } finally {
        await production.close();
      }
    });

    /**
     * `SESSION_TTL_HOURS` drives two things at once — the cookie's `Max-Age`
     * and the session row's `expires_at` — and the whole point of one variable
     * for both is that they cannot drift apart. Asserted with a *changed*
     * value, not with the default: a test against 12 hours would also pass if
     * the variable were ignored and the number hard-coded.
     */
    it('applies a changed session lifetime to cookie and row alike', async () => {
      const oneHour = await createTestApp({
        databaseUrl: databaseUrl(),
        env: { SESSION_TTL_HOURS: 1 },
      });
      try {
        const ONE_HOUR_MS = 3_600_000;
        const before = Date.now();
        const response = await request(oneHour.server)
          .post(apiPath('/auth/login'))
          .send({ email: 'admin@example.org', password: PASSWORD });
        const after = Date.now();

        const [header] = setCookies(response);
        expect(header).toContain('Max-Age=3600');

        const token = sessionCookie(response);
        const stored = await oneHour.prisma.session.findUnique({
          where: { tokenHash: digestSessionToken(token) },
        });
        // The row is stamped somewhere inside the request, so the window is
        // the request itself — not a tolerance picked to make it pass.
        const expiresAt = stored?.expiresAt.getTime() ?? 0;
        expect(expiresAt).toBeGreaterThanOrEqual(before + ONE_HOUR_MS);
        expect(expiresAt).toBeLessThanOrEqual(after + ONE_HOUR_MS);
      } finally {
        await oneHour.close();
      }
    });

    it('accepts the address in any casing and with stray whitespace', async () => {
      const response = await login('  ADMIN@Example.org  ', PASSWORD);

      expect(response.status).toBe(200);
    });

    it('scopes a session to the one tenant the person belongs to', async () => {
      const response = await login('admin@example.org', PASSWORD);
      const body = loginResponseSchema.parse(response.body as unknown);

      expect(body.user.activeTenantId).toBe(dach.id);
    });

    /**
     * Two memberships mean the person has to choose. Picking one here would
     * silently prefer an organisation — and picking one for a superadmin without any
     * membership would be the cross-tenant access the requirement forbids.
     */
    it('leaves the tenant unset when there is a choice to make', async () => {
      const several = loginResponseSchema.parse(
        (await login('zwei@example.org', PASSWORD)).body as unknown,
      );
      expect(several.user.memberships).toHaveLength(2);
      expect(several.user.activeTenantId).toBeNull();

      const none = loginResponseSchema.parse(
        (await login('ohne@example.org', PASSWORD)).body as unknown,
      );
      expect(none.user.isSuperadmin).toBe(true);
      expect(none.user.memberships).toStrictEqual([]);
      expect(none.user.activeTenantId).toBeNull();
    });

    it('refuses a wrong password with 401 and without a cookie', async () => {
      const response = await login('admin@example.org', WRONG_PASSWORD);

      expect(response.status).toBe(401);
      expect(setCookies(response)).toStrictEqual([]);
    });

    /**
     * The heart of the requirement: the answer to "wrong password" and to "no such account"
     * must be the same one. Compared byte for byte rather than "both are 401",
     * because a differing message body is exactly how an account enumerator
     * gets its answer.
     */
    it('answers an unknown address byte-identically to a wrong password', async () => {
      const wrongPassword = await login('admin@example.org', WRONG_PASSWORD);
      const unknownAddress = await login('niemand@example.org', PASSWORD);

      expect(unknownAddress.status).toBe(wrongPassword.status);
      expect(unknownAddress.text).toBe(wrongPassword.text);
      expect(stableHeaders(unknownAddress)).toStrictEqual(
        stableHeaders(wrongPassword),
      );
      expect(setCookies(unknownAddress)).toStrictEqual([]);
    });

    it('answers a user without a password hash the same way again', async () => {
      const wrongPassword = await login('admin@example.org', WRONG_PASSWORD);
      const oidcUser = await login('oidc@example.org', PASSWORD);

      expect(oidcUser.status).toBe(wrongPassword.status);
      expect(oidcUser.text).toBe(wrongPassword.text);
      expect(setCookies(oidcUser)).toStrictEqual([]);
    });

    /**
     * Indistinguishable in the body is only half the promise — the clock talks
     * too. Argon2id at 19 MiB costs tens of milliseconds; skipping it for an
     * unknown address would make that request several times faster, which is
     * plenty to enumerate accounts over a network.
     *
     * A deliberately loose bound: the assertion is "the same order of work
     * happened", not a benchmark. Without the dummy verification the unknown
     * address comes back in a small fraction of the time and this fails.
     *
     * The measurement — interleaved pairs, a discarded warm-up pair, the
     * median and the factor — lives in `test/support/timing-comparison.ts`,
     * shared with the password gate's timing proof in
     * `test/public/password-gate.spec.ts`, which is the same argument about
     * two other paths. It carries the measured distribution the bound is
     * derived from, and the reasons for each part; the short version is that
     * this shape flaked three times in one session *and* took CI down on
     * `ac6b208` while it still measured five pairs against a factor of two.
     * A test that goes red for a reason outside its subject teaches everyone
     * to re-run it, and then it protects nothing at all.
     *
     * The clock is the weaker of the two proofs, and it is honest to say so.
     * `src/auth/auth.service.spec.ts` asserts the same invariant
     * deterministically — that the verification runs at all when there is no
     * user — and is the one that would fail unambiguously. This one is now
     * bounded at a factor of three, so it sees a skipped Argon2id (tens of
     * milliseconds against a request of ≈28 ms) and nothing subtler.
     */
    it('spends the same order of time on an unknown address', async () => {
      const measure = async (email: string): Promise<number> => {
        const started = performance.now();
        await login(email, WRONG_PASSWORD);
        return performance.now() - started;
      };

      expectSameOrderOfTime(
        await compareInterleaved(
          () => measure('admin@example.org'),
          () => measure('niemand-sonst@example.org'),
          // Per pair rather than per batch: ten attempts a minute is the
          // limit, and this measurement spends far more than ten.
          resetLoginRateLimit,
        ),
      );
    });

    it('rejects a malformed body with 400 and the same wording', async () => {
      const response = await request(app().server)
        .post(apiPath('/auth/login'))
        .send({ email: 'not-an-address', password: '' });

      expect(response.status).toBe(400);
      expect(response.text).toContain(INVALID_CREDENTIALS_MESSAGE);
      expect(setCookies(response)).toStrictEqual([]);
    });

    it('rejects an empty body instead of failing with a stack trace', async () => {
      const response = await request(app().server).post(apiPath('/auth/login'));

      expect(response.status).toBe(400);
    });

    /** The token in the cookie must exist in the database only as a digest. */
    it('stores the digest of the token, never the token', async () => {
      const token = sessionCookie(await login('admin@example.org', PASSWORD));

      const stored = await app().prisma.session.findUnique({
        where: { tokenHash: digestSessionToken(token) },
      });

      expect(stored).not.toBeNull();
      expect(stored?.revokedAt).toBeNull();
      // The digest is a one-way function of the token; a row that carried the
      // token itself would show up here.
      expect(JSON.stringify(stored)).not.toContain(token);
      expect(Buffer.from(stored?.tokenHash ?? []).toString('hex')).toBe(
        createHash('sha256').update(token, 'utf8').digest('hex'),
      );
    });
  });

  /**
   * The login is the one route here anybody on the internet may call, and each
   * call buys a full Argon2id verification at 19 MiB — including the call with
   * an invented address, because the answer to an unknown address has to cost
   * the same as the answer to a known one. Without a limit that anti-
   * enumeration measure is an amplifier: `@node-rs/argon2` works on the libuv
   * thread pool, four threads shared with the rest of the process.
   */
  describe('rate limit on POST /api/auth/login', () => {
    it('lets the allowed attempts through and refuses the one after', async () => {
      for (let attempt = 0; attempt < LOGIN_RATE_LIMIT.limit; attempt += 1) {
        const allowed = await login('admin@example.org', WRONG_PASSWORD);
        expect(allowed.status).toBe(401);
      }

      const refused = await login('admin@example.org', WRONG_PASSWORD);

      expect(refused.status).toBe(429);
      expect(setCookies(refused)).toStrictEqual([]);
      // A correct password does not get past it either — the limit is about
      // the work the endpoint commissions, not about failed attempts.
      expect((await login('admin@example.org', PASSWORD)).status).toBe(429);
    });

    it('says that it was too much, and nothing about the account', async () => {
      for (let attempt = 0; attempt <= LOGIN_RATE_LIMIT.limit; attempt += 1) {
        await login('admin@example.org', WRONG_PASSWORD);
      }

      const refused = await login('admin@example.org', WRONG_PASSWORD);

      expect(refused.status).toBe(429);
      // Neutral wording: the same root option now serves the
      // public fill-in routes, and a participant submitting a registration too
      // quickly must not be told they tried to *log in* too often
      // (`common/rate-limit.module.ts`).
      expect(refused.text).toContain('Zu viele Anfragen');
      // The library's default message names its own exception class.
      expect(refused.text).not.toContain('ThrottlerException');
      expect(refused.text).not.toContain('admin@example.org');
    });

    /**
     * The reason the guard sits on the route instead of on `APP_GUARD`: a
     * global limiter chosen for a password prompt would also meter the tenant
     * switcher and every feature route of the next wave. Someone whose login
     * attempts ran out must not lose the session they already hold.
     */
    it('does not throttle the session routes along with it', async () => {
      const token = sessionCookie(await login('admin@example.org', PASSWORD));
      for (let attempt = 0; attempt < LOGIN_RATE_LIMIT.limit; attempt += 1) {
        await login('admin@example.org', WRONG_PASSWORD);
      }
      expect((await login('admin@example.org', PASSWORD)).status).toBe(429);

      const session = await request(app().server)
        .get(apiPath('/auth/me'))
        .set('Cookie', cookieHeader(token));
      expect(session.status).toBe(200);

      const logout = await request(app().server)
        .post(apiPath('/auth/logout'))
        .set('Cookie', cookieHeader(token))
        .set(csrfHeader(token));
      expect(logout.status).toBe(204);
    });
  });

  /**
   * Which address the rate limit counts against, once there is a reverse proxy
   * in front of the API (`apps/web/Dockerfile`).
   *
   * Both halves have to hold, and they pull in opposite directions:
   *
   * - Without a configured hop, `X-Forwarded-For` is a caller-controlled
   *   string and must change **nothing**. A limiter that believed it would be
   *   no limiter at all — the eleventh request simply invents a new address.
   * - With the hop configured, the header must be what counts. Otherwise
   *   everyone behind the proxy shares the proxy's bucket, and ten attempts a
   *   minute apply to the whole association at once.
   */
  describe('rate limit behind a reverse proxy', () => {
    /**
     * Documentation range (RFC 5737) — never a real caller. Four distinct
     * addresses because the limiter's counters live for a minute: a test that
     * reused an address would depend on the order the tests ran in.
     */
    const CLIENT_A = '203.0.113.7';
    const CLIENT_B = '203.0.113.8';
    const CLIENT_C = '203.0.113.9';
    const CLIENT_D = '203.0.113.10';

    /** Exhausts the allowance from one claimed address and returns the next. */
    async function exhaustFrom(
      server: TestApp['server'],
      forwardedFor: () => string,
    ): Promise<request.Response> {
      for (let attempt = 0; attempt < LOGIN_RATE_LIMIT.limit; attempt += 1) {
        const allowed = await request(server)
          .post(apiPath('/auth/login'))
          .set('X-Forwarded-For', forwardedFor())
          .send({ email: 'admin@example.org', password: WRONG_PASSWORD });
        expect(allowed.status).toBe(401);
      }
      return request(server)
        .post(apiPath('/auth/login'))
        .set('X-Forwarded-For', forwardedFor())
        .send({ email: 'admin@example.org', password: WRONG_PASSWORD });
    }

    it('ignores X-Forwarded-For when no hop is trusted', async () => {
      // A different invented address on every attempt. With the header
      // believed, each of these would open its own bucket and nothing would
      // ever be refused.
      let caller = 0;
      const refused = await exhaustFrom(app().server, () => {
        caller += 1;
        return `198.51.100.${String(caller)}`;
      });

      expect(refused.status).toBe(429);
    });

    describe('with exactly one hop trusted', () => {
      let proxied: TestApp | undefined;

      function behindProxy(): TestApp {
        if (proxied === undefined) {
          throw new Error('the proxied application was not started');
        }
        return proxied;
      }

      beforeAll(async () => {
        proxied = await createTestApp({
          databaseUrl: databaseUrl(),
          env: { TRUST_PROXY_HOPS: 1 },
        });
      }, SETUP_TIMEOUT_MS);

      afterAll(async () => {
        await proxied?.close();
      }, SETUP_TIMEOUT_MS);

      it('counts each forwarded caller separately', async () => {
        const refused = await exhaustFrom(behindProxy().server, () => CLIENT_A);
        expect(refused.status).toBe(429);

        // The neighbour behind the same proxy is untouched. Without the
        // trusted hop this would be 429 as well — one bucket for everyone.
        const neighbour = await request(behindProxy().server)
          .post(apiPath('/auth/login'))
          .set('X-Forwarded-For', CLIENT_B)
          .send({ email: 'admin@example.org', password: WRONG_PASSWORD });
        expect(neighbour.status).toBe(401);
      });

      /**
       * The reason a hop count is safe to switch on at all: Express counts
       * trusted hops from the **right**, so entries a caller prepends land to
       * the left of the one the proxy wrote and are never read. The front door
       * additionally replaces the header rather than appending to it
       * (`apps/web/docker/default.conf.template`); this test says the API does
       * not depend on that alone.
       */
      it('reads the entry the proxy wrote, not the one the caller prepended', async () => {
        const refused = await exhaustFrom(behindProxy().server, () => CLIENT_C);
        expect(refused.status).toBe(429);

        // Same bucket, despite an invented address in front of it: the
        // rightmost entry is the one the single trusted hop wrote. If the
        // leftmost were read instead, this would be a fresh bucket and a 401 —
        // and the limit would be one header away from being useless.
        const prepended = await request(behindProxy().server)
          .post(apiPath('/auth/login'))
          .set('X-Forwarded-For', `${CLIENT_D}, ${CLIENT_C}`)
          .send({ email: 'admin@example.org', password: WRONG_PASSWORD });
        expect(prepended.status).toBe(429);
      });
    });
  });

  /**
   * Login CSRF — the hole a `SameSite=Lax` cookie does **not** close.
   *
   * `SameSite=Lax` keeps the browser from *sending* the session cookie on a
   * cross-site POST. It says nothing about *setting* one: an attacker page
   * with a hidden `<form method="POST" action="https://app/api/auth/login">`
   * carrying **their own** credentials still gets a `Set-Cookie` back, the
   * browser stores it, and the next top-level navigation hands it over. From
   * then on the victim works, unknowingly, inside the attacker's account and
   * the attacker's Organisation — and everything they enter there is the attacker's.
   *
   * An HTML form cannot choose its content type, so parsing none of the three
   * it may send makes the route unreachable for one. `APP_OPTIONS` in
   * `src/app-setup.ts` carries the full reasoning — including the invariant the
   * last test here pins. Measured before the fix (Nest registers both parsers
   * by default): the urlencoded call answered `200` with a `Set-Cookie`.
   */
  describe('a cross-site HTML form cannot log anyone in', () => {
    /**
     * The attacker's origin, for readability only: the server never looks at
     * `Origin`, and every test below would pass without the header. What does
     * the work is the content type — except in the preflight test at the end,
     * where the origin is the whole point.
     */
    const CROSS_SITE_ORIGIN = 'https://evil.example';

    it('refuses application/x-www-form-urlencoded and sets no cookie', async () => {
      const response = await request(app().server)
        .post(apiPath('/auth/login'))
        .set('Origin', CROSS_SITE_ORIGIN)
        .type('form')
        .send({ email: 'admin@example.org', password: PASSWORD });

      expect(response.status).toBe(400);
      expect(setCookies(response)).toStrictEqual([]);
      // The wording is the one every failed login gets: the answer must not
      // become a probe for "which content types does this route take".
      expect(response.text).toContain(INVALID_CREDENTIALS_MESSAGE);
    });

    /** The second of the three enctypes a form may choose. */
    it('refuses multipart/form-data and sets no cookie', async () => {
      const response = await request(app().server)
        .post(apiPath('/auth/login'))
        .set('Origin', CROSS_SITE_ORIGIN)
        .field('email', 'admin@example.org')
        .field('password', PASSWORD);

      expect(response.status).toBe(400);
      expect(setCookies(response)).toStrictEqual([]);
      expect(response.text).toContain(INVALID_CREDENTIALS_MESSAGE);
    });

    /**
     * The third, and the sneaky one: `enctype="text/plain"` lets a form put
     * arbitrary bytes in the body, so the payload can be valid JSON. Only the
     * content type gives it away, which is exactly why the parser is pinned to
     * `application/json` rather than left to sniff.
     */
    it('refuses text/plain even when the body is valid JSON', async () => {
      const response = await request(app().server)
        .post(apiPath('/auth/login'))
        .set('Origin', CROSS_SITE_ORIGIN)
        .set('Content-Type', 'text/plain')
        .send(
          JSON.stringify({ email: 'admin@example.org', password: PASSWORD }),
        );

      expect(response.status).toBe(400);
      expect(setCookies(response)).toStrictEqual([]);
      expect(response.text).toContain(INVALID_CREDENTIALS_MESSAGE);
    });

    /** The same-origin, JSON-speaking client keeps working. */
    it('still accepts application/json', async () => {
      const response = await login('admin@example.org', PASSWORD);
      const cookies = setCookies(response);

      expect(response.status).toBe(200);
      // Two cookies, and they are named rather than counted: the
      // session token and the CSRF token that belongs to it. A bare count
      // would stay green if the login started setting some third cookie.
      expect(
        cookies.filter((header) =>
          header.startsWith(`${SESSION_COOKIE_NAME}=`),
        ),
      ).toHaveLength(1);
      expect(
        cookies.filter((header) => header.startsWith(`${CSRF_COOKIE_NAME}=`)),
      ).toHaveLength(1);
      expect(cookies).toHaveLength(2);
    });

    /**
     * The CSRF cookie is the one cookie here that is deliberately *not*
     * HttpOnly — the client has to read it to echo it back — and it carries no
     * authority on its own. Asserted because "not HttpOnly" is the kind of
     * attribute a later tidying-up removes for looking wrong.
     */
    it('hands out a readable CSRF cookie whose value is derived from the session', async () => {
      const response = await login('admin@example.org', PASSWORD);
      const token = sessionCookie(response);
      const csrf = setCookies(response).find((header) =>
        header.startsWith(`${CSRF_COOKIE_NAME}=`),
      );

      expect(csrf).toBeDefined();
      expect(csrf).not.toContain('HttpOnly');
      expect(csrf).toContain(`${CSRF_COOKIE_NAME}=${deriveCsrfToken(token)}`);
      // One-way: holding the CSRF token must not hand anyone the session.
      expect(deriveCsrfToken(token)).not.toContain(token);
    });

    /**
     * The invariant the whole defence rests on, and the one no content-type
     * test can see.
     *
     * A cross-origin `fetch` *can* set `Content-Type: application/json` — it
     * just needs the server to answer the preflight first. Nothing calls
     * `enableCors`, so it goes unanswered and the browser never sends the
     * request. That is a load-bearing absence: `app.enableCors({ origin: true,
     * credentials: true })` is the reflex the moment the web app moves to
     * another origin, and it would reopen the hole while all four tests above
     * stayed green. This one goes red instead.
     */
    it('answers no cross-origin preflight — the JSON-only defence needs that', async () => {
      const preflight = await request(app().server)
        .options(apiPath('/auth/login'))
        .set('Origin', CROSS_SITE_ORIGIN)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'content-type');

      expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
      expect(
        preflight.headers['access-control-allow-credentials'],
      ).toBeUndefined();
    });
  });

  /**
   * The payload limit of the one route anybody may call.
   *
   * Its own block rather than a corner of the CSRF one: no form and no foreign
   * origin are involved, this is about the size of a body from anywhere.
   */
  describe('payload limit on POST /api/auth/login', () => {
    it('refuses a body beyond the limit', async () => {
      const response = await request(app().server)
        .post(apiPath('/auth/login'))
        .send({
          email: 'admin@example.org',
          password: 'x'.repeat(JSON_BODY_LIMIT_BYTES),
        });

      expect(response.status).toBe(413);
      expect(setCookies(response)).toStrictEqual([]);
    });

    /**
     * The counter-example, and the reason it is here: the test above scales
     * with `JSON_BODY_LIMIT_BYTES`, so a limit accidentally set to a few bytes
     * would keep it green. A body comfortably under the limit has to reach the
     * handler and get the ordinary 400, not a 413.
     */
    it('lets a body below the limit through to the handler', async () => {
      const response = await request(app().server)
        .post(apiPath('/auth/login'))
        .send({
          email: 'admin@example.org',
          password: 'x'.repeat(Math.floor(JSON_BODY_LIMIT_BYTES * 0.9)),
        });

      expect(response.status).toBe(400);
      expect(response.text).toContain(INVALID_CREDENTIALS_MESSAGE);
    });

    /**
     * The header on the answers the *parser* produces — which is where the
     * global registration used to fail. `next(err)` from body-parser makes
     * Express skip every ordinary middleware behind it, so a `no-store`
     * registered as module middleware never ran for these two. Measured:
     * `413` and `400` both came back with no `Cache-Control` at all.
     */
    it('marks the parser refusals no-store as well', async () => {
      const tooLarge = await request(app().server)
        .post(apiPath('/auth/login'))
        .send({
          email: 'admin@example.org',
          password: 'x'.repeat(JSON_BODY_LIMIT_BYTES),
        });
      expect(tooLarge.status).toBe(413);
      expect(tooLarge.headers['cache-control']).toBe(NO_STORE);

      const brokenJson = await request(app().server)
        .post(apiPath('/auth/login'))
        .set('Content-Type', 'application/json')
        .send('{"email":');
      expect(brokenJson.status).toBe(400);
      expect(brokenJson.headers['cache-control']).toBe(NO_STORE);
    });
  });

  /**
   * `GET /api/auth/me` reports one person's e-mail, name, organisation memberships and
   * permission flags, and Express hangs an `ETag` on it. Without an explicit
   * freshness statement a shared cache — a reverse proxy is on
   * the roadmap — may keep such an answer heuristically and serve it to the
   * next caller. That leak happens outside the application, where no guard can
   * see it.
   */
  describe('no shared cache may keep these answers', () => {
    it('marks the login and the session answer no-store', async () => {
      const loginResponse = await login('admin@example.org', PASSWORD);
      expect(loginResponse.headers['cache-control']).toBe(NO_STORE);

      const token = sessionCookie(loginResponse);
      const me = await request(app().server)
        .get(apiPath('/auth/me'))
        .set('Cookie', cookieHeader(token));

      expect(me.status).toBe(200);
      expect(me.headers['cache-control']).toBe(NO_STORE);
    });

    /**
     * Including the answers a guard produces. An interceptor would run after
     * the guards and leave exactly these without the header; the middleware
     * runs before them.
     */
    it('marks the refusals as well, not only the answers that reach a handler', async () => {
      const failedLogin = await login('admin@example.org', WRONG_PASSWORD);
      expect(failedLogin.status).toBe(401);
      expect(failedLogin.headers['cache-control']).toBe(NO_STORE);

      const withoutSession = await request(app().server).get(
        apiPath('/auth/me'),
      );
      expect(withoutSession.status).toBe(401);
      expect(withoutSession.headers['cache-control']).toBe(NO_STORE);

      const logout = await request(app().server).post(apiPath('/auth/logout'));
      expect(logout.status).toBe(204);
      expect(logout.headers['cache-control']).toBe(NO_STORE);

      for (let attempt = 0; attempt <= LOGIN_RATE_LIMIT.limit; attempt += 1) {
        await login('admin@example.org', WRONG_PASSWORD);
      }
      const throttled = await login('admin@example.org', WRONG_PASSWORD);
      expect(throttled.status).toBe(429);
      expect(throttled.headers['cache-control']).toBe(NO_STORE);
    });
  });

  describe('GET /api/auth/me', () => {
    it('reports the signed-in person for a valid session', async () => {
      const token = sessionCookie(await login('admin@example.org', PASSWORD));

      const response = await request(app().server)
        .get(apiPath('/auth/me'))
        .set('Cookie', cookieHeader(token));

      expect(response.status).toBe(200);
      // The bare user, not a `{ user }` envelope — the shape the shared
      // contract describes and the web client parses.
      const user = sessionUserSchema.parse(response.body as unknown);
      expect(user.email).toBe('admin@example.org');
      expect(user.activeTenantId).toBe(dach.id);
    });

    /**
     * `configureApp()` is what the server and this suite share, and this is the
     * assertion that says so. `X-Powered-By` names the framework on every
     * answer — free reconnaissance for anyone matching a server against a CVE
     * list — and Express sends it unless told otherwise. The header is checked
     * on the *assembled* application, which is the only way to notice that the
     * two bootstraps have drifted apart again.
     */
    it('names no framework in its headers', async () => {
      const token = sessionCookie(await login('admin@example.org', PASSWORD));

      const response = await request(app().server)
        .get(apiPath('/auth/me'))
        .set('Cookie', cookieHeader(token));

      expect(response.headers['x-powered-by']).toBeUndefined();
    });

    /**
     * And the health route through the same assembled application. Its own spec
     * boots `HealthModule` alone — right for a version string, but it means no
     * test would notice if the route stopped being reachable under the global
     * prefix once every module is wired together.
     */
    it('serves health from the assembled application under the prefix', async () => {
      const response = await request(app().server).get(apiPath('/health'));

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ status: 'ok' });
    });

    /**
     * The body is pinned in full rather than searched for a field name: a 401
     * from Nest never carries payload, so "does not contain `memberships`"
     * would have been true whatever the guard did. What is worth asserting is
     * that the refusal says one sentence and nothing else — no stack, no path,
     * no hint which of "no cookie", "unknown", "revoked" or "expired" it was.
     */
    it('answers 401 without a cookie — not an empty user', async () => {
      const response = await request(app().server).get(apiPath('/auth/me'));

      expect(response.status).toBe(401);
      expect(response.body).toStrictEqual({
        statusCode: 401,
        message: NOT_AUTHENTICATED_MESSAGE,
        error: 'Unauthorized',
      });
    });

    /** All four refusals are the same answer — the guard is no oracle. */
    it('answers every kind of invalid session identically', async () => {
      const revoked = sessionCookie(await login('admin@example.org', PASSWORD));
      await app().prisma.session.updateMany({
        where: { tokenHash: digestSessionToken(revoked) },
        data: { revokedAt: new Date() },
      });
      const expired = sessionCookie(await login('admin@example.org', PASSWORD));
      await app().prisma.session.updateMany({
        where: { tokenHash: digestSessionToken(expired) },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      // Sequentially: supertest brings the server up per request, and four of
      // those at once race each other on the same server object.
      const answers: { status: number; text: string }[] = [];
      for (const token of [undefined, 'a'.repeat(43), revoked, expired]) {
        const pending = request(app().server).get(apiPath('/auth/me'));
        const response =
          token === undefined
            ? await pending
            : await pending.set('Cookie', cookieHeader(token));
        answers.push({ status: response.status, text: response.text });
      }

      expect(answers[1]).toStrictEqual(answers[0]);
      expect(answers[2]).toStrictEqual(answers[0]);
      expect(answers[3]).toStrictEqual(answers[0]);
      expect(answers[0]?.status).toBe(401);
    });

    it('answers 401 for a cookie that is not a token', async () => {
      for (const value of ['', 'nonsense', 'a'.repeat(43)]) {
        const response = await request(app().server)
          .get(apiPath('/auth/me'))
          .set('Cookie', cookieHeader(value));

        expect(response.status).toBe(401);
      }
    });

    it('answers 401 for a cookie of a different name', async () => {
      const token = sessionCookie(await login('admin@example.org', PASSWORD));

      const response = await request(app().server)
        .get(apiPath('/auth/me'))
        .set('Cookie', `formsache_session_theme=${token}`);

      expect(response.status).toBe(401);
    });

    it('answers 401 for a session that was revoked in the database', async () => {
      const token = sessionCookie(await login('admin@example.org', PASSWORD));
      await app().prisma.session.updateMany({
        where: { tokenHash: digestSessionToken(token) },
        data: { revokedAt: new Date() },
      });

      const response = await request(app().server)
        .get(apiPath('/auth/me'))
        .set('Cookie', cookieHeader(token));

      expect(response.status).toBe(401);
    });

    it('answers 401 for an expired session', async () => {
      const token = sessionCookie(await login('admin@example.org', PASSWORD));
      await app().prisma.session.updateMany({
        where: { tokenHash: digestSessionToken(token) },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const response = await request(app().server)
        .get(apiPath('/auth/me'))
        .set('Cookie', cookieHeader(token));

      expect(response.status).toBe(401);
    });

    it('records that a session was used', async () => {
      const token = sessionCookie(await login('admin@example.org', PASSWORD));
      const digest = digestSessionToken(token);
      // Backdated past the refresh threshold, which exists so that a burst of
      // requests does not turn into a burst of writes.
      await app().prisma.session.updateMany({
        where: { tokenHash: digest },
        data: { lastSeenAt: new Date(Date.now() - 3_600_000) },
      });

      await request(app().server)
        .get(apiPath('/auth/me'))
        .set('Cookie', cookieHeader(token));

      const session = await app().prisma.session.findUnique({
        where: { tokenHash: digest },
      });
      expect(session?.lastSeenAt.getTime()).toBeGreaterThan(
        Date.now() - 60_000,
      );
    });
  });

  describe('POST /api/auth/logout', () => {
    it('makes the cookie worthless even when it is sent again', async () => {
      const token = sessionCookie(await login('admin@example.org', PASSWORD));

      const before = await request(app().server)
        .get(apiPath('/auth/me'))
        .set('Cookie', cookieHeader(token));
      expect(before.status).toBe(200);

      const logout = await request(app().server)
        .post(apiPath('/auth/logout'))
        .set('Cookie', cookieHeader(token))
        .set(csrfHeader(token));
      expect(logout.status).toBe(204);

      const after = await request(app().server)
        .get(apiPath('/auth/me'))
        .set('Cookie', cookieHeader(token));
      expect(after.status).toBe(401);
    });

    it('revokes the session server-side rather than only in the browser', async () => {
      const token = sessionCookie(await login('admin@example.org', PASSWORD));

      await request(app().server)
        .post(apiPath('/auth/logout'))
        .set('Cookie', cookieHeader(token))
        .set(csrfHeader(token));

      const session = await app().prisma.session.findUnique({
        where: { tokenHash: digestSessionToken(token) },
      });
      expect(session?.revokedAt).not.toBeNull();
    });

    it('clears the cookie with the same attributes it was set with', async () => {
      const token = sessionCookie(await login('admin@example.org', PASSWORD));

      const response = await request(app().server)
        .post(apiPath('/auth/logout'))
        .set('Cookie', cookieHeader(token))
        .set(csrfHeader(token));
      const [header] = setCookies(response);

      expect(header).toContain(`${SESSION_COOKIE_NAME}=;`);
      expect(header).toContain('Max-Age=0');
      expect(header).toContain('Path=/');
      expect(header).toContain('HttpOnly');
      expect(header).toContain('SameSite=Lax');
    });

    /**
     * Both names, always — even though this environment only *accepts* one of
     * them. The other is left-over state rather than a way in: it stays in the
     * browser, is sent along with every request, and turns live again if the
     * deployment ever moves off TLS. The `__Host-` variant has to carry
     * `Secure`, or the browser refuses the clearing cookie as well.
     */
    it('clears both cookie names, not just the one it sets', async () => {
      const token = sessionCookie(await login('admin@example.org', PASSWORD));

      const response = await request(app().server)
        .post(apiPath('/auth/logout'))
        .set('Cookie', cookieHeader(token))
        .set(csrfHeader(token));
      const headers = setCookies(response);

      // Four: both names of the session cookie and both of the
      // CSRF cookie. Leaving either CSRF name behind would present a token on
      // every later request that no longer matches any session.
      expect(headers).toHaveLength(4);
      const host = headers.find((header) =>
        header.startsWith(`${SECURE_SESSION_COOKIE_NAME}=`),
      );
      const bare = headers.find((header) =>
        header.startsWith(`${SESSION_COOKIE_NAME}=`),
      );
      expect(host).toBeDefined();
      expect(bare).toBeDefined();
      expect(host).toContain('Max-Age=0');
      expect(host).toContain('; Secure');
      expect(bare).toContain('Max-Age=0');
      expect(bare).not.toContain('Secure');

      const csrfHost = headers.find((header) =>
        header.startsWith(`${SECURE_CSRF_COOKIE_NAME}=`),
      );
      const csrfBare = headers.find((header) =>
        header.startsWith(`${CSRF_COOKIE_NAME}=`),
      );
      expect(csrfHost).toBeDefined();
      expect(csrfBare).toBeDefined();
      expect(csrfHost).toContain('Max-Age=0');
      expect(csrfBare).toContain('Max-Age=0');
    });

    /** Logging out twice, or without a session, is not an error and not a hint. */
    it('answers 204 without a session and says nothing about it', async () => {
      const anonymous = await request(app().server).post(
        apiPath('/auth/logout'),
      );
      expect(anonymous.status).toBe(204);
      expect(anonymous.text).toBe('');

      // The CSRF token is derived from whatever session token is presented, so
      // a client holding a dead one can still form a well-shaped request — and
      // must still get 204. Answering differently here would be the very
      // "is this token still live?" oracle this test exists to rule out.
      const bogus = await request(app().server)
        .post(apiPath('/auth/logout'))
        .set('Cookie', cookieHeader('not-a-real-token'))
        .set(csrfHeader('not-a-real-token'));
      expect(bogus.status).toBe(204);
      expect(bogus.text).toBe('');
    });

    it('leaves other sessions of the same person alone', async () => {
      const first = sessionCookie(await login('admin@example.org', PASSWORD));
      const second = sessionCookie(await login('admin@example.org', PASSWORD));

      await request(app().server)
        .post(apiPath('/auth/logout'))
        .set('Cookie', cookieHeader(first))
        .set(csrfHeader(first));

      const response = await request(app().server)
        .get(apiPath('/auth/me'))
        .set('Cookie', cookieHeader(second));
      expect(response.status).toBe(200);
    });
  });

  describe('nothing in the clear', () => {
    /**
     * The whole serialised answer — body *and* headers — is searched for the
     * password and for the token. The `Set-Cookie` value is the one place the
     * token is allowed to be, so that header's value is excluded; everything
     * else, including a redirect location or an echoed request header, is
     * fair game.
     */
    it('leaks neither the password nor the token into the login answer', async () => {
      const response = await login('admin@example.org', PASSWORD);
      const token = sessionCookie(response);

      const serialised = JSON.stringify({
        status: response.status,
        body: response.body as unknown,
        text: response.text,
        headers: Object.fromEntries(
          Object.entries(response.headers as Record<string, unknown>).filter(
            ([name]) => name.toLowerCase() !== 'set-cookie',
          ),
        ),
      });

      expect(serialised).not.toContain(PASSWORD);
      expect(serialised).not.toContain(token);
      expect(serialised).not.toContain('argon2');
      expect(serialised).not.toContain('passwordHash');
      expect(serialised).not.toContain('tokenHash');
    });

    it('leaks neither of them into the session answer either', async () => {
      const token = sessionCookie(await login('admin@example.org', PASSWORD));

      const response = await request(app().server)
        .get(apiPath('/auth/me'))
        .set('Cookie', cookieHeader(token));

      const serialised = JSON.stringify({
        body: response.body as unknown,
        headers: response.headers as unknown,
      });
      expect(serialised).not.toContain(PASSWORD);
      expect(serialised).not.toContain(token);
      expect(serialised).not.toContain('argon2');
    });

    /**
     * The other half of the requirement, and the one a body assertion cannot
     * reach: the log. Everything the process writes during a full login,
     * session use and logout is captured — Nest's logger writes through the
     * same two streams — and searched for the plaintext password and the
     * token.
     */
    it('writes neither the password nor the token to stdout or stderr', async () => {
      const captured: string[] = [];
      const record = (chunk: unknown): boolean => {
        captured.push(typeof chunk === 'string' ? chunk : String(chunk));
        return true;
      };
      const stdout = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation(record);
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(record);

      let token: string;
      try {
        const response = await login('admin@example.org', PASSWORD);
        token = sessionCookie(response);
        await request(app().server)
          .get(apiPath('/auth/me'))
          .set('Cookie', cookieHeader(token));
        // The failing paths log more readily than the succeeding ones.
        await login('admin@example.org', WRONG_PASSWORD);
        await login('niemand@example.org', PASSWORD);
        await request(app().server)
          .post(apiPath('/auth/login'))
          .send({ email: 'kaputt', password: PASSWORD });
        await request(app().server)
          .post(apiPath('/auth/logout'))
          .set('Cookie', cookieHeader(token))
          .set(csrfHeader(token));
      } finally {
        stdout.mockRestore();
        stderr.mockRestore();
      }

      const log = captured.join('');
      expect(log).not.toContain(PASSWORD);
      expect(log).not.toContain(WRONG_PASSWORD);
      expect(log).not.toContain(token);
    });
  });
});
