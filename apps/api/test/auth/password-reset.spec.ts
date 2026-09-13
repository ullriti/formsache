import {
  PASSWORD_RESET_LINK_MARK,
  PASSWORD_RESET_SEGMENT,
} from '@formsache/shared';
import type { NotificationTrigger } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { verifyPassword } from '../../src/auth/password';
import { MailBodyRenderer } from '../../src/mail/mail-body-renderer';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import {
  TEST_PUBLIC_BASE_URL,
  apiPath,
  configureSystemMail,
  createTestApp,
  type TestApp,
} from '../support/create-test-app';
import {
  createTenant,
  createUser,
  type TenantFixture,
} from '../support/fixtures';
import { authedMutation, cookieHeader, openSession } from '../support/http';

const PASSWORD = 'ein hinreichend langes passwort';

/** The provider under which the open SSO invitations of this file stand. */
const ISSUER = 'https://idp.reset.example';

/**
 * **„Passwort vergessen" — measured from the forbidden side** (ADR-0020).
 *
 * This is the only route of this application that opens an account to someone
 * **not logged in**. A case that only shows that the correct link works
 * proves nothing of that; the cases below are therefore mostly ones that
 * **must** fail:
 *
 * | What is tried | What has to hold |
 * |---|---|
 * | someone else's token | changes only its own account, never a second one |
 * | expired token | refusal, password unchanged |
 * | redeemed twice | the second attempt fails |
 * | token of another organisation | works only there — the route knows no organisation at all |
 * | SSO account | neither token nor mail, and the answer does not give it away |
 * | address that does not exist | answer **byte for byte** the same as that of one that does |
 *
 * Plus the two promises that no status code shows: that the token is **not in
 * the stored body** of the mail — otherwise the mail log would be a path
 * to every local account — and that redeeming ends **all sessions**.
 *
 * ## Two things this setup deliberately does not do
 *
 * It **does not log in** in order to check a password: the login route is
 * limited to ten attempts per minute, and a file with two dozen
 * logins measures that limit instead of the reset. What is checked instead is
 * against the **stored hash**, with the application's own function
 * ({@link passwordOf}) — that is the same statement („this word opens this
 * account"), only without the detour.
 *
 * And it uses **a person of its own per case**: one address may trigger three
 * reset mails per hour (`password-reset-rate-limit.ts`), and a
 * case that silently fails at that limit would be a case that measures the
 * limit and not the rule.
 */
describe('Passwort vergessen', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  let alpha: TenantFixture;
  let beta: TenantFixture;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });
    // Without a base address no link could be formed — the dispatch would
    // then stay put with a readable reason, which would be a different
    // statement than the ones checked here.
    await configureSystemMail(testApp, {
      publicBaseUrl: TEST_PUBLIC_BASE_URL,
    });

    alpha = await createTenant(testApp.prisma, 'PWRA');
    beta = await createTenant(testApp.prisma, 'PWRB');
  }, 180_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  /** A fresh local person — see the class comment on the „per case". */
  async function freshLocal(
    slug: string,
    tenant: TenantFixture = alpha,
  ): Promise<{ id: string; email: string }> {
    return createUser(app().prisma, {
      email: `reset-${slug}@example.org`,
      password: PASSWORD,
      tenants: [tenant],
    });
  }

  function requestReset(email: string): request.Test {
    return request(app().server)
      .post(apiPath('/auth/password-reset/request'))
      .set('Content-Type', 'application/json')
      .send({ email });
  }

  function confirmReset(token: string, password: string): request.Test {
    return request(app().server)
      .post(apiPath('/auth/password-reset/confirm'))
      .set('Content-Type', 'application/json')
      .send({ token, password });
  }

  /** Does this word open this account? — against the stored hash. */
  async function passwordOf(
    userId: string,
    candidate: string,
  ): Promise<boolean> {
    const user = await app().prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { passwordHash: true },
    });
    return user.passwordHash !== null
      ? verifyPassword(user.passwordHash, candidate)
      : false;
  }

  /** The log row of the reset mail queued last for this person. */
  async function latestResetMail(userId: string): Promise<{
    id: string;
    tenantId: string;
    bodyText: string | null;
    trigger: NotificationTrigger;
  }> {
    const row = await app().prisma.passwordResetToken.findFirstOrThrow({
      where: { userId, usedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { mailLogId: true },
    });
    return app().prisma.mailLog.findUniqueOrThrow({
      where: { id: row.mailLogId ?? '' },
      select: { id: true, tenantId: true, bodyText: true, trigger: true },
    });
  }

  /**
   * The token the way the person reads it from their mail: **from the rendered
   * mail**, never from a column.
   *
   * That is the point of the whole construction. The database knows only the
   * hash, the frozen body only a mark; the address comes into being in the
   * dispatch step (`QueuedBodyRenderer`). A test that read the token out of
   * the table would describe a different application.
   */
  async function tokenFromMail(userId: string): Promise<string> {
    const mail = await latestResetMail(userId);
    const rendered = await app().app.get(MailBodyRenderer).render({
      id: mail.id,
      trigger: mail.trigger,
      tenantId: mail.tenantId,
      responseId: null,
      bodyText: mail.bodyText,
      bodyHtml: null,
    });
    const match = new RegExp(
      `${TEST_PUBLIC_BASE_URL}/${PASSWORD_RESET_SEGMENT}/([A-Za-z0-9_-]+)`,
      'u',
    ).exec(rendered.text);
    const token = match?.[1];
    expect(token, 'kein Rücksetz-Link in der gerenderten Mail').toBeDefined();
    return token ?? '';
  }

  describe('das Anfordern verrät nicht, ob es das Konto gibt', () => {
    it('antwortet für eine unbekannte Adresse genau wie für eine bekannte', async () => {
      const person = await freshLocal('enumeration');

      const known = await requestReset(person.email);
      const unknown = await requestReset('gibt-es-hier-nicht@example.org');

      // Byte for byte the same answer: status, body, text. There is no field
      // in which a difference *could* stand — and that is exactly what this
      // case checks.
      expect(known.status).toBe(204);
      expect(unknown.status).toBe(known.status);
      expect(unknown.body).toEqual(known.body);
      expect(unknown.text).toEqual(known.text);
    });

    it('legt für ein SSO-Konto weder Token noch Mail an — und sagt es nicht', async () => {
      const ssoAccount = await createUser(app().prisma, {
        email: 'reset-sso@example.org',
        tenants: [alpha],
      });
      const mailsBefore = await app().prisma.mailLog.count();

      const response = await requestReset(ssoAccount.email);

      expect(response.status).toBe(204);
      expect(response.text).toBe('');
      expect(
        await app().prisma.passwordResetToken.count({
          where: { userId: ssoAccount.id },
        }),
      ).toBe(0);
      // No mail either: otherwise the mailbox would learn that there is an
      // account here — and the provider, not this application, is responsible.
      expect(await app().prisma.mailLog.count()).toBe(mailsBefore);
    });

    it('braucht für eine unbekannte Adresse ähnlich lange wie für eine bekannte', async () => {
      // **The timing channel.** The answer is the same, the work behind it is
      // not: the hit writes two rows, the miss none. The floor of
      // `PASSWORD_RESET_FLOOR_MS` covers the difference.
      //
      // Measured generously, because a test machine is no stopwatch: what
      // this case rules out is the **order of magnitude** — a branch that
      // answers immediately, next to one that answers only after the database
      // work.
      const person = await freshLocal('timing');
      const hit = await timed(() => requestReset(person.email));
      const miss = await timed(() => requestReset('auch-nicht-da@example.org'));

      expect(miss).toBeGreaterThan(200);
      expect(Math.abs(hit - miss)).toBeLessThan(300);
    });
  });

  /**
   * **What „local" has meant since ADR-0024 — and what it still rules out.**
   *
   * The condition of `tryIssue` used to read `password_hash IS NOT NULL AND
   * oidc_subject IS NULL` and now reads `oidc_issuer IS NULL AND
   * oidc_subject IS NULL`. The three cases here are the three sides of that —
   * one that **is added** (and is meant to be), one that must **not** be
   * added, and the question whether the two can be told apart from
   * outside.
   *
   * *Counter-check:* take `oidcIssuer: null` out of the condition → the second
   * case goes red, namely at the line that counts an invitation row: an
   * open SSO invitation would get a reset link, that is, the second, quiet
   * way into an account that a provider claims (ADR-0012).
   */
  describe('„nur lokale Konten" nach der Einladung (ADR-0024)', () => {
    /** An open SSO invitation: issuer, no subject, no password. */
    async function oidcInvitation(
      slug: string,
    ): Promise<{ id: string; email: string }> {
      const email = `reset-${slug}@example.org`;
      const user = await app().prisma.user.create({
        data: { email, name: 'Eingeladen per SSO', oidcIssuer: ISSUER },
        select: { id: true, email: true },
      });
      await app().prisma.membership.create({
        data: {
          tenantId: alpha.id,
          userId: user.id,
          groupId: alpha.adminGroupId,
        },
      });
      return user;
    }

    /** A local account whose invitation is still open: nothing set. */
    async function invitedLocal(
      slug: string,
    ): Promise<{ id: string; email: string }> {
      const email = `reset-${slug}@example.org`;
      const user = await app().prisma.user.create({
        data: { email, name: 'Frisch eingeladen' },
        select: { id: true, email: true },
      });
      await app().prisma.membership.create({
        data: {
          tenantId: alpha.id,
          userId: user.id,
          groupId: alpha.adminGroupId,
        },
      });
      return user;
    }

    it('hilft einem Konto, dessen Einladung abgelaufen ist, zu seinem **ersten** Passwort', async () => {
      const person = await invitedLocal('eingeladen-lokal');

      expect((await requestReset(person.email)).status).toBe(204);

      const token = await tokenFromMail(person.id);
      expect(
        (await confirmReset(token, 'mein erstes langes passwort')).status,
      ).toBe(204);
      expect(await passwordOf(person.id, 'mein erstes langes passwort')).toBe(
        true,
      );
    });

    it('gibt einer offenen SSO-Einladung weiterhin nichts — und sagt es nicht', async () => {
      const person = await oidcInvitation('eingeladen-sso');
      const mailsBefore = await app().prisma.mailLog.count();

      const response = await requestReset(person.email);

      expect(response.status).toBe(204);
      expect(response.text).toBe('');
      // **The actual statement.** A reset link here would be the second,
      // quiet way into an account that a provider decides about — exactly
      // what ADR-0012 rules out.
      expect(
        await app().prisma.passwordResetToken.count({
          where: { userId: person.id },
        }),
      ).toBe(0);
      expect(await app().prisma.mailLog.count()).toBe(mailsBefore);
    });

    it('antwortet für ein Konto ohne Passwort genau wie für eine unbekannte Adresse', async () => {
      const person = await invitedLocal('eingeladen-stumm');

      const known = await requestReset(person.email);
      const unknown = await requestReset('auch-den-nicht@example.org');

      // The same comparison as above, for the state that did not exist
      // before: a local account **without** a password is now a hit, and that
      // it is one must not be visible from outside.
      expect(known.status).toBe(204);
      expect(unknown.status).toBe(known.status);
      expect(unknown.body).toEqual(known.body);
      expect(unknown.text).toEqual(known.text);

      const hit = await timed(() => requestReset('reset-timing-a@example.org'));
      const miss = await timed(() =>
        requestReset('reset-timing-b@example.org'),
      );
      expect(miss).toBeGreaterThan(200);
      expect(Math.abs(hit - miss)).toBeLessThan(300);
    });
  });

  describe('das Token steht in keiner lesbaren Spalte', () => {
    it('friert nur die Marke ein, baut die Adresse beim Versand und zeigt dem Protokoll ein Etikett', async () => {
      const person = await freshLocal('frozen');
      await requestReset(person.email);

      const stored = await app().prisma.passwordResetToken.findFirstOrThrow({
        where: { userId: person.id, usedAt: null },
      });
      const mail = await latestResetMail(person.id);

      // **The actual finding of this construction.** Were the address to
      // stand here, the detail view of the mail log would show it — behind
      // `can_manage_settings` instead of `can_manage_users`, and without
      // stopping short of the system administration.
      expect(mail.bodyText).toContain(PASSWORD_RESET_LINK_MARK);
      expect(mail.bodyText).not.toContain(TEST_PUBLIC_BASE_URL);

      const token = await tokenFromMail(person.id);
      expect(token.length).toBeGreaterThan(20);
      // The reset row does not know the token either — only its hash.
      expect(JSON.stringify(stored)).not.toContain(token);

      const redacted = await app().app.get(MailBodyRenderer).render(
        {
          id: mail.id,
          trigger: mail.trigger,
          tenantId: mail.tenantId,
          responseId: null,
          bodyText: mail.bodyText,
          bodyHtml: null,
        },
        'redacted',
      );
      expect(redacted.text).toContain('[Passwort-Link]');
      expect(redacted.text).not.toContain(token);
    });
  });

  describe('das Einlösen', () => {
    it('setzt das Passwort, beendet alle Sitzungen und gilt genau einmal', async () => {
      const person = await freshLocal('redeem');
      // Two running sessions, so that „all ended" hits more than one.
      const deviceA = await openSession(testApp, person.id, alpha.id);
      const deviceB = await openSession(testApp, person.id, alpha.id);

      await requestReset(person.email);
      const token = await tokenFromMail(person.id);

      const redeemed = await confirmReset(token, 'das neue lange passwort');
      expect(redeemed.status).toBe(204);

      expect(await passwordOf(person.id, 'das neue lange passwort')).toBe(true);
      expect(await passwordOf(person.id, PASSWORD)).toBe(false);

      // Both sessions are dead — otherwise the withdrawal of a leaked
      // password would be none: a session token knows no password.
      for (const device of [deviceA, deviceB]) {
        const alive = await request(app().server)
          .get(apiPath('/auth/me'))
          .set('Cookie', cookieHeader(device));
        expect(alive.status).toBe(401);
      }

      // **A second time does not work.**
      const again = await confirmReset(token, 'noch ein langes passwort');
      expect(again.status).toBe(400);
      expect(await passwordOf(person.id, 'noch ein langes passwort')).toBe(
        false,
      );
      expect(await passwordOf(person.id, 'das neue lange passwort')).toBe(true);
    });

    it('weist ein abgelaufenes Token ab, und zwar wie ein erfundenes', async () => {
      const person = await freshLocal('expired');
      await requestReset(person.email);
      const token = await tokenFromMail(person.id);

      // Not the clock set, but the expiry backdated: the process
      // is not to be lied to, and what is checked is the condition
      // `expires_at > now` in the `WHERE` of the redemption.
      await app().prisma.passwordResetToken.updateMany({
        where: { userId: person.id, usedAt: null },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const expired = await confirmReset(token, 'ein neues langes passwort');
      const invented = await confirmReset(
        'A'.repeat(43),
        'ein neues langes passwort',
      );

      expect(expired.status).toBe(400);
      // The same refusal for „expired" and „never existed": any
      // distinction would be information for someone who is guessing.
      expect(invented.status).toBe(expired.status);
      expect(invented.body).toEqual(expired.body);
      expect(await passwordOf(person.id, PASSWORD)).toBe(true);
    });

    it('ändert mit dem Token einer Person nie das Konto einer anderen', async () => {
      // **The case that carries the construction.** The token names no
      // account that the sender could choose — it *is* the row, and the row
      // carries its person. Whoever has a valid token of their own can turn
      // nothing on it.
      const holder = await freshLocal('holder');
      const victim = await freshLocal('victim');

      await requestReset(holder.email);
      const token = await tokenFromMail(holder.id);

      const response = await confirmReset(token, 'uebernommen bitte sehr');
      expect(response.status).toBe(204);

      expect(await passwordOf(holder.id, 'uebernommen bitte sehr')).toBe(true);
      expect(await passwordOf(victim.id, 'uebernommen bitte sehr')).toBe(false);
      expect(await passwordOf(victim.id, PASSWORD)).toBe(true);
    });

    it('wirkt über Organisation-Grenzen hinweg nur auf sein eigenes Konto', async () => {
      // This route knows no organisation — there is no caller out of which
      // one would arise. What separates them is the row itself.
      const inBeta = await freshLocal('beta-person', beta);
      const inAlpha = await freshLocal('alpha-person');

      await requestReset(inBeta.email);
      const token = await tokenFromMail(inBeta.id);
      expect((await confirmReset(token, 'beta bekommt ein wort')).status).toBe(
        204,
      );

      expect(await passwordOf(inBeta.id, 'beta bekommt ein wort')).toBe(true);
      expect(await passwordOf(inAlpha.id, 'beta bekommt ein wort')).toBe(false);
      expect(await passwordOf(inAlpha.id, PASSWORD)).toBe(true);

      // And the mail is queued under the organisation in which the account
      // came into being — `mail_log.tenant_id` is NOT NULL, so it has to have
      // one, and it must not be just any one.
      const mail = await app().prisma.mailLog.findFirstOrThrow({
        where: { recipient: inBeta.email },
        orderBy: { createdAt: 'desc' },
        select: { tenantId: true },
      });
      expect(mail.tenantId).toBe(beta.id);
    });

    it('entwertet mit einem neuen Link jeden älteren derselben Person', async () => {
      const person = await freshLocal('reissued');
      await requestReset(person.email);
      const older = await tokenFromMail(person.id);
      await requestReset(person.email);
      const newer = await tokenFromMail(person.id);
      expect(newer).not.toBe(older);

      expect(
        (await confirmReset(older, 'der alte link bitte nicht')).status,
      ).toBe(400);
      expect(
        (await confirmReset(newer, 'der neue link bitte schon')).status,
      ).toBe(204);
      expect(await passwordOf(person.id, 'der neue link bitte schon')).toBe(
        true,
      );
    });
  });

  describe('eine Passwortänderung auf anderem Weg entwertet offene Links', () => {
    it('macht den Link aus der Mail unbrauchbar, sobald die Person ihr Passwort selbst ändert', async () => {
      const person = await freshLocal('invalidated');
      await requestReset(person.email);
      const token = await tokenFromMail(person.id);

      const session = await openSession(testApp, person.id, alpha.id);
      const changed = await request(app().server)
        .post(apiPath('/auth/password'))
        .set(authedMutation(session))
        .send({
          currentPassword: PASSWORD,
          newPassword: 'selbst gesetzt und lang genug',
        });
      expect(changed.status).toBe(200);

      // The link from the mail is thereby dead — otherwise it would be a
      // second key next to the lock that has just been changed.
      expect(
        (await confirmReset(token, 'wieder etwas anderes langes')).status,
      ).toBe(400);
      expect(await passwordOf(person.id, 'selbst gesetzt und lang genug')).toBe(
        true,
      );
    });
  });
});

/** How long a call took, in milliseconds. */
async function timed(run: () => Promise<unknown>): Promise<number> {
  const started = Date.now();
  await run();
  return Date.now() - started;
}
