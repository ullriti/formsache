import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import {
  TEST_PUBLIC_BASE_URL,
  apiPath,
  createTestApp,
  type TestApp,
} from '../support/create-test-app';
import {
  createTenant,
  createUser,
  type TenantFixture,
} from '../support/fixtures';
import { authedMutation, openSession } from '../support/http';

/**
 * **The shipped default, measured over the routes** — „Zwischenspeichern
 * erlauben" and „Bearbeiten nach Absenden" are on ex works (review finding 16,
 * `CHANGELOG.md`).
 *
 * The difference to `draft.spec.ts` and `response-edit.spec.ts` next door is
 * what does **not** happen here: those two suites set the switches before they
 * measure, and thereby prove the effect of the setting. This test sets nothing.
 * It measures what a form does whose settings **nobody has ever touched** — and
 * that is the statement carrying the product decision: without this file a
 * turning back of the two lines in `SYSTEM_FORM_SETTINGS` in `shared`, `web` and
 * `api` stays completely green, although the behaviour of every inheriting form
 * flips over.
 *
 * That really nothing is configured is itself a claim and is therefore measured:
 * the first case reads both JSONB columns and insists on `{}`. Without it the
 * two cases below would only be worth as much as the assumption that the fixture
 * routes have written nothing.
 *
 * **`TRUST_PROXY_HOPS: 1` plus an `X-Forwarded-For` of its own per request**, as
 * in the two suites next door: the public write routes limit per address, and a
 * test that spends the quota on fixtures measures the limiting instead of the
 * default.
 */

const PASSWORD = 'test-password';
const PAGE = '019ff900-0000-7000-8000-0000000000a0';
const NAME = '019ff900-0000-7000-8000-000000000001';

/** Documentation range (RFC 5737) — never a real caller. */
let nextAddress = 0;
function ownAddress(): string {
  nextAddress += 1;
  return `198.51.100.${String((nextAddress % 250) + 1)}`;
}

function definition(): unknown {
  return {
    pages: [
      {
        id: PAGE,
        title: 'Anmeldung',
        description: null,
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

describe('a form nobody configured', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  let tenant: TenantFixture;
  let editor: string;
  let form: { id: string; slug: string };

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({
      databaseUrl: database.url,
      // The installation's own address is a row — without it there is no
      // absolute edit link, and `editUrl` would be `null` for a different reason
      // than the setting.
      systemMail: { publicBaseUrl: TEST_PUBLIC_BASE_URL },
      env: { TRUST_PROXY_HOPS: 1 },
    });

    tenant = await createTenant(testApp.prisma, 'SHIP');
    const user = await createUser(testApp.prisma, {
      email: 'editor@example.org',
      password: PASSWORD,
      tenants: [tenant],
    });
    editor = await openSession(testApp, user.id, tenant.id);

    // Created, saved, published — and **no** `PUT /forms/:id/settings` and no
    // `PUT /tenant/form-defaults` in between.
    const created = await request(app().server)
      .post(apiPath('/forms'))
      .set(authedMutation(editor))
      .send({ title: 'Ohne jede Einstellung' });
    const row = created.body as {
      id: string;
      revision: number;
      publicSlug: string;
    };

    const saved = await request(app().server)
      .put(apiPath(`/forms/${row.id}`))
      .set(authedMutation(editor))
      .send({
        title: 'Ohne jede Einstellung',
        definition: definition(),
        revision: row.revision,
      });
    const published = await request(app().server)
      .post(apiPath(`/forms/${row.id}/publish`))
      .set(authedMutation(editor))
      .send({ revision: (saved.body as { revision: number }).revision });
    expect(published.status).toBe(200);

    form = { id: row.id, slug: row.publicSlug };
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  it('carries no stored setting at all, on either layer', async () => {
    const stored = await app().prisma.form.findUniqueOrThrow({
      where: { id: form.id },
      select: { settingsOverride: true },
    });
    const organisation = await app().prisma.tenant.findUniqueOrThrow({
      where: { id: tenant.id },
      select: { formDefaults: true },
    });

    // Both columns empty: what the two cases below measure comes from the
    // shipped default and from nothing else.
    expect(stored.settingsOverride).toStrictEqual({});
    expect(organisation.formDefaults).toStrictEqual({});
  });

  it('offers Zwischenspeichern to the fill-in view, and accepts the save', async () => {
    const read = await request(app().server)
      .get(apiPath(`/public/forms/${form.slug}`))
      .set('X-Forwarded-For', ownAddress());

    expect(read.status).toBe(200);
    expect((read.body as { canSaveDraft: boolean }).canSaveDraft).toBe(true);

    // Both halves of the rule, not only the view: the switch also decides
    // whether the route accepts anything. A `canSaveDraft: true` above a route
    // that answers 409 would be an offered button without effect.
    const draft = await request(app().server)
      .post(apiPath(`/public/forms/${form.slug}/drafts`))
      .set('X-Forwarded-For', ownAddress())
      .send({ answers: { [NAME]: 'Anton' } });

    expect(draft.status).toBe(200);
  });

  it('hands out an edit link on the confirmation, and the link opens', async () => {
    const submitted = await request(app().server)
      .post(apiPath(`/public/forms/${form.slug}/responses`))
      .set('X-Forwarded-For', ownAddress())
      .send({ answers: { [NAME]: 'Anton' } });

    expect(submitted.status).toBe(200);
    const { editUrl } = submitted.body as { editUrl: string | null };
    expect(editUrl).not.toBeNull();
    expect(editUrl?.startsWith(`${TEST_PUBLIC_BASE_URL}/a/`)).toBe(true);

    // And the address leads somewhere: `allowEdit` is read on **every** access,
    // so an issued link alone proves nothing. If the default stood on `false`,
    // `409 editing_disabled` would come here.
    const token = (editUrl ?? '').slice((editUrl ?? '').lastIndexOf('/') + 1);
    const opened = await request(app().server)
      .get(apiPath(`/public/responses/${token}`))
      .set('X-Forwarded-For', ownAddress());

    expect(opened.status).toBe(200);
  });
});
