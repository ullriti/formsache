import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  NOTIFICATION_TEMPLATES_FLOOR,
  NOTIFICATION_TEMPLATE_LIMIT,
  type NotificationTemplate,
} from '@formsache/shared';

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
 * **The write path of the notification templates** (ADR-0022, continuation
 * 2026-08-18).
 *
 * The column `system_setting.notification_templates` was read up to this point
 * and written by nothing; `system-settings.module.ts` held on to the condition
 * under which that may stop — whoever builds the route brings the counter
 * along. What is measured is therefore both: that the route has the guard that
 * every other system setting has, **and** that the lock really locks.
 *
 * ## What is proven here through the **forbidden** case
 *
 * The refused caller is `admin` **in the active organisation** — the
 * system group with all group permissions, `can_manage_settings` included.
 * A caller without permissions would only show that *some* guard sounds; it is
 * precisely this fixture mistake that has once before in this project made a
 * 403 look green that proved nothing.
 *
 * ## Negative checks, measured while writing
 *
 * - `SuperadminGuard` removed from the controller: the two 403 cases go red.
 * - In the repository, `notificationTemplatesRevision` taken out of the
 *   `where`: the 409 case is let through green, hence red.
 * - `systemNotificationTemplatesSchema` in the request schema swapped for a
 *   bare `z.array(...)`: limit and identifier uniqueness go red.
 */

const PASSWORD = 'test-password';
const TEMPLATES = apiPath('/admin/system-settings/notification-templates');

/** A valid template — terse, because what is checked is what happens to it. */
function template(id: string): NotificationTemplate {
  return {
    id,
    name: `Vorlage ${id}`,
    description: 'Eine Vorlage dieser Installation.',
    triggers: ['submit'],
    format: 'html',
    subject: 'Betreff',
    body: 'Rumpf',
    toSubmitter: false,
  };
}

describe('the superadmin notification-template routes', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  let alpha: TenantFixture;

  /** `admin` in alpha — all group permissions, no superadmin flag. */
  let tenantAdmin: string;
  let superadmin: string;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });

    alpha = await createTenant(testApp.prisma, 'NTPL');

    const admin = await createUser(testApp.prisma, {
      email: 'ntpl-organisation-admin@example.org',
      password: PASSWORD,
      tenants: [alpha],
    });
    tenantAdmin = await openSession(testApp, admin.id, alpha.id);

    const root = await createUser(testApp.prisma, {
      email: 'ntpl-superadmin@example.org',
      password: PASSWORD,
      tenants: [alpha],
      isSuperadmin: true,
    });
    superadmin = await openSession(testApp, root.id, alpha.id);
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  afterEach(async () => {
    // The row applies to the whole installation; a test that left one
    // standing would decide for every test after it what „nichts
    // entschieden" means.
    await app().prisma.systemSetting.deleteMany({});
  });

  function read(session: string): Promise<request.Response> {
    return request(app().server)
      .get(TEMPLATES)
      .set('Cookie', cookieHeader(session));
  }

  function write(
    session: string,
    templates: readonly NotificationTemplate[],
    lock: number,
  ): Promise<request.Response> {
    return request(app().server)
      .put(TEMPLATES)
      .set(authedMutation(session))
      .send({ templates, lock });
  }

  function rowCount(): Promise<number> {
    return app().prisma.systemSetting.count();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // The limit — proven by the case that must fail
  // ═══════════════════════════════════════════════════════════════════════

  it('refuses a caller without a session', async () => {
    const anonymous = await request(app().server).get(TEMPLATES);

    expect(anonymous.status).toBe(401);
  });

  it('refuses the admin of the active organisation on the read with 403', async () => {
    const refused = await read(tenantAdmin);

    expect(refused.status).toBe(403);
    // The read is as privileged as the write: it hands out the
    // document that is being replaced. None of it may travel along in the
    // refusal.
    expect(JSON.stringify(refused.body)).not.toContain('templates');
  });

  it('refuses the admin of the active organisation on the write — and writes nothing', async () => {
    expect(await rowCount()).toBe(0);

    const refused = await write(tenantAdmin, [template('eigene')], 1);

    expect(refused.status).toBe(403);
    // Checked with a query of its own and not on the response: a
    // refused write that had written anyway would look exactly the
    // same from outside.
    expect(await rowCount()).toBe(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // „Nichts entschieden" is a state of its own
  // ═══════════════════════════════════════════════════════════════════════

  it('answers a fresh installation with the shipped templates and decided: false', async () => {
    const answer = await read(superadmin);

    expect(answer.status).toBe(200);
    const body = answer.body as {
      templates: NotificationTemplate[];
      decided: boolean;
      lock: number;
    };
    expect(body.decided).toBe(false);
    expect(body.lock).toBe(1);
    expect(body.templates.map((entry) => entry.id)).toEqual(
      NOTIFICATION_TEMPLATES_FLOOR.map((entry) => entry.id),
    );
    // It reads, it does not write: a `GET` that silently wrote the shipped
    // set into the column would make out of „nichts entschieden" a
    // decision that nobody has taken.
    expect(await rowCount()).toBe(0);
  });

  it('stores what a superadmin writes and reports it as decided', async () => {
    const written = await write(superadmin, [template('eigene')], 1);

    expect(written.status).toBe(200);
    expect(written.body).toMatchObject({
      decided: true,
      lock: 2,
      templates: [{ id: 'eigene', name: 'Vorlage eigene' }],
    });

    const again = await read(superadmin);
    expect(again.body).toMatchObject({ decided: true, lock: 2 });
  });

  /**
   * **The empty list is a decision**, not a „nichts entschieden" —
   * the same difference that the column expresses with its `NULL`.
   */
  it('tells „bietet keine Vorlagen an" apart from „nichts entschieden"', async () => {
    const written = await write(superadmin, [], 1);

    expect(written.status).toBe(200);
    expect(written.body).toMatchObject({ templates: [], decided: true });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // The lock
  // ═══════════════════════════════════════════════════════════════════════

  it('answers a second write from the same lock with 409 and keeps the first', async () => {
    expect((await write(superadmin, [template('erste')], 1)).status).toBe(200);

    const stale = await write(superadmin, [template('zweite')], 1);

    expect(stale.status).toBe(409);
    const current = await read(superadmin);
    expect(
      (current.body as { templates: NotificationTemplate[] }).templates.map(
        (entry) => entry.id,
      ),
    ).toEqual(['erste']);
  });

  it('accepts the follow-up write that names the new lock', async () => {
    await write(superadmin, [template('erste')], 1);

    const second = await write(superadmin, [template('zweite')], 2);

    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ lock: 3 });
  });

  /**
   * The counter is **its own**: a write to the mail block does not move it,
   * otherwise the 409 of the one side would be the answer to the work of the
   * other.
   */
  it('is not moved by a write to the mail block', async () => {
    const mail = await request(app().server)
      .put(apiPath('/admin/system-settings/mail'))
      .set(authedMutation(superadmin))
      .send({
        smtp: null,
        publicBaseUrl: 'https://vorlagen-probe.example.org',
        replyTo: null,
        opsAlertEmail: null,
        lock: 1,
      });
    expect(mail.status).toBe(200);

    // The row exists now — and the counter of the templates still stands at
    // its initial value, so the write with `lock: 1` takes effect.
    const written = await write(superadmin, [template('eigene')], 1);
    expect(written.status).toBe(200);
    expect(written.body).toMatchObject({ lock: 2 });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // The limits of the document
  // ═══════════════════════════════════════════════════════════════════════

  it('refuses more than the limit', async () => {
    const tooMany = Array.from(
      { length: NOTIFICATION_TEMPLATE_LIMIT + 1 },
      (_, index) => template(`v${String(index)}`),
    );

    const refused = await write(superadmin, tooMany, 1);

    expect(refused.status).toBe(400);
    expect(await rowCount()).toBe(0);
  });

  it('refuses two templates under one id', async () => {
    const refused = await write(
      superadmin,
      [template('doppelt'), template('doppelt')],
      1,
    );

    expect(refused.status).toBe(400);
    expect(await rowCount()).toBe(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Repairability
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * **An unreadable document does not lock out the page that can repair
   * it.** The same weighing-up that the mail page makes for a broken SMTP
   * block: a 500 here would mean that the installation can only get rid of
   * the error with `psql`.
   */
  it('shows the shipped templates for a stored document that does not parse — and lets it be replaced', async () => {
    await app().prisma.systemSetting.create({
      data: { id: 'x', notificationTemplates: { kaputt: true } },
    });

    const answer = await read(superadmin);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ decided: false, lock: 1 });
    expect(
      (answer.body as { templates: NotificationTemplate[] }).templates.map(
        (entry) => entry.id,
      ),
    ).toEqual(NOTIFICATION_TEMPLATES_FLOOR.map((entry) => entry.id));

    const repaired = await write(superadmin, [template('repariert')], 1);
    expect(repaired.status).toBe(200);
    expect(repaired.body).toMatchObject({ decided: true, lock: 2 });
  });
});
