import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import {
  TENANT_DELETE_CONFIRM_MISMATCH_MESSAGE,
  parseDeletedTenantList,
  parseTenantOverview,
  trashCutoff,
} from '@formsache/shared';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { TENANT_NOT_FOUND_MESSAGE } from '../../src/admin/admin.service';
import { FileStorage } from '../../src/files/file-storage';
import { MailWorkerService } from '../../src/mail/mail-worker.service';
import { PermanentDeletionService } from '../../src/trash/permanent-deletion.service';
import { TenantScopeFactory } from '../../src/tenancy/tenant-scope';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import { MutableClock } from '../mail/mail-test-context';
import {
  TEST_PUBLIC_BASE_URL,
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
  authedMutation,
  cookieHeader,
  login,
  openSession,
} from '../support/http';
import { SmtpDouble } from '../support/smtp-double';

/**
 * **An organisation is deleted via the trash, with 30 days** (Konzept no. 64).
 *
 * ## Why this file is organised by *filter* and not by feature
 *
 * The requirement's own words: „`deleted_at` am Tenant muss in **jeder** Abfrage
 * gefiltert werden — Anmeldung, Sitzungsauflösung, Tenant-Wechsler,
 * Superadmin-Übersicht, öffentliche Formularadresse, Mail-Worker. Ein
 * vergessener Filter lässt jemanden in einer gelöschten Organisation weiterarbeiten."
 * A single test asserting „irgendetwas antwortet nicht mehr" would go green
 * with five of the six in place and say nothing about which one is missing. So
 * each case below names the query it is about and is red on its own.
 *
 * **Where the code has fewer filters than the requirement predicts, this file
 * says so rather than inventing one.** Three of the six named places —
 * Anmeldung (local), Sitzungsauflösung and the Tenant-Wechsler's *list* — read
 * one query, `membershipInclude` in `auth/session-user.ts`, and are covered by
 * one condition there. Three separate cases still measure three separate
 * promises, and all three go red together when that condition goes. The list in
 * the requirement is a prediction; the code is the measurement.
 *
 * The OIDC login (`OidcTenantsService`) is the second half of „Anmeldung" and
 * has its own query and its own condition — measured in
 * `test/auth/oidc-deleted-tenant.spec.ts`, because it needs a fake provider and
 * this suite does not.
 *
 * ## Reproductions, measured on 2026-08-03 — see each case
 */

const PASSWORD = 'test-password-e5';

const PAGE = '019ffe00-0000-7000-8000-0000000000a0';
const NAME_QUESTION = '019ffe00-0000-7000-8000-000000000001';
const MAIL_QUESTION = '019ffe00-0000-7000-8000-000000000002';

/** The address the participant types in — the one a withheld mail carries. */
const PARTICIPANT = 'berta@example.invalid';

const questionBase = { hint: null, required: false, width: 'full' as const };

const definition = {
  pages: [
    {
      id: PAGE,
      title: 'Anmeldung',
      description: null,
      questions: [
        {
          ...questionBase,
          id: NAME_QUESTION,
          type: 'text',
          label: 'Name',
          minLength: null,
          maxLength: null,
          pattern: null,
        },
        {
          ...questionBase,
          id: MAIL_QUESTION,
          type: 'email',
          label: 'E-Mail',
        },
      ],
    },
  ],
};

/** Documentation range (RFC 5737) — never a real caller. */
let nextAddress = 0;
function ownAddress(): string {
  nextAddress += 1;
  return `198.51.100.${String((nextAddress % 250) + 1)}`;
}

describe('eine Organisation löschen, über den Papierkorb ', () => {
  let database: TestDatabase | undefined;
  let testApp: TestApp;
  let clock: MutableClock;
  let transport: SmtpDouble;
  let worker: MailWorkerService;

  /** The organisation this suite deletes and restores. */
  let victim: TenantFixture;
  /** A second, live Organisation — so „nichts geht mehr" cannot be true of everything. */
  let neighbour: TenantFixture;

  let superadmin: string;
  /** …and the id that has to appear in the protocol. */
  let superadminId: string;
  /** A member of {@link victim} and of nothing else. */
  let memberId: string;
  const memberEmail = 'schriftfuehrer@victim.invalid';
  /** A member of both Organisationen — the Tenant-Wechsler case. */
  let switcherId: string;
  /** Somebody who is not a superadmin at all. */
  let outsider: string;

  let form: { id: string; slug: string };

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    transport = new SmtpDouble();
    clock = new MutableClock(new Date('2026-08-03T12:00:00.000Z'));
    testApp = await createTestApp({
      databaseUrl: database.url,
      systemMail: { publicBaseUrl: TEST_PUBLIC_BASE_URL },
      env: { TRUST_PROXY_HOPS: 1 },
      transport,
      clock,
    });
    worker = testApp.app.get(MailWorkerService);

    victim = await createTenant(testApp.prisma, 'VICTIM');
    neighbour = await createTenant(testApp.prisma, 'NEIGHBOUR');

    const root = await createUser(testApp.prisma, {
      email: 'root@example.org',
      password: PASSWORD,
      isSuperadmin: true,
    });
    superadminId = root.id;
    superadmin = await openSession(testApp, root.id, null);

    const member = await createUser(testApp.prisma, {
      email: memberEmail,
      password: PASSWORD,
      tenants: [victim],
    });
    memberId = member.id;

    const switcher = await createUser(testApp.prisma, {
      email: 'beide@example.org',
      password: PASSWORD,
      tenants: [victim, neighbour],
    });
    switcherId = switcher.id;

    const plain = await createUser(testApp.prisma, {
      email: 'kein-root@example.org',
      password: PASSWORD,
      tenants: [neighbour],
    });
    outsider = await openSession(testApp, plain.id, neighbour.id);

    form = await publishedSendingForm();
  }, 240_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  // ─── fixtures, through the real routes ──────────────────────────────────

  /** A published form of {@link victim} that sends a confirmation. */
  async function publishedSendingForm(): Promise<{ id: string; slug: string }> {
    const editor = await openSession(testApp, memberId, victim.id);

    const created = await request(app().server)
      .post(apiPath('/forms'))
      .set(authedMutation(editor))
      .send({ title: 'Jahrestagung' });
    expect(created.status).toBe(201);
    const row = created.body as {
      id: string;
      revision: number;
      publicSlug: string;
    };

    const saved = await request(app().server)
      .put(apiPath(`/forms/${row.id}`))
      .set(authedMutation(editor))
      .send({
        title: 'Jahrestagung',
        definition,
        revision: row.revision,
      });
    expect(saved.status).toBe(200);

    const published = await request(app().server)
      .post(apiPath(`/forms/${row.id}/publish`))
      .set(authedMutation(editor))
      .send({ revision: (saved.body as { revision: number }).revision });
    expect(published.status).toBe(200);

    // A question recipient reads the participant's own address out of the
    // answer, which counts as *participant delivery* — and that needs
    // `copyToSubmitter` on the form (`submission-mail.ts`). Without it the
    // notification is silent and „die Mail wurde zurückgehalten" would be
    // measuring a mail that was never queued.
    const tenant = await app().prisma.tenant.findUniqueOrThrow({
      where: { id: victim.id },
      select: { formDefaultsRevision: true },
    });
    const settings = await request(app().server)
      .put(apiPath(`/forms/${row.id}/settings`))
      .set(authedMutation(editor))
      .send({
        overridden: {
          access: true,
          confirm: true,
          display: false,
          budget: false,
        },
        values: { allowEdit: true },
        revision: (
          await app().prisma.form.findUniqueOrThrow({
            where: { id: row.id },
            select: { settingsRevision: true },
          })
        ).settingsRevision,
        tenantRevision: tenant.formDefaultsRevision,
      });
    expect(settings.status).toBe(200);

    const notification = await request(app().server)
      .post(apiPath(`/forms/${row.id}/notifications`))
      .set(authedMutation(editor))
      .send({
        name: 'Bestätigung',
        subject: 'Anmeldung eingegangen',
        body: 'Wir haben deine Anmeldung erhalten.',
        recipients: [{ kind: 'question', questionId: MAIL_QUESTION }],
        replyTo: null,
      });
    expect(notification.status).toBe(201);

    return { id: row.id, slug: row.publicSlug };
  }

  // ─── the two verbs under test ───────────────────────────────────────────

  function deleteTenant(id: string, confirmName: string, session = superadmin) {
    return request(app().server)
      .delete(apiPath(`/admin/tenants/${id}`))
      .set(authedMutation(session))
      .send({ confirmName });
  }

  function restoreTenant(id: string, session = superadmin) {
    return request(app().server)
      .post(apiPath(`/admin/tenants/${id}/restore`))
      .set(authedMutation(session));
  }

  /** Deletes {@link victim}, runs `body`, and always restores afterwards. */
  async function whileDeleted(body: () => Promise<void>): Promise<void> {
    expect((await deleteTenant(victim.id, 'Organisation VICTIM')).status).toBe(
      204,
    );
    try {
      await body();
    } finally {
      expect((await restoreTenant(victim.id)).status).toBe(204);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // The action itself — superadmin, without membership, with typing it out
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * The rule: „das Löschen einer Organisation ist eine Superadmin-Handlung und
   * braucht **keine** Mitgliedschaft".
   *
   * The superadmin of this suite is a member of nothing at all, which is the
   * state a fresh installation's first superadmin is in — and the reason this
   * must stay untouched: this route reads and returns nothing *fachlich* of the
   * Organisation.
   */
  it('is a superadmin action and needs no membership in the organisation', async () => {
    const memberships = await app().prisma.membership.count({
      where: { user: { isSuperadmin: true } },
    });
    expect(memberships).toBe(0);

    await whileDeleted(async () => {
      const row = await app().prisma.tenant.findUniqueOrThrow({
        where: { id: victim.id },
        select: { deletedAt: true },
      });
      expect(row.deletedAt).not.toBeNull();
    });
  }, 120_000);

  /**
   * **The deletion instant comes from the clock, not from `new Date()`** — a
   * review finding made on exactly this shape.
   *
   * It is not decoration: the 30 days are counted from this column, and
   * the purge below is proven at 29 and 31 days *through this route*. A
   * `new Date()` here would mean the only way to a 31-day-old Organisation is to write
   * the column by hand, i.e. to prove the purge against a state the application
   * is not shown to produce.
   *
   * *Reproduction, measured on 2026-08-03:* `this.clock.now()` in
   * `AdminService.remove` replaced by `new Date()` → **3 rot**: this case, the
   * „Gelöschte Organisationen" section (whose `deletedAt` is then the wall clock), and
   * — the one that matters — **the 29/31-day check itself**, because the 29/31-day pair can no
   * longer be reached through the route at all.
   */
  it('stamps deleted_at from the injected clock', async () => {
    clock.set(new Date('2026-08-03T12:00:00.000Z'));
    await whileDeleted(async () => {
      const row = await app().prisma.tenant.findUniqueOrThrow({
        where: { id: victim.id },
        select: { deletedAt: true },
      });
      expect(row.deletedAt?.toISOString()).toBe('2026-08-03T12:00:00.000Z');
    });
  }, 120_000);

  /**
   * **The confirmation demands that the organisation's name be typed out**
   * — and the check is on the server.
   *
   * *Reproduction, measured on 2026-08-03:* the comparison removed from
   * `AdminService.remove` → this case red at the 409, and the organisation is **deleted
   * by a request that typed „Organisation NEIGHBOUR"** — which then knocks over nine
   * further cases, because from there on the organisation this suite works in is gone.
   */
  it('refuses a mistyped confirmation and deletes nothing', async () => {
    const wrong = await deleteTenant(victim.id, 'Organisation NEIGHBOUR');
    expect(wrong.status).toBe(409);
    expect((wrong.body as { message: string }).message).toBe(
      TENANT_DELETE_CONFIRM_MISMATCH_MESSAGE,
    );
    // The message does not hand the expected name back out.
    expect(wrong.text).not.toContain('Organisation VICTIM');

    const row = await app().prisma.tenant.findUniqueOrThrow({
      where: { id: victim.id },
      select: { deletedAt: true },
    });
    expect(row.deletedAt).toBeNull();
  }, 120_000);

  /**
   * **The most destructive verb of the application leaves a line** — three
   * of them: deleting, restoring and the refused confirmation
   * (a security review finding).
   *
   * Neither `AdminService` nor its controller had a `Logger` at all, while the
   * file purge, the redeeming of an invitation and the mail purge beside them
   * all write one. „Wer hat VICTIM gelöscht, und wann" was answerable only from
   * `deleted_at` — the column the restore then clears.
   *
   * The refused confirmation is in the protocol and the two 404s are not, on
   * purpose: somebody standing in front of this dialog with the **right id and
   * the wrong name** is the shape a mistake and an attempt share, while a line
   * per mistyped id would be a way to fill the protocol from outside.
   *
   * **And what may not be in the line is asserted too** (`CONTRIBUTING.md`): two
   * ids, never a name and never an address — not the organisation's name, not the
   * string that was typed into the confirmation, not the superadmin's e-mail.
   *
   * *Reproduction, measured on 2026-08-03:* with the three `logger` calls
   * removed from `AdminService` this case is red at `toHaveLength(3)` with
   * **0** lines — the state the review found.
   */
  it('protocols the deletion, the restore and the refused confirmation', async () => {
    const written = vi.spyOn(Logger.prototype, 'log');
    const refusals = vi.spyOn(Logger.prototype, 'warn');
    try {
      const wrong = await deleteTenant(victim.id, 'Organisation NEIGHBOUR');
      expect(wrong.status).toBe(409);
      await whileDeleted(async () => {
        /* deleted and restored by the helper */
      });

      const lines = [...written.mock.calls, ...refusals.mock.calls]
        .map(([first]) => String(first))
        .filter((line) => line.includes(victim.id));

      // One per verb, and each names the acting superadmin.
      expect(lines).toHaveLength(3);
      for (const line of lines) {
        expect(line).toContain(superadminId);
      }
      expect(lines.filter((line) => line.includes('refused'))).toHaveLength(1);
      expect(lines.filter((line) => line.includes('restored'))).toHaveLength(1);
      expect(
        lines.filter((line) => line.includes('moved to the Papierkorb')),
      ).toHaveLength(1);

      // Nothing personal, and nothing the caller typed.
      for (const line of lines) {
        expect(line).not.toContain('Organisation VICTIM');
        expect(line).not.toContain('Organisation NEIGHBOUR');
        expect(line).not.toContain('root@example.org');
      }
    } finally {
      written.mockRestore();
      refusals.mockRestore();
    }
  }, 120_000);

  /**
   * **A 404 must not be an existence oracle.** An organisation that never existed, one
   * that is already in the trash, and a path segment that is not a uuid
   * all answer the same thing — byte for byte.
   *
   * The third case is the floor under the route ordering of
   * `GET /api/admin/tenants/deleted`: without `requireTenantId` a non-uuid
   * segment reaches PostgreSQL and comes back as a 500, which differs from
   * every other refusal and is therefore readable.
   */
  it('answers a deleted Organisation, an invented one and a malformed id alike', async () => {
    await whileDeleted(async () => {
      const deleted = await request(app().server)
        .get(apiPath(`/admin/tenants/${victim.id}`))
        .set('Cookie', cookieHeader(superadmin));
      const invented = await request(app().server)
        .get(apiPath(`/admin/tenants/${randomUUID()}`))
        .set('Cookie', cookieHeader(superadmin));
      const malformed = await request(app().server)
        .get(apiPath('/admin/tenants/nicht-einmal-eine-uuid'))
        .set('Cookie', cookieHeader(superadmin));

      expect(deleted.status).toBe(404);
      expect(invented.status).toBe(404);
      expect(malformed.status).toBe(404);
      expect(deleted.text).toBe(invented.text);
      expect(malformed.text).toBe(invented.text);
      expect((deleted.body as { message: string }).message).toBe(
        TENANT_NOT_FOUND_MESSAGE,
      );

      // And deleting one twice is not a second, different answer either.
      const again = await deleteTenant(victim.id, 'Organisation VICTIM');
      expect(again.status).toBe(404);
      expect(again.text).toBe(invented.text);
    });
  }, 120_000);

  /**
   * The guard chain is `SessionGuard → SuperadminGuard` and nothing else — so
   * the refusal for everybody else is the 403 of the requirement, and the organisation
   * stands afterwards.
   */
  it('refuses a non-superadmin, and the organisation is untouched', async () => {
    const refused = await deleteTenant(
      victim.id,
      'Organisation VICTIM',
      outsider,
    );
    expect(refused.status).toBe(403);

    const refusedRestore = await restoreTenant(victim.id, outsider);
    expect(refusedRestore.status).toBe(403);

    const row = await app().prisma.tenant.findUniqueOrThrow({
      where: { id: victim.id },
      select: { deletedAt: true },
    });
    expect(row.deletedAt).toBeNull();
  }, 120_000);

  // ═════════════════════════════════════════════════════════════════════════
  // The six filters — one each, one test of its own each
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * **Anmeldung** (`membershipInclude`, `auth/session-user.ts`).
   *
   * The person still signs in: their account is not what was deleted. What they
   * must not get is a scope — `deriveActiveTenant` picks the single membership
   * of somebody who has exactly one, and that is the path a member of a deleted
   * Organisation walks straight into.
   *
   * *Reproduction, measured on 2026-08-03:* `where: { tenant: { deletedAt:
   * null } }` removed from `membershipInclude` → **3 rot**, this case among
   * them, with `activeTenantId` naming the deleted Organisation. The three go red
   * together because they are one condition; this file says so in its header
   * rather than pretending otherwise.
   */
  it('filter 1 — a fresh login into a deleted Organisation gets no scope', async () => {
    await whileDeleted(async () => {
      const response = await request(app().server)
        .post(apiPath('/auth/login'))
        .send({ email: memberEmail, password: PASSWORD });

      expect(response.status).toBe(200);
      // `POST /auth/login` answers a `{ user }` envelope, `GET /auth/me` the
      // person itself — see `AuthController`.
      const { user } = response.body as {
        user: {
          activeTenantId: string | null;
          memberships: { tenant: { id: string } }[];
        };
      };
      expect(user.activeTenantId).toBeNull();
      expect(user.memberships).toHaveLength(0);
    });
  }, 120_000);

  /**
   * **Sitzungsauflösung**, and this is the case the requirement writes
   * out in full: „eine **offene** Sitzung mit ihr als aktiver Organisation verliert den
   * Scope, **ohne 500**".
   *
   * The session is opened *before* the deletion and carries the organisation as its
   * active one, so `session.active_tenant_id` still names it in the table. What
   * decides is `resolveActiveTenantId`, which keeps that column only while the
   * membership list covers it — and the list is the one the login filter narrows.
   *
   * *Reproduction, measured on 2026-08-03:* the same condition removed → this
   * case red in the worst way, at the **first** assertion: `GET /api/forms`
   * answers **200** for a session whose Organisation is in the trash.
   */
  it('filter 1 — an open session loses its scope, and not with a 500', async () => {
    const open = await openSession(testApp, memberId, victim.id);

    await whileDeleted(async () => {
      // **The scoped route first**, because it is the load-bearing half: a
      // session that still reports an organisation is a nuisance, a session that still
      // *reads* one is the „jemand arbeitet in einer gelöschten Organisation weiter"
      // the requirement is about. 403 „keine Organisation ausgewählt" is the ordinary
      // answer of `TenantScopeGuard` — explicitly not 500 and not 200.
      const scoped = await request(app().server)
        .get(apiPath('/forms'))
        .set('Cookie', cookieHeader(open));
      expect(scoped.status).toBe(403);

      const me = await request(app().server)
        .get(apiPath('/auth/me'))
        .set('Cookie', cookieHeader(open));
      expect(me.status).toBe(200);
      expect(
        (me.body as { activeTenantId: string | null }).activeTenantId,
      ).toBeNull();
    });

    // And it comes back on its own after the restore — the session was never
    // revoked, only unscoped.
    const after = await request(app().server)
      .get(apiPath('/auth/me'))
      .set('Cookie', cookieHeader(open));
    expect(
      (after.body as { activeTenantId: string | null }).activeTenantId,
    ).toBe(victim.id);
  }, 120_000);

  /**
   * **The Tenant-Wechsler does not know it.**
   *
   * The switcher in the header is rendered from `SessionUser.memberships`, so a
   * person serving two Organisationen is offered one while the other is deleted. Its own
   * case rather than an assertion inside the login one: „der Wechsler kennt ihn
   * nicht" is a promise about somebody who has *another* Organisation to work in, and
   * the login case is about somebody who has none.
   */
  it('filter 1 — the switcher offers only the living Organisation', async () => {
    const both = await openSession(testApp, switcherId, neighbour.id);

    await whileDeleted(async () => {
      const me = await request(app().server)
        .get(apiPath('/auth/me'))
        .set('Cookie', cookieHeader(both));
      const body = me.body as { memberships: { tenant: { id: string } }[] };
      expect(body.memberships.map((entry) => entry.tenant.id)).toEqual([
        neighbour.id,
      ]);
    });

    const after = await request(app().server)
      .get(apiPath('/auth/me'))
      .set('Cookie', cookieHeader(both));
    expect(
      (after.body as { memberships: { tenant: { id: string } }[] }).memberships,
    ).toHaveLength(2);
  }, 120_000);

  /**
   * **Der Tenant-Wechsler, Schreibseite**
   * (`TenantSwitchService.switchTo`).
   *
   * Its own query and therefore its own condition: this method checks against
   * the **database** on purpose, so it cannot lean on the list the previous filter
   * narrowed. `PUT /api/session/tenant` answers 404 — and the same 404 an id
   * that never existed gets, so the reply confirms nothing.
   *
   * *Reproduction, measured on 2026-08-03:* `tenant: { deletedAt: null }`
   * removed from the `where` → **1 rot**, this case, with **200** instead of
   * 404: the switch succeeds and `session.active_tenant_id` names the deleted
   * Organisation. (The login filter then unscopes it again on the next request, which is
   * exactly why the two conditions are not one — the write must refuse, not be
   * quietly undone.)
   */
  it('filter 2 — switching into a deleted Organisation is 404, like an invented one', async () => {
    const both = await openSession(testApp, switcherId, neighbour.id);

    await whileDeleted(async () => {
      const into = await request(app().server)
        .put(apiPath('/session/tenant'))
        .set(authedMutation(both))
        .send({ tenantId: victim.id });
      const invented = await request(app().server)
        .put(apiPath('/session/tenant'))
        .set(authedMutation(both))
        .send({ tenantId: randomUUID() });

      expect(into.status).toBe(404);
      expect(invented.status).toBe(404);
      expect(into.text).toBe(invented.text);

      // The stored session did not move either — a refusal that answered 404
      // after writing would be the worse bug.
      const row = await app().prisma.session.findFirstOrThrow({
        where: { userId: switcherId, revokedAt: null },
        orderBy: { createdAt: 'desc' },
        select: { activeTenantId: true },
      });
      expect(row.activeTenantId).toBe(neighbour.id);
    });
  }, 120_000);

  /**
   * **The superadmin overview** (`AdminRepository.overview` and
   * `findById`), and the „Gelöschte Organisationen" section it comes back from.
   *
   * *Reproduction, measured on 2026-08-03:* `where: { deletedAt: null }`
   * removed from `overview()` → **1 rot**, this case, with the deleted Organisation
   * standing in the table next to the living ones.
   */
  it('filter 4 — the overview drops it, and the deleted section lists it', async () => {
    const before = parseTenantOverview(
      (
        await request(app().server)
          .get(apiPath('/admin/tenants'))
          .set('Cookie', cookieHeader(superadmin))
      ).body,
    );

    await whileDeleted(async () => {
      const listing = await request(app().server)
        .get(apiPath('/admin/tenants'))
        .set('Cookie', cookieHeader(superadmin));
      const overview = parseTenantOverview(listing.body);
      expect(overview.tenants.map((row) => row.tenant.id)).not.toContain(
        victim.id,
      );
      expect(overview.totals.tenants).toBe(before.totals.tenants - 1);
      // The counters follow: a deleted organisation's forms do not stand in the tiles.
      expect(overview.totals.forms).toBeLessThan(before.totals.forms);

      const section = await request(app().server)
        .get(apiPath('/admin/tenants/deleted'))
        .set('Cookie', cookieHeader(superadmin));
      expect(section.status).toBe(200);
      const deleted = parseDeletedTenantList(section.body);
      expect(deleted.tenants.map((row) => row.tenant.id)).toContain(victim.id);
      expect(deleted.tenants[0]?.deletedAt).toBe('2026-08-03T12:00:00.000Z');
    });

    const restored = parseTenantOverview(
      (
        await request(app().server)
          .get(apiPath('/admin/tenants'))
          .set('Cookie', cookieHeader(superadmin))
      ).body,
    );
    expect(restored.totals.tenants).toBe(before.totals.tenants);
  }, 120_000);

  /**
   * **A non-superadmin does not see the section**.
   */
  it('filter 4 — the deleted section refuses a non-superadmin', async () => {
    const refused = await request(app().server)
      .get(apiPath('/admin/tenants/deleted'))
      .set('Cookie', cookieHeader(outsider));
    expect(refused.status).toBe(403);
  }, 120_000);

  /**
   * **The public form address** (`PublicFormsService.load`).
   *
   * The one filter of the six a stranger on the internet reaches, and the only
   * one whose absence carries data out of the house on its own: without it a
   * Organisation taken out of service goes on collecting Anmeldungen under its old
   * links.
   *
   * The 404 is byte-identical with an invented address, and it is a *condition
   * of the same statement* — the shape the requirement settled on, so the deleted
   * organisation's form does not cost the three relation round trips an invented
   * address never costs.
   *
   * *Reproduction, measured on 2026-08-03:* `tenant: { deletedAt: null }`
   * removed from the `where` → **1 rot**, this case, with **200** where 404 is
   * expected: the deleted organisation's form is served to anybody with the link.
   */
  it('filter 5 — the public address answers 404, like an invented one', async () => {
    await whileDeleted(async () => {
      const page = await request(app().server).get(
        apiPath(`/public/forms/${form.slug}`),
      );
      const invented = await request(app().server).get(
        apiPath('/public/forms/AAAAAAAAAAAAAAAAAAAAAA'),
      );

      expect(page.status).toBe(404);
      expect(invented.status).toBe(404);
      expect(page.text).toBe(invented.text);

      // And nothing can be submitted to it either.
      const sent = await request(app().server)
        .post(apiPath(`/public/forms/${form.slug}/responses`))
        .set('X-Forwarded-For', ownAddress())
        .send({
          answers: { [NAME_QUESTION]: 'Berta', [MAIL_QUESTION]: PARTICIPANT },
        });
      expect(sent.status).toBe(404);
    });

    // And back: working again, without anything being re-published.
    const again = await request(app().server).get(
      apiPath(`/public/forms/${form.slug}`),
    );
    expect(again.status).toBe(200);
  }, 120_000);

  /**
   * **Der Mail-Worker** (`MailQueueRepository`, `NOT_IN_TRASH`).
   *
   * The requirement decides the *shape*: the row is **withheld**, not failed. It
   * stays `queued`, `attempts` does not move, and it goes out on the next tick
   * after the restore — which is why this case asserts the transport first and
   * the row second. A run that claimed, rendered and asked SMTP before writing
   * `queued` back would leave the row looking exactly the same.
   *
   * The same fragment as the deleted form and the deleted answer, deliberately:
   * the same rule applies: „für das gelöschte Formular dieselbe Regel, die sie für die
   * gelöschte Organisation ohnehin verlangt".
   *
   * *Reproduction, measured on 2026-08-03:* `AND t."deleted_at" IS NULL`
   * removed from `NOT_IN_TRASH` → **1 rot**, this case, with **1 mail actually
   * handed to the transport** — the participant's frozen answers carried out of
   * an organisation that is out of service.
   */
  it('filter 6 — a queued mail is held back, and goes after the restore', async () => {
    const sent = await request(app().server)
      .post(apiPath(`/public/forms/${form.slug}/responses`))
      .set('X-Forwarded-For', ownAddress())
      .send({
        answers: { [NAME_QUESTION]: 'Berta', [MAIL_QUESTION]: PARTICIPANT },
      });
    expect(sent.status).toBe(200);

    const queued = await app().prisma.mailLog.findFirstOrThrow({
      where: { formId: form.id, recipient: PARTICIPANT },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true },
    });
    expect(queued.status).toBe('queued');

    await whileDeleted(async () => {
      const before = transport.attemptCount;
      const run = await worker.runOnce();
      expect(transport.attemptCount - before).toBe(0);
      expect(run.sent).toBe(0);
      expect(transport.attempts.map((mail) => mail.to)).not.toContain(
        PARTICIPANT,
      );

      // Held back, not failed: nothing was attempted, so nothing is counted.
      const held = await app().prisma.mailLog.findUniqueOrThrow({
        where: { id: queued.id },
        select: { status: true, attempts: true },
      });
      expect(held.status).toBe('queued');
      expect(held.attempts).toBe(0);
    });

    const before = transport.attemptCount;
    await worker.runOnce();
    expect(transport.attemptCount - before).toBe(1);
    expect(transport.attempts.at(-1)?.to).toBe(PARTICIPANT);
    expect(
      (
        await app().prisma.mailLog.findUniqueOrThrow({
          where: { id: queued.id },
          select: { status: true },
        })
      ).status,
    ).toBe('sent');
  }, 180_000);

  /**
   * **Der Bearbeiten-Link** (`PublicFormsService.loadForEdit`).
   *
   * A second sessionless door into the same organisation, and it is not the one the
   * requirement names: `GET /api/public/responses/:token` shows a participant
   * their own submitted answers. A link handed out before the deletion must
   * stop leading anywhere, or the one route that hands personal data back out
   * would outlive the organisation it belongs to.
   *
   * *Reproduction, measured on 2026-08-03:* `response?.form.tenant.deletedAt !=
   * null` removed from the refusal chain → this case red with **200** and the
   * stored answers in the body.
   */
  it('filter 5 — an edit link into a deleted Organisation answers 404', async () => {
    const sent = await request(app().server)
      .post(apiPath(`/public/forms/${form.slug}/responses`))
      .set('X-Forwarded-For', ownAddress())
      .send({
        answers: { [NAME_QUESTION]: 'Cäcilie', [MAIL_QUESTION]: PARTICIPANT },
      });
    expect(sent.status).toBe(200);

    const stored = await app().prisma.response.findFirstOrThrow({
      where: { form: { publicSlug: form.slug } },
      orderBy: { submittedAt: 'desc' },
      select: { editToken: true },
    });
    const token = stored.editToken;
    expect(token).not.toBeNull();

    const before = await request(app().server).get(
      apiPath(`/public/responses/${token ?? ''}`),
    );
    expect(before.status).toBe(200);

    await whileDeleted(async () => {
      const during = await request(app().server).get(
        apiPath(`/public/responses/${token ?? ''}`),
      );
      expect(during.status).toBe(404);
    });

    const after = await request(app().server).get(
      apiPath(`/public/responses/${token ?? ''}`),
    );
    expect(after.status).toBe(200);
  }, 120_000);

  /**
   * **A further filter — the public Logo** (`PublicLogoService.byRef`).
   *
   * The third sessionless door, and the one a security review finding
   * found unmeasured: `public-logo.service.ts` carried the condition and a
   * comment claiming it „is measured here anyway", and no case anywhere named
   * it. The filter could have been deleted without a single test going red,
   * which is the same thing as not having it — a deleted organisation's Logo served
   * on from an address anybody who once opened one of its forms has written
   * down.
   *
   * The bytes are real, and they have to be: without them `deliverFile` answers
   * 404 for the missing object and the case would be green for the wrong
   * reason.
   *
   * *Reproduction, measured on 2026-08-03:* `deletedAt: null` removed from the
   * `tenant` condition in `PublicLogoService.byRef` → **1 rot**, this case, with
   * **200** and the image body where 404 is expected.
   */
  it('filter 5 — the public Logo of a deleted Organisation answers 404', async () => {
    const ref = randomBytes(16).toString('base64url');
    const row = await app().prisma.file.create({
      data: {
        tenantId: victim.id,
        kind: 'tenant_logo',
        publicRef: ref,
        fileName: 'logo.png',
        contentType: 'image/png',
        status: 'stored',
      },
      select: { id: true },
    });
    const storage = testApp.app.get(FileStorage);
    // Not a real PNG; the delivery gate reads the column, never the bytes.
    await storage.put(row.id, Readable.from([Buffer.from('89504e47', 'hex')]), {
      maxBytes: 4096,
    });
    // **A Logo is one only while its organisation names it** (ADR-0014 no. 19).
    await app().prisma.tenant.update({
      where: { id: victim.id },
      data: { logoRef: ref },
    });

    const logo = (value: string) =>
      request(app().server).get(apiPath(`/public/files/${value}`));

    try {
      const before = await logo(ref);
      expect(before.status).toBe(200);

      await whileDeleted(async () => {
        const during = await logo(ref);
        const invented = await logo(randomBytes(16).toString('base64url'));

        expect(during.status).toBe(404);
        expect(invented.status).toBe(404);
        // Byte for byte the answer an invented reference gets — the refusal
        // must not be readable as „diese Organisation gibt es, sie ist nur weg".
        expect(during.text).toBe(invented.text);
      });

      // And back: served again, without anything being re-uploaded.
      expect((await logo(ref)).status).toBe(200);
    } finally {
      await app().prisma.tenant.update({
        where: { id: victim.id },
        // What `createTenant` leaves behind — a *shipped* Logo, so the cases
        // after this one see the fixture they were written against.
        data: { logoRef: 'assets/beispiel-signet.svg' },
      });
      await app().prisma.file.delete({ where: { id: row.id } });
      await storage.remove(row.id);
    }
  }, 120_000);

  // ═════════════════════════════════════════════════════════════════════════
  // Wiederhergestellt funktioniert alles wieder
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * The way back, in one place: sign in, get the scope, and work.
   *
   * Nothing is re-created by the restore — one column is cleared, and the six
   * filters do the rest. That is the whole argument for a soft delete over an
   * export-and-recreate, so it is worth one case that walks the chain end to
   * end rather than only the halves the filter cases already assert.
   */
  it('restored, everything works again', async () => {
    await whileDeleted(async () => {
      /* deleted and restored by the helper */
    });

    const token = await login(testApp, memberEmail, PASSWORD);
    const me = await request(app().server)
      .get(apiPath('/auth/me'))
      .set('Cookie', cookieHeader(token));
    expect(me.status).toBe(200);
    expect(
      (
        me.body as { memberships: { tenant: { id: string } }[] }
      ).memberships.map((entry) => entry.tenant.id),
    ).toContain(victim.id);

    const session = await openSession(testApp, memberId, victim.id);
    const forms = await request(app().server)
      .get(apiPath('/forms'))
      .set('Cookie', cookieHeader(session));
    expect(forms.status).toBe(200);
    expect(
      (forms.body as { items: { id: string }[] }).items.map((row) => row.id),
    ).toContain(form.id);
  }, 120_000);

  // ═════════════════════════════════════════════════════════════════════════
  // Physically gone after 30 days, with the injected clock
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * **At 29 days it stays, at 31 days it is gone** — with the injected clock, and through
   * the route: the organisation is deleted by `DELETE /api/admin/tenants/:id`, which
   * stamps `deleted_at` from that same clock.
   *
   * The physical deletion itself is
   * {@link PermanentDeletionService.deleteTenant} — session-free, taking a
   * scope `TenantScopeFactory` minted from an id, which is exactly what the
   * 30-day job will hand it. **The schedule is not built here**: arming
   * a run at start-up and on an interval is the requirement.
   *
   * *Reproductions, measured on 2026-08-03 — and the honest result is that the
   * due-check is **doubled**, so one half alone keeps both cases green:*
   * relaxing `deletedAt: { not: null, lte: cutoff }` to `{ not: null }` → still
   * green (the service's own comparison catches it); removing the service's
   * comparison instead → still green (the `where` catches it); removing
   * **both** → **2 rot**, `'deleted'` where `'not-found'` is expected, i.e. a
   * Organisation destroyed the day after somebody deleted it by mistake.
   *
   * The pair is deliberate and each half has its own job (bytes are spent
   * before the `DELETE` runs), so neither is dead code — but neither is
   * *individually* proven by these two cases, and saying otherwise would be the
   * comment review has been finding eleven times.
   */
  it('29 days stays, 31 days is physically gone', async () => {
    const doomed = await createTenant(app().prisma, 'DOOMED');
    const user = await createUser(app().prisma, {
      email: 'letzter@doomed.invalid',
      password: PASSWORD,
      tenants: [doomed],
    });
    const editor = await openSession(testApp, user.id, doomed.id);

    // A form with a version, so the cascade has something to carry.
    const created = await request(app().server)
      .post(apiPath('/forms'))
      .set(authedMutation(editor))
      .send({ title: 'Bestandsmeldung' });
    expect(created.status).toBe(201);

    const deletedAt = new Date('2026-09-01T09:00:00.000Z');
    clock.set(deletedAt);
    expect((await deleteTenant(doomed.id, 'Organisation DOOMED')).status).toBe(
      204,
    );

    const purge = testApp.app.get(PermanentDeletionService);
    const scope = testApp.app.get(TenantScopeFactory).create(doomed.id);

    // 29 days: not due, and untouched.
    clock.set(new Date(deletedAt.getTime() + 29 * 86_400_000));
    expect(await purge.deleteTenant(scope, trashCutoff(clock.now()))).toBe(
      'not-found',
    );
    expect(await app().prisma.tenant.count({ where: { id: doomed.id } })).toBe(
      1,
    );

    // 31 days: gone, with every child table.
    clock.set(new Date(deletedAt.getTime() + 31 * 86_400_000));
    expect(await purge.deleteTenant(scope, trashCutoff(clock.now()))).toBe(
      'deleted',
    );

    const where = { tenantId: doomed.id };
    // **Ten children, not eight.** The requirement predicts eight; the schema
    // says ten `ON DELETE CASCADE` foreign keys to `tenant`, plus
    // `session.active_tenant_id` at `SET NULL`. Named one by one, so an
    // eleventh table added later has to be added here before it can survive a
    // purge.
    expect(await app().prisma.tenant.count({ where: { id: doomed.id } })).toBe(
      0,
    );
    expect(await app().prisma.group.count({ where })).toBe(0);
    expect(await app().prisma.membership.count({ where })).toBe(0);
    expect(await app().prisma.form.count({ where })).toBe(0);
    expect(await app().prisma.formVersion.count({ where })).toBe(0);
    expect(await app().prisma.response.count({ where })).toBe(0);
    expect(await app().prisma.eventRegistration.count({ where })).toBe(0);
    expect(await app().prisma.notification.count({ where })).toBe(0);
    expect(await app().prisma.mailLog.count({ where })).toBe(0);
    expect(await app().prisma.formPermission.count({ where })).toBe(0);
    expect(await app().prisma.file.count({ where })).toBe(0);

    // The person survives **this** call — `user` carries no `tenant_id`, so no
    // cascade reaches it — and their session is nulled rather than deleted
    // (`ON DELETE SET NULL`).
    //
    // **That is a statement about `deleteTenant`, not about the 30 days.**
    // Since 2026-08-03 the *job* removes an account that loses its
    // last membership this way, and it has to: the sweep is cross-tenant, and
    // this method only ever holds one organisation's scope. Where that happens and what
    // it is conditioned on: `RetentionPurgeService.purgeHomelessAccounts`,
    // measured in `test/trash/retention-purge.spec.ts`.
    expect(await app().prisma.user.count({ where: { id: user.id } })).toBe(1);
    const session = await app().prisma.session.findFirstOrThrow({
      where: { userId: user.id },
      select: { activeTenantId: true },
    });
    expect(session.activeTenantId).toBeNull();

    // And the session is worthless without a scope, rather than dangerous.
    const after = await request(app().server)
      .get(apiPath('/forms'))
      .set('Cookie', cookieHeader(editor));
    expect(after.status).toBe(403);

    clock.set(new Date('2026-08-03T12:00:00.000Z'));
  }, 180_000);

  /**
   * An organisation that is **not** in the trash is never purged, whatever cut-off
   * a job hands in — the harder half of the case above, and the one that
   * matters for a job that got its due-list wrong.
   *
   * *Measured while writing this:* the `IS NOT NULL` half of the condition is
   * **redundant in SQL** — `deleted_at <= $1` is NULL for a live Organisation and
   * therefore never true — so removing it leaves this case green. It stays
   * anyway because it says out loud what the three-valued logic says quietly.
   * What actually carries this case is `lte: cutoff`; with the whole `where`
   * reduced to the id, it goes red with `'deleted'`.
   */
  it('a live Organisation is never purged, whatever cut-off is handed in', async () => {
    const purge = testApp.app.get(PermanentDeletionService);
    const scope = testApp.app.get(TenantScopeFactory).create(neighbour.id);

    // A cut-off far in the future: everything ever deleted would be due.
    expect(
      await purge.deleteTenant(scope, new Date('2099-01-01T00:00:00.000Z')),
    ).toBe('not-found');
    expect(
      await app().prisma.tenant.count({ where: { id: neighbour.id } }),
    ).toBe(1);
  }, 120_000);
});
