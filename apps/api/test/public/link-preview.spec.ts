import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import {
  apiPath,
  createTestApp,
  type TestApp,
} from '../support/create-test-app';
import { createTenant, createUser } from '../support/fixtures';
import { authedMutation, openSession } from '../support/http';

/**
 * **What a messenger shows for a shared public address** (ADR-0033).
 *
 * The front door splices this route's answer into `<head>` of `/f/<Adresse>`.
 * It is reachable without a login, so the cases that matter are the ones where
 * it must say **nothing** about the form: never published, deleted, closed, full
 * — each answers exactly the plain title an unknown address gets. And behind an
 * access word the intro stays withheld, the same line the fill-in view draws.
 */

const PASSWORD = 'test-password';
const WORD = 'Sommerfest-Zugang';
const PAGE = '019ff400-0000-7000-8000-0000000000a0';
const NAME = '019ff400-0000-7000-8000-000000000001';
const INTRO = 'Bitte bis Freitag anmelden — Grillgut bringen wir mit.';
const PLAIN = '<title>Formsache</title>\n';

function definition() {
  return {
    pages: [
      {
        id: PAGE,
        title: 'Anmeldung',
        description: INTRO,
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

let nextAddress = 0;
function ownAddress(): string {
  nextAddress += 1;
  return `198.51.100.${String((nextAddress % 250) + 1)}`;
}

describe('the link preview of a public address', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  let editor: string;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({
      databaseUrl: database.url,
      env: { TRUST_PROXY_HOPS: 1 },
    });

    const tenant = await createTenant(testApp.prisma, 'LNK');
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

  async function createForm(
    title: string,
    publish: boolean,
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
    expect(saved.status).toBe(200);

    if (publish) {
      const published = await request(app().server)
        .post(apiPath(`/forms/${form.id}/publish`))
        .set(authedMutation(editor))
        .send({ revision: (saved.body as { revision: number }).revision });
      expect(published.status).toBe(200);
    }
    return { id: form.id, slug: form.publicSlug };
  }

  /** Writes a form's settings through the real route. */
  async function configure(
    formId: string,
    overridden: Record<string, boolean>,
    values: Record<string, unknown>,
  ): Promise<void> {
    const form = await app().prisma.form.findUniqueOrThrow({
      where: { id: formId },
      select: { settingsRevision: true, tenantId: true },
    });
    const tenantRow = await app().prisma.tenant.findUniqueOrThrow({
      where: { id: form.tenantId },
      select: { formDefaultsRevision: true },
    });

    const response = await request(app().server)
      .put(apiPath(`/forms/${formId}/settings`))
      .set(authedMutation(editor))
      .send({
        overridden: {
          access: false,
          confirm: false,
          display: false,
          budget: false,
          ...overridden,
        },
        values,
        revision: form.settingsRevision,
        tenantRevision: tenantRow.formDefaultsRevision,
      });
    expect(response.status).toBe(200);
  }

  function preview(slug: string): Promise<request.Response> {
    return request(app().server)
      .get(apiPath(`/public/forms/${slug}/link-preview`))
      .set('X-Forwarded-For', ownAddress());
  }

  it('names an open form, its organisation and the intro of its first page', async () => {
    const form = await createForm('Sommerfest & Grillen', true);

    const response = await preview(form.slug);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.text).toContain('<title>Sommerfest &amp; Grillen</title>');
    expect(response.text).toContain(
      '<meta property="og:title" content="Sommerfest &amp; Grillen" />',
    );
    expect(response.text).toContain(
      '<meta property="og:site_name" content="Organisation LNK" />',
    );
    expect(response.text).toContain(
      `<meta property="og:description" content="${INTRO}" />`,
    );
  });

  it('keeps the title of a form that opens later — such links go out ahead', async () => {
    const form = await createForm('Anmeldung ab Januar', true);
    await configure(
      form.id,
      {},
      { openEnabled: true, openAt: '2099-01-01T00:00:00.000Z' },
    );

    const response = await preview(form.slug);

    expect(response.text).toContain('<title>Anmeldung ab Januar</title>');
  });

  it('shows the title behind an access word, and withholds the intro', async () => {
    const form = await createForm('Geschlossene Runde', true);
    await configure(
      form.id,
      { access: true },
      { passwordEnabled: true, password: WORD },
    );

    const response = await preview(form.slug);

    expect(response.text).toContain('<title>Geschlossene Runde</title>');
    expect(response.text).not.toContain(INTRO);
    expect(response.text).not.toContain('description');
  });

  /**
   * The locked stub of `bySlug` says nothing about availability, so neither
   * may this route: a stranger would otherwise watch a protected form close or
   * fill up by polling its preview.
   */
  describe('behind an access word, says nothing about availability', () => {
    it('a closed protected form keeps its title', async () => {
      const form = await createForm('Geschützt und vorbei', true);
      await configure(
        form.id,
        { access: true },
        {
          passwordEnabled: true,
          password: WORD,
          openEnabled: true,
          closeAt: '2020-01-01T00:00:00.000Z',
        },
      );

      expect((await preview(form.slug)).text).toContain(
        '<title>Geschützt und vorbei</title>',
      );
    });

    it('a full protected form keeps its title', async () => {
      const form = await createForm('Geschützt und voll', true);
      await configure(
        form.id,
        { access: true },
        {
          passwordEnabled: true,
          password: WORD,
          maxResponsesEnabled: true,
          maxResponses: 1,
        },
      );
      // Written directly: submitting would need the word first, and what is
      // under test is the preview of a full form, not the gate.
      const row = await app().prisma.form.findUniqueOrThrow({
        where: { id: form.id },
        select: { tenantId: true, publishedVersionId: true },
      });
      await app().prisma.response.create({
        data: {
          formId: form.id,
          tenantId: row.tenantId,
          formVersionId: row.publishedVersionId ?? '',
          answers: {},
        },
      });

      expect((await preview(form.slug)).text).toContain(
        '<title>Geschützt und voll</title>',
      );
    });
  });

  describe('says nothing about a form that cannot be filled in', () => {
    it('a form that was never published', async () => {
      const form = await createForm('Geheimer Entwurf', false);

      const response = await preview(form.slug);

      expect(response.status).toBe(200);
      expect(response.text).toBe(PLAIN);
    });

    it('a deleted form', async () => {
      const form = await createForm('Im Papierkorb', true);
      await app().prisma.form.update({
        where: { id: form.id },
        data: { deletedAt: new Date() },
      });

      expect((await preview(form.slug)).text).toBe(PLAIN);
    });

    it('a form of a deleted organisation', async () => {
      const other = await createTenant(app().prisma, 'LNX');
      const user = await createUser(app().prisma, {
        email: 'editor-lnx@example.org',
        password: PASSWORD,
        tenants: [other],
      });
      const session = await openSession(app(), user.id, other.id);
      const created = await request(app().server)
        .post(apiPath('/forms'))
        .set(authedMutation(session))
        .send({ title: 'Organisation aufgelöst' });
      const form = created.body as {
        id: string;
        revision: number;
        publicSlug: string;
      };
      const saved = await request(app().server)
        .put(apiPath(`/forms/${form.id}`))
        .set(authedMutation(session))
        .send({
          title: 'Organisation aufgelöst',
          definition: definition(),
          revision: form.revision,
        });
      await request(app().server)
        .post(apiPath(`/forms/${form.id}/publish`))
        .set(authedMutation(session))
        .send({ revision: (saved.body as { revision: number }).revision });
      // The control: while the organisation exists, the title shows.
      expect((await preview(form.publicSlug)).text).toContain(
        '<title>Organisation aufgelöst</title>',
      );

      await app().prisma.tenant.update({
        where: { id: other.id },
        data: { deletedAt: new Date() },
      });

      expect((await preview(form.publicSlug)).text).toBe(PLAIN);
    });

    it('a form whose published snapshot does not parse', async () => {
      const form = await createForm('Kaputter Stand', true);
      await app().prisma.formVersion.updateMany({
        where: { formId: form.id },
        data: { schema: { pages: 'kaputt' } },
      });

      expect((await preview(form.slug)).text).toBe(PLAIN);
    });

    it('a form past its closing instant', async () => {
      const form = await createForm('Frist vorbei', true);
      await configure(
        form.id,
        {},
        { openEnabled: true, closeAt: '2020-01-01T00:00:00.000Z' },
      );

      expect((await preview(form.slug)).text).toBe(PLAIN);
    });

    it('a form that reached its response limit', async () => {
      const form = await createForm('Ausgebucht', true);
      await configure(
        form.id,
        {},
        { maxResponsesEnabled: true, maxResponses: 1 },
      );
      // Open until the one place is taken — the control for this case.
      expect((await preview(form.slug)).text).toContain(
        '<title>Ausgebucht</title>',
      );

      const submitted = await request(app().server)
        .post(apiPath(`/public/forms/${form.slug}/responses`))
        .set('X-Forwarded-For', ownAddress())
        .send({ answers: { [NAME]: 'Anton' } });
      expect(submitted.status).toBe(200);

      expect((await preview(form.slug)).text).toBe(PLAIN);
    });

    it.each([
      ['an unknown address', 'gibtesnicht'],
      ['an address outside the slug alphabet', 'AbCd%00Ef'],
    ])('%s', async (_case, slug) => {
      const response = await preview(slug);

      expect(response.status).toBe(200);
      expect(response.text).toBe(PLAIN);
    });
  });
});
