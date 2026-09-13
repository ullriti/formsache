import { randomBytes } from 'node:crypto';

import { ConsoleLogger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_OIDC_EMAIL_CLAIM,
  DEFAULT_OIDC_EMAIL_VERIFIED_CLAIM,
} from '@formsache/shared';

import { MailIdentityService } from '../../src/mail/mail-identity.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import { captureStdio } from '../mail/stdio-capture';
import {
  apiPath,
  createTestApp,
  TEST_PUBLIC_BASE_URL,
  type TestApp,
} from '../support/create-test-app';
import {
  createTenant,
  createUser,
  type TenantFixture,
} from '../support/fixtures';
import { authedMutation, cookieHeader, openSession } from '../support/http';

/**
 * **An organisation's SMTP password is a database secret** (ADR-0013
 * no. 6) — the third one of this application, and the same four proofs the
 * requirement asks for the OIDC client secret, applied to a value that lives in JSONB
 * rather than in a `Bytes` column.
 *
 * The load-bearing one is the last: the sealed value of Organisation A, carried into
 * the column of Organisation B by a raw write. No route, no service and no delegate can
 * do that — which is the point, because the boundary has to hold against
 * somebody who can write the column.
 */

const SETUP_TIMEOUT_MS = 180_000;

const SMTP_PATH = '/tenant/smtp';

/**
 * A password that cannot be found by accident.
 *
 * Random per run, because a fixed word either turns up somewhere by chance (a
 * red test that means nothing) or turns up nowhere for reasons unrelated to the
 * code (a green test that proves nothing). The punctuation makes the raw,
 * base64 and percent-encoded spellings differ from each other, and all three
 * are searched: a leak through an encoder is still a leak.
 */
function mintPassword(prefix: string): string {
  return `${prefix}!${randomBytes(12).toString('hex')}+/=`;
}

function spellings(secret: string): { label: string; value: string }[] {
  return [
    { label: 'im Klartext', value: secret },
    { label: 'base64-kodiert', value: Buffer.from(secret).toString('base64') },
    { label: 'URL-kodiert', value: encodeURIComponent(secret) },
  ];
}

/** The keys the requirement allows in the payload of an own block, and no others. */
/** The five fields of the block — since ADR-0023 without `source`. */
const OWN_PAYLOAD_KEYS = ['auth', 'from', 'host', 'port', 'secure'];
const AUTH_PAYLOAD_KEYS = ['passwordSet', 'user'];

describe('an organisation’s SMTP password', () => {
  let database: TestDatabase | undefined;
  let testApp: TestApp | undefined;
  let prisma: PrismaService;

  let alpha: TenantFixture;
  let beta: TenantFixture;
  let alphaSession: string;
  let betaSession: string;

  function app(): TestApp {
    if (testApp === undefined) {
      throw new Error('no test app');
    }
    return testApp;
  }

  async function configure(session: string, password: string): Promise<void> {
    const response = await request(app().server)
      .put(apiPath(SMTP_PATH))
      .set(authedMutation(session))
      .send({
        smtp: {
          host: 'mail.organisation.invalid',
          port: 587,
          secure: false,
          from: 'post@organisation.invalid',
          auth: { user: 'Organisation', password },
        },
      });
    expect(response.status).toBe(200);
  }

  /** The whole `tenant` row as text — every column, not the one we expected. */
  async function rawTenant(tenantId: string): Promise<string> {
    const rows = await prisma.$queryRaw<{ row: string }[]>`
      SELECT to_jsonb(t)::text AS "row" FROM "tenant" t WHERE t.id = ${tenantId}::uuid`;
    return rows[0]?.row ?? '';
  }

  /** The stored document of one organisation, as JSON. */
  async function storedOf(tenantId: string): Promise<Prisma.JsonValue> {
    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { smtp: true },
    });
    return tenant.smtp;
  }

  async function resolve(
    tenantId: string,
  ): ReturnType<MailIdentityService['resolve']> {
    return app()
      .app.get(MailIdentityService)
      .resolve({ id: tenantId, smtp: await storedOf(tenantId) }, 'tenant');
  }

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({
      databaseUrl: database.url,
      // The installation's own address is a **row**. The OIDC route
      // this suite uses for its last case builds a `redirect_uri` from it and
      // answers 503 without one — deliberately, and nothing to do with mail.
      // No `smtp` here: what an organisation stores is what this file is about.
      systemMail: { publicBaseUrl: TEST_PUBLIC_BASE_URL },
      // A real logger, not `@nestjs/testing`'s silent one: the log proof
      // counts on seeing what the application actually writes, and a harness
      // that swallows lines would make „nichts geleakt" true by omission.
      logger: new ConsoleLogger(),
    });
    prisma = testApp.prisma;

    // Without an entered mail server, explicitly: every case below writes its
    // own block, and a pre-set one would cover up what is measured.
    alpha = await createTenant(prisma, 'SECSMTPA', null);
    beta = await createTenant(prisma, 'SECSMTPB', null);

    const alphaAdmin = await createUser(prisma, {
      email: 'admin@secsmtpa.example.org',
      password: 'test-password',
      tenants: [alpha],
    });
    alphaSession = await openSession(app(), alphaAdmin.id, alpha.id);

    const betaAdmin = await createUser(prisma, {
      email: 'admin@secsmtpb.example.org',
      password: 'test-password',
      tenants: [beta],
    });
    betaSession = await openSession(app(), betaAdmin.id, beta.id);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await testApp?.close();
    await database?.release();
  });

  // -------------------------------------------------------------------------
  // the evidence — round trip, and what is really in the column
  // -------------------------------------------------------------------------

  it('opens what it sealed, and the column holds no plaintext', async () => {
    const password = mintPassword('smtp');
    await configure(alphaSession, password);

    // The round trip, through the same service the worker will use.
    const resolved = await resolve(alpha.id);
    expect(
      resolved.kind === 'send' ? resolved.block.auth?.password : null,
    ).toBe(password);

    const row = await rawTenant(alpha.id);
    // The control: we really looked at the ciphertext, and it is the
    // self-describing token `SecretBoxService` produces.
    expect(row).toContain('formsache1.');
    for (const { label, value } of spellings(password)) {
      expect(row, `SMTP-Passwort ${label} in der tenant-Zeile`).not.toContain(
        value,
      );
    }
    // The hex spelling would be a leak the three above cannot see, because hex
    // has no punctuation to disagree on.
    expect(row).not.toContain(Buffer.from(password).toString('hex'));
  });

  // -------------------------------------------------------------------------
  // the evidence — the plaintext never leaves the server
  // -------------------------------------------------------------------------

  /**
   * An **allow list**, not „enthält kein Passwort" : a field added
   * later has to be added here too, and this fails until somebody looks at it.
   * The weaker form stays green for exactly the field nobody thought of.
   */
  it('answers with the documented keys, and the whole payload is clean', async () => {
    const password = mintPassword('payload');
    await configure(alphaSession, password);

    const read = await request(app().server)
      .get(apiPath(SMTP_PATH))
      .set('Cookie', cookieHeader(alphaSession));
    expect(read.status).toBe(200);
    expect(Object.keys(read.body as object)).toEqual(['smtp']);
    const block = (read.body as { smtp: Record<string, unknown> }).smtp;
    expect(Object.keys(block).sort()).toEqual(OWN_PAYLOAD_KEYS);
    expect(Object.keys(block.auth as object).sort()).toEqual(AUTH_PAYLOAD_KEYS);
    // The payload really describes a configured Organisation — otherwise „nothing
    // found" would be the answer of a response that says nothing.
    expect(read.body).toMatchObject({ smtp: { auth: { passwordSet: true } } });

    for (const { label, value } of spellings(password)) {
      // The **whole** payload, as it went over the wire.
      expect(read.text, `Passwort ${label} in der Leseantwort`).not.toContain(
        value,
      );
    }
  });

  it('does not echo the password back out of the write that set it', async () => {
    const password = mintPassword('echo');
    const response = await request(app().server)
      .put(apiPath(SMTP_PATH))
      .set(authedMutation(alphaSession))
      .send({
        smtp: {
          host: 'mail.organisation.invalid',
          port: 587,
          secure: false,
          from: 'post@organisation.invalid',
          auth: { user: 'Organisation', password },
        },
      });

    expect(response.status).toBe(200);
    expect(
      Object.keys(
        (response.body as { smtp: Record<string, unknown> }).smtp,
      ).sort(),
    ).toEqual(OWN_PAYLOAD_KEYS);
    for (const { label, value } of spellings(password)) {
      expect(
        response.text,
        `Passwort ${label} in der Schreibantwort`,
      ).not.toContain(value);
    }
  });

  // -------------------------------------------------------------------------
  // the evidence — it appears in no log
  // -------------------------------------------------------------------------

  /**
   * A full cycle: setting the password, a resolution that opens it, a
   * resolution that **fails** because the stored value does not open — the
   * moment an error is built, logged and thrown, which is the ordinary way a
   * secret reaches a log — and a read of the tab afterwards.
   */
  it('leaks the password into neither stdout nor stderr over a full cycle', async () => {
    const password = mintPassword('log');
    const capture = captureStdio();
    let output: string;
    try {
      const tenant = await createTenant(prisma, 'SECSMTPLOG', null);
      const admin = await createUser(prisma, {
        email: 'admin@secsmtplog.example.org',
        password: 'test-password',
        tenants: [tenant],
      });
      const session = await openSession(app(), admin.id, tenant.id);

      // 1. set
      await configure(session, password);
      // 2. a resolution that works — the one path that holds the plaintext
      const sending = await resolve(tenant.id);
      expect(
        sending.kind === 'send' ? sending.block.auth?.password : null,
      ).toBe(password);

      // 3. and one that fails: the document is replaced by a value sealed
      //    elsewhere, so the resolution refuses instead of proceeding.
      await configure(alphaSession, mintPassword('fremd'));
      await prisma.$executeRaw`
        UPDATE "tenant" SET smtp = (SELECT smtp FROM "tenant" WHERE id = ${alpha.id}::uuid)
         WHERE id = ${tenant.id}::uuid`;
      expect((await resolve(tenant.id)).kind).toBe('fail');

      // 4. …and the tab is asked about it, which is the other caller
      await request(app().server)
        .get(apiPath(SMTP_PATH))
        .set('Cookie', cookieHeader(session))
        .expect(200);
    } finally {
      output = capture.text();
      capture.restore();
    }

    // The control: the capture really caught this application's output,
    // including the line that names the broken row.
    expect(output).toContain('MailSecretsService');
    expect(output).toContain('cannot be opened');

    for (const { label, value } of spellings(password)) {
      expect(output, `Passwort ${label} im Log`).not.toContain(value);
    }
  });

  // -------------------------------------------------------------------------
  // the evidence — the isolation probe, the load-bearing part
  // -------------------------------------------------------------------------

  /**
   * **The tenant is in the AAD, so a sealed value opens in one organisation only.**
   * Organisation A's document is written straight into Organisation B's column — no route, no
   * service, no delegate could do this.
   *
   * „Scheitert sichtbar" is checked three ways, because the dangerous failure is
   * the quiet one: the tab says „nicht gesetzt", the resolution refuses instead
   * of sending under a foreign identity, and a save that would *keep* that
   * password is refused rather than carrying it along forever.
   */
  it('does not open Organisation A’s password in Organisation B, and says so', async () => {
    const alphaPassword = mintPassword('alpha');
    await configure(alphaSession, alphaPassword);
    const stolen = await storedOf(alpha.id);
    await prisma.tenant.update({
      where: { id: beta.id },
      data: { smtp: stolen as Prisma.InputJsonValue },
    });

    // The control: it still opens for Organisation A. Without this the case below would
    // also pass against a service that can open nothing at all.
    const forAlpha = await resolve(alpha.id);
    expect(
      forAlpha.kind === 'send' ? forAlpha.block.auth?.password : null,
    ).toBe(alphaPassword);

    // 1. the resolution refuses rather than sending with a foreign password
    expect((await resolve(beta.id)).kind).toBe('fail');

    // 2. Organisation B is told „nicht gesetzt" — fail closed, and repairable
    const read = await request(app().server)
      .get(apiPath(SMTP_PATH))
      .set('Cookie', cookieHeader(betaSession));
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ smtp: { auth: { passwordSet: false } } });
    for (const { label, value } of spellings(alphaPassword)) {
      expect(
        read.text,
        `Organisation A’s Passwort ${label} in Organisation B’s Antwort`,
      ).not.toContain(value);
    }

    // 3. …and it cannot be kept: a save without a password is refused, so the
    //    foreign value cannot survive the next edit unnoticed.
    const refused = await request(app().server)
      .put(apiPath(SMTP_PATH))
      .set(authedMutation(betaSession))
      .send({
        smtp: {
          host: 'mail.beta.invalid',
          port: 587,
          secure: false,
          from: 'post@beta.invalid',
          auth: { user: 'Organisation' },
        },
      });
    expect(refused.status).toBe(400);
  });

  /**
   * **The reproduction `secret-context.ts` describes in as many words**, in the
   * direction the *field* segment of the AAD guards: a sealed OIDC client
   * secret moved into the SMTP block of the **same** Organisation. Same tenant, same
   * key, raw SQL — the most favourable form for an attacker — and it still does
   * not open as a mail password.
   */
  it('does not open a sealed OIDC client secret as a mail password', async () => {
    const tenant = await createTenant(prisma, 'SECSMTPX', null);
    const admin = await createUser(prisma, {
      email: 'admin@secsmtpx.example.org',
      password: 'test-password',
      tenants: [tenant],
    });
    const session = await openSession(app(), admin.id, tenant.id);

    const clientSecret = mintPassword('oidc');
    await request(app().server)
      .put(apiPath('/tenant/oidc'))
      .set(authedMutation(session))
      .send({
        enabled: false,
        issuer: 'https://idp.example.org/realms/demo',
        clientId: 'formsache',
        scopes: ['openid', 'profile', 'email'],
        emailClaim: DEFAULT_OIDC_EMAIL_CLAIM,
        emailVerifiedClaim: DEFAULT_OIDC_EMAIL_VERIFIED_CLAIM,
        buttonLabel: null,
        clientSecret,
      })
      .expect(200);

    // The attacker's move: the sealed OIDC secret, verbatim, into the place a
    // mail password lives — where the worker would hand it to a mail server.
    await prisma.$executeRaw`
      UPDATE "tenant"
         SET smtp = jsonb_build_object(
               'host', 'mail.organisation.invalid',
               'port', 587,
               'secure', false,
               'from', 'post@organisation.invalid',
               'auth', jsonb_build_object(
                 'user', 'Organisation',
                 'password', encode(oidc_client_secret_encrypted, 'escape')))
       WHERE id = ${tenant.id}::uuid`;

    expect((await resolve(tenant.id)).kind).toBe('fail');
    const read = await request(app().server)
      .get(apiPath(SMTP_PATH))
      .set('Cookie', cookieHeader(session));
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ smtp: { auth: { passwordSet: false } } });
    for (const { label, value } of spellings(clientSecret)) {
      expect(
        read.text,
        `Client-Secret ${label} über den SMTP-Reiter`,
      ).not.toContain(value);
    }
  });
});
