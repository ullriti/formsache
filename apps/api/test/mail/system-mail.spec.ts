import { randomBytes } from 'node:crypto';

import { Prisma } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MailSecretsService } from '../../src/mail/mail-secrets.service';
import { MailWorkerService } from '../../src/mail/mail-worker.service';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import {
  apiPath,
  createTestApp,
  TEST_PUBLIC_BASE_URL,
  type TestApp,
} from '../support/create-test-app';
import { createTenant, createUser } from '../support/fixtures';
import { authedMutation, openSession } from '../support/http';
import { startSmtpInbox, type SmtpInbox } from '../support/smtp-inbox';

/**
 * **The requirement, the evidence — the whole mail chain out of the
 * database alone.**
 *
 * The application starts with **no** `SMTP_*` and **no** `PUBLIC_BASE_URL` in
 * its environment — those variables do not exist any more
 * — and a submission still produces a mail that reaches a real SMTP server, with
 * an edit link built from the address stored in the row.
 *
 * ⚠️ **Since ADR-0023 the mail server of this organisation stands in *its
 * own* column**, no longer in that of the installation: an organisation
 * inherits nothing. What comes unchanged out of the system row is the **base
 * address** — it is explicitly no part of the mail block (ADR-0013 no. 3).
 * The statement of this file thereby stays the same and even becomes sharper:
 * the whole chain runs out of the database, and out of two different rows at
 * that.
 *
 * ## Why a real server and a real submission
 *
 * Both halves are the point. A double would prove that *something* was handed to
 * a transport, not that a transport built from a database row can talk to a mail
 * server; and a hand-written `mail_log` row would skip the body freeze,
 * which is where the base address is resolved. What is asserted below is the
 * message the server received.
 *
 * The listener binds to `127.0.0.1`, every address is `…@example.invalid`, and
 * no run can therefore reach a real mailbox.
 *
 * ## The negative probe this file is built around
 *
 * With the base address read from anywhere but the row — an environment
 * variable, a request's `Host`, a constant — the link assertion fails, because
 * the row holds an address no request in this suite carries.
 */

const SETUP_TIMEOUT_MS = 180_000;

const PAGE = '019ffd00-0000-7000-8000-0000000000a0';
const NAME_QUESTION = '019ffd00-0000-7000-8000-000000000001';
const OFFICE_ADDRESS = 'buero@example.invalid';
const SENDER_ADDRESS = 'formulare@installation.invalid';
/**
 * Minted per run, never written down: a fixed word would either turn up
 * somewhere by chance (false red) or nowhere for reasons unrelated to the code
 * (green that proves nothing) — the shape of the requirement, the evidence.
 */
const MAIL_PASSWORD = `pw-${randomBytes(9).toString('hex')}`;

/** Undoes quoted-printable's soft line breaks — see the assertion that uses it. */
function unwrapped(body: string): string {
  return body.replace(/=\r?\n/g, '');
}

describe('the mail chain runs on the Systemeinstellungen alone ', () => {
  let database: TestDatabase | undefined;
  let inbox: SmtpInbox;
  let testApp: TestApp;
  let editor: string;
  let slug: string;
  let tenantId: string;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    inbox = await startSmtpInbox();

    testApp = await createTestApp({
      databaseUrl: database.url,
      // The base address comes out of the system row — it is no mail identity
      // and stays there (ADR-0013 no. 3). A mail server of the installation is
      // **not** set up here: it serves operations, not the post of an
      // organisation (ADR-0023), and leaving it out makes the statement below
      // sharper — there is nothing that could be fallen back on.
      systemMail: { publicBaseUrl: TEST_PUBLIC_BASE_URL },
    });

    const tenant = await createTenant(testApp.prisma, 'SYSMAIL');
    // The mail server **of this organisation**, in its column and sealed the
    // way the route seals it: the catching server demands a login
    // (`authOptional: false`), so the password goes sealed into the row and
    // opened to the server.
    await testApp.prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        smtp: testApp.app.get(MailSecretsService).sealTenantBlock(
          {
            host: '127.0.0.1',
            port: inbox.port,
            secure: false,
            auth: {
              user: 'installation',
              password: { kind: 'typed', value: MAIL_PASSWORD },
            },
            from: SENDER_ADDRESS,
          },
          tenant.id,
        ),
      },
    });
    tenantId = tenant.id;
    const user = await createUser(testApp.prisma, {
      email: 'editor@example.org',
      password: 'test-password',
      tenants: [tenant],
    });
    editor = await openSession(testApp, user.id, tenant.id);
    slug = await publishedForm();
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await testApp.close();
    await inbox.close();
    await database?.release();
  }, 120_000);

  /**
   * The premise of this file, asserted rather than assumed.
   *
   * If a stray `SMTP_HOST` were set in the process, every case below could pass
   * for a reason that has nothing to do with the row — and a green suite would
   * be the strongest possible evidence for the opposite of what it claims.
   */
  it('runs in a process that has no mail configuration in its environment', () => {
    for (const gone of [
      'SMTP_HOST',
      'SMTP_PORT',
      'SMTP_USER',
      'SMTP_PASSWORD',
      'SMTP_FROM',
      'SMTP_SECURE',
      'PUBLIC_BASE_URL',
    ]) {
      expect(
        process.env[gone],
        `${gone} is set in this process`,
      ).toBeUndefined();
    }
  });

  it('delivers a submission’s notification to a real mail server', async () => {
    const submitted = await request(app().server)
      .post(apiPath(`/public/forms/${slug}/responses`))
      .send({ answers: { [NAME_QUESTION]: 'Anton Aktiv' } });
    expect(submitted.status).toBe(200);
    // The edit address in the answer already comes from the row (the requirement): the confirmation page shows it, and no request in this
    // suite carries that host.
    expect((submitted.body as { editUrl: string | null }).editUrl).toContain(
      `${TEST_PUBLIC_BASE_URL}/a/`,
    );

    const run = await app().app.get(MailWorkerService).runOnce();
    expect(run.sent).toBe(1);
    expect(run.withheld).toBe(0);

    // The server's own record — the transport was built from the stored block
    // and really spoke SMTP.
    expect(inbox.messages).toHaveLength(1);
    const message = inbox.messages[0];
    expect(message?.to).toEqual([OFFICE_ADDRESS]);
    // The sender address is the one in the row, not a default and not a value
    // from anywhere else.
    expect(message?.from).toBe(SENDER_ADDRESS);
    // …and the link inside the body starts at the stored base address. The
    // soft line breaks of quoted-printable are removed first: a mailer wraps at
    // 76 characters, so the URL arrives in pieces and a naive `toContain` would
    // fail on a mail that is perfectly correct.
    expect(unwrapped(message?.data ?? '')).toContain(
      `${TEST_PUBLIC_BASE_URL}/a/`,
    );

    const row = await app().prisma.mailLog.findFirstOrThrow({
      where: { recipient: OFFICE_ADDRESS },
      select: { status: true, lastError: true },
    });
    expect(row.status).toBe('sent');
    expect(row.lastError).toBeNull();
  });

  /**
   * The other half of ADR-0013 no. 5, on the same installation: with the block
   * removed the queue **waits** instead of failing. „Nichts eingerichtet" is not
   * „kaputt", and a fresh installation has to stay usable.
   */
  it('holds mail in the queue when the row carries no mail server', async () => {
    await app().prisma.tenant.update({
      where: { id: tenantId },
      // `DbNull`, the SQL NULL — the state a freshly created organisation is
      // in. Prisma's `JsonNull` would store the JSON value `null`, which is a
      // different thing and would be a document that does not parse.
      data: { smtp: Prisma.DbNull },
    });

    const submitted = await request(app().server)
      .post(apiPath(`/public/forms/${slug}/responses`))
      .send({ answers: { [NAME_QUESTION]: 'Berta Mitglied' } });
    expect(submitted.status).toBe(200);

    const before = inbox.messages.length;
    const run = await app().app.get(MailWorkerService).runOnce();
    expect(run.sent).toBe(0);
    expect(run.failed).toBe(0);
    // Withheld, not failed: nothing was attempted and nothing refused.
    expect(run.withheld).toBeGreaterThan(0);
    expect(inbox.messages).toHaveLength(before);

    const rows = await app().prisma.mailLog.findMany({
      where: { status: 'queued' },
      select: { lastError: true },
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.lastError).toContain(
      'Diese Organisation hat keinen Mailserver eingetragen',
    );

    // …and it resolves itself the moment somebody configures one, which is the
    // whole reason the state is `queued` rather than `failed`.
    await app().prisma.tenant.update({
      where: { id: tenantId },
      data: {
        smtp: app()
          .app.get(MailSecretsService)
          .sealTenantBlock(
            {
              host: '127.0.0.1',
              port: inbox.port,
              secure: false,
              auth: {
                user: 'installation',
                password: { kind: 'typed', value: MAIL_PASSWORD },
              },
              from: SENDER_ADDRESS,
            },
            tenantId,
          ),
      },
    });
    const second = await app().app.get(MailWorkerService).runOnce();
    expect(second.sent).toBeGreaterThan(0);
    expect(inbox.messages.length).toBeGreaterThan(before);
  });

  /**
   * A published form with one internal notification — through the real routes,
   * so what lands in `mail_log` is what the submission path writes, edit link
   * and all.
   */
  async function publishedForm(): Promise<string> {
    const created = await request(testApp.server)
      .post(apiPath('/forms'))
      .set(authedMutation(editor))
      .send({ title: 'Anmeldung Jahrestagung' });
    expect(created.status).toBe(201);
    const form = created.body as {
      id: string;
      revision: number;
      publicSlug: string;
    };

    const saved = await request(testApp.server)
      .put(apiPath(`/forms/${form.id}`))
      .set(authedMutation(editor))
      .send({
        title: 'Anmeldung Jahrestagung',
        definition: {
          pages: [
            {
              id: PAGE,
              title: 'Anmeldung',
              questions: [
                {
                  id: NAME_QUESTION,
                  type: 'text',
                  label: 'Name',
                  hint: null,
                  required: false,
                  width: 'full',
                  minLength: null,
                  maxLength: null,
                  pattern: null,
                },
              ],
            },
          ],
        },
        revision: form.revision,
      });
    expect(saved.status).toBe(200);

    // Editing on, so the mail carries `{{bearbeiten}}` — the placeholder whose
    // resolution needs the base address of the row.
    const settingsRevision = (
      await testApp.prisma.form.findUniqueOrThrow({
        where: { id: form.id },
        select: { settingsRevision: true },
      })
    ).settingsRevision;
    const tenantRevision = (
      await testApp.prisma.tenant.findFirstOrThrow({
        select: { formDefaultsRevision: true },
      })
    ).formDefaultsRevision;
    const configured = await request(testApp.server)
      .put(apiPath(`/forms/${form.id}/settings`))
      .set(authedMutation(editor))
      .send({
        overridden: {
          access: true,
          confirm: false,
          display: false,
          budget: false,
        },
        values: { allowEdit: true },
        revision: settingsRevision,
        tenantRevision,
      });
    expect(configured.status).toBe(200);

    const published = await request(testApp.server)
      .post(apiPath(`/forms/${form.id}/publish`))
      .set(authedMutation(editor))
      .send({ revision: (saved.body as { revision: number }).revision });
    expect(published.status).toBe(200);

    const notification = await request(testApp.server)
      .post(apiPath(`/forms/${form.id}/notifications`))
      .set(authedMutation(editor))
      .send({
        name: 'Anmeldung an das Organisationsbüro',
        subject: 'Neue Anmeldung',
        body: 'Es ist eine Anmeldung eingegangen: {{bearbeiten}}',
        recipients: [{ kind: 'literal', address: OFFICE_ADDRESS }],
        replyTo: null,
      });
    expect(notification.status).toBe(201);

    return form.publicSlug;
  }
});
