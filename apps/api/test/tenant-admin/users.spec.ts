import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { MISSING_PERMISSION_MESSAGE } from '../../src/tenancy/group-permission.guard';
import { ADMIN_GROUP_MISSING_MESSAGE } from '../../src/tenancy/tenant-scope';
import { NO_TENANT_SCOPE_MESSAGE } from '../../src/tenancy/tenant-scope.guard';
import {
  ALREADY_MEMBER_MESSAGE,
  EMAIL_INVITED_ELSEWHERE_MESSAGE,
  EMAIL_IS_LOCAL_MESSAGE,
  EMAIL_IS_OIDC_MESSAGE,
  MEMBER_GROUP_NOT_FOUND_MESSAGE,
  MEMBER_NOT_FOUND_MESSAGE,
  OIDC_DISABLED_MESSAGE,
  lastAdminMessage,
} from '../../src/tenant-admin/users.service';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import {
  TEST_PUBLIC_BASE_URL,
  TEST_SYSTEM_SMTP_BLOCK,
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
import { resetRateLimit } from '../support/rate-limit';

/**
 * The Nutzerverwaltung of one organisation, against real
 * PostgreSQL.
 *
 * Every rights and isolation rule is proven through the case that has to
 * **fail** (`CONTRIBUTING.md`): a pair per route (403 without `can_manage_users`,
 * 2xx with it — and neither fixture is the `admin` group, which already holds
 * every right and would measure nothing), the isolation probe against a
 * foreign Organisation (404, byte-identical to an unknown id), membership removal
 * that leaves the person's other organisation untouched, and the last-administrator
 * guard.
 *
 * **Negative probes, measured while writing this file** — each rule removed,
 * suite run, rule restored:
 *
 * - dropping `tenantId` from `ScopedMembershipDelegate.findByUserId`'s
 *   `where` (spelling it `findFirst({ where: { userId } })`) turns the
 *   isolation block red — on **status**, not merely "did not succeed": beta's
 *   admin id resolves inside alpha's scope and the three requests answer 200/
 *   200/200 instead of 404/404/404;
 * - deleting the `user` row instead of the `membership` row in
 *   `ScopedMembershipDelegate.remove` turns "leaves the other organisation untouched"
 *   red — the beta membership disappears along with the person. Since Konzept
 *   no. 69, the same case is the negative probe for `deleteHomelessAccount`'s
 *   membership condition, and the block below says so;
 * - removing the last-administrator guard from
 *   `ScopedMembershipDelegate.write` (the one place `remove` and
 *   `updateGroup` both run through, a coordinator review — the guard
 *   used to be an opt-in argument either path could omit) turns the
 *   last-administrator block red, and the row changes underneath it (checked
 *   with a raw query, not by re-reading through the API);
 * - swapping `RequirePermission('canManageUsers')` for
 *   `RequireAnyPermission('canManageUsers', 'canBuild')` turns **both**
 *   halves of the permission pair red at once — proof it is a pair and not
 *   two tests of the same thing.
 */

const PASSWORD = 'test-password';
const ABSENT_UUID = '019ff600-0000-7000-8000-0000000000ff';

interface MemberBody {
  userId: string;
  email: string;
  name: string;
  accountKind: 'local' | 'oidc' | 'invited';
  group: { id: string; name: string; isSystem: boolean };
}

describe('tenant users ', () => {
  let testApp: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let alphaAdmin: string;
  let betaAdmin: string;
  /** Every right except `can_manage_users` — the "may not" half of the pair. */
  let restOnly: { id: string; email: string; groupId: string };
  let restOnlySession: string;
  /** Only `can_manage_users` — the "may" half, and deliberately not `admin`. */
  let usersOnly: { id: string; email: string; groupId: string };
  let usersOnlySession: string;
  let database: TestDatabase | undefined;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    /*
     * **Since ADR-0024 the instance's mail server and base address are the
     * precondition of creating**, not accessories: to create a person means
     * to send them an invitation, and without both there is none. Were they
     * missing here, **every** 201 of this file would answer 422 — the suite
     * would be red, and the reason would not stand in it. The counter-check
     * ("without a mail server no account comes into being") stands as a block
     * of its own below, with an application of its own.
     */
    testApp = await createTestApp({
      databaseUrl: database.url,
      systemMail: {
        publicBaseUrl: TEST_PUBLIC_BASE_URL,
        smtp: TEST_SYSTEM_SMTP_BLOCK,
      },
    });

    alpha = await createTenant(testApp.prisma, 'USRA');
    beta = await createTenant(testApp.prisma, 'USRB');

    const alphaUser = await createUser(testApp.prisma, {
      email: 'users-alpha-admin@example.org',
      password: PASSWORD,
      tenants: [alpha],
    });
    const betaUser = await createUser(testApp.prisma, {
      email: 'users-beta-admin@example.org',
      password: PASSWORD,
      tenants: [beta],
    });
    alphaAdmin = await openSession(testApp, alphaUser.id, alpha.id);
    betaAdmin = await openSession(testApp, betaUser.id, beta.id);

    restOnly = await createRestrictedMember(testApp.prisma, alpha, {
      email: 'users-rest-only@example.org',
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

    usersOnly = await createRestrictedMember(testApp.prisma, alpha, {
      email: 'users-only@example.org',
      groupName: 'Nur Nutzer verwalten',
      permissions: { canManageUsers: true },
    });
    usersOnlySession = await openSession(testApp, usersOnly.id, alpha.id);
  }, 180_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  /**
   * **The limit set to zero before every case** (security finding 2).
   *
   * Since ADR-0024 `POST /tenant/users` sends a mail and therefore allows
   * ten calls per minute and origin address
   * (`INVITATION_MAIL_RATE_LIMIT`). This file creates far more people —
   * from the same loopback address and within the same minute —, and without
   * the reset it would not be the rule under test that turns red, but the case
   * that happens to run eleventh. The limit itself is measured by
   * `account-invitation.spec.ts`, there in **one** case.
   */
  beforeEach(() => {
    resetRateLimit(testApp);
  });

  function listMembers(token: string): request.Test {
    return request(app().server)
      .get(apiPath('/tenant/users'))
      .set('Cookie', cookieHeader(token));
  }

  function getMember(token: string, userId: string): request.Test {
    return request(app().server)
      .get(apiPath(`/tenant/users/${userId}`))
      .set('Cookie', cookieHeader(token));
  }

  function postMember(token: string, body: object): request.Test {
    return request(app().server)
      .post(apiPath('/tenant/users'))
      .set(authedMutation(token))
      .send(body);
  }

  /**
   * `PUT /tenant/users/:id` — **with name and address since finding 12**.
   *
   * The route carries three fields, because `PUT` is a statement about the
   * target state and not a list of changes (`tenantMemberUpdateSchema`). Almost
   * every case below, however, is interested only in the **role** — and shall
   * be allowed to go on doing so without ten places dragging along a name they
   * do not mean.
   *
   * That is why this helper reads what is stored and sends name and address
   * along **unchanged**, unless the case names them expressly. That is
   * exactly what a user interface does as well: it shows the fields filled in
   * and sends back what stands in them.
   *
   * For an id the caller may not read at all (a foreign member, an
   * invented id), there is nothing to read — then the same
   * placeholders stand in both requests, which leaves the byte-for-byte
   * comparisons of the organisation boundary below intact.
   */
  async function putMember(
    token: string,
    userId: string,
    body: { groupId: string; name?: string; email?: string },
  ): Promise<request.Response> {
    const current = await getMember(token, userId);
    const stored =
      current.status === 200 ? (current.body as MemberBody) : undefined;
    return request(app().server)
      .put(apiPath(`/tenant/users/${userId}`))
      .set(authedMutation(token))
      .send({
        groupId: body.groupId,
        name: body.name ?? stored?.name ?? 'Nicht lesbar',
        email: body.email ?? stored?.email ?? 'nicht-lesbar@example.org',
      });
  }

  function deleteMember(token: string, userId: string): request.Test {
    return request(app().server)
      .delete(apiPath(`/tenant/users/${userId}`))
      .set(authedMutation(token));
  }

  describe('storing who works in this organisation', () => {
    it('creates a local account, lists, changes the role and removes it', async () => {
      const viewer = await request(app().server)
        .post(apiPath('/tenant/groups'))
        .set(authedMutation(alphaAdmin))
        .send({
          name: 'Ansicht',
          color: '#5b6b52',
          rank: 20,
          permissions: {
            canBuild: false,
            canViewResponses: true,
            canExport: false,
            canManageSettings: false,
            canManageFormSettings: false,
            canManageUsers: false,
          },
        });
      expect(viewer.status).toBe(201);
      const viewerGroupId = (viewer.body as { id: string }).id;

      const created = await postMember(alphaAdmin, {
        kind: 'local',
        email: 'frisch@example.org',
        name: 'Frisch Angemeldet',
        groupId: viewerGroupId,
      });
      expect(created.status).toBe(201);
      const member = created.body as MemberBody;
      expect(member.accountKind).toBe('local');
      expect(member.group.id).toBe(viewerGroupId);

      const fetched = await getMember(alphaAdmin, member.userId);
      expect(fetched.status).toBe(200);
      expect((fetched.body as MemberBody).email).toBe('frisch@example.org');

      const listed = await listMembers(alphaAdmin);
      expect(listed.status).toBe(200);
      expect(
        (listed.body as { members: MemberBody[] }).members.map((m) => m.userId),
      ).toContain(member.userId);

      const promoted = await putMember(alphaAdmin, member.userId, {
        groupId: alpha.adminGroupId,
      });
      expect(promoted.status).toBe(200);
      expect((promoted.body as MemberBody).group.id).toBe(alpha.adminGroupId);

      const removed = await deleteMember(alphaAdmin, member.userId);
      expect(removed.status).toBe(204);

      const goneList = await listMembers(alphaAdmin);
      expect(
        (goneList.body as { members: MemberBody[] }).members.map(
          (m) => m.userId,
        ),
      ).not.toContain(member.userId);
    });

    it('refuses a group that does not belong to this organisation, on create and on update', async () => {
      const created = await postMember(alphaAdmin, {
        kind: 'local',
        email: 'ohne-gruppe@example.org',
        name: 'Ohne Gruppe',
        groupId: ABSENT_UUID,
      });
      expect(created.status).toBe(422);
      expect((created.body as { message: string }).message).toBe(
        MEMBER_GROUP_NOT_FOUND_MESSAGE,
      );

      const updated = await putMember(alphaAdmin, restOnly.id, {
        groupId: ABSENT_UUID,
      });
      expect(updated.status).toBe(422);
    });

    it('attaches an existing local account instead of creating a second row', async () => {
      const first = await postMember(alphaAdmin, {
        kind: 'local',
        email: 'wieder-verwendet@example.org',
        name: 'Wiederverwendet',
        groupId: alpha.adminGroupId,
      });
      expect(first.status).toBe(201);
      const userId = (first.body as MemberBody).userId;

      // **The membership in ALPHA stays standing here**, and since the
      // specification that is no longer incidental: removing it beforehand — as
      // this case once did — deletes the account, because it then belongs to
      // nobody any more, and "the same row is reused" would no longer be a
      // statement about reuse but about a newly created row.
      //
      // Beta adds the very same e-mail — a different Organisation, so this is not the
      // "already a member" conflict, it is account reuse.
      const second = await request(app().server)
        .post(apiPath('/tenant/users'))
        .set(authedMutation(betaAdmin))
        .send({
          kind: 'local',
          email: 'wieder-verwendet@example.org',
          name: 'Ignoriert',
          groupId: beta.adminGroupId,
        });
      expect(second.status).toBe(201);
      expect((second.body as MemberBody).userId).toBe(userId);

      // **And the answer says that *no* invitation went out here.**
      // Without this field, creating and attaching are indistinguishable for
      // the user interface, and the page would report „hat eine Einladung per
      // Mail bekommen" for both — for an account that has existed since the
      // first call and has long had its password, that is simply wrong.
      expect((first.body as { invited: boolean }).invited).toBe(true);
      expect((second.body as { invited: boolean }).invited).toBe(false);

      expect(
        await app().prisma.user.count({
          where: { email: 'wieder-verwendet@example.org' },
        }),
      ).toBe(1);
    });

    it('refuses adding somebody who is already a member of this organisation', async () => {
      const conflict = await postMember(alphaAdmin, {
        kind: 'local',
        email: restOnly.email,
        name: 'Doppelt',
        groupId: alpha.adminGroupId,
      });
      expect(conflict.status).toBe(409);
      expect((conflict.body as { message: string }).message).toBe(
        ALREADY_MEMBER_MESSAGE,
      );
    });
  });

  describe('OIDC is locked when the organisation has it switched off ', () => {
    it('refuses `kind: "oidc"` on create — server-side, not only in the UI', async () => {
      // The fixture Organisation never touched `oidc_enabled`, so it carries the
      // column default: off.
      const tenant = await app().prisma.tenant.findUniqueOrThrow({
        where: { id: alpha.id },
      });
      expect(tenant.oidcEnabled).toBe(false);

      const response = await postMember(alphaAdmin, {
        kind: 'oidc',
        email: 'per-sso@example.org',
        name: 'Per SSO',
        groupId: alpha.adminGroupId,
      });
      expect(response.status).toBe(422);
      expect((response.body as { message: string }).message).toBe(
        OIDC_DISABLED_MESSAGE,
      );
      expect(
        await app().prisma.user.count({
          where: { email: 'per-sso@example.org' },
        }),
      ).toBe(0);
    });

    it('attaches an account that already has an OIDC identity, once enabled', async () => {
      await app().prisma.tenant.update({
        where: { id: alpha.id },
        data: { oidcEnabled: true },
      });
      const sso = await createUser(testApp.prisma, {
        email: 'schon-sso@example.org',
      });
      try {
        const response = await postMember(alphaAdmin, {
          kind: 'oidc',
          email: 'schon-sso@example.org',
          name: 'Schon SSO',
          groupId: alpha.adminGroupId,
        });
        expect(response.status).toBe(201);
        const member = response.body as MemberBody;
        expect(member.userId).toBe(sso.id);
        expect(member.accountKind).toBe('oidc');
      } finally {
        await app().prisma.tenant.update({
          where: { id: alpha.id },
          data: { oidcEnabled: false },
        });
      }
    });

    /**
     * The third shape of `user` (ADR-0012), on the wire: an invitation nobody has redeemed yet is `'invited'`,
     * not `'oidc'` — the moment a first login stamps the subject onto the
     * row, the very same membership reports `'oidc'` without a second write
     * anywhere. Reverting `deriveAccountKind` back to two values (or
     * `accountKindSchema` back to `z.enum(['local', 'oidc'])`) makes both
     * halves of this test red — the first because the value would no longer
     * exist, the second because the two states would collapse back together.
     */
    it('tells an unclaimed invitation apart from a bound OIDC identity', async () => {
      await app().prisma.tenant.update({
        where: { id: alpha.id },
        data: {
          oidcEnabled: true,
          oidcIssuer: 'https://idp.alpha-follow-up.example/realms/demo',
        },
      });
      try {
        const invited = await postMember(alphaAdmin, {
          kind: 'oidc',
          email: 'noch-nicht-angemeldet@example.org',
          name: 'Noch Nicht Angemeldet',
          groupId: alpha.adminGroupId,
        });
        expect(invited.status).toBe(201);
        const invitation = invited.body as MemberBody;
        expect(invitation.accountKind).toBe('invited');

        const listedBefore = await listMembers(alphaAdmin);
        expect(
          (listedBefore.body as { members: MemberBody[] }).members.find(
            (m) => m.userId === invitation.userId,
          )?.accountKind,
        ).toBe('invited');

        // The first login stamps the subject — simulated here the way
        // `auth/oidc` does it, without a second route.
        await app().prisma.user.update({
          where: { id: invitation.userId },
          data: { oidcSubject: 'sub-noch-nicht-angemeldet' },
        });

        const fetched = await getMember(alphaAdmin, invitation.userId);
        expect((fetched.body as MemberBody).accountKind).toBe('oidc');
      } finally {
        await app().prisma.tenant.update({
          where: { id: alpha.id },
          data: { oidcEnabled: false, oidcIssuer: null },
        });
      }
    });

    it('refuses `kind: "oidc"` against an e-mail that is already a local account', async () => {
      await app().prisma.tenant.update({
        where: { id: alpha.id },
        data: { oidcEnabled: true },
      });
      try {
        const response = await postMember(alphaAdmin, {
          kind: 'oidc',
          email: restOnly.email,
          name: 'Verwechslung',
          groupId: alpha.adminGroupId,
        });
        expect(response.status).toBe(409);
        expect((response.body as { message: string }).message).toBe(
          EMAIL_IS_LOCAL_MESSAGE,
        );
      } finally {
        await app().prisma.tenant.update({
          where: { id: alpha.id },
          data: { oidcEnabled: false },
        });
      }
    });

    it('refuses `kind: "local"` against an e-mail that already has only an OIDC identity', async () => {
      const sso = await createUser(testApp.prisma, {
        email: 'nur-sso@example.org',
      });
      const response = await postMember(alphaAdmin, {
        kind: 'local',
        email: 'nur-sso@example.org',
        name: 'Verwechslung',
        groupId: alpha.adminGroupId,
      });
      expect(response.status).toBe(409);
      expect((response.body as { message: string }).message).toBe(
        EMAIL_IS_OIDC_MESSAGE,
      );
      expect(
        await app().prisma.user.findUniqueOrThrow({ where: { id: sso.id } }),
      ).not.toBeNull();
    });
  });

  /**
   * **The invitation row** (ADR-0012).
   *
   * Until this package the `oidc` branch refused every unknown address with
   * 422 — and since nothing else in this application creates an SSO account
   * either, **no** SSO account could ever exist and the branch was unreachable
   * by construction. Two `CHECK`s (`user_has_credentials`,
   * `user_oidc_identity_complete`) additionally made the row impossible to
   * write at all; the migration
   * `20260730154134_relax_user_credential_checks_for_oidc_invitation` relaxes
   * them additively.
   *
   * Everything below reads the table **raw**. "The route came back with 201"
   * says nothing about the three properties the login matches on
   * (`oidc_issuer = iss`, `oidc_subject IS NULL`, `password_hash IS NULL`), and
   * those three are the whole contract between this route and that one.
   */
  describe('the SSO invitation (ADR-0012)', () => {
    const ISSUER_ALPHA = 'https://idp.alpha.example/realms/demo';
    const ISSUER_BETA = 'https://idp.beta.example/realms/demo';

    /** Switches SSO on for one organisation, runs the case, and switches it back. */
    async function withSso(
      tenant: TenantFixture,
      issuer: string,
      run: () => Promise<void>,
    ): Promise<void> {
      await app().prisma.tenant.update({
        where: { id: tenant.id },
        data: { oidcEnabled: true, oidcIssuer: issuer },
      });
      try {
        await run();
      } finally {
        await app().prisma.tenant.update({
          where: { id: tenant.id },
          data: { oidcEnabled: false, oidcIssuer: null },
        });
      }
    }

    it('creates a row with exactly the three properties the login matches on', async () => {
      await withSso(alpha, ISSUER_ALPHA, async () => {
        const response = await postMember(alphaAdmin, {
          kind: 'oidc',
          email: 'eingeladen@example.org',
          name: 'Eingeladen',
          groupId: alpha.adminGroupId,
        });
        expect(response.status).toBe(201);

        // Raw, not through the route that just answered.
        const [row] = await app().prisma.$queryRaw<
          {
            id: string;
            oidc_issuer: string | null;
            oidc_subject: string | null;
            password_hash: string | null;
          }[]
        >`SELECT "id", "oidc_issuer", "oidc_subject", "password_hash"
            FROM "user" WHERE "email" = 'eingeladen@example.org'`;
        expect(row).toBeDefined();
        // The assertion above is what makes the fallback unreachable; it keeps
        // `exactOptionalPropertyTypes` happy without a non-null assertion.
        const invitation = row ?? { id: '', oidc_issuer: null };
        expect(invitation.oidc_issuer).toBe(ISSUER_ALPHA);
        expect(row?.oidc_subject).toBe(null);
        expect(row?.password_hash).toBe(null);

        // The membership came with it, in the same transaction: an invitation
        // without one would be an orphan nothing tenant-bound could find, and
        // it would hold the installation-wide unique e-mail hostage.
        expect(
          await app().prisma.membership.count({
            where: { tenantId: alpha.id, userId: invitation.id },
          }),
        ).toBe(1);
      });
    });

    /**
     * **The issuer is stamped from the inviting Organisation, never from a request.**
     * `tenantMemberCreateSchema` carries no issuer field at all — this is the
     * behavioural half: BETA invites, and the row carries BETA's issuer, not
     * ALPHA's, although ALPHA's is the one this file used a moment ago.
     */
    it('stamps the inviting Organisation’s issuer', async () => {
      await withSso(beta, ISSUER_BETA, async () => {
        const response = await postMember(betaAdmin, {
          kind: 'oidc',
          email: 'beta-eingeladen@example.org',
          name: 'Beta Eingeladen',
          groupId: beta.adminGroupId,
        });
        expect(response.status).toBe(201);

        const [row] = await app().prisma.$queryRaw<
          { oidc_issuer: string | null }[]
        >`SELECT "oidc_issuer" FROM "user"
            WHERE "email" = 'beta-eingeladen@example.org'`;
        expect(row?.oidc_issuer).toBe(ISSUER_BETA);
        expect(row?.oidc_issuer).not.toBe(ISSUER_ALPHA);
      });
    });

    /**
     * Two organisations, **two different issuers**, the same address.
     *
     * `user.email` is unique installation-wide (ADR-0012), so the second
     * invitation cannot exist — and the point of this case is *how* it fails:
     * a readable 409, never the 500 that a raw `P2002` produces. That the
     * address can be occupied this way is a named open point for later work, not a
     * claim made here.
     */
    it('refuses a second invitation for the same address readably, not with a 500', async () => {
      const shared = 'geteilte-adresse@example.org';

      await withSso(alpha, ISSUER_ALPHA, async () => {
        const first = await postMember(alphaAdmin, {
          kind: 'oidc',
          email: shared,
          name: 'Zuerst',
          groupId: alpha.adminGroupId,
        });
        expect(first.status).toBe(201);
      });

      await withSso(beta, ISSUER_BETA, async () => {
        const second = await postMember(betaAdmin, {
          kind: 'oidc',
          email: shared,
          name: 'Danach',
          groupId: beta.adminGroupId,
        });
        expect(second.status).toBe(409);
        expect(second.status).not.toBe(500);
        expect((second.body as { message: string }).message).toBe(
          EMAIL_INVITED_ELSEWHERE_MESSAGE,
        );
      });

      // One row, and it is still ALPHA's: nothing of BETA touched it.
      const rows = await app().prisma.$queryRaw<
        { oidc_issuer: string | null }[]
      >`SELECT "oidc_issuer" FROM "user" WHERE "email" = ${shared}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.oidc_issuer).toBe(ISSUER_ALPHA);
    });

    /**
     * **A local account is not touched by any invitation** — the half ADR-0012
     * calls „ein IdP entscheidet nie über ein lokales Konto". Here it is the
     * *write* side of that promise: the invite path must not stamp an issuer
     * onto a row that has a password.
     */
    it('never writes an issuer onto a local account', async () => {
      const before = await app().prisma.$queryRaw<
        {
          name: string;
          password_hash: string | null;
          oidc_issuer: string | null;
        }[]
      >`SELECT "name", "password_hash", "oidc_issuer" FROM "user"
          WHERE "email" = ${restOnly.email}`;

      await withSso(alpha, ISSUER_ALPHA, async () => {
        const response = await postMember(alphaAdmin, {
          kind: 'oidc',
          email: restOnly.email,
          name: 'Übernahmeversuch',
          groupId: alpha.adminGroupId,
        });
        expect(response.status).toBe(409);
        expect((response.body as { message: string }).message).toBe(
          EMAIL_IS_LOCAL_MESSAGE,
        );
      });

      const after = await app().prisma.$queryRaw<
        {
          name: string;
          password_hash: string | null;
          oidc_issuer: string | null;
        }[]
      >`SELECT "name", "password_hash", "oidc_issuer" FROM "user"
          WHERE "email" = ${restOnly.email}`;
      expect(after).toEqual(before);
      expect(after[0]?.oidc_issuer).toBe(null);
      expect(after[0]?.password_hash).not.toBe(null);
    });
  });

  /**
   * **„Person hinzufügen" with an address that already has an account leaves
   * that account alone** (write side).
   *
   * The case next door ("attaches an existing local account instead of creating
   * a second row") counts rows — which is the weaker half. It stays green
   * against a route that reuses the row and *writes the typed name into it*, or
   * re-hashes the typed password over the stored one. Either would mean an organisation
   * admin editing the installation-wide user record of somebody who may work
   * mainly for a different Organisation.
   */
  describe('an existing account is reused, never rewritten', () => {
    it('leaves name and password hash untouched, and the old password still works', async () => {
      const email = 'unberuehrt@example.org';
      const ownPassword = 'das-eigene-passwort';

      /*
       * **The fixture and not the route** (ADR-0024): created through the route
       * this account would have no password at all — the person sets it
       * themselves through their invitation. What this case wants to measure is
       * an account that is already working and that a **second** organisation
       * may not rewrite anything of; an account with a password is the sharper
       * starting point for that, not the more convenient one.
       */
      await createUser(app().prisma, {
        email,
        name: 'Eigener Name',
        password: ownPassword,
        tenants: [alpha],
      });

      const before = await app().prisma.$queryRaw<
        { name: string; password_hash: string | null }[]
      >`SELECT "name", "password_hash" FROM "user" WHERE "email" = ${email}`;
      expect(before).toHaveLength(1);

      // BETA adds the same address with a **different** name and password.
      const attached = await request(app().server)
        .post(apiPath('/tenant/users'))
        .set(authedMutation(betaAdmin))
        .send({
          kind: 'local',
          email,
          name: 'Fremdname',
          groupId: beta.adminGroupId,
        });
      expect(attached.status).toBe(201);

      const after = await app().prisma.$queryRaw<
        { name: string; password_hash: string | null }[]
      >`SELECT "name", "password_hash" FROM "user" WHERE "email" = ${email}`;
      expect(after).toEqual(before);
      expect(after[0]?.name).toBe('Eigener Name');

      // …and the strongest form of "the hash is untouched": the **old**
      // password still logs in, through the real login route. A comparison of
      // hashes alone would pass if the column held a hash of something else.
      const login = await request(app().server)
        .post(apiPath('/auth/login'))
        .send({ email, password: ownPassword });
      expect(login.status).toBe(200);

      const wrong = await request(app().server)
        .post(apiPath('/auth/login'))
        .send({ email, password: 'ein-ganz-anderes-passwort' });
      expect(wrong.status).toBe(401);
    });
  });

  describe('group permissions — `can_manage_users`, and only that ', () => {
    it('refuses every route to a member who holds every other right', async () => {
      const denied = await listMembers(restOnlySession);
      expect(denied.status).toBe(403);
      expect((denied.body as { message: string }).message).toBe(
        MISSING_PERMISSION_MESSAGE,
      );

      expect((await getMember(restOnlySession, restOnly.id)).status).toBe(403);
      expect(
        (
          await postMember(restOnlySession, {
            kind: 'local',
            email: 'heimlich@example.org',
            name: 'Heimlich',
            groupId: alpha.adminGroupId,
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await putMember(restOnlySession, restOnly.id, {
            groupId: alpha.adminGroupId,
          })
        ).status,
      ).toBe(403);
      expect((await deleteMember(restOnlySession, restOnly.id)).status).toBe(
        403,
      );

      // Nothing of the five got through.
      expect(
        await app().prisma.user.count({
          where: { email: 'heimlich@example.org' },
        }),
      ).toBe(0);
      const stillThere = await app().prisma.membership.findUnique({
        where: { tenantId_userId: { tenantId: alpha.id, userId: restOnly.id } },
      });
      expect(stillThere?.groupId).toBe(restOnly.groupId);
    });

    it('opens every route to a member who holds only that one flag', async () => {
      expect((await listMembers(usersOnlySession)).status).toBe(200);
      expect((await getMember(usersOnlySession, usersOnly.id)).status).toBe(
        200,
      );

      const created = await postMember(usersOnlySession, {
        kind: 'local',
        email: 'per-usersonly@example.org',
        name: 'Erlaubt',
        groupId: usersOnly.groupId,
      });
      expect(created.status).toBe(201);
      const member = created.body as MemberBody;

      expect(
        (
          await putMember(usersOnlySession, member.userId, {
            groupId: alpha.adminGroupId,
          })
        ).status,
      ).toBe(200);
      expect((await deleteMember(usersOnlySession, member.userId)).status).toBe(
        204,
      );
    });
  });

  describe('the tenant boundary ', () => {
    it('answers a member of another organisation exactly like an unknown id, on every route', async () => {
      const betaUserId = (
        await app().prisma.membership.findFirstOrThrow({
          where: { tenantId: beta.id },
          select: { userId: true },
        })
      ).userId;

      const unknown = await getMember(alphaAdmin, ABSENT_UUID);
      const foreign = await getMember(alphaAdmin, betaUserId);
      expect(foreign.status).toBe(unknown.status);
      expect(foreign.body).toEqual(unknown.body);
      expect(foreign.status).toBe(404);
      expect((foreign.body as { message: string }).message).toBe(
        MEMBER_NOT_FOUND_MESSAGE,
      );

      const removedUnknown = await deleteMember(alphaAdmin, ABSENT_UUID);
      const removedForeign = await deleteMember(alphaAdmin, betaUserId);
      expect(removedForeign.status).toBe(removedUnknown.status);
      expect(removedForeign.body).toEqual(removedUnknown.body);
      expect(removedForeign.status).toBe(404);

      const changedUnknown = await putMember(alphaAdmin, ABSENT_UUID, {
        groupId: alpha.adminGroupId,
      });
      const changedForeign = await putMember(alphaAdmin, betaUserId, {
        groupId: alpha.adminGroupId,
      });
      expect(changedForeign.status).toBe(changedUnknown.status);
      expect(changedForeign.body).toEqual(changedUnknown.body);
      expect(changedForeign.status).toBe(404);

      // Beta's row is exactly as it was — the attempts never touched it.
      const stillBeta = await app().prisma.membership.findUniqueOrThrow({
        where: { tenantId_userId: { tenantId: beta.id, userId: betaUserId } },
      });
      expect(stillBeta.groupId).toBe(beta.adminGroupId);
    });
  });

  /**
   * **Whoever is still somewhere else is not touched** (and since specification
   * no. 69 at the same time the reproduction of the most dangerous line of this
   * package).
   *
   * An account is installation-wide, not a datum of one organisation: removal
   * from ALPHA takes a membership, not a human being — as long as BETA still
   * holds them. Both organisations here are **alive**; with two dying
   * organisations the case would go green without the condition as well,
   * because in the end no membership would stand any more anyway.
   *
   * *Reproduction:* leave out `memberships: { none: {} }` from
   * `deleteHomelessAccount` → **red**: the `user` row is gone and the beta
   * session answers 403 instead of 200.
   */
  describe('removing a membership is not deleting a person ', () => {
    it('leaves the other organisation and its session untouched', async () => {
      const beide = await createUser(testApp.prisma, {
        email: 'beide-buende@example.org',
        password: PASSWORD,
        tenants: [alpha, beta],
      });
      const beideAlphaSession = await openSession(testApp, beide.id, alpha.id);
      const beideBetaSession = await openSession(testApp, beide.id, beta.id);

      const removed = await deleteMember(alphaAdmin, beide.id);
      expect(removed.status).toBe(204);

      // The person still exists, and still belongs to beta.
      expect(
        await app().prisma.user.findUnique({ where: { id: beide.id } }),
      ).not.toBe(null);
      expect(
        await app().prisma.membership.findUnique({
          where: { tenantId_userId: { tenantId: beta.id, userId: beide.id } },
        }),
      ).not.toBe(null);
      expect(
        await app().prisma.membership.findUnique({
          where: { tenantId_userId: { tenantId: alpha.id, userId: beide.id } },
        }),
      ).toBe(null);

      // The beta session is unaffected — permissions there are resolved from
      // a membership that is still there.
      const stillBeta = await request(app().server)
        .get(apiPath('/tenant/groups'))
        .set('Cookie', cookieHeader(beideBetaSession));
      expect(stillBeta.status).toBe(200);

      // The alpha session, on its very next request, is refused — not
      // because a cookie was revoked, but because the membership it is
      // resolved from is gone (`CONTRIBUTING.md`: rights are resolved per
      // request).
      const goneAlpha = await request(app().server)
        .get(apiPath('/tenant/groups'))
        .set('Cookie', cookieHeader(beideAlphaSession));
      expect(goneAlpha.status).toBe(403);
      expect((goneAlpha.body as { message: string }).message).toBe(
        NO_TENANT_SCOPE_MESSAGE,
      );

      const me = await request(app().server)
        .get(apiPath('/auth/me'))
        .set('Cookie', cookieHeader(beideAlphaSession));
      expect(me.status).toBe(200);
      expect(
        (
          me.body as { memberships: { tenant: { id: string } }[] }
        ).memberships.map((m) => m.tenant.id),
      ).not.toContain(alpha.id);
      expect(
        (
          me.body as { memberships: { tenant: { id: string } }[] }
        ).memberships.map((m) => m.tenant.id),
      ).toContain(beta.id);
    });
  });

  describe('the last administrator ', () => {
    it('cannot remove themselves, and the row does not change', async () => {
      const gamma = await createTenant(testApp.prisma, 'USRG');
      const solo = await createUser(testApp.prisma, {
        email: 'solo-admin@example.org',
        password: PASSWORD,
        tenants: [gamma],
      });
      const soloSession = await openSession(testApp, solo.id, gamma.id);

      const response = await deleteMember(soloSession, solo.id);
      expect(response.status).toBe(409);
      expect((response.body as { message: string }).message).toBe(
        lastAdminMessage('remove'),
      );

      const stillThere = await app().prisma.membership.findUniqueOrThrow({
        where: { tenantId_userId: { tenantId: gamma.id, userId: solo.id } },
      });
      expect(stillThere.groupId).toBe(gamma.adminGroupId);

      // **And the account all the more so**: the lock sits in
      // `ScopedMembershipDelegate.write`, that is *before* the body of `remove`
      // — the deletion of the account that has become homeless cannot get past
      // it, because this call never reaches the statements below. Otherwise the
      // only administrator of the organisation would be gone together with
      // their login, and nobody would get in any more.
      expect(await app().prisma.user.count({ where: { id: solo.id } })).toBe(1);
      const login = await request(app().server)
        .post(apiPath('/auth/login'))
        .send({ email: solo.email, password: PASSWORD });
      expect(login.status).toBe(200);
    });

    it('cannot downgrade themselves either', async () => {
      const gamma = await createTenant(testApp.prisma, 'USRH');
      const solo = await createUser(testApp.prisma, {
        email: 'solo-admin-2@example.org',
        password: PASSWORD,
        tenants: [gamma],
      });
      const soloSession = await openSession(testApp, solo.id, gamma.id);
      const viewer = await request(app().server)
        .post(apiPath('/tenant/groups'))
        .set(authedMutation(soloSession))
        .send({
          name: 'Ansicht',
          color: '#5b6b52',
          rank: 20,
          permissions: {
            canBuild: false,
            canViewResponses: true,
            canExport: false,
            canManageSettings: false,
            canManageFormSettings: false,
            canManageUsers: false,
          },
        });
      expect(viewer.status).toBe(201);
      const viewerGroupId = (viewer.body as { id: string }).id;

      const response = await putMember(soloSession, solo.id, {
        groupId: viewerGroupId,
      });
      expect(response.status).toBe(409);
      expect((response.body as { message: string }).message).toBe(
        lastAdminMessage('downgrade'),
      );

      const stillThere = await app().prisma.membership.findUniqueOrThrow({
        where: { tenantId_userId: { tenantId: gamma.id, userId: solo.id } },
      });
      expect(stillThere.groupId).toBe(gamma.adminGroupId);
    });

    /**
     * **A `PUT` that changes nothing is not a downgrade** (review finding). The sole administrator of an organisation, saved onto the group they
     * already hold, used to come back 409 „kann nicht herabgestuft werden" — a
     * refusal of a change nobody was making, and one the surface cannot
     * explain. `PUT` states the role a member should have; this one already
     * has it.
     */
    it('accepts saving the last administrator onto their own group', async () => {
      const gamma = await createTenant(testApp.prisma, 'USRJ');
      const solo = await createUser(testApp.prisma, {
        email: 'solo-admin-3@example.org',
        password: PASSWORD,
        tenants: [gamma],
      });
      const soloSession = await openSession(testApp, solo.id, gamma.id);

      const response = await putMember(soloSession, solo.id, {
        groupId: gamma.adminGroupId,
      });
      expect(response.status).toBe(200);
      expect((response.body as MemberBody).group.id).toBe(gamma.adminGroupId);

      // …and the row is what it was — read raw, not through the answer.
      const stored = await app().prisma.membership.findUniqueOrThrow({
        where: { tenantId_userId: { tenantId: gamma.id, userId: solo.id } },
      });
      expect(stored.groupId).toBe(gamma.adminGroupId);
    });

    it('allows it once a second administrator exists', async () => {
      const gamma = await createTenant(testApp.prisma, 'USRI');
      const first = await createUser(testApp.prisma, {
        email: 'first-admin@example.org',
        password: PASSWORD,
        tenants: [gamma],
      });
      const second = await createUser(testApp.prisma, {
        email: 'second-admin@example.org',
        password: PASSWORD,
        tenants: [gamma],
      });
      const firstSession = await openSession(testApp, first.id, gamma.id);

      const response = await deleteMember(firstSession, second.id);
      expect(response.status).toBe(204);
    });

    /**
     * **The guard must not skip itself when it cannot look** (review finding).
     *
     * `ScopedMembershipDelegate.write` resolved the `admin` system group and
     * then asked `if (admin !== null && …)`. An organisation without that group — a
     * botched migration, a hand-edited database — therefore ran the write with
     * *no* last-administrator check at all, silently: "I could not look" read
     * as "it is all right", which is the one direction this
     * guard may never take. The earlier, caller-side resolution threw here.
     *
     * The state is produced the way it would actually occur — straight in the
     * table, not through a route, because no route can unset `is_system`.
     */
    it('refuses every membership write when the organisation has no system group', async () => {
      const gamma = await createTenant(testApp.prisma, 'USRK');
      const first = await createUser(testApp.prisma, {
        email: 'kaputt-admin@example.org',
        password: PASSWORD,
        tenants: [gamma],
      });
      const second = await createUser(testApp.prisma, {
        email: 'kaputt-zweiter@example.org',
        password: PASSWORD,
        tenants: [gamma],
      });
      const session = await openSession(testApp, first.id, gamma.id);

      // A group of **this** Organisation to downgrade into — one of another organisation is
      // refused two checks earlier and would never reach the guard under test.
      const viewer = await request(app().server)
        .post(apiPath('/tenant/groups'))
        .set(authedMutation(session))
        .send({
          name: 'Ansicht',
          color: '#5b6b52',
          rank: 20,
          permissions: {
            canBuild: false,
            canViewResponses: true,
            canExport: false,
            canManageSettings: false,
            canManageFormSettings: false,
            canManageUsers: false,
          },
        });
      expect(viewer.status).toBe(201);
      const viewerGroupId = (viewer.body as { id: string }).id;

      await app().prisma.group.updateMany({
        where: { tenantId: gamma.id, isSystem: true },
        data: { isSystem: false },
      });

      try {
        // Both write paths, because the guard is shared and each of them used
        // to be able to omit it separately (coordinator review).
        const removed = await deleteMember(session, second.id);
        expect(removed.status).toBe(409);
        expect((removed.body as { message: string }).message).toBe(
          ADMIN_GROUP_MISSING_MESSAGE,
        );

        const downgraded = await putMember(session, second.id, {
          groupId: viewerGroupId,
        });
        expect(downgraded.status).toBe(409);
        expect((downgraded.body as { message: string }).message).toBe(
          ADMIN_GROUP_MISSING_MESSAGE,
        );

        // Raw, not through the route that just answered: "a 409 came back"
        // and "the row is still standing" are two statements, and the second is
        // the guarantee. Without the refusal the delete goes through — there is
        // a second administrator, so nothing else would have stopped it.
        const rows = await app().prisma.$queryRaw<{ group_id: string }[]>`
          SELECT "group_id" FROM "membership"
            WHERE "tenant_id" = ${gamma.id}::uuid
              AND "user_id" = ${second.id}::uuid`;
        expect(rows).toHaveLength(1);
        expect(rows[0]?.group_id).toBe(gamma.adminGroupId);
      } finally {
        await app().prisma.group.updateMany({
          where: { tenantId: gamma.id, id: gamma.adminGroupId },
          data: { isSystem: true },
        });
      }

      // The control: with the group back, the very same request succeeds — so
      // the 409 above is about the missing system group and nothing else.
      const allowed = await deleteMember(session, second.id);
      expect(allowed.status).toBe(204);
    });
  });

  /**
   * **Whoever is removed from their last organisation loses their account**
   * (2026-08-03).
   *
   * the specification closed one door: the 30-day purge of an organisation deletes the
   * people who thereby become homeless. This one here is the second. If
   * somebody is taken out of their last organisation through *Person entfernen*,
   * **nothing** cleaned up until now: `remove` only deleted an unredeemed
   * invitation, that is somebody who never signed in. A real user
   * stayed standing **indefinitely** — e-mail, name, password hash, OIDC
   * identity —, was visible to nobody (people are enumerated through
   * `membership`), occupied their address installation-wide (`user.email` is
   * `@unique`) and **could go on signing in**: `AuthService.login`
   * demands no membership.
   *
   * The requirement is therefore no longer "has never signed in", but
   * "does this account still belong to somebody" — `deleteHomelessAccount`, the
   * same one statement the purge runs. Since then the invitation is no
   * special case any more, but the same case without code of its own.
   *
   * **The three traps, each with its reproduction** (measured on 2026-08-03,
   * rule removed, suite run, rule back):
   *
   * - `memberships: { none: {} }` left out → **red** in "a living
   *   second organisation stays" further above: the account is gone and
   *   the beta session answers 403 instead of 200. That is the most dangerous
   *   line of the package — an account is installation-wide, not an organisation datum;
   * - `isSuperadmin: false` left out → **red** in the superadmin case below;
   * - `deleteHomelessAccount` called **before** the deletion of the membership
   *   → **red** in every deletion case here: the membership about to be
   *   removed is then counted along, and nobody is ever
   *   deleted. The purge has measured the same trap in both directions
   *   (`retention-purge.spec.ts`).
   *
   * The fourth trap — the last administrator — stands with its own
   * proof further above: the lock takes hold in `write`, **before** this
   * addition runs at all, and there the `user` row is now checked as well.
   */
  describe('die Spezifikation Nr. 69 — ein Konto ohne Organisation wird gelöscht', () => {
    const ISSUER = 'https://idp.delta.example/realms/demo';
    let delta: TenantFixture;
    let deltaSession: string;

    beforeAll(async () => {
      delta = await createTenant(testApp.prisma, 'USRL');
      const deltaAdmin = await createUser(testApp.prisma, {
        email: 'delta-admin@example.org',
        password: PASSWORD,
        tenants: [delta],
      });
      deltaSession = await openSession(testApp, deltaAdmin.id, delta.id);
      await testApp.prisma.tenant.update({
        where: { id: delta.id },
        data: { oidcEnabled: true, oidcIssuer: ISSUER },
      });
    }, 120_000);

    /** What the table holds for one address — never what a route reported. */
    function accountRows(email: string): Promise<
      {
        id: string;
        password_hash: string | null;
        oidc_subject: string | null;
      }[]
    > {
      return app().prisma.$queryRaw`
        SELECT "id", "password_hash", "oidc_subject" FROM "user"
          WHERE "email" = ${email}`;
    }

    /**
     * **The case the specification was built for.** An account with a password
     * that loses its last organisation — before, a human being who can sign
     * in, afterwards no row any more.
     *
     * The login is asked **through the route**, because that is the half that
     * counts: `login` demands no membership, so "the person has no
     * organisation any more" would not have stopped it. Only the missing row
     * does. And the open session is used afterwards instead of talked about:
     * `session` cascades from `user`, the next request gets the 401
     * of an unknown session — no 500.
     */
    it('löscht ein lokales Konto samt Anmeldung und Sitzung', async () => {
      const email = 'letzter-organisation@example.org';
      const ownPassword = 'ein-langes-passwort';

      /*
       * The fixture and not the route, for the same reason as above: this
       * case is about an account **that can sign in** and that disappears with
       * its last membership. A freshly invited account without a password
       * would satisfy "can no longer sign in" already, before anything was
       * deleted.
       */
      const member = await createUser(app().prisma, {
        email,
        name: 'Letzter Organisation',
        password: ownPassword,
        tenants: [delta],
      });
      const ownSession = await openSession(testApp, member.id, delta.id);

      // Beforehand: the account carries, otherwise "can no longer sign in"
      // would be satisfied by an account that never could.
      const before = await request(app().server)
        .post(apiPath('/auth/login'))
        .send({ email, password: ownPassword });
      expect(before.status).toBe(200);

      const removed = await deleteMember(deltaSession, member.id);
      expect(removed.status).toBe(204);

      expect(await accountRows(email)).toHaveLength(0);

      const after = await request(app().server)
        .post(apiPath('/auth/login'))
        .send({ email, password: ownPassword });
      expect(after.status).toBe(401);

      // The session that was open: 401, not 500 — the row has cascaded with
      // the account and the request simply finds none.
      const orphaned = await request(app().server)
        .get(apiPath('/auth/me'))
        .set('Cookie', cookieHeader(ownSession));
      expect(orphaned.status).toBe(401);
    });

    /**
     * …and a **redeemed** SSO account just the same: that somebody has already
     * signed in once (the `sub` stands on the row, ADR-0012),
     * does not make the account somebody's account. Until the specification that
     * was exactly the condition, and it was the wrong one.
     */
    it('nimmt auch ein eingelöstes SSO-Konto mit', async () => {
      const email = 'angemeldet@example.org';

      const invited = await postMember(deltaSession, {
        kind: 'oidc',
        email,
        name: 'Angemeldet',
        groupId: delta.adminGroupId,
      });
      expect(invited.status).toBe(201);
      const member = invited.body as MemberBody;

      // The way the sign-in would do it: the first login stamps the `sub` onto
      // the row and turns the invitation into a bound identity.
      await app().prisma.user.update({
        where: { id: member.userId },
        data: { oidcSubject: 'sub-angemeldet-0815' },
      });

      const removed = await deleteMember(deltaSession, member.userId);
      expect(removed.status).toBe(204);

      expect(await accountRows(email)).toHaveLength(0);
    });

    /**
     * The unredeemed invitation — since the specification **the same case**, no
     * longer the only one. What is measured is what "released" means: the same
     * address can be invited again afterwards, and that is the whole point
     * when taking back a typo (`user.email` is installation-wide
     * unique, ADR-0012).
     */
    it('gibt die Adresse einer uneingelösten Einladung wieder frei', async () => {
      const email = 'vertippt@example.org';

      const invited = await postMember(deltaSession, {
        kind: 'oidc',
        email,
        name: 'Vertippt',
        groupId: delta.adminGroupId,
      });
      expect(invited.status).toBe(201);
      const invitation = invited.body as MemberBody;
      // A finding, on the wire, closed (a review follow-up): an invitation has no
      // password and cannot sign in, so „Lokal" would promise a login that
      // does not exist — and „OIDC" would claim it has already signed in
      // somewhere. `deriveAccountKind` (`tenant-admin/users.service.ts`)
      // answers the third, honest value.
      expect(invitation.accountKind).toBe('invited');

      const removed = await deleteMember(deltaSession, invitation.userId);
      expect(removed.status).toBe(204);

      expect(await accountRows(email)).toHaveLength(0);

      const again = await postMember(deltaSession, {
        kind: 'oidc',
        email,
        name: 'Richtig',
        groupId: delta.adminGroupId,
      });
      expect(again.status).toBe(201);
    });

    /**
     * **A superadmin without a membership stays**: their
     * work is administration, not domain data, "no organisation" is their
     * normal state. The membership in the organisation is here only the way by
     * which they come within reach of `remove` at all — a superadmin who
     * was never a member is not a case but an absence.
     *
     * *Reproduction:* leave out `isSuperadmin: false` from
     * `deleteHomelessAccount` → red, and with them the administration of the
     * installation gone.
     */
    it('lässt einen Superadmin ohne Mitgliedschaft stehen', async () => {
      const root = await createUser(testApp.prisma, {
        email: 'zweitroot@example.org',
        password: PASSWORD,
        isSuperadmin: true,
        tenants: [delta],
      });

      const removed = await deleteMember(deltaSession, root.id);
      expect(removed.status).toBe(204);

      expect(await app().prisma.user.count({ where: { id: root.id } })).toBe(1);
      // …and the case is really "without a membership", not "still a member
      // somewhere else".
      expect(
        await app().prisma.membership.count({ where: { userId: root.id } }),
      ).toBe(0);
      // The login still carries — the account is intact, not merely the row
      // present.
      const login = await request(app().server)
        .post(apiPath('/auth/login'))
        .send({ email: root.email, password: PASSWORD });
      expect(login.status).toBe(200);
    });
  });
});
