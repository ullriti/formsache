import {
  NOTIFICATION_TEMPLATES_FLOOR,
  TENANT_SETTINGS_FLOOR,
  parseTenantOverview,
  type NotificationTemplate,
  type TenantFormSettings,
} from '@formsache/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hashPassword } from '../../src/auth/password';
import {
  ADMIN_EMAIL_TAKEN_MESSAGE,
  SHORT_NAME_TAKEN_MESSAGE,
  TENANT_NOT_FOUND_MESSAGE,
} from '../../src/admin/admin.service';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import { redeemInvitation } from '../support/invitations';
import {
  TEST_PUBLIC_BASE_URL,
  TEST_SYSTEM_SMTP_BLOCK,
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

/**
 * **The superadmin overview and „+ Neue Organisation"** (the requirements).
 *
 * The guard chain of these routes is proved in `admin-routes.spec.ts`; what is
 * here is what they *do*.
 *
 * ## The load-bearing test is the second one, and the requirement says so
 *
 * „nach dem Anlegen ist `form_defaults` `{}`" is weak on its own — one reaches
 * `{}` by doing nothing at all. The proof that matters is that a **later**
 * change to the system row still reaches the new Organisation: that is the promise,
 * and copying the system values at creation time
 * would break it while looking identical on the first day.
 *
 * ## Negative probes, measured while writing this file
 *
 * - System defaults copied into `tenant.form_defaults` at creation: **both**
 *   tests red, and the second one names the value that stopped arriving.
 * - The `admin` group not created: „eine frische Organisation ist sofort arbeitsfähig"
 *   red at the login, because the first administrator has no membership.
 * - `isSuperadmin` allowed through from the payload: it cannot be — there is no
 *   field for it in `tenantCreateSchema`, and the strict object refuses one.
 *   The test below asserts the resulting row instead.
 * - The account lookup dropped, so `tx.user.create` runs unconditionally again:
 *   „makes an existing person the first administrator" red with the 409 that
 *   was the review finding.
 * - The lookup kept but the attach turned into an `upsert` that writes the
 *   typed name and password: the same test red at `toStrictEqual(before)`,
 *   naming the columns that moved.
 */

const PASSWORD = 'test-password-b9';
const TENANTS = apiPath('/admin/tenants');

describe('the superadmin overview and creating an organisation ', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  let existing: TenantFixture;
  let superadmin: string;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    /*
     * **The first administrator is invited** (ADR-0024), and an invitation
     * needs the mail server of the instance and the base address.
     * Without both, every creation answered 422 — the counter-check for that
     * stands below in a block of its own with an application of its own.
     */
    testApp = await createTestApp({
      databaseUrl: database.url,
      systemMail: {
        publicBaseUrl: TEST_PUBLIC_BASE_URL,
        smtp: TEST_SYSTEM_SMTP_BLOCK,
      },
    });

    existing = await createTenant(testApp.prisma, 'OVWA');
    const root = await createUser(testApp.prisma, {
      email: 'root@overview.example',
      password: PASSWORD,
      tenants: [existing],
      isSuperadmin: true,
    });
    superadmin = await openSession(testApp, root.id, existing.id);
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  async function overview() {
    const response = await request(app().server)
      .get(TENANTS)
      .set('Cookie', cookieHeader(superadmin));
    expect(response.status).toBe(200);
    // Parsed against the shared schema rather than read loosely: it is a
    // `strictObject`, so a column that started travelling would fail here
    // instead of arriving unnoticed (the positive-list argument).
    return parseTenantOverview(response.body);
  }

  // `object`, not `unknown`: supertest's `send` takes one, and every call below
  // sends a document — including the ones the server must refuse, which are
  // refused for what they contain.
  function createTenantRequest(body: object) {
    return request(app().server)
      .post(TENANTS)
      .set(authedMutation(superadmin))
      .send(body);
  }

  function newTenant(shortName: string, email: string) {
    return {
      shortName,
      name: `Verein ${shortName}`,
      // No password any more (ADR-0024): the person gets an invitation.
      admin: { email, name: `${shortName} Administrator` },
    };
  }

  // ═════════════════════════════════════════════════════════════════════════
  // The overview
  // ═════════════════════════════════════════════════════════════════════════

  it('lists every organisation with its counters and the KPI totals', async () => {
    const before = await overview();
    const created = await createTenantRequest(
      newTenant('OVWB', 'admin@ovwb.example'),
    );
    expect(created.status).toBe(201);

    const after = await overview();
    expect(after.tenants.length).toBe(before.tenants.length + 1);
    expect(after.totals.tenants).toBe(after.tenants.length);

    const row = after.tenants.find(
      (candidate) => candidate.tenant.shortName === 'OVWB',
    );
    expect(row).toBeDefined();
    // The organisation exists, has its first administrator and nothing else yet.
    expect(row?.users).toBe(1);
    expect(row?.forms).toBe(0);
    expect(row?.responses).toBe(0);
    // „nur lokal" — a fresh Organisation has no identity provider configured, which is
    // also why its first administrator is necessarily a local account.
    expect(row?.oidcEnabled).toBe(false);
    // The totals are the sum of the rows, not a second count that could differ.
    expect(after.totals.users).toBe(
      after.tenants.reduce((total, entry) => total + entry.users, 0),
    );
  });

  it('carries no stored value of any Organisation — only identity, branding, numbers', async () => {
    // The one cross-tenant listing this application has. An organisation's access word
    // lives in `form_defaults`; that column is not even selected
    // (`TENANT_OVERVIEW_SELECT`), and the payload is an allow list.
    const word = 'geheimes-bundwort';
    await app().prisma.tenant.update({
      where: { id: existing.id },
      data: {
        formDefaults: { password: word },
        oidcIssuer: 'https://idp.test',
      },
    });

    const response = await request(app().server)
      .get(TENANTS)
      .set('Cookie', cookieHeader(superadmin));

    expect(response.status).toBe(200);
    expect(response.text).not.toContain(word);
    expect(response.text).not.toContain('idp.test');

    await app().prisma.tenant.update({
      where: { id: existing.id },
      data: { formDefaults: {}, oidcIssuer: null },
    });
  });

  it('answers 404 for an organisation that does not exist', async () => {
    const response = await request(app().server)
      .get(`${TENANTS}/00000000-0000-4000-8000-000000000000`)
      .set('Cookie', cookieHeader(superadmin));

    expect(response.status).toBe(404);
    expect(response.text).toContain(TENANT_NOT_FOUND_MESSAGE);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // A new Organisation is usable at once, and it keeps inheriting
  // ═════════════════════════════════════════════════════════════════════════

  describe('creating an organisation', () => {
    it('gives it the three standard groups and one working administrator', async () => {
      const created = await createTenantRequest(
        newTenant('NEWA', 'admin@newa.example'),
      );
      expect(created.status).toBe(201);
      const { tenant } = created.body as { tenant: { id: string } };

      const groups = await app().prisma.group.findMany({
        where: { tenantId: tenant.id },
        orderBy: { rank: 'desc' },
        select: {
          name: true,
          rank: true,
          isSystem: true,
          canManageUsers: true,
        },
      });
      expect(groups.map((group) => group.name)).toStrictEqual([
        'admin',
        'editor',
        'viewer',
      ]);
      // Exactly one system group, and it is the one that can administer.
      expect(groups.filter((group) => group.isSystem).length).toBe(1);
      expect(groups[0]?.canManageUsers).toBe(true);

      /*
       * „sofort arbeitsfähig" measured the only way that means anything: the
       * first administrator signs in and reaches the organisation's own routes.
       *
       * **With one step more since ADR-0024**, and the step is the heart of
       * the matter — the account comes into being without a password, the
       * person sets it over their invitation link. The case therefore goes
       * through the real redemption route and with the real token — rebuilt
       * from the id of the row and the signing key of this application,
       * because it stands in no column (`support/invitations.ts`).
       *
       * What that proves along the way: the path from „+ Neue Organisation" to
       * the first sign-in is complete, without anybody having typed somebody
       * else's password.
       */
      await redeemInvitation(app(), 'admin@newa.example', PASSWORD);
      const session = await login(app(), 'admin@newa.example', PASSWORD);
      const users = await request(app().server)
        .get(apiPath('/tenant/users'))
        .set('Cookie', cookieHeader(session));
      expect(users.status).toBe(200);
    });

    /**
     * **What the standard groups `editor` and `viewer` reach — and what
     * not** ([ADR-0021](../../../../docs/architecture/0021-recht-formular-einstellungen.md)).
     *
     * The place is this one on purpose: the groups come into being here, over
     * the real route, out of `DEFAULT_GROUPS`. A case that builds its group
     * itself checks the combination it typed — not the one a new organisation
     * really gets.
     *
     * **Both directions** are measured, because only together do they prove
     * the separation:
     *
     * - `editor` reaches the four surfaces **of one form** and is refused at
     *   the **organisation-wide** routes;
     * - `viewer` reaches none of the four.
     *
     * *Counter-check:* `canManageFormSettings` in `DEFAULT_GROUPS` set to
     * `false` for `editor` → the four 200s go red. Setting it to `true` for
     * `viewer` as well → the four 403s go red. `canManageSettings` set to
     * `true` for `editor` → the three organisation-wide 403s go red.
     */
    it('gives editor the four form surfaces and viewer none, and neither the organisation-wide ones', async () => {
      const created = await createTenantRequest(
        newTenant('NEWE', 'admin@newe.example'),
      );
      expect(created.status).toBe(201);
      const { tenant } = created.body as { tenant: { id: string } };

      const groups = await app().prisma.group.findMany({
        where: { tenantId: tenant.id },
      });
      const groupId = (name: string): string => {
        const found = groups.find((group) => group.name === name);
        if (found === undefined) {
          throw new Error(`the new organisation has no ${name} group`);
        }
        return found.id;
      };

      async function sessionIn(email: string, group: string): Promise<string> {
        const user = await app().prisma.user.create({
          data: {
            email,
            name: email,
            passwordHash: await hashPassword(PASSWORD),
            memberships: {
              create: { tenantId: tenant.id, groupId: groupId(group) },
            },
          },
        });
        return openSession(app(), user.id, tenant.id);
      }

      const editor = await sessionIn('editor@newe.example', 'editor');
      const viewer = await sessionIn('viewer@newe.example', 'viewer');

      const form = await app().prisma.form.create({
        data: {
          tenantId: tenant.id,
          title: 'Anmeldung NEWE',
          draftSchema: { pages: [] },
          publicSlug: 'slug-newe-anmeldung',
        },
      });

      /** The four surfaces of the form menu, reading. */
      const FORM_SURFACES = [
        `/forms/${form.id}/settings`,
        `/forms/${form.id}/notifications`,
        `/mail-log?formId=${form.id}`,
        `/forms/${form.id}/members`,
      ];
      /** What `can_manage_settings` unlocks and `editor` does not get. */
      const ORGANISATION_SURFACES = [
        '/tenant/form-defaults',
        '/tenant/branding',
        '/tenant/oidc',
      ];

      const status = (session: string, path: string): Promise<number> =>
        request(app().server)
          .get(apiPath(path))
          .set('Cookie', cookieHeader(session))
          .then((response) => response.status);

      for (const path of FORM_SURFACES) {
        expect([path, await status(editor, path)]).toStrictEqual([path, 200]);
        expect([path, await status(viewer, path)]).toStrictEqual([path, 403]);
      }
      for (const path of ORGANISATION_SURFACES) {
        expect([path, await status(editor, path)]).toStrictEqual([path, 403]);
        expect([path, await status(viewer, path)]).toStrictEqual([path, 403]);
      }
    });

    it('does not make the first administrator a superadmin', async () => {
      const created = await createTenantRequest(
        newTenant('NEWB', 'admin@newb.example'),
      );
      expect(created.status).toBe(201);

      const user = await app().prisma.user.findUniqueOrThrow({
        where: { email: 'admin@newb.example' },
        select: { id: true, isSuperadmin: true, passwordHash: true },
      });
      expect(user.isSuperadmin).toBe(false);
      /*
       * **And without a password** (ADR-0024). „Argon2id, never the plaintext"
       * once stood here; the line went with the field, and what takes its
       * place is the sharper statement: there is no hash at all that somebody
       * could have typed. That the account is reachable all the same hangs on
       * the invitation row beside it — which is why that row stands in the
       * same case.
       */
      expect(user.passwordHash).toBeNull();
      const invitation = await app().prisma.passwordResetToken.findFirstOrThrow(
        { where: { userId: user.id } },
      );
      expect(invitation.kind).toBe('invitation');
      expect(invitation.usedAt).toBeNull();
    });

    it('leaves form_defaults empty — the weak half of the proof', async () => {
      const created = await createTenantRequest(
        newTenant('NEWC', 'admin@newc.example'),
      );
      expect(created.status).toBe(201);
      const { tenant } = created.body as { tenant: { id: string } };

      const row = await app().prisma.tenant.findUniqueOrThrow({
        where: { id: tenant.id },
        select: { formDefaults: true },
      });
      expect(row.formDefaults).toStrictEqual({});
    });

    /**
     * **The load-bearing half**: what a fresh organisation *means*.
     *
     * „eine spätere Änderung der Systemzeile erreicht diese Organisation" once
     * stood here — that row does not exist any more (ADR-0011, continuation
     * 2026-08-14; review finding 9). What remains and is worth more than the
     * look into the empty column: the organisation really does *inherit*, and
     * inherits the shipped default, in every section — measured against its
     * own standards route instead of against the column the case above already
     * looks at.
     */
    it('inherits the shipped defaults in every section afterwards', async () => {
      const created = await createTenantRequest(
        newTenant('NEWD', 'admin@newd.example'),
      );
      expect(created.status).toBe(201);
      // Redeem the invitation, then sign in (ADR-0024) — see the case further
      // up for why that is two steps now.
      await redeemInvitation(app(), 'admin@newd.example', PASSWORD);
      const session = await login(app(), 'admin@newd.example', PASSWORD);

      const standards = await request(app().server)
        .get(apiPath('/tenant/form-defaults'))
        .set('Cookie', cookieHeader(session));
      expect(standards.status).toBe(200);

      /*
       * **The whole set, not one field of it** (review finding 10).
       *
       * Since the section switches of this layer are gone, there is no
       * `overridden: {…}, values: {}` any more from which „nichts entschieden"
       * could be read off — the answer carries a complete document. What keeps
       * the case load-bearing all the same is the comparison against
       * `TENANT_SETTINGS_FLOOR`: a fresh organisation shows the shipped
       * default field by field. A „copying at creation time" that freezes
       * today's values would look identical here on the first day — which is
       * why the column stands beside it, and it is empty (the case above).
       */
      expect(
        (standards.body as { values: TenantFormSettings }).values,
      ).toStrictEqual(TENANT_SETTINGS_FLOOR);

      // The column itself stays empty: the default is read, nothing is
      // stored — only that way does a later change to the default still reach
      // this organisation at all.
      const { tenant } = created.body as { tenant: { id: string } };
      const row = await app().prisma.tenant.findUniqueOrThrow({
        where: { id: tenant.id },
        select: { formDefaults: true },
      });
      expect(row.formDefaults).toStrictEqual({});
    });

    /**
     * **The opposite choice from `form_defaults`, and deliberately so**
     * (ADR-0032). There is no installation-wide row left for notification
     * templates to inherit from any more — the organisation's own row is the
     * whole answer from the moment it exists, so this checks that it is
     * genuinely **written**, not left empty the way `form_defaults` is.
     */
    it('seeds the shipped notification templates for a freshly created organisation', async () => {
      const created = await createTenantRequest(
        newTenant('NEWE', 'admin@newe.example'),
      );
      expect(created.status).toBe(201);
      await redeemInvitation(app(), 'admin@newe.example', PASSWORD);
      const session = await login(app(), 'admin@newe.example', PASSWORD);

      const templates = await request(app().server)
        .get(apiPath('/tenant/notification-templates'))
        .set('Cookie', cookieHeader(session));
      expect(templates.status).toBe(200);
      expect(
        (templates.body as { templates: unknown[]; decided: boolean }).decided,
        'a fresh organisation already has its own document — not the ' +
          '"nichts entschieden" state a merely tolerant fallback would show',
      ).toBe(true);
      expect(
        (templates.body as { templates: NotificationTemplate[] }).templates,
      ).toEqual(NOTIFICATION_TEMPLATES_FLOOR);

      // And the column itself carries the document — unlike `form_defaults`
      // above, which stays empty on purpose.
      const { tenant } = created.body as { tenant: { id: string } };
      const row = await app().prisma.tenant.findUniqueOrThrow({
        where: { id: tenant.id },
        select: { notificationTemplates: true },
      });
      expect(row.notificationTemplates).toEqual(NOTIFICATION_TEMPLATES_FLOOR);
    });

    it('refuses a Kurzname that is already taken', async () => {
      const first = await createTenantRequest(
        newTenant('DUPE', 'admin@dupe.example'),
      );
      expect(first.status).toBe(201);

      const second = await createTenantRequest(
        newTenant('DUPE', 'zweiter@dupe.example'),
      );
      expect(second.status).toBe(409);
      expect(second.text).toContain(SHORT_NAME_TAKEN_MESSAGE);
    });

    /**
     * **The other direction of „erster Administrator": somebody who already
     * has an account** (review finding).
     *
     * `user.email` is unique installation-wide, so creating unconditionally
     * answered 409 for everybody who already serves any Organisation — and „dieselbe
     * Person kann mehreren Organisationen dienen" is the case the tenant switcher
     * exists for. The pair to this is the test above, which creates a fresh
     * account for an unknown address; between them they say that both
     * directions work.
     *
     * The load-bearing half is the raw row: attaching must write **nothing** to
     * an account the superadmin does not own. Read before and after and
     * compared as a whole — `updated_at` included, which is what makes „nichts
     * geschrieben" a statement rather than a spot check.
     */
    it('makes an existing person the first administrator without writing to their account', async () => {
      const email = 'admin@dupe.example';
      /*
       * **First make it a finished account** (ADR-0024). The address comes
       * from the case above and has carried an open invitation ever since, so
       * no password — and the case here is about a person who already works
       * and for whom the creation of a *second* organisation must rewrite
       * nothing. Without the redemption, „with the credentials the person
       * already had" would be a statement about credentials that do not exist.
       */
      await redeemInvitation(app(), email, PASSWORD);

      const before = await app().prisma.user.findUniqueOrThrow({
        where: { email },
      });

      const created = await createTenantRequest(newTenant('LINK', email));
      expect(created.status).toBe(201);
      const { tenant } = created.body as { tenant: { id: string } };

      const after = await app().prisma.user.findUniqueOrThrow({
        where: { email },
      });
      // Every column of the row, not the ones we expected to be interesting:
      // the name and the password hash the request carried are **not** in it.
      expect(after).toStrictEqual(before);
      expect(after.name).not.toBe('LINK Administrator');

      // …and the person really is the new organisation's administrator: one further
      // membership, in the system group of the organisation that was just created.
      const memberships = await app().prisma.membership.findMany({
        where: { userId: before.id },
        select: { tenantId: true, group: { select: { name: true } } },
      });
      expect(memberships.length).toBe(2);
      const fresh = memberships.find(
        (membership) => membership.tenantId === tenant.id,
      );
      expect(fresh?.group.name).toBe('admin');

      // „sofort arbeitsfähig" for this organisation too — with the credentials the
      // person already had, since the typed password was not applied to a row
      // that belongs to somebody else.
      const session = await login(app(), email, PASSWORD);
      const switched = await request(app().server)
        .put(apiPath('/session/tenant'))
        .set(authedMutation(session))
        .send({ tenantId: tenant.id });
      expect(switched.status).toBe(200);

      const users = await request(app().server)
        .get(apiPath('/tenant/users'))
        .set('Cookie', cookieHeader(session));
      expect(users.status).toBe(200);
    });

    /**
     * The one case that is still a 409 about an address — and it is a race, not
     * a person: both requests looked before either wrote.
     *
     * Asserted as an invariant rather than as a fixed pair of statuses, because
     * both interleavings are legitimate. If the winner committed first, the
     * loser simply attaches the account and both organisations are created — the
     * ordinary „eine Person, zwei Organisationen". If not, the loser meets
     * `user.email @unique` and has to be told to try again. What must not
     * happen either way is a second row for the address or a 500 naming a
     * PostgreSQL index.
     */
    it('mints no second account for one address when two creations race', async () => {
      const email = 'race@dupe.example';
      const [first, second] = await Promise.all([
        createTenantRequest(newTenant('RACA', email)),
        createTenantRequest(newTenant('RACB', email)),
      ]);

      const statuses = [first.status, second.status].sort((a, b) => a - b);
      expect(statuses[0]).toBe(201);
      expect([201, 409]).toContain(statuses[1]);
      if (statuses[1] === 409) {
        const loser = first.status === 409 ? first : second;
        expect(loser.text).toContain(ADMIN_EMAIL_TAKEN_MESSAGE);
      }
      expect(await app().prisma.user.count({ where: { email } })).toBe(1);
    });

    /**
     * **„Mich selbst als ersten Administrator eintragen"** (review finding 7).
     *
     * The way the form did not offer before and the server did not want: create
     * an organisation and work in it oneself, without inventing a second
     * account. `admin: null` says that, and *who* is meant is decided by the
     * server from the session.
     *
     * Both are measured, because only together do they prove the decision:
     *
     * - **no** account comes into being (the counter over `user`), and
     * - the signed-in account afterwards has a membership in the `admin` group
     *   of exactly this organisation and reaches its routes.
     *
     * *Counter-check:* `actorId` in `AdminService.create` replaced by an id
     * from the request body → there is no such field, the schema refuses the
     * request; the membership below goes red as soon as the id is no longer
     * the one of the session.
     */
    it('makes the signed-in superadmin the first administrator when the payload says so', async () => {
      const usersBefore = await app().prisma.user.count();
      const rootBefore = await app().prisma.user.findUniqueOrThrow({
        where: { email: 'root@overview.example' },
      });

      const created = await createTenantRequest({
        shortName: 'SELF',
        name: 'Verein SELF',
        admin: null,
      });
      expect(created.status).toBe(201);
      const { tenant } = created.body as { tenant: { id: string } };

      // No second account — that is the whole point of the switch.
      expect(await app().prisma.user.count()).toBe(usersBefore);
      // …and nothing was written to the existing one: name, password and
      // `updated_at` belong to the person, not to the act of creation.
      expect(
        await app().prisma.user.findUniqueOrThrow({
          where: { email: 'root@overview.example' },
        }),
      ).toStrictEqual(rootBefore);

      const membership = await app().prisma.membership.findFirstOrThrow({
        where: { tenantId: tenant.id, userId: rootBefore.id },
        select: { group: { select: { name: true } } },
      });
      expect(membership.group.name).toBe('admin');

      // „sofort arbeitsfähig", measured as with the typed account: the session
      // switches into the new organisation and reaches its own routes.
      const switched = await request(app().server)
        .put(apiPath('/session/tenant'))
        .set(authedMutation(superadmin))
        .send({ tenantId: tenant.id });
      expect(switched.status).toBe(200);

      const users = await request(app().server)
        .get(apiPath('/tenant/users'))
        .set('Cookie', cookieHeader(superadmin));
      expect(users.status).toBe(200);

      // Put the session back: the other cases of this file run with the same
      // one and expect the organisation it began in.
      const back = await request(app().server)
        .put(apiPath('/session/tenant'))
        .set(authedMutation(superadmin))
        .send({ tenantId: existing.id });
      expect(back.status).toBe(200);
    });

    /**
     * **And the forbidden case fails** (`AGENTS.md`: every permission rule
     * needs a test that sees the disallowed access fail).
     *
     * An organisation admin — `can_manage_users` in their own organisation,
     * that is the highest role an organisation can grant — does not get through
     * on this route, neither with a typed account nor with `admin: null`. The
     * second case is the one this finding adds: it would be the way to create
     * an organisation for oneself and be its administrator.
     *
     * 403 and not 404: the caller is signed in, and the route is no secret
     * (`AdminTenantsController`).
     */
    it('refuses both ways to an organisation admin who is no superadmin', async () => {
      const outsider = await createUser(testApp.prisma, {
        email: 'admin@ovwa.example',
        password: PASSWORD,
        tenants: [existing],
      });
      const session = await openSession(testApp, outsider.id, existing.id);

      for (const body of [
        newTenant('NOPE1', 'admin@nope1.example'),
        { shortName: 'NOPE2', name: 'Verein NOPE2', admin: null },
      ]) {
        const response = await request(app().server)
          .post(TENANTS)
          .set(authedMutation(session))
          .send(body);
        expect(response.status).toBe(403);
      }

      // Nothing came into being — neither the organisation nor a membership
      // that would put this person higher than before.
      expect(
        await app().prisma.tenant.count({
          where: { shortName: { in: ['NOPE1', 'NOPE2'] } },
        }),
      ).toBe(0);
      expect(
        await app().prisma.membership.count({ where: { userId: outsider.id } }),
      ).toBe(1);
    });

    it('refuses a payload that tries to bring form standards along', async () => {
      // The absence in `tenantCreateSchema` is what is being checked, and a strict
      // object is what makes it one: „kein Feld dafür" has to mean the request
      // fails, not that the extra key is quietly dropped.
      const response = await createTenantRequest({
        ...newTenant('NOPE', 'admin@nope.example'),
        formDefaults: { confirmTitle: 'Kopiert' },
      });

      expect(response.status).toBe(400);
      expect(
        await app().prisma.tenant.count({ where: { shortName: 'NOPE' } }),
      ).toBe(0);
    });
  });
});
