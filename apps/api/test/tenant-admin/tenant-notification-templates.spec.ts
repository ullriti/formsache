import { NOTIFICATION_TEMPLATES_FLOOR } from '@formsache/shared';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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
  createRestrictedMember,
  createTenant,
  createUser,
  type TenantFixture,
} from '../support/fixtures';
import { authedMutation, cookieHeader, openSession } from '../support/http';

/**
 * **The notification templates of an organisation, through its own route**
 * (ADR-0032 — the reversal of ADR-0011 for this one facet).
 *
 * What earlier belonged here through `test/notifications/templates.spec.ts`
 * proved the *read* path a form's notification editor uses
 * (`TenantNotificationTemplatesService.forEditor`). This file proves the
 * *route*: who may read and write an organisation's own templates, that a
 * write is refused on a stale lock, that organisation A can never reach
 * organisation B's row — and, per AGENTS.md's rule that every permission and
 * isolation rule needs the failing case, that the removed superadmin route is
 * genuinely gone and not merely unreachable from the UI.
 */

const PASSWORD = 'test-password';
const TENANT_TEMPLATES = apiPath('/tenant/notification-templates');
const REMOVED_SYSTEM_TEMPLATES = apiPath(
  '/admin/system-settings/notification-templates',
);

const [FIRST_FLOOR_TEMPLATE] = NOTIFICATION_TEMPLATES_FLOOR;
if (FIRST_FLOOR_TEMPLATE === undefined) {
  throw new Error('NOTIFICATION_TEMPLATES_FLOOR is unexpectedly empty');
}
const EDITED_TEMPLATE = {
  ...FIRST_FLOOR_TEMPLATE,
  subject: 'Eigener Betreff dieser Organisation',
};

describe('die Benachrichtigungs-Vorlagen einer Organisation, über die eigene Route', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let alphaAdmin: string;
  let betaAdmin: string;
  let superadmin: string;
  /** Member in alpha **without** `can_manage_settings`. */
  let withoutSettings: string;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });

    alpha = await createTenant(testApp.prisma, 'VORA');
    beta = await createTenant(testApp.prisma, 'VORB');

    const admin = await createUser(testApp.prisma, {
      email: 'admin@vora.example.org',
      password: PASSWORD,
      tenants: [alpha],
    });
    alphaAdmin = await openSession(testApp, admin.id, alpha.id);

    const other = await createUser(testApp.prisma, {
      email: 'admin@vorb.example.org',
      password: PASSWORD,
      tenants: [beta],
    });
    betaAdmin = await openSession(testApp, other.id, beta.id);

    const root = await createUser(testApp.prisma, {
      email: 'root@example.org',
      password: PASSWORD,
      isSuperadmin: true,
    });
    superadmin = await openSession(testApp, root.id, alpha.id);

    // ⚠️ Holds every permission but `can_manage_settings` — the one the
    // proof below is about. A member holding nothing would only prove that
    // *some* guard fires (AGENTS.md).
    const restricted = await createRestrictedMember(testApp.prisma, alpha, {
      email: 'ohne-einstellungen@vora.example.org',
      groupName: 'Ohne Einstellungen',
      permissions: {
        canBuild: true,
        canViewResponses: true,
        canExport: true,
        canManageSettings: false,
        canManageFormSettings: true,
        canManageUsers: true,
      },
    });
    withoutSettings = await openSession(testApp, restricted.id, alpha.id);
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  /**
   * Every test starts from the same, clean „nichts entschieden" baseline —
   * the same discipline `smtp-config.spec.ts` follows for the same reason:
   * a test whose expectation depends on what an earlier test happened to
   * leave behind is a test that breaks when somebody reorders the file.
   */
  beforeEach(async () => {
    await app().prisma.tenant.updateMany({
      where: { id: { in: [alpha.id, beta.id] } },
      data: {
        notificationTemplates: Prisma.DbNull,
        notificationTemplatesRevision: 1,
      },
    });
  });

  function get(session: string): request.Test {
    return request(app().server)
      .get(TENANT_TEMPLATES)
      .set('Cookie', cookieHeader(session));
  }

  function put(session: string, body: unknown): request.Test {
    return request(app().server)
      .put(TENANT_TEMPLATES)
      .set(authedMutation(session))
      .send(body as object);
  }

  it('offers the shipped floor for a row nothing has decided, undecided', async () => {
    // `createTenant` (the fixture) does not seed a document — see its own
    // comment — so this measures the *route's* fallback rather than the real
    // creation path (`admin/tenants.spec.ts` covers that one, seeded through
    // `AdminRepository.createTenant`).
    const response = await get(alphaAdmin);
    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({
      templates: NOTIFICATION_TEMPLATES_FLOOR,
      decided: false,
      lock: 1,
    });
  });

  it('stores a whole document under its own lock and reads it back', async () => {
    const first = await get(alphaAdmin);
    const written = await put(alphaAdmin, {
      templates: [EDITED_TEMPLATE],
      lock: (first.body as { lock: number }).lock,
    });

    expect(written.status).toBe(200);
    expect(written.body).toMatchObject({
      templates: [EDITED_TEMPLATE],
      decided: true,
    });

    const read = await get(alphaAdmin);
    expect(read.body).toStrictEqual(written.body);
  });

  it('weist eine veraltete Sperre mit 409 ab, statt still zu überschreiben', async () => {
    const first = await get(alphaAdmin);
    const lock = (first.body as { lock: number }).lock;

    const ok = await put(alphaAdmin, { templates: [EDITED_TEMPLATE], lock });
    expect(ok.status).toBe(200);

    // The same, now-stale lock a second time.
    const stale = await put(alphaAdmin, { templates: [], lock });
    expect(stale.status).toBe(409);

    // And the row really is untouched by the refused write.
    expect((await get(alphaAdmin)).body).toMatchObject({
      templates: [EDITED_TEMPLATE],
    });
  });

  // ---------------------------------------------------------------------
  // Who may do this
  // ---------------------------------------------------------------------

  it('weist ein Mitglied ohne „Einstellungen verwalten" ab — lesend wie schreibend', async () => {
    const read = await get(withoutSettings);
    expect(read.status).toBe(403);

    const write = await put(withoutSettings, {
      templates: [EDITED_TEMPLATE],
      lock: 1,
    });
    expect(write.status).toBe(403);
  });

  it('weist eine Anfrage ohne Sitzung ab', async () => {
    const response = await request(app().server).get(TENANT_TEMPLATES);
    expect(response.status).toBe(401);
  });

  /**
   * A superadmin has no group membership permission of their own — the
   * boundary is `can_manage_settings` on a **membership**, and being
   * superadmin grants none. Signed in with an active scope on alpha
   * nonetheless, so this measures the permission and not the tenant scope.
   */
  it('lässt auch einen Superadministrator ohne das Recht nicht durch', async () => {
    const response = await get(superadmin);
    expect(response.status).toBe(403);
  });

  // ---------------------------------------------------------------------
  // The organisation boundary
  // ---------------------------------------------------------------------

  /**
   * There is no organisation in the path: the route always names the
   * *active* one. So the isolation is not a refusal but an impossibility —
   * the case worth writing is that alpha's write never reaches beta.
   */
  it('schreibt nur in die eigene Organisation und nie in eine fremde', async () => {
    const first = await get(alphaAdmin);
    await put(alphaAdmin, {
      templates: [EDITED_TEMPLATE],
      lock: (first.body as { lock: number }).lock,
    }).expect(200);

    const betaRead = await get(betaAdmin);
    expect(betaRead.status).toBe(200);
    expect(betaRead.body).toStrictEqual({
      templates: NOTIFICATION_TEMPLATES_FLOOR,
      decided: false,
      lock: 1,
    });
  });

  // ---------------------------------------------------------------------
  // The old superadmin route
  // ---------------------------------------------------------------------

  /**
   * **The full move, checked from the outside.** ADR-0032 removed the route,
   * its controller method, its service and its counter — this is not an
   * override layer over a surviving system default. A 404 here is the proof
   * that held for the arm ADR-0023 removed from the mail block
   * (`smtp-config.spec.ts`): the route answers as if it had never been
   * declared, superadmin session or not.
   */
  it('die alte, installationsweite Route gibt es nicht mehr — auch nicht für einen Superadministrator', async () => {
    const read = await request(app().server)
      .get(REMOVED_SYSTEM_TEMPLATES)
      .set('Cookie', cookieHeader(superadmin));
    expect(read.status).toBe(404);

    const write = await request(app().server)
      .put(REMOVED_SYSTEM_TEMPLATES)
      .set(authedMutation(superadmin))
      .send({ templates: [], lock: 1 });
    expect(write.status).toBe(404);
  });
});
