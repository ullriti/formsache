import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MISSING_PERMISSION_MESSAGE } from '../../src/tenancy/group-permission.guard';
import {
  GROUP_NOT_FOUND_MESSAGE,
  SYSTEM_GROUP_MESSAGE,
  groupHasMembersMessage,
} from '../../src/tenant-admin/groups.service';
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
 * The group editor of one organisation, against real PostgreSQL.
 *
 * The four permission flags proven scharf elsewhere (`can_build`,
 * `can_view_responses`, `can_export`, `can_manage_settings`) are **not**
 * reproven here — that would be regression, not evidence. What is new, and what this file exists to prove, is:
 *
 * 1. a group edited **through this editor** takes effect on its very next
 *    request, with no new login (the evidence's only new half);
 * 2. the `admin` system group refuses a right taken, a rename and a delete —
 *    and none of the three changes the row;
 * 3. a group still holding members is refused **before** any delete is
 *    attempted, with a message that says why.
 *
 * **Negative probes, measured while writing this file** — each rule removed,
 * suite run, rule restored:
 *
 * - reading permissions from the session's `SessionUser` snapshot instead of
 *   from the membership `GroupPermissionGuard` resolves per request turns the
 *   "takes effect immediately" case red — the flipped session keeps answering
 *   with its first-login permissions;
 * - dropping `isSystem: false` from `ScopedGroupDelegate.update`'s `where`
 *   turns the three `admin`-protection cases red, and does so **silently**
 *   without the pre-check in `TenantGroupsService`: the row would actually
 *   change, which the raw-query assertions catch;
 * - removing the member-count pre-check in `TenantGroupsService.remove` turns
 *   the "says so before the delete" case red and replaces it with the
 *   database's own `NO ACTION` foreign-key violation — a 500, not a 409.
 */

const PASSWORD = 'test-password';
const ABSENT_UUID = '019ff600-0000-7000-8000-0000000000ff';

interface GroupBody {
  id: string;
  name: string;
  color: string;
  rank: number;
  isSystem: boolean;
  permissions: {
    canBuild: boolean;
    canViewResponses: boolean;
    canExport: boolean;
    canManageSettings: boolean;
    canManageUsers: boolean;
  };
  memberCount: number;
}

function groupBody(overrides: Record<string, unknown> = {}): object {
  return {
    name: 'Testgruppe',
    color: '#5b6b52',
    rank: 40,
    permissions: {
      canBuild: true,
      canViewResponses: false,
      canExport: false,
      canManageSettings: false,
      canManageFormSettings: false,
      canManageUsers: false,
    },
    ...overrides,
  };
}

describe('tenant groups', () => {
  let testApp: TestApp;
  let alpha: TenantFixture;
  let alphaAdmin: string;
  let restOnly: { id: string; email: string; groupId: string };
  let restOnlySession: string;
  let usersOnly: { id: string; email: string; groupId: string };
  let usersOnlySession: string;
  let database: TestDatabase | undefined;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });

    alpha = await createTenant(testApp.prisma, 'GRPA');

    const alphaUser = await createUser(testApp.prisma, {
      email: 'groups-alpha-admin@example.org',
      password: PASSWORD,
      tenants: [alpha],
    });
    alphaAdmin = await openSession(testApp, alphaUser.id, alpha.id);

    restOnly = await createRestrictedMember(testApp.prisma, alpha, {
      email: 'groups-rest-only@example.org',
      groupName: 'Alles außer Nutzer (Gruppen)',
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
      email: 'groups-users-only@example.org',
      groupName: 'Nur Nutzer verwalten (Gruppen)',
      permissions: { canManageUsers: true },
    });
    usersOnlySession = await openSession(testApp, usersOnly.id, alpha.id);
  }, 180_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  function listGroups(token: string): request.Test {
    return request(app().server)
      .get(apiPath('/tenant/groups'))
      .set('Cookie', cookieHeader(token));
  }

  function postGroup(token: string, body: object): request.Test {
    return request(app().server)
      .post(apiPath('/tenant/groups'))
      .set(authedMutation(token))
      .send(body);
  }

  function putGroup(token: string, id: string, body: object): request.Test {
    return request(app().server)
      .put(apiPath(`/tenant/groups/${id}`))
      .set(authedMutation(token))
      .send(body);
  }

  function deleteGroup(token: string, id: string): request.Test {
    return request(app().server)
      .delete(apiPath(`/tenant/groups/${id}`))
      .set(authedMutation(token));
  }

  describe('storing the roles of this organisation', () => {
    it('creates, lists, replaces and deletes one', async () => {
      const created = await postGroup(alphaAdmin, groupBody());
      expect(created.status).toBe(201);
      const group = created.body as GroupBody;
      expect(group.isSystem).toBe(false);
      expect(group.memberCount).toBe(0);

      const listed = await listGroups(alphaAdmin);
      expect(listed.status).toBe(200);
      expect(
        (listed.body as { groups: GroupBody[] }).groups.map((g) => g.id),
      ).toContain(group.id);

      const replaced = await putGroup(
        alphaAdmin,
        group.id,
        groupBody({
          name: 'Umbenannt',
          permissions: {
            canBuild: true,
            canViewResponses: false,
            canExport: true,
            canManageSettings: false,
            canManageFormSettings: false,
            canManageUsers: false,
          },
        }),
      );
      expect(replaced.status).toBe(200);
      expect((replaced.body as GroupBody).name).toBe('Umbenannt');

      const removed = await deleteGroup(alphaAdmin, group.id);
      expect(removed.status).toBe(204);

      const goneList = await listGroups(alphaAdmin);
      expect(
        (goneList.body as { groups: GroupBody[] }).groups.map((g) => g.id),
      ).not.toContain(group.id);
    });

    it('answers an unknown or malformed id with 404', async () => {
      expect(
        (await putGroup(alphaAdmin, ABSENT_UUID, groupBody())).status,
      ).toBe(404);
      expect((await deleteGroup(alphaAdmin, 'keine-uuid')).status).toBe(404);
    });

    it('refuses a duplicate name within the same organisation', async () => {
      const first = await postGroup(
        alphaAdmin,
        groupBody({ name: 'Einzigartig' }),
      );
      expect(first.status).toBe(201);
      const second = await postGroup(
        alphaAdmin,
        groupBody({ name: 'Einzigartig' }),
      );
      expect(second.status).toBe(409);
    });
  });

  describe('the `admin` system group refuses to change', () => {
    it('refuses to take a right away from it, and the row does not change', async () => {
      const before = await app().prisma.group.findUniqueOrThrow({
        where: { id: alpha.adminGroupId },
      });

      const response = await putGroup(
        alphaAdmin,
        alpha.adminGroupId,
        groupBody({
          name: before.name,
          color: before.color,
          // `before.rank` is 100 (`ADMIN_GROUP_RANK`), and `groupWriteSchema`
          // caps a written rank below it (see its doc) — a body that carries
          // it would be refused by the schema itself (400), before the
          // system-group check ever runs. Any writable rank proves the same
          // point: this request is refused for being `admin`, not for its rank.
          rank: 90,
          permissions: {
            canBuild: true,
            canViewResponses: true,
            canExport: true,
            canManageSettings: true,
            canManageFormSettings: true,
            canManageUsers: false, // the right taken away
          },
        }),
      );
      expect(response.status).toBe(409);
      expect((response.body as { message: string }).message).toBe(
        SYSTEM_GROUP_MESSAGE,
      );

      const after = await app().prisma.group.findUniqueOrThrow({
        where: { id: alpha.adminGroupId },
      });
      expect(after).toEqual(before);
    });

    it('refuses to rename it, and the row does not change', async () => {
      const before = await app().prisma.group.findUniqueOrThrow({
        where: { id: alpha.adminGroupId },
      });

      const response = await putGroup(
        alphaAdmin,
        alpha.adminGroupId,
        groupBody({
          name: 'Nicht mehr admin',
          color: before.color,
          rank: 90,
          permissions: {
            canBuild: true,
            canViewResponses: true,
            canExport: true,
            canManageSettings: true,
            canManageFormSettings: true,
            canManageUsers: true,
          },
        }),
      );
      expect(response.status).toBe(409);

      const after = await app().prisma.group.findUniqueOrThrow({
        where: { id: alpha.adminGroupId },
      });
      expect(after).toEqual(before);
    });

    it('refuses to delete it, and the row does not change', async () => {
      const response = await deleteGroup(alphaAdmin, alpha.adminGroupId);
      expect(response.status).toBe(409);
      expect((response.body as { message: string }).message).toBe(
        SYSTEM_GROUP_MESSAGE,
      );

      expect(
        await app().prisma.group.findUnique({
          where: { id: alpha.adminGroupId },
        }),
      ).not.toBeNull();
    });
  });

  describe('a group still holding members is refused before it is deleted', () => {
    it('says so, without touching the row, and succeeds once the group is empty', async () => {
      const group = await postGroup(
        alphaAdmin,
        groupBody({ name: 'In Benutzung' }),
      );
      expect(group.status).toBe(201);
      const groupId = (group.body as GroupBody).id;

      const member = await createUser(testApp.prisma, {
        email: 'in-benutzung@example.org',
        password: PASSWORD,
      });
      await testApp.prisma.membership.create({
        data: { tenantId: alpha.id, userId: member.id, groupId },
      });

      const refused = await deleteGroup(alphaAdmin, groupId);
      expect(refused.status).toBe(409);
      expect((refused.body as { message: string }).message).toBe(
        groupHasMembersMessage(1),
      );

      expect(
        await testApp.prisma.group.findUnique({ where: { id: groupId } }),
      ).not.toBeNull();

      await testApp.prisma.membership.delete({
        where: { tenantId_userId: { tenantId: alpha.id, userId: member.id } },
      });

      const removed = await deleteGroup(alphaAdmin, groupId);
      expect(removed.status).toBe(204);
    });
  });

  describe('group permissions — `can_manage_users`, and only that (pair)', () => {
    it('refuses every route to a member who holds every other right', async () => {
      const denied = await listGroups(restOnlySession);
      expect(denied.status).toBe(403);
      expect((denied.body as { message: string }).message).toBe(
        MISSING_PERMISSION_MESSAGE,
      );
      expect((await postGroup(restOnlySession, groupBody())).status).toBe(403);
      expect(
        (await putGroup(restOnlySession, alpha.adminGroupId, groupBody()))
          .status,
      ).toBe(403);
      expect(
        (await deleteGroup(restOnlySession, alpha.adminGroupId)).status,
      ).toBe(403);
    });

    it('opens every route to a member who holds only that one flag', async () => {
      expect((await listGroups(usersOnlySession)).status).toBe(200);
      const created = await postGroup(
        usersOnlySession,
        groupBody({ name: 'Von UsersOnly' }),
      );
      expect(created.status).toBe(201);
      const groupId = (created.body as GroupBody).id;
      expect(
        (
          await putGroup(
            usersOnlySession,
            groupId,
            groupBody({ name: 'Geändert' }),
          )
        ).status,
      ).toBe(200);
      expect((await deleteGroup(usersOnlySession, groupId)).status).toBe(204);
    });
  });

  describe('a group changed through this editor takes effect immediately (the new half)', () => {
    it('flips a session from 403 to 200 and back, with no new login', async () => {
      const target = await createRestrictedMember(testApp.prisma, alpha, {
        email: 'sofort-wirksam@example.org',
        groupName: 'Sofort wirksam',
        permissions: { canManageUsers: false },
      });
      const targetSession = await openSession(testApp, target.id, alpha.id);

      const before = await request(app().server)
        .get(apiPath('/tenant/users'))
        .set('Cookie', cookieHeader(targetSession));
      expect(before.status).toBe(403);

      const group = await app().prisma.group.findUniqueOrThrow({
        where: { id: target.groupId },
      });
      const granted = await putGroup(alphaAdmin, target.groupId, {
        name: group.name,
        color: group.color,
        rank: group.rank,
        permissions: {
          canBuild: group.canBuild,
          canViewResponses: group.canViewResponses,
          canExport: group.canExport,
          canManageSettings: group.canManageSettings,
          canManageFormSettings: group.canManageFormSettings,
          canManageUsers: true,
        },
      });
      expect(granted.status).toBe(200);

      // Same cookie, no new login — the very next request already carries
      // the new right.
      const after = await request(app().server)
        .get(apiPath('/tenant/users'))
        .set('Cookie', cookieHeader(targetSession));
      expect(after.status).toBe(200);

      const revoked = await putGroup(alphaAdmin, target.groupId, {
        name: group.name,
        color: group.color,
        rank: group.rank,
        permissions: {
          canBuild: group.canBuild,
          canViewResponses: group.canViewResponses,
          canExport: group.canExport,
          canManageSettings: group.canManageSettings,
          canManageFormSettings: group.canManageFormSettings,
          canManageUsers: false,
        },
      });
      expect(revoked.status).toBe(200);

      const again = await request(app().server)
        .get(apiPath('/tenant/users'))
        .set('Cookie', cookieHeader(targetSession));
      expect(again.status).toBe(403);
    });
  });

  describe('the tenant boundary', () => {
    it('answers a group of another organisation exactly like an unknown one', async () => {
      const beta = await createTenant(testApp.prisma, 'GRPB');
      const betaUser = await createUser(testApp.prisma, {
        email: 'groups-beta-admin@example.org',
        password: PASSWORD,
        tenants: [beta],
      });
      const betaAdmin = await openSession(testApp, betaUser.id, beta.id);

      const created = await postGroup(
        betaAdmin,
        groupBody({ name: 'Beta-Gruppe' }),
      );
      expect(created.status).toBe(201);
      const betaGroupId = (created.body as GroupBody).id;

      const unknown = await putGroup(alphaAdmin, ABSENT_UUID, groupBody());
      const foreign = await putGroup(alphaAdmin, betaGroupId, groupBody());
      expect(foreign.status).toBe(unknown.status);
      expect(foreign.status).toBe(404);
      expect((foreign.body as { message: string }).message).toBe(
        GROUP_NOT_FOUND_MESSAGE,
      );

      const stillBeta = await app().prisma.group.findUniqueOrThrow({
        where: { id: betaGroupId },
      });
      expect(stillBeta.name).toBe('Beta-Gruppe');
    });
  });
});
