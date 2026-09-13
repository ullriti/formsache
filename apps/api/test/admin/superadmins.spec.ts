import { parseSuperadminList } from '@formsache/shared';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  ALREADY_SUPERADMIN_MESSAGE,
  LAST_SUPERADMIN_MESSAGE,
  NOT_A_SUPERADMIN_MESSAGE,
  SUPERADMIN_WITHOUT_TENANT_MESSAGE,
} from '../../src/admin/superadmins.service';
import { INVITATION_NO_MAIL_SERVER_MESSAGE } from '../../src/auth/invitation/account-invitation';
import { CSRF_FAILED_MESSAGE } from '../../src/auth/csrf.guard';
import { NOT_SUPERADMIN_MESSAGE } from '../../src/auth/superadmin.guard';
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
 * **The second superadministrator** (ADR-0029) — appointing, revoking, and
 * the four refusals.
 *
 * Up to here an installation got a second superadministrator only through the
 * database: `scripts/create-superadmin.sh` and `POST /api/setup` both demand
 * *zero* rows in `user` (ADR-0022 §3). The one superadministrator was thereby
 * a single point of failure.
 *
 * ## The trap sits in the fixture, not in the code
 *
 * The refused person is the **administrator of their organisation**: the system
 * group `admin`, all six group permissions, `canManageUsers` included. A
 * refused person who happens to hold nothing would prove only that *some*
 * guard fires — the same fixture trap that
 * `system-settings/permissions.spec.ts` writes out. The first case below
 * measures the six flags itself, so that a fixture which quietly stops
 * granting them does not make the rest of this file meaningless.
 *
 * ## Why „the last one removes themselves" is the same case
 *
 * Whoever writes here is a superadministrator themselves (`SuperadminGuard`).
 * If the target is somebody **else**, there are therefore at least two — the
 * count cannot fall to one at all. The only way to the last appointment
 * therefore leads through one's own account, and „the last superadmin removes
 * themselves" and „the last superadmin is removed" are the same request. A
 * **different** self-revocation — one of two resigns — is expressly permitted
 * and measured below: that is the rule which `lastAdminMessage` sets up one
 * level further down for the last administrator of an organisation, and a user
 * interface that forbids more than the server lies about the rule.
 *
 * ## Counter-checks that were run (all measured while writing this file)
 *
 * - `SuperadminGuard` removed from the guard chain of the controller → **four**
 *   cases red: the list answers the organisation administrator with 200, both
 *   appointments with 201 — they appoint themselves —, and the revocation falls
 *   to 409, that is to the refusal of the *next* rule instead of to the guard.
 * - `others === 0` set to `others < 0` → „the last one cannot remove
 *   themselves" **and** the parallel case red, both with 204: the installation
 *   stands there without system administration.
 * - The pre-lock taken out of `demote` → the parallel case below red: both
 *   requests get through, `is_superadmin` stands nowhere afterwards.
 * - **For the membership condition a pair, and the pair is the point.**
 *   It stands there twice — as an `if` for the message and in the `where` of
 *   the statement that acts —, and only the second one carries under
 *   concurrency. From the outside the two cannot be told apart: reverting the
 *   `where` alone stays **green**, because the `if` takes hold first
 *   (measured). What tells them apart is the pair:
 *     1. `if` removed, `where` kept → **green**, all three membership cases.
 *        The condition in the `where` carries them on its own.
 *     2. `if` removed **and** `where` back to `{ id, isSuperadmin }` →
 *        **red**, the same three with 204 instead of 409.
 *   The real interleaving — the membership disappears *between* the read and
 *   the write of the same transaction — cannot be staged over HTTP; that is
 *   why it stands written out in `superadmins.service.ts` at the `where` that
 *   catches it.
 * - `superadminPromoteSchema` set from `strictObject` to `object` → the
 *   400 case for an `isSuperadmin` sent along red.
 */

const PASSWORD = 'test-password-sa';
const SUPERADMINS = apiPath('/admin/superadmins');
/** Any route behind the same guard — the touchstone for „does the permission apply now?". */
const SYSTEM_MAIL = apiPath('/admin/system-settings/mail');

describe('den zweiten Superadministrator ernennen', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  let alpha: TenantFixture;

  /** The first superadministrator of the installation — member in alpha. */
  let rootId: string;
  let root: string;
  /** `admin` in alpha: all six group permissions, no superadmin. */
  let tenantAdminId: string;
  let tenantAdmin: string;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });

    alpha = await createTenant(testApp.prisma, 'SUPX');

    const first = await createUser(testApp.prisma, {
      email: 'root@superadmins.example',
      password: PASSWORD,
      tenants: [alpha],
      isSuperadmin: true,
    });
    rootId = first.id;
    root = await openSession(testApp, first.id, alpha.id);

    const admin = await createUser(testApp.prisma, {
      email: 'admin@superadmins.example',
      password: PASSWORD,
      tenants: [alpha],
    });
    tenantAdminId = admin.id;
    tenantAdmin = await openSession(testApp, admin.id, alpha.id);
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  afterEach(async () => {
    // The initial state of this file: **exactly one** superadministrator.
    // If an appointment stayed in place, the previous case would decide what
    // „the last one" means in the next.
    await app().prisma.user.updateMany({
      where: { id: { not: rootId }, isSuperadmin: true },
      data: { isSuperadmin: false },
    });
    await app().prisma.user.update({
      where: { id: rootId },
      data: { isSuperadmin: true },
    });
  });

  /** What stands in the column — not what an answer claims. */
  async function storedFlag(userId: string): Promise<boolean> {
    const row = await app().prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { isSuperadmin: true },
    });
    return row.isSuperadmin;
  }

  function list(session: string) {
    return request(app().server)
      .get(SUPERADMINS)
      .set('Cookie', cookieHeader(session));
  }

  function promote(session: string, body: object) {
    return request(app().server)
      .post(SUPERADMINS)
      .set(authedMutation(session))
      .send(body);
  }

  function demote(session: string, userId: string) {
    return request(app().server)
      .delete(`${SUPERADMINS}/${userId}`)
      .set(authedMutation(session));
  }

  /** A fresh person in alpha, without any system permission. */
  async function newcomer(local: string): Promise<{
    id: string;
    email: string;
  }> {
    return createUser(app().prisma, {
      email: `${local}@superadmins.example`,
      password: PASSWORD,
      tenants: [alpha],
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // The fixture itself — otherwise none of the 403 cases measures what it claims
  // ═══════════════════════════════════════════════════════════════════════

  it('gibt der abgewiesenen Person jedes Gruppenrecht, das es gibt', async () => {
    const me = await request(app().server)
      .get(apiPath('/auth/me'))
      .set('Cookie', cookieHeader(tenantAdmin));

    expect(me.status).toBe(200);
    const body = me.body as {
      isSuperadmin: boolean;
      memberships: {
        group: { name: string; isSystem: boolean };
        permissions: Record<string, boolean>;
      }[];
    };
    expect(body.isSuperadmin).toBe(false);
    const [membership] = body.memberships;
    expect(membership?.group).toMatchObject({ name: 'admin', isSystem: true });
    expect(membership?.permissions).toEqual({
      canBuild: true,
      canViewResponses: true,
      canExport: true,
      canManageSettings: true,
      canManageFormSettings: true,
      canManageUsers: true,
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // The guard — every rule via the case that must fail
  // ═══════════════════════════════════════════════════════════════════════

  describe('nur ein Superadministrator kommt an diese Routen', () => {
    it('weist die Administratorin ihrer Organisation beim Lesen mit 403 ab', async () => {
      const refused = await list(tenantAdmin);

      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ message: NOT_SUPERADMIN_MESSAGE });
      // The list names names and addresses of the people who administer this
      // installation. None of that may stand in the refusal.
      expect(JSON.stringify(refused.body)).not.toContain(
        'root@superadmins.example',
      );
    });

    it('weist sie beim Ernennen mit 403 ab — und schreibt nichts', async () => {
      const candidate = await newcomer('kandidat-403');

      const refused = await promote(tenantAdmin, { email: candidate.email });

      expect(refused.status).toBe(403);
      // Checked with a query of its own and not on the answer: a refused
      // write operation that wrote anyway looks exactly the same from the
      // outside.
      expect(await storedFlag(candidate.id)).toBe(false);
    });

    it('weist sie beim Ernennen ihrer selbst mit 403 ab', async () => {
      // The path on which somebody would appoint themselves, if there were one:
      // one's own address into the body.
      const refused = await promote(tenantAdmin, {
        email: 'admin@superadmins.example',
      });

      expect(refused.status).toBe(403);
      expect(await storedFlag(tenantAdminId)).toBe(false);
    });

    it('weist sie beim Zurücknehmen mit 403 ab — und schreibt nichts', async () => {
      const refused = await demote(tenantAdmin, rootId);

      expect(refused.status).toBe(403);
      expect(await storedFlag(rootId)).toBe(true);
    });

    it('weist eine Anfrage ohne CSRF-Kopf ab', async () => {
      const candidate = await newcomer('kandidat-csrf');

      const refused = await request(app().server)
        .post(SUPERADMINS)
        .set('Cookie', cookieHeader(root))
        .send({ email: candidate.email });

      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ message: CSRF_FAILED_MESSAGE });
      expect(await storedFlag(candidate.id)).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // The permitted case
  // ═══════════════════════════════════════════════════════════════════════

  describe('ein Superadministrator ernennt', () => {
    it('listet, wer die Systemverwaltung trägt', async () => {
      const response = await list(root);

      expect(response.status).toBe(200);
      const { superadmins } = parseSuperadminList(response.body);
      expect(superadmins).toEqual([
        {
          userId: rootId,
          email: 'root@superadmins.example',
          name: expect.any(String) as string,
          hasMembership: true,
          invitationPending: false,
        },
      ]);
    });

    /**
     * **The two markers of the row, measured against the real state.**
     *
     * Both decide something and are derived by the server, not by the user
     * interface: `hasMembership` is the preview of a refusal
     * ({@link SUPERADMIN_WITHOUT_TENANT_MESSAGE}), `invitationPending` says
     * that nobody has ever got into this account — whoever holds the
     * invitation link thereby administers the system.
     *
     * The account comes into being here **directly in the database** and not
     * through the fixture: without a password `createUser` creates a *bound*
     * SSO account (issuer **and** subject), and that is exactly the case
     * `invitationPending` does not mean.
     */
    it('meldet ein Konto ohne Organisation und ohne je eine Anmeldung', async () => {
      const pending = await app().prisma.user.create({
        data: {
          email: 'nie-angemeldet@superadmins.example',
          name: 'Noch Niemand',
          isSuperadmin: true,
        },
        select: { id: true },
      });

      const response = await list(root);

      expect(response.status).toBe(200);
      const { superadmins } = parseSuperadminList(response.body);
      expect(
        superadmins.find((entry) => entry.userId === pending.id),
      ).toMatchObject({ hasMembership: false, invitationPending: true });
      // The counter-check in the same answer: an account with a password and
      // a membership carries both markers the other way round. Without it the
      // case would be green even with two hard-wired `true`.
      expect(
        superadmins.find((entry) => entry.userId === rootId),
      ).toMatchObject({ hasMembership: true, invitationPending: false });

      await app().prisma.user.delete({ where: { id: pending.id } });
    });

    it('macht aus einem vorhandenen Konto einen zweiten Superadministrator', async () => {
      const candidate = await newcomer('zweiter');

      const created = await promote(root, {
        email: candidate.email,
        name: 'Kandidat Person',
      });

      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        userId: candidate.id,
        email: candidate.email,
        hasMembership: true,
        invitationPending: false,
      });
      expect(await storedFlag(candidate.id)).toBe(true);

      const after = parseSuperadminList((await list(root)).body);
      expect(after.superadmins.map((entry) => entry.userId)).toContain(
        candidate.id,
      );
    });

    it('nimmt die Adresse so, wie ein Mensch sie tippt', async () => {
      const candidate = await newcomer('gross-und-klein');

      // `emailAddressSchema` trims and lowercases — the same normalisation
      // with which the login finds its row. Without it this route would not
      // find the account the operator means.
      const created = await promote(root, {
        email: `  ${candidate.email.toUpperCase()} `,
        name: 'Kandidat Person',
      });

      expect(created.status).toBe(201);
      expect(await storedFlag(candidate.id)).toBe(true);
    });

    /**
     * **The session carries no stale permission** — and needs no revocation.
     *
     * `SessionGuard` resolves the `user` row on **every** request, and
     * `SuperadminGuard` reads the flag from there. The appointment therefore
     * takes effect on the next request of the same, long-open session — and
     * the revocation likewise. Were the permission stamped into the session, a
     * session destruction would stand here; it would be necessary and it would
     * be missing.
     */
    it('wirkt sofort in einer längst offenen Sitzung — in beide Richtungen', async () => {
      const candidate = await newcomer('offene-sitzung');
      const session = await openSession(app(), candidate.id, alpha.id);

      const before = await request(app().server)
        .get(SYSTEM_MAIL)
        .set('Cookie', cookieHeader(session));
      expect(before.status).toBe(403);

      expect(
        (
          await promote(root, {
            email: candidate.email,
            name: 'Kandidat Person',
          })
        ).status,
      ).toBe(201);

      const granted = await request(app().server)
        .get(SYSTEM_MAIL)
        .set('Cookie', cookieHeader(session));
      expect(granted.status).toBe(200);

      expect((await demote(root, candidate.id)).status).toBe(204);

      const revoked = await request(app().server)
        .get(SYSTEM_MAIL)
        .set('Cookie', cookieHeader(session));
      expect(revoked.status).toBe(403);
    });

    it('lässt einen von zweien zurücktreten — auch sich selbst', async () => {
      const candidate = await newcomer('ruecktritt');
      expect(
        (
          await promote(root, {
            email: candidate.email,
            name: 'Kandidat Person',
          })
        ).status,
      ).toBe(201);
      const session = await openSession(app(), candidate.id, alpha.id);

      // The self-revocation that is **not** the last one. Permitted, like the
      // demotion of the second-to-last administrator of an organisation
      // (`lastAdminMessage`): whoever can leave their own seat only via
      // somebody else is stuck.
      const response = await demote(session, candidate.id);

      expect(response.status).toBe(204);
      expect(await storedFlag(candidate.id)).toBe(false);
      expect(await storedFlag(rootId)).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // The refusals
  // ═══════════════════════════════════════════════════════════════════════

  describe('was die Ernennung abweist', () => {
    /**
     * **Ohne Mailserver entsteht kein Konto** (ADR-0024, hier für die
     * Systemverwaltung).
     *
     * Bis Review-Runde 3 Nr. 13 antwortete diese Route auf eine unbekannte
     * Adresse mit 404 („Ernennen lässt sich nur, wer schon eines hat"). Jetzt
     * lädt sie ein — und genau deshalb misst dieser Fall weiter dieselbe
     * Zusage wie vorher, nur an ihrer neuen Stelle: **es entsteht kein
     * Konto, wenn die Einladung nicht hinausgehen kann.**
     *
     * Diese Testanwendung hat keinen Mailserver eingetragen, die Absage ist
     * also die von `AccountInvitationService.plan` — 422 mit dem Satz, der
     * sagt, wo es einzutragen ist. Der glückliche Weg steht in
     * `superadmin-invitation.spec.ts`, mit einem echten SMTP-Empfänger.
     */
    it('legt ohne Mailserver kein Konto an, sondern sagt warum', async () => {
      const refused = await promote(root, {
        email: 'gibt-es-nicht@superadmins.example',
        name: 'Gibt Es Nicht',
      });

      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({
        message: INVITATION_NO_MAIL_SERVER_MESSAGE,
      });
      /*
        **The second half, and the actual promise** (a review finding): no
        account comes into being. Without a delivered invitation it would be
        an account nobody can redeem whose address is taken installation-wide
        — the state ADR-0024 orders the steps against. The status alone says
        nothing about that.
      */
      expect(
        await app().prisma.user.count({
          where: { email: 'gibt-es-nicht@superadmins.example' },
        }),
      ).toBe(0);
    });

    it('antwortet 409, wenn die Person das System schon verwaltet', async () => {
      const refused = await promote(root, {
        email: 'root@superadmins.example',
        name: 'Root Person',
      });

      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({
        message: ALREADY_SUPERADMIN_MESSAGE,
      });
    });

    it('weist ein mitgeschicktes `isSuperadmin` mit 400 ab', async () => {
      const candidate = await newcomer('schmuggel');

      const refused = await promote(root, {
        email: candidate.email,
        name: 'Kandidat Person',
        isSuperadmin: true,
      });

      expect(refused.status).toBe(400);
      expect(await storedFlag(candidate.id)).toBe(false);
    });
  });

  describe('was den Entzug abweist', () => {
    it('lässt den letzten Superadministrator nicht gehen', async () => {
      // The reason this whole user interface exists, from the other side: an
      // installation without a superadministrator cannot give itself a new one
      // — `POST /api/setup` demands zero rows in `user`.
      const refused = await demote(root, rootId);

      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ message: LAST_SUPERADMIN_MESSAGE });
      expect(await storedFlag(rootId)).toBe(true);
    });

    it('lässt ein Konto ohne Organisation nicht heimatlos zurück', async () => {
      const lonely = await createUser(app().prisma, {
        email: 'ohne-organisation@superadmins.example',
        password: PASSWORD,
        isSuperadmin: true,
      });

      const refused = await demote(root, lonely.id);

      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({
        message: SUPERADMIN_WITHOUT_TENANT_MESSAGE,
      });
      // The row still stands — and that is exactly the point: without the
      // refusal `deleteHomelessAccounts` would delete it at the next cleanup
      // run.
      expect(await storedFlag(lonely.id)).toBe(true);

      await app().prisma.user.delete({ where: { id: lonely.id } });
    });

    it('nennt eine Mitgliedschaft in einer gelöschten Organisation keine Heimat', async () => {
      const closed = await createTenant(app().prisma, 'SUPZ');
      const stranded = await createUser(app().prisma, {
        email: 'in-geloeschter-organisation@superadmins.example',
        password: PASSWORD,
        tenants: [closed],
        isSuperadmin: true,
      });
      await app().prisma.tenant.update({
        where: { id: closed.id },
        data: { deletedAt: new Date() },
      });

      const refused = await demote(root, stranded.id);

      // The membership still exists, but it passes away with the
      // organisation: 30 days later the purge takes it along, and the account
      // would afterwards be exactly the homeless remainder that the refusal
      // prevents.
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({
        message: SUPERADMIN_WITHOUT_TENANT_MESSAGE,
      });
      expect(await storedFlag(stranded.id)).toBe(true);

      await app().prisma.user.delete({ where: { id: stranded.id } });
      await app().prisma.tenant.delete({ where: { id: closed.id } });
    });

    /**
     * **The race that the pre-lock does not cover** (a review finding).
     *
     * The lock lines up the callers of `demote`. The membership, however, is
     * deleted by somebody else entirely: an organisation administrator with
     * `can_manage_users` via *Person entfernen* — no superadmin needed. If
     * that happens between the read and the write, the account would
     * afterwards stand there as a non-superadmin **without any membership**,
     * and the cleanup run (`deleteHomelessAccounts`, on a timer) would delete
     * it for good — sessions and form permissions included.
     *
     * ⚠️ **What this case measures and what it does not.** It runs the part
     * reachable *deterministically* from the outside: the membership is gone
     * before the revocation begins. The real interleaving — gone *between* the
     * read and the write of the same transaction — cannot be staged over HTTP;
     * what catches it is the condition in the `where` of the statement that
     * acts. How far this case reaches towards that stands in the head of the
     * file among the reproductions.
     */
    it('lässt die Ernennung stehen, wenn die letzte Mitgliedschaft zwischendurch verschwindet', async () => {
      const stranded = await newcomer('mitgliedschaft-weg');
      expect(
        (
          await promote(root, {
            email: stranded.email,
            name: 'Gestrandet Person',
          })
        ).status,
      ).toBe(201);
      const listed = parseSuperadminList(
        (await list(root)).body,
      ).superadmins.find((entry) => entry.userId === stranded.id);
      // The list still saw them with a place — that is the state a human
      // clicks on.
      expect(listed?.hasMembership).toBe(true);

      // And now somebody else takes the stranded person out of their last
      // organisation.
      await app().prisma.membership.deleteMany({
        where: { userId: stranded.id },
      });

      const refused = await demote(root, stranded.id);

      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({
        message: SUPERADMIN_WITHOUT_TENANT_MESSAGE,
      });
      expect(await storedFlag(stranded.id)).toBe(true);
      // The actual promise: the account still stands. With `isSuperadmin:
      // false` it would be the homeless remainder that the next run takes
      // along.
      expect(
        await app().prisma.user.count({ where: { id: stranded.id } }),
      ).toBe(1);

      await app().prisma.user.delete({ where: { id: stranded.id } });
    });

    /**
     * The counter-check for the filter „only living organisations": **one**
     * living membership suffices, even when a deleted one stands beside it.
     *
     * Without this case the filter would only be proved negatively — an
     * implementation that already read „any membership in a deleted
     * organisation" as homelessness would stay green and refuse the
     * revocation for people who very much do have a place.
     */
    it('entzieht, solange eine lebende Organisation bleibt', async () => {
      const closed = await createTenant(app().prisma, 'SUPY');
      const person = await createUser(app().prisma, {
        email: 'zwei-organisationen@superadmins.example',
        password: PASSWORD,
        tenants: [alpha, closed],
        isSuperadmin: true,
      });
      await app().prisma.tenant.update({
        where: { id: closed.id },
        data: { deletedAt: new Date() },
      });

      const response = await demote(root, person.id);

      expect(response.status).toBe(204);
      expect(await storedFlag(person.id)).toBe(false);

      await app().prisma.user.delete({ where: { id: person.id } });
      await app().prisma.tenant.delete({ where: { id: closed.id } });
    });

    it('antwortet 404 für ein Konto, das die Systemverwaltung nicht trägt', async () => {
      const refused = await demote(root, tenantAdminId);

      expect(refused.status).toBe(404);
      /*
        **The sentence of the revocation, not that of the appointment** (a
        review finding). `SUPERADMIN_ACCOUNT_NOT_FOUND_MESSAGE` speaks of an
        e-mail address and of appointing — here an identifier arrived, and what
        was wanted was the revocation. Were the other sentence to stand here,
        this case would fix a wrong piece of information as the expected
        behaviour.
      */
      expect(refused.body).toMatchObject({
        message: NOT_A_SUPERADMIN_MESSAGE,
      });
    });

    it('antwortet 404 für eine Kennung, die keine ist', async () => {
      const refused = await demote(root, 'nicht-einmal-eine-uuid');

      expect(refused.status).toBe(404);
      expect(refused.body).toMatchObject({
        message: NOT_A_SUPERADMIN_MESSAGE,
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Concurrency — the promise hangs on a number, and numbers run away
  // ═══════════════════════════════════════════════════════════════════════

  it('lässt zwei gleichzeitige Entzüge nicht beide durch', async () => {
    const second = await newcomer('parallel');
    expect(
      (await promote(root, { email: second.email, name: 'Zweite Person' }))
        .status,
    ).toBe(201);

    // Two superadministrators, two requests, each takes the other's
    // appointment away. Without the pre-lock each would see „there are two"
    // and both would write — the installation would stand there afterwards
    // without system administration.
    const [first, other] = await Promise.all([
      demote(root, second.id),
      demote(root, rootId),
    ]);

    const codes = [first.status, other.status].sort((a, b) => a - b);
    expect(codes).toEqual([204, 409]);

    const left = await app().prisma.user.count({
      where: { isSuperadmin: true },
    });
    expect(left).toBe(1);
  });
});
