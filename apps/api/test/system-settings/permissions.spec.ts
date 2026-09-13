import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { digestSessionToken } from '../../src/auth/session-token';
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
 * **System settings are a superadmin matter** .
 *
 * `user.is_superadmin` has existed and decided nothing; these routes
 * are the first that ask. Every guarantee here is asserted through the case
 * that must **fail** (`CONTRIBUTING.md`) — a suite of allowed halves would stay
 * green under a guard that refuses nobody.
 *
 * ## The trap is in the fixture, not in the code
 *
 * The refused caller is `admin` **in the active Organisation**: the system group, all
 * five permissions, `can_manage_settings` included. A refused user who happens
 * to hold nothing would only show that *some* guard fires — the same fixture
 * mistake that once let „ohne beide → 403" pass without proving anything.
 * `createTenant`/`createUser` put a person in exactly that group, and the first
 * test asserts the five flags rather than trusting the fixture, so a fixture
 * that quietly stopped granting them cannot make the rest of this file
 * meaningless.
 *
 * ## Negative probe, measured while writing this file
 *
 * - Replacing `SuperadminGuard` with `RequireAllPermissions('canManageSettings')`
 *   (plus the tenant scope that decorator needs): **both** 403 tests red — the
 *   organisation's admin is let in.
 * - Removing the guard from the controller: the same two red, plus „ohne
 *   Mitgliedschaft" stays green, which is what tells the two apart.
 * - Reading `isSuperadmin` off the *membership* instead of the user: „ein
 *   Tenant-Wechsel ändert nichts" red.
 *
 * ## What is deliberately **not** here
 *
 * That superadmin opens no *domain* route is proved below in one place and one
 * place only — it belongs to this requirement („kein Generalschlüssel") and
 * nowhere else. It is asserted against the organisation-facing settings routes, because
 * those are the ones whose subject matter is closest to this route's: the same
 * documents, one layer up.
 */

const PASSWORD = 'test-password';
/**
 * The route the guard is measured on.
 *
 * Until 2026-08-14 these were the *form defaults* of the installation; they do
 * not exist any more (ADR-0011, continuation; review finding 9). Measurement
 * now happens on the mail route — the same chain of guards, the same
 * controller, the same line.
 */
const MAIL = apiPath('/admin/system-settings/mail');

describe('the superadmin guard', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  let alpha: TenantFixture;
  let beta: TenantFixture;

  /** `admin` in Organisation alpha — all five group permissions, no superadmin flag. */
  let tenantAdmin: string;
  /** Superadmin **and** member of alpha, as a real installation's first one is. */
  let superadmin: string;
  /** Superadmin with **no** membership anywhere — a fresh installation. */
  let outsider: string;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });

    alpha = await createTenant(testApp.prisma, 'SUPA');
    beta = await createTenant(testApp.prisma, 'SUPB');

    const admin = await createUser(testApp.prisma, {
      email: 'Organisation-admin@example.org',
      password: PASSWORD,
      tenants: [alpha],
    });
    tenantAdmin = await openSession(testApp, admin.id, alpha.id);

    const root = await createUser(testApp.prisma, {
      email: 'superadmin@example.org',
      password: PASSWORD,
      tenants: [alpha],
      isSuperadmin: true,
    });
    superadmin = await openSession(testApp, root.id, alpha.id);

    const lonely = await createUser(testApp.prisma, {
      email: 'superadmin-ohne-organisation@example.org',
      password: PASSWORD,
      isSuperadmin: true,
    });
    // No active tenant: there is no membership to make one out of.
    outsider = await openSession(testApp, lonely.id, null);
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  afterEach(async () => {
    // The row is installation-wide; a test that left one behind would decide
    // what „nichts entschieden" means for every test after it.
    await app().prisma.systemSetting.deleteMany({});
  });

  function read(session: string): Promise<request.Response> {
    return request(app().server).get(MAIL).set('Cookie', cookieHeader(session));
  }

  function write(session: string, lock = 1): Promise<request.Response> {
    return request(app().server).put(MAIL).set(authedMutation(session)).send({
      smtp: null,
      publicBaseUrl: 'https://guard-probe.example.org',
      replyTo: null,
      opsAlertEmail: null,
      lock,
    });
  }

  function rowCount(): Promise<number> {
    return app().prisma.systemSetting.count();
  }

  // ═════════════════════════════════════════════════════════════════════════
  // The fixture itself — so the pairs below measure the boundary they claim
  // ═════════════════════════════════════════════════════════════════════════

  it('gives the refused caller every group permission there is', async () => {
    const me = await request(app().server)
      .get(apiPath('/auth/me'))
      .set('Cookie', cookieHeader(tenantAdmin));

    expect(me.status).toBe(200);
    const body = me.body as {
      isSuperadmin: boolean;
      activeTenantId: string;
      memberships: {
        group: { name: string; isSystem: boolean };
        permissions: Record<string, boolean>;
      }[];
    };
    expect(body.isSuperadmin).toBe(false);
    expect(body.activeTenantId).toBe(alpha.id);
    const [membership] = body.memberships;
    expect(membership?.group).toMatchObject({ name: 'admin', isSystem: true });
    expect(membership?.permissions).toEqual({
      canBuild: true,
      canViewResponses: true,
      canExport: true,
      canManageSettings: true,
      canManageFormSettings: true,
      canManageUsers: true,
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // A pair per route — reading *and* writing
  // ═════════════════════════════════════════════════════════════════════════

  const AI_PATH = apiPath('/admin/system-settings/ai');

  describe('GET /api/admin/system-settings/mail', () => {
    it('refuses the admin of the active Organisation with 403', async () => {
      const refused = await read(tenantAdmin);

      expect(refused.status).toBe(403);
      // The read is as privileged as the write: it hands out the document the
      // write replaces. Nothing of it may travel in the refusal.
      expect(JSON.stringify(refused.body)).not.toContain('publicBaseUrl');
    });

    it('answers a superadmin with 200', async () => {
      const allowed = await read(superadmin);

      expect(allowed.status).toBe(200);
      expect(allowed.body).toMatchObject({
        values: { smtp: null, publicBaseUrl: null },
      });
    });
  });

  describe('PUT /api/admin/system-settings/mail', () => {
    it('refuses the admin of the active Organisation with 403 and writes nothing', async () => {
      expect(await rowCount()).toBe(0);

      const refused = await write(tenantAdmin);

      expect(refused.status).toBe(403);
      // Checked with a raw query rather than by looking at the answer: a
      // refused write that still wrote would look identical from outside.
      expect(await rowCount()).toBe(0);
    });

    it('lets a superadmin through', async () => {
      const allowed = await write(superadmin);

      expect(allowed.status).toBe(200);
      expect(allowed.body).toMatchObject({
        values: { publicBaseUrl: 'https://guard-probe.example.org' },
      });
      expect(await rowCount()).toBe(1);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // The property hangs on the **user**, not on the active Organisation
  // ═════════════════════════════════════════════════════════════════════════

  describe('the flag belongs to the person', () => {
    it('survives a tenant switch — and belongs to no organisation at all', async () => {
      const membered = await createUser(app().prisma, {
        email: 'superadmin-zwei-buende@example.org',
        password: PASSWORD,
        tenants: [alpha, beta],
        isSuperadmin: true,
      });
      const session = await openSession(app(), membered.id, alpha.id);

      expect((await read(session)).status).toBe(200);

      const switched = await request(app().server)
        .put(apiPath('/session/tenant'))
        .set(authedMutation(session))
        .send({ tenantId: beta.id });
      expect(switched.status).toBe(200);

      // Same person, other organisation, same answer. Were the flag resolved from the
      // membership — the shape a „Superadmin-Gruppe" would have — this is where
      // it would change.
      expect((await read(session)).status).toBe(200);
    });

    it('opens the route for a superadmin who is a member of nothing', async () => {
      // The state of every fresh installation: somebody has to be able to set
      // the standards before the first organisation exists. A route that asked for a
      // tenant scope would lock them out of it.
      const allowed = await read(outsider);

      expect(allowed.status).toBe(200);
    });

    it('writes the row for somebody who is a member of nothing', async () => {
      // There once was more to check here: the row carried `updated_by`,
      // because a superadmin wrote the form defaults of all organisations.
      // Both are gone (ADR-0011, continuation 2026-08-14) — what remains is
      // that the guard hangs on the person and not on a membership.
      const written = await write(outsider);

      expect(written.status).toBe(200);
      expect(await rowCount()).toBe(1);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // The flag is resolved per request — nothing about it is frozen at login
  // ═════════════════════════════════════════════════════════════════════════

  describe('a withdrawn flag takes effect at once', () => {
    /**
     * Code-wise this holds by construction: `SessionService.authenticate` loads
     * the `user` row on **every** request and `toSessionUser` reads
     * `isSuperadmin` off it, so nothing is frozen into the session. Nothing
     * held it there, though — the group permissions and the membership have
     * their „ohne neue Anmeldung" proofs, this flag had none. It is the test
     * *and* the negative probe: lifting `isSuperadmin` into a session column or
     * a cache later turns this red instead of turning it into a superadmin
     * whose demotion never arrives.
     */
    it('refuses the next request after the flag is taken away', async () => {
      const demoted = await createUser(app().prisma, {
        email: 'kurzzeitig-superadmin@example.org',
        password: PASSWORD,
        tenants: [alpha],
        isSuperadmin: true,
      });
      const session = await openSession(app(), demoted.id, alpha.id);
      expect((await read(session)).status).toBe(200);

      // The session stays untouched — only the flag goes.
      await app().prisma.user.update({
        where: { id: demoted.id },
        data: { isSuperadmin: false },
      });

      expect((await read(session)).status).toBe(403);
      const refusedWrite = await write(session);
      expect(refusedWrite.status).toBe(403);
      expect(await rowCount()).toBe(0);
    });
  });

  describe('a session that is no longer one', () => {
    /**
     * ⚠️ **Its negative probe is weak, and that is worth writing down.**
     * Removing `SessionGuard` from the controller leaves this test **green**
     * (measured): `SuperadminGuard` refuses a request with no `auth` on it with
     * the very same 401. The two guards fail closed into each other, which is
     * the right redundancy to have and the wrong one to mistake for a proof.
     * What this test does hold is that the two new routes are behind the
     * session lifecycle at all — a route added later without either guard would
     * answer 200 here.
     */
    it('answers 401 on both routes, revoked or expired, and writes nothing', async () => {
      const cases: { name: string; token: string }[] = [];
      for (const [name, data] of [
        ['revoked', { revokedAt: new Date() }],
        ['expired', { expiresAt: new Date(Date.now() - 1000) }],
      ] as const) {
        const user = await createUser(app().prisma, {
          email: `${name}-superadmin@example.org`,
          password: PASSWORD,
          isSuperadmin: true,
        });
        const token = await openSession(app(), user.id, null);
        await app().prisma.session.updateMany({
          where: { tokenHash: digestSessionToken(token) },
          data,
        });
        cases.push({ name, token });
      }

      for (const { token } of cases) {
        expect((await read(token)).status).toBe(401);
        // 401 from the session guard, not 403 from the superadmin one: the
        // caller is not refused for who they are, they are not a caller.
        expect((await write(token)).status).toBe(401);
      }
      // Raw query: a refused write that still wrote would look identical from
      // outside.
      expect(await rowCount()).toBe(0);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Superadmin is a fourth way in, not a master key
  // ═════════════════════════════════════════════════════════════════════════

  describe('it opens no door in an organisation', () => {
    /**
     * The half of the requirement that is easy to forget, and the one that would fail
     * silently: widening `TenantScopeGuard` „weil Superadmin ja alles darf"
     * leaves no trace in a query and would be found by no test that only ever
     * checks whether an administrator can administrate.
     */
    it('reaches no organisation-facing route without a membership', async () => {
      for (const path of [
        '/tenant/form-defaults',
        '/forms',
        '/groups',
        '/mail-log',
      ]) {
        const refused = await request(app().server)
          .get(apiPath(path))
          .set('Cookie', cookieHeader(outsider));

        // 403, from the tenant scope: the caller is signed in and has no active
        // Organisation. What matters is that it is not 200 — the superadmin flag adds
        // nothing to the chain of `CONTRIBUTING.md`.
        expect(refused.status).toBe(403);
      }
    });

    it('cannot write another organisation’s standards by being superadmin', async () => {
      // A superadmin who *is* a member of alpha, with beta as the target: the
      // routes of the organisation carry no tenant in their path, so the only
      // Organisation reachable is the active one. Switching would be the honest way in
      // — and switching needs a membership, which is the boundary itself.
      const before = await app().prisma.tenant.findUniqueOrThrow({
        where: { id: beta.id },
        select: { formDefaults: true, formDefaultsRevision: true },
      });

      const refused = await request(app().server)
        .put(apiPath('/session/tenant'))
        .set(authedMutation(superadmin))
        .send({ tenantId: beta.id });
      // **404**, byte-identical to an unknown id — the switch refuses a
      // Organisation no membership backs, and being superadmin changes nothing about
      // that. This is the sentence „kein Generalschlüssel" as a status code.
      expect(refused.status).toBe(404);

      const after = await app().prisma.tenant.findUniqueOrThrow({
        where: { id: beta.id },
        select: { formDefaults: true, formDefaultsRevision: true },
      });
      expect(after).toEqual(before);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // The guard is not the only thing on this route
  // ═════════════════════════════════════════════════════════════════════════

  it('refuses a write without the CSRF header, superadmin or not', async () => {
    const refused = await request(app().server)
      .put(MAIL)
      // Cookie only — no `authedMutation`, so no token.
      .set('Cookie', cookieHeader(superadmin))
      .send({
        smtp: null,
        publicBaseUrl: 'https://guard-probe.example.org',
        replyTo: null,
        opsAlertEmail: null,
        lock: 1,
      });

    expect(refused.status).toBe(403);
    expect(await rowCount()).toBe(0);
  });

  it('refuses an unauthenticated caller with 401, on both routes', async () => {
    const read = await request(app().server).get(MAIL);
    expect(read.status).toBe(401);

    const written = await request(app().server).put(MAIL).send({
      smtp: null,
      publicBaseUrl: null,
      replyTo: null,
      opsAlertEmail: null,
      lock: 1,
    });
    // 403 from the CSRF guard or 401 from the session guard — either refuses,
    // and which comes first is a wiring detail. What must not happen is a row.
    expect([401, 403]).toContain(written.status);
    expect(await rowCount()).toBe(0);
  });

  /**
   * **The third pair of this page — and it was missing** (a review finding).
   *
   * Behind `GET`/`PUT /admin/system-settings/ai` lie the provider key and a
   * cost lever. The guards were set correctly
   * (`SessionGuard, SuperadminGuard`), but **it was not proved**: no case saw
   * an unauthorised caller fail. CONTRIBUTING.md demands exactly that for every
   * permission and isolation rule — a test that only checks the allowed case
   * proves nothing.
   *
   * The refused caller is the same `tenantAdmin` as above: an administrator
   * **with all five group permissions** of their organisation. That is the
   * right trap — whoever got through here would get through with proper rights.
   */
  describe('das KI-Paar der Systemeinstellungen', () => {
    function readAi(session: string): Promise<request.Response> {
      return request(app().server)
        .get(AI_PATH)
        .set('Cookie', cookieHeader(session));
    }

    function writeAi(session: string): Promise<request.Response> {
      return request(app().server)
        .put(AI_PATH)
        .set(authedMutation(session))
        .send({
          enabled: true,
          provider: 'anthropic',
          model: null,
          region: 'eu',
          apiKey: 'ZZKANARIE-GUARD-PROBE',
          lock: 1,
        });
    }

    it('weist die Organisation-Admin auf dem Lesepfad mit 403 ab', async () => {
      expect((await readAi(tenantAdmin)).status).toBe(403);
    });

    it('weist ihn auf dem Schreibpfad ab — und schreibt nichts', async () => {
      expect(await rowCount()).toBe(0);

      expect((await writeAi(tenantAdmin)).status).toBe(403);

      // ⚠️ **Not only the answer, the row as well.** Exactly this
      // shape was real once: 204 instead of 403, **and the column was written**.
      expect(await rowCount()).toBe(0);
    });

    it('lässt den Superadmin durch — sonst wiese der Wächter alle ab', async () => {
      expect((await readAi(superadmin)).status).toBe(200);
    });
  });
});
