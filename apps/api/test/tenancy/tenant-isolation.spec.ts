import { groupSummarySchema, sessionUserSchema } from '@formsache/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { digestSessionToken } from '../../src/auth/session-token';
import { NO_STORE } from '../../src/common/no-store';
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
  createGroup,
  createTenant,
  createUser,
  type TenantFixture,
} from '../support/fixtures';
import { cookieHeader, csrfHeader, openSession } from '../support/http';

/**
 * the requirements against a real PostgreSQL database.
 *
 * The whole file is built around the *forbidden* case. A suite that shows a
 * member of Organisation A reading Organisation A's groups proves nothing about isolation — it
 * would stay green against an endpoint with no tenant binding at all. So every
 * allowed case here exists only to give a forbidden one something to be
 * compared against, and the assertions look at the answer's **content**, not
 * merely at its status: "404 with the row in the body" is the failure mode a
 * status check misses.
 *
 * Two tenants, ALPHA and BETA, each with groups of their own, and users whose
 * memberships differ — that is the minimum for a boundary to exist at all.
 */

const SETUP_TIMEOUT_MS = 180_000;

const PASSWORD = 'korrektes-pferd-batterie-heftklammer';

/** A uuid of the right shape that belongs to nothing. */
const ABSENT_UUID = '01919c3f-0000-7000-8000-000000000000';

describe('tenant isolation (the forbidden case)', () => {
  let database: TestDatabase | undefined;
  let testApp: TestApp | undefined;

  let alpha: TenantFixture;
  let beta: TenantFixture;
  /** The group of BETA that must never surface in an answer to an ALPHA user. */
  let betaOnlyGroup: { id: string; name: string };
  let alphaOnlyGroup: { id: string; name: string };

  /** Member of ALPHA only — the person every forbidden case is asked from. */
  let alphaUser: { id: string };
  /** Member of BETA only — proves the rows ALPHA cannot see do exist. */
  let betaUser: { id: string };
  /** Member of both — the only one who may legitimately switch. */
  let beideUser: { id: string };
  /** Superadmin without any membership: a session that has no scope to have. */
  let ohneUser: { id: string };

  function app(): TestApp {
    if (testApp === undefined) {
      throw new Error('the application was not started');
    }
    return testApp;
  }

  /**
   * Everything that identifies BETA. An answer to an ALPHA user may contain
   * none of it — not the ids, not the names, not the Kurzname.
   */
  function betaFingerprints(): string[] {
    return [beta.id, beta.adminGroupId, betaOnlyGroup.id, betaOnlyGroup.name];
  }

  /** Body *and* headers, so a leak through a header is caught as well. */
  function serialise(response: request.Response): string {
    return JSON.stringify({
      body: response.body as unknown,
      text: response.text,
      headers: response.headers as unknown,
    });
  }

  function expectNoTraceOfBeta(response: request.Response): void {
    const serialised = serialise(response);
    for (const fingerprint of betaFingerprints()) {
      expect(serialised).not.toContain(fingerprint);
    }
  }

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });

    alpha = await createTenant(app().prisma, 'ALPHA');
    beta = await createTenant(app().prisma, 'BETA');

    // A second group per tenant, so a tenant-bound list can be told apart from
    // a list that returns the only row in the table.
    alphaOnlyGroup = await createGroup(app().prisma, alpha, {
      name: 'alpha-redaktion',
      color: '#123456',
      rank: 60,
    });
    betaOnlyGroup = await createGroup(app().prisma, beta, {
      name: 'beta-redaktion',
      color: '#654321',
      rank: 60,
    });

    alphaUser = await createUser(app().prisma, {
      email: 'alpha@example.org',
      password: PASSWORD,
      tenants: [alpha],
    });
    betaUser = await createUser(app().prisma, {
      email: 'beta@example.org',
      password: PASSWORD,
      tenants: [beta],
    });
    beideUser = await createUser(app().prisma, {
      email: 'beide@example.org',
      password: PASSWORD,
      tenants: [alpha, beta],
    });
    ohneUser = await createUser(app().prisma, {
      email: 'ohne@example.org',
      password: PASSWORD,
      isSuperadmin: true,
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await testApp?.close();
    await database?.release();
  }, SETUP_TIMEOUT_MS);

  const groups = (token: string): request.Test =>
    request(app().server)
      .get(apiPath('/groups'))
      .set('Cookie', cookieHeader(token));

  const group = (token: string, id: string): request.Test =>
    request(app().server)
      .get(apiPath(`/groups/${id}`))
      .set('Cookie', cookieHeader(token));

  describe('GET /api/groups', () => {
    it('answers 401 without a session — not an empty list', async () => {
      const response = await request(app().server).get(apiPath('/groups'));

      expect(response.status).toBe(401);
      // An empty array would be the dangerous kind of "safe": it looks like a
      // valid answer and hides that nobody was authenticated.
      expect(response.text).not.toContain('[]');
    });

    it('lists the groups of the signed-in tenant', async () => {
      const token = await openSession(app(), alphaUser.id, alpha.id);

      const response = await groups(token);

      expect(response.status).toBe(200);
      const listed = z
        .array(groupSummarySchema)
        .parse(response.body as unknown);
      expect(listed.map((entry) => entry.id).sort()).toStrictEqual(
        [alpha.adminGroupId, alphaOnlyGroup.id].sort(),
      );
    });

    /**
     * The forbidden half of the test above. Without it, an endpoint that
     * simply returned *every* group would pass the previous assertion the
     * moment ALPHA happened to own them all.
     */
    it('contains no group of the other tenant, anywhere in the answer', async () => {
      const token = await openSession(app(), alphaUser.id, alpha.id);

      const response = await groups(token);

      expectNoTraceOfBeta(response);
    });

    /**
     * Proves the boundary is a boundary and not an empty database: the rows
     * ALPHA cannot see are readable by the organisation that owns them.
     */
    it('shows the other tenant its own groups', async () => {
      const token = await openSession(app(), betaUser.id, beta.id);

      const response = await groups(token);

      expect(response.status).toBe(200);
      const listed = z
        .array(groupSummarySchema)
        .parse(response.body as unknown);
      expect(listed.map((entry) => entry.id).sort()).toStrictEqual(
        [beta.adminGroupId, betaOnlyGroup.id].sort(),
      );
    });

    /**
     * Signed in, but no membership anywhere — a superadmin who has not picked
     * an organisation. 403, because the session is valid; and no data, because
     * "no tenant scope" must never be read as "all tenants".
     */
    it('answers 403 for a session without a tenant scope', async () => {
      const token = await openSession(app(), ohneUser.id, null);

      const response = await groups(token);

      expect(response.status).toBe(403);
      expectNoTraceOfBeta(response);
      expect(serialise(response)).not.toContain(alphaOnlyGroup.id);
    });
  });

  describe('GET /api/groups/:id', () => {
    it('answers 401 without a session', async () => {
      const response = await request(app().server).get(
        apiPath(`/groups/${alpha.adminGroupId}`),
      );

      expect(response.status).toBe(401);
    });

    it('returns a group of the own tenant', async () => {
      const token = await openSession(app(), alphaUser.id, alpha.id);

      const response = await group(token, alphaOnlyGroup.id);

      expect(response.status).toBe(200);
      const body = groupSummarySchema.parse(response.body as unknown);
      expect(body.id).toBe(alphaOnlyGroup.id);
      expect(body.name).toBe('alpha-redaktion');
    });

    /** A read across the tenant boundary must leak nothing of the tenant it touches. */
    it('answers 404 for a group of the other tenant and leaks nothing of it', async () => {
      const token = await openSession(app(), alphaUser.id, alpha.id);

      for (const id of [beta.adminGroupId, betaOnlyGroup.id]) {
        const response = await group(token, id);

        expect(response.status).toBe(404);
        // The status alone would still pass if the row rode along in the body.
        expectNoTraceOfBeta(response);
        expect(response.text).not.toContain('color');
        expect(response.text).not.toContain('rank');
      }
    });

    /**
     * 404 rather than 403 is only worth anything if the two 404s are the same
     * one: a reply that differed between "exists elsewhere" and "does not
     * exist" would confirm the id and turn every leaked id into a probe.
     */
    it('answers a foreign group byte-identically to an unknown id', async () => {
      const token = await openSession(app(), alphaUser.id, alpha.id);

      const foreign = await group(token, betaOnlyGroup.id);
      const unknown = await group(token, ABSENT_UUID);

      expect(unknown.status).toBe(foreign.status);
      expect(unknown.text).toBe(foreign.text);
    });

    it('answers a malformed id the same way instead of failing with a 500', async () => {
      const token = await openSession(app(), alphaUser.id, alpha.id);

      const malformed = await group(token, 'nicht-mal-eine-uuid');
      const unknown = await group(token, ABSENT_UUID);

      expect(malformed.status).toBe(404);
      expect(malformed.text).toBe(unknown.text);
    });

    it('answers 403 for a session without a tenant scope', async () => {
      const token = await openSession(app(), ohneUser.id, null);

      const response = await group(token, alphaOnlyGroup.id);

      expect(response.status).toBe(403);
      expect(serialise(response)).not.toContain('alpha-redaktion');
    });
  });

  describe('PUT /api/session/tenant', () => {
    // `object`, not `unknown`: supertest serialises what it is given, and the
    // malformed cases below are wrong *values* inside a well-formed JSON body,
    // which is what a real client sends.
    const switchTo = (token: string, body: object): request.Test =>
      request(app().server)
        .put(apiPath('/session/tenant'))
        .set('Cookie', cookieHeader(token))
        // Mutating and behind a session, so it carries the CSRF token.
        .set(csrfHeader(token))
        .send(body);

    it('answers 401 without a session', async () => {
      const response = await request(app().server)
        .put(apiPath('/session/tenant'))
        .send({ tenantId: alpha.id });

      expect(response.status).toBe(401);
    });

    it('moves a session into a tenant the person belongs to', async () => {
      const token = await openSession(app(), beideUser.id, alpha.id);

      const response = await switchTo(token, { tenantId: beta.id });

      expect(response.status).toBe(200);
      const user = sessionUserSchema.parse(response.body as unknown);
      expect(user.activeTenantId).toBe(beta.id);

      // And the scope really moved: the answer is not a claim about the
      // session, it is the session.
      const listed = z
        .array(groupSummarySchema)
        .parse((await groups(token)).body as unknown);
      expect(listed.map((entry) => entry.id).sort()).toStrictEqual(
        [beta.adminGroupId, betaOnlyGroup.id].sort(),
      );
    });

    /**
     * The forbidden switch — and the assertion that matters is the one *after*
     * it: a rejected switch that still wrote the column would leave the next
     * request scoped to an organisation the person has no membership in.
     */
    it('refuses a tenant without membership and leaves the scope where it was', async () => {
      const token = await openSession(app(), alphaUser.id, alpha.id);

      const response = await switchTo(token, { tenantId: beta.id });

      expect(response.status).toBe(404);
      expectNoTraceOfBeta(response);

      const me = await request(app().server)
        .get(apiPath('/auth/me'))
        .set('Cookie', cookieHeader(token));
      expect(sessionUserSchema.parse(me.body as unknown).activeTenantId).toBe(
        alpha.id,
      );

      const listed = z
        .array(groupSummarySchema)
        .parse((await groups(token)).body as unknown);
      expect(listed.map((entry) => entry.id).sort()).toStrictEqual(
        [alpha.adminGroupId, alphaOnlyGroup.id].sort(),
      );
    });

    it('does not reveal whether the refused tenant exists at all', async () => {
      const token = await openSession(app(), alphaUser.id, alpha.id);

      const foreign = await switchTo(token, { tenantId: beta.id });
      const unknown = await switchTo(token, { tenantId: ABSENT_UUID });

      expect(unknown.status).toBe(foreign.status);
      expect(unknown.text).toBe(foreign.text);
    });

    it('answers a malformed body the same way', async () => {
      const token = await openSession(app(), alphaUser.id, alpha.id);

      const malformed = await switchTo(token, { tenantId: 'ALPHA' });
      const unknown = await switchTo(token, { tenantId: ABSENT_UUID });

      expect(malformed.status).toBe(404);
      expect(malformed.text).toBe(unknown.text);
    });

    it('stores the tenant on the session row, not only in the answer', async () => {
      const token = await openSession(app(), beideUser.id, alpha.id);

      await switchTo(token, { tenantId: alpha.id });

      const session = await app().prisma.session.findUnique({
        where: { tokenHash: digestSessionToken(token) },
        select: { activeTenantId: true },
      });
      expect(session?.activeTenantId).toBe(alpha.id);
    });
  });

  /**
   * The trap the worklog names: `session.active_tenant_id` is a stored value,
   * and a stored value is a claim. These two tests are the ones that close it —
   * they write the column past every check the application makes, exactly as a
   * stale row, a botched migration or a compromised database would.
   */
  describe('a session row that claims a tenant it has no membership for', () => {
    it('grants no access to that tenant', async () => {
      const token = await openSession(app(), alphaUser.id, alpha.id);

      // Straight into the table. No endpoint can produce this row — which is
      // the point: the guard may not rely on that being true.
      await app().prisma.session.updateMany({
        where: { tokenHash: digestSessionToken(token) },
        data: { activeTenantId: beta.id },
      });

      const list = await groups(token);
      expect(list.status).toBe(403);
      expectNoTraceOfBeta(list);

      // 403, not 404: the guard refuses before the handler ever sees the id.
      // That is the stronger answer, because it does not depend on the id at
      // all — the same reply comes back for a BETA group, for an ALPHA group
      // and for an id that exists nowhere, so the endpoint says nothing about
      // any of them.
      const single = await group(token, betaOnlyGroup.id);
      expect(single.status).toBe(403);
      expectNoTraceOfBeta(single);

      const own = await group(token, alphaOnlyGroup.id);
      const nothing = await group(token, ABSENT_UUID);
      expect(own.text).toBe(single.text);
      expect(nothing.text).toBe(single.text);
    });

    it('is reported as no tenant at all, not as the claimed one', async () => {
      const token = await openSession(app(), alphaUser.id, alpha.id);
      await app().prisma.session.updateMany({
        where: { tokenHash: digestSessionToken(token) },
        data: { activeTenantId: beta.id },
      });

      const response = await request(app().server)
        .get(apiPath('/auth/me'))
        .set('Cookie', cookieHeader(token));

      expect(response.status).toBe(200);
      const user = sessionUserSchema.parse(response.body as unknown);
      // Null, not BETA: null means *no* scope, never "all tenants".
      expect(user.activeTenantId).toBeNull();
      expectNoTraceOfBeta(response);
    });
  });

  /**
   * The review gate's open finding: memberships are revoked while sessions
   * live on. Until this was fixed, `GET /api/auth/me` kept reporting the old
   * Organisation next to an empty membership list.
   */
  describe('a membership revoked while the session lives', () => {
    it('takes the tenant scope with it', async () => {
      const revoked = await createUser(app().prisma, {
        email: 'entzug@example.org',
        password: PASSWORD,
        tenants: [alpha],
      });
      const token = await openSession(app(), revoked.id, alpha.id);

      // Still inside: this is what the assertions below are a change from.
      expect((await groups(token)).status).toBe(200);

      await app().prisma.membership.deleteMany({
        where: { userId: revoked.id, tenantId: alpha.id },
      });

      const me = await request(app().server)
        .get(apiPath('/auth/me'))
        .set('Cookie', cookieHeader(token));
      expect(me.status).toBe(200);
      const user = sessionUserSchema.parse(me.body as unknown);
      expect(user.memberships).toStrictEqual([]);
      // The session row still says ALPHA. The answer must not.
      expect(user.activeTenantId).toBeNull();

      const list = await groups(token);
      expect(list.status).toBe(403);
      expect(serialise(list)).not.toContain(alphaOnlyGroup.id);

      const single = await group(token, alphaOnlyGroup.id);
      expect(single.status).toBe(403);
      expect(serialise(single)).not.toContain('alpha-redaktion');
    });
  });

  /**
   * The isolation these routes enforce can be undone one hop upstream: a
   * shared cache that keeps ALPHA's group list and hands it to BETA does so
   * without any request reaching a guard, so every test above stays green
   * while it happens. `src/common/no-store.ts` carries the RFC references and
   * the measurements; these are the assertions that keep them true.
   */
  describe('no shared cache may keep these answers either', () => {
    it('marks the group routes no-store', async () => {
      const token = await openSession(app(), alphaUser.id, alpha.id);

      const list = await groups(token);
      expect(list.status).toBe(200);
      expect(list.headers['cache-control']).toBe(NO_STORE);

      const single = await group(token, alphaOnlyGroup.id);
      expect(single.status).toBe(200);
      expect(single.headers['cache-control']).toBe(NO_STORE);
    });

    it('marks the tenant switcher no-store', async () => {
      const token = await openSession(app(), beideUser.id, alpha.id);

      const response = await request(app().server)
        .put(apiPath('/session/tenant'))
        .set('Cookie', cookieHeader(token))
        .set(csrfHeader(token))
        .send({ tenantId: beta.id });

      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe(NO_STORE);
    });

    /**
     * The refusals too — they are the answers a guard produces, which is
     * exactly what an interceptor would have missed.
     */
    it('marks the refusals of the guard chain as well', async () => {
      const anonymous = await request(app().server).get(apiPath('/groups'));
      expect(anonymous.status).toBe(401);
      expect(anonymous.headers['cache-control']).toBe(NO_STORE);

      const scopeless = await groups(
        await openSession(app(), ohneUser.id, null),
      );
      expect(scopeless.status).toBe(403);
      expect(scopeless.headers['cache-control']).toBe(NO_STORE);
    });

    /**
     * And the route nobody would have thought to register it on. `/api/health`
     * is deliberately not exempt; asserting it is what turns "it applies
     * everywhere" from an intention into a fact — a per-controller
     * registration cannot make this pass.
     */
    it('covers even the routes outside the guard chain', async () => {
      const response = await request(app().server).get(apiPath('/health'));

      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe(NO_STORE);
    });
  });

  /**
   * Deleting an organisation must not sign anybody out of the *other* Organisationen — the
   * `activeTenant` relation in `prisma/schema.prisma` states why `SET NULL`
   * rather than `Cascade`. This is the behaviour, against the real foreign key
   * built by the committed migration.
   */
  describe('deleting a tenant (Session.activeTenant onDelete)', () => {
    it('clears the scope of the sessions inside it instead of deleting them', async () => {
      const doomed = await createTenant(app().prisma, 'GAMMA');
      const visitor = await createUser(app().prisma, {
        email: 'besucher@example.org',
        password: PASSWORD,
        isSuperadmin: true,
      });
      const inside = await openSession(app(), visitor.id, doomed.id);
      // A second session of the same person, in no tenant at all — it must be
      // just as untouched, and it is what a cascade would have taken along.
      const elsewhere = await openSession(app(), visitor.id, null);

      await app().prisma.tenant.delete({ where: { id: doomed.id } });

      const rows = await app().prisma.session.findMany({
        where: { userId: visitor.id },
      });
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.activeTenantId).toBeNull();
        expect(row.revokedAt).toBeNull();
      }

      // And the session is still usable — 200 with no scope, not the 401 a
      // deleted row would produce.
      for (const token of [inside, elsewhere]) {
        const me = await request(app().server)
          .get(apiPath('/auth/me'))
          .set('Cookie', cookieHeader(token));
        expect(me.status).toBe(200);
        expect(sessionUserSchema.parse(me.body as unknown).activeTenantId).toBe(
          null,
        );
      }

      // No scope still means no access — "the tenant is gone" must not become
      // "everything is visible".
      expect((await groups(inside)).status).toBe(403);

      // The only test in this file that adds rows the other tests can see, so
      // it is also the only one that has to take them away again. Sessions go
      // with the user (`onDelete: Cascade` on `Session.user`).
      await app().prisma.user.delete({ where: { id: visitor.id } });
    });
  });
});
