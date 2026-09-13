import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { parseTestMailResult, type SmtpBlock } from '@formsache/shared';

import { MAIL_CATEGORY_UNREACHABLE } from '../../src/mail/mail-error-category';
import { MailSecretsService } from '../../src/mail/mail-secrets.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import {
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
import { startSmtpInbox, type SmtpInbox } from '../support/smtp-inbox';

/**
 * **The two test-mail findings, on the wire** — finding 29a (a variant
 * on the system level) and 29b (a differing recipient).
 *
 * ## Why a file of its own next to `test-mail.spec.ts`
 *
 * Not out of convenience: `TEST_MAIL_RATE_LIMIT` is ten presses per minute
 * and origin address, and the neighbouring file works out its budget in a
 * paragraph of its own — "the tests above press exactly ten times". Every test
 * that one adds there takes one of those ten presses away and breaks the
 * proof about the limit itself. A file of its own brings its own
 * application and thus its own counter with it; the rate limit itself is and
 * stays proven over there.
 *
 * ## What is proven here — and what the **forbidden** case is
 *
 * 1. **The differing recipient arrives, and the row names it.** Without the
 *    second half, the attributability with which the continuation argues at the
 *    docblock of `TestMailController` would be an assertion.
 * 2. **What is not an address is rejected** — 400, and no row. The
 *    recipient is free, not unchecked.
 * 3. **A transport field still does not get through.** The part of the old
 *    justification that carries: the free *host* is excluded as before.
 * 4. **The system route is reserved for superadmins** — the forbidden case:
 *    an organisation admin with `canManageSettings` **and**
 *    `canViewResponses`, that is, with everything the organisation route next door
 *    demands, fails here with 403 and leaves no row behind.
 * 5. **The system route takes the system block, even when the organisation
 *    has one of its own.** That is the whole purpose of finding 29a: before,
 *    one could only check the installation's block over an organisation
 *    that happened to be inheriting at that moment.
 */

const SETUP_TIMEOUT_MS = 180_000;
const TENANT_TEST_MAIL_PATH = '/tenant/smtp/test';
const SYSTEM_TEST_MAIL_PATH = '/admin/system-settings/mail/test';

describe('Testmail — abweichender Empfänger und Systemebene', () => {
  let database: TestDatabase | undefined;
  let testApp: TestApp | undefined;
  let prisma: PrismaService;
  let inbox: SmtpInbox | undefined;

  let alpha: TenantFixture;
  let adminSession: string;
  let adminEmail: string;
  let superadminSession: string;
  let superadminEmail: string;

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

  function post(
    path: string,
    session: string,
    body: unknown = {},
  ): request.Test {
    return request(app().server)
      .post(apiPath(path))
      .set(authedMutation(session))
      .send(body as object);
  }

  /** This organisation's own block, pointed at the inbox. */
  async function giveTenantItsOwnBlock(): Promise<void> {
    const secrets = app().app.get(MailSecretsService);
    await prisma.tenant.update({
      where: { id: alpha.id },
      data: {
        smtp: secrets.sealTenantBlock(
          {
            host: '127.0.0.1',
            port: box().port,
            secure: false,
            from: 'post@organisation.invalid',
            auth: {
              user: 'Organisation',
              password: { kind: 'typed', value: 'test-password-1!' },
            },
          },
          alpha.id,
        ) as Prisma.InputJsonValue,
      },
    });
  }

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });
    prisma = testApp.prisma;
    inbox = await startSmtpInbox();

    // Without an entered mail server: the cases that need one set it
    // themselves (`giveTenantItsOwnBlock`), and the system route must not look
    // at it anyway (ADR-0023).
    alpha = await createTenant(prisma, `TR${randomUUID().slice(0, 6)}`, null);

    adminEmail = `admin@${alpha.shortName.toLowerCase()}.example.org`;
    const admin = await createUser(prisma, {
      email: adminEmail,
      password: 'test-password',
      tenants: [alpha],
    });
    adminSession = await openSession(app(), admin.id, alpha.id);

    // Superadmin **and** member of the same organisation: the system route
    // needs a scope, because the log row belongs to an organisation
    // (`SystemTestMailController` writes that out).
    superadminEmail = `super@${alpha.shortName.toLowerCase()}.example.org`;
    const superadmin = await createUser(prisma, {
      email: superadminEmail,
      password: 'test-password',
      tenants: [alpha],
      isSuperadmin: true,
    });
    superadminSession = await openSession(app(), superadmin.id, alpha.id);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await testApp?.close();
    await inbox?.close();
    await database?.release();
  });

  afterEach(async () => {
    await prisma.tenant.updateMany({ data: { smtp: Prisma.DbNull } });
    await prisma.mailLog.deleteMany();
    await configureSystemMail(app(), { smtp: null });
  });

  /**
   * How many mails the inbox has seen **since the beginning of this case**.
   *
   * `SmtpInbox.messages` is deliberately `readonly` and is not emptied between
   * the cases (`smtp-inbox.ts`), so counting is relative here instead of
   * absolute. That is also the more honest assurance: "exactly one mail **has
   * been added**" hits the statement, "in total there is one there" would hang on
   * the ordering of the cases.
   */
  function since(
    mark: number,
  ): readonly { from: string; to: readonly string[] }[] {
    return box().messages.slice(mark);
  }

  // -------------------------------------------------------------------------
  // Finding 29b — the differing recipient
  // -------------------------------------------------------------------------

  it('schickt an die genannte Adresse und schreibt sie in die Protokollzeile', async () => {
    await giveTenantItsOwnBlock();
    const mark = box().messages.length;
    const elsewhere = 'jemand.anderes@example.invalid';

    const response = await post(TENANT_TEST_MAIL_PATH, adminSession, {
      recipientEmail: elsewhere,
    });

    expect(response.status).toBe(200);
    expect(parseTestMailResult(response.body as unknown)).toStrictEqual({
      recipientEmail: elsewhere,
      status: 'sent',
      reason: null,
    });

    // Really there — and explicitly **not** additionally to one's own
    // address: "one request, one recipient" is the property that keeps the
    // free recipient from becoming a distribution list.
    expect(since(mark)).toHaveLength(1);
    expect(since(mark)[0]?.to).toStrictEqual([elsewhere]);

    // The trace with which the continuation argues: the attempt stands in the
    // delivery log, **with this address**.
    const rows = await prisma.mailLog.findMany({
      where: { tenantId: alpha.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.recipient).toBe(elsewhere);
  });

  it('nimmt die Adresse aus der Sitzung, wenn die Anfrage keine nennt', async () => {
    await giveTenantItsOwnBlock();
    const mark = box().messages.length;

    const response = await post(TENANT_TEST_MAIL_PATH, adminSession, {});

    expect(response.status).toBe(200);
    expect(parseTestMailResult(response.body as unknown).recipientEmail).toBe(
      adminEmail,
    );
    expect(since(mark)[0]?.to).toStrictEqual([adminEmail]);
  });

  it('weist zurück, was keine Adresse ist — ohne Zeile und ohne Verbindung', async () => {
    await giveTenantItsOwnBlock();
    const mark = box().messages.length;

    for (const value of ['kein-empfaenger', 'a@b.de, c@d.de', '']) {
      const response = await post(TENANT_TEST_MAIL_PATH, adminSession, {
        recipientEmail: value,
      });
      expect(response.status, `„${value}" durfte nicht durchkommen`).toBe(400);
    }

    expect(since(mark)).toHaveLength(0);
    expect(await prisma.mailLog.count()).toBe(0);
  });

  it('lässt weiterhin kein Transportfeld herein — auch nicht neben einer gültigen Adresse', async () => {
    // The part of the old justification that carries: the recipient has become
    // free, the **host** has not. Checked next to a valid address, because
    // exactly that would be the shape in which a field attaches itself.
    const response = await post(TENANT_TEST_MAIL_PATH, adminSession, {
      recipientEmail: 'jemand@example.invalid',
      host: '169.254.169.254',
      port: 80,
    });

    expect(response.status).toBe(400);
    expect(await prisma.mailLog.count()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Finding 29a — the system level
  // -------------------------------------------------------------------------

  it('verweigert die Systemroute einem Organisationsadmin, der alles darf, was die Organisationsroute verlangt', async () => {
    // ⚠️ The forbidden access. `adminSession` belongs to the `admin` group
    // of this organisation, thus holds `canManageSettings` and
    // `canViewResponses` — and gets through on `/tenant/smtp/test` next door.
    // Not here: no organisation decides about the installation's mail
    // server.
    const mark = box().messages.length;
    const refused = await post(SYSTEM_TEST_MAIL_PATH, adminSession, {});
    expect(refused.status).toBe(403);
    expect(await prisma.mailLog.count()).toBe(0);
    expect(since(mark)).toHaveLength(0);

    // The counter-check in the same assurance: the same body, the same
    // route, a superadmin — otherwise the refusal above would only prove that the
    // route is broken.
    const allowed = await post(SYSTEM_TEST_MAIL_PATH, superadminSession, {});
    expect(allowed.status).toBe(200);
  });

  it('prüft den Block der Installation, auch wenn die Organisation einen eigenen hat', async () => {
    // Both blocks point at the same inbox, but differ
    // in the sender address — by that, and only by that, is it readable which
    // block was really selected.
    await giveTenantItsOwnBlock();
    const systemBlock: SmtpBlock = {
      host: '127.0.0.1',
      port: box().port,
      secure: false,
      auth: { user: 'installation', password: 'test-password-2!' },
      from: 'post@installation.invalid',
    };
    await configureSystemMail(app(), { smtp: systemBlock });
    const mark = box().messages.length;

    const response = await post(SYSTEM_TEST_MAIL_PATH, superadminSession, {});

    expect(response.status).toBe(200);
    expect(parseTestMailResult(response.body as unknown).status).toBe('sent');
    expect(since(mark)).toHaveLength(1);
    // ⚠️ The one line that finding 29a is about: **not**
    // `post@organisation.invalid`. Before, there was no way to check that
    // without looking for an inheriting organisation.
    expect(since(mark)[0]?.from).toBe('post@installation.invalid');

    const rows = await prisma.mailLog.findMany({
      where: { tenantId: alpha.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.senderIdentity).toBe('system');
    expect(rows[0]?.senderAddress).toBe('post@installation.invalid');
    // Even after the sending the row still says over whom it went — on that
    // hangs that „↻ Erneut" in the delivery log chooses the same block.
    expect(rows[0]?.trigger).toBe('system');
  });

  it('nimmt auf der Systemroute ebenfalls eine abweichende Adresse', async () => {
    await configureSystemMail(app(), {
      smtp: {
        host: '127.0.0.1',
        port: box().port,
        secure: false,
        auth: { user: 'installation', password: 'test-password-2!' },
        from: 'post@installation.invalid',
      },
    });
    const elsewhere = 'betrieb@example.invalid';
    const mark = box().messages.length;

    const response = await post(SYSTEM_TEST_MAIL_PATH, superadminSession, {
      recipientEmail: elsewhere,
    });

    expect(response.status).toBe(200);
    expect(parseTestMailResult(response.body as unknown).recipientEmail).toBe(
      elsewhere,
    );
    expect(since(mark)[0]?.to).toStrictEqual([elsewhere]);
  });

  /**
   * **The instance's mail server is categorised too, never passed through
   * verbatim** (ADR-0013 „Consequences", a security finding; since
   * ADR-0023 here and no longer on the organisation route).
   *
   * The system arm once passed `describeMailError` through — that redacts
   * user and password, but **not host and port**. On a button that would read
   * `connect ECONNREFUSED 10.8.0.12:587` or a `535` naming the installation's
   * internal relay. The wording belongs in
   * `mail_log.last_error`, where the operator of this host reads — not in an
   * answer that dials an arbitrary machine on request.
   */
  it('kategorisiert eine Ablehnung des Instanz-Servers, ohne dessen Adresse zu nennen', async () => {
    await configureSystemMail(app(), {
      smtp: {
        host: '127.0.0.1',
        // Port 1: nothing is listening, the refusal comes back immediately.
        port: 1,
        secure: false,
        auth: { user: 'installation', password: 'test-password-2!' },
        from: 'post@installation.invalid',
      },
    });
    const before = await prisma.mailLog.count();

    const response = await post(SYSTEM_TEST_MAIL_PATH, superadminSession, {});
    const result = parseTestMailResult(response.body as unknown);

    expect(response.status).toBe(200);
    expect(result.status).toBe('failed');
    expect(result.reason).toBe(MAIL_CATEGORY_UNREACHABLE);
    expect(result.reason).not.toContain('ECONNREFUSED');
    expect(result.reason).not.toContain('127.0.0.1');
    expect(result.reason).not.toContain(':1');

    // The same sentence at the row — nothing verbatim stays standing anywhere
    // where the caller of this route can read it. And the row says under
    // which identity it failed: that of the installation.
    const rows = await prisma.mailLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 1,
    });
    expect(await prisma.mailLog.count()).toBe(before + 1);
    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.lastError).toBe(MAIL_CATEGORY_UNREACHABLE);
    expect(rows[0]?.senderIdentity).toBe('system');
    expect(rows[0]?.senderAddress).toBe('post@installation.invalid');
  });
});
