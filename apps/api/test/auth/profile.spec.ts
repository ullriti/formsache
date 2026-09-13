import { randomBytes, randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { verifyPassword } from '../../src/auth/password';
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
import {
  authedMutation,
  cookieHeader,
  openSession,
  sessionCookie,
} from '../support/http';

const PASSWORD = 'ein hinreichend langes passwort';
const NEW_PASSWORD = 'ein anderes hinreichend langes passwort';

/**
 * **One's own profile** (findings 12 and 17).
 *
 * Two routes in which there is no foreign identifier: `PUT /auth/profile` and
 * `POST /auth/password` read the person exclusively out of the session. What
 * is to be proven here is therefore not a permission matrix, but **that there
 * is no parameter through which someone catches another account** — and the
 * one real limit of self-service: the old password.
 *
 * | What is tried | What has to hold |
 * |---|---|
 * | without a session | 401, nothing written |
 * | password change | ends **every** login and replaces one's own |
 * | wrong „aktuelles Passwort" | 401, password unchanged |
 * | an SSO account changes its password | 422 — it has none |
 * | body with a foreign identifier | acts on one's **own** row, never on the named one |
 *
 * Since finding 8 `POST /auth/email` has come in addition, and with it the
 * second real limit of self-service: the address is the **login key**, so
 * changing it costs the same as changing the password.
 *
 * | What is tried | What has to hold |
 * |---|---|
 * | wrong password | 401, address unchanged |
 * | without a session | 401, address unchanged |
 * | address of a foreign account | 409, **both** rows unchanged |
 * | an SSO account changes its address | 422, address unchanged |
 * | successful | address new, open reset links dead, session alive |
 */
describe('das eigene Profil', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  let alpha: TenantFixture;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });
    alpha = await createTenant(testApp.prisma, 'PROF');
  }, 180_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  async function person(slug: string): Promise<{ id: string; email: string }> {
    return createUser(app().prisma, {
      email: `profile-${slug}@example.org`,
      password: PASSWORD,
      tenants: [alpha],
    });
  }

  function updateProfile(token: string, body: object): request.Test {
    return request(app().server)
      .put(apiPath('/auth/profile'))
      .set(authedMutation(token))
      .send(body);
  }

  function changePassword(token: string, body: object): request.Test {
    return request(app().server)
      .post(apiPath('/auth/password'))
      .set(authedMutation(token))
      .send(body);
  }

  function changeEmail(token: string, body: object): request.Test {
    return request(app().server)
      .post(apiPath('/auth/email'))
      .set(authedMutation(token))
      .send(body);
  }

  async function emailOf(userId: string): Promise<string> {
    return (
      await app().prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { email: true },
      })
    ).email;
  }

  async function passwordOf(
    userId: string,
    candidate: string,
  ): Promise<boolean> {
    const row = await app().prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { passwordHash: true },
    });
    return row.passwordHash !== null
      ? verifyPassword(row.passwordHash, candidate)
      : false;
  }

  describe('den eigenen Namen ändern', () => {
    it('schreibt den Namen und antwortet mit dem ganzen angemeldeten Nutzer', async () => {
      const me = await person('rename');
      const session = await openSession(testApp, me.id, alpha.id);

      const response = await updateProfile(session, { name: 'Selbst Benannt' });

      expect(response.status).toBe(200);
      // The whole `SessionUser`, not only the changed field: the name stands
      // in the header line, in the member list and in the profile.
      const body = response.body as { id: string; name: string };
      expect(body.id).toBe(me.id);
      expect(body.name).toBe('Selbst Benannt');
      expect(
        (
          await app().prisma.user.findUniqueOrThrow({
            where: { id: me.id },
            select: { name: true },
          })
        ).name,
      ).toBe('Selbst Benannt');
    });

    it('ändert nie ein anderes Konto, auch wenn der Rumpf eine Kennung mitschickt', async () => {
      // **There is no parameter for another person.** The schema is a
      // `strictObject` with one field; a `userId` in the body is therefore no
      // silent addition, but a body that the validation refuses.
      const me = await person('strict-me');
      const other = await person('strict-other');
      const session = await openSession(testApp, me.id, alpha.id);

      const response = await updateProfile(session, {
        name: 'Fremd Benannt',
        userId: other.id,
      });

      expect(response.status).toBe(400);
      const stored = await app().prisma.user.findMany({
        where: { id: { in: [me.id, other.id] } },
        select: { id: true, name: true },
      });
      expect(stored.every((row) => row.name !== 'Fremd Benannt')).toBe(true);
    });

    it('antwortet ohne Sitzung mit 401 und schreibt nichts', async () => {
      const me = await person('anonymous');
      const before = await app().prisma.user.findUniqueOrThrow({
        where: { id: me.id },
        select: { name: true },
      });

      const response = await request(app().server)
        .put(apiPath('/auth/profile'))
        .set('Content-Type', 'application/json')
        .send({ name: 'Ohne Anmeldung' });

      expect(response.status).toBe(401);
      expect(
        (
          await app().prisma.user.findUniqueOrThrow({
            where: { id: me.id },
            select: { name: true },
          })
        ).name,
      ).toBe(before.name);
    });
  });

  describe('die eigene E-Mail-Adresse ändern (Befund 8)', () => {
    it('schreibt die Adresse, entwertet offene Rücksetz-Links und lässt die Sitzung leben', async () => {
      const me = await person('email-change');
      const session = await openSession(testApp, me.id, alpha.id);
      // A link that went to the **old** address. Were it to survive the
      // change, the old mailbox would still have a second key afterwards.
      const openToken = await app().prisma.passwordResetToken.create({
        data: {
          id: randomUUID(),
          userId: me.id,
          tokenHash: randomBytes(32),
          expiresAt: new Date(Date.now() + 3_600_000),
        },
        select: { id: true },
      });

      const response = await changeEmail(session, {
        currentPassword: PASSWORD,
        email: '  Profile-Neu@Example.ORG ',
      });

      expect(response.status).toBe(200);
      // Normalised as everywhere: trimmed and lower-cased, otherwise the
      // login would not find the row again via the `unique` index.
      expect(await emailOf(me.id)).toBe('profile-neu@example.org');
      // The whole `SessionUser`, as with the name change — the address stands
      // in the header line.
      expect((response.body as { email: string }).email).toBe(
        'profile-neu@example.org',
      );
      expect(
        (
          await app().prisma.passwordResetToken.findUniqueOrThrow({
            where: { id: openToken.id },
            select: { usedAt: true },
          })
        ).usedAt,
      ).not.toBeNull();
      // And one's own session lives: an address is not an access, and whoever
      // has just shown their password need not do it a second time.
      expect(
        (
          await request(app().server)
            .get(apiPath('/auth/me'))
            .set('Cookie', cookieHeader(session))
        ).status,
      ).toBe(200);
    });

    it('weist ein falsches Passwort ab und lässt die Adresse stehen', async () => {
      // **The limit.** Without it, an unattended machine with an open
      // session would be an account whose login key the next person along
      // bends over to their own mailbox — and after that the
      // password prompt next door is worthless too, because „Passwort
      // vergessen" does the rest.
      const me = await person('email-wrong-password');
      const session = await openSession(testApp, me.id, alpha.id);

      const response = await changeEmail(session, {
        currentPassword: 'das ist es nicht gewesen',
        email: 'profile-abgewiesen@example.org',
      });

      expect(response.status).toBe(401);
      expect(await emailOf(me.id)).toBe(me.email);
    });

    it('antwortet ohne Sitzung mit 401 und schreibt nichts', async () => {
      const me = await person('email-anonymous');

      const response = await request(app().server)
        .post(apiPath('/auth/email'))
        .set('Content-Type', 'application/json')
        .send({ currentPassword: PASSWORD, email: 'ohne@example.org' });

      expect(response.status).toBe(401);
      expect(await emailOf(me.id)).toBe(me.email);
    });

    it('weist die Adresse eines **fremden** Kontos mit 409 ab — und rührt keine der beiden Zeilen an', async () => {
      // The case that, without a translation, the `P2002` of the `unique`
      // index would have answered as a 500 with an index name. More important
      // than the status code is the second half: the foreign row stays as it
      // was — this route is no way to take over an address already in use.
      const me = await person('email-taken-me');
      const other = await person('email-taken-other');
      const session = await openSession(testApp, me.id, alpha.id);

      const response = await changeEmail(session, {
        currentPassword: PASSWORD,
        email: other.email,
      });

      expect(response.status).toBe(409);
      expect(await emailOf(me.id)).toBe(me.email);
      expect(await emailOf(other.id)).toBe(other.email);
    });

    it('weist ein SSO-Konto ab, ohne seine Adresse zu berühren', async () => {
      // An SSO account has no local password — it could not pay the price at
      // all —, and its address is an image of what the
      // login service reports (ADR-0012). The organisation administration
      // draws the same line.
      const ssoAccount = await createUser(app().prisma, {
        email: 'profile-sso-email@example.org',
        tenants: [alpha],
      });
      const session = await openSession(testApp, ssoAccount.id, alpha.id);

      const response = await changeEmail(session, {
        currentPassword: 'egal',
        email: 'profile-sso-neu@example.org',
      });

      expect(response.status).toBe(422);
      expect(await emailOf(ssoAccount.id)).toBe(ssoAccount.email);
    });

    it('hat kein Feld für eine fremde Kennung — und keines ohne Passwort', async () => {
      const me = await person('email-strict-me');
      const other = await person('email-strict-other');
      const session = await openSession(testApp, me.id, alpha.id);

      // `strictObject`: an identifier sent along is no silent addition.
      expect(
        (
          await changeEmail(session, {
            currentPassword: PASSWORD,
            email: 'profile-strict-neu@example.org',
            userId: other.id,
          })
        ).status,
      ).toBe(400);
      // And without a password the request does not even reach the service.
      expect(
        (
          await changeEmail(session, {
            email: 'profile-strict-neu@example.org',
          })
        ).status,
      ).toBe(400);

      expect(await emailOf(me.id)).toBe(me.email);
      expect(await emailOf(other.id)).toBe(other.email);
    });
  });

  describe('das eigene Passwort ändern', () => {
    it('beendet **jede** Anmeldung und ersetzt die eigene durch eine frische', async () => {
      // **A security finding, and the reversal of the first version.** That
      // one left the other sessions standing, with the argument „routine
      // change". The expensive case is the other one: whoever notices a
      // takeover changes their password first — and would achieve nothing by
      // it, because the intruder's session token knows no password and keeps
      // running for up to 720 hours.
      const me = await person('change');
      const here = await openSession(testApp, me.id, alpha.id);
      const elsewhere = await openSession(testApp, me.id, alpha.id);

      const response = await changePassword(here, {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      });

      expect(response.status).toBe(200);
      expect(await passwordOf(me.id, NEW_PASSWORD)).toBe(true);
      expect(await passwordOf(me.id, PASSWORD)).toBe(false);
      // Both: the foreign one **and** one's own.
      expect((response.body as { revoked: number }).revoked).toBe(2);

      // The other device is logged out …
      expect(
        (
          await request(app().server)
            .get(apiPath('/auth/me'))
            .set('Cookie', cookieHeader(elsewhere))
        ).status,
      ).toBe(401);

      // … and one's own old token as well: the revocation took it along.
      expect(
        (
          await request(app().server)
            .get(apiPath('/auth/me'))
            .set('Cookie', cookieHeader(here))
        ).status,
      ).toBe(401);

      // **But the response carries the replacement session**, otherwise the
      // browser would fall back to the login and nobody would read the
      // confirmation.
      const replacement = sessionCookie(response);
      expect(replacement).not.toBe(here);
      expect(
        (
          await request(app().server)
            .get(apiPath('/auth/me'))
            .set('Cookie', cookieHeader(replacement))
        ).status,
      ).toBe(200);
    });

    it('gibt der Ersatzsitzung ein passendes CSRF-Cookie mit', async () => {
      // The readable half is derived from the session token; were the old one
      // to stay, the next mutation would fail with a 403 that looks like a
      // permission error and is none.
      const me = await person('csrf-pair');
      const session = await openSession(testApp, me.id, alpha.id);

      const changed = await changePassword(session, {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      });
      const replacement = sessionCookie(changed);

      const revoke = await request(app().server)
        .post(apiPath('/auth/sessions/revoke-others'))
        .set(authedMutation(replacement));
      expect(revoke.status).toBe(201);
    });

    it('weist ein falsches aktuelles Passwort ab und lässt das alte gelten', async () => {
      // **The actual limit of self-service.** Without it, an unattended
      // machine with an open session would be an account that the next person
      // along takes over for good.
      const me = await person('wrong-current');
      const session = await openSession(testApp, me.id, alpha.id);

      const response = await changePassword(session, {
        currentPassword: 'das ist es nicht gewesen',
        newPassword: NEW_PASSWORD,
      });

      expect(response.status).toBe(401);
      expect(await passwordOf(me.id, PASSWORD)).toBe(true);
      expect(await passwordOf(me.id, NEW_PASSWORD)).toBe(false);
    });

    it('weist ein SSO-Konto ab, ohne ihm ein Passwort zu geben', async () => {
      const ssoAccount = await createUser(app().prisma, {
        email: 'profile-sso@example.org',
        tenants: [alpha],
      });
      const session = await openSession(testApp, ssoAccount.id, alpha.id);

      const response = await changePassword(session, {
        currentPassword: 'egal',
        newPassword: NEW_PASSWORD,
      });

      expect(response.status).toBe(422);
      expect(
        (
          await app().prisma.user.findUniqueOrThrow({
            where: { id: ssoAccount.id },
            select: { passwordHash: true },
          })
        ).passwordHash,
      ).toBeNull();
    });

    it('weist ein zu kurzes neues Passwort ab, bevor irgendetwas geschrieben wird', async () => {
      const me = await person('too-short');
      const session = await openSession(testApp, me.id, alpha.id);

      const response = await changePassword(session, {
        currentPassword: PASSWORD,
        newPassword: 'kurz',
      });

      expect(response.status).toBe(400);
      expect(await passwordOf(me.id, PASSWORD)).toBe(true);
    });
  });

  describe('andere Sitzungen beenden — dieselbe Route, jetzt im Profil (Befund 17)', () => {
    it('beendet die anderen, lässt die eigene leben und nennt die Zahl', async () => {
      const me = await person('revoke');
      const here = await openSession(testApp, me.id, alpha.id);
      const there = await openSession(testApp, me.id, alpha.id);

      const response = await request(app().server)
        .post(apiPath('/auth/sessions/revoke-others'))
        .set(authedMutation(here));

      expect(response.status).toBe(201);
      expect((response.body as { revoked: number }).revoked).toBe(1);
      expect(
        (
          await request(app().server)
            .get(apiPath('/auth/me'))
            .set('Cookie', cookieHeader(here))
        ).status,
      ).toBe(200);
      expect(
        (
          await request(app().server)
            .get(apiPath('/auth/me'))
            .set('Cookie', cookieHeader(there))
        ).status,
      ).toBe(401);
    });
  });
});
