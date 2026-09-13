import { randomBytes } from 'node:crypto';

import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { MailSecretsService } from '../../src/mail/mail-secrets.service';
import { SYSTEM_SETTING_ID } from '../../src/system-settings/system-settings.repository';
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
  createTenant,
  createUser,
  type TenantFixture,
} from '../support/fixtures';
import { authedMutation, cookieHeader, openSession } from '../support/http';

/**
 * The superadmin's write path onto `system_setting.smtp` and
 * `system_setting.public_base_url` — the requirements.
 *
 * Until this package the row's mail columns could only be written with a raw
 * `prisma`/SQL call, which is exactly what the requirements rule out ("ohne SQL, ohne
 * Seed-Trick, ohne Handgriff am JSONB"). What is proved here is that the
 * route writes what it says it writes, refuses what it says it refuses, never
 * hands the password back, and never loses a stored one on an unrelated edit.
 */

const PASSWORD = 'test-password';
const MAIL_PATH = apiPath('/admin/system-settings/mail');

/** A value that cannot turn up in output by accident. */
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

interface MailSettingsBody {
  values: {
    smtp: {
      host: string;
      port: number;
      secure: boolean;
      authUser: string | null;
      from: string;
    } | null;
    publicBaseUrl: string | null;
    replyTo: string | null;
  };
  lock: number;
}

/** The keys the requirement's positive-list proof allows, and no others. */
const MAIL_VALUES_KEYS = ['opsAlertEmail', 'publicBaseUrl', 'replyTo', 'smtp'];
const SMTP_KEYS = ['authUser', 'from', 'host', 'port', 'secure'];

describe('the installation mail server and base address ', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  let tenant: TenantFixture;
  let superadmin: string;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });

    tenant = await createTenant(testApp.prisma, 'MAIA');
    const root = await createUser(testApp.prisma, {
      email: 'root@example.org',
      password: PASSWORD,
      isSuperadmin: true,
    });
    superadmin = await openSession(testApp, root.id, tenant.id);
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  afterEach(async () => {
    await app().prisma.systemSetting.deleteMany({});
  });

  function secrets(): MailSecretsService {
    return app().app.get(MailSecretsService);
  }

  function read(session = superadmin): Promise<request.Response> {
    return request(app().server)
      .get(MAIL_PATH)
      .set('Cookie', cookieHeader(session));
  }

  function write(
    body: Record<string, unknown>,
    session = superadmin,
  ): Promise<request.Response> {
    return request(app().server)
      .put(MAIL_PATH)
      .set(authedMutation(session))
      .send(body);
  }

  function fullSmtp(overrides: Record<string, unknown> = {}) {
    return {
      host: 'mail.example.org',
      port: 587,
      secure: false,
      auth: null,
      from: 'versand@example.org',
      ...overrides,
    };
  }

  /** The stored `smtp` column, straight from the database, as text. */
  async function rawSmtpColumn(): Promise<string | null> {
    const rows = await app().prisma.$queryRaw<
      { smtp: string | null }[]
    >`SELECT smtp::text AS "smtp" FROM "system_setting" WHERE id = ${SYSTEM_SETTING_ID}`;
    return rows[0]?.smtp ?? null;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Reading a row that does not exist
  // ═════════════════════════════════════════════════════════════════════════

  it('answers "nicht eingerichtet" and a usable lock on a fresh installation', async () => {
    const page = await read();

    expect(page.status).toBe(200);
    const body = page.body as MailSettingsBody;
    expect(body.values).toEqual({
      smtp: null,
      publicBaseUrl: null,
      replyTo: null,
      opsAlertEmail: null,
    });
    // The number `mail_revision` will start at — never `null`, so the first
    // write always has a lock to name (`INITIAL_MAIL_REVISION`).
    expect(body.lock).toBe(1);
    expect(await app().prisma.systemSetting.count()).toBe(0);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // The allow list: the password never comes back, in any spelling
  // ═════════════════════════════════════════════════════════════════════════

  describe('the password never leaves the server', () => {
    it('answers with only the documented keys, on the GET', async () => {
      const secret = mintSecret('read');
      const written = await write({
        smtp: fullSmtp({ auth: { user: 'versand', password: secret } }),
        publicBaseUrl: null,
        replyTo: null,
        opsAlertEmail: null,
        lock: 1,
      });
      expect(written.status).toBe(200);

      const page = await read();
      expect(page.status).toBe(200);
      const body = page.body as MailSettingsBody;
      expect(Object.keys(body.values).sort()).toEqual(MAIL_VALUES_KEYS);
      expect(
        body.values.smtp === null ? [] : Object.keys(body.values.smtp).sort(),
      ).toEqual(SMTP_KEYS);
      expect(body.values.smtp?.authUser).toBe('versand');

      for (const { label, value } of spellings(secret)) {
        expect(page.text, `Passwort ${label} in der Leseantwort`).not.toContain(
          value,
        );
      }
    });

    it('answers with only the documented keys, on the PUT that set it', async () => {
      const secret = mintSecret('write');
      const written = await write({
        smtp: fullSmtp({ auth: { user: 'versand', password: secret } }),
        publicBaseUrl: null,
        replyTo: null,
        opsAlertEmail: null,
        lock: 1,
      });

      expect(written.status).toBe(200);
      const body = written.body as MailSettingsBody;
      expect(Object.keys(body.values).sort()).toEqual(MAIL_VALUES_KEYS);
      expect(
        body.values.smtp === null ? [] : Object.keys(body.values.smtp).sort(),
      ).toEqual(SMTP_KEYS);

      for (const { label, value } of spellings(secret)) {
        expect(
          written.text,
          `Passwort ${label} in der Schreibantwort`,
        ).not.toContain(value);
      }
    });

    it('is not stored in the clear, in any of the three encodings', async () => {
      const secret = mintSecret('column');
      await write({
        smtp: fullSmtp({ auth: { user: 'versand', password: secret } }),
        publicBaseUrl: null,
        replyTo: null,
        opsAlertEmail: null,
        lock: 1,
      });

      const raw = await rawSmtpColumn();
      expect(raw).not.toBeNull();
      expect(raw ?? '').toMatch(/formsache1\./);

      for (const { label, value } of spellings(secret)) {
        expect(raw ?? '', `Passwort ${label} in der Spalte`).not.toContain(
          value,
        );
      }
      expect(raw ?? '').not.toContain(Buffer.from(secret).toString('hex'));

      // …and it really opens, through the same service the worker uses —
      // otherwise the assertions above would also pass for a service that
      // seals nothing usable at all.
      const opened = secrets().openSystemBlock(
        JSON.parse(raw ?? 'null') as unknown,
      );
      expect(opened?.auth?.password).toBe(secret);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // The block is indivisible: half-filled is refused, naming the field
  // ═════════════════════════════════════════════════════════════════════════

  describe('a half-filled block is refused', () => {
    it('refuses a block missing an ordinary field, naming it', async () => {
      const half: Record<string, unknown> = fullSmtp();
      delete half.port;

      const refused = await write({
        smtp: half,
        publicBaseUrl: null,
        replyTo: null,
        opsAlertEmail: null,
        lock: 1,
      });

      expect(refused.status).toBe(400);
      expect(JSON.stringify(refused.body)).toContain('port');
      expect(await app().prisma.systemSetting.count()).toBe(0);
    });

    it('refuses `auth: { user }` without a password on a fresh installation', async () => {
      const refused = await write({
        smtp: fullSmtp({ auth: { user: 'versand' } }),
        publicBaseUrl: null,
        replyTo: null,
        opsAlertEmail: null,
        lock: 1,
      });

      expect(refused.status).toBe(400);
      expect(JSON.stringify(refused.body)).toContain('password');
      expect(await app().prisma.systemSetting.count()).toBe(0);
    });

    it('does not accept the mixture the shared schema is meant to reject either', async () => {
      // A control for the evidence's own claim: an object shape without the
      // union's required fields is refused, not silently completed.
      const refused = await write({
        smtp: { from: 'nur-adresse@example.org' },
        publicBaseUrl: null,
        replyTo: null,
        opsAlertEmail: null,
        lock: 1,
      });
      expect(refused.status).toBe(400);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // The load-bearing guarantee: omitting the password keeps the stored one
  // ═════════════════════════════════════════════════════════════════════════

  describe('a write without the password field', () => {
    it('keeps the stored password, and the block still opens', async () => {
      const secret = mintSecret('kept');
      const first = await write({
        smtp: fullSmtp({ auth: { user: 'versand', password: secret } }),
        publicBaseUrl: null,
        replyTo: null,
        opsAlertEmail: null,
        lock: 1,
      });
      expect(first.status).toBe(200);
      const firstBody = first.body as MailSettingsBody;

      // A second save that changes the host, but keeps the same user and
      // does not type the password again — the ordinary case named in the
      // assignment. Changing the *user* without the password is its own
      // case, covered separately (the requirement of a review).
      const second = await write({
        smtp: fullSmtp({
          host: 'mail2.example.org',
          auth: { user: 'versand' },
        }),
        publicBaseUrl: null,
        replyTo: null,
        opsAlertEmail: null,
        lock: firstBody.lock,
      });

      expect(second.status).toBe(200);
      const secondBody = second.body as MailSettingsBody;
      expect(secondBody.values.smtp).toMatchObject({
        host: 'mail2.example.org',
        authUser: 'versand',
      });

      // The round trip: the password nobody retyped is still there, and it
      // is still the one that was set originally.
      const raw = await rawSmtpColumn();
      const opened = secrets().openSystemBlock(
        JSON.parse(raw ?? 'null') as unknown,
      );
      expect(opened?.auth?.user).toBe('versand');
      expect(opened?.auth?.password).toBe(secret);

      for (const { label, value } of spellings(secret)) {
        expect(
          JSON.stringify(secondBody),
          `Passwort ${label} in der zweiten Antwort`,
        ).not.toContain(value);
      }
    });

    /**
     * A finding of a review — the case the test above used to fold into
     * "kept", which it is not: the stored ciphertext was sealed for the
     * *previous* user, and pairing it with a new one is a login nobody typed.
     */
    it('refuses a changed user without a new password, naming the field', async () => {
      const secret = mintSecret('user-wechsel');
      const first = await write({
        smtp: fullSmtp({ auth: { user: 'versand', password: secret } }),
        publicBaseUrl: null,
        replyTo: null,
        opsAlertEmail: null,
        lock: 1,
      });
      expect(first.status).toBe(200);
      const firstBody = first.body as MailSettingsBody;

      const refused = await write({
        smtp: fullSmtp({ auth: { user: 'versand-neu' } }),
        publicBaseUrl: null,
        replyTo: null,
        opsAlertEmail: null,
        lock: firstBody.lock,
      });

      expect(refused.status).toBe(400);
      expect(JSON.stringify(refused.body)).toContain('smtp.auth.password');

      // Nothing was written: the stored block still opens with the old user
      // and the old password.
      const raw = await rawSmtpColumn();
      const opened = secrets().openSystemBlock(
        JSON.parse(raw ?? 'null') as unknown,
      );
      expect(opened?.auth?.user).toBe('versand');
      expect(opened?.auth?.password).toBe(secret);
    });

    it('a relay without a login stays without a login across an edit', async () => {
      const first = await write({
        smtp: fullSmtp({ auth: null }),
        publicBaseUrl: null,
        replyTo: null,
        opsAlertEmail: null,
        lock: 1,
      });
      const firstBody = first.body as MailSettingsBody;

      const second = await write({
        smtp: fullSmtp({ host: 'anderer-server.example.org', auth: null }),
        publicBaseUrl: null,
        replyTo: null,
        opsAlertEmail: null,
        lock: firstBody.lock,
      });

      expect(second.status).toBe(200);
      expect((second.body as MailSettingsBody).values.smtp).toMatchObject({
        host: 'anderer-server.example.org',
        authUser: null,
      });
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // The base address is independent (ADR-0013 no. 3)
  // ═════════════════════════════════════════════════════════════════════════

  it('sets the base address without needing a mail server at all', async () => {
    const written = await write({
      smtp: null,
      publicBaseUrl: 'https://formulare.example.org/',
      replyTo: null,
      opsAlertEmail: null,
      lock: 1,
    });

    expect(written.status).toBe(200);
    const body = written.body as MailSettingsBody;
    expect(body.values).toEqual({
      smtp: null,
      publicBaseUrl: 'https://formulare.example.org',
      replyTo: null,
      opsAlertEmail: null,
    });
  });

  it('removes a configured block, leaving the base address untouched', async () => {
    const first = await write({
      smtp: fullSmtp({ auth: null }),
      publicBaseUrl: 'https://formulare.example.org',
      replyTo: null,
      opsAlertEmail: null,
      lock: 1,
    });
    const firstBody = first.body as MailSettingsBody;

    const second = await write({
      smtp: null,
      publicBaseUrl: 'https://formulare.example.org',
      replyTo: null,
      opsAlertEmail: null,
      lock: firstBody.lock,
    });

    expect(second.status).toBe(200);
    expect((second.body as MailSettingsBody).values).toEqual({
      smtp: null,
      publicBaseUrl: 'https://formulare.example.org',
      replyTo: null,
      opsAlertEmail: null,
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // The optimistic lock
  // ═════════════════════════════════════════════════════════════════════════

  describe('two superadmins, one row', () => {
    it('refuses a second save sent after the first already moved the lock', async () => {
      await write({
        smtp: fullSmtp({ auth: null }),
        publicBaseUrl: null,
        replyTo: null,
        opsAlertEmail: null,
        lock: 1,
      });

      // Sent with the *original* lock again — the shape of a client that
      // never re-read the page after the first save went through.
      const stale = await write({
        smtp: fullSmtp({ host: 'zu-spaet.example.org', auth: null }),
        publicBaseUrl: null,
        replyTo: null,
        opsAlertEmail: null,
        lock: 1,
      });

      expect(stale.status).toBe(409);
      const raw = await rawSmtpColumn();
      expect(raw ?? '').not.toContain('zu-spaet');
    });

    it('lets exactly one of two fresh writes create the row', async () => {
      const [first, second] = await Promise.all([
        write({
          smtp: null,
          publicBaseUrl: 'https://erster.example.org',
          replyTo: null,
          opsAlertEmail: null,
          lock: 1,
        }),
        write({
          smtp: null,
          publicBaseUrl: 'https://zweiter.example.org',
          replyTo: null,
          opsAlertEmail: null,
          lock: 1,
        }),
      ]);

      const statuses = [first.status, second.status].sort((a, b) => a - b);
      expect(statuses).toEqual([200, 409]);
      expect(await app().prisma.systemSetting.count()).toBe(1);
    });

    /**
     * A finding of a review — the race the two tests above do not measure.
     * Both of them start from "no row" (`createMany`/`skipDuplicates`), never
     * from a **genuinely non-null, already-stored** lock two readers raced on
     * (`updateMany` with `mailRevision: expectedRevision`). This is the case
     * `updated_at` could not safely guard at all: two writes racing in the
     * same millisecond would have compared equal and both matched. A plain
     * integer cannot land "in between" another integer, so exactly one of
     * two concurrent writers starting from the same stored revision may win.
     */
    it('lets exactly one of two writes starting from the same stored, non-null lock through', async () => {
      const seed = await write({
        smtp: fullSmtp({ auth: null }),
        publicBaseUrl: null,
        replyTo: null,
        opsAlertEmail: null,
        lock: 1,
      });
      expect(seed.status).toBe(200);
      const sharedLock = (seed.body as MailSettingsBody).lock;
      expect(sharedLock).toBeGreaterThan(1);

      const [first, second] = await Promise.all([
        write({
          smtp: fullSmtp({ host: 'erster-gewinnt.example.org', auth: null }),
          publicBaseUrl: null,
          replyTo: null,
          opsAlertEmail: null,
          lock: sharedLock,
        }),
        write({
          smtp: fullSmtp({ host: 'zweiter-gewinnt.example.org', auth: null }),
          publicBaseUrl: null,
          replyTo: null,
          opsAlertEmail: null,
          lock: sharedLock,
        }),
      ]);

      const statuses = [first.status, second.status].sort((a, b) => a - b);
      expect(statuses).toEqual([200, 409]);

      // Exactly one host made it into the column — never a merge of both,
      // and never neither.
      const raw = await rawSmtpColumn();
      const wonWithFirst = (raw ?? '').includes('erster-gewinnt');
      const wonWithSecond = (raw ?? '').includes('zweiter-gewinnt');
      expect(wonWithFirst !== wonWithSecond).toBe(true);
    });

    it('starts the lock where a fresh installation starts it', async () => {
      // There once was a second write path onto the same row here — the
      // *form standards* of the installation —, and this case recorded that
      // it does not move the mail counter. That path no longer exists
      // (ADR-0011, continuation 2026-08-14); what remains is the counter
      // itself: `INITIAL_MAIL_REVISION`, before anybody has written.
      const page = await read();
      expect(page.status).toBe(200);
      const lock = (page.body as MailSettingsBody).lock;
      expect(lock).toBe(1);

      const written = await write({
        smtp: null,
        publicBaseUrl: 'https://frische-installation.example.org',
        replyTo: null,
        opsAlertEmail: null,
        lock,
      });
      expect(written.status).toBe(200);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // No CSRF exemption, no session — the posture of every superadmin route
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * **The operator address for operations alerts has a write path** — and
   * this case is the proof of it.
   *
   * ⚠️ **Why this case exists.** The column `ops_alert_email` came into being
   * together with the guard that reads it — but **nothing** wrote
   * it: no controller, no seed, no variable. On every real
   * installation the guard reported „keine Adresse konfiguriert" and
   * sent nothing, while `ops-alert-delivery.spec.ts` was green because it set
   * the column itself. A review found it; until then this point was
   * ticked off.
   *
   * It is therefore measured **through the route**: write into it, read it
   * back out, and look in the column.
   *
   * *Reproduction:* take `opsAlertEmail` out of `writeMail` → this case turns
   * red, and the alert would be a declaration of intent again.
   */
  it('writes and returns the operator address for ops alerts ', async () => {
    const before = await read();
    const written = await write({
      smtp: null,
      publicBaseUrl: null,
      replyTo: null,
      opsAlertEmail: 'betrieb@example.org',
      lock: (before.body as { lock: number }).lock,
    });
    expect(written.status).toBe(200);
    expect(written.body).toMatchObject({
      values: { opsAlertEmail: 'betrieb@example.org' },
    });

    // And it really stands in the column the guard reads — not only in the
    // response.
    const row = await app().prisma.systemSetting.findUnique({
      where: { id: 'x' },
      select: { opsAlertEmail: true },
    });
    expect(row?.opsAlertEmail).toBe('betrieb@example.org');

    // `null` takes it back: "nobody" is a state, not an oversight.
    const cleared = await write({
      smtp: null,
      publicBaseUrl: null,
      replyTo: null,
      opsAlertEmail: null,
      lock: (written.body as { lock: number }).lock,
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ values: { opsAlertEmail: null } });
  });

  /**
   * An invented address is rejected — the same check as with the two address
   * fields next to it, no third version.
   */
  it('refuses an ops alert address that is not one', async () => {
    const before = await read();
    const written = await write({
      smtp: null,
      publicBaseUrl: null,
      replyTo: null,
      opsAlertEmail: 'kein-at-zeichen',
      lock: (before.body as { lock: number }).lock,
    });
    expect(written.status).toBe(400);
  });

  it('refuses an unauthenticated caller with 401, on both routes', async () => {
    expect((await request(app().server).get(MAIL_PATH)).status).toBe(401);

    const written = await request(app().server)
      .put(MAIL_PATH)
      .send({ smtp: null, publicBaseUrl: null, replyTo: null, lock: 1 });
    expect([401, 403]).toContain(written.status);
    expect(await app().prisma.systemSetting.count()).toBe(0);
  });
});
