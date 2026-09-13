import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { PrismaService } from '../../src/prisma/prisma.service';
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
 * The reply address of an organisation — **who may touch it, and whose row is
 * hit in doing so** .
 *
 * This file is the proof that the Reply-To package was missing: its only
 * access to `/api/tenant/reply-to` was a `PUT` as an admin, that is, exactly
 * the *permitted* case. Deleting both `@RequireAllPermissions` lines of the
 * controller would have yielded a green suite — and so none of it proved a
 * permission rule (`CONTRIBUTING.md`: „ein Test, der nur den erlaubten Zugriff prüft, belegt nichts").
 *
 * Built after `tenant-base-url.spec.ts`, because the neighbouring route has the
 * same position, the same two permissions and the same organisation boundary.
 * What stands here and not there is the header proof — that one lies in
 * `apps/api/test/mail/reply-to.spec.ts` against a real SMTP server; here it is
 * only about the gate in front of it.
 *
 * *Reproduction, measured (2026-08-04):* remove one of the two
 * `@RequireAllPermissions` lines at a time — separate cases of this file each
 * turn red (see the comments on the two refusal cases).
 */

const REPLY_TO_PATH = '/tenant/reply-to';

const ALPHA_REPLY_TO = 'geschaeftsstelle@alpha.invalid';
const BETA_REPLY_TO = 'kanzlei@beta.invalid';
/** What must never land in a column — the value that gets turned away. */
const SNEAKED = 'eingeschmuggelt@example.invalid';

describe('the organisation’s own Reply-To address, through its route', () => {
  let database: TestDatabase | undefined;
  let testApp: TestApp | undefined;
  let prisma: PrismaService;

  let alpha: TenantFixture;
  let beta: TenantFixture;
  let alphaSession: string;
  let betaSession: string;
  /** All permissions but `can_view_responses` — one half of the pair. */
  let settingsOnlySession: string;
  /** The other half — all permissions but `can_manage_settings`. */
  let viewOnlySession: string;

  function app(): TestApp {
    if (testApp === undefined) {
      throw new Error('no test app');
    }
    return testApp;
  }

  function get(session: string): request.Test {
    return request(app().server)
      .get(apiPath(REPLY_TO_PATH))
      .set('Cookie', cookieHeader(session));
  }

  function put(session: string, body: unknown): request.Test {
    return request(app().server)
      .put(apiPath(REPLY_TO_PATH))
      .set(authedMutation(session))
      .send(body as object);
  }

  /** The column itself — what is looked up past the route. */
  async function storedReplyTo(tenantId: string): Promise<string | null> {
    const row = await prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { replyTo: true },
    });
    return row.replyTo;
  }

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });
    prisma = testApp.prisma;

    alpha = await createTenant(prisma, 'RTOA');
    beta = await createTenant(prisma, 'RTOB');

    const alphaAdmin = await createUser(prisma, {
      email: 'admin@rtoa.example.org',
      password: 'test-password',
      tenants: [alpha],
    });
    alphaSession = await openSession(app(), alphaAdmin.id, alpha.id);

    const betaAdmin = await createUser(prisma, {
      email: 'admin@rtob.example.org',
      password: 'test-password',
      tenants: [beta],
    });
    betaSession = await openSession(app(), betaAdmin.id, beta.id);

    const settingsOnly = await createRestrictedMember(prisma, alpha, {
      email: 'settings@rtoa.example.org',
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
      email: 'view@rtoa.example.org',
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
  }, 180_000);

  afterAll(async () => {
    await testApp?.close();
    await database?.release();
  });

  beforeEach(async () => {
    await prisma.tenant.updateMany({ data: { replyTo: null } });
  });

  // -------------------------------------------------------------------------
  // The round trip
  // -------------------------------------------------------------------------

  it('reads null on an organisation that never set one — die Vorgabe gilt', async () => {
    const response = await get(alphaSession);

    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({ replyTo: null });
  });

  it('sets an own address and reads it back', async () => {
    const written = await put(alphaSession, { replyTo: ALPHA_REPLY_TO });

    expect(written.status).toBe(200);
    expect(written.body).toStrictEqual({ replyTo: ALPHA_REPLY_TO });
    expect((await get(alphaSession)).body).toStrictEqual({
      replyTo: ALPHA_REPLY_TO,
    });
    expect(await storedReplyTo(alpha.id)).toBe(ALPHA_REPLY_TO);
  });

  it('clearing it is the inheritance, not an empty header', async () => {
    await put(alphaSession, { replyTo: ALPHA_REPLY_TO }).expect(200);

    const cleared = await put(alphaSession, { replyTo: null });

    expect(cleared.status).toBe(200);
    expect(cleared.body).toStrictEqual({ replyTo: null });
    expect(await storedReplyTo(alpha.id)).toBeNull();
  });

  // -------------------------------------------------------------------------
  // What the route does not accept — the check is the one of the sender address
  // -------------------------------------------------------------------------

  /**
   * `Name <adresse>` is the form that would turn into a second header line at
   * the sender; `replyToAddressSchema` **is** `smtpBlockSchema.shape.from`, so
   * it is refused here by the same rule, not by a second
   * opinion. The empty string stands next to it because it is the most likely
   * slip of a user interface that means „löschen": it is **no**
   * deletion, `null` is.
   */
  it('refuses what is not a bare address, names the field, and stores nothing', async () => {
    for (const bad of [
      'Max <max@example.org>',
      'a@example.org, b@example.org',
      'kein-at-zeichen',
      '',
    ]) {
      const response = await put(alphaSession, { replyTo: bad });

      expect(response.status, bad).toBe(400);
      expect(response.body).toMatchObject({ issues: [{ path: 'replyTo' }] });
    }

    expect(await storedReplyTo(alpha.id)).toBeNull();
  });

  /**
   * **A `PUT` without the key deletes nothing — it is refused.**
   *
   * The field is required and nullable, explicitly without a default value
   * (`notificationWriteShape`/`tenantReplyToWriteSchema` in `@formsache/shared`): the
   * route replaces the whole document, and an omittable key would mean
   * that a second write path silently deletes a configured address.
   *
   * *Reproduction, measured (2026-08-04):* give `replyTo` in
   * `tenantReplyToWriteSchema` a `.default(null)` — this case turns
   * red (200 instead of 400, and the address is gone).
   */
  it('refuses a PUT that omits the key, and leaves the address standing', async () => {
    await put(alphaSession, { replyTo: ALPHA_REPLY_TO }).expect(200);

    const response = await put(alphaSession, {});

    expect(response.status).toBe(400);
    expect(await storedReplyTo(alpha.id)).toBe(ALPHA_REPLY_TO);
    expect((await get(alphaSession)).body).toStrictEqual({
      replyTo: ALPHA_REPLY_TO,
    });
  });

  // -------------------------------------------------------------------------
  // Who may — the same two permissions the neighbouring route demands
  // -------------------------------------------------------------------------

  it('lets an admin of the active Organisation read and write it', async () => {
    await get(alphaSession).expect(200);
    await put(alphaSession, { replyTo: ALPHA_REPLY_TO }).expect(200);
  });

  /**
   * *Reproduction, measured (2026-08-04):* remove `'canViewResponses'` from the
   * two `@RequireAllPermissions` lines of the controller — this case
   * turns red (200/200 instead of 403/403).
   */
  it('refuses a member who may configure but may not see responses, and changes nothing', async () => {
    await put(alphaSession, { replyTo: ALPHA_REPLY_TO }).expect(200);

    const read = await get(settingsOnlySession);
    const write = await put(settingsOnlySession, { replyTo: SNEAKED });

    expect(read.status).toBe(403);
    expect(write.status).toBe(403);
    expect(await storedReplyTo(alpha.id)).toBe(ALPHA_REPLY_TO);
  });

  /**
   * *Reproduction, measured (2026-08-04):* remove `'canManageSettings'` from
   * the two `@RequireAllPermissions` lines — this case turns red.
   */
  it('refuses a member who may see responses but may not configure, and changes nothing', async () => {
    await put(alphaSession, { replyTo: ALPHA_REPLY_TO }).expect(200);

    const read = await get(viewOnlySession);
    const write = await put(viewOnlySession, { replyTo: SNEAKED });

    expect(read.status).toBe(403);
    expect(write.status).toBe(403);
    expect(await storedReplyTo(alpha.id)).toBe(ALPHA_REPLY_TO);
  });

  it('refuses a request without a session at all', async () => {
    await request(app().server).get(apiPath(REPLY_TO_PATH)).expect(401);
    await request(app().server)
      .put(apiPath(REPLY_TO_PATH))
      .send({ replyTo: SNEAKED })
      .expect(401);

    expect(await storedReplyTo(alpha.id)).toBeNull();
  });

  // -------------------------------------------------------------------------
  // The organisation boundary — there is no organisation in the path, the row
  // addressed is always the one of the session. So what has to be proven is
  // that it stays that way.
  // -------------------------------------------------------------------------

  it('writes only the organisation of the session, and the other one keeps reading its own', async () => {
    await put(alphaSession, { replyTo: ALPHA_REPLY_TO }).expect(200);

    expect((await get(betaSession)).body).toStrictEqual({ replyTo: null });
    expect(await storedReplyTo(beta.id)).toBeNull();

    await put(betaSession, { replyTo: BETA_REPLY_TO }).expect(200);

    expect((await get(alphaSession)).body).toStrictEqual({
      replyTo: ALPHA_REPLY_TO,
    });
    expect((await get(betaSession)).body).toStrictEqual({
      replyTo: BETA_REPLY_TO,
    });
    expect(await storedReplyTo(alpha.id)).toBe(ALPHA_REPLY_TO);
    expect(await storedReplyTo(beta.id)).toBe(BETA_REPLY_TO);
  });
});
