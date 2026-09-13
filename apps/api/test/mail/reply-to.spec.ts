import { randomBytes } from 'node:crypto';

import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { effectiveReplyTo } from '@formsache/shared';

import { MailWorkerService } from '../../src/mail/mail-worker.service';
import { SystemMailSettingsService } from '../../src/system-settings/system-mail-settings.service';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import {
  apiPath,
  configureSystemMail,
  createTestApp,
  TEST_PUBLIC_BASE_URL,
  type TestApp,
} from '../support/create-test-app';
import { MailSecretsService } from '../../src/mail/mail-secrets.service';
import { createTenant, createUser } from '../support/fixtures';
import { authedMutation, openSession } from '../support/http';
import { startSmtpInbox, type SmtpInbox } from '../support/smtp-inbox';

/**
 * **`Reply-To` per notification, with a default from the system settings**.
 *
 * ## What is measured is the **sent header**, not the configuration
 *
 * Every case below reads `Reply-To:` out of what a real SMTP server has
 * accepted. A test that checked the column or the resolution function instead
 * would stay green if the transport never touched the value — and that is
 * exactly the one fault that counts here: a mail goes out, it looks right, and
 * the reply lands somewhere else.
 *
 * The unit tests of the chain itself stand in
 * `packages/shared/src/reply-to.test.ts`; here stands what arrives on the wire.
 *
 * ## The five promises of this file
 *
 * 1. **The chain applies in the right order:** notification → organisation
 *    → system, each read off the header.
 * 2. **If nothing is set anywhere, the mail carries no header — and still goes
 *    out.** That is the decision on „required": the effective value is then
 *    „no header", not „delivery refused".
 * 3. **The value is frozen at the enqueue.** Whoever changes the notification
 *    afterwards no longer changes a mail that has already been promised.
 * 4. **An unusably stored value falls through**, instead of going out as a
 *    header.
 * 5. **The testmail carries it too** — with *two* levels, organisation and system,
 *    because no notification belongs to it. That way the button, which sits on
 *    the mail-delivery tab anyway, checks exactly the field next to it.
 *
 * ## Every case establishes its own state
 *
 * The three levels are set **completely** at the start of every case
 * ({@link setLevels}), none ever carried over from the case before. That is not
 * tidiness: the file used to hang on its order — case 2 set the system default,
 * 3–7 built on it, and one restored `tenant.reply_to` by hand at the end. A
 * case run on its own (`-t`) then measured something other than the same case
 * in the full run, and a reordering would silently have shifted the statement.
 */

const SETUP_TIMEOUT_MS = 180_000;

const PAGE = '019ffd00-0000-7000-8000-0000000000b0';
const NAME_QUESTION = '019ffd00-0000-7000-8000-000000000011';
const OFFICE_ADDRESS = 'buero@example.invalid';
const SENDER_ADDRESS = 'formulare@installation.invalid';

const SYSTEM_REPLY_TO = 'system-antwort@example.invalid';
const TENANT_REPLY_TO = 'Organisation-antwort@example.invalid';
const NOTIFICATION_REPLY_TO = 'benachrichtigung-antwort@example.invalid';

const MAIL_PASSWORD = `pw-${randomBytes(9).toString('hex')}`;

/** Undoes quoted-printable's soft line breaks — headers wrap at 76 characters. */
function unwrapped(body: string): string {
  return body.replace(/=\r?\n/g, '');
}

/**
 * The `Reply-To` header of the message, or `null` when there is none.
 *
 * **The difference between „no header" and „empty header" is the core of
 * promise 2**, which is why the search here is for the header line and not for
 * the address: a `toContain(address)` could not tell a header with an empty
 * value from a missing one.
 */
function replyToHeader(data: string): string | null {
  const match = /^Reply-To:\s*(.*)$/im.exec(unwrapped(data));
  return match === null ? null : (match[1]?.trim() ?? '');
}

describe('Reply-To je Benachrichtigung ', () => {
  let database: TestDatabase | undefined;
  let inbox: SmtpInbox;
  let testApp: TestApp;
  let editor: string;
  let tenantId: string;
  let formId: string;
  let notificationId: string;
  let slug: string;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    inbox = await startSmtpInbox();

    testApp = await createTestApp({
      databaseUrl: database.url,
      systemMail: {
        publicBaseUrl: TEST_PUBLIC_BASE_URL,
        // Explicitly **no** system-wide default at the start: the state in
        // which a mail goes out without a header is the initial state of every
        // installation and must be measurable.
        replyTo: null,
        smtp: {
          host: '127.0.0.1',
          port: inbox.port,
          secure: false,
          auth: { user: 'installation', password: MAIL_PASSWORD },
          from: SENDER_ADDRESS,
        },
      },
    });

    const tenant = await createTenant(testApp.prisma, 'REPLYTO');
    tenantId = tenant.id;
    // **The own mail server of this organisation** (ADR-0023): since the
    // abolition of inheritance nothing at all goes out without it, and this
    // tab measures sent headers. It points at the same inbox as the one of
    // the installation — what counts here is `Reply-To`, not the
    // route.
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
    const user = await createUser(testApp.prisma, {
      email: 'editor@example.org',
      password: 'test-password',
      tenants: [tenant],
    });
    editor = await openSession(testApp, user.id, tenant.id);
    await publishedForm();
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await testApp.close();
    await inbox.close();
    await database?.release();
  }, 120_000);

  /**
   * Submit a registration, let the queue run, and return the header of the
   * mail that arrived at the server while doing so.
   *
   * The round trip goes through the real routes: the value is frozen at the
   * *enqueue*, and a hand-written `mail_log` row would skip exactly the step
   * this is about.
   */
  async function sendOne(name: string): Promise<string | null> {
    const before = inbox.messages.length;
    const submitted = await request(app().server)
      .post(apiPath(`/public/forms/${slug}/responses`))
      .send({ answers: { [NAME_QUESTION]: name } });
    expect(submitted.status).toBe(200);

    const run = await app().app.get(MailWorkerService).runOnce();
    expect(run.sent).toBe(1);
    expect(inbox.messages).toHaveLength(before + 1);
    return replyToHeader(inbox.messages[before]?.data ?? '');
  }

  /**
   * Press „Testmail senden" and return the header of the mail that arrived at
   * the server while doing so.
   *
   * The real route (`POST /api/tenant/smtp/test`), not the service: the
   * promise is that **the button** carries the effective value. The recipient
   * is the address of the session, the route never reads it from the body.
   */
  async function sendTestMail(): Promise<string | null> {
    const before = inbox.messages.length;
    const pressed = await request(app().server)
      .post(apiPath('/tenant/smtp/test'))
      .set(authedMutation(editor))
      .send({});
    expect(pressed.status).toBe(200);
    expect(pressed.body).toMatchObject({ status: 'sent' });
    expect(inbox.messages).toHaveLength(before + 1);
    return replyToHeader(inbox.messages[before]?.data ?? '');
  }

  /**
   * Set all three levels explicitly — the start of every case.
   *
   * The organisation level deliberately goes through Prisma here and not through the
   * route: here it is *state*, not subject, and the route must also be able to
   * produce values that it would itself refuse with 400 (promise 4). That the
   * route exists and that it manages without an SMTP password is measured by
   * the case that owns that.
   */
  async function setLevels(levels: {
    readonly system: string | null;
    readonly tenant: string | null;
    readonly notification: string | null;
  }): Promise<void> {
    await configureSystemMail(app(), { replyTo: levels.system });
    await app().prisma.tenant.update({
      where: { id: tenantId },
      data: { replyTo: levels.tenant },
    });
    await updateNotification({ replyTo: levels.notification });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Promise 2 — nothing set: no header, and the mail goes out anyway
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * **The most expensive confusion, explicitly measured.** „Required" does not
   * mean „no delivery without a value": an installation that never filled in
   * the default keeps sending its confirmations.
   *
   * *Reproduction, measured (2026-08-04):* in the worker set
   * `replyTo: claimed.replyTo ?? sending.block.from` instead of leaving the
   * field out — **exactly this** case turns red (1 failed, 6 passed), because
   * then a header `formulare@installation.invalid` arrives.
   */
  it('sends without a Reply-To header when no level has one', async () => {
    await setLevels({ system: null, tenant: null, notification: null });

    expect(await sendOne('Anton ohne Antwortadresse')).toBeNull();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Promise 1 — the chain, from the bottom up
  // ═══════════════════════════════════════════════════════════════════════

  it('uses the system default once it is set', async () => {
    await setLevels({
      system: SYSTEM_REPLY_TO,
      tenant: null,
      notification: null,
    });

    expect(await sendOne('Berta Systemvorgabe')).toBe(SYSTEM_REPLY_TO);
  });

  /**
   * The organisation beats the system — written through the real route, so
   * that it is also on record that it exists and that it manages **without an
   * SMTP password**: the reply address lies next to the block and not inside
   * it (ADR-0013 no. 3, the question before the build). Exactly for that
   * reason it can be changed here without anyone having the stored SMTP
   * password at hand.
   */
  it('lets the organisation override the installation — through a route of its own', async () => {
    await setLevels({
      system: SYSTEM_REPLY_TO,
      tenant: null,
      notification: null,
    });

    const saved = await request(app().server)
      .put(apiPath('/tenant/reply-to'))
      .set(authedMutation(editor))
      .send({ replyTo: TENANT_REPLY_TO });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ replyTo: TENANT_REPLY_TO });

    // The block of the organisation has stayed untouched — the reply address
    // does not hang on the transport and stands in none of its columns.
    const stored = (
      await app().prisma.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { smtp: true },
      })
    ).smtp;
    expect(JSON.stringify(stored)).not.toContain(TENANT_REPLY_TO);

    expect(await sendOne('Cäcilia Organisationsvorgabe')).toBe(TENANT_REPLY_TO);
  });

  it('lets the notification override the organisation', async () => {
    await setLevels({
      system: SYSTEM_REPLY_TO,
      tenant: TENANT_REPLY_TO,
      notification: NOTIFICATION_REPLY_TO,
    });

    expect(await sendOne('Dora Benachrichtigung')).toBe(NOTIFICATION_REPLY_TO);
  });

  /**
   * And back again: a cleared field is the inheritance, not an empty header.
   *
   * The empty string is not a second state here: `replyToAddressSchema`
   * refuses it with 400, which is why the draft in the editor turns it into
   * `null` (`notification-draft.ts`, `tenant-reply-to-draft.ts`).
   */
  it('falls back to the organisation when the notification clears its own', async () => {
    await setLevels({
      system: SYSTEM_REPLY_TO,
      tenant: TENANT_REPLY_TO,
      notification: NOTIFICATION_REPLY_TO,
    });
    expect(await sendOne('Emil noch mit eigener')).toBe(NOTIFICATION_REPLY_TO);

    await updateNotification({ replyTo: null });

    expect(await sendOne('Emil zurück zur Organisation')).toBe(TENANT_REPLY_TO);
  });

  /**
   * **A `PUT` without the key does not delete the address — it is
   * refused** (a review finding of the Reply-To review).
   *
   * The field is required and nullable, explicitly **without**
   * `.default(null)` (`notificationWriteShape` in `@formsache/shared`). With a
   * default value the same request would have answered 200 and silently set the
   * column to `null`: a second write path that does not know the field — an
   * older interface, a script, a repeated document out of the log
   * — would thereby have deleted a configured reply address without anyone
   * finding out. The two sister routes of the same field decide exactly the
   * same way; three places, one answer to „was heißt weggelassen?".
   *
   * *Reproduction, measured (2026-08-04):* attach `.default(null)` again —
   * this case turns red (200 instead of 400, and the header of the next mail
   * is the one of the organisation instead of the one of the notification).
   */
  it('refuses a notification PUT that omits replyTo, and the address stands', async () => {
    await setLevels({
      system: SYSTEM_REPLY_TO,
      tenant: TENANT_REPLY_TO,
      notification: NOTIFICATION_REPLY_TO,
    });

    const omitted = await request(app().server)
      .put(apiPath(`/forms/${formId}/notifications/${notificationId}`))
      .set(authedMutation(editor))
      .send({
        name: 'Anmeldung an das Organisationsbüro',
        subject: 'Neue Anmeldung',
        body: 'Es ist eine Anmeldung eingegangen.',
        recipients: [{ kind: 'literal', address: OFFICE_ADDRESS }],
      });

    expect(omitted.status).toBe(400);
    expect(omitted.body).toMatchObject({ issues: [{ path: 'replyTo' }] });
    // The column stands unchanged — and the next mail proves it at the header,
    // not just at the row.
    expect(
      (
        await app().prisma.notification.findUniqueOrThrow({
          where: { id: notificationId },
          select: { replyTo: true },
        })
      ).replyTo,
    ).toBe(NOTIFICATION_REPLY_TO);
    expect(await sendOne('Hedwig nichts verloren')).toBe(NOTIFICATION_REPLY_TO);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Promise 4 — an unusable stored value falls through
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * The column is an ordinary `text`, and a value can reach it past the API.
   * It does **not** go out as a header: the chain reaches for the next level,
   * here therefore for the system default.
   *
   * *Reproduction, measured (2026-08-04):* in `effectiveReplyTo` replace the
   * `safeParse` with a mere emptiness check — the unit test of the same name
   * in `packages/shared/src/reply-to.test.ts` turns red (measured there; this
   * case here is the evidence on the wire).
   */
  it('falls through a stored value that is not an address', async () => {
    await setLevels({
      system: SYSTEM_REPLY_TO,
      tenant: 'Dachorganisation <x@example.invalid>, z@example.invalid',
      notification: null,
    });

    expect(await sendOne('Frieda handgeschrieben')).toBe(SYSTEM_REPLY_TO);
  });

  /**
   * **Falling through is the right effect and still a silent failure**
   * (a review finding of the Reply-To review).
   *
   * A hand-written line like `geschaeftsstelle@lokal` takes the header away
   * from every mail of that level; in the interface the address still stands
   * in the field, and in the log there stood nothing so far. It is therefore
   * reported exactly once per process — the same form that `publicBaseUrl` has
   * next door, and for the same reason: one line per mail would bury
   * everything else.
   *
   * **The value itself does not stand in the message.** It comes out of a
   * column and is an e-mail address (`CONTRIBUTING.md`); the id of the organisation
   * is enough to find the row.
   *
   * **A fresh organisation, and the service instead of a delivery** — both for
   * the same reason that `public-forms.spec.ts` names for its twin:
   * `reportOnce` debounces per process, so the counted one would otherwise be
   * a statement about which case ran before, and not about this one. There is
   * nothing to measure in the sent header here — that the chain falls through
   * stands in the case above, on a real mail.
   *
   * *Reproduction, measured (2026-08-04):* remove the `isUnusableReplyTo` in
   * `SystemMailSettingsService.replyToDefaults` and in `replyTo()` respectively —
   * this case turns red, nothing else.
   */
  it('reports an unusable stored value on both levels — once, without the value', async () => {
    const fresh = await createTenant(app().prisma, 'REPLYTO2');
    await app().prisma.tenant.update({
      where: { id: fresh.id },
      data: { replyTo: 'geschaeftsstelle@lokal' },
    });
    // The system level past the route: `configureSystemMail` writes through
    // the schema, and this value is exactly the one the schema would refuse.
    await app().prisma.systemSetting.updateMany({
      data: { replyTo: 'system@lokal' },
    });

    const settings = app().app.get(SystemMailSettingsService);
    const written = vi.spyOn(Logger.prototype, 'error');
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        // Both levels fall through — what comes out is „no header", and
        // without an origin at that: no level has contributed anything.
        expect(
          effectiveReplyTo(
            await settings.replyToDefaults({
              id: fresh.id,
              replyTo: 'geschaeftsstelle@lokal',
            }),
          ),
        ).toEqual({ address: null, origin: null });
      }

      const lines = written.mock.calls.map(([first]) => String(first));
      const tenant = lines.filter((line) => line.includes(fresh.id));
      const system = lines.filter((line) => line.includes('system_setting'));

      expect(tenant).toHaveLength(1);
      expect(system).toHaveLength(1);
      expect(tenant[0]).toContain('reply_to');
      expect(tenant[0]).not.toContain('geschaeftsstelle@lokal');
      expect(system[0]).not.toContain('system@lokal');
    } finally {
      written.mockRestore();
      await app().prisma.systemSetting.updateMany({ data: { replyTo: null } });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Promise 3 — frozen at the enqueue
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * **The value is fixed as soon as the row lies in the queue** — like
   * recipient, subject and body, and unlike
   * `sender_identity`/`sender_address`, which are written at the send.
   *
   * The difference is not symmetry but content versus transport: the reply
   * address stands in the body of the message, the mail server stands in the
   * connection. And the practical reason stands next to it: `notification_id`
   * is `SetNull` — a value resolved at the send would silently disappear as
   * soon as somebody deletes the notification.
   *
   * *Reproduction, measured (2026-08-04):* in `toMailLogRow`
   * (`public-forms.service.ts`) write `replyTo: null` instead of
   * `pending.replyTo` — six of the seven cases of this file turn red, this one
   * already at `queued.replyTo`, that is exactly at the place where the
   * freezing is claimed. (The broad swing is to be expected: the column
   * carries the value for *all* levels, not just for the topmost.)
   */
  it('freezes the value at the enqueue, not at the send', async () => {
    await setLevels({
      system: SYSTEM_REPLY_TO,
      tenant: TENANT_REPLY_TO,
      notification: NOTIFICATION_REPLY_TO,
    });

    const before = inbox.messages.length;
    const submitted = await request(app().server)
      .post(apiPath(`/public/forms/${slug}/responses`))
      .send({ answers: { [NAME_QUESTION]: 'Gustav eingefroren' } });
    expect(submitted.status).toBe(200);

    // The row waits — and already carries the effective value.
    const queued = await app().prisma.mailLog.findFirstOrThrow({
      where: { status: 'queued' },
      orderBy: { createdAt: 'desc' },
      select: { replyTo: true },
    });
    expect(queued.replyTo).toBe(NOTIFICATION_REPLY_TO);

    // Between enqueue and send somebody changes both levels above.
    await updateNotification({ replyTo: 'zu-spaet@example.invalid' });
    await app().prisma.tenant.update({
      where: { id: tenantId },
      data: { replyTo: 'auch-zu-spaet@example.invalid' },
    });

    const run = await app().app.get(MailWorkerService).runOnce();
    expect(run.sent).toBe(1);
    expect(inbox.messages).toHaveLength(before + 1);
    expect(replyToHeader(inbox.messages[before]?.data ?? '')).toBe(
      NOTIFICATION_REPLY_TO,
    );
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Promise 5 — the testmail carries it, and that from two levels
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * **The button checks the field next to it.** „Testmail senden" stands on the same
   * tab as the reply address of the organisation; if the header did not appear
   * there, the button would check everything except what was entered directly
   * next to it.
   *
   * The notification level is here explicitly **set and nevertheless
   * uninvolved**: no notification belongs to a testmail, so none may get into
   * its header either.
   *
   * *Reproduction, measured (2026-08-04):* in `TestMailService.send` strike
   * the `...(replyTo === null ? {} : { replyTo })` from the `mail` object
   * — this case and the next turn red (no header instead of an address).
   */
  it('carries the organisation’s value in a testmail — and never the notification’s', async () => {
    await setLevels({
      system: SYSTEM_REPLY_TO,
      tenant: TENANT_REPLY_TO,
      notification: NOTIFICATION_REPLY_TO,
    });

    expect(await sendTestMail()).toBe(TENANT_REPLY_TO);
  });

  /**
   * And one level lower: if the organisation has none of its own, the testmail carries
   * the system default — the same chain, only without the topmost level.
   *
   * *Reproduction, measured (2026-08-04):* remove `SystemSettingsModule` from
   * the `imports` of `test-mail.module.ts` — the application no longer starts
   * (`TestMailService` does not get `SystemMailSettingsService` resolved), the
   * whole file turns red. If the import stays and only the system level is
   * left out of `replyToDefaults`, it is **this** case.
   */
  it('falls back to the installation in a testmail when the organisation has none', async () => {
    await setLevels({
      system: SYSTEM_REPLY_TO,
      tenant: null,
      notification: NOTIFICATION_REPLY_TO,
    });

    expect(await sendTestMail()).toBe(SYSTEM_REPLY_TO);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Fixtures
  // ═══════════════════════════════════════════════════════════════════════

  /** Replaces the notification through the real route (`PUT`, full replacement). */
  async function updateNotification(patch: {
    readonly replyTo: string | null;
  }): Promise<void> {
    const saved = await request(app().server)
      .put(apiPath(`/forms/${formId}/notifications/${notificationId}`))
      .set(authedMutation(editor))
      .send({
        name: 'Anmeldung an das Organisationsbüro',
        subject: 'Neue Anmeldung',
        body: 'Es ist eine Anmeldung eingegangen.',
        recipients: [{ kind: 'literal', address: OFFICE_ADDRESS }],
        replyTo: patch.replyTo,
      });
    expect(saved.status).toBe(200);
    expect((saved.body as { replyTo: string | null }).replyTo).toBe(
      patch.replyTo,
    );
  }

  async function publishedForm(): Promise<void> {
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
    formId = form.id;
    slug = form.publicSlug;

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
        body: 'Es ist eine Anmeldung eingegangen.',
        recipients: [{ kind: 'literal', address: OFFICE_ADDRESS }],
        // Explicitly sent along, also when creating: `replyTo` is
        // required and nullable, without a default value — an omitted
        // key is a 400, not a silent „then none at all"
        // (`notificationWriteShape` in `@formsache/shared`).
        replyTo: null,
      });
    expect(notification.status).toBe(201);
    // Without an own entry: `null` — the inheritance, not the empty string.
    expect(
      (notification.body as { replyTo: string | null }).replyTo,
    ).toBeNull();
    notificationId = (notification.body as { id: string }).id;
  }
});
