import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { formMemberWriteSchema, type FormMemberList } from '@formsache/shared';
import type { FormPermission } from '@prisma/client';

import { FORM_NOT_FOUND_MESSAGE } from '../../src/common/form-not-found';
import { hashPassword } from '../../src/auth/password';
import { MISSING_PERMISSION_MESSAGE } from '../../src/tenancy/group-permission.guard';
import {
  ADMIN_NOT_RESTRICTABLE_MESSAGE,
  CAP_GROUP_UNKNOWN_MESSAGE,
  CAP_MUST_LOWER_MESSAGE,
  MEMBER_NOT_FOUND_MESSAGE,
  SELF_CAP_LOCKOUT_MESSAGE,
  SELF_LOCKOUT_MESSAGE,
} from '../../src/tenancy/form-permission.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
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
 * The requirement — *Nutzerrechte je Formular* — against real routes and real
 * PostgreSQL.
 *
 * The chain under test is *tenant scope → group permissions → **form restriction***
 * and the fourth link can only take away. Every guarantee below is asserted
 * through the case that must **fail**: a suite showing that an unrestricted
 * viewer reads their answers would stay green against a guard that was never
 * applied.
 *
 * Two habits this file keeps on purpose, both bought with earlier defects:
 *
 * - **status *and* body are compared with the „unknown id" answer.** Once,
 *   removing `tenantId` from `mailLog.findById` left the whole suite green
 *   because the difference was 409 against 404. „Hat nicht geklappt" is not a
 *   boundary; „ist von der unbekannten ID nicht zu unterscheiden" is.
 * - **the whole payload is searched**, never just the field a mapper happens to
 *   fill. A restriction applied after the load would leave the row in the
 *   response and merely unrendered.
 */

const PASSWORD = 'test-password';
const SETUP_TIMEOUT_MS = 180_000;

/** A uuid of the right shape that belongs to nothing. */
const ABSENT_UUID = '01919c3f-0000-7000-8000-000000000000';

describe('per-form restrictions', () => {
  let database: TestDatabase | undefined;
  let testApp: TestApp;
  let prisma: PrismaService;

  let alpha: TenantFixture;
  let beta: TenantFixture;

  /** ALPHA's admin — unrestrictable, and the one who edits the restrictions. */
  let alphaAdmin: { id: string; token: string };
  /** BETA's admin — the foreign Organisation of every isolation probe. */
  let betaAdmin: { id: string; token: string };
  /** ALPHA viewer: may see answers and export, and *is* restrictable. */
  let viewer: { id: string; token: string; groupId: string };
  /** A second ALPHA member, so „the list is empty" can never be the reason. */
  let editor: { id: string; token: string; groupId: string };
  /** The group a cap lowers **to**: sees answers, may not export. */
  let cappedGroupId: string;
  /**
   * A member who may **build** and may not see answers, and a cap group that
   * holds the mirror image of that pair — see the case they exist for
   * („measures the intersection").
   */
  let builder: { id: string; token: string; groupId: string };
  let mirrorGroupId: string;

  /** ALPHA's form, and BETA's — both with one answer, so a table is non-empty. */
  let alphaFormId: string;
  let betaFormId: string;

  const server = () => testApp.server;

  /**
   * A `form_permission` row written **straight into PostgreSQL** — no service,
   * no route.
   *
   * The whole of the evidence's second half rests on this: the promise „ein
   * Administrator sieht immer alles" must not depend on which way a row got
   * into the table, so the row this suite plants is one no route would ever
   * write.
   */
  async function rawInsert(
    formId: string,
    userId: string,
    accessRevoked: boolean,
    cappedGroup: string | null,
  ): Promise<void> {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "form_permission"
         ("id", "tenant_id", "form_id", "user_id", "access_revoked",
          "capped_group_id", "created_at", "updated_at")
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::boolean,
               $5::uuid, now(), now())`,
      alpha.id,
      formId,
      userId,
      accessRevoked,
      cappedGroup,
    );
  }

  /** What the table actually holds — never what a route reported it holds. */
  function storedRow(
    formId: string,
    userId: string,
  ): Promise<FormPermission | null> {
    return prisma.formPermission.findFirst({ where: { formId, userId } });
  }

  async function createMember(options: {
    readonly email: string;
    readonly groupName: string;
    readonly rank: number;
    readonly permissions: Partial<{
      canBuild: boolean;
      canViewResponses: boolean;
      canExport: boolean;
      canManageSettings: boolean;
      canManageFormSettings: boolean;
      canManageUsers: boolean;
    }>;
  }): Promise<{ id: string; token: string; groupId: string }> {
    const group = await prisma.group.create({
      data: {
        tenantId: alpha.id,
        name: options.groupName,
        color: '#5b6b52',
        rank: options.rank,
        isSystem: false,
        canBuild: options.permissions.canBuild ?? false,
        canViewResponses: options.permissions.canViewResponses ?? false,
        canExport: options.permissions.canExport ?? false,
        canManageSettings: options.permissions.canManageSettings ?? false,
        canManageFormSettings:
          options.permissions.canManageFormSettings ?? false,
        canManageUsers: options.permissions.canManageUsers ?? false,
      },
    });
    const user = await prisma.user.create({
      data: {
        email: options.email,
        name: `Test ${options.email}`,
        passwordHash: await hashPassword(PASSWORD),
      },
    });
    await prisma.membership.create({
      data: { tenantId: alpha.id, userId: user.id, groupId: group.id },
    });
    return {
      id: user.id,
      token: await openSession(testApp, user.id, alpha.id),
      groupId: group.id,
    };
  }

  /** A form of `tenant` with one published version and one answer. */
  async function createFormWithAnswer(
    tenant: TenantFixture,
    title: string,
    slug: string,
  ): Promise<string> {
    const definition = {
      pages: [
        {
          id: '019fd000-0000-7000-8000-0000000000a0',
          title: 'Seite 1',
          questions: [
            {
              id: '019fd000-0000-7000-8000-000000000001',
              type: 'text',
              label: 'Name',
              hint: null,
              required: true,
              width: 'full',
              minLength: null,
              maxLength: null,
              pattern: null,
            },
          ],
        },
      ],
    };

    const form = await prisma.form.create({
      data: {
        tenantId: tenant.id,
        title,
        draftSchema: definition,
        publicSlug: slug,
        status: 'active',
      },
    });
    const version = await prisma.formVersion.create({
      data: {
        tenantId: tenant.id,
        formId: form.id,
        version: 1,
        schema: definition,
      },
    });
    await prisma.form.update({
      where: { id: form.id },
      data: { publishedVersionId: version.id },
    });
    await prisma.response.create({
      data: {
        tenantId: tenant.id,
        formId: form.id,
        formVersionId: version.id,
        answers: { '019fd000-0000-7000-8000-000000000001': 'Fuchsmajor' },
      },
    });
    return form.id;
  }

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });
    prisma = testApp.prisma;

    alpha = await createTenant(prisma, 'ALPHA');
    beta = await createTenant(prisma, 'BETA');

    const alphaAdminUser = await createUser(prisma, {
      email: 'admin-alpha@example.org',
      password: PASSWORD,
      tenants: [alpha],
    });
    alphaAdmin = {
      id: alphaAdminUser.id,
      token: await openSession(testApp, alphaAdminUser.id, alpha.id),
    };

    const betaAdminUser = await createUser(prisma, {
      email: 'admin-beta@example.org',
      password: PASSWORD,
      tenants: [beta],
    });
    betaAdmin = {
      id: betaAdminUser.id,
      token: await openSession(testApp, betaAdminUser.id, beta.id),
    };

    viewer = await createMember({
      email: 'viewer@example.org',
      groupName: 'viewer',
      rank: 20,
      // Both, because the evidence names the CSV download and the
      // export route requires `canViewResponses` **and** `canExport`.
      // A viewer without export could not tell „die Restriktion greift" apart
      // from „diese Gruppe durfte ohnehin nicht exportieren".
      permissions: { canViewResponses: true, canExport: true },
    });
    editor = await createMember({
      email: 'editor@example.org',
      groupName: 'editor',
      rank: 60,
      permissions: {
        canBuild: true,
        canViewResponses: true,
        canExport: true,
        canManageSettings: true,
        canManageFormSettings: true,
      },
    });

    const capped = await prisma.group.create({
      data: {
        tenantId: alpha.id,
        name: 'nur-lesen',
        color: '#212226',
        rank: 10,
        isSystem: false,
        canViewResponses: true,
        // No export — this is what a cap takes away in the tests below.
        canExport: false,
      },
    });
    cappedGroupId = capped.id;

    builder = await createMember({
      email: 'builder@example.org',
      groupName: 'baumeister',
      rank: 50,
      // May build, may **not** see answers — the pair matters, see below.
      permissions: { canBuild: true },
    });
    const mirror = await prisma.group.create({
      data: {
        tenantId: alpha.id,
        name: 'spiegel',
        color: '#212226',
        rank: 15,
        isSystem: false,
        // The mirror image of the builder's own group: it holds exactly the
        // permission they lack and lacks exactly the one they hold. That is
        // what makes „Schnittmenge" and „Zuweisung" tell each other apart.
        canBuild: false,
        canViewResponses: true,
      },
    });
    mirrorGroupId = mirror.id;

    alphaFormId = await createFormWithAnswer(
      alpha,
      'Anmeldung ALPHA',
      'slug-alpha-form-permission',
    );
    betaFormId = await createFormWithAnswer(
      beta,
      'Anmeldung BETA',
      'slug-beta-form-permission',
    );
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, SETUP_TIMEOUT_MS);

  beforeEach(async () => {
    // Every case states its own restrictions. A row surviving into the next
    // test would make a green run mean „irgendetwas war gesperrt".
    await prisma.formPermission.deleteMany({});
  });

  // -------------------------------------------------------------------------
  // the evidence — the forbidden case, on all three ways to the answers
  // -------------------------------------------------------------------------

  describe('the evidence: revoked access answers 404, indistinguishably', () => {
    /**
     * The reference answer: what an id that belongs to nothing produces. Every
     * assertion below compares against **this**, status and body, because
     * „another status than 200" is not a boundary — a lesson learned before.
     */
    async function unknownIdAnswer(
      path: (id: string) => string,
      token: string = viewer.token,
    ): Promise<{ status: number; text: string }> {
      const response = await request(server())
        .get(apiPath(path(ABSENT_UUID)))
        .set('Cookie', cookieHeader(token));
      return { status: response.status, text: response.text };
    }

    beforeEach(async () => {
      await rawInsert(alphaFormId, viewer.id, true, null);
    });

    it('refuses the answers of a form the viewer is locked out of', async () => {
      const reference = await unknownIdAnswer((id) => `/forms/${id}/responses`);
      const response = await request(server())
        .get(apiPath(`/forms/${alphaFormId}/responses`))
        .set('Cookie', cookieHeader(viewer.token));

      expect(response.status).toBe(404);
      expect(response.status).toBe(reference.status);
      expect(response.text).toBe(reference.text);
      expect(response.text).toContain(FORM_NOT_FOUND_MESSAGE);

      // The control: the same request without the restriction succeeds, so the
      // 404 is about the restriction and not about a broken fixture.
      await prisma.formPermission.deleteMany({});
      const allowed = await request(server())
        .get(apiPath(`/forms/${alphaFormId}/responses`))
        .set('Cookie', cookieHeader(viewer.token));
      expect(allowed.status).toBe(200);
      expect(allowed.body).toHaveLength(1);
    });

    it('refuses the form detail', async () => {
      const reference = await unknownIdAnswer((id) => `/forms/${id}`);
      const response = await request(server())
        .get(apiPath(`/forms/${alphaFormId}`))
        .set('Cookie', cookieHeader(viewer.token));

      expect(response.status).toBe(404);
      expect(response.status).toBe(reference.status);
      expect(response.text).toBe(reference.text);
    });

    /**
     * **The CSV download gets its own case** : the
     * export is the way a gap was left open once — the review gate found `can_export`
     * opening it without `can_view_responses` — and „ist ja dieselbe Route" is
     * exactly the sentence that left it open. It is not the same route: it has
     * its own permission pair, its own handler and its own response type.
     */
    it('refuses the CSV download', async () => {
      const reference = await unknownIdAnswer(
        (id) => `/forms/${id}/export.csv`,
      );
      const response = await request(server())
        .get(apiPath(`/forms/${alphaFormId}/export.csv`))
        .set('Cookie', cookieHeader(viewer.token));

      expect(response.status).toBe(404);
      expect(response.status).toBe(reference.status);
      expect(response.text).toBe(reference.text);
      // Nothing of the answers travelled in the body of the refusal either.
      expect(response.text).not.toContain('Fuchsmajor');

      // The control — the same download without the row hands the answers over.
      await prisma.formPermission.deleteMany({});
      const allowed = await request(server())
        .get(apiPath(`/forms/${alphaFormId}/export.csv`))
        .set('Cookie', cookieHeader(viewer.token));
      expect(allowed.status).toBe(200);
      expect(allowed.text).toContain('Fuchsmajor');
    });

    it('refuses the response columns as well', async () => {
      // Status **and** body against the unknown id, like every case above —
      // `toContain(FORM_NOT_FOUND_MESSAGE)` alone would have accepted a 403
      // that happens to carry the same sentence, and „hat nicht geklappt" is
      // not the guarantee (see the habits noted at the top of this file).
      const reference = await unknownIdAnswer(
        (id) => `/forms/${id}/responses/columns`,
      );
      const response = await request(server())
        .get(apiPath(`/forms/${alphaFormId}/responses/columns`))
        .set('Cookie', cookieHeader(viewer.token));

      expect(response.status).toBe(404);
      expect(response.status).toBe(reference.status);
      expect(response.text).toBe(reference.text);
      expect(response.text).toContain(FORM_NOT_FOUND_MESSAGE);
    });

    /**
     * The settings and the notifications of the same form, which the requirement
     * does not name and which would have been the next hole of the same shape.
     *
     * They are probed with the **editor**, not the viewer: the settings routes
     * need `canManageSettings`, so a viewer's refusal would come from the third
     * link and prove nothing about the fourth. The editor holds the right, and
     * the lock has to be theirs — hence its own row.
     */
    it('refuses the settings and the notifications of a locked form', async () => {
      await rawInsert(alphaFormId, editor.id, true, null);

      // The reference answers are fetched **with the editor's own session**,
      // because these two routes need `canManageSettings` — a reference taken
      // as the viewer would be a 403 and the comparison would prove nothing.
      for (const suffix of ['settings', 'notifications']) {
        const reference = await unknownIdAnswer(
          (id) => `/forms/${id}/${suffix}`,
          editor.token,
        );
        const response = await request(server())
          .get(apiPath(`/forms/${alphaFormId}/${suffix}`))
          .set('Cookie', cookieHeader(editor.token));

        expect(response.status).toBe(404);
        expect(response.status).toBe(reference.status);
        expect(response.text).toBe(reference.text);
        expect(response.text).toContain(FORM_NOT_FOUND_MESSAGE);
      }

      // The control: without the row the editor reaches both.
      await prisma.formPermission.deleteMany({});
      for (const path of [
        `/forms/${alphaFormId}/settings`,
        `/forms/${alphaFormId}/notifications`,
      ]) {
        const allowed = await request(server())
          .get(apiPath(path))
          .set('Cookie', cookieHeader(editor.token));
        expect(allowed.status).toBe(200);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Reproduction 1 — the restriction is in the query, not applied afterwards
  // -------------------------------------------------------------------------

  describe('the list route never loads a locked form (Nachstellung 1)', () => {
    it('carries no trace of it anywhere in the payload', async () => {
      await rawInsert(alphaFormId, viewer.id, true, null);

      const response = await request(server())
        .get(apiPath('/forms'))
        .set('Cookie', cookieHeader(viewer.token));
      expect(response.status).toBe(200);

      // The **whole** payload, not the mapped `id` field: a restriction applied
      // after the load would leave the row here — loaded, serialised and merely
      // not rendered by a client. That is an Anzeigefrage, not a boundary.
      const payload = JSON.stringify(response.body);
      expect(payload).not.toContain(alphaFormId);
      expect(payload).not.toContain('Anmeldung ALPHA');

      // The control: without the restriction the same request lists it, so the
      // empty payload above is about the lock and not about an empty Organisation.
      await prisma.formPermission.deleteMany({});
      const unlocked = await request(server())
        .get(apiPath('/forms'))
        .set('Cookie', cookieHeader(viewer.token));
      expect(JSON.stringify(unlocked.body)).toContain('Anmeldung ALPHA');
    });

    it('still lists it for everybody else in the organisation', async () => {
      await rawInsert(alphaFormId, viewer.id, true, null);

      const response = await request(server())
        .get(apiPath('/forms'))
        .set('Cookie', cookieHeader(editor.token));
      expect(JSON.stringify(response.body)).toContain('Anmeldung ALPHA');
    });
  });

  // -------------------------------------------------------------------------
  // The requirement no. 3 — the payload states the *effective* rights
  // -------------------------------------------------------------------------

  /**
   * The rights the interface renders its decisions from have to be the ones
   * that survive the fourth link, not the organisation-wide ones off the session.
   *
   * The reachable case, measured by the review gate: `FormPermissionService`
   * refuses to revoke one's **own** access outright (409, `SELF_LOCKOUT_MESSAGE`),
   * so „wer sich selbst aussperrt" does not exist server-side. What does exist
   * is the cap — a weaker group on one form — and until this field the dashboard
   * card and the form navigation read `SessionUser.memberships[].permissions`
   * and offered „Bearbeiten" to somebody the very next `PUT` answers 403.
   *
   * `editor` is the person for it: their membership holds `can_build`, so they
   * may read the list at all, and the cap group „nur-lesen" does not.
   */
  describe('the payload carries the effective rights per form', () => {
    /** The one form in the list, whichever route produced the list. */
    interface Card {
      readonly id: string;
      readonly permissions: Record<string, boolean>;
    }

    function alphaCard(body: unknown): Card {
      // `items`, since `GET /forms` answers a **page** : the
      // cards are one field of it, next to `total`/`limit`/`offset`.
      const card = (body as { items: Card[] }).items.find(
        (entry) => entry.id === alphaFormId,
      );
      if (card === undefined) {
        throw new Error('ALPHA’s form is not in the payload.');
      }
      return card;
    }

    /**
     * The person the reachable case needs: all five flags, so they may write
     * the restriction *and* read the list — and restrictable, so the row counts.
     */
    let manager: { id: string; token: string; groupId: string };
    /**
     * What they cap themselves **to**: it keeps `can_manage_users` (anything
     * else is refused with `SELF_CAP_LOCKOUT_MESSAGE`) and `can_view_responses`
     * (so the list route stays open), and drops `can_build` — the flag the
     * whole finding is about.
     */
    let keepsUsersGroupId: string;

    beforeAll(async () => {
      manager = await createMember({
        email: 'verwalter-effektiv@example.org',
        groupName: 'verwalter-effektiv',
        rank: 70,
        permissions: {
          canBuild: true,
          canViewResponses: true,
          canExport: true,
          canManageSettings: true,
          canManageFormSettings: true,
          canManageUsers: true,
        },
      });
      const keeps = await prisma.group.create({
        data: {
          tenantId: alpha.id,
          name: 'behaelt-nutzerrechte',
          color: '#212226',
          rank: 30,
          isSystem: false,
          canBuild: false,
          canViewResponses: true,
          canExport: false,
          canManageSettings: false,
          canManageFormSettings: false,
          canManageUsers: true,
        },
      });
      keepsUsersGroupId = keeps.id;
    }, SETUP_TIMEOUT_MS);

    it('reports the capped role in the list, not the tenant-wide one', async () => {
      // Written **through the route**, not planted: this is the one shape of
      // self-restriction the server accepts (revoking one's own access is 409),
      // and it is the case the review gate identified as the reachable one.
      const write = await request(server())
        .put(apiPath(`/forms/${alphaFormId}/members/${manager.id}`))
        .set(authedMutation(manager.token))
        .send({ accessRevoked: false, cappedGroupId: keepsUsersGroupId });
      expect(write.status).toBe(200);

      const response = await request(server())
        .get(apiPath('/forms'))
        .set('Cookie', cookieHeader(manager.token));
      expect(response.status).toBe(200);

      // A cap does not hide the form — it answers 403, not 404 — so the card is
      // there and has to say what may be done with it.
      expect(alphaCard(response.body).permissions).toEqual({
        canBuild: false,
        canViewResponses: true,
        canExport: false,
        canManageSettings: false,
        canManageFormSettings: false,
        canManageUsers: true,
      });

      // The refusal the old payload walked into: the very same session, the
      // route the hidden button led to.
      const build = await request(server())
        .put(apiPath(`/forms/${alphaFormId}`))
        .set(authedMutation(manager.token))
        .send({ title: 'Trotzdem', definition: {}, revision: 1 });
      expect(build.status).toBe(403);

      // …and the session still reports the **Organisation-wide** set, unchanged. Both
      // halves are needed: „das Wire-Feld ist eng" proves nothing if the
      // membership had narrowed too, and a cap must not touch the membership.
      const session = await request(server())
        .get(apiPath('/auth/me'))
        .set('Cookie', cookieHeader(manager.token));
      const memberships = (session.body as { memberships: unknown[] })
        .memberships as { permissions: Record<string, boolean> }[];
      expect(memberships[0]?.permissions.canBuild).toBe(true);
    });

    it('reports it on the detail route as well', async () => {
      await rawInsert(alphaFormId, editor.id, false, cappedGroupId);

      const response = await request(server())
        .get(apiPath(`/forms/${alphaFormId}`))
        .set('Cookie', cookieHeader(editor.token));
      expect(response.status).toBe(200);
      expect(
        (response.body as { permissions: Record<string, boolean> }).permissions
          .canBuild,
      ).toBe(false);
    });

    /**
     * The control, on the identical request: without a row the card reports the
     * membership's own five flags. „canBuild ist false" above would otherwise
     * also be true of a field hard-wired to nothing.
     */
    it('reports the membership’s own rights where no cap stands', async () => {
      const response = await request(server())
        .get(apiPath('/forms'))
        .set('Cookie', cookieHeader(editor.token));

      expect(alphaCard(response.body).permissions).toEqual({
        canBuild: true,
        canViewResponses: true,
        canExport: true,
        canManageSettings: true,
        canManageFormSettings: true,
        canManageUsers: false,
      });
    });

    /**
     * An administrator's rows are not read, so a cap smuggled onto
     * one changes the payload as little as it changes the guard.
     */
    it('ignores a cap planted on an administrator', async () => {
      await rawInsert(alphaFormId, alphaAdmin.id, false, cappedGroupId);

      const response = await request(server())
        .get(apiPath('/forms'))
        .set('Cookie', cookieHeader(alphaAdmin.token));

      expect(alphaCard(response.body).permissions).toEqual({
        canBuild: true,
        canViewResponses: true,
        canExport: true,
        canManageSettings: true,
        canManageFormSettings: true,
        canManageUsers: true,
      });
    });

    /**
     * The cap narrows **that** form and no other: a second form of the same
     * Organisation keeps the full set in the same payload. A per-form field that
     * answered the same everywhere would be the organisation-wide one under a new name.
     */
    it('narrows only the form the row stands on', async () => {
      const second = await createFormWithAnswer(
        alpha,
        'Zweites ALPHA',
        `slug-alpha-second-${String(Date.now())}`,
      );
      await rawInsert(alphaFormId, editor.id, false, cappedGroupId);

      const response = await request(server())
        .get(apiPath('/forms'))
        .set('Cookie', cookieHeader(editor.token));
      const other = (response.body as { items: Card[] }).items.find(
        (entry) => entry.id === second,
      );

      expect(alphaCard(response.body).permissions).toMatchObject({
        canBuild: false,
      });
      expect(other?.permissions).toMatchObject({ canBuild: true });

      await prisma.response.deleteMany({ where: { formId: second } });
      await prisma.form.update({
        where: { id: second },
        data: { publishedVersionId: null },
      });
      await prisma.formVersion.deleteMany({ where: { formId: second } });
      await prisma.form.delete({ where: { id: second } });
    });
  });

  // -------------------------------------------------------------------------
  // the evidence — a restriction can never raise
  // -------------------------------------------------------------------------

  describe('the evidence: a restriction can only lower', () => {
    /**
     * The structural half. `formMemberWriteSchema` is a `strictObject` with two
     * fields, and neither adds anything: there is no `permissions`, no
     * `grantedGroupId`, no flag that could travel. A request that tries to send
     * one is not „ignored", it is **refused** — so the field cannot be added to
     * a client in the belief that the server might one day honour it.
     */
    it('has no field on the wire that could grant', () => {
      expect(
        formMemberWriteSchema.safeParse({
          accessRevoked: false,
          cappedGroupId: null,
          permissions: { canExport: true },
        }).success,
      ).toBe(false);

      expect(
        formMemberWriteSchema.safeParse({
          accessRevoked: false,
          cappedGroupId: null,
        }).success,
      ).toBe(true);
    });

    /**
     * The behavioural half: a cap that is not *below* the person's role is
     * refused, and the stored row is read back **raw** — „die Anfrage kam mit
     * 422 zurück" says nothing about what is in the table.
     */
    it('refuses a cap that would raise the role and leaves the row untouched', async () => {
      const put = (cappedGroupIdValue: string | null) =>
        request(server())
          .put(apiPath(`/forms/${alphaFormId}/members/${viewer.id}`))
          .set(authedMutation(alphaAdmin.token))
          .send({ accessRevoked: false, cappedGroupId: cappedGroupIdValue });

      // First a legitimate cap, so there is a row to leave unchanged.
      expect((await put(cappedGroupId)).status).toBe(200);
      const before = await storedRow(alphaFormId, viewer.id);
      expect(before?.cappedGroupId).toBe(cappedGroupId);

      // …now the promotion: `editor` ranks 60, the viewer's own group 20.
      const raised = await put(editor.groupId);
      expect(raised.status).toBe(422);
      expect(raised.text).toContain(CAP_MUST_LOWER_MESSAGE);

      // …and the same for the person's own role, which raises nothing but
      // would store a restriction that is none.
      const flat = await put(viewer.groupId);
      expect(flat.status).toBe(422);

      const after = await storedRow(alphaFormId, viewer.id);
      expect(after?.cappedGroupId).toBe(cappedGroupId);
      expect(after?.id).toBe(before?.id);
    });

    /**
     * **The case that measures the intersection itself** (review finding).
     *
     * Its predecessor planted the admin group as a cap on the viewer and
     * checked that `PUT /forms/:id` still answered 403. It did — but from the
     * **third** link: the viewer's own group has no `canBuild`, so
     * `GroupPermissionGuard` refused before the fourth link ran at all. Replace
     * `capPermissions`'s intersection with a plain assignment (`return cap`, the
     * promotion-shaped mistake) and that test stayed green. It measured the
     * wrong guard.
     *
     * What tells the two apart is a route with an **any-of** requirement, and a
     * person who genuinely holds one of the two permissions:
     *
     * - `GET /forms/:id` asks for `canBuild` **or** `canViewResponses`;
     * - the builder holds `canBuild` and not `canViewResponses`, so the third
     *   link lets them through — the fourth is now the only one deciding;
     * - the cap („spiegel") holds `canViewResponses` and not `canBuild`.
     *
     * Intersection ⇒ neither permission survives ⇒ 403. Assignment ⇒ the cap's
     * `canViewResponses` is *granted* to somebody whose own role never had it
     * ⇒ 200. That is the promotion the evidence forbids, and this is where it
     * shows up.
     *
     * **This `it` is the one that carries the behavioural half of the evidence**
     * — together with the exhaustive 32 × 32 case in
     * `src/tenancy/form-restriction.spec.ts`, which makes the same claim for
     * every pair of permission sets rather than for this fixture's two. The
     * `it` below it is a control and measures the chain's *order*.
     */
    it('intersects rather than replaces: a cap grants nothing the role lacks', async () => {
      // The control first: without a restriction the builder opens the form on
      // `canBuild` alone, so the 403 below is about the cap and not the fixture.
      const before = await request(server())
        .get(apiPath(`/forms/${alphaFormId}`))
        .set('Cookie', cookieHeader(builder.token));
      expect(before.status).toBe(200);

      await rawInsert(alphaFormId, builder.id, false, mirrorGroupId);

      const detail = await request(server())
        .get(apiPath(`/forms/${alphaFormId}`))
        .set('Cookie', cookieHeader(builder.token));
      expect(detail.status).toBe(403);
      expect(detail.text).toContain(MISSING_PERMISSION_MESSAGE);
    });

    /**
     * **A control, and named as one** (a review finding — it used to be
     * the second half of the case above, under a comment claiming „a
     * replacement would hand them over").
     *
     * It would not: `GET /forms/:id/responses` requires `canViewResponses`,
     * the builder's own group does not hold it, so the **third** link refuses
     * before the fourth is ever consulted. Replace `capPermissions` with
     * `return cap` — the promotion-shaped mistake — and this stays green, at
     * 403, for a reason that has nothing to do with caps. What it does show is
     * worth keeping: the cap is never a *grantor*, because the link that could
     * read it does not run until the role has already opened the door. The
     * intersection itself is carried by the case above.
     */
    it('never reaches the cap on a route the role does not open (control)', async () => {
      await rawInsert(alphaFormId, builder.id, false, mirrorGroupId);

      const answers = await request(server())
        .get(apiPath(`/forms/${alphaFormId}/responses`))
        .set('Cookie', cookieHeader(builder.token));
      expect(answers.status).toBe(403);
      expect(answers.text).not.toContain('Fuchsmajor');

      // …and it is the third link speaking: the same 403 arrives without any
      // restriction row at all.
      await prisma.formPermission.deleteMany({});
      const uncapped = await request(server())
        .get(apiPath(`/forms/${alphaFormId}/responses`))
        .set('Cookie', cookieHeader(builder.token));
      expect(uncapped.status).toBe(403);
      expect(uncapped.text).toBe(answers.text);
    });

    /**
     * The control that used to carry the name above, kept and labelled as what
     * it is: the **third** link refusing first. It proves the ordering of the
     * chain (a cap is never consulted for a permission the role lacks), not the
     * capping — the case above carries that.
     */
    it('is refused by the third link before any cap is consulted (control)', async () => {
      await rawInsert(alphaFormId, viewer.id, false, alpha.adminGroupId);

      const build = await request(server())
        .put(apiPath(`/forms/${alphaFormId}`))
        .set(authedMutation(viewer.token))
        .send({ title: 'Übernommen', definition: {}, revision: 1 });
      expect(build.status).toBe(403);
      expect(build.text).toContain(MISSING_PERMISSION_MESSAGE);
    });

    /** And the cap does take away: export goes, reading the answers stays. */
    it('removes a permission the capped group does not hold', async () => {
      await rawInsert(alphaFormId, viewer.id, false, cappedGroupId);

      const csv = await request(server())
        .get(apiPath(`/forms/${alphaFormId}/export.csv`))
        .set('Cookie', cookieHeader(viewer.token));
      expect(csv.status).toBe(403);
      expect(csv.text).not.toContain('Fuchsmajor');

      // 403 and not 404: a cap does not hide the form, and the list still shows
      // it — answering 404 here would contradict what the dashboard displays.
      const answers = await request(server())
        .get(apiPath(`/forms/${alphaFormId}/responses`))
        .set('Cookie', cookieHeader(viewer.token));
      expect(answers.status).toBe(200);

      const list = await request(server())
        .get(apiPath('/forms'))
        .set('Cookie', cookieHeader(viewer.token));
      expect(JSON.stringify(list.body)).toContain('Anmeldung ALPHA');
    });
  });

  // -------------------------------------------------------------------------
  // the evidence — administrators are not restrictable, on either path
  // -------------------------------------------------------------------------

  describe('the evidence: administrators are not restrictable', () => {
    it('refuses to write a restriction onto an administrator', async () => {
      const response = await request(server())
        .put(apiPath(`/forms/${alphaFormId}/members/${alphaAdmin.id}`))
        .set(authedMutation(alphaAdmin.token))
        .send({ accessRevoked: true, cappedGroupId: null });

      expect(response.status).toBe(422);
      expect(response.text).toContain(ADMIN_NOT_RESTRICTABLE_MESSAGE);
      expect(await storedRow(alphaFormId, alphaAdmin.id)).toBe(null);
    });

    /**
     * **The second half, and the one the reproduction targets.** A row that no
     * route would write is planted directly in PostgreSQL, and the promise of
     * the handoff — „Administratoren sehen immer alles" — has to survive it.
     * Check the admin exception only where restrictions are *written* and every
     * assertion below goes red.
     */
    it('ignores a restriction smuggled onto an administrator', async () => {
      await rawInsert(alphaFormId, alphaAdmin.id, true, cappedGroupId);
      expect(await storedRow(alphaFormId, alphaAdmin.id)).not.toBe(null);

      const detail = await request(server())
        .get(apiPath(`/forms/${alphaFormId}`))
        .set('Cookie', cookieHeader(alphaAdmin.token));
      expect(detail.status).toBe(200);

      const answers = await request(server())
        .get(apiPath(`/forms/${alphaFormId}/responses`))
        .set('Cookie', cookieHeader(alphaAdmin.token));
      expect(answers.status).toBe(200);

      // The export too — the cap in the planted row has no `canExport`, so this
      // is the assertion that fails if the cap were honoured for an admin.
      const csv = await request(server())
        .get(apiPath(`/forms/${alphaFormId}/export.csv`))
        .set('Cookie', cookieHeader(alphaAdmin.token));
      expect(csv.status).toBe(200);
      expect(csv.text).toContain('Fuchsmajor');

      const list = await request(server())
        .get(apiPath('/forms'))
        .set('Cookie', cookieHeader(alphaAdmin.token));
      expect(JSON.stringify(list.body)).toContain('Anmeldung ALPHA');
    });

    /**
     * …and the page says the same thing the evaluation does. A lock rendered
     * for somebody the guard ignores would be the one promise answered two
     * ways, and the answer people believe is the one on screen.
     */
    it('reports the administrator as unrestricted and unrestrictable', async () => {
      await rawInsert(alphaFormId, alphaAdmin.id, true, cappedGroupId);

      const response = await request(server())
        .get(apiPath(`/forms/${alphaFormId}/members`))
        .set('Cookie', cookieHeader(alphaAdmin.token));
      expect(response.status).toBe(200);

      const body = response.body as FormMemberList;
      const admin = body.members.find(
        (member) => member.userId === alphaAdmin.id,
      );
      expect(admin?.restrictable).toBe(false);
      expect(admin?.accessRevoked).toBe(false);
      expect(admin?.cappedGroupId).toBe(null);

      // The control: a restrictable person's row *is* reported.
      await rawInsert(alphaFormId, viewer.id, true, null);
      const second = await request(server())
        .get(apiPath(`/forms/${alphaFormId}/members`))
        .set('Cookie', cookieHeader(alphaAdmin.token));
      const listed = (second.body as FormMemberList).members.find(
        (member) => member.userId === viewer.id,
      );
      expect(listed?.restrictable).toBe(true);
      expect(listed?.accessRevoked).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // the evidence — the order of the chain
  // -------------------------------------------------------------------------

  describe('the evidence: the tenant boundary comes first', () => {
    /**
     * A restriction on a form of another organisation is not „refused because the
     * caller lacks a right" — it is **not addressable**: 404, byte-identical to
     * an id that belongs to nothing, and produced before any permission is
     * consulted. Put the fourth link before `TenantScopeGuard` and this turns
     * into a 403 about a missing scope.
     */
    it('cannot restrict a form of another organisation', async () => {
      const foreign = await request(server())
        .put(apiPath(`/forms/${betaFormId}/members/${viewer.id}`))
        .set(authedMutation(alphaAdmin.token))
        .send({ accessRevoked: true, cappedGroupId: null });

      const unknown = await request(server())
        .put(apiPath(`/forms/${ABSENT_UUID}/members/${viewer.id}`))
        .set(authedMutation(alphaAdmin.token))
        .send({ accessRevoked: true, cappedGroupId: null });

      expect(foreign.status).toBe(404);
      expect(foreign.status).toBe(unknown.status);
      expect(foreign.text).toBe(unknown.text);
      expect(foreign.text).toContain(FORM_NOT_FOUND_MESSAGE);

      // Nothing was written — „es kam 404 zurück" and „es steht nichts in der
      // Tabelle" are two statements, and only the second is the guarantee.
      expect(await prisma.formPermission.count()).toBe(0);
    });

    it('cannot read the rights page of a form of another organisation', async () => {
      const foreign = await request(server())
        .get(apiPath(`/forms/${betaFormId}/members`))
        .set('Cookie', cookieHeader(alphaAdmin.token));
      const unknown = await request(server())
        .get(apiPath(`/forms/${ABSENT_UUID}/members`))
        .set('Cookie', cookieHeader(alphaAdmin.token));

      expect(foreign.status).toBe(404);
      expect(foreign.text).toBe(unknown.text);
      // Nothing of BETA travelled — not the form title, not the organisation id.
      expect(foreign.text).not.toContain('Anmeldung BETA');
      expect(foreign.text).not.toContain(beta.id);
    });

    /** …and a person of another organisation is equally unaddressable. */
    it('cannot restrict a person of another organisation', async () => {
      const foreign = await request(server())
        .put(apiPath(`/forms/${alphaFormId}/members/${betaAdmin.id}`))
        .set(authedMutation(alphaAdmin.token))
        .send({ accessRevoked: true, cappedGroupId: null });
      const unknown = await request(server())
        .put(apiPath(`/forms/${alphaFormId}/members/${ABSENT_UUID}`))
        .set(authedMutation(alphaAdmin.token))
        .send({ accessRevoked: true, cappedGroupId: null });

      expect(foreign.status).toBe(404);
      expect(foreign.text).toBe(unknown.text);
      expect(foreign.text).toContain(MEMBER_NOT_FOUND_MESSAGE);
      expect(await prisma.formPermission.count()).toBe(0);
    });

    /** A cap naming a group of another organisation is unresolvable, not a promotion. */
    it('cannot cap somebody to a group of another organisation', async () => {
      const response = await request(server())
        .put(apiPath(`/forms/${alphaFormId}/members/${viewer.id}`))
        .set(authedMutation(alphaAdmin.token))
        .send({ accessRevoked: false, cappedGroupId: beta.adminGroupId });

      expect(response.status).toBe(422);
      expect(response.text).toContain(CAP_GROUP_UNKNOWN_MESSAGE);
      expect(await prisma.formPermission.count()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // The editor itself: the right it needs, and the door it stands behind
  // -------------------------------------------------------------------------

  describe('the rights page', () => {
    /**
     * **The forbidden case**: whoever holds *neither* of the two rights that
     * open this page (`FORM_MEMBERS_PERMISSIONS`) does not get in — and the
     * person holds everything else, so that the 403 is not that of a group
     * which may do nothing anyway.
     */
    it('is closed to a member holding neither can_manage_users nor can_manage_form_settings', async () => {
      const outsider = await createMember({
        email: 'ohne-rechteseite@example.org',
        groupName: 'ohne-rechteseite',
        rank: 30,
        permissions: {
          canBuild: true,
          canViewResponses: true,
          canExport: true,
          // The **organisation-wide** settings right expressly does not open
          // this page (ADR-0021).
          canManageSettings: true,
        },
      });

      const response = await request(server())
        .get(apiPath(`/forms/${alphaFormId}/members`))
        .set('Cookie', cookieHeader(outsider.token));
      expect(response.status).toBe(403);
      expect(response.text).toContain(MISSING_PERMISSION_MESSAGE);

      // And writing likewise — a page that is shut for reading only would be none.
      const written = await request(server())
        .put(apiPath(`/forms/${alphaFormId}/members/${viewer.id}`))
        .set(authedMutation(outsider.token))
        .send({ accessRevoked: true, cappedGroupId: null });
      expect(written.status).toBe(403);
      expect(await prisma.formPermission.count()).toBe(0);
    });

    /**
     * ADR-0021, the other half of the pair: `can_manage_form_settings`
     * **alone** opens the page, without `can_manage_users`. That is the
     * standard group `editor`.
     */
    it('is open to a member holding only can_manage_form_settings', async () => {
      const response = await request(server())
        .get(apiPath(`/forms/${alphaFormId}/members`))
        .set('Cookie', cookieHeader(editor.token));
      expect(response.status).toBe(200);
    });

    /**
     * **And it is no ladder.** The suspicion ADR-0021 expressly examines: can
     * an `editor` give themselves rights their group does not have, by way of
     * „Nutzerrechte je Formular"? No — and triply bolted at that, measured
     * here at the route instead of believed from the construction:
     *
     * 1. the schema has no granting field (an attempt is a 400);
     * 2. a cap has to rank *below* the role of the person concerned (422) —
     *    „auf die eigene Rolle" is already too high;
     * 3. and even a stored cap is computed as an intersection, so it can only
     *    take away.
     */
    it('gives an editor no way to raise anybody, least of all themselves', async () => {
      // 1. There is no granting field: `formMemberWriteSchema` is strict, so
      //    the attempt is a 400 and not a silent adoption.
      const invented = await request(server())
        .put(apiPath(`/forms/${alphaFormId}/members/${editor.id}`))
        .set(authedMutation(editor.token))
        .send({
          accessRevoked: false,
          cappedGroupId: null,
          permissions: { canManageUsers: true },
        });
      expect(invented.status).toBe(400);

      // 2. „Deckeln" only goes downwards — to one's own role is already too
      //    high, to a higher one all the more so.
      const sideways = await request(server())
        .put(apiPath(`/forms/${alphaFormId}/members/${editor.id}`))
        .set(authedMutation(editor.token))
        .send({ accessRevoked: false, cappedGroupId: editor.groupId });
      expect(sideways.status).toBe(422);
      expect(sideways.text).toContain(CAP_MUST_LOWER_MESSAGE);

      // 3. What the `editor` *may* save only takes away — and is looked up
      //    as a row, not inferred from the status code.
      const capped = await request(server())
        .put(apiPath(`/forms/${alphaFormId}/members/${viewer.id}`))
        .set(authedMutation(editor.token))
        .send({ accessRevoked: false, cappedGroupId });
      expect(capped.status).toBe(200);
      const stored = await storedRow(alphaFormId, viewer.id);
      expect(stored?.cappedGroupId).toBe(cappedGroupId);
      expect(stored?.accessRevoked).toBe(false);
    });

    /**
     * The management surface stands behind the rule it manages: somebody locked
     * out of this form does not get its rights page back as a way in.
     */
    it('is closed to somebody locked out of the very form', async () => {
      const manager = await createMember({
        email: 'manager@example.org',
        groupName: 'nutzerverwalter',
        rank: 40,
        permissions: { canManageUsers: true },
      });
      await rawInsert(alphaFormId, manager.id, true, null);

      const response = await request(server())
        .get(apiPath(`/forms/${alphaFormId}/members`))
        .set('Cookie', cookieHeader(manager.token));
      expect(response.status).toBe(404);
      expect(response.text).toContain(FORM_NOT_FOUND_MESSAGE);
    });

    it('lifts a restriction by storing no row at all', async () => {
      await rawInsert(alphaFormId, viewer.id, true, null);

      const response = await request(server())
        .put(apiPath(`/forms/${alphaFormId}/members/${viewer.id}`))
        .set(authedMutation(alphaAdmin.token))
        .send({ accessRevoked: false, cappedGroupId: null });

      expect(response.status).toBe(200);
      // „Keine Einschränkung" is the absence of a row, not a row full of
      // falsehoods — otherwise „ist diese Person eingeschränkt?" becomes a
      // question about contents rather than about existence.
      expect(await storedRow(alphaFormId, viewer.id)).toBe(null);

      const listed = (response.body as FormMemberList).members.find(
        (member) => member.userId === viewer.id,
      );
      expect(listed?.accessRevoked).toBe(false);
      expect(listed?.cappedGroupId).toBe(null);
    });

    /**
     * **Nobody locks themselves out** (review finding) — the same shape
     * as „der letzte Admin einer Organisation" , and it
     * needs the same two halves: a refusal that names the reason, and a **raw**
     * read proving the row is not there. „Es kam 409 zurück" says nothing about
     * what is in the table.
     */
    describe('a person cannot lock themselves out', () => {
      /** Holds `canManageUsers`, is not an administrator, so is restrictable. */
      async function selfManager(): Promise<{ id: string; token: string }> {
        return createMember({
          email: `selbst-${String(Date.now())}@example.org`,
          groupName: `selbstverwalter-${String(Date.now())}`,
          rank: 45,
          permissions: { canManageUsers: true },
        });
      }

      it('refuses to revoke one’s own access and writes no row', async () => {
        const manager = await selfManager();

        const response = await request(server())
          .put(apiPath(`/forms/${alphaFormId}/members/${manager.id}`))
          .set(authedMutation(manager.token))
          .send({ accessRevoked: true, cappedGroupId: null });

        expect(response.status).toBe(409);
        expect(response.text).toContain(SELF_LOCKOUT_MESSAGE);
        expect(await storedRow(alphaFormId, manager.id)).toBe(null);

        // The control: the very same session may lock *somebody else* out, so
        // the refusal is about „das bist du selbst" and not about the right.
        const other = await request(server())
          .put(apiPath(`/forms/${alphaFormId}/members/${viewer.id}`))
          .set(authedMutation(manager.token))
          .send({ accessRevoked: true, cappedGroupId: null });
        expect(other.status).toBe(200);
        expect((await storedRow(alphaFormId, viewer.id))?.accessRevoked).toBe(
          true,
        );
      });

      /**
       * One field further along, and the same trap: a cap on oneself to a role
       * without `can_manage_users` takes away the only route that could undo
       * it. It answers 403 rather than 404, which is the only difference.
       */
      it('refuses a self-cap that would take can_manage_users away', async () => {
        const manager = await selfManager();

        const response = await request(server())
          .put(apiPath(`/forms/${alphaFormId}/members/${manager.id}`))
          // `viewer`'s group ranks 20, below the manager's 45, so the
          // „nur nach unten" check passes and this refusal is the new one.
          .send({ accessRevoked: false, cappedGroupId: viewer.groupId })
          .set(authedMutation(manager.token));

        expect(response.status).toBe(409);
        expect(response.text).toContain(SELF_CAP_LOCKOUT_MESSAGE);
        expect(await storedRow(alphaFormId, manager.id)).toBe(null);
      });

      /** …and a self-cap that keeps the right is allowed — the cap still works. */
      it('allows a self-cap that keeps can_manage_users', async () => {
        const manager = await selfManager();
        const keeps = await prisma.group.create({
          data: {
            tenantId: alpha.id,
            name: `behaelt-${String(Date.now())}`,
            color: '#212226',
            rank: 30,
            isSystem: false,
            canManageUsers: true,
          },
        });

        const response = await request(server())
          .put(apiPath(`/forms/${alphaFormId}/members/${manager.id}`))
          .set(authedMutation(manager.token))
          .send({ accessRevoked: false, cappedGroupId: keeps.id });

        expect(response.status).toBe(200);
        expect((await storedRow(alphaFormId, manager.id))?.cappedGroupId).toBe(
          keeps.id,
        );
      });

      /**
       * **The case the old check would have let through** (ADR-0021).
       *
       * Since the page is opened by *two* rights, it is no longer enough to
       * ask „hält die Deckelungsgruppe `can_manage_users`?". Here it does hold
       * it — and the acting person does **not**: they get in through
       * `can_manage_form_settings`, and that is exactly what the cap takes
       * away from them. The intersection is empty afterwards, the page shut.
       *
       * *Counter-check:* turn the check in `FormPermissionService.save` back
       * to `!cap.canManageUsers` → this case turns red (200 instead of 409)
       * and leaves behind a row that locks the person out.
       */
      it('refuses a self-cap whose group holds the other right, not the one held', async () => {
        const formManager = await createMember({
          email: `formverwalter-${String(Date.now())}@example.org`,
          groupName: `formverwalter-${String(Date.now())}`,
          rank: 45,
          permissions: { canManageFormSettings: true },
        });
        const otherRight = await prisma.group.create({
          data: {
            tenantId: alpha.id,
            name: `nur-nutzerverwaltung-${String(Date.now())}`,
            color: '#212226',
            rank: 30,
            isSystem: false,
            // Holds the *other* of the two rights — on its own it opens the
            // page, in the intersection nothing of it remains.
            canManageUsers: true,
            canManageFormSettings: false,
          },
        });

        const response = await request(server())
          .put(apiPath(`/forms/${alphaFormId}/members/${formManager.id}`))
          .set(authedMutation(formManager.token))
          .send({ accessRevoked: false, cappedGroupId: otherRight.id });

        expect(response.status).toBe(409);
        expect(response.text).toContain(SELF_CAP_LOCKOUT_MESSAGE);
        expect(await storedRow(alphaFormId, formManager.id)).toBe(null);
      });
    });

    it('lists the organisation and nothing of the other one', async () => {
      const response = await request(server())
        .get(apiPath(`/forms/${alphaFormId}/members`))
        .set('Cookie', cookieHeader(alphaAdmin.token));
      expect(response.status).toBe(200);

      const body = response.body as FormMemberList;
      expect(body.members.map((member) => member.userId)).toContain(viewer.id);

      const payload = JSON.stringify(body);
      for (const trace of [beta.id, betaAdmin.id, beta.adminGroupId]) {
        expect(payload).not.toContain(trace);
      }
    });
  });
});
