import { randomBytes, randomUUID } from 'node:crypto';

import {
  REDACTED_PASSWORD,
  SYSTEM_FORM_SETTINGS,
  type FormSettings,
} from '@formsache/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FORM_NOT_FOUND_MESSAGE } from '../../src/forms/forms.service';
import { STALE_SETTINGS_MESSAGE } from '../../src/settings/form-settings.service';
import { MISSING_PERMISSION_MESSAGE } from '../../src/tenancy/group-permission.guard';
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
import { NO_SECTIONS } from '../support/settings-sections';

/**
 * The requirements (persistence) and (`can_manage_settings`) against real
 * PostgreSQL.
 *
 * Written the way `CONTRIBUTING.md` demands of a rights or isolation rule: every
 * guarantee is asserted through the case that must **fail**. Each permission
 * appears as a pair — without the flag 403, with it 200 — because a suite of
 * only the allowed half would stay green under a guard that refuses nobody.
 *
 * **Negative probe, measured while writing this file.** Removing
 * `@RequirePermission(…)` from the four routes turns exactly the four pairs
 * plus "reads the permissions of the active tenant" red and nothing else.
 * Since ADR-0021 there are **two** permissions: `can_manage_form_settings` on
 * the form routes, `can_manage_settings` on those of the organisation.
 * Replacing the one with the other turns the crosswise built pair in
 * "can_manage_form_settings ≠ can_manage_settings" red — and that in both
 * directions, which is the point of it. Removing `tenantId` from
 * `ScopedFormDelegate.findSettingsById` turns the read-boundary test red and
 * hands SETB SETA's deadline; putting `.prefault(false)` back on the write
 * schema turns "refuses a write that names fewer than four sections" red and
 * silently deletes a sealed access word.
 *
 * **What is deliberately not here: enforcement.** A deadline stored by these
 * tests closes nothing, a limit refuses nothing, an access word guards nothing
 * — that is a separate concern, with its own requirements and its own proofs. This file proves
 * that the decision is stored, inherited and reachable only by the right people.
 */

const PASSWORD = 'test-password';

/** A minimal but real definition — one page, one required text question. */
function definition() {
  return {
    pages: [
      {
        id: '019fe000-0000-7000-8000-0000000000a0',
        title: 'Seite 1',
        questions: [
          {
            id: '019fe000-0000-7000-8000-000000000001',
            type: 'text',
            label: 'Name',
            hint: null,
            required: true,
            width: 'full',
            minLength: null,
            maxLength: null,
            pattern: null,
          },
        ],
      },
    ],
  };
}

/** The shape the settings routes answer with — parsed, not asserted about. */
interface SettingsBody {
  overridden: Record<string, boolean>;
  values: Record<string, unknown>;
  tenantDefaults: FormSettings;
  effective: FormSettings;
  revision: number;
  tenantRevision: number;
}

/** What a write has to name so it cannot overwrite a state nobody saw. */
interface Revisions {
  readonly revision?: number;
  readonly tenantRevision?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The **stored** — that is, sealed — access word of a tenant standard, or
 * `undefined` when the document carries none.
 *
 * Reaching into the raw column on purpose: these assertions are about what sits
 * in PostgreSQL, which is the one thing the API by definition cannot show.
 */
function storedPassword(document: unknown): string | undefined {
  const password = isRecord(document) ? document.password : undefined;
  return typeof password === 'string' ? password : undefined;
}

/** The same, one level down — a form override keeps its values in `values`. */
function storedOverridePassword(document: unknown): string | undefined {
  return storedPassword(isRecord(document) ? document.values : undefined);
}

/**
 * The headers of a response, minus the ones that legitimately differ per call.
 *
 * `date` ticks, and the others are compared verbatim — that is the point: two
 * answers that must be indistinguishable have to be indistinguishable in
 * `content-length` and `etag` as well, not only in their body.
 */
function comparableHeaders(
  response: request.Response,
): Record<string, unknown> {
  const headers = response.headers as Record<string, unknown>;
  return Object.fromEntries(
    // `date` moves with the clock; `x-request-id` is **random per request**
    // and therefore gives away nothing about the occasion of the answer — the
    // assurance here is indistinguishability of the *reasons*, not equality
    // byte for byte.
    Object.entries(headers).filter(
      ([name]) => name !== 'date' && name !== 'x-request-id',
    ),
  );
}

describe('form settings ', () => {
  let testApp: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  /** A third Organisation, so the inheritance tests can move a standard around
   * without disturbing the boundary and permission fixtures. */
  let gamma: TenantFixture;
  let alphaAdmin: string;
  let betaAdmin: string;
  let gammaAdmin: string;
  let database: TestDatabase | undefined;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });

    alpha = await createTenant(testApp.prisma, 'SETA');
    beta = await createTenant(testApp.prisma, 'SETB');
    gamma = await createTenant(testApp.prisma, 'SETC');

    const alphaUser = await createUser(testApp.prisma, {
      email: 'settings-alpha@example.org',
      password: PASSWORD,
      tenants: [alpha],
    });
    const betaUser = await createUser(testApp.prisma, {
      email: 'settings-beta@example.org',
      password: PASSWORD,
      tenants: [beta],
    });
    const gammaUser = await createUser(testApp.prisma, {
      email: 'settings-gamma@example.org',
      password: PASSWORD,
      tenants: [gamma],
    });

    alphaAdmin = await openSession(testApp, alphaUser.id, alpha.id);
    betaAdmin = await openSession(testApp, betaUser.id, beta.id);
    gammaAdmin = await openSession(testApp, gammaUser.id, gamma.id);
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  /** Creates a form through the real route and returns its id. */
  async function createForm(token: string, title: string): Promise<string> {
    const response = await request(app().server)
      .post(apiPath('/forms'))
      .set(authedMutation(token))
      .send({ title });
    expect(response.status).toBe(201);
    return (response.body as { id: string }).id;
  }

  /**
   * A form exactly as it looked before this feature existed.
   *
   * The insert names **only the columns that existed then**, so `settings_override` takes
   * its column default — which is byte for byte what
   * `ALTER TABLE … ADD COLUMN … DEFAULT '{}'` leaves on every row that already
   * existed. That is the whole point of the requirement's "no backfill needed
   * and none made": a form nobody has ever configured must *mean* something,
   * not merely fail to crash. Going through the API instead would prove nothing
   * — the API writes the new column.
   */
  async function legacyForm(
    tenant: TenantFixture,
    title: string,
  ): Promise<string> {
    const id = randomUUID();
    await app().prisma.$executeRawUnsafe(
      `INSERT INTO "form" (
         "id", "tenant_id", "title", "status", "draft_schema", "public_slug",
         "revision", "created_at", "updated_at"
       ) VALUES (
         $1::uuid, $2::uuid, $3, 'draft'::"form_status", $4::jsonb, $5,
         1, now(), now()
       )`,
      id,
      tenant.id,
      title,
      JSON.stringify(definition()),
      randomBytes(16).toString('base64url'),
    );
    return id;
  }

  async function readSettings(
    token: string,
    formId: string,
  ): Promise<SettingsBody> {
    const response = await request(app().server)
      .get(apiPath(`/forms/${formId}/settings`))
      .set('Cookie', cookieHeader(token));
    expect(response.status).toBe(200);
    return response.body as SettingsBody;
  }

  /**
   * The counters as they stand right now, read from the database.
   *
   * From the row rather than through `GET`, because half the callers below are
   * members who are *not* allowed to read the settings — their write has to
   * carry a valid revision so that the 403 they get is the guard's answer and
   * not a conflict wearing its number.
   */
  async function currentRevisions(
    formId: string,
  ): Promise<{ revision: number; tenantRevision: number }> {
    const form = await app().prisma.form.findUniqueOrThrow({
      where: { id: formId },
      select: { settingsRevision: true, tenantId: true },
    });
    const tenant = await app().prisma.tenant.findUniqueOrThrow({
      where: { id: form.tenantId },
      select: { formDefaultsRevision: true },
    });
    return {
      revision: form.settingsRevision,
      tenantRevision: tenant.formDefaultsRevision,
    };
  }

  async function writeSettings(
    token: string,
    formId: string,
    // `object`, not `unknown`: supertest's `send` takes one, and every call
    // below sends a document. A body the *server* must reject is still an
    // object — the rejection is about its contents.
    body: object,
    revisions: Revisions = {},
  ): Promise<request.Response> {
    const current = await currentRevisions(formId);
    return request(app().server)
      .put(apiPath(`/forms/${formId}/settings`))
      .set(authedMutation(token))
      .send({
        revision: revisions.revision ?? current.revision,
        tenantRevision: revisions.tenantRevision ?? current.tenantRevision,
        ...body,
      });
  }

  async function tenantRevisionOf(tenantId: string): Promise<number> {
    const tenant = await app().prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { formDefaultsRevision: true },
    });
    return tenant.formDefaultsRevision;
  }

  /**
   * Writes the organisation's standards.
   *
   * **A patch, no switches** (review finding 10): an organisation carries
   * a complete set of values, and what changes is what gets written. The
   * cases that have this layer itself as their subject stand in
   * `tenant-sections.spec.ts`.
   */
  async function writeTenantDefaults(
    token: string,
    tenantId: string,
    values: Record<string, unknown>,
    revision?: number,
  ): Promise<request.Response> {
    return request(app().server)
      .put(apiPath('/tenant/form-defaults'))
      .set(authedMutation(token))
      .send({
        values,
        revision: revision ?? (await tenantRevisionOf(tenantId)),
      });
  }

  describe('persistence, and the backfill that was not made', () => {
    it('reads a form written before the migration as four sections on tenant default', async () => {
      const id = await legacyForm(alpha, 'Aus einer früheren Fassung');

      const settings = await readSettings(alphaAdmin, id);

      expect(settings.overridden).toEqual(NO_SECTIONS);
      expect(settings.values).toEqual({});
      // …and "on tenant standard" is not a label: what applies is exactly what
      // the organisation's standard says, which for an untouched Organisation is the system
      // default. A missing key must mean "no deadline", never `undefined`.
      expect(settings.effective).toEqual(SYSTEM_FORM_SETTINGS);
      expect(settings.effective.closeAt).toBeNull();
    });

    it('leaves the column of such a form untouched — the absence is the meaning', async () => {
      const id = await legacyForm(alpha, 'Unberührt');
      await readSettings(alphaAdmin, id);

      const row = await app().prisma.form.findUniqueOrThrow({ where: { id } });
      // Reading must not write. A read path that "repairs" the document would
      // be the backfill the requirement rules out, arriving one request at a time.
      expect(row.settingsOverride).toEqual({});
    });

    it('stores one section as taken over and leaves the other three inheriting', async () => {
      const id = await createForm(alphaAdmin, 'Ein Abschnitt');

      const written = await writeSettings(alphaAdmin, id, {
        // *Verfügbarkeit* no longer carries a switch: the values apply because
        // they stand in this form (ADR-0011, continuation 2026-08-14).
        overridden: { ...NO_SECTIONS, display: true },
        values: {
          openEnabled: true,
          closeAt: '2026-08-20T18:00:00.000Z',
          maxResponsesEnabled: true,
          maxResponses: 300,
          showProgress: false,
        },
      });
      expect(written.status).toBe(200);

      const settings = await readSettings(alphaAdmin, id);
      expect(settings.overridden).toEqual({ ...NO_SECTIONS, display: true });
      expect(settings.effective.closeAt).toBe('2026-08-20T18:00:00.000Z');
      expect(settings.effective.maxResponses).toBe(300);
      // The other three still read from the organisation.
      expect(settings.effective.confirmTitle).toBe(
        SYSTEM_FORM_SETTINGS.confirmTitle,
      );

      // And it is really in JSONB, not in a request-scoped cache.
      const row = await app().prisma.form.findUniqueOrThrow({ where: { id } });
      expect(JSON.stringify(row.settingsOverride)).toContain(
        '2026-08-20T18:00:00.000Z',
      );
    });

    /**
     * The requirement, case 1, observed through the API rather than through the
     * unit test: the organisation moves its standard and a form that never took the
     * section over moves with it — without being touched.
     */
    it('lets a changed tenant standard through to a form that inherits', async () => {
      const id = await createForm(gammaAdmin, 'Erbt');

      const changed = await writeTenantDefaults(gammaAdmin, gamma.id, {
        confirmTitle: 'Angekommen!',
        confirmMsg: 'Die Organisation meldet sich.',
      });
      expect(changed.status).toBe(200);

      const settings = await readSettings(gammaAdmin, id);
      expect(settings.tenantDefaults.confirmTitle).toBe('Angekommen!');
      expect(settings.effective.confirmTitle).toBe('Angekommen!');
      expect(settings.overridden.confirm).toBe(false);
    });

    /** Case 2: the same move does **not** reach a form that took it over. */
    it('leaves a taken-over section alone when the tenant standard moves', async () => {
      const id = await createForm(gammaAdmin, 'Angepasst');
      const taken = await writeSettings(gammaAdmin, id, {
        overridden: { ...NO_SECTIONS, confirm: true },
        values: { confirmTitle: 'Eigener Text' },
      });
      expect(taken.status).toBe(200);

      const changed = await writeTenantDefaults(gammaAdmin, gamma.id, {
        confirmTitle: 'Neuer Organisationstext',
      });
      expect(changed.status).toBe(200);

      const settings = await readSettings(gammaAdmin, id);
      expect(settings.tenantDefaults.confirmTitle).toBe(
        'Neuer Organisationstext',
      );
      expect(settings.effective.confirmTitle).toBe('Eigener Text');
    });

    /**
     * Case 4: switching back **discards**. Keeping the values would mean a
     * second switch-on silently resurrects numbers nobody remembers entering —
     * and the editor had shown them as gone.
     */
    it('discards the values of a section switched back to the tenant standard', async () => {
      const id = await createForm(alphaAdmin, 'Zurückgeschaltet');
      await writeSettings(alphaAdmin, id, {
        overridden: { ...NO_SECTIONS, display: true },
        values: { showProgress: false, showPageNumbers: false },
      });

      const back = await writeSettings(alphaAdmin, id, {
        overridden: NO_SECTIONS,
        values: {},
      });
      expect(back.status).toBe(200);

      const row = await app().prisma.form.findUniqueOrThrow({ where: { id } });
      // Not merely "no longer applied" — no longer *there*. A stale value in
      // the row is one that surprises whoever reads it next.
      expect(JSON.stringify(row.settingsOverride)).not.toContain(
        'showProgress',
      );
      expect((await readSettings(alphaAdmin, id)).effective.showProgress).toBe(
        true,
      );
    });

    /**
     * A locked section whose values the client still sends must leave no trace
     * . Rejecting the write instead would make an ordinary "save
     * everything on screen" fail for a section nobody was editing.
     */
    it('ignores values sent for a section that is not taken over', async () => {
      const id = await createForm(alphaAdmin, 'Gesperrter Abschnitt');

      const response = await writeSettings(alphaAdmin, id, {
        overridden: { ...NO_SECTIONS, display: true },
        values: { showProgress: false, confirmTitle: 'Darf nicht ankommen' },
      });
      expect(response.status).toBe(200);

      const row = await app().prisma.form.findUniqueOrThrow({ where: { id } });
      expect(JSON.stringify(row.settingsOverride)).not.toContain(
        'Darf nicht ankommen',
      );
      expect((await readSettings(alphaAdmin, id)).effective.confirmTitle).toBe(
        SYSTEM_FORM_SETTINGS.confirmTitle,
      );
    });

    it('refuses a document that contradicts itself and names the field', async () => {
      const id = await createForm(alphaAdmin, 'Widersprüchlich');

      const response = await writeSettings(alphaAdmin, id, {
        overridden: NO_SECTIONS,
        values: {
          openEnabled: true,
          openAt: '2026-08-20T18:00:00.000Z',
          closeAt: '2026-08-01T18:00:00.000Z',
        },
      });

      expect(response.status).toBe(400);
      expect(response.text).toContain('values.closeAt');

      const row = await app().prisma.form.findUniqueOrThrow({ where: { id } });
      expect(row.settingsOverride).toEqual({});
    });

    /**
     * The seam to the requirement: whatever else is true of the access word, this
     * write path must not put it into the database in clear. Asserted here
     * because this is the code that stores it — its own proofs elsewhere (key material,
     * logs, exports) live with the `SecretBoxService`.
     */
    it('stores the access word sealed, and hands it back to whoever may configure it', async () => {
      const id = await createForm(alphaAdmin, 'Zugangswort');
      const word = 'jahrestagung-2026-zugang';

      const written = await writeSettings(alphaAdmin, id, {
        overridden: { ...NO_SECTIONS, access: true },
        values: { passwordEnabled: true, password: word },
      });
      expect(written.status).toBe(200);

      const row = await app().prisma.form.findUniqueOrThrow({ where: { id } });
      expect(JSON.stringify(row.settingsOverride)).not.toContain(word);

      // …and it is still readable, which is the whole reason it is encrypted
      // rather than hashed (client decision, 2026-07-27).
      expect((await readSettings(alphaAdmin, id)).effective.password).toBe(
        word,
      );
    });

    it('refuses password protection without a word, before anyone stands in front of it', async () => {
      const id = await createForm(alphaAdmin, 'Schutz ohne Wort');

      // **An empty word, not a word of spaces**, and the difference is what
      // keeps this test about the rule it names. Since the
      // written word has to be at least `PASSWORD_MIN` characters, so `'   '`
      // is now refused by the *length* bound — this test would have stayed
      // green with the "password protection without a password" rule deleted.
      // Empty is deliberately allowed by that bound (it means "no word set"), so
      // the only thing left that can refuse this document is
      // `checkSettingsConsistency`.
      const response = await writeSettings(alphaAdmin, id, {
        overridden: { ...NO_SECTIONS, access: true },
        values: { passwordEnabled: true, password: '' },
      });

      expect(response.status).toBe(400);
      expect(response.text).toContain('values.password');
    });

    it('seals the access word of the tenant standard as well', async () => {
      const word = 'organisationsweites-zugangswort';
      const written = await writeTenantDefaults(betaAdmin, beta.id, {
        passwordEnabled: true,
        password: word,
      });
      expect(written.status).toBe(200);

      const row = await app().prisma.tenant.findUniqueOrThrow({
        where: { id: beta.id },
      });
      // Not in clear …
      expect(JSON.stringify(row.formDefaults)).not.toContain(word);
      // … and **there** all the same: since review finding 10 the sealed word
      // stands at the very top of the organisation's document, no longer in
      // `values`. That is the security-relevant half of this case — "not in
      // clear" alone would be green for a column in which nothing lands at all.
      const sealed = storedPassword(row.formDefaults);
      expect(sealed).toBeDefined();
      expect(sealed).not.toBe(word);

      const read = await request(app().server)
        .get(apiPath('/tenant/form-defaults'))
        .set('Cookie', cookieHeader(betaAdmin));
      expect(read.status).toBe(200);
      // **One field the word travels in, no longer two.** Until 2026-08-17 the
      // answer additionally carried a mixed `effective`; without a section
      // switch the organisation's document is itself already what
      // applies. The barrier in front of it is unchanged
      // (`refuses reading the tenant standards without the flag …`).
      const body = read.body as { values: FormSettings };
      expect(body.values.password).toBe(word);
    });

    it('refuses a redirect target that is not http or https', async () => {
      const id = await createForm(alphaAdmin, 'Weiterleitung');

      const response = await writeSettings(alphaAdmin, id, {
        overridden: { ...NO_SECTIONS, confirm: true },
        values: { redirectEnabled: true, redirectUrl: 'javascript:alert(1)' },
      });

      expect(response.status).toBe(400);
      expect(response.text).toContain('values.redirectUrl');
    });

    /**
     * **The regression that gave this counter its urgency.**
     *
     * `settingsOverriddenSchema` carries `.prefault(false)` on all four fields —
     * right for a *stored* document, wrong for a *replacing write*, where it
     * makes "key forgotten" and "expressly `false`" the same request.
     * Before the write schema was split off, the second `PUT` below answered
     * **200** and silently switched *Verfügbarkeit* and *Zugriff & Sicherheit*
     * back to the tenant standard — dropping the deadline and **physically
     * removing the sealed access word** from a column with no history, no
     * trash and no audit trail.
     */
    it('refuses a write that names fewer than four sections, and changes nothing', async () => {
      const id = await createForm(alphaAdmin, 'Unvollständige Hülle');
      const word = 'wort-das-bleiben-muss';
      const first = await writeSettings(alphaAdmin, id, {
        overridden: { ...NO_SECTIONS, access: true },
        values: {
          openEnabled: true,
          closeAt: '2026-08-20T18:00:00.000Z',
          passwordEnabled: true,
          password: word,
        },
      });
      expect(first.status).toBe(200);

      const before = await app().prisma.form.findUniqueOrThrow({
        where: { id },
      });

      const partial = await writeSettings(alphaAdmin, id, {
        overridden: { display: true },
        values: { showProgress: false },
      });

      expect(partial.status).toBe(400);
      expect(partial.text).toContain('overridden.access');

      const after = await app().prisma.form.findUniqueOrThrow({
        where: { id },
      });
      expect(after.settingsOverride).toEqual(before.settingsOverride);
      expect(after.settingsRevision).toBe(before.settingsRevision);
      // The word is still sealed in the row, and still readable.
      expect(storedOverridePassword(after.settingsOverride)).toBeDefined();
      expect((await readSettings(alphaAdmin, id)).effective.password).toBe(
        word,
      );
    });

    it('refuses a settings key that does not exist', async () => {
      const id = await createForm(alphaAdmin, 'Unbekannter Schlüssel');

      const response = await writeSettings(alphaAdmin, id, {
        overridden: NO_SECTIONS,
        // The setting the client dropped on 2026-07-27 — not a tolerated
        // leftover but an unknown key.
        values: { onePerPerson: true },
      });

      expect(response.status).toBe(400);
    });
  });

  /**
   * The seam to `SecretBoxService`, after the security finding of 2026-07-27.
   *
   * A sealed value used to be bound to **nothing**: whoever could write the
   * JSONB column could copy an access word from one form into another — across
   * tenants included — and it decrypted perfectly. The context closes that, and
   * these tests are what makes "closed" a fact rather than a claim: each of
   * them moves a sealed value somewhere it does not belong and watches the read
   * fail.
   *
   * They write to the database directly, deliberately. The API cannot produce
   * these rows, and that is the point — the threat is somebody who does not go
   * through the API.
   */
  describe('a sealed word belongs to the row it sits in', () => {
    /** Copies one form's whole override document onto another form's row. */
    async function copyOverride(fromId: string, toId: string): Promise<void> {
      await app().prisma.$executeRawUnsafe(
        `UPDATE "form" SET "settings_override" =
           (SELECT "settings_override" FROM "form" WHERE "id" = $1::uuid)
         WHERE "id" = $2::uuid`,
        fromId,
        toId,
      );
    }

    async function withAccessWord(
      token: string,
      title: string,
      word: string,
    ): Promise<string> {
      const id = await createForm(token, title);
      const written = await writeSettings(token, id, {
        overridden: { ...NO_SECTIONS, access: true },
        values: { passwordEnabled: true, password: word },
      });
      expect(written.status).toBe(200);
      return id;
    }

    it('refuses to open a word carried in from another form of the same organisation', async () => {
      const word = 'wort-der-quelle';
      const source = await withAccessWord(alphaAdmin, 'Quelle', word);
      const target = await createForm(alphaAdmin, 'Ziel');
      await copyOverride(source, target);

      const response = await request(app().server)
        .get(apiPath(`/forms/${target}/settings`))
        .set('Cookie', cookieHeader(alphaAdmin));

      expect(response.status).toBe(500);
      expect(response.text).not.toContain(word);
      // The source is untouched and still readable — the refusal is about the
      // place, not about the value having been damaged.
      expect((await readSettings(alphaAdmin, source)).effective.password).toBe(
        word,
      );
    });

    /** The boundary the finding was really about. */
    it('refuses to open a word carried across the tenant boundary', async () => {
      const word = 'wort-von-seta';
      const source = await withAccessWord(alphaAdmin, 'SETA-Quelle', word);
      const target = await createForm(betaAdmin, 'SETB-Ziel');
      await copyOverride(source, target);

      const response = await request(app().server)
        .get(apiPath(`/forms/${target}/settings`))
        .set('Cookie', cookieHeader(betaAdmin));

      expect(response.status).toBe(500);
      expect(response.text).not.toContain(word);
    });

    /**
     * The two columns are sealed under **different** contexts, so a tenant
     * standard cannot be read as if it were a form's own value. Without that,
     * the difference between "the organisation has a word" and "this form has
     * a word" would be one `UPDATE` wide.
     */
    it('refuses to open the tenant standard as a form override', async () => {
      const word = 'wort-des-bundes';
      expect(
        (
          await writeTenantDefaults(betaAdmin, beta.id, {
            passwordEnabled: true,
            password: word,
          })
        ).status,
      ).toBe(200);
      const target = await createForm(betaAdmin, 'Fremder Kontext');

      await app().prisma.$executeRawUnsafe(
        `UPDATE "form" SET "settings_override" = jsonb_build_object(
           'overridden', jsonb_build_object(
             'access', true, 'confirm', false, 'display', false
           ),
           'values', jsonb_build_object(
             'passwordEnabled', true,
             'password', (SELECT "form_defaults" ->> 'password'
                          FROM "tenant" WHERE "id" = $1::uuid)
           )
         ) WHERE "id" = $2::uuid`,
        beta.id,
        target,
      );

      const response = await request(app().server)
        .get(apiPath(`/forms/${target}/settings`))
        .set('Cookie', cookieHeader(betaAdmin));

      expect(response.status).toBe(500);
      expect(response.text).not.toContain(word);
    });

    /**
     * The consequence of two contexts that is easy to miss: taking the section
     * over **copies** the organisation's word into the form's own document, and a copy
     * of the stored *string* would be a value nobody could open again. The
     * write path re-seals instead — everything between opening and sealing is
     * plaintext, so what lands in the row is bound to the row.
     *
     * Note the request sends **no values at all**: the copy is the server's job
     * (`setSectionOverride`), not something a client has to remember to do.
     */
    it('re-seals the access word when a form takes the section over', async () => {
      const word = 'organisationsweites-wort-setc';
      expect(
        (
          await writeTenantDefaults(gammaAdmin, gamma.id, {
            passwordEnabled: true,
            password: word,
          })
        ).status,
      ).toBe(200);

      const id = await createForm(gammaAdmin, 'Übernimmt das Wort');
      const written = await writeSettings(gammaAdmin, id, {
        overridden: { ...NO_SECTIONS, access: true },
        values: {},
      });
      expect(written.status).toBe(200);

      // The copy arrived, in the form's **own** document rather than by
      // inheritance — and it is readable, which is what the requirement promises.
      const settings = await readSettings(gammaAdmin, id);
      expect(settings.values.password).toBe(word);
      expect(settings.effective.passwordEnabled).toBe(true);

      const formRow = await app().prisma.form.findUniqueOrThrow({
        where: { id },
      });
      const tenantRow = await app().prisma.tenant.findUniqueOrThrow({
        where: { id: gamma.id },
      });
      expect(JSON.stringify(formRow.settingsOverride)).not.toContain(word);
      expect(JSON.stringify(tenantRow.formDefaults)).not.toContain(word);

      const formWord = storedOverridePassword(formRow.settingsOverride);
      const tenantWord = storedPassword(tenantRow.formDefaults);
      expect(formWord).toBeDefined();
      // **Not the same ciphertext.** A blind pass-through of the stored string
      // would have produced exactly that — and a value nobody could open again.
      expect(formWord).not.toBe(tenantWord);
    });

    /**
     * The requirement, case 4 — "discarded", and physically so.
     *
     * The shared `setSectionOverride(…, false)` drops the section's values, and
     * `pruneToOverridden` states the same rule for a whole document; the write
     * path applies that rule once more, on the untyped document, right before
     * it is parsed. Whichever of the three does the work, the promise is the
     * one asserted here: the key is **gone from the row**, not merely ignored.
     * A sealed word that stays behind lives on in every backup, and a second
     * switch-on would bring it back.
     */
    it('removes a copied access word from the row when the section goes back', async () => {
      const word = 'wort-das-verschwinden-soll';
      const id = await withAccessWord(alphaAdmin, 'Wieder zurück', word);

      const back = await writeSettings(alphaAdmin, id, {
        overridden: NO_SECTIONS,
        values: {},
      });
      expect(back.status).toBe(200);

      const row = await app().prisma.form.findUniqueOrThrow({ where: { id } });
      expect(row.settingsOverride).toEqual({
        overridden: {
          access: false,
          confirm: false,
          display: false,
          budget: false,
        },
        values: {},
      });
      expect(storedOverridePassword(row.settingsOverride)).toBeUndefined();

      // And switching back on starts from the organisation's standard, not from what
      // used to be there.
      const again = await writeSettings(alphaAdmin, id, {
        overridden: { ...NO_SECTIONS, access: true },
        values: {},
      });
      expect(again.status).toBe(200);
      expect((await readSettings(alphaAdmin, id)).values.password).not.toBe(
        word,
      );
    });
  });

  /**
   * Konzept no. 21 — the settings get their **own** conflict protection.
   *
   * The loss it prevents is section-shaped, which is what makes it worse than
   * the usual last-write-wins: two editors who have nothing to do with each
   * other — one sets the deadline, one the display — delete each other's whole
   * sections, sealed access word included.
   */
  /**
   * The requirement, proof 4 — the access word appears in no log, **no CSV
   * export** and no `mail_log` line.
   *
   * The export is the half that is reachable *today* and by the wrong people:
   * it is guarded by `can_view_responses` + `can_export`, neither of which is
   * `can_manage_settings`. So a group that may download answers but may not
   * configure the form must not find the word in the file — which is exactly
   * the case the requirement names. (`mail_log` does not exist yet at this point
   * and is proven by a later suite.)
   */
  describe('the access word stays out of the CSV export', () => {
    it('exports a password-protected form without the word in it', async () => {
      const id = await createForm(alphaAdmin, 'Export mit Zugangswort');
      const word = 'wort-fuer-den-export';
      expect(
        (
          await writeSettings(alphaAdmin, id, {
            overridden: { ...NO_SECTIONS, access: true },
            values: { passwordEnabled: true, password: word },
          })
        ).status,
      ).toBe(200);

      const exporter = await createRestrictedMember(app().prisma, alpha, {
        email: 'export-ohne-einstellungen@example.org',
        groupName: 'export-ohne-einstellungen',
        permissions: {
          canViewResponses: true,
          canExport: true,
          canManageSettings: false,
          canManageFormSettings: false,
        },
      });
      const session = await openSession(app(), exporter.id, alpha.id);

      const csv = await request(app().server)
        .get(apiPath(`/forms/${id}/export.csv`))
        .set('Cookie', cookieHeader(session));

      expect(csv.status).toBe(200);
      // The **whole** file, header row and column names included — not just
      // the data rows. A leak into a column caption is still a leak.
      expect(csv.text).not.toContain(word);
      expect(csv.text).not.toContain('password');
      // …and the download name cannot carry it either.
      expect(csv.headers['content-disposition']).not.toContain(word);
    });
  });

  describe('conflicting editors (Konzept Nr. 21)', () => {
    it('refuses the second save from the same starting state with 409', async () => {
      const id = await createForm(alphaAdmin, 'Zwei Bearbeiter');
      const start = (await readSettings(alphaAdmin, id)).revision;

      const first = await writeSettings(
        alphaAdmin,
        id,
        {
          overridden: NO_SECTIONS,
          values: { openEnabled: true, closeAt: '2026-08-20T18:00:00.000Z' },
        },
        { revision: start },
      );
      const second = await writeSettings(
        alphaAdmin,
        id,
        // The same revision the first one started from — what two people with
        // the page open in two tabs actually send.
        {
          overridden: { ...NO_SECTIONS, display: true },
          values: { showProgress: false },
        },
        { revision: start },
      );

      expect(first.status).toBe(200);
      expect(second.status).toBe(409);
      expect(second.text).toContain(STALE_SETTINGS_MESSAGE);

      // And the first editor's deadline is still there — which is the point.
      const settings = await readSettings(alphaAdmin, id);
      expect(settings.effective.closeAt).toBe('2026-08-20T18:00:00.000Z');
    });

    it('accepts the second save once it names the revision it actually saw', async () => {
      const id = await createForm(alphaAdmin, 'Nacheinander');

      expect(
        (
          await writeSettings(alphaAdmin, id, {
            overridden: { ...NO_SECTIONS, display: true },
            values: { showProgress: false },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await writeSettings(alphaAdmin, id, {
            overridden: { ...NO_SECTIONS, display: true },
            values: { showPageNumbers: false },
          })
        ).status,
      ).toBe(200);

      const settings = await readSettings(alphaAdmin, id);
      expect(settings.effective.showProgress).toBe(false);
      expect(settings.effective.showPageNumbers).toBe(false);
    });

    it('reports the revision it wrote, so the next save can name it', async () => {
      const id = await createForm(alphaAdmin, 'Zähler');
      const before = (await readSettings(alphaAdmin, id)).revision;

      const written = await writeSettings(alphaAdmin, id, {
        overridden: { ...NO_SECTIONS, display: true },
        values: { showProgress: false },
      });

      expect(written.status).toBe(200);
      expect((written.body as SettingsBody).revision).toBe(before + 1);
      expect((await readSettings(alphaAdmin, id)).revision).toBe(before + 1);
    });

    it('refuses the second write of the tenant standards with 409', async () => {
      const start = await tenantRevisionOf(gamma.id);

      const first = await writeTenantDefaults(
        gammaAdmin,
        gamma.id,
        { confirmTitle: 'Erster Bearbeiter' },
        start,
      );
      const second = await writeTenantDefaults(
        gammaAdmin,
        gamma.id,
        { confirmTitle: 'Zweiter Bearbeiter' },
        start,
      );

      expect(first.status).toBe(200);
      expect(second.status).toBe(409);
      expect(second.text).toContain(STALE_SETTINGS_MESSAGE);

      const read = await request(app().server)
        .get(apiPath('/tenant/form-defaults'))
        .set('Cookie', cookieHeader(gammaAdmin));
      expect((read.body as { values: FormSettings }).values.confirmTitle).toBe(
        'Erster Bearbeiter',
      );
    });

    /**
     * The third face of the same finding: taking a section over **copies** the
     * organisation's current values into the form. If the standard moved between
     * loading and saving, the editor would store a value they never saw — an
     * access word above all, since that is the one the page displays.
     */
    it('refuses a take-over that started from an outdated tenant standard', async () => {
      const id = await createForm(betaAdmin, 'Übernahme mit altem Stand');
      const staleTenantRevision = await tenantRevisionOf(beta.id);

      // The organisation moves its standard while the editor has the page open.
      expect(
        (
          await writeTenantDefaults(betaAdmin, beta.id, {
            passwordEnabled: true,
            password: 'inzwischen-geaendert',
          })
        ).status,
      ).toBe(200);

      const refused = await writeSettings(
        betaAdmin,
        id,
        { overridden: { ...NO_SECTIONS, access: true }, values: {} },
        { tenantRevision: staleTenantRevision },
      );

      expect(refused.status).toBe(409);
      expect(refused.text).toContain(STALE_SETTINGS_MESSAGE);
      const row = await app().prisma.form.findUniqueOrThrow({ where: { id } });
      expect(row.settingsOverride).toEqual({});
    });

    /**
     * …and the other half, which is why the check is not simply always on: a
     * write that takes over **nothing** does not read the organisation's values at all,
     * so a standard that moved is none of its business. Blocking it would be
     * the over-blocking that keeps this counter apart from `form.revision` in
     * the first place.
     */
    it('lets a write through that takes nothing over, however old the tenant standard it names', async () => {
      const id = await createForm(gammaAdmin, 'Nur Werte');
      expect(
        (
          await writeSettings(gammaAdmin, id, {
            overridden: { ...NO_SECTIONS, display: true },
            values: { showProgress: false },
          })
        ).status,
      ).toBe(200);

      expect(
        (
          await writeSettings(
            gammaAdmin,
            id,
            {
              overridden: { ...NO_SECTIONS, display: true },
              values: { showPageNumbers: false },
            },
            { tenantRevision: 1 },
          )
        ).status,
      ).toBe(200);
    });
  });

  describe('the tenant boundary', () => {
    /**
     * 404 — not 403 — and **byte-identical** to an unknown id. A different
     * answer would confirm that the id exists somewhere on the platform, and
     * form ids travel in URLs, mails and exports.
     */
    it('answers the settings of a form of another organisation exactly as an unknown id', async () => {
      const id = await createForm(alphaAdmin, 'Nur für SETA');

      const foreign = await request(app().server)
        .get(apiPath(`/forms/${id}/settings`))
        .set('Cookie', cookieHeader(betaAdmin));
      const unknown = await request(app().server)
        .get(apiPath('/forms/019fe000-0000-7000-8000-0000000000ff/settings'))
        .set('Cookie', cookieHeader(betaAdmin));
      const malformed = await request(app().server)
        .get(apiPath('/forms/nicht-mal-eine-uuid/settings'))
        .set('Cookie', cookieHeader(betaAdmin));

      expect(foreign.status).toBe(404);
      expect(foreign.text).toBe(unknown.text);
      expect(malformed.text).toBe(unknown.text);
      expect(foreign.text).toContain(FORM_NOT_FOUND_MESSAGE);

      // …and the **headers** too, not only the body. They agree today down to
      // `content-length` and `etag`; asserting it is what stops a header added
      // on one of the three paths — a cache hint, a diagnostic — from turning
      // "not found" back into "it exists, but you may not".
      expect(comparableHeaders(foreign)).toEqual(comparableHeaders(unknown));
      expect(comparableHeaders(malformed)).toEqual(comparableHeaders(unknown));
    });

    /** A form in the trash answers like one that never existed. */
    it('answers a deleted form exactly as an unknown id', async () => {
      const id = await createForm(alphaAdmin, 'Gelöscht');
      await app().prisma.form.update({
        where: { id },
        data: { deletedAt: new Date() },
      });

      const deleted = await request(app().server)
        .get(apiPath(`/forms/${id}/settings`))
        .set('Cookie', cookieHeader(alphaAdmin));
      const unknown = await request(app().server)
        .get(apiPath('/forms/019fe000-0000-7000-8000-0000000000fe/settings'))
        .set('Cookie', cookieHeader(alphaAdmin));

      expect(deleted.status).toBe(404);
      expect(deleted.text).toBe(unknown.text);
      expect(comparableHeaders(deleted)).toEqual(comparableHeaders(unknown));

      // …and writing to it is refused as well, rather than quietly configuring
      // a form nobody can reach any more.
      const written = await writeSettings(alphaAdmin, id, {
        overridden: { ...NO_SECTIONS, display: true },
        values: { showProgress: false },
      });
      expect(written.status).toBe(404);
    });

    /**
     * **What this proves, and what it does not.** The refusal here survives even
     * if the tenant filter were dropped from the *read* path, because
     * `updateSettingsOverride` is bound to the tenant independently — defence in
     * depth, and welcome. The read boundary is the test above; nobody should
     * take it as covered by this one.
     */
    it('refuses to write the settings of a form of another organisation, and changes nothing', async () => {
      const id = await createForm(alphaAdmin, 'SETA schreibt');

      const response = await writeSettings(betaAdmin, id, {
        overridden: NO_SECTIONS,
        values: { openEnabled: true, closeAt: '2026-01-01T00:00:00.000Z' },
      });

      expect(response.status).toBe(404);
      const row = await app().prisma.form.findUniqueOrThrow({ where: { id } });
      expect(row.settingsOverride).toEqual({});
    });

    /**
     * The standards have no id in their path, so there is nothing to point at
     * another organisation with — the boundary is structural. What is asserted here is
     * that the route really follows the *active* tenant and not some ambient
     * one: two organisations write different standards and each reads back its own.
     */
    it('gives each organisation its own standards, with no way to name another', async () => {
      expect(
        (
          await writeTenantDefaults(alphaAdmin, alpha.id, {
            confirmTitle: 'SETA sagt',
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await writeTenantDefaults(betaAdmin, beta.id, {
            confirmTitle: 'SETB sagt',
          })
        ).status,
      ).toBe(200);

      const asAlpha = await request(app().server)
        .get(apiPath('/tenant/form-defaults'))
        .set('Cookie', cookieHeader(alphaAdmin));
      const asBeta = await request(app().server)
        .get(apiPath('/tenant/form-defaults'))
        .set('Cookie', cookieHeader(betaAdmin));

      expect(
        (asAlpha.body as { values: FormSettings }).values.confirmTitle,
      ).toBe('SETA sagt');
      // Both halves: SETB reads **its own** value, not merely "not SETA's".
      // The negative alone would also pass for an empty answer.
      expect(
        (asBeta.body as { values: FormSettings }).values.confirmTitle,
      ).toBe('SETB sagt');
      expect(asBeta.text).not.toContain('SETA sagt');
    });
  });

  /**
   * The requirement — the fourth of the five permission flags takes effect.
   *
   * Four routes, four pairs. The **reading** half matters as much as the
   * writing one and is easy to wave through: the settings document carries the
   * access word in clear for whoever may configure it, so "read only" is the
   * half that hands out a password.
   */
  /**
   * **Two permissions, two reaches** (ADR-0021).
   *
   * `can_manage_form_settings` opens the settings **of one form**,
   * `can_manage_settings` the **organisation-wide** form standards. The
   * cases here therefore stand crosswise: each group holds exactly one of the
   * two, and each is refused at the other route. A block that
   * held both permissions in the same group would have stayed green if the
   * separation had never taken place.
   */
  describe('can_manage_form_settings ≠ can_manage_settings', () => {
    let formId: string;
    let denied: string;
    let allowed: string;
    /** Only the organisation-wide permission — the counter-direction of the pair. */
    let orgAllowed: string;

    beforeAll(async () => {
      formId = await createForm(alphaAdmin, 'Rechte-Matrix');

      const without = await createRestrictedMember(app().prisma, alpha, {
        email: 'ohne-einstellungen@example.org',
        groupName: 'ohne-einstellungen',
        // Everything *else* granted, so a 403 can only come from the one flag
        // under test rather than from a member who may do nothing at all.
        permissions: {
          canBuild: true,
          canViewResponses: true,
          canExport: true,
          canManageSettings: false,
          canManageFormSettings: false,
        },
      });
      const withFlag = await createRestrictedMember(app().prisma, alpha, {
        email: 'mit-einstellungen@example.org',
        groupName: 'mit-einstellungen',
        // Exactly the standard group `editor` since ADR-0021: the form
        // permission yes, the organisation-wide one no.
        permissions: { canBuild: true, canManageFormSettings: true },
      });
      const withOrgFlag = await createRestrictedMember(app().prisma, alpha, {
        email: 'mit-organisationseinstellungen@example.org',
        groupName: 'mit-organisationseinstellungen',
        permissions: { canBuild: true, canManageSettings: true },
      });

      denied = await openSession(app(), without.id, alpha.id);
      allowed = await openSession(app(), withFlag.id, alpha.id);
      orgAllowed = await openSession(app(), withOrgFlag.id, alpha.id);
    }, 120_000);

    /**
     * ADR-0021, the one direction: the **organisation-wide** permission does not
     * open the settings of a form. Reading and writing separately, because
     * reading this route carries the access word in clear.
     */
    it("refuses a form's settings to the organisation-wide flag alone", async () => {
      const read = await request(app().server)
        .get(apiPath(`/forms/${formId}/settings`))
        .set('Cookie', cookieHeader(orgAllowed));
      expect(read.status).toBe(403);
      expect(read.text).toContain(MISSING_PERMISSION_MESSAGE);

      const written = await writeSettings(orgAllowed, formId, {
        overridden: { ...NO_SECTIONS, display: true },
        values: { showPageNumbers: false },
      });
      expect(written.status).toBe(403);
    });

    /**
     * And the counter-direction, which is the actual purpose of the
     * separation: whoever may configure their forms does not reach the
     * **standards of all forms** of the organisation — and just as little
     * their administration (the appearance as a stand-in for the tabs
     * behind it). What is looked at in addition is the row, not only the
     * status code.
     */
    it('refuses the organisation-wide standards and the Organisations-Verwaltung to the per-form flag alone', async () => {
      const before = await app().prisma.tenant.findUniqueOrThrow({
        where: { id: alpha.id },
      });

      expect(
        (
          await request(app().server)
            .get(apiPath('/tenant/form-defaults'))
            .set('Cookie', cookieHeader(allowed))
        ).status,
      ).toBe(403);

      const written = await writeTenantDefaults(allowed, alpha.id, {
        confirmTitle: 'Sollte nicht ankommen',
      });
      expect(written.status).toBe(403);
      const after = await app().prisma.tenant.findUniqueOrThrow({
        where: { id: alpha.id },
      });
      expect(after.formDefaults).toEqual(before.formDefaults);

      // The tenant administration hangs on the same wide permission.
      expect(
        (
          await request(app().server)
            .get(apiPath('/tenant/branding'))
            .set('Cookie', cookieHeader(allowed))
        ).status,
      ).toBe(403);
    });

    it("refuses reading a form's settings without the flag and allows it with", async () => {
      const refused = await request(app().server)
        .get(apiPath(`/forms/${formId}/settings`))
        .set('Cookie', cookieHeader(denied));
      const granted = await request(app().server)
        .get(apiPath(`/forms/${formId}/settings`))
        .set('Cookie', cookieHeader(allowed));

      expect(refused.status).toBe(403);
      expect(refused.text).toContain(MISSING_PERMISSION_MESSAGE);
      expect(granted.status).toBe(200);
    });

    it("refuses writing a form's settings without the flag and allows it with", async () => {
      const body = {
        overridden: { ...NO_SECTIONS, display: true },
        values: { showPageNumbers: false },
      };

      const refused = await writeSettings(denied, formId, body);
      expect(refused.status).toBe(403);
      // The refusal changed nothing — counted at the row, not inferred from
      // the status code.
      const untouched = await app().prisma.form.findUniqueOrThrow({
        where: { id: formId },
      });
      expect(untouched.settingsOverride).toEqual({});

      const granted = await writeSettings(allowed, formId, body);
      expect(granted.status).toBe(200);
    });

    it('refuses reading the tenant standards without the flag and allows it with', async () => {
      const refused = await request(app().server)
        .get(apiPath('/tenant/form-defaults'))
        .set('Cookie', cookieHeader(denied));
      const granted = await request(app().server)
        .get(apiPath('/tenant/form-defaults'))
        .set('Cookie', cookieHeader(orgAllowed));

      expect(refused.status).toBe(403);
      expect(refused.text).toContain(MISSING_PERMISSION_MESSAGE);
      expect(granted.status).toBe(200);
    });

    it('refuses writing the tenant standards without the flag and allows it with', async () => {
      const before = await app().prisma.tenant.findUniqueOrThrow({
        where: { id: alpha.id },
      });

      const refused = await writeTenantDefaults(denied, alpha.id, {
        confirmTitle: 'Sollte nicht ankommen',
      });
      expect(refused.status).toBe(403);
      const after = await app().prisma.tenant.findUniqueOrThrow({
        where: { id: alpha.id },
      });
      expect(after.formDefaults).toEqual(before.formDefaults);

      const granted = await writeTenantDefaults(orgAllowed, alpha.id, {
        confirmTitle: 'Darf ankommen',
      });
      expect(granted.status).toBe(200);
    });

    /**
     * The reason the guard resolves the membership of the **active** tenant
     * (restated by the requirements): someone may be admin in their own Organisation
     * and a viewer in the association, and the wider role must not travel.
     */
    it('reads the flag of the active tenant, not the widest one held', async () => {
      const person = await createRestrictedMember(app().prisma, beta, {
        email: 'zwei-rollen-einstellungen@example.org',
        groupName: 'setb-viewer',
        permissions: { canBuild: true, canManageSettings: false },
      });
      // The same person, admin — and therefore `can_manage_settings` — in SETA.
      await app().prisma.membership.create({
        data: {
          tenantId: alpha.id,
          userId: person.id,
          groupId: alpha.adminGroupId,
        },
      });

      const inAlpha = await openSession(app(), person.id, alpha.id);
      const inBeta = await openSession(app(), person.id, beta.id);

      expect(
        (
          await request(app().server)
            .get(apiPath('/tenant/form-defaults'))
            .set('Cookie', cookieHeader(inAlpha))
        ).status,
      ).toBe(200);
      expect(
        (
          await request(app().server)
            .get(apiPath('/tenant/form-defaults'))
            .set('Cookie', cookieHeader(inBeta))
        ).status,
      ).toBe(403);
    });

    it('refuses both routes to a request without a session at all', async () => {
      const form = await request(app().server).get(
        apiPath(`/forms/${formId}/settings`),
      );
      const tenant = await request(app().server).get(
        apiPath('/tenant/form-defaults'),
      );

      expect(form.status).toBe(401);
      expect(tenant.status).toBe(401);
    });

    /** Mutating routes are behind the global CSRF guard, like every other. */
    it('refuses a write without a CSRF token', async () => {
      const response = await request(app().server)
        .put(apiPath(`/forms/${formId}/settings`))
        .set('Cookie', cookieHeader(alphaAdmin))
        .send({ overridden: NO_SECTIONS, values: {} });

      expect(response.status).toBe(403);
    });
  });

  /**
   * **The payload, not only the status code** (ADR-0021, a
   * security finding).
   *
   * The cross-check one level up checks *whether* a route answers — 403
   * against 200. It cannot check **what** stands in the answer, and that is
   * exactly where the gap was: `GET /api/forms/:id/settings` stands behind
   * `can_manage_form_settings` and carried `tenantDefaults` from the
   * **decrypted** document of the organisation, access word included —
   * and `effective` the same value for an inheriting form. An `editor`
   * thereby reached the organisation-wide word that protects the forms of
   * **others**, over a route that is only meant to unlock their own for them.
   *
   * ADR-0021 „Consequences" claimed the opposite: „Ein `editor` erreicht die
   * vier Bereiche **seiner** Formulare und **nicht** die Formular-Standards der
   * Organisation." The sentence was true of the route and not of its answer.
   *
   * *Reproduction while writing these cases:* without the redaction in
   * `FormSettingsService.shownTenantDefaults` the word stands in clear in
   * both fields, and the case "the word does not appear in the body at all"
   * is red.
   */
  describe('das Zugangswort der Organisation in der Antwort', () => {
    /** The organisation-wide word — it protects the forms of **everyone**. */
    const ORG_WORD = `organisation-${randomBytes(9).toString('hex')}`;
    /** The own word of **one** form — an `editor` may see that one. */
    const OWN_WORD = `formular-${randomBytes(9).toString('hex')}`;
    /**
     * A value of the organisation that is **no** secret.
     *
     * It keeps open the case in which taking over still has to copy: what is
     * held back is the access word and nothing else.
     */
    const ORG_CONFIRM_TITLE = 'Danke von der Organisation';

    let delta: TenantFixture;
    let deltaAdmin: string;
    /** `can_manage_form_settings` alone — the standard group `editor`. */
    let editor: string;
    /** Both permissions — the counter-check that may see the clear text. */
    let manager: string;
    /** A form that **inherits** *Zugriff & Sicherheit*. */
    let inheriting: string;
    /** …and one that has taken the section over **itself**. */
    let ownWord: string;

    beforeAll(async () => {
      delta = await createTenant(app().prisma, 'SETD');
      const adminUser = await createUser(app().prisma, {
        email: 'settings-delta@example.org',
        password: PASSWORD,
        tenants: [delta],
      });
      deltaAdmin = await openSession(app(), adminUser.id, delta.id);

      const editorUser = await createRestrictedMember(app().prisma, delta, {
        email: 'setd-editor@example.org',
        groupName: 'setd-editor',
        permissions: { canBuild: true, canManageFormSettings: true },
      });
      const managerUser = await createRestrictedMember(app().prisma, delta, {
        email: 'setd-manager@example.org',
        groupName: 'setd-manager',
        permissions: {
          canBuild: true,
          canManageFormSettings: true,
          canManageSettings: true,
        },
      });
      editor = await openSession(app(), editorUser.id, delta.id);
      manager = await openSession(app(), managerUser.id, delta.id);

      // The organisation protects its forms organisation-wide.
      const organisationWide = await writeTenantDefaults(deltaAdmin, delta.id, {
        passwordEnabled: true,
        password: ORG_WORD,
        confirmTitle: ORG_CONFIRM_TITLE,
      });
      expect(organisationWide.status).toBe(200);

      inheriting = await createForm(deltaAdmin, 'Erbt den Schutz');
      ownWord = await createForm(deltaAdmin, 'Eigener Schutz');
      const taken = await writeSettings(deltaAdmin, ownWord, {
        overridden: { ...NO_SECTIONS, access: true },
        values: { passwordEnabled: true, password: OWN_WORD },
      });
      expect(taken.status).toBe(200);
    }, 120_000);

    it('zeigt einem editor das Wort der Organisation nicht', async () => {
      const response = await request(app().server)
        .get(apiPath(`/forms/${inheriting}/settings`))
        .set('Cookie', cookieHeader(editor));

      expect(response.status).toBe(200);
      const body = response.body as SettingsBody;
      expect(body.tenantDefaults.password).toBe(REDACTED_PASSWORD);
      // `effective` is the second way to the same value, and it was forgotten
      // on the first attempt: this form inherits the section, so its effective
      // word comes from the organisation's document.
      expect(body.effective.password).toBe(REDACTED_PASSWORD);
      // **The body as a whole** — the check that leaves out no field that is
      // not one yet today.
      expect(JSON.stringify(response.body)).not.toContain(ORG_WORD);
    });

    it('lässt den Schutz dabei sichtbar an', async () => {
      const body = (
        await request(app().server)
          .get(apiPath(`/forms/${inheriting}/settings`))
          .set('Cookie', cookieHeader(editor))
      ).body as SettingsBody;

      // The redaction takes the word and not the statement: "this form is
      // protected" is something an `editor` has to see, otherwise they have a
      // page in front of them that claims something other than reality. That is
      // also the reason why `REDACTED_PASSWORD` is not the empty string
      // — that one would violate the schema (`settings-document.ts`).
      expect(body.effective.passwordEnabled).toBe(true);
      expect(body.tenantDefaults.passwordEnabled).toBe(true);
    });

    it('zeigt es dem Inhaber von can_manage_settings im Klartext', async () => {
      const body = (
        await request(app().server)
          .get(apiPath(`/forms/${inheriting}/settings`))
          .set('Cookie', cookieHeader(manager))
      ).body as SettingsBody;

      // The counter-check, without which the case above would also be green
      // for a route that shows the word to **nobody**: whoever reads the
      // standards of the organisation one route further in clear anyway sees
      // nothing new here.
      expect(body.tenantDefaults.password).toBe(ORG_WORD);
      expect(body.effective.password).toBe(ORG_WORD);
    });

    it('zeigt einem editor das **eigene** Wort seines Formulars weiterhin', async () => {
      const body = (
        await request(app().server)
          .get(apiPath(`/forms/${ownWord}/settings`))
          .set('Cookie', cookieHeader(editor))
      ).body as SettingsBody;

      // The boundary runs between the two documents and not across the
      // field: this form has taken *Zugriff & Sicherheit* over, its
      // word is its own, and `can_manage_form_settings` is exactly the
      // permission to manage it. A redaction that swallowed that too would be
      // no safeguard but a broken page.
      expect(body.values.password).toBe(OWN_WORD);
      expect(body.effective.password).toBe(OWN_WORD);
      // And the organisation's word nevertheless not.
      expect(body.tenantDefaults.password).toBe(REDACTED_PASSWORD);
      expect(JSON.stringify(body)).not.toContain(ORG_WORD);
    });

    it('redigiert auch die Antwort eines Schreibvorgangs', async () => {
      // `PUT` answers with the same document as `GET` — and without the
      // second call of `shownTenantDefaults` it would be the open side
      // entrance to the same value.
      const written = await writeSettings(editor, inheriting, {
        overridden: { ...NO_SECTIONS, display: true },
        values: { showPageNumbers: false },
      });

      expect(written.status).toBe(200);
      const body = written.body as SettingsBody;
      expect(body.tenantDefaults.password).toBe(REDACTED_PASSWORD);
      expect(body.effective.password).toBe(REDACTED_PASSWORD);
      expect(JSON.stringify(written.body)).not.toContain(ORG_WORD);
    });

    it('lässt das Wort in der Spalte unangetastet, gesiegelt wie zuvor', async () => {
      // The redaction is a view and not a write: after the `PUT` of an
      // `editor` the real, sealed word still stands in `tenant.form_defaults`
      // — not `REDACTED_PASSWORD` with its NUL byte, which
      // PostgreSQL would refuse in `jsonb` anyway.
      const row = await app().prisma.tenant.findUniqueOrThrow({
        where: { id: delta.id },
      });
      // The organisation's document is **flat**: the word stands at the very
      // top and not in `values` (review finding 10; the migration
      // `20260817120000_tenant_form_defaults_flat` wrote the shape out).
      // `storedPassword` and not `storedOverridePassword` — the difference
      // is exactly this one level, and confusing it would mean reading "no
      // word stored" past an `undefined`.
      const sealed = storedPassword(row.formDefaults);
      expect(sealed).toBeDefined();
      expect(sealed).not.toBe(ORG_WORD);
      expect(sealed).not.toBe(REDACTED_PASSWORD);

      // And the organisation reads its word back unchanged.
      const defaults = await request(app().server)
        .get(apiPath('/tenant/form-defaults'))
        .set('Cookie', cookieHeader(deltaAdmin));
      expect(defaults.status).toBe(200);
      expect((defaults.body as { values: FormSettings }).values.password).toBe(
        ORG_WORD,
      );
    });

    /**
     * **Taking the section over was the side entrance** (ADR-0021, the
     * second half of the same finding).
     *
     * The redaction takes the word out of the *answer* for an `editor`. It was
     * thereby one click away from being ineffective: when switching to
     * „Angepasst", `setSectionOverride` copies the currently applying values
     * into the form — including the word the display had just held back.
     * After that it stands in `values.password` of **this** form, and there
     * `can_manage_form_settings` may read it.
     *
     * *Reproduction while writing these cases:* without `copyableTenantDefaults`
     * the `PUT` answers with `values.password === ORG_WORD`, and the column
     * carries it sealed — both assertions below are red.
     */
    describe('das Übernehmen von „Zugriff & Sicherheit"', () => {
      it('übernimmt den Abschnitt für einen editor ohne das Wort der Organisation', async () => {
        const form = await createForm(deltaAdmin, 'Editor übernimmt');

        const written = await writeSettings(editor, form, {
          overridden: { ...NO_SECTIONS, access: true },
          values: {},
        });

        expect(written.status).toBe(200);
        const body = written.body as SettingsBody;
        expect(body.overridden.access).toBe(true);
        // **Not in the answer** — neither as clear text nor as a placeholder.
        expect(body.values.password).toBe('');
        expect(body.effective.password).toBe('');
        expect(JSON.stringify(written.body)).not.toContain(ORG_WORD);

        // **And not in the database.** The answer alone would prove nothing:
        // a server that stores the word and merely does not show it would let
        // it out again on the next read.
        const row = await app().prisma.form.findUniqueOrThrow({
          where: { id: form },
        });
        // Empty and **not** sealed: `mapPassword` leaves an empty word alone,
        // because `SecretBoxService.seal` refuses an empty secret anyway.
        // "No word" thereby stays an absence and does not become a
        // secret-shaped lump for a secret nobody has set.
        expect(storedOverridePassword(row.settingsOverride)).toBe('');
        expect(JSON.stringify(row.settingsOverride)).not.toContain(ORG_WORD);

        // Afterwards the protection visibly stands at "off" and does not claim
        // that there still is one: `checkSettingsConsistency` would not let
        // "on without a word" through anyway, and a silent contradiction would
        // be worse than a visible loss.
        expect(body.effective.passwordEnabled).toBe(false);

        // And reading back says the same — no word that only turns up on the
        // second `GET`.
        const reread = (
          await request(app().server)
            .get(apiPath(`/forms/${form}/settings`))
            .set('Cookie', cookieHeader(editor))
        ).body as SettingsBody;
        expect(reread.values.password).toBe('');
        expect(JSON.stringify(reread)).not.toContain(ORG_WORD);
      });

      it('lässt denselben editor sein eigenes Wort im selben Zug setzen', async () => {
        const form = await createForm(deltaAdmin, 'Editor setzt eigenes Wort');
        const ownWordHere = `eigenes-${randomBytes(9).toString('hex')}`;

        // The counter-check to the counter-check: holding back does not mean
        // "the section is dead for this role". Whoever takes it over may set a
        // word — only their own.
        const written = await writeSettings(editor, form, {
          overridden: { ...NO_SECTIONS, access: true },
          values: { passwordEnabled: true, password: ownWordHere },
        });

        expect(written.status).toBe(200);
        const body = written.body as SettingsBody;
        expect(body.values.password).toBe(ownWordHere);
        expect(body.effective.passwordEnabled).toBe(true);
        expect(JSON.stringify(written.body)).not.toContain(ORG_WORD);
      });

      it('übernimmt es für can_manage_settings unverändert', async () => {
        const form = await createForm(deltaAdmin, 'Manager übernimmt');

        // **The counter-check**, without which the case above would also be
        // green for a server that copies nothing for *anybody* on taking over
        // — which would lose every organisation's word on the first
        // „Angepasst".
        const written = await writeSettings(manager, form, {
          overridden: { ...NO_SECTIONS, access: true },
          values: {},
        });

        expect(written.status).toBe(200);
        const body = written.body as SettingsBody;
        expect(body.values.password).toBe(ORG_WORD);
        expect(body.effective.passwordEnabled).toBe(true);

        // Sealed under the context of *this* form, not in clear.
        const row = await app().prisma.form.findUniqueOrThrow({
          where: { id: form },
        });
        const sealed = storedOverridePassword(row.settingsOverride);
        expect(sealed).toBeDefined();
        expect(sealed).not.toBe(ORG_WORD);
      });

      it('lässt die anderen drei Abschnitte auch für einen editor kopieren', async () => {
        const form = await createForm(
          deltaAdmin,
          'Editor übernimmt Bestätigung',
        );

        // The holding back applies to **one field** and not to the taking over
        // as such: what is no secret travels along as before, otherwise a
        // redaction would have turned into a broken inheritance.
        const written = await writeSettings(editor, form, {
          overridden: { ...NO_SECTIONS, confirm: true },
          values: {},
        });

        expect(written.status).toBe(200);
        const body = written.body as SettingsBody;
        expect(body.values.confirmTitle).toBe(ORG_CONFIRM_TITLE);
      });
    });
  });
});
