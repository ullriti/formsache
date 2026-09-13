import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { MetadataScanner, ModulesContainer } from '@nestjs/core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CSRF_EXEMPT, CSRF_FAILED_MESSAGE } from '../../src/auth/csrf.guard';
import {
  CSRF_COOKIE_NAME,
  csrfTokenMatches,
  deriveCsrfToken,
} from '../../src/auth/csrf';
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
 * The requirement — CSRF protection for the mutating routes behind a session,
 * the open point ADR-0005 has carried.
 *
 * The heart of this file is `mutatingRoutes()`. The requirement is explicit that
 * the proof must **enumerate the routes from Nest itself**, not from a list
 * kept by hand: a hand-kept list protects exactly the routes someone
 * remembered, and the route that gets forgotten is by definition the one no
 * test would have named. Every mutating handler the application registers is
 * discovered here and asserted against — a route added is covered by
 * this file on the day it is written, or it turns this file red.
 */

const PASSWORD = 'test-password';

/** A route as the application registers it. */
interface DiscoveredRoute {
  readonly method: string;
  /** Path under the global prefix, with parameters left as `:id`. */
  readonly path: string;
  readonly exempt: boolean;
  readonly controller: string;
  readonly handler: string;
}

const METHOD_NAMES: Partial<Record<RequestMethod, string>> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.PATCH]: 'PATCH',
};

const MUTATING = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

/**
 * Reads a `@Controller()` / `@Get()` path off a target.
 *
 * `Reflect.getMetadata` is typed `any`, so the value is narrowed rather than
 * stringified: Nest also accepts arrays and RegExps as paths, and `String()`
 * would turn one of those into `[object Object]` and silently test a route
 * that does not exist.
 */
function metadataPath(target: object): string {
  const value: unknown = Reflect.getMetadata(PATH_METADATA, target);
  return typeof value === 'string' ? value : '';
}

function join(base: string, path: string): string {
  const segments = [base, path]
    .map((part) => part.replace(/^\/+|\/+$/gu, ''))
    .filter((part) => part !== '');
  return `/${segments.join('/')}`;
}

/**
 * Every route the application registers, read out of Nest's own metadata.
 *
 * `ModulesContainer` is the compiled module graph itself and is always
 * present, so this sees precisely the controllers that exist at runtime —
 * including any a future module adds without touching this file.
 * `DiscoveryService` would read the same graph but requires `DiscoveryModule`
 * in the application, and adding a module to production wiring for a test's
 * convenience is the wrong direction.
 */
function discoverRoutes(app: TestApp): DiscoveredRoute[] {
  const modules = app.app.get(ModulesContainer);
  const scanner = new MetadataScanner();
  const routes: DiscoveredRoute[] = [];

  const controllers = [...modules.values()].flatMap((module) => [
    ...module.controllers.values(),
  ]);

  for (const wrapper of controllers) {
    const metatype: unknown = wrapper.metatype;
    if (typeof metatype !== 'function') {
      continue;
    }
    const basePath = metadataPath(metatype);
    const prototype: object = metatype.prototype as object;
    const classExempt = Reflect.getMetadata(CSRF_EXEMPT, metatype) === true;

    for (const name of scanner.getAllMethodNames(prototype)) {
      const handler = (prototype as Record<string, unknown>)[name];
      if (typeof handler !== 'function') {
        continue;
      }
      const requestMethod = Reflect.getMetadata(METHOD_METADATA, handler) as
        RequestMethod | undefined;
      if (requestMethod === undefined) {
        continue;
      }
      const methodPath = metadataPath(handler);

      routes.push({
        method: METHOD_NAMES[requestMethod] ?? String(requestMethod),
        path: join(basePath, methodPath),
        exempt:
          classExempt || Reflect.getMetadata(CSRF_EXEMPT, handler) === true,
        controller: metatype.name,
        handler: name,
      });
    }
  }

  return routes;
}

/**
 * Issues a request with the discovered method.
 *
 * Spelled out as a switch rather than indexing the agent by a lowercased
 * method name: the index would need a cast to satisfy the type checker, and a
 * cast is how a method the agent does not have becomes a runtime error inside
 * a loop that is meant to be reporting on routes.
 */
function sendMutating(app: TestApp, method: string, url: string): request.Test {
  const agent = request(app.server);
  switch (method) {
    case 'POST':
      return agent.post(url);
    case 'PUT':
      return agent.put(url);
    case 'DELETE':
      return agent.delete(url);
    case 'PATCH':
      return agent.patch(url);
    default:
      throw new Error(`no request helper for method ${method}`);
  }
}

/** Fills route parameters with values of the right shape. */
function concrete(path: string): string {
  return path.replace(/:[A-Za-z]+/gu, '019fe000-0000-7000-8000-000000000001');
}

describe('CSRF protection', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  let tenant: TenantFixture;
  let session: string;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });

    tenant = await createTenant(testApp.prisma, 'CSRF');
    const user = await createUser(testApp.prisma, {
      email: 'csrf@example.org',
      password: PASSWORD,
      tenants: [tenant],
    });
    session = await openSession(testApp, user.id, tenant.id);
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  describe('coverage of the whole route table', () => {
    it('finds the routes the application actually registers', () => {
      const routes = discoverRoutes(app());

      // A sanity floor: if discovery silently returned nothing, every
      // assertion below would pass vacuously — which is the failure mode a
      // coverage test has to rule out first.
      expect(routes.length).toBeGreaterThan(5);
      expect(
        routes.filter((route) => MUTATING.has(route.method)).length,
      ).toBeGreaterThan(2);
    });

    /**
     * The assertion the requirement is about: **every** mutating route behind a
     * session refuses a request without the token.
     *
     * Driven by discovery, so it grows with the application. A new
     * `POST /api/notifications` is tested by this line the moment it
     * exists.
     */
    it('refuses every discovered mutating route that lacks the token', async () => {
      const routes = discoverRoutes(app()).filter(
        (route) => MUTATING.has(route.method) && !route.exempt,
      );

      for (const route of routes) {
        const url = apiPath(concrete(route.path));
        const response = await sendMutating(app(), route.method, url)
          .set('Cookie', cookieHeader(session))
          .send({});

        expect(
          response.status,
          `${route.method} ${url} (${route.controller}.${route.handler}) was not refused`,
        ).toBe(403);
        expect(response.text).toContain(CSRF_FAILED_MESSAGE);
      }
    });

    /**
     * The exemptions, named rather than counted.
     *
     * This list is the whole trust boundary of the mechanism, so it is written
     * out: adding an exemption turns this test red and forces the author to
     * state, in a diff, why the route has no session to ride on. It did
     * exactly that when the public fill-in route arrived.
     *
     * Every entry has the same justification, and it is the only one
     * that counts: **the route authenticates nobody.** The login has no session
     * yet, and neither public route ever has one — a forged submission from
     * another site is one the participant could equally have made by visiting
     * the form, so there is no privilege to abuse.
     *
     * The password gate is the third, and it is worth stating why it
     * is not a new kind of case. A cross-site page can only offer a word its
     * author already knows, and the proof it would get back goes to the browser
     * that asked — the attacker's script cannot read a cross-origin response
     * body, and there is no cookie set that would ride along afterwards. What a
     * CSRF token would defend here is a session that does not exist.
     */
    it('exempts only the routes that have no session to ride on', () => {
      const exempt = discoverRoutes(app())
        .filter((route) => MUTATING.has(route.method) && route.exempt)
        .map((route) => `${route.method} ${route.path}`)
        .sort();

      expect(exempt).toStrictEqual([
        /*
         * The requirement — **einen Entwurf löschen** (DSGVO Art. 17, review
         * finding). It adds nothing to the `PUT` two entries down: the
         * token *is* the authorisation, so a forged cross-site request can only
         * destroy a draft whose address the forger already holds — and holding
         * it already allows overwriting the answers with an empty document.
         */
        'DELETE /public/drafts/:token',
        'POST /auth/login',
        /*
         * **„Passwort vergessen"** (ADR-0020) — the two most recent
         * exemptions, and they are the same case as the login above: **the
         * route authenticates nobody.** There is no session a cross-site
         * request could ride on, so there is no privilege to
         * abuse.
         *
         * What a cross-site page could do with the request step is a
         * mail to an address its author knows anyway — and the
         * limit per address (three per hour, `password-reset-rate-limit.ts`)
         * binds that too. Redeeming demands a token that stands only in a
         * stranger's mailbox; whoever has it needs no foreign browser
         * for it.
         *
         * Both routes answer without any information and set no cookie that
         * would ride along afterwards — the answer goes to the browser that
         * asked, and a cross-site page cannot read it under `SameSite`.
         */
        'POST /auth/password-reset/confirm',
        'POST /auth/password-reset/request',
        /*
         * The requirement — an upload into a **resumed draft** (a finding
         * of the acceptance run). It inherits both justifications of the two
         * upload routes below and adds nothing: no session to ride on, the
         * token *is* the authorisation, and the same `application/octet-stream`
         * demand makes the route grammatically unreachable for a foreign HTML
         * form.
         */
        'POST /public/drafts/:token/files',
        'POST /public/forms/:slug/access',
        /*
         * The requirement — *Zwischenspeichern*, the first save.
         * It adds no new kind of case: the route authenticates nobody, so there
         * is no session for a forged request to ride on, and a half-filled form
         * a stranger's page could store is one the participant could equally
         * have stored by pressing the button. The address comes back to the
         * browser that asked, which under `SameSite` rules the attacker's page
         * cannot read — and it opens nothing the attacker did not already have,
         * because it is a draft *they* just caused to exist. On a protected form
         * it also takes a valid access proof, like every other request there.
         */
        'POST /public/forms/:slug/drafts',
        /*
         * The requirement — the public upload (ADR-0014 no. 14), and the fifth
         * entry rather than a new kind of case: it authenticates nobody, so
         * there is no session for a forged request to ride on, and an upload a
         * stranger's page could trigger is one the participant could equally
         * have made by visiting the form. It writes a row that belongs to
         * nobody until an answer claims it (no. 13) and that the purge removes
         * after a day (no. 15).
         *
         * What guards it instead is stated where it is built: the route demands
         * `application/octet-stream` and answers 415 to everything else, which
         * makes it **grammatically unreachable for a foreign HTML form** — the
         * same property `bodyParser: false` buys for the login. A cross-origin
         * `fetch` could set that type, but only after a preflight nothing here
         * answers (`app-setup.ts`: no CORS anywhere, pinned in `auth.spec.ts`).
         * On a protected form it also takes a valid access proof, like every
         * other request on that form.
         */
        'POST /public/forms/:slug/files',
        'POST /public/forms/:slug/responses',
        /*
         * The requirement — the same upload as `POST /public/forms/:slug/files`
         * two entries up, through the **edit token** instead of the slug
         * (ADR-0014 no. 13, last paragraph): a correction has to be able to
         * replace a scan, and on a password-protected form the token holder has
         * no access word to offer (the confirmation mail carries none). It
         * inherits both justifications above and adds nothing new — no session
         * to ride on, the token *is* the authorisation, and the same
         * `application/octet-stream` demand keeps a foreign HTML form out.
         */
        'POST /public/responses/:token/files',
        /*
         * **The first commissioning** (ADR-0022) — and the case that stands
         * closest to the login instead of being a new one: **there is not even
         * an account here** on whose session a cross-site
         * request could ride. It is the only entry of this list
         * that stops existing: as soon as the installation has a user row,
         * the route answers 404.
         *
         * What a cross-site page could do with it is the serious case that
         * this list otherwise does not know — a superadministrator with a
         * stranger's password. Only, a CSRF token would protect nothing
         * against that: there is no cookie out of which the attacker would
         * have to read one, and whoever knows the address of an installation
         * that has not been set up can call it themselves without the detour
         * through a foreign window. What actually protects here
         * is the condition „zero rows in `user`" — and that the route, like
         * the login, accepts only `application/json` (`app-setup.ts`), which
         * makes it grammatically unreachable for a foreign HTML form.
         */
        'POST /setup',
        /*
         * The requirement — continuing a draft, and the same addition the edit
         * route makes one entry down: holding the token *is* the authorisation, so
         * a forged cross-site request can only overwrite a draft whose address
         * the forger already has. A CSRF token would defend nothing.
         */
        'PUT /public/drafts/:token',
        /*
         * The requirement — the edit route, and the same justification as the
         * three above with one addition worth stating: holding the token *is*
         * the authorisation here. A forged cross-site request can therefore
         * only change an answer whose token the forger already has, which is
         * not a privilege borrowed from a session — it is the capability
         * itself, and a CSRF token would defend nothing.
         */
        'PUT /public/responses/:token',
      ]);
    });
  });

  describe('the check itself', () => {
    it('accepts a request carrying the token derived from its session', async () => {
      const response = await request(app().server)
        .put(apiPath('/session/tenant'))
        .set(authedMutation(session))
        .send({ tenantId: tenant.id });

      expect(response.status).toBe(200);
    });

    it('refuses a token that belongs to a different session', async () => {
      const other = await createUser(app().prisma, {
        email: 'csrf-other@example.org',
        password: PASSWORD,
        tenants: [tenant],
      });
      const otherSession = await openSession(app(), other.id, tenant.id);

      const response = await request(app().server)
        .put(apiPath('/session/tenant'))
        .set('Cookie', cookieHeader(session))
        // A token that is perfectly valid — for somebody else.
        .set({ 'x-csrf-token': deriveCsrfToken(otherSession) })
        .send({ tenantId: tenant.id });

      expect(response.status).toBe(403);
    });

    /**
     * The property that separates this from plain double submit: the expected
     * value is derived from the **session** cookie, never read from the CSRF
     * cookie. A subdomain that tosses in a matching pair therefore gains
     * nothing — the pair agrees with itself and with no session.
     */
    it('ignores a CSRF cookie that agrees with the header but not with the session', async () => {
      const attacker = 'ein-vom-angreifer-gewaehlter-wert';

      const response = await request(app().server)
        .put(apiPath('/session/tenant'))
        .set(
          'Cookie',
          `${cookieHeader(session)}; ${CSRF_COOKIE_NAME}=${attacker}`,
        )
        .set({ 'x-csrf-token': attacker })
        .send({ tenantId: tenant.id });

      expect(response.status).toBe(403);
    });

    it('lets safe methods through untouched', async () => {
      const response = await request(app().server)
        .get(apiPath('/auth/me'))
        .set('Cookie', cookieHeader(session));

      expect(response.status).toBe(200);
    });

    /**
     * Without a session there is nothing to protect, and answering 403 here
     * would replace the honest 401 with a misleading one. The request still
     * gets no further than `SessionGuard`.
     */
    it('does not turn "not logged in" into a CSRF failure', async () => {
      const response = await request(app().server)
        .put(apiPath('/session/tenant'))
        .send({ tenantId: tenant.id });

      expect(response.status).toBe(401);
    });
  });

  describe('the derivation', () => {
    it('is stable, one-way and different per session', () => {
      const a = deriveCsrfToken('token-a');
      const b = deriveCsrfToken('token-b');

      expect(deriveCsrfToken('token-a')).toBe(a);
      expect(a).not.toBe(b);
      expect(a).not.toContain('token-a');
      expect(csrfTokenMatches(a, a)).toBe(true);
      expect(csrfTokenMatches(a, b)).toBe(false);
    });

    it('compares values of different lengths without throwing', () => {
      // `timingSafeEqual` throws on a length mismatch, and a thrown error here
      // would surface as a 500 on every malformed header.
      expect(csrfTokenMatches('kurz', deriveCsrfToken('x'))).toBe(false);
      expect(csrfTokenMatches('', deriveCsrfToken('x'))).toBe(false);
    });
  });
});
