import { randomBytes } from 'node:crypto';

import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SmtpBlock } from '@formsache/shared';

import { MailIdentityService } from '../../src/mail/mail-identity.service';
import {
  MAIL_CONFIG_UNPARSABLE_REASON,
  MAIL_PASSWORD_UNREADABLE_REASON,
  MailSecretsService,
} from '../../src/mail/mail-secrets.service';
import { TENANT_MAIL_NOT_CONFIGURED_REASON } from '../../src/mail/mail-transport';
import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import {
  configureSystemMail,
  createTestApp,
  type TestApp,
} from '../support/create-test-app';
import { createTenant, type TenantFixture } from '../support/fixtures';
import { SmtpDouble } from '../support/smtp-double';

/**
 * **Fail closed, against a real column** (the requirements, ADR-0013
 * no. 4 and no. 5).
 *
 * The unit half of this lives in `src/mail/mail-identity.service.spec.ts` and
 * hands documents to the service directly. What only *this* file can do is
 * start from the place the danger actually comes from: a **raw write** into
 * `tenant.smtp`. A mixed block is not a payload anybody can send — the union
 * refuses it at every route — so the only way it exists is `UPDATE … SET smtp`,
 * and a suite that built it any other way would be testing a state the
 * application can reach rather than the one it cannot.
 *
 * ## What the system transport is doing in here
 *
 * `SmtpDouble` is bound as `MailTransport` and it **works** — it accepts every
 * mail it is handed and counts them. That is the arrangement ADR-0013 no. 4
 * insists on: „die Mail ging nicht raus" stays green when the fallback is
 * broken too, so the fallback has to be in working order and the counter has to
 * be the assertion.
 *
 * ⚠️ **And here is the honest limit of this file.** The counter it reads is 0
 * because *the resolution knows no transport at all* — which is the property
 * this suite rests on, but it is not yet the end-to-end proof the requirement describes.
 * That one reads the counter after a **worker run**, and the worker
 * (`mail-worker.service.ts`, `mail-transport.ts`) belongs to a package that
 * is building the per-Organisation transports in parallel. The three arms are ready for
 * it; what is missing is the caller. This is stated rather than papered over,
 * because a test that looked like the requirement and measured less would be
 * worse than a named gap.
 */

const SETUP_TIMEOUT_MS = 180_000;

/** A password per run — a fixed one either collides or proves nothing. */
function mintPassword(prefix: string): string {
  return `${prefix}!${randomBytes(9).toString('hex')}`;
}

const SYSTEM_HOST = 'mail.installation.invalid';
const OWN_HOST = 'mail.organisation.invalid';

const systemBlock = (password: string): SmtpBlock => ({
  host: SYSTEM_HOST,
  port: 587,
  secure: false,
  auth: { user: 'installation', password },
  from: 'post@installation.invalid',
});

describe('the sending identity, resolved against a real column', () => {
  let database: TestDatabase | undefined;
  let testApp: TestApp | undefined;
  let prisma: PrismaService;
  let Organisation: TenantFixture;
  /** The **working** installation transport whose counter must stay at 0. */
  let systemTransport: SmtpDouble;
  let systemPassword: string;

  function app(): TestApp {
    if (testApp === undefined) {
      throw new Error('no test app');
    }
    return testApp;
  }

  function identities(): MailIdentityService {
    return app().app.get(MailIdentityService);
  }

  function secrets(): MailSecretsService {
    return app().app.get(MailSecretsService);
  }

  /**
   * The organisation's stored column, straight from the row.
   *
   * `findUniqueOrThrow` rather than `findUnique`, and the return type is the
   * column's own rather than `unknown`: a `mail_log` row without a tenant does
   * not exist, so a missing row is a defect and not "inherits from the system".
   * The distinction is load-bearing since `resolve` was narrowed — an absent
   * column reads as `{ source: 'system' }`, which would send an organisation's mail
   * under the installation's identity (a review finding).
   */
  async function storedOf(tenantId: string): Promise<Prisma.JsonValue> {
    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { smtp: true },
    });
    return tenant.smtp;
  }

  async function resolveOf(
    tenantId: string,
  ): ReturnType<MailIdentityService['resolve']> {
    return identities().resolve(
      {
        id: tenantId,
        smtp: await storedOf(tenantId),
      },
      'tenant',
    );
  }

  /** The only way a mixed block exists: past every route. */
  async function writeRaw(tenantId: string, document: unknown): Promise<void> {
    await prisma.$executeRaw`
      UPDATE "tenant" SET smtp = ${JSON.stringify(document)}::jsonb
       WHERE id = ${tenantId}::uuid`;
  }

  beforeAll(async () => {
    database = await acquireTestDatabase();
    systemTransport = new SmtpDouble();
    systemPassword = mintPassword('system');
    testApp = await createTestApp({
      databaseUrl: database.url,
      transport: systemTransport,
      systemMail: { smtp: systemBlock(systemPassword) },
    });
    prisma = testApp.prisma;
    Organisation = await createTenant(prisma, 'IDENT');
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await testApp?.close();
    await database?.release();
  });

  beforeEach(async () => {
    // Every case starts from „diese Organisation hat keinen Mailserver", so a
    // document one case wrote cannot decide the next one's outcome.
    // `Prisma.DbNull`, not `null`: for a nullable JSON column the two mean
    // different things to Prisma, and only this one clears it.
    await prisma.tenant.update({
      where: { id: Organisation.id },
      data: { smtp: Prisma.DbNull },
    });
    await configureSystemMail(app(), { smtp: systemBlock(systemPassword) });
  });

  // -------------------------------------------------------------------------
  // The three arms, from the column
  // -------------------------------------------------------------------------

  /**
   * ⚠️ **The reproduction of the abolished inheritance — against a real
   * column** (ADR-0023).
   *
   * The system block is **set up and in working order** in this `beforeEach`,
   * and that is the whole sharpness of the case: if there still were a fallback,
   * it would be available here and the answer would be `send`/`system`. It is
   * `withhold`, with the sentence the organisation reads.
   *
   * „Nothing set up" thereby stays **no** `failed` (ADR-0013 no. 5, first line):
   * nothing was attempted, nothing refused, and a mail server entered next week
   * sends the row.
   */
  it('withholds when the organisation has no mail server — even though the installation has one', async () => {
    const resolved = await resolveOf(Organisation.id);

    expect(resolved).toStrictEqual({
      kind: 'withhold',
      reason: TENANT_MAIL_NOT_CONFIGURED_REASON,
    });
    // Nothing of the installation got into the answer — no host, no password,
    // no block.
    const answer = JSON.stringify(resolved);
    expect(answer).not.toContain(SYSTEM_HOST);
    expect(answer).not.toContain(systemPassword);
    // And the working system transport was not asked.
    expect(systemTransport.attemptCount).toBe(0);
  });

  /**
   * The same state without any mail server at all — the fresh installation. Here
   * too `withhold` and not `failed`.
   */
  it('withholds when nothing at all is set up', async () => {
    await prisma.$executeRaw`UPDATE "system_setting" SET smtp = NULL`;

    expect(await resolveOf(Organisation.id)).toStrictEqual({
      kind: 'withhold',
      reason: TENANT_MAIL_NOT_CONFIGURED_REASON,
    });
  });

  /**
   * The **system arm** keeps reading the block of the installation — and only
   * that one. Without this case „`'system'` does not see the organisation's
   * column" would be a claim without a measurement.
   */
  it('resolves the installation’s block for the system arm, never the organisation’s', async () => {
    await writeRaw(Organisation.id, {
      host: OWN_HOST,
      port: 465,
      secure: true,
      auth: null,
      from: 'post@organisation.invalid',
    });

    const resolved = await identities().resolve(
      { id: Organisation.id, smtp: await storedOf(Organisation.id) },
      'system',
    );

    expect(resolved.kind).toBe('send');
    expect(resolved.kind === 'send' ? resolved.source : null).toBe('system');
    expect(resolved.kind === 'send' ? resolved.block.host : null).toBe(
      SYSTEM_HOST,
    );
    expect(
      resolved.kind === 'send' ? resolved.block.auth?.password : null,
    ).toBe(systemPassword);
  });

  // -------------------------------------------------------------------------
  // The requirement — a mixed block is refused, not half used
  // -------------------------------------------------------------------------

  /**
   * **The dangerous mixture, written straight into the column**: an own sender
   * address on the installation's transport. Signed, technically flawless post
   * from `vorstand@example.org` — identity forgery carrying the installation's
   * own SPF/DKIM authorisation (ADR-0013 no. 2).
   *
   * It is refused, and the refusal is total: no host, no address and no
   * password of the installation appears anywhere in the answer.
   */
  it('refuses a mixed block instead of completing it from the system', async () => {
    await writeRaw(Organisation.id, {
      from: 'vorstand@example.org',
    });

    const resolved = await resolveOf(Organisation.id);

    expect(resolved).toStrictEqual({
      kind: 'fail',
      reason: MAIL_CONFIG_UNPARSABLE_REASON,
    });
    // Nothing of the installation leaked into the answer — the arm carries no
    // block at all, so there is nothing for a caller to send with.
    const answer = JSON.stringify(resolved);
    expect(answer).not.toContain(SYSTEM_HOST);
    expect(answer).not.toContain(systemPassword);
    // The working system transport was not asked. See the file's own caveat:
    // this reads 0 because the resolution knows no transport — the end-to-end
    // counter after a worker run belongs to the mail worker's own suite.
    expect(systemTransport.attemptCount).toBe(0);
  });

  it('refuses a block that names a source it does not fill', async () => {
    // `secure` missing — the one field a „sensible default" would invent, and
    // the one that decides whether this mail is encrypted from the first byte.
    await writeRaw(Organisation.id, {
      host: OWN_HOST,
      port: 465,
      auth: null,
      from: 'post@organisation.invalid',
    });

    expect((await resolveOf(Organisation.id)).kind).toBe('fail');
  });

  it('refuses a block whose password was sealed for the installation', async () => {
    // The system block, verbatim, in an organisation's column — a raw write no route can
    // make. The holder segment of the AAD („system" against „tenant-smtp") is
    // what refuses it.
    const stored = await prisma.systemSetting.findFirstOrThrow({
      select: { smtp: true },
    });
    const block = stored.smtp as Record<string, unknown>;
    await writeRaw(Organisation.id, block);

    expect(await resolveOf(Organisation.id)).toStrictEqual({
      kind: 'fail',
      reason: MAIL_PASSWORD_UNREADABLE_REASON,
    });
    expect(systemTransport.attemptCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // The requirement — no fallback to the installation's block
  // -------------------------------------------------------------------------

  /**
   * An organisation whose own mail server is a name that cannot resolve — the shape of
   * „jede Verbindung wird verweigert". The installation's block is configured
   * and its transport works, so a fallback would be *available*; the resolution
   * hands back the organisation's own block and only that.
   *
   * What this cannot show is what happens **after** the connection is refused,
   * because refusing one needs a transport. That half belongs to the mail worker's own suite.
   */
  it('answers with the organisation’s own block, never the installation’s', async () => {
    const password = mintPassword('Organisation');
    await prisma.tenant.update({
      where: { id: Organisation.id },
      data: {
        smtp: secrets().sealTenantBlock(
          {
            host: OWN_HOST,
            port: 465,
            secure: true,
            from: 'post@organisation.invalid',
            auth: {
              user: 'Organisation',
              password: { kind: 'typed', value: password },
            },
          },
          Organisation.id,
        ),
      },
    });

    const resolved = await resolveOf(Organisation.id);

    expect(resolved.kind).toBe('send');
    expect(resolved.kind === 'send' ? resolved.source : null).toBe('own');
    expect(resolved.kind === 'send' ? resolved.block.host : null).toBe(
      OWN_HOST,
    );
    expect(resolved.kind === 'send' ? resolved.block.from : null).toBe(
      'post@organisation.invalid',
    );
    expect(
      resolved.kind === 'send' ? resolved.block.auth?.password : null,
    ).toBe(password);
    // The control that makes the case mean something: the installation really
    // does have a usable block right now, so „kein Rückfall" is a decision and
    // not the absence of an alternative. Since ADR-0023 this no longer becomes a
    // second `send`, but the counter-check over the **system arm** — only it is
    // still allowed to see the block of the installation.
    const viaSystem = await identities().resolve(
      { id: Organisation.id, smtp: await storedOf(Organisation.id) },
      'system',
    );
    expect(viaSystem.kind === 'send' ? viaSystem.block.host : null).toBe(
      SYSTEM_HOST,
    );
  });

  // -------------------------------------------------------------------------
  // The requirement — the column holds no plaintext
  // -------------------------------------------------------------------------

  it('stores the organisation’s password sealed, in no spelling readable', async () => {
    const password = mintPassword('sealed');
    await prisma.tenant.update({
      where: { id: Organisation.id },
      data: {
        smtp: secrets().sealTenantBlock(
          {
            host: OWN_HOST,
            port: 587,
            secure: false,
            from: 'post@organisation.invalid',
            auth: {
              user: 'Organisation',
              password: { kind: 'typed', value: password },
            },
          },
          Organisation.id,
        ),
      },
    });

    const rows = await prisma.$queryRaw<{ row: string }[]>`
      SELECT to_jsonb(t)::text AS "row" FROM "tenant" t WHERE t.id = ${Organisation.id}::uuid`;
    const row = rows[0]?.row ?? '';

    // The control: we really are looking at the sealed token.
    expect(row).toContain('formsache1.');
    for (const [label, value] of [
      ['im Klartext', password],
      ['base64-kodiert', Buffer.from(password).toString('base64')],
      ['URL-kodiert', encodeURIComponent(password)],
    ] as const) {
      expect(row, `SMTP-Passwort ${label} in der tenant-Zeile`).not.toContain(
        value,
      );
    }
  });
});
