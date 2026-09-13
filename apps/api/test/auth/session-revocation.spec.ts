import { parseSessionRevocation } from '@formsache/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import {
  apiPath,
  createTestApp,
  type TestApp,
} from '../support/create-test-app';
import { authedMutation, cookieHeader, openSession } from '../support/http';
import {
  createRestrictedMember,
  createTenant,
  createUser,
  type TenantFixture,
} from '../support/fixtures';

const PASSWORD = 'correct horse battery staple';

/**
 * **Revoking sessions (a review finding).**
 *
 * The finding was a gap, not a weakness: a leaked password was **not**
 * revocable with the means of the application. Changing the password did not
 * help — a running session carries its own token —, and all that was left was
 * to wait until it expires: up to 720 hours.
 *
 * Two ways, and both are measured here from the forbidden side:
 *
 * 1. **Self-service** (`POST /api/auth/sessions/revoke-others`) — ends all
 *    other sessions of the signed-in person, **never** other people's.
 * 2. **Enforced** (`POST /api/tenant/users/:id/revoke-sessions`) — demands
 *    `canManageUsers` and ends at the organisation boundary.
 */
describe('Sitzungen widerrufen', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  /** The person whose sessions are ended in almost every case. */
  let member: { id: string; email: string };
  let alphaAdmin: string;
  let betaAdmin: string;
  /** Everything except `canManageUsers` — the "must not" half. */
  let restOnlySession: string;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });

    alpha = await createTenant(testApp.prisma, 'REVA');
    beta = await createTenant(testApp.prisma, 'REVB');

    const alphaUser = await createUser(testApp.prisma, {
      email: 'revoke-alpha-admin@example.org',
      password: PASSWORD,
      tenants: [alpha],
    });
    const betaUser = await createUser(testApp.prisma, {
      email: 'revoke-beta-admin@example.org',
      password: PASSWORD,
      tenants: [beta],
    });
    const memberUser = await createUser(testApp.prisma, {
      email: 'revoke-member@example.org',
      password: PASSWORD,
      tenants: [alpha],
    });
    member = { id: memberUser.id, email: memberUser.email };

    alphaAdmin = await openSession(testApp, alphaUser.id, alpha.id);
    betaAdmin = await openSession(testApp, betaUser.id, beta.id);

    const restOnly = await createRestrictedMember(testApp.prisma, alpha, {
      email: 'revoke-rest-only@example.org',
      groupName: 'Alles außer Nutzer',
      permissions: {
        canBuild: true,
        canViewResponses: true,
        canExport: true,
        canManageSettings: true,
        canManageFormSettings: true,
        canManageUsers: false,
      },
    });
    restOnlySession = await openSession(testApp, restOnly.id, alpha.id);
  }, 180_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  /** Does the `me` route still answer with 200 — so is this session alive? */
  async function alive(token: string): Promise<boolean> {
    const response = await request(app().server)
      .get(apiPath('/auth/me'))
      .set('Cookie', cookieHeader(token));
    return response.status === 200;
  }

  function revokeOthers(token: string): request.Test {
    return request(app().server)
      .post(apiPath('/auth/sessions/revoke-others'))
      .set(authedMutation(token));
  }

  function revokeSessionsOf(token: string, userId: string): request.Test {
    return request(app().server)
      .post(apiPath(`/tenant/users/${userId}/revoke-sessions`))
      .set(authedMutation(token));
  }

  describe('Selbstbedienung: „alle anderen beenden"', () => {
    it('beendet die anderen Sitzungen und lässt die eigene leben', async () => {
      const first = await openSession(testApp, member.id, alpha.id);
      const second = await openSession(testApp, member.id, alpha.id);
      const third = await openSession(testApp, member.id, alpha.id);

      const response = await revokeOthers(third).expect(201);
      expect(parseSessionRevocation(response.body).revoked).toBe(2);

      // One's own lives on — otherwise the confirmation could not be read.
      expect(await alive(third)).toBe(true);
      expect(await alive(first)).toBe(false);
      expect(await alive(second)).toBe(false);
    });

    /**
     * The case that a version reading "all sessions of this account" would
     * take along without anything turning red: a **foreign** session.
     */
    it('rührt die Sitzung einer anderen Person nicht an', async () => {
      const mine = await openSession(testApp, member.id, alpha.id);
      const before = await alive(alphaAdmin);
      expect(before).toBe(true);

      await revokeOthers(mine).expect(201);

      expect(await alive(alphaAdmin)).toBe(true);
    });

    /**
     * "0 ended" is the statement someone waits for who suspects a break-in —
     * so it has to be reachable and not merely theoretical.
     *
     * The case makes its starting state **itself**: a first call clears away
     * what earlier cases of this file have left behind. The earlier version
     * relied on nobody having left a session open beforehand — it was red, and
     * rightly so.
     */
    it('antwortet 0, wenn es keine zweite Sitzung gibt', async () => {
      const only = await openSession(testApp, member.id, alpha.id);
      await revokeOthers(only).expect(201);

      const response = await revokeOthers(only).expect(201);
      expect(parseSessionRevocation(response.body).revoked).toBe(0);
    });

    it('verlangt eine Anmeldung', async () => {
      await request(app().server)
        .post(apiPath('/auth/sessions/revoke-others'))
        .expect(401);
    });
  });

  describe('erzwungen: der Weg für Verwaltende', () => {
    it('beendet jede Sitzung des Mitglieds, auch die zuletzt benutzte', async () => {
      const one = await openSession(testApp, member.id, alpha.id);
      const two = await openSession(testApp, member.id, alpha.id);

      const response = await revokeSessionsOf(alphaAdmin, member.id).expect(
        201,
      );
      expect(
        parseSessionRevocation(response.body).revoked,
      ).toBeGreaterThanOrEqual(2);

      expect(await alive(one)).toBe(false);
      expect(await alive(two)).toBe(false);
    });

    /** The permission half: without `canManageUsers` the action does not exist. */
    it('weist eine Rolle ohne `canManageUsers` mit 403 ab', async () => {
      const victim = await openSession(testApp, member.id, alpha.id);

      await revokeSessionsOf(restOnlySession, member.id).expect(403);

      // And the session lives on — the refusal was not a half action.
      expect(await alive(victim)).toBe(true);
    });

    /**
     * The isolation half: an organisation admin reaches no member of another
     * organisation — and the answer is **404**, not 403, so that it does not
     * become an oracle about which identifiers exist on the installation.
     */
    it('antwortet über die Organisation-Grenze hinweg mit 404 und beendet nichts', async () => {
      const victim = await openSession(testApp, member.id, alpha.id);

      await revokeSessionsOf(betaAdmin, member.id).expect(404);

      expect(await alive(victim)).toBe(true);
    });

    it('antwortet für eine erfundene Kennung mit demselben 404', async () => {
      await revokeSessionsOf(
        alphaAdmin,
        '00000000-0000-4000-8000-000000000000',
      ).expect(404);
    });

    /** A malformed identifier must not produce a server error. */
    it('antwortet für eine missgestaltete Kennung mit 404 statt 500', async () => {
      await revokeSessionsOf(alphaAdmin, 'kein-uuid').expect(404);
    });
  });
});
