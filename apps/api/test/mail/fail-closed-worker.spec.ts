import { randomBytes } from 'node:crypto';

import { MAIL_MAX_ATTEMPTS } from '@formsache/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MAIL_BACKOFF_MAX_MS } from '../../src/mail/mail-backoff';
import { MAIL_CATEGORY_UNREACHABLE } from '../../src/mail/mail-error-category';
import { MailSecretsService } from '../../src/mail/mail-secrets.service';
import { SYSTEM_IDENTITY_KEY } from '../../src/mail/mail-transport';
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
import { MutableClock } from './mail-test-context';
import { IdentityRoutingDouble } from './identity-routing-double';

/**
 * **Fail closed, measured after a worker run** (ADR-0013
 * no. 4).
 *
 * `identity-fail-closed.spec.ts` proves the *resolution* never answers with the
 * installation's block. It says so itself: its counter reads 0 because the
 * resolution knows no transport at all, which is the property this suite rests on but
 * not the proof the requirement describes. **That one reads the counter after a
 * worker run**, and until the mail worker existed there was no caller. This file is that
 * caller.
 *
 * ## The arrangement the requirement insists on
 *
 * The installation's transport **works**. A test in which the fallback is also
 * broken stays green with the fallback in place — "the mail did not go out"
 * would be true either way — so the measurement is the *counter of the system
 * identity*, and the last case here proves that counter can move at all. Take
 * that case away and the file measures nothing.
 *
 * ## And the other half: the confirmation is untouched
 *
 * An organisation that has locked itself out still gets a confirmation page and a stored
 * answer. Not being deliverable is a mail problem, not a registration problem —
 * and it is asserted here rather than assumed, because this is the first package
 * in which the sending identity is resolved on the path that leads to a `failed`
 * row.
 */

const SETUP_TIMEOUT_MS = 180_000;
const CASE_TIMEOUT_MS = 60_000;

const PAGE = '019ffe00-0000-7000-8000-0000000000a0';
const NAME_QUESTION = '019ffe00-0000-7000-8000-000000000001';
const OFFICE_ADDRESS = 'buero@example.invalid';
const OWN_HOST = 'mail.eigener-Organisation.invalid';

describe('no fallback to the installation’s transport', () => {
  let database: TestDatabase | undefined;
  let testApp: TestApp | undefined;
  let double: IdentityRoutingDouble;
  let clock: MutableClock;
  let ownTenantId: string;
  let slug: string;

  function app(): TestApp {
    if (testApp === undefined) {
      throw new Error('no test app');
    }
    return testApp;
  }

  beforeAll(async () => {
    database = await acquireTestDatabase();
    double = new IdentityRoutingDouble();
    clock = new MutableClock(new Date());

    testApp = await createTestApp({
      databaseUrl: database.url,
      transport: double,
      clock,
      // The installation has a mail server, and it is in working order. That is
      // the control: "no fallback" has to be a decision, not the absence of
      // an alternative.
      systemMail: {
        publicBaseUrl: TEST_PUBLIC_BASE_URL,
        smtp: {
          host: 'smtp.installation.invalid',
          port: 587,
          secure: false,
          auth: null,
          from: 'formulare@installation.invalid',
        },
      },
    });

    const tenant = await createTenant(testApp.prisma, 'FAILCL');
    ownTenantId = tenant.id;
    // The organisation sends over its own mail server — and that server refuses every
    // connection. A double rather than a switched-off port: it refuses
    // deterministically instead of after whatever TCP timeout the host has.
    await testApp.prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        smtp: testApp.app.get(MailSecretsService).sealTenantBlock(
          {
            host: OWN_HOST,
            port: 587,
            secure: false,
            from: 'post@eigener-Organisation.invalid',
            auth: {
              user: 'Organisation',
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
    double.refuse(tenant.id);

    const user = await createUser(testApp.prisma, {
      email: 'editor@example.org',
      password: 'test-password',
      tenants: [tenant],
    });
    const editor = await openSession(testApp, user.id, tenant.id);
    slug = await publishedForm(testApp, editor);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await testApp?.close();
    await database?.release();
  });

  it(
    'fails the row without ever asking the installation’s transport',
    async () => {
      const submitted = await request(app().server)
        .post(apiPath(`/public/forms/${slug}/responses`))
        .send({ answers: { [NAME_QUESTION]: 'Anton Aktiv' } });

      // **Unchanged.** The confirmation itself, not only its status: an
      // organisation that mistyped its own SMTP host has not thereby lost its
      // registrations.
      expect(submitted.status).toBe(200);
      expect(submitted.body).toMatchObject({
        confirmationTitle: 'Vielen Dank!',
      });
      expect(await app().prisma.response.count()).toBe(1);

      const worker = app().app.get(MailWorkerService);
      for (let round = 0; round < MAIL_MAX_ATTEMPTS; round += 1) {
        await worker.runOnce();
        clock.advance(MAIL_BACKOFF_MAX_MS + 60_000);
      }

      const row = await app().prisma.mailLog.findFirstOrThrow({
        where: { recipient: OFFICE_ADDRESS },
      });
      expect(row.status).toBe('failed');
      expect(row.attempts).toBe(MAIL_MAX_ATTEMPTS);
      // Readable, and it names what to fix.
      expect(row.lastError).toBe(MAIL_CATEGORY_UNREACHABLE);

      // The organisation's own transport was asked, every single time …
      expect(double.attemptsFor(ownTenantId)).toHaveLength(MAIL_MAX_ATTEMPTS);
      // … and **this** is the requirement: the installation's was not asked once.
      // A `?? systemTransport` anywhere on this path moves this number.
      expect(double.attemptsFor(SYSTEM_IDENTITY_KEY)).toHaveLength(0);
    },
    CASE_TIMEOUT_MS,
  );

  /**
   * The case that makes the zero above mean something.
   *
   * Without it, "the system transport was not asked" would be equally true
   * of a transport that cannot be reached at all — and the requirement says so
   * in as many words: the system transport in the test has to be
   * **operational**.
   */
  it('delivers the installation’s own mail over that very transport', async () => {
    // **The counter-check, since ADR-0023 over the system lane.** Before it was
    // an inheriting tenant; that one no longer exists. What remains is the only
    // kind of row that still uses the installation's block — and exactly that
    // one has to go out, so that "the system transport stayed at 0" above
    // proves a decision and not a broken transport.
    const other = await createTenant(app().prisma, 'SYSPOST');
    await app().prisma.mailLog.create({
      data: {
        tenantId: other.id,
        recipient: 'betrieb@example.invalid',
        subject: 'Passwort zurücksetzen',
        status: 'queued',
        trigger: 'system',
        // Frozen at enqueue time, as the submission path writes it —
        // a row without a body has nothing to send and would never reach a
        // transport, which would leave this control proving nothing.
        bodyText: 'Es ist eine Anmeldung eingegangen.',
      },
    });

    const run = await app().app.get(MailWorkerService).runOnce();
    expect(run.sent).toBe(1);

    // The counter moves — so it was a working transport that stayed at zero.
    expect(double.attemptsFor(SYSTEM_IDENTITY_KEY)).toHaveLength(1);
    expect(double.sendersFor(SYSTEM_IDENTITY_KEY)).toEqual([
      'formulare@installation.invalid',
    ]);
  });

  /** A published form with one internal notification, through the real routes. */
  async function publishedForm(
    target: TestApp,
    editor: string,
  ): Promise<string> {
    const created = await request(target.server)
      .post(apiPath('/forms'))
      .set(authedMutation(editor))
      .send({ title: 'Anmeldung Jahrestagung' });
    expect(created.status).toBe(201);
    const form = created.body as {
      id: string;
      revision: number;
      publicSlug: string;
    };

    const saved = await request(target.server)
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

    const published = await request(target.server)
      .post(apiPath(`/forms/${form.id}/publish`))
      .set(authedMutation(editor))
      .send({ revision: (saved.body as { revision: number }).revision });
    expect(published.status).toBe(200);

    const notification = await request(target.server)
      .post(apiPath(`/forms/${form.id}/notifications`))
      .set(authedMutation(editor))
      .send({
        name: 'Anmeldung an das Organisationsbüro',
        subject: 'Neue Anmeldung',
        body: 'Es ist eine Anmeldung eingegangen.',
        recipients: [{ kind: 'literal', address: OFFICE_ADDRESS }],
        replyTo: null,
      });
    expect(notification.status).toBe(201);

    return form.publicSlug;
  }
});
