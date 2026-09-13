import { randomBytes } from 'node:crypto';
import {
  ACCOUNT_INVITATION_SEGMENT,
  ACCOUNT_INVITATION_TTL_DAYS,
  PASSWORD_RESET_INVALID_MESSAGE,
  PASSWORD_RESET_LINK_MARK,
  PASSWORD_RESET_TTL_MINUTES,
} from '@formsache/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  INVITATION_NO_BASE_URL_MESSAGE,
  INVITATION_NO_MAIL_SERVER_MESSAGE,
} from '../../src/auth/invitation/account-invitation';
import { MailSecretsService } from '../../src/mail/mail-secrets.service';
import { SYSTEM_IDENTITY_KEY } from '../../src/mail/mail-transport';
import { MailWorkerService } from '../../src/mail/mail-worker.service';
import { MISSING_PERMISSION_MESSAGE } from '../../src/tenancy/group-permission.guard';
import { INVITATION_MAIL_RATE_LIMIT } from '../../src/tenant-admin/users.controller';
import {
  INVITATION_ACCOUNT_SHARED_MESSAGE,
  INVITATION_ALREADY_SET_UP_MESSAGE,
  MEMBER_NOT_FOUND_MESSAGE,
} from '../../src/tenant-admin/users.service';
import { MutableClock } from '../mail/mail-test-context';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import {
  TEST_PUBLIC_BASE_URL,
  TEST_SYSTEM_SMTP_BLOCK,
  apiPath,
  configureSystemMail,
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
import { invitationToken, redeemInvitation } from '../support/invitations';
import { SmtpDouble } from '../support/smtp-double';

const PASSWORD = 'ein hinreichend langes passwort';
const MS_PER_DAY = 86_400_000;
const NEW_PASSWORD = 'das selbst gesetzte passwort';

/** The host the organisation enters — it must never be asked. */
const TENANT_SMTP_HOST = 'relay.angreifer.invalid';
/** The address the organisation enters — it must stand in no link. */
const TENANT_BASE_URL = 'https://formsache.angreifer.example';

/**
 * **An invitation instead of a typed password** (ADR-0024) — the whole path,
 * from „Person hinzufügen" to the first sign-in, and the boundaries beside it.
 *
 * ## What is measured here and what stands elsewhere
 *
 * `users.spec.ts` measures the permission and isolation matrix of the
 * creation; this file measures what is **new**: that an invitation comes into
 * being, how it leaves the installation, who may trigger it again and what
 * cannot be done with it. The setup is deliberately the same as in
 * `test/auth/password-reset-delivery.spec.ts` — the same organisation carries
 * a mail server of its own **and** a base address of its own, and neither may
 * appear at any point of this path.
 *
 * ## The attack the delivery cases stand against
 *
 * Somebody with `can_manage_settings` — without `can_manage_users`, no
 * superadmin — enters an SMTP host of their own for their organisation. If the
 * invitation went over it, their relay would get the fully rendered plaintext
 * link to **every** newly created account of this organisation, that is the
 * authority over accounts that are not theirs. With the password reset that was
 * a security finding (ADR-0020, ADR-0023); with the invitation the same path
 * weighs more heavily, because it concerns every new account and not only a
 * forgotten password.
 *
 * ## Negative probes, measured while writing
 *
 * - `trigger: 'system'` in `enqueueInvitation` changed to `'submit'` → the two
 *   delivery cases go red, and they do so on the **identity**: the mail goes
 *   over the organisation's host;
 * - `installationBaseUrl()` in `QueuedBodyRenderer.resetLinkFor` swapped for
 *   `resolveBaseUrl(tenantId)` → „baut den Link aus der
 *   Basis-Adresse der Installation" goes red and names the attacker's
 *   address;
 * - the check in `AccountInvitationService.plan` removed → „ohne Mailserver
 *   der Instanz entsteht kein Konto" goes red, **and** the row stands in the
 *   database afterwards (the case counts them);
 * - `kind` taken out of the `WHERE` of `resendInvitation` (that is the check
 *   „not set up yet" struck out) → „verweigert eine zweite Einladung
 *   an ein fertiges Konto" goes red;
 * - `usedAt: null` taken out of the `WHERE` of the redemption → „lässt sich
 *   genau einmal einlösen" goes red.
 */
describe('Einladung eines neu angelegten Kontos ', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  let transport: SmtpDouble;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let alphaAdmin: string;
  let betaAdmin: string;
  /** Every permission except `can_manage_users` — the „may not" half. */
  let restOnly: { id: string; email: string; groupId: string };
  let restOnlySession: string;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    transport = new SmtpDouble();
    testApp = await createTestApp({ databaseUrl: database.url, transport });

    await configureSystemMail(testApp, {
      publicBaseUrl: TEST_PUBLIC_BASE_URL,
      smtp: TEST_SYSTEM_SMTP_BLOCK,
    });

    alpha = await createTenant(testApp.prisma, 'INVA');
    beta = await createTenant(testApp.prisma, 'INVB');

    /*
     * **What the organisation is allowed to enter** — both over
     * `can_manage_settings`, written straight into the columns here, because
     * the routes for it have their own cases and this one measures the
     * *consequences*.
     */
    await testApp.prisma.tenant.update({
      where: { id: alpha.id },
      data: {
        publicBaseUrl: TENANT_BASE_URL,
        smtp: testApp.app.get(MailSecretsService).sealTenantBlock(
          {
            host: TENANT_SMTP_HOST,
            port: 587,
            secure: false,
            from: 'post@angreifer.invalid',
            auth: {
              user: 'angreifer',
              password: {
                kind: 'typed',
                value: `pw-${randomBytes(9).toString('hex')}`,
              },
            },
          },
          alpha.id,
        ),
      },
    });

    const alphaUser = await createUser(testApp.prisma, {
      email: 'inv-alpha-admin@example.org',
      password: PASSWORD,
      tenants: [alpha],
    });
    const betaUser = await createUser(testApp.prisma, {
      email: 'inv-beta-admin@example.org',
      password: PASSWORD,
      tenants: [beta],
    });
    alphaAdmin = await openSession(testApp, alphaUser.id, alpha.id);
    betaAdmin = await openSession(testApp, betaUser.id, beta.id);

    restOnly = await createRestrictedMember(testApp.prisma, alpha, {
      email: 'inv-rest-only@example.org',
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
  }, 180_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  /**
   * **The rate limit back to zero before every case** (security finding 2).
   *
   * Since `POST /tenant/users` and `POST /tenant/users/:id/invitation` each
   * allow ten calls a minute, this file without the reset is **one** caller
   * with dozens of attempts from the same loopback address — the case that
   * happens to run eleventh would go red, and the message would say nothing
   * about the matter. The case that **measures** the limit therefore pushes
   * past it within a single case.
   */
  beforeEach(() => {
    resetRateLimit(testApp);
  });

  async function addLocalMember(
    session: string,
    email: string,
  ): Promise<request.Response> {
    return request(app().server)
      .post(apiPath('/tenant/users'))
      .set(authedMutation(session))
      .send({
        kind: 'local',
        email,
        name: `Neu ${email}`,
        groupId: alpha.adminGroupId,
      });
  }

  function resendFor(session: string, userId: string) {
    return request(app().server)
      .post(apiPath(`/tenant/users/${userId}/invitation`))
      .set(authedMutation(session));
  }

  /**
   * The one delivered mail of a call — over the real worker.
   *
   * **Drain it first.** Every case of this file creates people, and each of
   * them enqueues an invitation; without draining beforehand the case measures
   * the queue of the whole suite instead of its own row.
   */
  async function deliverOne(
    trigger: () => Promise<void>,
  ): Promise<{ identityKey: string; host: string; to: string; text: string }> {
    await drainQueue();
    const before = transport.attempts.length;
    await trigger();
    await app().app.get(MailWorkerService).runOnce();

    const sent = transport.attempts.slice(before);
    const identities = transport.identities.slice(before);
    expect(sent).toHaveLength(1);
    return {
      identityKey: identities[0]?.key ?? '',
      host: identities[0]?.block.host ?? '',
      to: sent[0]?.to ?? '',
      text: sent[0]?.text ?? '',
    };
  }

  /** Sends out everything waiting — until nothing follows any more. */
  async function drainQueue(): Promise<void> {
    for (let round = 0; round < 10; round += 1) {
      const before = transport.attempts.length;
      await app().app.get(MailWorkerService).runOnce();
      if (transport.attempts.length === before) {
        return;
      }
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // What comes into being at the creation
  // ═════════════════════════════════════════════════════════════════════════

  describe('was „Person hinzufügen" schreibt', () => {
    it('legt ein Konto **ohne** Passwort an und reiht eine Einladung ein', async () => {
      const email = 'inv-frisch@example.org';
      const created = await addLocalMember(alphaAdmin, email);
      expect(created.status).toBe(201);

      const user = await app().prisma.user.findUniqueOrThrow({
        where: { email },
        select: { id: true, passwordHash: true, oidcIssuer: true },
      });
      // The whole change in one line: nobody typed a password here, and there
      // is none.
      expect(user.passwordHash).toBeNull();
      expect(user.oidcIssuer).toBeNull();

      const invitation = await app().prisma.passwordResetToken.findFirstOrThrow(
        { where: { userId: user.id } },
      );
      expect(invitation.kind).toBe('invitation');
      expect(invitation.usedAt).toBeNull();

      const mail = await app().prisma.mailLog.findUniqueOrThrow({
        where: { id: invitation.mailLogId ?? '' },
      });
      expect(mail.recipient).toBe(email);
      // **A system mail** — the security condition the transport and the base
      // address hang on (ADR-0023, ADR-0024 no. 3).
      expect(mail.trigger).toBe('system');
      expect(mail.tenantId).toBe(alpha.id);
      // **The stored body carries the mark, never the address**
      // (ADR-0020 §5): if the link stood here, the detail view of the mail log
      // would be a way to every freshly created account.
      expect(mail.bodyText).toContain(PASSWORD_RESET_LINK_MARK);
      expect(mail.bodyText).not.toContain(
        `${TEST_PUBLIC_BASE_URL}/${ACCOUNT_INVITATION_SEGMENT}/`,
      );
      // The **sign-in address** is indeed in it, and that is no
      // contradiction: it is the start page of the installation, no authority
      // — and it stands in every other mail of this application as well.
      expect(mail.bodyText).toContain(TEST_PUBLIC_BASE_URL);
    });

    it('reiht für ein SSO-Konto eine Mail **ohne** Token ein', async () => {
      await app().prisma.tenant.update({
        where: { id: beta.id },
        data: {
          oidcEnabled: true,
          oidcIssuer: 'https://idp.beta.example',
          oidcButtonLabel: 'Mit Vereinskonto anmelden',
        },
      });

      const email = 'inv-sso@example.org';
      const created = await request(app().server)
        .post(apiPath('/tenant/users'))
        .set(authedMutation(betaAdmin))
        .send({
          kind: 'oidc',
          email,
          name: 'SSO Person',
          groupId: beta.adminGroupId,
        });
      expect(created.status).toBe(201);

      const user = await app().prisma.user.findUniqueOrThrow({
        where: { email },
        select: { id: true },
      });
      // **No invitation row.** A provider account gets no password, so there
      // is nothing to set and no authority to send out.
      expect(
        await app().prisma.passwordResetToken.count({
          where: { userId: user.id },
        }),
      ).toBe(0);

      const mail = await app().prisma.mailLog.findFirstOrThrow({
        where: { recipient: email },
      });
      expect(mail.trigger).toBe('system');
      // The sign-in path stands in it **by name**, not as „SSO".
      expect(mail.bodyText).toContain('Mit Vereinskonto anmelden');
      expect(mail.bodyText).not.toContain(PASSWORD_RESET_LINK_MARK);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // How it leaves the installation
  // ═════════════════════════════════════════════════════════════════════════

  describe('die Leitung, nicht die Datenbank', () => {
    it('geht über die Systemidentität, obwohl die Organisation einen eigenen Mailserver hat', async () => {
      const delivered = await deliverOne(async () => {
        const created = await addLocalMember(
          alphaAdmin,
          'inv-weg1@example.org',
        );
        expect(created.status).toBe(201);
      });

      expect(delivered.identityKey).toBe(SYSTEM_IDENTITY_KEY);
      expect(delivered.host).toBe(TEST_SYSTEM_SMTP_BLOCK.host);
      expect(delivered.host).not.toBe(TENANT_SMTP_HOST);
    });

    it('baut den Link aus der Basis-Adresse der Installation, nie aus der der Organisation', async () => {
      const delivered = await deliverOne(async () => {
        const created = await addLocalMember(
          alphaAdmin,
          'inv-weg2@example.org',
        );
        expect(created.status).toBe(201);
      });

      expect(delivered.text).toContain(
        `${TEST_PUBLIC_BASE_URL}/${ACCOUNT_INVITATION_SEGMENT}/`,
      );
      expect(delivered.text).not.toContain(TENANT_BASE_URL);
      expect(delivered.text).not.toContain('angreifer');
      // And the address does **not** carry the segment of the password reset:
      // what the page says hangs on that alone (ADR-0024 no. 9).
      expect(delivered.text).not.toContain(`${TEST_PUBLIC_BASE_URL}/password/`);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // The redemption
  // ═════════════════════════════════════════════════════════════════════════

  describe('das Einlösen', () => {
    it('setzt das erste Passwort — und lässt sich genau einmal benutzen', async () => {
      const email = 'inv-einmal@example.org';
      expect((await addLocalMember(alphaAdmin, email)).status).toBe(201);

      const token = await invitationToken(app(), email);
      const first = await request(app().server)
        .post(apiPath('/auth/password-reset/confirm'))
        .send({ token, password: NEW_PASSWORD });
      expect(first.status).toBe(204);

      // Only now can the person sign in — before, nobody could.
      const login = await request(app().server)
        .post(apiPath('/auth/login'))
        .send({ email, password: NEW_PASSWORD });
      expect(login.status).toBe(200);

      // **The second use fails**, with the one refusal: `used_at` stands in
      // the same statement that sets it.
      const second = await request(app().server)
        .post(apiPath('/auth/password-reset/confirm'))
        .send({ token, password: 'noch ein anderes langes passwort' });
      expect(second.status).toBe(400);
      expect((second.body as { message: string }).message).toBe(
        PASSWORD_RESET_INVALID_MESSAGE,
      );
    });

    it('entwertet die vorherige Einladung, wenn eine neue verschickt wird', async () => {
      const email = 'inv-zweitlink@example.org';
      expect((await addLocalMember(alphaAdmin, email)).status).toBe(201);
      const first = await invitationToken(app(), email);

      const user = await app().prisma.user.findUniqueOrThrow({
        where: { email },
        select: { id: true },
      });
      expect((await resendFor(alphaAdmin, user.id)).status).toBe(204);
      const second = await invitationToken(app(), email);
      expect(second).not.toBe(first);

      // **The last one sent is the one that counts.** Three links in three
      // mailboxes would be three windows.
      const stale = await request(app().server)
        .post(apiPath('/auth/password-reset/confirm'))
        .send({ token: first, password: NEW_PASSWORD });
      expect(stale.status).toBe(400);

      const fresh = await request(app().server)
        .post(apiPath('/auth/password-reset/confirm'))
        .send({ token: second, password: NEW_PASSWORD });
      expect(fresh.status).toBe(204);
    });

    it('beendet dabei jede Sitzung des Kontos und entwertet alles Offene', async () => {
      const email = 'inv-sitzungen@example.org';
      expect((await addLocalMember(alphaAdmin, email)).status).toBe(201);
      const user = await app().prisma.user.findUniqueOrThrow({
        where: { email },
        select: { id: true },
      });

      /*
       * A session on an account that has not set its password yet is a state
       * no sign-in path produces — here it is made by hand, because the
       * promise is exactly the case that counts: **whoever notices a takeover
       * sets the password and expects the foreign session to end**
       * (ADR-0020 §3).
       */
      const session = await openSession(testApp, user.id, alpha.id);
      await redeemInvitation(app(), email, NEW_PASSWORD);

      const after = await request(app().server)
        .get(apiPath('/auth/me'))
        .set('Cookie', cookieHeader(session));
      expect(after.status).toBe(401);

      expect(
        await app().prisma.passwordResetToken.count({
          where: { userId: user.id, usedAt: null },
        }),
      ).toBe(0);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Sending again — the boundaries
  // ═════════════════════════════════════════════════════════════════════════

  describe('„Einladung erneut senden" — die Grenzen', () => {
    it('verweigert sie einer Rolle ohne `can_manage_users`', async () => {
      const email = 'inv-ohne-recht@example.org';
      expect((await addLocalMember(alphaAdmin, email)).status).toBe(201);
      const user = await app().prisma.user.findUniqueOrThrow({
        where: { email },
        select: { id: true },
      });

      const refused = await resendFor(restOnlySession, user.id);
      expect(refused.status).toBe(403);
      expect((refused.body as { message: string }).message).toBe(
        MISSING_PERMISSION_MESSAGE,
      );

      // And the allowed half of the same pair — without it the 403 would
      // prove nothing about *this* permission.
      expect((await resendFor(alphaAdmin, user.id)).status).toBe(204);
    });

    /**
     * **No invitation token for a foreign account** — the isolation probe.
     *
     * BETA does not see a member of ALPHA and gets the same 404 as for an id
     * that exists nowhere. What is decisive is the second half: **no**
     * invitation row and **no** mail comes into being. A route that wrote
     * first and refused afterwards would be a way of having an authority
     * issued over an account of a foreign organisation.
     */
    it('verweigert sie für ein Mitglied einer fremden Organisation — und schreibt nichts', async () => {
      const email = 'inv-fremd@example.org';
      expect((await addLocalMember(alphaAdmin, email)).status).toBe(201);
      const user = await app().prisma.user.findUniqueOrThrow({
        where: { email },
        select: { id: true },
      });
      const tokensBefore = await app().prisma.passwordResetToken.count({
        where: { userId: user.id },
      });
      const mailsBefore = await app().prisma.mailLog.count({
        where: { recipient: email },
      });

      const refused = await resendFor(betaAdmin, user.id);
      expect(refused.status).toBe(404);
      expect((refused.body as { message: string }).message).toBe(
        MEMBER_NOT_FOUND_MESSAGE,
      );

      expect(
        await app().prisma.passwordResetToken.count({
          where: { userId: user.id },
        }),
      ).toBe(tokensBefore);
      expect(
        await app().prisma.mailLog.count({ where: { recipient: email } }),
      ).toBe(mailsBefore);
    });

    it('verweigert eine zweite Einladung an ein Konto, das schon eingerichtet ist', async () => {
      const email = 'inv-fertig@example.org';
      expect((await addLocalMember(alphaAdmin, email)).status).toBe(201);
      await redeemInvitation(app(), email, NEW_PASSWORD);

      const user = await app().prisma.user.findUniqueOrThrow({
        where: { email },
        select: { id: true },
      });
      const mailsBefore = await app().prisma.mailLog.count({
        where: { recipient: email },
      });

      const refused = await resendFor(alphaAdmin, user.id);
      expect(refused.status).toBe(422);
      expect((refused.body as { message: string }).message).toBe(
        INVITATION_ALREADY_SET_UP_MESSAGE,
      );
      // **Nothing enqueued.** Otherwise „Einladung erneut senden" would be
      // the way of having a fresh sign-in link sent to a working account.
      expect(
        await app().prisma.mailLog.count({ where: { recipient: email } }),
      ).toBe(mailsBefore);
    });

    it('verweigert sie für ein Konto der Systemverwaltung', async () => {
      const root = await createUser(app().prisma, {
        email: 'inv-superadmin@example.org',
        password: PASSWORD,
        tenants: [alpha],
        isSuperadmin: true,
      });

      const refused = await resendFor(alphaAdmin, root.id);
      expect(refused.status).toBe(409);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // The emergency path of the administration
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * **An invitation that never arrives is not a lost account** (ADR-0024
   * no. 1).
   *
   * `ScopedMembershipDelegate.setPassword` demanded `password_hash IS NOT
   * NULL` — a condition that before the invitation did the same as „only
   * local accounts" and afterwards excluded too much: of all people the one
   * whose invitation lies in the spam folder would be reachable by nobody any
   * more.
   *
   * *Counter-check:* the condition back to `passwordHash: { not: null }` →
   * this case goes red, with the 404 that means „does not exist".
   */
  describe('der Notfallweg der Verwaltung', () => {
    it('setzt einer Person, deren Einladung nicht ankam, ein Passwort — und entwertet dabei den Link', async () => {
      const email = 'inv-notfall@example.org';
      expect((await addLocalMember(alphaAdmin, email)).status).toBe(201);
      const user = await app().prisma.user.findUniqueOrThrow({
        where: { email },
        select: { id: true },
      });
      const token = await invitationToken(app(), email);

      const set = await request(app().server)
        .post(apiPath(`/tenant/users/${user.id}/password`))
        .set(authedMutation(alphaAdmin))
        .send({ password: NEW_PASSWORD });
      expect(set.status).toBe(201);

      const login = await request(app().server)
        .post(apiPath('/auth/login'))
        .send({ email, password: NEW_PASSWORD });
      expect(login.status).toBe(200);

      // **And the old invitation link is dead.** A link that survives a
      // password change would be the second key it is meant to remove — the
      // same single statement for both kinds (ADR-0024 no. 5).
      const stale = await request(app().server)
        .post(apiPath('/auth/password-reset/confirm'))
        .send({ token, password: 'wieder ein anderes langes passwort' });
      expect(stale.status).toBe(400);
      expect((stale.body as { message: string }).message).toBe(
        PASSWORD_RESET_INVALID_MESSAGE,
      );
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // An expired invitation — security finding 3
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * **Eight days later the link is worth nothing any more** — and the account
   * still has no password.
   *
   * An application of its own with a clock of its own, like the block „ohne
   * Mailserver der Instanz" beside it: `MutableClock` is the clock of the
   * **queue**, and the suite above is not to depend on where it currently
   * stands.
   *
   * ## Why the clock is set back and then wound forward
   *
   * Because the redemption reads the **wall clock** (`const now = new Date()`
   * in `PasswordResetService.confirm`) and not the clock of the queue — and
   * that is right: a deadline that hung on a settable clock would be a lever.
   * So the invitation comes into being eight days in the past, its deadline is
   * thereby a day gone, and winding forward brings the queue back to „now".
   *
   * *Counter-check:* take `expiresAt: { gt: now }` out of the `WHERE` of the
   * redemption → this case goes red, and it does so on both lines: the answer
   * is 204, and the account carries a hash afterwards.
   */
  describe('eine abgelaufene Einladung', () => {
    let aged: TestApp;
    let agedDatabase: TestDatabase | undefined;
    let clock: MutableClock;
    let delta: TenantFixture;
    let deltaAdmin: string;

    beforeAll(async () => {
      agedDatabase = await acquireTestDatabase();
      clock = new MutableClock(
        new Date(Date.now() - (ACCOUNT_INVITATION_TTL_DAYS + 1) * MS_PER_DAY),
      );
      aged = await createTestApp({ databaseUrl: agedDatabase.url, clock });
      await configureSystemMail(aged, {
        publicBaseUrl: TEST_PUBLIC_BASE_URL,
        smtp: TEST_SYSTEM_SMTP_BLOCK,
      });

      delta = await createTenant(aged.prisma, 'INVE');
      const user = await createUser(aged.prisma, {
        email: 'inv-delta-admin@example.org',
        password: PASSWORD,
        tenants: [delta],
      });
      deltaAdmin = await openSession(aged, user.id, delta.id);
    }, 180_000);

    afterAll(async () => {
      await aged.close();
      await agedDatabase?.release();
    }, 120_000);

    it('lässt sich nach acht Tagen nicht mehr einlösen — und das Konto bleibt ohne Passwort', async () => {
      const email = 'inv-abgelaufen@example.org';
      const created = await request(aged.server)
        .post(apiPath('/tenant/users'))
        .set(authedMutation(deltaAdmin))
        .send({
          kind: 'local',
          email,
          name: 'Zu spät',
          groupId: delta.adminGroupId,
        });
      expect(created.status).toBe(201);

      const token = await invitationToken(aged, email);
      // Wind eight days forward: the clock thereby stands at „now" again, and
      // the deadline of the invitation has been over for a day.
      clock.advance((ACCOUNT_INVITATION_TTL_DAYS + 1) * MS_PER_DAY);

      const refused = await request(aged.server)
        .post(apiPath('/auth/password-reset/confirm'))
        .send({ token, password: NEW_PASSWORD });

      expect(refused.status).toBe(400);
      // The same single refusal as for an unknown, a used or a foreign token
      // — whoever presents an expired value is not told that it was almost
      // valid.
      expect((refused.body as { message: string }).message).toBe(
        PASSWORD_RESET_INVALID_MESSAGE,
      );

      const user = await aged.prisma.user.findUniqueOrThrow({
        where: { email },
        select: { passwordHash: true },
      });
      // **The half that counts**: a 400 beside a password that was set would
      // be the worse variant of the two.
      expect(user.passwordHash).toBeNull();

      // And the sign-in stays shut.
      const login = await request(aged.server)
        .post(apiPath('/auth/login'))
        .send({ email, password: NEW_PASSWORD });
      expect(login.status).toBe(401);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // A foreign value in the body — ADR-0026
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * **Whoever writes the name writes nothing else on this mail.**
   *
   * The attack: a holder of `can_manage_users` creates a person whose `name`
   * carries line breaks, and picks the recipient address along with it. The
   * invitation goes out over the mail server of the **installation**, so
   * SPF/DKIM-signed under its domain — and its text version would carry the
   * smuggled-in lines, while the HTML version was covered by `escapeHtml` and
   * `renderAnswerTable`.
   *
   * Two bolts, two cases:
   *
   * 1. `userNameSchema` demands `isSingleLineText` — the value does not reach
   *    the column at all;
   * 2. `collapseWhitespace` in `account-invitation-mail.ts` folds what does
   *    stand in it after all (a row from the time before the rule, from a
   *    restore, from a later write path). The second case produces exactly
   *    that by writing the column **past the route** — the same construction
   *    with which `branding.ts` checks its second gate.
   *
   * *Counter-checks:* take `isSingleLineText` out of `userNameSchema` → case 1
   * goes red; take `collapseWhitespace` out of `invitationLead` → case 2 goes
   * red, and the body carries two lines more than the harmless invitation
   * beside it.
   */
  describe('ein Fremdwert im Rumpf einer Systemmail', () => {
    const ATTACK_LINE =
      'Dein Zugang läuft ab. Jetzt bestätigen: https://boese.example';
    const ATTACK_NAME = `Max\n\n${ATTACK_LINE}\n\n—`;

    it('weist den Namen schon an der Route ab — und legt kein Konto an', async () => {
      const email = 'inv-einzeilig-route@example.org';
      const refused = await request(app().server)
        .post(apiPath('/tenant/users'))
        .set(authedMutation(alphaAdmin))
        .send({
          kind: 'local',
          email,
          name: ATTACK_NAME,
          groupId: alpha.adminGroupId,
        });

      expect(refused.status).toBe(400);
      // The half that counts: no row, no account, no mail.
      expect(await app().prisma.user.count({ where: { email } })).toBe(0);
      expect(
        await app().prisma.mailLog.count({ where: { recipient: email } }),
      ).toBe(0);
    });

    it('macht aus einem gespeicherten Namen mit Umbruch keine zweite Zeile in `mail_log.body_text`', async () => {
      const email = 'inv-einzeilig-spalte@example.org';
      expect((await addLocalMember(alphaAdmin, email)).status).toBe(201);
      const user = await app().prisma.user.findUniqueOrThrow({
        where: { email },
        select: { id: true },
      });
      // The harmless invitation of the same account — the yardstick the
      // second one is measured against.
      const harmless = await app().prisma.mailLog.findFirstOrThrow({
        where: { recipient: email },
      });

      /*
       * **Past the route into the column**, because that is exactly the case
       * the second bolt covers: a row that was written before this rule or
       * comes out of a backup. Over the route it would not work any more since
       * case 1.
       */
      await app().prisma.user.update({
        where: { id: user.id },
        data: { name: ATTACK_NAME },
      });

      expect((await resendFor(alphaAdmin, user.id)).status).toBe(204);

      const poisoned = await app().prisma.mailLog.findFirstOrThrow({
        where: { recipient: email, id: { not: harmless.id } },
      });
      const lines = (poisoned.bodyText ?? '').split('\n');

      // **Not one single line more than the harmless invitation.**
      expect(lines).toHaveLength((harmless.bodyText ?? '').split('\n').length);
      // And no line that on its own looks like a sentence of the application.
      for (const line of lines) {
        expect(line.trim()).not.toBe(ATTACK_LINE);
      }
      // The text is not gone — it stands folded in the salutation, where it
      // belongs: as a name.
      expect(poisoned.bodyText).toContain(`Hallo Max ${ATTACK_LINE} —,`);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // The rate limit of the account mails — security finding 2
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * **Two routes that send a real mail out, and both of them limited.**
   *
   * Without the number, a holder of `can_manage_users` can let the mailbox of
   * a pending member fill up — over the mail server of the **installation**,
   * whose sender domain carries the damage. The number is the same as with
   * „Testmail senden" ({@link INVITATION_MAIL_RATE_LIMIT}), because it is the
   * same action.
   *
   * *Counter-check:* remove `@UseGuards(ThrottlerGuard)` from either of the
   * two routes → the respective case goes red. `@Throttle` alone is not
   * enough, and that is exactly how it stood there before: not at all.
   */
  describe('die Begrenzung der Kontomails', () => {
    it('weist den elften Versand innerhalb der Minute ab', async () => {
      const email = 'inv-grenze-erneut@example.org';
      expect((await addLocalMember(alphaAdmin, email)).status).toBe(201);
      const user = await app().prisma.user.findUniqueOrThrow({
        where: { email },
        select: { id: true },
      });
      const mailsBefore = await app().prisma.mailLog.count({
        where: { recipient: email },
      });

      const statuses: number[] = [];
      for (
        let press = 0;
        press <= INVITATION_MAIL_RATE_LIMIT.limit;
        press += 1
      ) {
        // One after another and not `Promise.all`: what is measured is a
        // **count** over a window, and nobody would count parallel requests in
        // an order this case determines.
        statuses.push((await resendFor(alphaAdmin, user.id)).status);
      }

      expect(statuses.at(-1)).toBe(429);
      expect(
        statuses.filter((status) => status !== 429).length,
      ).toBeLessThanOrEqual(INVITATION_MAIL_RATE_LIMIT.limit);
      // A refused request costs nothing: no row, no mail.
      expect(
        await app().prisma.mailLog.count({ where: { recipient: email } }),
      ).toBeLessThanOrEqual(mailsBefore + INVITATION_MAIL_RATE_LIMIT.limit);
    });

    it('begrenzt auch das Anlegen, das seit ADR-0024 eine Mail verschickt', async () => {
      const statuses: number[] = [];
      for (
        let press = 0;
        press <= INVITATION_MAIL_RATE_LIMIT.limit;
        press += 1
      ) {
        statuses.push(
          (
            await addLocalMember(
              alphaAdmin,
              `inv-grenze-${String(press)}@example.org`,
            )
          ).status,
        );
      }

      expect(statuses.at(-1)).toBe(429);
      // The refused request created no account either.
      expect(
        await app().prisma.user.count({
          where: {
            email: `inv-grenze-${String(INVITATION_MAIL_RATE_LIMIT.limit)}@example.org`,
          },
        }),
      ).toBe(0);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // The deadline — security finding 3
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * **Seven days, and not the minutes of the password reset.**
   *
   * `ACCOUNT_INVITATION_TTL_DAYS` appeared in no case up to here. Both
   * deadlines stand on the same column of the same table
   * (`password_reset.expires_at`), and the one line that tells them apart is
   * the calculation in `AccountInvitationService.plan`:
   * `PASSWORD_RESET_TTL_MINUTES` written in there would be an invitation that
   * is dead after an hour — and **no** test would have seen it.
   *
   * Measured against `mail_log.created_at` and not against
   * `password_reset.created_at`: the log row carries the timestamp of the same
   * clock the deadline is calculated from (`invitation.stampedAt`), while the
   * column beside it gets its default value from the database. Two calendars
   * in one calculation would give a deviation of milliseconds and a case that
   * is sometimes red.
   */
  describe('die Frist der Einladung', () => {
    it('läuft sieben Tage nach dem Einreihen ab', async () => {
      const email = 'inv-frist@example.org';
      expect((await addLocalMember(alphaAdmin, email)).status).toBe(201);
      const user = await app().prisma.user.findUniqueOrThrow({
        where: { email },
        select: { id: true },
      });

      const invitation = await app().prisma.passwordResetToken.findFirstOrThrow(
        { where: { userId: user.id, kind: 'invitation' } },
      );
      const mail = await app().prisma.mailLog.findUniqueOrThrow({
        where: { id: invitation.mailLogId ?? '' },
      });

      const ttl = invitation.expiresAt.getTime() - mail.createdAt.getTime();
      expect(ttl).toBe(ACCOUNT_INVITATION_TTL_DAYS * MS_PER_DAY);
      // Explicitly **not** the deadline of the password reset: that both
      // kinds use the same column is the reason this line stands here.
      expect(ttl).not.toBe(PASSWORD_RESET_TTL_MINUTES * 60_000);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // An account two organisations share — security finding 4
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * **An open invitation does not belong to the organisation that joined
   * last.**
   *
   * The path: ALPHA creates a person whose invitation is still open; BETA
   * attaches the same address (`attachExisting` — allowed, that is the
   * documented way of working in two organisations) and presses „Einladung
   * erneut senden". Without the condition, `invalidateOpenTokens` thereby
   * invalidates the link ALPHA sent out, and the new mail says „von der
   * Organisation BETA".
   *
   * No takeover of an authority — the mail goes to the person's mailbox —, but
   * an effect across the organisation boundary that `requireOwnAccount`
   * explicitly rules out for the two neighbouring actions (address, password).
   * What was decided: **draw the same condition**, and symmetrically at that —
   * ALPHA sends none afterwards either. What remains for the person is
   * „Passwort vergessen", which since ADR-0024 explicitly applies to an
   * account without a password as well.
   */
  describe('ein Konto, das zwei Organisationen teilen', () => {
    it('verweigert das erneute Verschicken beiden — und lässt den offenen Link stehen', async () => {
      const email = 'inv-geteilt@example.org';
      expect((await addLocalMember(alphaAdmin, email)).status).toBe(201);
      const token = await invitationToken(app(), email);
      const user = await app().prisma.user.findUniqueOrThrow({
        where: { email },
        select: { id: true },
      });

      // BETA brings the same person in — allowed, and the occasion of the
      // finding.
      const attached = await request(app().server)
        .post(apiPath('/tenant/users'))
        .set(authedMutation(betaAdmin))
        .send({
          kind: 'local',
          email,
          name: 'Geteilte Person',
          groupId: beta.adminGroupId,
        });
      expect(attached.status).toBe(201);
      const mailsBefore = await app().prisma.mailLog.count({
        where: { recipient: email },
      });

      const refusedByBeta = await resendFor(betaAdmin, user.id);
      expect(refusedByBeta.status).toBe(409);
      expect((refusedByBeta.body as { message: string }).message).toBe(
        INVITATION_ACCOUNT_SHARED_MESSAGE,
      );

      // **Symmetrical**: the refusal is a statement about the account, not
      // about the asking organisation.
      expect((await resendFor(alphaAdmin, user.id)).status).toBe(409);

      // Nothing enqueued — and the link ALPHA sent out is alive.
      expect(
        await app().prisma.mailLog.count({ where: { recipient: email } }),
      ).toBe(mailsBefore);
      expect(await invitationToken(app(), email)).toBe(token);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Without a mail server of the instance
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * **Without a mail server of the instance nobody can be invited** (ADR-0024
   * no. 7) — and that must not fail silently.
   *
   * An application of its own, because the state is a property of the
   * installation: the suite above sets both up, and a `configureSystemMail`
   * in the middle of it would make every following case depend on the order.
   */
  describe('ohne Mailserver der Instanz', () => {
    let bare: TestApp;
    let bareDatabase: TestDatabase | undefined;
    let gamma: TenantFixture;
    let gammaAdmin: string;

    beforeAll(async () => {
      bareDatabase = await acquireTestDatabase();
      bare = await createTestApp({ databaseUrl: bareDatabase.url });
      gamma = await createTenant(bare.prisma, 'INVC');
      const user = await createUser(bare.prisma, {
        email: 'inv-gamma-admin@example.org',
        password: PASSWORD,
        tenants: [gamma],
      });
      gammaAdmin = await openSession(bare, user.id, gamma.id);
    }, 180_000);

    afterAll(async () => {
      await bare.close();
      await bareDatabase?.release();
    }, 120_000);

    function addTo(email: string) {
      return request(bare.server)
        .post(apiPath('/tenant/users'))
        .set(authedMutation(gammaAdmin))
        .send({
          kind: 'local',
          email,
          name: 'Ohne Post',
          groupId: gamma.adminGroupId,
        });
    }

    it('sagt es vorher — und legt kein Konto an', async () => {
      const email = 'inv-ohne-mailserver@example.org';
      const refused = await addTo(email);

      expect(refused.status).toBe(422);
      expect((refused.body as { message: string }).message).toBe(
        INVITATION_NO_MAIL_SERVER_MESSAGE,
      );
      /*
       * **The half that counts.** An account that exists and whose invitation
       * never went out would be the worst of all variants: the person knows
       * nothing of it, the administration does not either, and the address is
       * taken installation-wide.
       */
      expect(await bare.prisma.user.count({ where: { email } })).toBe(0);
    });

    it('sagt es auch, wenn nur die Basis-Adresse fehlt — mit dem eigenen Satz', async () => {
      await configureSystemMail(bare, { smtp: TEST_SYSTEM_SMTP_BLOCK });

      const email = 'inv-ohne-adresse@example.org';
      const refused = await addTo(email);

      expect(refused.status).toBe(422);
      // Two causes, two sentences: „trag einen Mailserver ein" would help
      // nobody here — it is entered.
      expect((refused.body as { message: string }).message).toBe(
        INVITATION_NO_BASE_URL_MESSAGE,
      );
      expect(await bare.prisma.user.count({ where: { email } })).toBe(0);
    });

    it('legt an, sobald beides eingetragen ist — derselbe Aufruf, ohne Neustart', async () => {
      await configureSystemMail(bare, {
        publicBaseUrl: TEST_PUBLIC_BASE_URL,
        smtp: TEST_SYSTEM_SMTP_BLOCK,
      });

      const email = 'inv-nachgetragen@example.org';
      expect((await addTo(email)).status).toBe(201);
      expect(await bare.prisma.user.count({ where: { email } })).toBe(1);
    });
  });
});
