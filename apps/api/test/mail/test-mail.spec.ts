import { randomUUID } from 'node:crypto';

import request from 'supertest';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { Prisma } from '@prisma/client';
import { parseTestMailResult } from '@formsache/shared';

import { MAIL_CATEGORY_UNREACHABLE } from '../../src/mail/mail-error-category';
import { MAIL_CONFIG_UNPARSABLE_REASON } from '../../src/mail/mail-secrets.service';
import {
  MailTransport,
  TENANT_MAIL_NOT_CONFIGURED_REASON,
} from '../../src/mail/mail-transport';
import type { PrismaService } from '../../src/prisma/prisma.service';
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
  createRestrictedMember,
  createTenant,
  createUser,
  type TenantFixture,
} from '../support/fixtures';
import { authedMutation, openSession } from '../support/http';
import { startSmtpInbox, type SmtpInbox } from '../support/smtp-inbox';

/**
 * „Testmail senden".
 *
 * What this file proves, in the order the requirement states its four
 * proofs:
 *
 * 1. **the recipient is the caller, never a notification's list** — a
 *    `mail_log` row already waiting for „buero@…" is untouched, and the new
 *    row addresses the signed-in person;
 * 2. **the real path** — a genuine loopback SMTP server receives the mail,
 *    and a genuine `mail_log` row records it;
 * 3. **the marking** — the row's subject is the fixed sentence a Testmail
 *    always carries, never a rendered notification;
 * 4. **the stored block, never a typed one** — the request schema has no
 *    field a block could travel in, so a body that tries one is refused
 *    before a handler runs.
 *
 * The SSRF hardening the security review demanded (ADR-0013 "Consequences")
 * gets its own proof: an organisation's own server that refuses the connection is
 * answered with a category from `mail-error-category.ts`, never the raw
 * transport error — the property that keeps this route from being a port
 * scanner run from inside the server's network. **Both halves of it**, since
 * a review (two review findings): the category holds for the *system* block
 * too, and the rate limit that is the second, named part of that hardening is
 * measured rather than assumed.
 *
 * The **sending identity** is checked as the `SendingIdentity.key` the
 * transport is handed, not only as "a mail arrived" (a review findingb): swap the two
 * branches of `key: source === 'system' ? SYSTEM_IDENTITY_KEY : tenant.id` and
 * every mail still goes out correctly — the block travels with the key and the
 * transport's fingerprint check rebuilds on a mismatch — while an organisation's own
 * block occupies the installation's cache slot across organisations. Nothing but the
 * key itself can see that, so the key itself is what is asserted.
 */

const SETUP_TIMEOUT_MS = 180_000;
const TEST_MAIL_PATH = '/tenant/smtp/test';
const SMTP_PATH = '/tenant/smtp';

/**
 * The exact subject the Testmail must carry —
 * spelled out here rather than imported from `TEST_MAIL_SUBJECT` in
 * `test-mail.service.ts`. Importing the source's own constant would compare
 * that value against itself: removing the marking there would change both
 * sides together and this assertion would stay green. A literal is what makes
 * "remove the marking" a reproduction this file can actually catch.
 */
const EXPECTED_TEST_MAIL_SUBJECT =
  'Formsache: Testmail — der Mailversand funktioniert';

/**
 * The budget of `TEST_MAIL_RATE_LIMIT`, spelled out here for the reason
 * {@link EXPECTED_TEST_MAIL_SUBJECT} is spelled out: imported from the
 * controller, "raise the limit to a hundred" would change both sides at once
 * and this file would stay green about a defence that no longer holds.
 */
const TEST_MAIL_PRESSES_PER_MINUTE = 10;

function ownBlock(overrides: Record<string, unknown> = {}): unknown {
  return {
    smtp: {
      host: '127.0.0.1',
      port: 1,
      secure: false,
      from: 'post@organisation.invalid',
      auth: null,
      ...overrides,
    },
  };
}

describe('Testmail — the requirement', () => {
  let database: TestDatabase | undefined;
  let testApp: TestApp | undefined;
  let prisma: PrismaService;

  let alpha: TenantFixture;
  let adminSession: string;
  let adminEmail: string;
  let settingsOnlySession: string;
  let viewOnlySession: string;
  /**
   * Started by the nested describe below, closed here — **after** the app.
   * `NodemailerTransport` caches one connection per organisation and only releases it
   * on `onModuleDestroy` (ADR-0013 no. 7); closing the inbox
   * first leaves that connection with nowhere to go and `server.close()` hangs
   * waiting for it, the same ordering `smtp-credentials.spec.ts` already
   * states as `context.close()` before `inbox.close()`.
   */
  let inbox: SmtpInbox | undefined;

  function app(): TestApp {
    if (testApp === undefined) {
      throw new Error('no test app');
    }
    return testApp;
  }

  function box(): SmtpInbox {
    if (inbox === undefined) {
      throw new Error('no smtp inbox');
    }
    return inbox;
  }

  function put(session: string, body: unknown): request.Test {
    return request(app().server)
      .put(apiPath(SMTP_PATH))
      .set(authedMutation(session))
      .send(body as object);
  }

  function testMail(session: string, body: unknown = {}): request.Test {
    return request(app().server)
      .post(apiPath(TEST_MAIL_PATH))
      .set(authedMutation(session))
      .send(body as object);
  }

  beforeAll(async () => {
    database = await acquireTestDatabase();
    // No `transport`/`systemMail` option: the real `NodemailerTransport` stays
    // in the graph (the whole point of the evidence) and the installation starts
    // in the unconfigured state of the requirement, which the "nothing
    // configured" case below relies on.
    testApp = await createTestApp({ databaseUrl: database.url });
    prisma = testApp.prisma;

    // Without a mail server of its own, expressly: the "nothing configured"
    // case below is the initial state of this file (ADR-0023).
    alpha = await createTenant(prisma, `TM${randomUUID().slice(0, 6)}`, null);
    adminEmail = `admin@${alpha.shortName.toLowerCase()}.example.org`;
    const admin = await createUser(prisma, {
      email: adminEmail,
      password: 'test-password',
      tenants: [alpha],
    });
    adminSession = await openSession(app(), admin.id, alpha.id);

    // The pairing from `SmtpConfigController`, mirrored rather than
    // re-chosen: each rejected member holds **all four other** permissions —
    // a member with none would only prove that some guard fires.
    const settingsOnly = await createRestrictedMember(prisma, alpha, {
      email: `settings@${alpha.shortName.toLowerCase()}.example.org`,
      groupName: 'settings-only',
      permissions: {
        canBuild: true,
        canExport: true,
        canManageSettings: true,
        canManageFormSettings: true,
        canManageUsers: true,
        canViewResponses: false,
      },
    });
    settingsOnlySession = await openSession(app(), settingsOnly.id, alpha.id);

    const viewOnly = await createRestrictedMember(prisma, alpha, {
      email: `view@${alpha.shortName.toLowerCase()}.example.org`,
      groupName: 'view-only',
      permissions: {
        canBuild: true,
        canExport: true,
        canManageSettings: false,
        canManageFormSettings: false,
        canManageUsers: true,
        canViewResponses: true,
      },
    });
    viewOnlySession = await openSession(app(), viewOnly.id, alpha.id);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await testApp?.close();
    await inbox?.close();
    await database?.release();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await prisma.tenant.updateMany({ data: { smtp: Prisma.DbNull } });
    await prisma.mailLog.deleteMany();
  });

  // -------------------------------------------------------------------------
  // The permission pair (mirrored from `SmtpConfigController`)
  // -------------------------------------------------------------------------

  it('refuses a caller who may manage settings but not view responses', async () => {
    const response = await testMail(settingsOnlySession);
    expect(response.status).toBe(403);
    expect(await prisma.mailLog.count()).toBe(0);
  });

  it('refuses a caller who may view responses but not manage settings', async () => {
    const response = await testMail(viewOnlySession);
    expect(response.status).toBe(403);
    expect(await prisma.mailLog.count()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // the evidence — the stored block, never a typed one
  // -------------------------------------------------------------------------

  it('accepts the empty document the button actually sends', async () => {
    const response = await testMail(adminSession, {});
    // Nothing is configured yet in this describe block's default state, so
    // the outcome is "not configured" — the point here is only that the
    // *schema* let the request through.
    expect(response.status).toBe(200);
    expect(parseTestMailResult(response.body as unknown).status).toBe('failed');
  });

  it('refuses a body that tries to carry a transport field — structurally', async () => {
    // Exactly the shape an unsaved draft of the *Mailversand*-Reiter would
    // hold — every field the indivisible block of the requirement knows, in one
    // request. `strictObject({})` refuses it on the first unrecognised key,
    // so one call already proves there is no field any of them could travel
    // in; a second call below checks the schema is not merely tolerant of a
    // *subset* by trying the single field a client would be most tempted to
    // add on its own — "which stored block", i.e. `source`.
    const withDraft = await testMail(adminSession, ownBlock());
    expect(withDraft.status).toBe(400);

    const withSourceOnly = await testMail(adminSession, { smtp: null });
    expect(withSourceOnly.status).toBe(400);

    // Refused at the schema, before a handler ran — no row, no attempt.
    expect(await prisma.mailLog.count()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Nothing configured — ADR-0013 no. 5's first row, never a `failed` row
  // -------------------------------------------------------------------------

  it('answers „nicht eingerichtet" without a connection or a mail_log row', async () => {
    const response = await testMail(adminSession);

    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({
      recipientEmail: adminEmail,
      status: 'failed',
      // **The organisation's sentence**, not the installation's (ADR-0023):
      // whoever presses here can enter something under *Mailversand*, and that
      // is exactly where the reason points.
      reason: TENANT_MAIL_NOT_CONFIGURED_REASON,
    });
    // Nothing was attempted, so nothing was queued either.
    expect(await prisma.mailLog.count()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // A broken stored block — never sent under the system's identity
  // -------------------------------------------------------------------------

  it('answers „unlesbar" for a mixed block, without a connection or a row', async () => {
    // A raw write past the write route's validation — the exact shape
    // `MailSecretsService.openTenantBlock` refuses (a document with none of
    // the required fields).
    await prisma.$executeRaw`UPDATE "tenant" SET smtp = '{"host":"mail.invalid"}'::jsonb WHERE id = ${alpha.id}::uuid`;

    const response = await testMail(adminSession);

    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({
      recipientEmail: adminEmail,
      status: 'failed',
      reason: MAIL_CONFIG_UNPARSABLE_REASON,
    });
    expect(await prisma.mailLog.count()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // SSRF hardening — a category, never the transport's own words
  // -------------------------------------------------------------------------

  it("tells the admin what to fix, never which of the server's own ports are open", async () => {
    const written = await put(adminSession, ownBlock({ port: 1, auth: null }));
    expect(written.status).toBe(200);

    const response = await testMail(adminSession);
    const result = parseTestMailResult(response.body as unknown);

    expect(response.status).toBe(200);
    expect(result.recipientEmail).toBe(adminEmail);
    expect(result.status).toBe('failed');
    // Readable and actionable …
    expect(result.reason).toBe(MAIL_CATEGORY_UNREACHABLE);
    // … and *not* the remote's transcript: "ECONNREFUSED" or the port tried
    // would tell an open port from a closed one (a security review finding).
    expect(result.reason).not.toContain('ECONNREFUSED');
    expect(result.reason).not.toContain('127.0.0.1');
    expect(result.reason).not.toContain(':1');

    // The attempt is still a genuine one — a `mail_log` row records it.
    const row = await prisma.mailLog.findFirstOrThrow({
      where: { tenantId: alpha.id },
    });
    expect(row.status).toBe('failed');
    expect(row.lastError).toBe(MAIL_CATEGORY_UNREACHABLE);
    expect(row.recipient).toBe(adminEmail);
    // A refused attempt is still an attempt *under* an identity, and the
    // failing row is the one an admin reads first (the requirement). The
    // service writes the columns in both arms; without this the "failed" arm
    // could be deleted with nothing going red.
    expect(row.senderIdentity).toBe('own');
    expect(row.senderAddress).toBe('post@organisation.invalid');
  });

  // -------------------------------------------------------------------------
  // The row exists before anything dials (a review finding)
  // -------------------------------------------------------------------------

  it('has committed the mail_log row by the time the transport is asked', async () => {
    // The property the proof stands on: "the mail is out, there is no
    // row" must be unreachable. It was reachable while the insert, the send
    // and the status write shared one interactive transaction — a failing
    // `update`, or a process that died after `send()`, rolled the insert back
    // with it.
    //
    // Counted from **outside** that would-be transaction: this `count` runs on
    // its own pool connection, so it sees the row only if it is committed. With
    // the insert back inside a transaction the answer here is zero, and this
    // test is the only thing in the file that notices.
    expect((await put(adminSession, ownBlock())).status).toBe(200);

    let rowsDuringSend = -1;
    vi.spyOn(app().app.get(MailTransport), 'send').mockImplementation(
      async () => {
        rowsDuringSend = await prisma.mailLog.count({
          where: { tenantId: alpha.id },
        });
      },
    );

    const response = await testMail(adminSession);

    expect(response.status).toBe(200);
    expect(parseTestMailResult(response.body as unknown).status).toBe('sent');
    expect(rowsDuringSend).toBe(1);

    // And the reservation that keeps the worker off the row while it is in
    // flight is cleared once the outcome is written.
    const row = await prisma.mailLog.findFirstOrThrow({
      where: { tenantId: alpha.id },
    });
    expect(row.status).toBe('sent');
    expect(row.nextAttemptAt).toBeNull();
  });

  // -------------------------------------------------------------------------
  // The real path, the marking, the recipient — and both sending identities
  // -------------------------------------------------------------------------

  describe('a real send under each of the two identities', () => {
    // Closed in the outer `afterAll`, after the app — see the outer `inbox`
    // declaration for why the order matters.
    beforeAll(async () => {
      inbox = await startSmtpInbox();
      // The base address of the installation — it is the level the chain of
      // this organisation falls back to (it has none of its own). Without it
      // there would be no link in the footer, and the case below would check
      // nothing.
      await configureSystemMail(app(), {
        publicBaseUrl: TEST_PUBLIC_BASE_URL,
      });
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      // The installation's block is written by the system-arm test below and
      // must not survive it: the outer `afterEach` clears the *organisation's* column,
      // and an organisation that inherits from a configured installation is no longer
      // the "nothing configured" state the tests after this describe rely on.
      await configureSystemMail(app(), { smtp: null });
    });

    it(
      'sends to the caller over real SMTP, marks the row, and leaves the ' +
        'configured recipient list untouched',
      async () => {
        // The inbox requires a login (`authOptional: false`), like most real
        // relays — `auth: null` is for the port-refusal scenario above, not
        // this one.
        const written = await put(
          adminSession,
          ownBlock({
            port: box().port,
            auth: { user: 'Organisation', password: 'test-password-1!' },
          }),
        );
        expect(written.status).toBe(200);

        // The key the transport is handed — see the file's doc for why the
        // arrival of the mail alone cannot see a swapped branch.
        const sendSpy = vi.spyOn(app().app.get(MailTransport), 'send');

        // A mail already waiting for the office's own list — the scenario
        // the evidence names by name. It must still be there, unsent and
        // unchanged, once the Testmail is done.
        const officeRow = await prisma.mailLog.create({
          data: {
            tenantId: alpha.id,
            recipient: 'buero@example.invalid',
            subject: 'Anmeldung eingegangen',
            status: 'queued',
          },
        });

        const response = await testMail(adminSession);

        expect(response.status).toBe(200);
        expect(response.body).toStrictEqual({
          recipientEmail: adminEmail,
          status: 'sent',
          reason: null,
        });

        // the evidence — a real SMTP conversation happened, over the organisation's own
        // block: its sender address, its login, and its **own** cache slot.
        expect(box().messages).toHaveLength(1);
        expect(box().messages[0]?.to).toStrictEqual([adminEmail]);
        expect(box().messages[0]?.from).toBe('post@organisation.invalid');
        expect(sendSpy.mock.calls.at(-1)?.[1].key).toBe(alpha.id);

        // the evidence — never the configured list, in any row.
        const bueroRows = await prisma.mailLog.findMany({
          where: { recipient: 'buero@example.invalid' },
        });
        expect(bueroRows).toHaveLength(1);
        expect(bueroRows[0]?.id).toBe(officeRow.id);
        expect(bueroRows[0]?.status).toBe('queued');

        // The new row: addressed to the caller, marked, sent.
        const rows = await prisma.mailLog.findMany({
          where: { tenantId: alpha.id, id: { not: officeRow.id } },
        });
        expect(rows).toHaveLength(1);
        const [testRow] = rows;
        expect(testRow?.recipient).toBe(adminEmail);
        expect(testRow?.status).toBe('sent');
        expect(testRow?.sentAt).not.toBeNull();
        // the evidence — the marking.
        expect(testRow?.subject).toBe(EXPECTED_TEST_MAIL_SUBJECT);
        // The row is committed and complete: nothing about it is left waiting.
        expect(testRow?.nextAttemptAt).toBeNull();

        // The requirement on **this** route: "which mail server did the
        // Testmail go over" is the question the button exists to answer, and until the
        // review of this package nothing in this file named the two columns —
        // deleting both writes in `test-mail.service.ts` left it green. The
        // address is compared against what the inbox really saw, so this cannot
        // pass by recomputing the configuration a second time.
        expect(testRow?.senderIdentity).toBe('own');
        expect(testRow?.senderAddress).toBe('post@organisation.invalid');
        expect(testRow?.senderAddress).toBe(box().messages[0]?.from);

        /*
         * **The footer with the link into the system — in both versions.**
         *
         * Measured on the argument handed to the transport and not on the DATA
         * body in the mailbox: the plain text version goes out there as
         * quoted-printable and can wrap a long line in the middle of the
         * address. What is checked here is what this route hands to the
         * transport.
         *
         * The organisation variant carries the mark **of the organisation** —
         * its Testmail goes out over its own mail server (ADR-0023),
         * and the footer points to where its forms are.
         *
         * ⚠️ The stored body stays **without** an envelope, as with every
         * other row: the detail view of the mail log adds it when
         * displaying.
         */
        const outgoing = sendSpy.mock.calls.at(-1)?.[0];
        expect(outgoing?.text).toContain(
          `Formulare von „Organisation ${alpha.shortName}": ${TEST_PUBLIC_BASE_URL}`,
        );
        expect(outgoing?.html).toContain(`href="${TEST_PUBLIC_BASE_URL}"`);
        expect(testRow?.bodyText).not.toContain(TEST_PUBLIC_BASE_URL);
      },
    );
    // -----------------------------------------------------------------------
    // Since ADR-0023 the system arm no longer lies on this route
    // -----------------------------------------------------------------------

    /*
     * Two cases stood here: "sends over the installation's block when the
     * organisation inherits" and "categorises a refusal of the
     * installation's server as well". Both presupposed the inheritance — an
     * organisation with an empty column whose mail goes out over the
     * installation. That no longer exists (ADR-0023): an organisation without
     * a mail server of its own sends nothing, and this route no longer sees
     * the installation's block at all.
     *
     * The system arm is thereby not unchecked, it has **moved**: it
     * belongs to the superadmin route, and both proofs lie there —
     * identity, sender address, shared cache key and the category
     * instead of the wording (`test-mail-recipient.spec.ts`).
     */
  });

  // -------------------------------------------------------------------------
  // The rate limit — the second, named half of the SSRF hardening
  // (ADR-0013 "Consequences", a review finding)
  // -------------------------------------------------------------------------

  /**
   * **Declared last on purpose, and the file's press budget is accounted for
   * here.** The limit is ten a minute per client address, the whole file runs
   * inside one such minute, and the tests above press exactly ten times (one
   * each, plus two for the two refused bodies). This burst then exhausts the
   * bucket for the rest of the minute, so anything declared after it would be
   * answered 429 instead of doing its own work — and a *new* test that presses
   * has to be counted into the ten, or it takes a press this file already
   * needs. Vitest runs tasks in declaration order, which is what makes "last"
   * mean last.
   *
   * At this point the organisation again has no mail server (the
   * nested `afterEach` has emptied the block), so every allowed
   * press answers out of the "nothing configured" arm: no
   * connection, no row, and eleven requests well within the
   * sixty-second window.
   */
  it('refuses the eleventh press within the minute', async () => {
    const statuses: number[] = [];
    for (let press = 0; press <= TEST_MAIL_PRESSES_PER_MINUTE; press += 1) {
      // Sequential, not `Promise.all`: the assertion is about a *count* over a
      // window, and parallel requests would be counted in an order this test
      // does not control.
      const response = await testMail(adminSession);
      statuses.push(response.status);
    }

    // The last one is refused — with the throttle removed, nothing here is.
    expect(statuses.at(-1)).toBe(429);
    // …and no more than the budget ever got through, however much of it the
    // tests above had already spent.
    expect(
      statuses.filter((status) => status !== 429).length,
    ).toBeLessThanOrEqual(TEST_MAIL_PRESSES_PER_MINUTE);

    // A refusal costs nothing: no attempt, no row, no connection.
    expect(await prisma.mailLog.count()).toBe(0);
  });
});
