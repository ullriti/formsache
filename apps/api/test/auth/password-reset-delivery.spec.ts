import { randomBytes } from 'node:crypto';
import { PASSWORD_RESET_SEGMENT } from '@formsache/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MailSecretsService } from '../../src/mail/mail-secrets.service';
import { MailWorkerService } from '../../src/mail/mail-worker.service';
import { SYSTEM_IDENTITY_KEY } from '../../src/mail/mail-transport';
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
  createTenant,
  createUser,
  type TenantFixture,
} from '../support/fixtures';
import { authedMutation, openSession } from '../support/http';
import { SmtpDouble } from '../support/smtp-double';

const PASSWORD = 'ein hinreichend langes passwort';

/** The host the organisation enters — it must never be asked. */
const TENANT_SMTP_HOST = 'relay.angreifer.invalid';
/** The address the organisation enters — it must stand in no link. */
const TENANT_BASE_URL = 'https://formsache.angreifer.example';

/**
 * **How a reset mail leaves the installation — the wire, not the
 * database** (ADR-0020, two security findings).
 *
 * The construction of the token withstands every look into the database: stored
 * is only a hash, in the body stands a marker, the address arises only at
 * delivery time. It did not withstand the **wire** — and both holes were
 * the same bug, only in two places: sender identity and base address
 * belonged to the organisation whose administration ADR-0020 keeps away from
 * exactly this account.
 *
 * ## The attack that both cases here stand against
 *
 * Somebody with `can_manage_settings` — **without** `can_manage_users`, no
 * superadmin — enters an own SMTP host and an own base address for their
 * organisation. They are allowed both; the organisation grants this
 * right regularly. Then, **not logged in**, they request „Passwort vergessen" for the
 * address of a superadmin. The mail is queued under the oldest living
 * membership of that account — in a typical installation
 * exactly their organisation.
 *
 * Before: the worker handed the fully rendered mail **with the
 * plaintext link** to their relay (finding 1), and the link pointed at their host
 * (finding 2). No click of the victim needed.
 *
 * ## Why that would not have turned red without this file
 *
 * "Over which mail server did this row go" was not observable in the test: the
 * SMTP double only recorded the message, not the identity. It now records
 * both (`smtp-double.ts`), and that is the half of the fix which prevents
 * the hole from arising unnoticed a second time.
 */
describe('Rücksetz-Mail: Absender und Link gehören der Installation', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  let tenant: TenantFixture;
  let transport: SmtpDouble;
  let victim: { id: string; email: string };

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    transport = new SmtpDouble();
    testApp = await createTestApp({
      databaseUrl: database.url,
      transport,
    });

    // The installation is set up: own block, own address.
    await configureSystemMail(testApp, {
      publicBaseUrl: TEST_PUBLIC_BASE_URL,
      smtp: TEST_SYSTEM_SMTP_BLOCK,
    });

    tenant = await createTenant(testApp.prisma, 'PWDEL');

    // **What the organisation may enter** — both over `can_manage_settings`,
    // written directly into the columns here, because the routes for it have
    // their own cases and this one measures the *consequences*, not the write path.
    await testApp.prisma.tenant.update({
      where: { id: tenant.id },
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
          tenant.id,
        ),
      },
    });

    victim = await createUser(testApp.prisma, {
      email: 'delivery-victim@example.org',
      password: PASSWORD,
      tenants: [tenant],
    });
  }, 180_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  /** The one delivered reset mail — requested, then really sent. */
  async function deliverReset(): Promise<{
    readonly identityKey: string;
    readonly host: string;
    readonly text: string;
  }> {
    const before = transport.attempts.length;
    const requested = await request(app().server)
      .post(apiPath('/auth/password-reset/request'))
      .set('Content-Type', 'application/json')
      .send({ email: victim.email });
    expect(requested.status).toBe(204);

    // The real worker, not a replica: what is measured here is the
    // path a row takes in production.
    await app().app.get(MailWorkerService).runOnce();

    const sent = transport.attempts.slice(before);
    const identities = transport.identities.slice(before);
    expect(sent).toHaveLength(1);
    const mail = sent[0];
    const identity = identities[0];
    expect(mail).toBeDefined();
    expect(identity).toBeDefined();
    return {
      identityKey: identity?.key ?? '',
      host: identity?.block.host ?? '',
      text: mail?.text ?? '',
    };
  }

  it('geht über die Systemidentität, obwohl die Organisation einen eigenen Mailserver hat', async () => {
    const delivered = await deliverReset();

    // **Finding 1.** Before, the organisation's identifier and its host stood
    // here — the attacker would have read the plaintext link in their own
    // relay, without the victim doing anything at all.
    expect(delivered.identityKey).toBe(SYSTEM_IDENTITY_KEY);
    expect(delivered.host).toBe(TEST_SYSTEM_SMTP_BLOCK.host);
    expect(delivered.host).not.toBe(TENANT_SMTP_HOST);
  });

  it('baut den Link aus der Basis-Adresse der Installation, nie aus der der Organisation', async () => {
    const delivered = await deliverReset();

    // **Finding 2.** Before, the only link of this mail pointed at the host
    // that `can_manage_settings` had entered — a real, correctly
    // worded mail to the victim, and one click hands over the token.
    expect(delivered.text).toContain(
      `${TEST_PUBLIC_BASE_URL}/${PASSWORD_RESET_SEGMENT}/`,
    );
    expect(delivered.text).not.toContain(TENANT_BASE_URL);
    expect(delivered.text).not.toContain('angreifer');
  });

  /**
   * **The footer is a link too, and the same attack path carries it.**
   *
   * ADR-0020 §5 justifies `installationBaseUrl()` at the reset link with the
   * authority that a click hands over. The footer carries none — what of the
   * justification nevertheless carries is the other half: this mail goes out over
   * the mail server of the **installation**, authenticated under its domain by SPF and
   * DKIM (ADR-0023). A link in it to a host that
   * `can_manage_settings` of an arbitrary organisation has set would be a
   * foreign landing page under foreign authentication.
   *
   * *Reproduction:* in `QueuedBodyRenderer.footerLinkFor` switch the `system`
   * branch to `resolveBaseUrl` → red, with the attacker's host in the text.
   */
  it('setzt auch die Fußzeile auf die Adresse der Installation', async () => {
    const delivered = await deliverReset();

    expect(delivered.text).toContain(`Zu Formsache: ${TEST_PUBLIC_BASE_URL}`);
    expect(delivered.text).not.toContain(TENANT_BASE_URL);
    expect(delivered.text).not.toContain('angreifer');
  });

  it('lässt eine Formularbestätigung weiterhin über den Mailserver der Organisation gehen', async () => {
    // **The counter-check, and it is the actual proof**: a rule that
    // forces *every* mail onto the system identity would be no fix but the
    // withdrawal of ADR-0013. What makes the difference is the column
    // `trigger` — set by hand here, because this case measures the path and
    // not the public filling-in path.
    const before = transport.attempts.length;
    await app().prisma.mailLog.create({
      data: {
        tenantId: tenant.id,
        recipient: 'teilnehmerin@example.org',
        subject: 'Anmeldung eingegangen',
        bodyText: 'Danke für Ihre Anmeldung.',
        status: 'queued',
        trigger: 'submit',
      },
    });

    await app().app.get(MailWorkerService).runOnce();

    const identities = transport.identities.slice(before);
    expect(identities).toHaveLength(1);
    expect(identities[0]?.key).toBe(tenant.id);
    expect(identities[0]?.block.host).toBe(TENANT_SMTP_HOST);

    // And the footer follows the same boundary: a confirmation belongs to the
    // organisation, so **its** address stands there. A rule that forced every
    // footer onto the installation would be as wrong as one that sent every
    // mail over the installation's mail server.
    const sent = transport.attempts.slice(before);
    expect(sent[0]?.text).toContain(TENANT_BASE_URL);
    expect(sent[0]?.text).not.toContain(TEST_PUBLIC_BASE_URL);
  });

  it('reiht die Mitteilung über ein administrativ gesetztes Passwort ebenso als Systemmail ein', async () => {
    // It carries no link, but the same property: a statement of the
    // application about an account does not go over the mail server of an
    // organisation.
    const admin = await createUser(app().prisma, {
      email: 'delivery-admin@example.org',
      password: PASSWORD,
      tenants: [tenant],
    });
    const member = await createUser(app().prisma, {
      email: 'delivery-member@example.org',
      password: PASSWORD,
      tenants: [tenant],
    });
    const session = await openSession(testApp, admin.id, tenant.id);

    const before = transport.attempts.length;
    const set = await request(app().server)
      .post(apiPath(`/tenant/users/${member.id}/password`))
      .set(authedMutation(session))
      .send({ password: 'ein neues langes passwort' });
    expect(set.status).toBe(201);

    await app().app.get(MailWorkerService).runOnce();

    const sent = transport.attempts.slice(before);
    const identities = transport.identities.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(member.email);
    expect(identities[0]?.key).toBe(SYSTEM_IDENTITY_KEY);
    // **The password that was set does not stand in the mail** — it would thereby stand in
    // `mail_log.body_text`, that is, in the column the delivery log shows.
    expect(sent[0]?.text).not.toContain('ein neues langes passwort');
  });
});
