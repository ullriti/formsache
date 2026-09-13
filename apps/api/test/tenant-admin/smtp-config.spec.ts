import { randomBytes } from 'node:crypto';

import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';

import { MailIdentityService } from '../../src/mail/mail-identity.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  CHANGED_SMTP_USER_MESSAGE,
  MISSING_SMTP_PASSWORD_MESSAGE,
  UNREADABLE_SMTP_MESSAGE,
} from '../../src/tenant-admin/smtp-config.service';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import {
  apiPath,
  createTestApp,
  type TestApp,
} from '../support/create-test-app';
import {
  createRestrictedMember,
  createTenant,
  createUser,
  type TenantFixture,
} from '../support/fixtures';
import { authedMutation, cookieHeader, openSession } from '../support/http';

/**
 * The *Mailversand*-Reiter of one organisation (the requirements).
 *
 * What is proven here is the **route**: that the block can only be written
 * whole, that a save which changes a port keeps the password it was not sent,
 * that a save which has nothing to keep is refused rather than storing an empty
 * secret, and who may do any of it. The secret's own promises — nothing in the
 * column, nothing in a payload, nothing in a log, nothing across the organisation
 * boundary — are next door in `smtp-secret.spec.ts`.
 */

const SETUP_TIMEOUT_MS = 180_000;

const SMTP_PATH = '/tenant/smtp';

function mintPassword(prefix: string): string {
  return `${prefix}!${randomBytes(9).toString('hex')}`;
}

/** A complete own block, as the tab sends it — in the envelope (ADR-0023). */
function ownBlock(overrides: Record<string, unknown> = {}): unknown {
  return {
    smtp: {
      host: 'mail.organisation.invalid',
      port: 587,
      secure: false,
      from: 'post@organisation.invalid',
      auth: { user: 'Organisation', password: mintPassword('pw') },
      ...overrides,
    },
  };
}

describe('the sending identity of an organisation, through its route', () => {
  let database: TestDatabase | undefined;
  let testApp: TestApp | undefined;
  let prisma: PrismaService;

  let alpha: TenantFixture;
  let beta: TenantFixture;
  let alphaSession: string;
  let betaSession: string;
  /** All permissions but `can_view_responses` — the boundary under test. */
  let settingsOnlySession: string;
  /**
   * The other half of the pair (a review finding): all permissions but
   * `can_manage_settings`. Both decorators are `@RequireAllPermissions`, so a
   * suite that only ever removes `can_view_responses` would stay green even if
   * `can_manage_settings` were dropped from both routes — the same trap the
   * doc on {@link createRestrictedMember}'s options warns about one permission
   * over.
   */
  let viewOnlySession: string;

  function app(): TestApp {
    if (testApp === undefined) {
      throw new Error('no test app');
    }
    return testApp;
  }

  function get(session: string): request.Test {
    return request(app().server)
      .get(apiPath(SMTP_PATH))
      .set('Cookie', cookieHeader(session));
  }

  function put(session: string, body: unknown): request.Test {
    return request(app().server)
      .put(apiPath(SMTP_PATH))
      .set(authedMutation(session))
      .send(body as object);
  }

  /** What the worker would do with this organisation right now. */
  async function resolve(
    tenantId: string,
  ): ReturnType<MailIdentityService['resolve']> {
    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { smtp: true },
    });
    return app()
      .app.get(MailIdentityService)
      .resolve({ id: tenantId, smtp: tenant.smtp }, 'tenant');
  }

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });
    prisma = testApp.prisma;

    // Without an entered mail server, expressly: this tab starts at
    // "none yet" and measures what the writing makes of it (ADR-0023).
    alpha = await createTenant(prisma, 'SMTPA', null);
    beta = await createTenant(prisma, 'SMTPB', null);

    const alphaAdmin = await createUser(prisma, {
      email: 'admin@smtpa.example.org',
      password: 'test-password',
      tenants: [alpha],
    });
    alphaSession = await openSession(app(), alphaAdmin.id, alpha.id);

    const betaAdmin = await createUser(prisma, {
      email: 'admin@smtpb.example.org',
      password: 'test-password',
      tenants: [beta],
    });
    betaSession = await openSession(app(), betaAdmin.id, beta.id);

    const settingsOnly = await createRestrictedMember(prisma, alpha, {
      email: 'settings@smtpa.example.org',
      groupName: 'settings-only',
      // Four of five. The member who must be refused holds everything **but**
      // the permission under test — one who happened to hold nothing would
      // prove only that *some* guard fires.
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
      email: 'view@smtpa.example.org',
      groupName: 'view-only',
      // Four of five, the other way round from `settingsOnly`.
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
    await database?.release();
  });

  beforeEach(async () => {
    await prisma.tenant.updateMany({ data: { smtp: Prisma.DbNull } });
  });

  // -------------------------------------------------------------------------
  // The block is written whole, or not at all
  // -------------------------------------------------------------------------

  it('reads an organisation that has never been configured as „kein Mailserver"', async () => {
    const response = await get(alphaSession);

    expect(response.status).toBe(200);
    // Since ADR-0023 that does **not** mean "inherits from the system", but
    // "this organisation sends nothing" — and the worker answers accordingly
    // with `withhold` instead of with the installation's block.
    expect(response.body).toStrictEqual({ smtp: null });
    expect((await resolve(alpha.id)).kind).toBe('withhold');
  });

  it('stores a complete own block and reads it back', async () => {
    const password = mintPassword('store');
    const written = await put(
      alphaSession,
      ownBlock({ auth: { user: 'Organisation', password } }),
    );

    expect(written.status).toBe(200);
    expect(written.body).toStrictEqual({
      smtp: {
        host: 'mail.organisation.invalid',
        port: 587,
        secure: false,
        from: 'post@organisation.invalid',
        auth: { user: 'Organisation', passwordSet: true },
      },
    });

    // …and the queue would send with exactly that, password opened.
    const resolved = await resolve(alpha.id);
    expect(resolved.kind === 'send' ? resolved.source : null).toBe('own');
    expect(
      resolved.kind === 'send' ? resolved.block.auth?.password : null,
    ).toBe(password);
  });

  /**
   * **The arm that no longer exists** (ADR-0023). `source: 'system'` was the
   * choice "this organisation inherits"; it is now refused instead of being
   * quietly read as something or other. Were the inheritance to come back,
   * this case would be the first line to report it.
   */
  it('refuses the old inheritance document', async () => {
    const response = await put(alphaSession, { source: 'system' });

    expect(response.status).toBe(400);
    expect((await get(alphaSession)).body).toStrictEqual({ smtp: null });
  });

  /**
   * **The mixture the indivisible block exists against** (ADR-0013
   * no. 2): a foreign transport with an own sender address. There is no field
   * for it, so the refusal is the schema's and needs no rule that
   * somebody could forget.
   */
  it('refuses a half-filled block and names the field', async () => {
    const response = await put(alphaSession, {
      smtp: { from: 'post@organisation.invalid' },
    });

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain('host');
  });

  it('writes NULL — not a document — when an organisation clears its mail server', async () => {
    await put(alphaSession, ownBlock()).expect(200);

    const response = await put(alphaSession, { smtp: null });

    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({ smtp: null });
    // NULL is the one spelling of "no mail server" — a stored
    // document would be the second, and the second is the one a later
    // query forgets.
    const row = await prisma.tenant.findUniqueOrThrow({
      where: { id: alpha.id },
      select: { smtp: true },
    });
    expect(row.smtp).toBeNull();
    // And the consequence the card announces: from now on nothing goes out
    // any more — **not** over the installation's mail server as a substitute.
    expect((await resolve(alpha.id)).kind).toBe('withhold');
  });

  // -------------------------------------------------------------------------
  // "password unchanged" against "password cleared"
  // -------------------------------------------------------------------------

  /**
   * **The trap this route shares with the OIDC one and with the
   * system surface**: whoever corrects a port does not retype the password —
   * the page never held it. An omitted `auth.password` therefore means "leave
   * the stored one standing", and the stored **ciphertext** is carried forward
   * byte-for-byte rather than opened and sealed again.
   */
  it('keeps the stored password when a save changes only the transport', async () => {
    const password = mintPassword('keep');
    await put(
      alphaSession,
      ownBlock({ auth: { user: 'Organisation', password } }),
    ).expect(200);
    const before = await prisma.tenant.findUniqueOrThrow({
      where: { id: alpha.id },
      select: { smtp: true },
    });

    const response = await put(
      alphaSession,
      ownBlock({ port: 465, secure: true, auth: { user: 'Organisation' } }),
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      smtp: {
        port: 465,
        secure: true,
        auth: { user: 'Organisation', passwordSet: true },
      },
    });
    // The ciphertext is the same bytes — not re-sealed, and above all not
    // sealed a second time, which would leave a value nobody can open.
    const after = await prisma.tenant.findUniqueOrThrow({
      where: { id: alpha.id },
      select: { smtp: true },
    });
    expect(passwordOf(after.smtp)).toBe(passwordOf(before.smtp));
    // And it still opens: the password survived the save unchanged.
    const resolved = await resolve(alpha.id);
    expect(
      resolved.kind === 'send' ? resolved.block.auth?.password : null,
    ).toBe(password);
    expect(resolved.kind === 'send' ? resolved.block.port : null).toBe(465);
  });

  /**
   * The other half: there is nothing to keep. Storing the block without
   * credentials would be an own transport authenticating as nobody, and the
   * first anybody heard of it would be a `failed` row.
   */
  it('refuses a save that keeps a password there is none of', async () => {
    const response = await put(
      alphaSession,
      ownBlock({ auth: { user: 'Organisation' } }),
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      issues: [
        { path: 'smtp.auth.password', message: MISSING_SMTP_PASSWORD_MESSAGE },
      ],
    });
    expect((await get(alphaSession)).body).toStrictEqual({ smtp: null });
  });

  /**
   * **A gap mirrored from `SystemMailAdminService`
   * (`eead295`):** a write that changes `auth.user` while omitting
   * `auth.password` must not pair the *new* name with the *old* ciphertext —
   * that login was never typed and would only fail at the next send, from
   * `mail_log.last_error`, nowhere near the save that caused it.
   *
   * Before this package the only place that refused this was
   * `MailIdentityCard`'s own client-side guard
   * (`usernameChangedWithoutNewPassword`) — comfort, not a boundary
   * (`CONTRIBUTING.md`). This request is built the way a client past that guard
   * would build it, straight against the route.
   */
  it('refuses a changed username without a new password — a client guard is not a boundary', async () => {
    const password = mintPassword('orig');
    await put(
      alphaSession,
      ownBlock({ auth: { user: 'urspruenglich', password } }),
    ).expect(200);
    const before = await prisma.tenant.findUniqueOrThrow({
      where: { id: alpha.id },
      select: { smtp: true },
    });

    const response = await put(
      alphaSession,
      ownBlock({ auth: { user: 'ein-anderer' } }),
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      issues: [
        { path: 'smtp.auth.password', message: CHANGED_SMTP_USER_MESSAGE },
      ],
    });
    // Nothing changed — the old user and the old (still openable) password
    // stand exactly as they did.
    const after = await prisma.tenant.findUniqueOrThrow({
      where: { id: alpha.id },
      select: { smtp: true },
    });
    expect(after.smtp).toStrictEqual(before.smtp);
    const resolved = await resolve(alpha.id);
    expect(resolved.kind === 'send' ? resolved.block.auth?.user : null).toBe(
      'urspruenglich',
    );
  });

  /**
   * A relay that wants no login stays expressible — the `.env` of earlier versions allowed
   * one, and dropping it silently would be an unannounced regression. Removing
   * the login takes **both** halves at once; there is no way to empty the
   * password while keeping the user.
   */
  it('stores a relay without a login, and then has no password to keep', async () => {
    await put(alphaSession, ownBlock({ auth: null })).expect(200);
    expect((await get(alphaSession)).body).toMatchObject({
      smtp: { auth: null },
    });

    const refused = await put(
      alphaSession,
      ownBlock({ auth: { user: 'Organisation' } }),
    );
    expect(refused.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // Broken is visible, and healable without SQL (a review finding)
  // -------------------------------------------------------------------------

  /**
   * A raw write reaches a document the route's own validation would have
   * refused — the shape a hand-edited row or a bug in a future writer
   * produces, not anything this route can be made to store. If `toConfig`
   * were ever made tolerant the way the system surface's `toSmtpDisplay` reads a broken
   * *system* block as "nicht eingerichtet", this organisation's *Mailversand*-Reiter
   * would say „kein Mailserver eingetragen" — which would keep the row
   * `queued` — while every one of its mails in fact goes `failed` —
   * and this is the test that would catch it, because a merely-optimistic
   * read stays 200.
   *
   * The repair half is the other half of the same requirement: the broken row
   * is not a dead end. A `PUT` with a complete block and a fresh password
   * clears it, and the worker — asked the identical question through
   * `MailIdentityService.resolve`, not re-derived here — agrees.
   */
  it('answers 500 on a mixed document, and heals with a fresh save — no SQL', async () => {
    await prisma.tenant.update({
      where: { id: alpha.id },
      // Exactly the mixture the schema refuses on the way in (ADR-0013
      // no. 2): a source without the fields it needs. Written directly,
      // bypassing `SmtpConfigService.replaceOfTenant` entirely.
      data: { smtp: { from: 'vorstand@example.org' } },
    });

    const broken = await get(alphaSession);
    expect(broken.status).toBe(500);
    expect(broken.body).toMatchObject({ message: UNREADABLE_SMTP_MESSAGE });
    // …and the queue agrees: this row cannot be used, so it goes `failed`
    // rather than silently falling back to the system block.
    expect((await resolve(alpha.id)).kind).toBe('fail');

    const password = mintPassword('heal');
    const healed = await put(
      alphaSession,
      ownBlock({ auth: { user: 'Organisation', password } }),
    );
    expect(healed.status).toBe(200);
    expect(healed.body).toMatchObject({
      smtp: { auth: { user: 'Organisation', passwordSet: true } },
    });

    expect((await get(alphaSession)).status).toBe(200);
    const resolved = await resolve(alpha.id);
    expect(resolved.kind).toBe('send');
    expect(resolved.kind === 'send' ? resolved.source : null).toBe('own');
    expect(
      resolved.kind === 'send' ? resolved.block.auth?.password : null,
    ).toBe(password);
  });

  // -------------------------------------------------------------------------
  // Who may do this
  // -------------------------------------------------------------------------

  /**
   * **The superadmin guard does not belong here.** The specification grants an *organisation*
   * its own mail server; a route only a superadmin could reach would make that
   * grant depend on somebody else's availability. The caller below is an admin
   * of the active organisation and no superadmin — exactly the person a misplaced
   * `SuperadminGuard` would turn away.
   */
  it('lets an admin of the active Organisation read and write it', async () => {
    await get(alphaSession).expect(200);
    await put(alphaSession, ownBlock()).expect(200);

    const admin = await prisma.user.findUniqueOrThrow({
      where: { email: 'admin@smtpa.example.org' },
      select: { isSuperadmin: true },
    });
    // The control: this really is an ordinary organisation admin.
    expect(admin.isSuperadmin).toBe(false);
  });

  /**
   * Whoever names the mail server names the machine **every notification of
   * this organisation travels through**, bodies included — and those carry answers. So
   * the route asks for `can_view_responses` next to `can_manage_settings`, the
   * same pair the mail log asks for.
   */
  it('refuses a member who may configure but may not see responses', async () => {
    await get(settingsOnlySession).expect(403);
    await put(settingsOnlySession, ownBlock()).expect(403);
  });

  /**
   * The other half of the pair (a review finding): `can_view_responses`
   * alone is not enough either. Without this case, deleting `canManageSettings`
   * from both `@RequireAllPermissions(...)` decorators would leave the suite
   * green — `settingsOnlySession` would still be refused for lacking
   * `can_view_responses`, and nothing would exercise the other permission.
   */
  it('refuses a member who may see responses but may not configure', async () => {
    await get(viewOnlySession).expect(403);
    await put(viewOnlySession, ownBlock()).expect(403);
  });

  // -------------------------------------------------------------------------
  // The organisation boundary
  // -------------------------------------------------------------------------

  /**
   * There is no organisation in the path: the block is always the active tenant's. So
   * the isolation is not a refusal but an impossibility — and the case worth
   * writing is that organisation A's save does not reach Organisation B.
   */
  it('writes only the organisation of the session', async () => {
    await put(alphaSession, ownBlock()).expect(200);

    expect((await get(betaSession)).body).toStrictEqual({ smtp: null });
    const row = await prisma.tenant.findUniqueOrThrow({
      where: { id: beta.id },
      select: { smtp: true },
    });
    expect(row.smtp).toBeNull();
  });
});

/** The sealed password inside a stored block, for a bytes-for-bytes compare. */
function passwordOf(stored: Prisma.JsonValue | null): string | null {
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) {
    return null;
  }
  const auth = (stored as Record<string, Prisma.JsonValue>).auth;
  if (auth === null || typeof auth !== 'object' || Array.isArray(auth)) {
    return null;
  }
  const password = (auth as Record<string, Prisma.JsonValue>).password;
  return typeof password === 'string' ? password : null;
}
