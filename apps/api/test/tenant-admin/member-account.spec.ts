import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { verifyPassword } from '../../src/auth/password';
import {
  ACCOUNT_SHARED_MESSAGE,
  EMAIL_ALREADY_USED_MESSAGE,
  OIDC_ACCOUNT_EMAIL_MESSAGE,
  OIDC_ACCOUNT_HAS_NO_PASSWORD_MESSAGE,
  SUPERADMIN_ACCOUNT_MESSAGE,
} from '../../src/tenant-admin/users.service';
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

const PASSWORD = 'ein hinreichend langes passwort';
const NEW_PASSWORD = 'ein anderes hinreichend langes passwort';
/** An id that never existed — the comparison case of every boundary. */
const ABSENT_UUID = '00000000-0000-4000-8000-000000000000';

/**
 * **Name, address and password of a member — from the forbidden side**
 * (finding 12, ADR-0020).
 *
 * Two new handles in the member administration: changing the address of an
 * account and setting a password for it. Both are **login keys** — whoever sets
 * them gets into the account, and namely into every organisation in which it
 * works. That is why this file mostly checks what does *not* go:
 *
 * | Who/what | What must hold |
 * |---|---|
 * | all rights **except** `canManageUsers` | 403 on both routes, and nothing written |
 * | a member of another organisation | 404 — byte for byte equal to the invented id |
 * | an account that works **elsewhere too** | 409, row unchanged |
 * | an account of the system administration | 409, row unchanged |
 * | an SSO account / an open invitation | 422, row unchanged |
 * | an address that is already taken | 409, row unchanged |
 *
 * And the one promise that no status code shows: a password that has been set
 * **ends every session** of the person — otherwise it would be ineffective
 * after a break-in, because a session token knows no password.
 */
describe('das Konto eines Mitglieds ändern', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  /** The session with `canManageUsers` in ALPHA. */
  let admin: string;
  /** Everything except `canManageUsers` — the „must not" half of every row. */
  let restOnly: string;
  /** A member of BETA that ALPHA may never see. */
  let betaMember: { id: string; email: string };

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });

    alpha = await createTenant(testApp.prisma, 'MACA');
    beta = await createTenant(testApp.prisma, 'MACB');

    const adminUser = await createUser(testApp.prisma, {
      email: 'account-admin@example.org',
      password: PASSWORD,
      tenants: [alpha],
    });
    admin = await openSession(testApp, adminUser.id, alpha.id);

    const restricted = await createRestrictedMember(testApp.prisma, alpha, {
      email: 'account-rest-only@example.org',
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
    restOnly = await openSession(testApp, restricted.id, alpha.id);

    betaMember = await createUser(testApp.prisma, {
      email: 'account-beta@example.org',
      password: PASSWORD,
      tenants: [beta],
    });
  }, 180_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  /** A fresh local member of ALPHA — one per case. */
  async function member(
    slug: string,
    tenants: readonly TenantFixture[] = [alpha],
    options: { readonly isSuperadmin?: boolean } = {},
  ): Promise<{ id: string; email: string }> {
    return createUser(app().prisma, {
      email: `account-${slug}@example.org`,
      password: PASSWORD,
      tenants,
      ...(options.isSuperadmin === undefined
        ? {}
        : { isSuperadmin: options.isSuperadmin }),
    });
  }

  function putMember(
    token: string,
    userId: string,
    body: { groupId: string; name: string; email: string },
  ): request.Test {
    return request(app().server)
      .put(apiPath(`/tenant/users/${userId}`))
      .set(authedMutation(token))
      .send(body);
  }

  function setPassword(
    token: string,
    userId: string,
    password: string,
  ): request.Test {
    return request(app().server)
      .post(apiPath(`/tenant/users/${userId}/password`))
      .set(authedMutation(token))
      .send({ password });
  }

  /** The stored row — the only evidence that nothing happened. */
  function stored(
    userId: string,
  ): Promise<{ email: string; name: string; passwordHash: string | null }> {
    return app().prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true, name: true, passwordHash: true },
    });
  }

  async function passwordOf(
    userId: string,
    candidate: string,
  ): Promise<boolean> {
    const row = await stored(userId);
    return row.passwordHash !== null
      ? verifyPassword(row.passwordHash, candidate)
      : false;
  }

  describe('was erlaubt ist', () => {
    it('ändert Name und Adresse eines Kontos, das dieser Organisation allein gehört', async () => {
      const person = await member('renamable');

      const response = await putMember(admin, person.id, {
        groupId: alpha.adminGroupId,
        name: 'Neu Benannt',
        email: 'account-renamable-neu@example.org',
      });

      expect(response.status).toBe(200);
      const row = await stored(person.id);
      expect(row.name).toBe('Neu Benannt');
      expect(row.email).toBe('account-renamable-neu@example.org');
    });

    it('setzt ein Passwort und beendet dabei jede Sitzung der Person', async () => {
      const person = await member('settable');
      const deviceA = await openSession(testApp, person.id, alpha.id);
      const deviceB = await openSession(testApp, person.id, alpha.id);

      const response = await setPassword(admin, person.id, NEW_PASSWORD);

      expect(response.status).toBe(201);
      // The number is the confirmation: two devices, two ended sessions.
      expect((response.body as { revoked: number }).revoked).toBe(2);
      expect(await passwordOf(person.id, NEW_PASSWORD)).toBe(true);
      expect(await passwordOf(person.id, PASSWORD)).toBe(false);

      for (const device of [deviceA, deviceB]) {
        const alive = await request(app().server)
          .get(apiPath('/auth/me'))
          .set('Cookie', cookieHeader(device));
        expect(alive.status).toBe(401);
      }
    });

    it('lässt Name und Rolle eines SSO-Kontos zu, solange die Adresse dieselbe bleibt', async () => {
      // **The rule „only what changed is checked".** `PUT` carries all three
      // fields; whoever sends the same address back does not change it — and
      // gets no refusal for a change that they do not make.
      const ssoAccount = await createUser(app().prisma, {
        email: 'account-sso-rename@example.org',
        tenants: [alpha],
      });

      const response = await putMember(admin, ssoAccount.id, {
        groupId: alpha.adminGroupId,
        name: 'SSO Umbenannt',
        email: ssoAccount.email,
      });

      expect(response.status).toBe(200);
      expect((await stored(ssoAccount.id)).name).toBe('SSO Umbenannt');
    });
  });

  describe('das Recht — dieselbe Route, ein Flag weniger', () => {
    it('weist beide Routen ab, wenn `canManageUsers` fehlt, und schreibt nichts', async () => {
      const person = await member('protected-by-permission');

      const changed = await putMember(restOnly, person.id, {
        groupId: alpha.adminGroupId,
        name: 'Heimlich Umbenannt',
        email: 'account-heimlich@example.org',
      });
      const passworded = await setPassword(restOnly, person.id, NEW_PASSWORD);

      expect(changed.status).toBe(403);
      expect(passworded.status).toBe(403);

      const row = await stored(person.id);
      expect(row.email).toBe(person.email);
      expect(row.name).not.toBe('Heimlich Umbenannt');
      expect(await passwordOf(person.id, NEW_PASSWORD)).toBe(false);
    });
  });

  describe('die Organisation-Grenze', () => {
    it('beantwortet ein fremdes Mitglied genau wie eine erfundene Kennung', async () => {
      const foreign = await setPassword(admin, betaMember.id, NEW_PASSWORD);
      const invented = await setPassword(admin, ABSENT_UUID, NEW_PASSWORD);

      expect(foreign.status).toBe(404);
      // Byte for byte equal: otherwise the route would be a directory of the ids
      // of this installation.
      expect(foreign.status).toBe(invented.status);
      expect(foreign.body).toEqual(invented.body);

      // And BETA's row is untouched.
      expect(await passwordOf(betaMember.id, PASSWORD)).toBe(true);
      expect(await passwordOf(betaMember.id, NEW_PASSWORD)).toBe(false);
    });

    it('ändert die Adresse eines fremden Mitglieds auch dann nicht, wenn sie frei wäre', async () => {
      const foreign = await putMember(admin, betaMember.id, {
        groupId: alpha.adminGroupId,
        name: 'Fremd Umbenannt',
        email: 'account-fremd-neu@example.org',
      });
      const invented = await putMember(admin, ABSENT_UUID, {
        groupId: alpha.adminGroupId,
        name: 'Fremd Umbenannt',
        email: 'account-fremd-neu@example.org',
      });

      expect(foreign.status).toBe(404);
      expect(foreign.status).toBe(invented.status);
      expect(foreign.body).toEqual(invented.body);
      expect((await stored(betaMember.id)).email).toBe(betaMember.email);
    });
  });

  describe('wessen Konto es ist', () => {
    it('weist Adresse und Passwort ab, wenn das Konto auch in einer anderen Organisation arbeitet', async () => {
      // **The privilege escalation that this rule closes:** ALPHA sets a
      // password, logs in as the person — and stands in BETA.
      const shared = await member('shared', [alpha, beta]);

      const changed = await putMember(admin, shared.id, {
        groupId: alpha.adminGroupId,
        name: 'Geteilt',
        email: 'account-shared-neu@example.org',
      });
      const passworded = await setPassword(admin, shared.id, NEW_PASSWORD);

      expect(changed.status).toBe(409);
      expect((changed.body as { message: string }).message).toBe(
        ACCOUNT_SHARED_MESSAGE,
      );
      expect(passworded.status).toBe(409);

      const row = await stored(shared.id);
      expect(row.email).toBe(shared.email);
      // The **name** is part of the same request and likewise stands:
      // the request was refused entirely, not half executed.
      expect(row.name).not.toBe('Geteilt');
      expect(await passwordOf(shared.id, PASSWORD)).toBe(true);
    });

    it('lässt den Namen eines geteilten Kontos zu, solange die Adresse gleich bleibt', async () => {
      const shared = await member('shared-rename', [alpha, beta]);

      const response = await putMember(admin, shared.id, {
        groupId: alpha.adminGroupId,
        name: 'Geteilt Umbenannt',
        email: shared.email,
      });

      // A name grants nothing — otherwise a typo for somebody who
      // works in two organisations could no longer be corrected by anybody.
      expect(response.status).toBe(200);
      expect((await stored(shared.id)).name).toBe('Geteilt Umbenannt');
    });

    it('weist ein Konto der Systemverwaltung ab', async () => {
      const superadmin = await member('superadmin', [alpha], {
        isSuperadmin: true,
      });

      const changed = await putMember(admin, superadmin.id, {
        groupId: alpha.adminGroupId,
        name: 'Übernommen',
        email: 'account-superadmin-neu@example.org',
      });
      const passworded = await setPassword(admin, superadmin.id, NEW_PASSWORD);

      expect(changed.status).toBe(409);
      expect((changed.body as { message: string }).message).toBe(
        SUPERADMIN_ACCOUNT_MESSAGE,
      );
      expect(passworded.status).toBe(409);
      expect((await stored(superadmin.id)).email).toBe(superadmin.email);
      expect(await passwordOf(superadmin.id, PASSWORD)).toBe(true);
    });

    it('weist ein SSO-Konto und eine offene Einladung ab', async () => {
      const ssoAccount = await createUser(app().prisma, {
        email: 'account-sso@example.org',
        tenants: [alpha],
      });
      const invitation = await app().prisma.user.create({
        data: {
          email: 'account-invited@example.org',
          name: 'Eingeladen',
          oidcIssuer: 'https://idp.example.org',
          memberships: {
            create: { tenantId: alpha.id, groupId: alpha.adminGroupId },
          },
        },
        select: { id: true, email: true },
      });

      for (const account of [ssoAccount, invitation]) {
        const changed = await putMember(admin, account.id, {
          groupId: alpha.adminGroupId,
          name: 'Egal',
          email: `neu-${account.id}@example.org`,
        });
        const passworded = await setPassword(admin, account.id, NEW_PASSWORD);

        expect(changed.status).toBe(422);
        expect((changed.body as { message: string }).message).toBe(
          OIDC_ACCOUNT_EMAIL_MESSAGE,
        );
        expect(passworded.status).toBe(422);
        expect((passworded.body as { message: string }).message).toBe(
          OIDC_ACCOUNT_HAS_NO_PASSWORD_MESSAGE,
        );

        const row = await stored(account.id);
        expect(row.email).toBe(account.email);
        // **No password has arisen in the process.** An SSO account with an
        // additional, quiet way in is exactly what ADR-0012
        // rules out.
        expect(row.passwordHash).toBeNull();
      }
    });

    it('weist eine Adresse ab, die schon einem anderen Konto gehört', async () => {
      const person = await member('collide');
      const occupied = await member('occupied');

      const response = await putMember(admin, person.id, {
        groupId: alpha.adminGroupId,
        name: 'Kollision',
        email: occupied.email,
      });

      expect(response.status).toBe(409);
      expect((response.body as { message: string }).message).toBe(
        EMAIL_ALREADY_USED_MESSAGE,
      );
      expect((await stored(person.id)).email).toBe(person.email);
      expect((await stored(occupied.id)).email).toBe(occupied.email);
    });
  });
});
