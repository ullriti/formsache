import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_FORM_SETTINGS } from '@formsache/shared';

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
 * **The one row of the installation** — and what applies without it.
 *
 * ⚠️ **This file has lost its main topic, and that is the point.** Until
 * 2026-08-14 `system_setting` carried a third layer of the form settings
 * beneath every organisation, and the largest part of this file proved that a
 * differing row reaches the public filling-in path *and* the settings page.
 * That layer no longer exists (ADR-0011, continuation;
 * review finding 9): what a form inherits is decided by its organisation and
 * the shipped default — checked in `test/settings/tenant-sections.spec.ts`
 * and in `packages/shared/src/form-settings.test.ts`.
 *
 * What remains here is what has to be true even without that layer:
 *
 * 1. **The row exists exactly once, because the table says so** — two rows
 *    are a database error and not an application check that somebody
 *    can remove. The row still carries mail server, base address, AI
 *    and the notification templates.
 * 2. **A fresh installation without the row is fully usable** — no
 *    backfill, no seed.
 * 3. **The lower bound of the access word** applies on the write path and not in
 *    the storage schema: an older, shorter word stays readable and still opens
 *    its form.
 */

const PASSWORD = 'test-password';
const PAGE = '019ff600-0000-7000-8000-0000000000a0';
const NAME = '019ff600-0000-7000-8000-000000000001';

function definition() {
  return {
    pages: [
      {
        id: PAGE,
        title: 'Anmeldung',
        questions: [
          {
            id: NAME,
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

describe('the system layer as a row', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  let tenant: TenantFixture;
  let editor: string;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });

    tenant = await createTenant(testApp.prisma, 'SYSA');
    const user = await createUser(testApp.prisma, {
      email: 'editor@example.org',
      password: PASSWORD,
      tenants: [tenant],
    });
    editor = await openSession(testApp, user.id, tenant.id);
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  afterEach(async () => {
    // The row is installation-wide, so a test that left one behind would decide
    // what „nichts entschieden" means for every test after it.
    await clearSystemRow();
  });

  async function clearSystemRow(): Promise<void> {
    await app().prisma.systemSetting.deleteMany({});
  }

  /** A published form, through the real routes. */
  async function publishedForm(
    title: string,
  ): Promise<{ id: string; slug: string }> {
    const created = await request(app().server)
      .post(apiPath('/forms'))
      .set(authedMutation(editor))
      .send({ title });
    const form = created.body as {
      id: string;
      revision: number;
      publicSlug: string;
    };

    const saved = await request(app().server)
      .put(apiPath(`/forms/${form.id}`))
      .set(authedMutation(editor))
      .send({ title, definition: definition(), revision: form.revision });
    const published = await request(app().server)
      .post(apiPath(`/forms/${form.id}/publish`))
      .set(authedMutation(editor))
      .send({ revision: (saved.body as { revision: number }).revision });
    expect(published.status).toBe(200);

    return { id: form.id, slug: form.publicSlug };
  }

  /** The public read — what a stranger sees. */
  function read(slug: string): Promise<request.Response> {
    return request(app().server).get(apiPath(`/public/forms/${slug}`));
  }

  /** The editor's settings page — what the other surface sees. */
  function settingsPage(formId: string): Promise<request.Response> {
    return (
      request(app().server)
        .get(apiPath(`/forms/${formId}/settings`))
        // A read, so the session cookie alone — `authedMutation` would add the
        // CSRF header a `GET` has no use for.
        .set('Cookie', cookieHeader(editor))
    );
  }

  function submit(slug: string): Promise<request.Response> {
    return request(app().server)
      .post(apiPath(`/public/forms/${slug}/responses`))
      .send({ answers: { [NAME]: 'Anton' } });
  }

  function rowsOf(formId: string): Promise<number> {
    return app().prisma.response.count({ where: { formId } });
  }

  // ═════════════════════════════════════════════════════════════════════════
  // The row exists exactly once, and the table says so
  // ═════════════════════════════════════════════════════════════════════════

  describe('exactly one row, promised by the table', () => {
    it('refuses a second row', async () => {
      await app().prisma.systemSetting.create({
        data: { id: SYSTEM_SETTING_ID },
      });

      // The **database** refuses it, not a service that could be edited to stop
      // refusing. `P2002` is Prisma's unique-constraint violation.
      await expect(
        app().prisma.systemSetting.create({ data: {} }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('refuses a row with any other id', async () => {
      // The other half of the promise: without the CHECK, „genau eine Zeile"
      // would only hold as long as every writer remembered to use the same id.
      await expect(
        app().prisma.systemSetting.create({ data: { id: 'y' } }),
        // `P2039` — PostgreSQL refused the statement with a check-constraint
        // violation, which is precisely the answer this test wants: the promise
        // is the table's, not the application's.
      ).rejects.toMatchObject({ code: 'P2039' });
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // The row is missing: „nichts entschieden"
  // ═════════════════════════════════════════════════════════════════════════

  describe('a missing row is the usable state', () => {
    /**
     * The **control**, and it is labelled as one on purpose.
     *
     * What it proves is that a fresh installation needs no backfill and no
     * seed: one that has never seen a superadmin still serves and accepts a
     * form. Which values it serves is the shipped constant's business, and the
     * inheritance above it is `tenant-sections.spec.ts`.
     */
    it('leaves a fresh installation fully usable (control)', async () => {
      const form = await publishedForm('Ohne Systemzeile');

      const payload = await read(form.slug);
      expect(payload.status).toBe(200);
      expect(payload.body).toMatchObject({
        display: {
          showProgress: SYSTEM_FORM_SETTINGS.showProgress,
          showPageNumbers: SYSTEM_FORM_SETTINGS.showPageNumbers,
          showRequiredHint: SYSTEM_FORM_SETTINGS.showRequiredHint,
        },
        availability: { state: 'open' },
      });

      const before = await rowsOf(form.id);
      const submitted = await submit(form.slug);
      expect(submitted.status).toBe(200);
      expect(await rowsOf(form.id)).toBe(before + 1);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // The specification — the minimum length, and the old stock it must not shut out
  // ═════════════════════════════════════════════════════════════════════════

  describe('Konzept Nr. 43 — the access word an editor writes', () => {
    it('refuses a word shorter than twelve characters and names the field', async () => {
      const form = await publishedForm('Kurzes Wort');
      const row = await app().prisma.form.findUniqueOrThrow({
        where: { id: form.id },
        select: { settingsRevision: true },
      });
      const tenantRow = await app().prisma.tenant.findUniqueOrThrow({
        where: { id: tenant.id },
        select: { formDefaultsRevision: true },
      });

      const refused = await request(app().server)
        .put(apiPath(`/forms/${form.id}/settings`))
        .set(authedMutation(editor))
        .send({
          overridden: {
            access: true,
            confirm: false,
            display: false,
            budget: false,
          },
          values: { passwordEnabled: true, password: 'zu-kurz' },
          revision: row.settingsRevision,
          tenantRevision: tenantRow.formDefaultsRevision,
        });

      expect(refused.status).toBe(400);
      expect(JSON.stringify(refused.body)).toContain('password');
    });

    /**
     * **The load-bearing half**: a word stored *before*
     * the rule existed stays readable and still opens its form.
     *
     * The word is written the way an older version would have written it —
     * through the real seal, straight into the column — because that is what
     * the old stock looks like. Moving the minimum length into the storage
     * schema has to turn this test red: it would not reject the old word, it
     * would make the whole document unparseable, and an unparseable settings
     * document has meant *fail closed*. If this test stays green
     * when the bound moves, it is checking the wrong path.
     */
    it('leaves a shorter *stored* word readable, and it still opens the form', async () => {
      const form = await publishedForm('Altbestand');
      const secrets = app().app.get(
        (await import('../../src/settings/settings-secrets.service'))
          .SettingsSecretsService,
      );
      const short = 'kurz';

      await app().prisma.form.update({
        where: { id: form.id },
        data: {
          settingsOverride: secrets.sealFormOverride(
            {
              overridden: {
                access: true,
                confirm: false,
                display: false,
                budget: false,
              },
              values: { passwordEnabled: true, password: short },
            },
            tenant.id,
            form.id,
          ),
        },
      });

      // Readable: the editor's settings page still renders it, word included.
      const page = await settingsPage(form.id);
      expect(page.status).toBe(200);
      expect(page.body).toMatchObject({
        effective: { passwordEnabled: true, password: short },
      });

      // …and openable: the public gate accepts the short word.
      expect((await read(form.slug)).body).toMatchObject({ locked: true });
      const unlocked = await request(app().server)
        .post(apiPath(`/public/forms/${form.slug}/access`))
        .send({ password: short });
      expect(unlocked.status).toBe(200);
    });
  });
});
