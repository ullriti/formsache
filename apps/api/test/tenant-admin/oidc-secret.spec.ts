import { randomBytes } from 'node:crypto';

import { ConsoleLogger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_OIDC_EMAIL_CLAIM,
  DEFAULT_OIDC_EMAIL_VERIFIED_CLAIM,
} from '@formsache/shared';

import type { PrismaService } from '../../src/prisma/prisma.service';
import { UNREADABLE_SETTINGS_MESSAGE } from '../../src/settings/settings-secrets.service';
import { OidcConfigService } from '../../src/tenant-admin/oidc-config.service';
import {
  OidcClientSecretUnreadableError,
  OidcSecretsService,
} from '../../src/tenant-admin/oidc-secrets.service';
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
 * The client secret is the **second database secret** of this application, and
 * unlike the access word it never leaves the server.
 *
 * The four proofs of the requirement, in order: the round trip and what is really in the
 * column, the whole payload of the administration route (for an ordinary admin
 * **and** for a superadmin), the logs over a full cycle, and — the load-bearing
 * one — the sealed value of Organisation A carried into the column of Organisation B by a raw
 * write.
 *
 * Plus the reproduction `secret-context.ts` describes in as many words: the
 * sealed OIDC secret pushed into `access.password` of the **same** Organisation and read
 * out through the settings page, which is allowed to show an access word in
 * clear. That is the privilege escalation from „darf Formulare konfigurieren" to
 * „kennt das Client-Secret des Identity-Providers".
 */

const SETUP_TIMEOUT_MS = 180_000;

const OIDC_PATH = '/tenant/oidc';

/**
 * A secret that cannot be found by accident — the same shape used elsewhere.
 *
 * Random per run, because a fixed `secret` either turns up somewhere by chance
 * (a red test that means nothing) or, worse, turns up nowhere for reasons that
 * have nothing to do with the code (a green test that proves nothing). The
 * punctuation makes the raw, base64 and percent-encoded spellings differ from
 * each other, and all three are searched for: a leak through an encoder is
 * still a leak.
 */
function mintSecret(prefix: string): string {
  return `${prefix}!${randomBytes(12).toString('hex')}+/=`;
}

/** The spellings a leaked value could take. */
function spellings(secret: string): { label: string; value: string }[] {
  return [
    { label: 'im Klartext', value: secret },
    { label: 'base64-kodiert', value: Buffer.from(secret).toString('base64') },
    { label: 'URL-kodiert', value: encodeURIComponent(secret) },
  ];
}

/** The keys the evidence allows in the payload, and no others. */
const OIDC_PAYLOAD_KEYS = [
  'buttonLabel',
  'clientId',
  'clientSecretSet',
  // The two claim names of the specification — configuration, and on the list for the
  // same reason the others are: this is a **positive** list, so a field added
  // to the read schema has to be looked at here before the suite goes green.
  'emailClaim',
  'emailVerifiedClaim',
  'enabled',
  'issuer',
  'redirectUri',
  'scopes',
];

describe('the OIDC client secret', () => {
  let database: TestDatabase | undefined;
  let testApp: TestApp | undefined;
  let prisma: PrismaService;

  let alpha: TenantFixture;
  let beta: TenantFixture;
  let alphaSession: string;
  let betaSession: string;
  /** A superadmin who is also an admin of ALPHA — the evidence's second caller. */
  let rootSession: string;

  function app(): TestApp {
    if (testApp === undefined) {
      throw new Error('no test app');
    }
    return testApp;
  }

  function secrets(): OidcSecretsService {
    return app().app.get(OidcSecretsService);
  }

  function configs(): OidcConfigService {
    return app().app.get(OidcConfigService);
  }

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({
      databaseUrl: database.url,
      // The installation's own address is a **row**, not
      // `PUBLIC_BASE_URL` of the environment. A suite
      // that asserts on absolute links has to put one there — which is also
      // what makes „fehlt sie, gibt es keinen Link" a state of its own.
      systemMail: { publicBaseUrl: TEST_PUBLIC_BASE_URL },
      // A real logger, not `@nestjs/testing`'s silent one: the evidence counts on
      // seeing what the application actually writes, and a harness that
      // swallows lines would make „nichts geleakt" true by omission (a lesson
      // learned before).
      logger: new ConsoleLogger(),
    });
    prisma = testApp.prisma;

    alpha = await createTenant(prisma, 'SECA');
    beta = await createTenant(prisma, 'SECB');

    const alphaAdmin = await createUser(prisma, {
      email: 'admin@seca.example.org',
      password: 'test-password',
      tenants: [alpha],
    });
    alphaSession = await openSession(app(), alphaAdmin.id, alpha.id);

    const betaAdmin = await createUser(prisma, {
      email: 'admin@secb.example.org',
      password: 'test-password',
      tenants: [beta],
    });
    betaSession = await openSession(app(), betaAdmin.id, beta.id);

    const root = await createUser(prisma, {
      email: 'superadmin@seca.example.org',
      password: 'test-password',
      tenants: [alpha],
      isSuperadmin: true,
    });
    rootSession = await openSession(app(), root.id, alpha.id);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await testApp?.close();
    await database?.release();
  });

  /** Stores a complete configuration through the real route. */
  async function configure(
    session: string,
    clientSecret: string,
  ): Promise<void> {
    const response = await request(app().server)
      .put(apiPath(OIDC_PATH))
      .set(authedMutation(session))
      .send({
        enabled: true,
        issuer: 'https://idp.example.org/realms/demo',
        clientId: 'formsache',
        scopes: ['openid', 'profile', 'email'],
        emailClaim: DEFAULT_OIDC_EMAIL_CLAIM,
        emailVerifiedClaim: DEFAULT_OIDC_EMAIL_VERIFIED_CLAIM,
        buttonLabel: 'Mit Organisation-Login anmelden',
        clientSecret,
      });
    expect(response.status).toBe(200);
    expect(
      (response.body as { clientSecretSet: boolean }).clientSecretSet,
    ).toBe(true);
  }

  /** The whole `tenant` row as text, plus the secret column in three encodings. */
  async function rawTenant(tenantId: string): Promise<{
    row: string;
    escaped: string | null;
    hex: string | null;
    base64: string | null;
  }> {
    const rows = await prisma.$queryRaw<
      {
        row: string;
        escaped: string | null;
        hex: string | null;
        base64: string | null;
      }[]
    >`SELECT to_jsonb(t)::text AS "row",
             encode(t.oidc_client_secret_encrypted, 'escape') AS "escaped",
             encode(t.oidc_client_secret_encrypted, 'hex') AS "hex",
             encode(t.oidc_client_secret_encrypted, 'base64') AS "base64"
        FROM "tenant" t WHERE t.id = ${tenantId}::uuid`;
    const row = rows[0];
    if (row === undefined) {
      throw new Error('tenant row missing');
    }
    return row;
  }

  /** The stored ciphertext bytes of one organisation. */
  async function sealedBytes(tenantId: string): Promise<Uint8Array> {
    const rows = await prisma.$queryRaw<
      { secret: Uint8Array | null }[]
    >`SELECT oidc_client_secret_encrypted AS "secret" FROM "tenant" WHERE id = ${tenantId}::uuid`;
    const stored = rows[0]?.secret ?? null;
    if (stored === null) {
      throw new Error('no sealed secret stored');
    }
    return stored;
  }

  /** The columns `OidcConfigService.signIn` reads, straight from the row. */
  async function oidcRow(tenantId: string): Promise<{
    id: string;
    oidcEnabled: boolean;
    oidcIssuer: string | null;
    oidcClientId: string | null;
    oidcClientSecret: Uint8Array<ArrayBuffer> | null;
    oidcScopes: string[];
    oidcEmailClaim: string;
    oidcEmailVerifiedClaim: string;
    oidcButtonLabel: string | null;
  }> {
    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
    });
    return tenant;
  }

  // -------------------------------------------------------------------------
  // the evidence — round trip, and what is really in the column
  // -------------------------------------------------------------------------

  it('opens what it sealed, and the column holds no plaintext', async () => {
    const secret = mintSecret('oidc');
    await configure(alphaSession, secret);

    // The round trip, through the same service the login will use.
    const stored = await sealedBytes(alpha.id);
    expect(secrets().open(stored, alpha.id)).toBe(secret);

    const raw = await rawTenant(alpha.id);
    // The control: we really looked at the ciphertext, and it is the
    // self-describing token `SecretBoxService` produces.
    expect(raw.escaped).toMatch(/^formsache1\./);
    expect(raw.row.length).toBeGreaterThan(0);

    for (const { label, value } of spellings(secret)) {
      expect(
        raw.escaped ?? '',
        `Client-Secret ${label} in der Spalte`,
      ).not.toContain(value);
      expect(raw.base64 ?? '', `Client-Secret ${label} (base64)`).not.toContain(
        value,
      );
      expect(raw.hex ?? '', `Client-Secret ${label} (hex)`).not.toContain(
        value,
      );
      // And in no *other* column of the row either.
      expect(
        raw.row,
        `Client-Secret ${label} in der tenant-Zeile`,
      ).not.toContain(value);
    }
    // The hex spelling of the plaintext would be a leak the three searches
    // above cannot see, because hex has no punctuation to disagree on.
    expect(raw.hex ?? '').not.toContain(Buffer.from(secret).toString('hex'));
  });

  // -------------------------------------------------------------------------
  // the evidence — the plaintext never leaves the server
  // -------------------------------------------------------------------------

  /**
   * An **allow list**, not „enthält kein Passwort" : a field added
   * later has to be added here too, and the test fails until somebody looks at
   * it. The weaker form stays green for exactly the field nobody thought of.
   */
  it('answers with the seven documented keys, for an admin and for a superadmin', async () => {
    const secret = mintSecret('payload');
    await configure(alphaSession, secret);

    for (const [who, session] of [
      ['Admin', alphaSession],
      ['Superadmin', rootSession],
    ] as const) {
      const response = await request(app().server)
        .get(apiPath(OIDC_PATH))
        .set('Cookie', cookieHeader(session));
      expect(response.status, who).toBe(200);
      expect(Object.keys(response.body as object).sort(), who).toEqual(
        OIDC_PAYLOAD_KEYS,
      );
      // The payload really describes a configured Organisation — otherwise „nothing
      // found" would be the answer of a response that says nothing.
      expect(
        (response.body as { clientSecretSet: boolean }).clientSecretSet,
      ).toBe(true);

      // The **whole** payload, as it went over the wire, not the fields we
      // expected to look at.
      for (const { label, value } of spellings(secret)) {
        expect(response.text, `${who}: Client-Secret ${label}`).not.toContain(
          value,
        );
      }
    }

    // The superadmin really is one — otherwise the second half of this case
    // would be a second ordinary admin.
    const root = await prisma.user.findUniqueOrThrow({
      where: { email: 'superadmin@seca.example.org' },
      select: { isSuperadmin: true },
    });
    expect(root.isSuperadmin).toBe(true);
  });

  it('does not echo the secret back out of the write that set it', async () => {
    const secret = mintSecret('echo');
    const response = await request(app().server)
      .put(apiPath(OIDC_PATH))
      .set(authedMutation(alphaSession))
      .send({
        enabled: true,
        issuer: 'https://idp.example.org/realms/demo',
        clientId: 'formsache',
        scopes: ['openid', 'profile', 'email'],
        emailClaim: DEFAULT_OIDC_EMAIL_CLAIM,
        emailVerifiedClaim: DEFAULT_OIDC_EMAIL_VERIFIED_CLAIM,
        buttonLabel: null,
        clientSecret: secret,
      });
    expect(response.status).toBe(200);
    expect(Object.keys(response.body as object).sort()).toEqual(
      OIDC_PAYLOAD_KEYS,
    );
    for (const { label, value } of spellings(secret)) {
      expect(
        response.text,
        `Client-Secret ${label} in der Schreibantwort`,
      ).not.toContain(value);
    }
  });

  // -------------------------------------------------------------------------
  // the evidence — it appears in no log
  // -------------------------------------------------------------------------

  /**
   * A full cycle: setting the secret, a sign-in that resolves it, and a sign-in
   * that **fails** because the stored value does not open — the moment an error
   * is built, logged and thrown, which is the ordinary way a secret reaches a
   * log (`SecretBoxError` was written on that assumption).
   */
  it('leaks the secret into neither stdout nor stderr over a full cycle', async () => {
    const secret = mintSecret('log');
    const capture = captureStdio();
    // Read inside the `finally`, so the streams are restored even when a step
    // above throws — and declared without an initialiser, because the only
    // assignment is that one.
    let output: string;
    try {
      const tenant = await createTenant(prisma, 'SECLOG');
      const admin = await createUser(prisma, {
        email: 'admin@seclog.example.org',
        password: 'test-password',
        tenants: [tenant],
      });
      const session = await openSession(app(), admin.id, tenant.id);

      // 1. set
      await configure(session, secret);

      // 2. a sign-in that works — the one path that holds the plaintext
      const signIn = await configs().signIn(await oidcRow(tenant.id));
      expect(signIn?.clientSecret).toBe(secret);

      // 3. and one that fails: the bytes are replaced by a value sealed
      //    elsewhere, so the login refuses instead of proceeding.
      await configure(alphaSession, mintSecret('fremd'));
      const foreign = await sealedBytes(alpha.id);
      await prisma.$executeRaw`
        UPDATE "tenant" SET oidc_client_secret_encrypted = ${Buffer.from(foreign)}
         WHERE id = ${tenant.id}::uuid`;
      const brokenRow = await oidcRow(tenant.id);
      // `rejects`, because `signIn` awaits the installation's base address for
      // the `redirect_uri` — the refusal is the same one.
      await expect(configs().signIn(brokenRow)).rejects.toThrow(
        OidcClientSecretUnreadableError,
      );

      // 4. and the tab is asked about it, which is the other caller
      await request(app().server)
        .get(apiPath(OIDC_PATH))
        .set('Cookie', cookieHeader(session))
        .expect(200);
    } finally {
      output = capture.text();
      capture.restore();
    }

    // The control: the capture really caught this application's output,
    // including the line that names the broken row.
    expect(output).toContain('OidcSecretsService');
    expect(output).toContain('cannot be opened');

    for (const { label, value } of spellings(secret)) {
      expect(output, `Client-Secret ${label} im Log`).not.toContain(value);
    }
  });

  // -------------------------------------------------------------------------
  // the evidence — the isolation probe, the load-bearing part
  // -------------------------------------------------------------------------

  /**
   * **The tenant is in the AAD, so a sealed value opens in one organisation only.**
   * Organisation A's ciphertext is written straight into Organisation B's column — no route, no
   * service, no delegate could do this, which is the point: the boundary has to
   * hold against somebody who can write the column.
   *
   * „Scheitert sichtbar" is checked three ways, because the dangerous failure is
   * the quiet one: the value does not open, the tab says „nicht gesetzt" so SSO
   * cannot be switched on against it, and the sign-in path **throws** rather
   * than proceeding with a foreign secret.
   */
  it('does not open Organisation A’s secret in Organisation B, and Organisation B’s login fails visibly', async () => {
    const alphaSecret = mintSecret('alpha');
    const betaSecret = mintSecret('beta');
    await configure(alphaSession, alphaSecret);
    await configure(betaSession, betaSecret);

    const stolen = await sealedBytes(alpha.id);
    await prisma.$executeRaw`
      UPDATE "tenant" SET oidc_client_secret_encrypted = ${Buffer.from(stolen)}
       WHERE id = ${beta.id}::uuid`;

    // The bytes really are the ones Organisation A stored …
    expect(
      Buffer.from(await sealedBytes(beta.id)).equals(Buffer.from(stolen)),
    ).toBe(true);
    // … and they still open for Organisation A. Without this control the case below
    // would also pass against a service that can open nothing at all.
    expect(secrets().open(stolen, alpha.id)).toBe(alphaSecret);

    // 1. it does not open in Organisation B
    expect(() => secrets().open(stolen, beta.id)).toThrow(
      OidcClientSecretUnreadableError,
    );

    // 2. Organisation B is told „nicht gesetzt" — fail closed, and repairable
    const read = await request(app().server)
      .get(apiPath(OIDC_PATH))
      .set('Cookie', cookieHeader(betaSession));
    expect(read.status).toBe(200);
    expect((read.body as { clientSecretSet: boolean }).clientSecretSet).toBe(
      false,
    );
    for (const { label, value } of spellings(alphaSecret)) {
      expect(
        read.text,
        `Organisation A’s Secret ${label} in Organisation B’s Antwort`,
      ).not.toContain(value);
    }

    // 3. …and Organisation B's sign-in refuses rather than using the foreign secret
    const betaRow = await oidcRow(beta.id);
    await expect(configs().signIn(betaRow)).rejects.toThrow(
      OidcClientSecretUnreadableError,
    );

    // 4. …and SSO cannot be switched on against it either
    const refused = await request(app().server)
      .put(apiPath(OIDC_PATH))
      .set(authedMutation(betaSession))
      .send({
        enabled: true,
        issuer: 'https://idp.example.org/realms/demo',
        clientId: 'formsache',
        scopes: ['openid', 'profile', 'email'],
        emailClaim: DEFAULT_OIDC_EMAIL_CLAIM,
        emailVerifiedClaim: DEFAULT_OIDC_EMAIL_VERIFIED_CLAIM,
        buttonLabel: null,
      });
    expect(refused.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // The reproduction `secret-context.ts` describes in as many words
  // -------------------------------------------------------------------------

  /**
   * **The privilege escalation the field segment of the AAD exists against.**
   *
   * `can_manage_settings` is allowed to read a form access word in clear — it
   * has to be, because an editor must be able to read it out. If a
   * sealed value were portable between the two fields of the *same* Organisation,
   * anyone able to write `tenant.form_defaults` could move the OIDC client
   * secret there and read it off the settings page. Here that write happens, in
   * the most favourable form for the attacker — same organisation, same key, raw SQL —
   * and the settings page refuses instead of answering.
   *
   * **What this case is red for:** any change that lets the two contexts
   * coincide. It is *not* red for removing the field segment alone, and that is
   * worth stating rather than implying: `secret-context.ts` built two
   * independent separations on purpose — the holder literal (`tenant-oidc`
   * against `tenant-defaults`) and the field — so either one alone still keeps
   * these two apart. The field segment on its own is pinned by
   * `src/common/secret-box/secret-context.spec.ts` („separates the two secrets
   * of one tenant by their field"), which *is* red when it goes.
   */
  it('cannot be read out through the settings page of the same organisation', async () => {
    const secret = mintSecret('escalate');
    const tenant = await createTenant(prisma, 'SECESC');
    const editor = await createUser(prisma, {
      email: 'admin@secesc.example.org',
      password: 'test-password',
      tenants: [tenant],
    });
    const session = await openSession(app(), editor.id, tenant.id);
    await configure(session, secret);

    // The attacker's move: the sealed OIDC secret, verbatim, into the place the
    // settings page opens and shows in clear.
    //
    // **Written flat** (review finding 10): `tenant.form_defaults` has carried
    // a complete document without `{overridden, values}` since 2026-08-17, and
    // the reproduction has to have the shape an attacker would write *today*.
    // In the old wrapper it would run past the place that even tries to open
    // the word — and would be green without ever having touched the separation
    // of the two contexts.
    const sealed = Buffer.from(await sealedBytes(tenant.id)).toString('utf8');
    await prisma.$executeRaw`
      UPDATE "tenant"
         SET form_defaults = jsonb_build_object(
               'passwordEnabled', true, 'password', ${sealed}::text)
       WHERE id = ${tenant.id}::uuid`;

    const response = await request(app().server)
      .get(apiPath('/tenant/form-defaults'))
      .set('Cookie', cookieHeader(session));

    // The read refuses — it does not hand back a plausible-looking word, and it
    // does not hand back the client secret.
    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      message: UNREADABLE_SETTINGS_MESSAGE,
    });
    for (const { label, value } of spellings(secret)) {
      expect(
        response.text,
        `Client-Secret ${label} über die Einstellungsseite`,
      ).not.toContain(value);
    }
  });

  /**
   * **The same move in the old wrapper** — it gets through just as little.
   *
   * A row in the shape `{overridden, values}` is one this version did not
   * write (the migration
   * `20260817120000_tenant_form_defaults_flat` rewrites every one). It fails
   * one station earlier, at the schema instead of at the seal, and therefore
   * carries the general 500 instead of the named message. What stays the same
   * is the only thing that matters here: **nothing of the client secret stands
   * in the answer.**
   *
   * The case stands beside the one above and not in its place: a restored
   * backup, an import or a hand-written row can produce this shape, and „falls
   * closed" is the promise for that — not „is interpreted".
   */
  it('cannot be read out through a row in the pre-2026-08-17 shape either', async () => {
    const secret = mintSecret('escalate-legacy');
    const tenant = await createTenant(prisma, 'SECESL');
    const editor = await createUser(prisma, {
      email: 'admin@secesl.example.org',
      password: 'test-password',
      tenants: [tenant],
    });
    const session = await openSession(app(), editor.id, tenant.id);
    await configure(session, secret);

    const sealed = Buffer.from(await sealedBytes(tenant.id)).toString('utf8');
    await prisma.$executeRaw`
      UPDATE "tenant"
         SET form_defaults = jsonb_build_object(
               'overridden', jsonb_build_object('access', true),
               'values', jsonb_build_object('passwordEnabled', true, 'password', ${sealed}::text))
       WHERE id = ${tenant.id}::uuid`;

    const response = await request(app().server)
      .get(apiPath('/tenant/form-defaults'))
      .set('Cookie', cookieHeader(session));

    expect(response.status).toBe(500);
    for (const { label, value } of spellings(secret)) {
      expect(
        response.text,
        `Client-Secret ${label} über eine Zeile in der alten Gestalt`,
      ).not.toContain(value);
    }
  });
});
