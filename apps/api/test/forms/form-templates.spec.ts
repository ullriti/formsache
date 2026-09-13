import type { Prisma } from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  FORM_TEMPLATE_NOT_FOUND_MESSAGE,
  FORM_TEMPLATE_SETTINGS_INVALID_MESSAGE,
} from '../../src/form-templates/form-template-content';
import { FORM_TEMPLATE_KIND_MISMATCH_MESSAGE } from '../../src/form-templates/form-templates.service';
import { MISSING_PERMISSION_MESSAGE } from '../../src/tenancy/group-permission.guard';
import { FORM_NOT_FOUND_MESSAGE } from '../../src/forms/forms.service';
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
import { NO_SECTIONS } from '../support/settings-sections';
import { authedMutation, cookieHeader, openSession } from '../support/http';

/**
 * Templates — **the mechanism, without any shipped content** .
 *
 * The four proofs of the requirement, each written the way `CONTRIBUTING.md` asks
 * of a rights or isolation rule — through the case that has to **fail** — plus
 * the two reproductions the requirement names:
 *
 * 1. **Out of an own form template arises a form that can be published and
 *    filled in.** Played through the real public path, which is the proof five
 *    field comparisons cannot give.
 * 2. **A page template appends a page to an existing form, with new ids.**
 *    *Reproduction:* keeping the ids would make the id-inequality assertions
 *    below fail, and the second insertion of one template would land on
 *    `formDefinitionSchema`'s duplicate-id refusal.
 * 3. **A template is bound to the tenant.** *Reproduction:* dropping the tenant
 *    from the list query would put BETA's template into ALPHA's list — asserted
 *    both ways round, and the 404 is measured to be byte-identical with the one
 *    an unknown id gets.
 * 4. **Copy, not reference.** The source form is changed after the template
 *    was saved, and the template after the form was made from it.
 *
 * **And what a template does not carry**: the access word (the specification — it is
 * stored decryptably, so a template carrying it would be a secret travelling to
 * a form nobody set it for), answers, versions and the public address.
 *
 * There is **no fixture in this file that a seed or a migration ships.** The
 * example forms live here, in the test, exactly as the work item requires.
 */

const PASSWORD = 'test-password';
const ACCESS_WORD = 'jahrestagung-2026-zugang';

describe('Vorlagen ', () => {
  let testApp: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let alphaAdmin: string;
  let betaAdmin: string;
  let database: TestDatabase | undefined;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });

    alpha = await createTenant(testApp.prisma, 'ALPHA');
    beta = await createTenant(testApp.prisma, 'BETA');

    const alphaUser = await createUser(testApp.prisma, {
      email: 'alpha-tpl@example.org',
      password: PASSWORD,
      tenants: [alpha],
    });
    const betaUser = await createUser(testApp.prisma, {
      email: 'beta-tpl@example.org',
      password: PASSWORD,
      tenants: [beta],
    });

    alphaAdmin = await openSession(testApp, alphaUser.id, alpha.id);
    betaAdmin = await openSession(testApp, betaUser.id, beta.id);
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  const PAGE_ONE = '019fe900-0000-7000-8000-0000000000b1';
  const PAGE_TWO = '019fe900-0000-7000-8000-0000000000b2';
  const MAIL_QUESTION = '019fe900-0000-7000-8000-000000000011';
  /** Conditional on {@link MAIL_QUESTION} — same page, so it travels along. */
  const NOTE_QUESTION = '019fe900-0000-7000-8000-000000000012';
  /** On page two, conditional on a question of page **one** — it does not. */
  const CROSS_PAGE_QUESTION = '019fe900-0000-7000-8000-000000000013';

  interface FormBody {
    id: string;
    revision: number;
    publicSlug: string;
    title: string;
    status: string;
    publishedVersion: number | null;
    definition: {
      pages: {
        id: string;
        title: string;
        questions: {
          id: string;
          label: string;
          visibleIf?: { questionId: string };
        }[];
      }[];
    };
  }

  interface TemplateBody {
    id: string;
    kind: string;
    name: string;
    questionCount: number;
    createdAt: string;
  }

  function twoPageDefinition(): unknown {
    return {
      pages: [
        {
          id: PAGE_ONE,
          title: 'Ihre Daten',
          description: null,
          questions: [
            {
              id: MAIL_QUESTION,
              type: 'email',
              label: 'E-Mail',
              hint: null,
              required: true,
              width: 'full',
            },
            {
              id: NOTE_QUESTION,
              type: 'text',
              label: 'Anmerkung',
              hint: null,
              required: false,
              width: 'full',
              minLength: null,
              maxLength: null,
              pattern: null,
              visibleIf: { questionId: MAIL_QUESTION, operator: 'filled' },
            },
          ],
        },
        {
          id: PAGE_TWO,
          title: 'Anreise',
          description: null,
          questions: [
            {
              id: CROSS_PAGE_QUESTION,
              type: 'text',
              label: 'Ankunft',
              hint: null,
              required: false,
              width: 'full',
              minLength: null,
              maxLength: null,
              pattern: null,
              // The source lives on page one. Saving page two as a template
              // leaves that source behind.
              visibleIf: { questionId: MAIL_QUESTION, operator: 'filled' },
            },
          ],
        },
      ],
    };
  }

  /** A saved form with two pages, a condition on each, and an access word. */
  async function buildForm(
    token: string,
    title: string,
    options: { readonly withAccessWord?: boolean } = {},
  ): Promise<FormBody> {
    const created = await request(app().server)
      .post(apiPath('/forms'))
      .set(authedMutation(token))
      .send({ title });
    expect(created.status).toBe(201);
    const form = created.body as FormBody;

    const saved = await request(app().server)
      .put(apiPath(`/forms/${form.id}`))
      .set(authedMutation(token))
      .send({
        title,
        definition: twoPageDefinition(),
        revision: form.revision,
      });
    expect(saved.status).toBe(200);

    if (options.withAccessWord === true) {
      const row = await app().prisma.form.findUniqueOrThrow({
        where: { id: form.id },
        select: { settingsRevision: true, tenantId: true },
      });
      const tenantRow = await app().prisma.tenant.findUniqueOrThrow({
        where: { id: row.tenantId },
        select: { formDefaultsRevision: true },
      });
      const settings = await request(app().server)
        .put(apiPath(`/forms/${form.id}/settings`))
        .set(authedMutation(token))
        .send({
          revision: row.settingsRevision,
          tenantRevision: tenantRow.formDefaultsRevision,
          overridden: { ...NO_SECTIONS, access: true },
          values: { passwordEnabled: true, password: ACCESS_WORD },
        });
      expect(settings.status).toBe(200);
    }

    const reread = await request(app().server)
      .get(apiPath(`/forms/${form.id}`))
      .set('Cookie', cookieHeader(token));
    return reread.body as FormBody;
  }

  /** A page whose question names a question retired in the source form. */
  const RETIRED = '019fe900-0000-7000-8000-000000000021';
  const SUCCESSOR = '019fe900-0000-7000-8000-000000000022';

  /**
   * A saved form with exactly one question that carries a `replaces`.
   *
   * In the outer scope, because two blocks need it: a review finding measures
   * the *saving* against it, the specification the *updating* — and a second
   * build of the same form would be exactly the copy that drifts apart.
   */
  async function formWithReplaces(title: string): Promise<FormBody> {
    const created = await request(app().server)
      .post(apiPath('/forms'))
      .set(authedMutation(alphaAdmin))
      .send({ title });
    const form = created.body as FormBody;

    const saved = await request(app().server)
      .put(apiPath(`/forms/${form.id}`))
      .set(authedMutation(alphaAdmin))
      .send({
        title,
        definition: {
          pages: [
            {
              id: PAGE_ONE,
              title: 'Ihre Daten',
              description: null,
              questions: [
                {
                  id: SUCCESSOR,
                  type: 'text',
                  label: 'Anmerkung (neu)',
                  hint: null,
                  required: false,
                  width: 'full',
                  minLength: null,
                  maxLength: null,
                  pattern: null,
                  // What a change of type in the builder leaves behind: the
                  // id of the question that was retired *in this form*.
                  replaces: RETIRED,
                },
              ],
            },
          ],
        },
        revision: form.revision,
      });
    expect(saved.status).toBe(200);
    return saved.body as FormBody;
  }

  async function saveTemplate(
    token: string,
    formId: string,
    // `object` and not `unknown`: supertest's `send` takes a body, and the
    // bodies here are all object literals — including the deliberately
    // malformed ones, whose defect is a *field*, never the shape.
    body: object,
  ): Promise<request.Response> {
    return request(app().server)
      .post(apiPath(`/forms/${formId}/templates`))
      .set(authedMutation(token))
      .send(body);
  }

  async function listTemplates(token: string): Promise<TemplateBody[]> {
    const response = await request(app().server)
      .get(apiPath('/form-templates'))
      .set('Cookie', cookieHeader(token));
    expect(response.status).toBe(200);
    return (response.body as { templates: TemplateBody[] }).templates;
  }

  /** „Umbenennen" — the template route, without a form. */
  async function renameTemplate(
    token: string,
    templateId: string,
    body: object,
  ): Promise<request.Response> {
    return request(app().server)
      .patch(apiPath(`/form-templates/${templateId}`))
      .set(authedMutation(token))
      .send(body);
  }

  /** „Aus diesem Formular aktualisieren" — underneath the form. */
  async function updateTemplate(
    token: string,
    formId: string,
    templateId: string,
    body: object,
  ): Promise<request.Response> {
    return request(app().server)
      .put(apiPath(`/forms/${formId}/templates/${templateId}`))
      .set(authedMutation(token))
      .send(body);
  }

  /** The stored content of a template, as JSON text for comparing. */
  async function storedContent(templateId: string): Promise<string> {
    const row = await app().prisma.formTemplate.findUniqueOrThrow({
      where: { id: templateId },
    });
    return JSON.stringify(row.content);
  }

  async function instantiate(
    token: string,
    templateId: string,
  ): Promise<request.Response> {
    return request(app().server)
      .post(apiPath(`/form-templates/${templateId}/instance`))
      .set(authedMutation(token));
  }

  async function createFrom(
    token: string,
    templateId: string,
    title: string,
  ): Promise<request.Response> {
    return request(app().server)
      .post(apiPath('/forms'))
      .set(authedMutation(token))
      .send({ title, templateId });
  }

  // -------------------------------------------------------------------------
  // the evidence — out of a form template arises a usable form
  // -------------------------------------------------------------------------

  describe('der Nachweis — eine Formular-Vorlage wird ein Formular', () => {
    it('lässt sich veröffentlichen und ausfüllen', async () => {
      const source = await buildForm(alphaAdmin, 'Bestandsmeldung');
      const saved = await saveTemplate(alphaAdmin, source.id, {
        kind: 'form',
        name: 'Meine Rückmeldung',
      });
      expect(saved.status).toBe(201);
      const template = saved.body as TemplateBody;
      expect(template.kind).toBe('form');
      expect(template.questionCount).toBe(3);

      const created = await createFrom(
        alphaAdmin,
        template.id,
        'Rückmeldung 2027',
      );
      expect(created.status).toBe(201);
      const form = created.body as FormBody;

      // Not a dead document: it goes through the real public path end to end.
      const questionId = form.definition.pages[0]?.questions[0]?.id;
      if (questionId === undefined) {
        throw new Error('expected a question on the first page');
      }
      const published = await request(app().server)
        .post(apiPath(`/forms/${form.id}/publish`))
        .set(authedMutation(alphaAdmin))
        .send({ revision: form.revision });
      expect(published.status).toBe(200);

      const submitted = await request(app().server)
        .post(apiPath(`/public/forms/${form.publicSlug}/responses`))
        .send({ answers: { [questionId]: 'anton@example.org' } });
      expect(submitted.status).toBe(200);

      const stored = await app().prisma.response.findFirst({
        where: { formId: form.id },
      });
      expect(stored?.answers).toMatchObject({
        [questionId]: 'anton@example.org',
      });
    });

    it('gibt dem Formular neue IDs, eine eigene öffentliche Adresse und keine Fassung', async () => {
      const source = await buildForm(alphaAdmin, 'Neue IDs');
      const template = (
        await saveTemplate(alphaAdmin, source.id, {
          kind: 'form',
          name: 'Neue IDs Vorlage',
        })
      ).body as TemplateBody;

      const first = (await createFrom(alphaAdmin, template.id, 'Erstes'))
        .body as FormBody;
      const second = (await createFrom(alphaAdmin, template.id, 'Zweites'))
        .body as FormBody;

      const firstIds = first.definition.pages.flatMap((page) =>
        page.questions.map((question) => question.id),
      );
      const secondIds = second.definition.pages.flatMap((page) =>
        page.questions.map((question) => question.id),
      );

      // Reproduction: keeping the ids would make all three of these pass by
      // accident — and the two forms would share answer keys.
      expect(firstIds).not.toContain(MAIL_QUESTION);
      expect(firstIds).not.toContain(NOTE_QUESTION);
      expect(new Set([...firstIds, ...secondIds]).size).toBe(
        firstIds.length + secondIds.length,
      );

      // …and the condition follows its source to the copy's id, not the old one.
      const followUp = first.definition.pages[0]?.questions[1];
      expect(followUp?.visibleIf?.questionId).toBe(firstIds[0]);

      expect(first.publicSlug).not.toBe(second.publicSlug);
      expect(first.publicSlug).not.toBe(source.publicSlug);
      expect(first.status).toBe('draft');
      expect(first.publishedVersion).toBeNull();
      expect(
        await app().prisma.formVersion.count({ where: { formId: first.id } }),
      ).toBe(0);
      expect(
        await app().prisma.response.count({ where: { formId: first.id } }),
      ).toBe(0);
    });

    it('nimmt den Titel des Anlegenden, nicht den der Vorlage', async () => {
      const source = await buildForm(alphaAdmin, 'Ursprungstitel');
      const template = (
        await saveTemplate(alphaAdmin, source.id, {
          kind: 'form',
          name: 'Vorlagenname',
        })
      ).body as TemplateBody;

      const form = (await createFrom(alphaAdmin, template.id, 'Frei benannt'))
        .body as FormBody;

      expect(form.title).toBe('Frei benannt');
    });
  });

  // -------------------------------------------------------------------------
  // What a template carries — and what it does not
  // -------------------------------------------------------------------------

  describe('was eine Vorlage trägt, und was nicht', () => {
    /**
     * The trap once named and this requirement repeats: an access word is stored
     * decryptably and sealed under the **source form's** id, so a
     * template carrying it would put a secret nobody set into a second form —
     * one that cannot even open it.
     */
    it('trägt kein Zugangswort — weder in der Zeile noch im daraus gebauten Formular', async () => {
      const source = await buildForm(alphaAdmin, 'Mit Zugangswort', {
        withAccessWord: true,
      });
      const template = (
        await saveTemplate(alphaAdmin, source.id, {
          kind: 'form',
          name: 'Geschützt',
        })
      ).body as TemplateBody;

      const row = await app().prisma.formTemplate.findUniqueOrThrow({
        where: { id: template.id },
      });
      expect(JSON.stringify(row.content)).not.toContain(ACCESS_WORD);

      const form = (await createFrom(alphaAdmin, template.id, 'Ohne Wort'))
        .body as FormBody;
      const settings = await request(app().server)
        .get(apiPath(`/forms/${form.id}/settings`))
        .set('Cookie', cookieHeader(alphaAdmin));
      expect(settings.status).toBe(200);
      const values = (
        settings.body as {
          values: { password?: string; passwordEnabled?: boolean };
          effective: { passwordEnabled: boolean };
        }
      ).values;
      expect(values.password).toBe('');
      expect(values.passwordEnabled).toBe(false);
      expect(
        (settings.body as { effective: { passwordEnabled: boolean } }).effective
          .passwordEnabled,
      ).toBe(false);

      const formRow = await app().prisma.form.findUniqueOrThrow({
        where: { id: form.id },
      });
      expect(JSON.stringify(formRow.settingsOverride)).not.toContain(
        ACCESS_WORD,
      );
    });

    it('trägt die übrigen Einstellungen sehr wohl', async () => {
      const source = await buildForm(alphaAdmin, 'Mit Frist');
      const row = await app().prisma.form.findUniqueOrThrow({
        where: { id: source.id },
        select: { settingsRevision: true },
      });
      const tenantRow = await app().prisma.tenant.findUniqueOrThrow({
        where: { id: alpha.id },
        select: { formDefaultsRevision: true },
      });
      const written = await request(app().server)
        .put(apiPath(`/forms/${source.id}/settings`))
        .set(authedMutation(alphaAdmin))
        .send({
          revision: row.settingsRevision,
          tenantRevision: tenantRow.formDefaultsRevision,
          overridden: { ...NO_SECTIONS },
          values: { closeAt: '2026-09-30T22:00:00.000Z' },
        });
      expect(written.status).toBe(200);

      const template = (
        await saveTemplate(alphaAdmin, source.id, {
          kind: 'form',
          name: 'Mit Frist',
        })
      ).body as TemplateBody;
      const form = (await createFrom(alphaAdmin, template.id, 'Erbt die Frist'))
        .body as FormBody;

      const settings = await request(app().server)
        .get(apiPath(`/forms/${form.id}/settings`))
        .set('Cookie', cookieHeader(alphaAdmin));
      // *Verfügbarkeit* has no switch any more — the deadline travels along as
      // a value and counts in the new form as its own (ADR-0011,
      // continuation 2026-08-14).
      expect(
        (settings.body as { effective: { closeAt: string | null } }).effective
          .closeAt,
      ).toBe('2026-09-30T22:00:00.000Z');
    });

    it('lässt eine Bedingung fallen, deren Quelle nicht mitreist', async () => {
      const source = await buildForm(alphaAdmin, 'Seite mit Fremdbezug');

      const template = (
        await saveTemplate(alphaAdmin, source.id, {
          kind: 'page',
          name: 'Anreise',
          pageId: PAGE_TWO,
        })
      ).body as TemplateBody;

      const instance = await instantiate(alphaAdmin, template.id);
      expect(instance.status).toBe(200);
      const page = (
        instance.body as {
          page: { questions: { visibleIf?: unknown }[] };
        }
      ).page;

      // The source of that condition is on page one and stayed behind; keeping
      // it would put an id of *another* form into this block.
      expect(page.questions[0]?.visibleIf).toBeUndefined();
    });

    it('behält eine Bedingung, deren Quelle auf derselben Seite steht', async () => {
      const source = await buildForm(alphaAdmin, 'Seite mit eigener Bedingung');

      const template = (
        await saveTemplate(alphaAdmin, source.id, {
          kind: 'page',
          name: 'Ihre Daten',
          pageId: PAGE_ONE,
        })
      ).body as TemplateBody;

      const instance = await instantiate(alphaAdmin, template.id);
      const page = (
        instance.body as {
          page: {
            questions: { id: string; visibleIf?: { questionId: string } }[];
          };
        }
      ).page;

      expect(page.questions[1]?.visibleIf?.questionId).toBe(
        page.questions[0]?.id,
      );
      expect(page.questions[1]?.visibleIf?.questionId).not.toBe(MAIL_QUESTION);
    });

    it('speichert eine Frage einzeln, immer ohne ihre Bedingung', async () => {
      const source = await buildForm(alphaAdmin, 'Einzelne Frage');

      const saved = await saveTemplate(alphaAdmin, source.id, {
        kind: 'question',
        name: 'Anmerkung',
        questionId: NOTE_QUESTION,
      });
      expect(saved.status).toBe(201);
      expect((saved.body as TemplateBody).questionCount).toBe(1);

      const instance = await instantiate(
        alphaAdmin,
        (saved.body as TemplateBody).id,
      );
      const question = (
        instance.body as {
          question: { id: string; label: string; visibleIf?: unknown };
        }
      ).question;

      expect(question.label).toBe('Anmerkung');
      expect(question.id).not.toBe(NOTE_QUESTION);
      expect(question.visibleIf).toBeUndefined();
    });

    it('antwortet 404, wenn Seite oder Frage nicht zu diesem Formular gehören', async () => {
      const source = await buildForm(alphaAdmin, 'Fremde Teile');

      const unknownPage = await saveTemplate(alphaAdmin, source.id, {
        kind: 'page',
        name: 'Gibt es nicht',
        pageId: '019fe900-0000-7000-8000-0000000000ff',
      });
      const unknownQuestion = await saveTemplate(alphaAdmin, source.id, {
        kind: 'question',
        name: 'Gibt es nicht',
        questionId: '019fe900-0000-7000-8000-0000000000fe',
      });

      expect(unknownPage.status).toBe(404);
      expect(unknownQuestion.status).toBe(404);
      expect(
        await app().prisma.formTemplate.count({
          where: { tenantId: alpha.id },
        }),
      ).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // rework of a review finding — a row the write path would never have created
  // -------------------------------------------------------------------------

  /**
   * **The write path is not the only source of a row** — precisely the threat
   * model `stripOverridePassword` was justified with („a hand written UPDATE,
   * an import, a restore").
   *
   * The rows here therefore come about **past the API**, straight through
   * Prisma: a template that `POST /forms/:id/templates` would never have
   * written that way. Before the rework `formTemplateFormContentSchema`
   * carried this one field as `z.unknown()` and `FormsService.create` cast it
   * raw into `form.settings_override` — *measured on 2026-08-05:* **201**,
   * stored byte-identically, afterwards permanently **500** on
   * `GET /forms/:id/settings`, so no longer repairable through the interface.
   */
  describe('ein Review-Befund — eine handgeschriebene Vorlagenzeile', () => {
    /**
     * The rows of this block, so that they do not outlive it.
     *
     * `GET /form-templates` reads **every** row of the organisation in order to
     * compute the question count; a row that deliberately does not parse
     * therefore makes the whole drawer unreadable. Since the rework that holds
     * for a broken `definition` just as much, and it is not the statement here
     * — the statement is what happens on *insertion*. So it is cleaned up
     * instead of leaving the remaining cases of this file a row they would
     * never have expected.
     */
    const handWrittenIds: string[] = [];

    afterEach(async () => {
      await app().prisma.formTemplate.deleteMany({
        where: { id: { in: handWrittenIds } },
      });
      handWrittenIds.length = 0;
    });

    /** Writes a `form_template` row bypassing the route. */
    async function handWritten(settingsOverride: unknown): Promise<string> {
      const row = await app().prisma.formTemplate.create({
        data: {
          tenantId: alpha.id,
          kind: 'form',
          name: 'Von Hand geschrieben',
          // The whole point of this block: the column takes any JSON, and the
          // cast stands here as a stand-in for everything that writes past the
          // application.
          content: {
            kind: 'form',
            title: 'Von Hand geschrieben',
            definition: twoPageDefinition(),
            settingsOverride,
          } as Prisma.InputJsonValue,
        },
      });
      handWrittenIds.push(row.id);
      return row.id;
    }

    it('scheitert beim Einsetzen, statt Klartext und Fremdschlüssel weiterzureichen', async () => {
      const templateId = await handWritten({
        values: { passwordEnabled: true, password: 'KLARTEXT-GEHEIM' },
        unbekannterSchluessel: 'x',
      });
      const before = await app().prisma.form.count({
        where: { tenantId: alpha.id },
      });

      const refused = await createFrom(
        alphaAdmin,
        templateId,
        'Aus Handarbeit',
      );

      // Reproduction: describe `settingsOverride` as `z.unknown()` again →
      // 201 instead of a refusal, and the plaintext word stands in the column.
      expect(refused.status).toBe(400);
      expect(refused.text).not.toContain('KLARTEXT-GEHEIM');
      expect(
        await app().prisma.form.count({ where: { tenantId: alpha.id } }),
      ).toBe(before);
    });

    it('scheitert mit 422, wenn die Werte einander widersprechen', async () => {
      // Formally valid — every key exists and has the right type —, but a
      // window that closes before it opens. Only the system level knows this
      // rule, and that level is not present until the insertion.
      const templateId = await handWritten({
        overridden: {
          access: false,
          confirm: false,
          display: false,
          budget: false,
        },
        values: {
          openAt: '2026-09-30T22:00:00.000Z',
          closeAt: '2026-09-01T22:00:00.000Z',
        },
      });
      const before = await app().prisma.form.count({
        where: { tenantId: alpha.id },
      });

      const refused = await createFrom(
        alphaAdmin,
        templateId,
        'Fenster verkehrt',
      );

      expect(refused.status).toBe(422);
      expect(refused.text).toContain(FORM_TEMPLATE_SETTINGS_INVALID_MESSAGE);
      // And the message going outwards carries no Zod path, no field, no
      // internal name (`CONTRIBUTING.md`).
      expect(refused.text).not.toContain('closeAt');
      expect(
        await app().prisma.form.count({ where: { tenantId: alpha.id } }),
      ).toBe(before);
    });

    /**
     * The second bolt, and the one the form check alone does not provide: a
     * plaintext word is **formally valid**. It must nevertheless not become
     * the password of the new form — it would be a secret nobody set.
     */
    it('nimmt der Vorlage das Wort ab, statt es zum Passwort des neuen Formulars zu machen', async () => {
      const templateId = await handWritten({
        overridden: {
          access: true,
          confirm: false,
          display: false,
          budget: false,
        },
        values: { passwordEnabled: true, password: 'KLARTEXT-GEHEIM' },
      });

      const created = await createFrom(
        alphaAdmin,
        templateId,
        'Wort abgenommen',
      );
      expect(created.status).toBe(201);
      const form = created.body as FormBody;

      const row = await app().prisma.form.findUniqueOrThrow({
        where: { id: form.id },
      });
      expect(JSON.stringify(row.settingsOverride)).not.toContain(
        'KLARTEXT-GEHEIM',
      );

      // And the settings page can be opened — before, exactly that was
      // permanently 500, because the plaintext word was read as a seal.
      const settings = await request(app().server)
        .get(apiPath(`/forms/${form.id}/settings`))
        .set('Cookie', cookieHeader(alphaAdmin));
      expect(settings.status).toBe(200);
      expect(
        (settings.body as { effective: { passwordEnabled: boolean } }).effective
          .passwordEnabled,
      ).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // rework of a review finding — `replaces` does not travel along
  // -------------------------------------------------------------------------

  describe('ein Review-Befund — eine Vorlage hält keine ID des Quellformulars', () => {
    /**
     * *Measured on 2026-08-05:* `"replaces":"019fe911-…-000000000011"` — a
     * question id of the source form — stood in the stored page template, in a
     * row without any connection to it.
     *
     * **One test per kind** (rework of the specification): the `form` branch
     * never ran through the filter, and a test that checked only the page
     * therefore proved two of three kinds. The third was the one that carries
     * a whole document.
     *
     * *Reproduction:* take the `delete copy.replaces` out of `detachQuestions`
     * → all three turn red; replace `detachFormDefinition` with `definition`
     * → the first one alone.
     */
    it('speichert eine Formular-Vorlage ohne `replaces`', async () => {
      const source = await formWithReplaces('Quelle mit Typwechsel (Formular)');

      const template = (
        await saveTemplate(alphaAdmin, source.id, {
          kind: 'form',
          name: 'Ganzes Formular mit Nachfolger',
        })
      ).body as TemplateBody;

      const content = await storedContent(template.id);
      expect(content).not.toContain('replaces');
      expect(content).not.toContain(RETIRED);
    });

    it('speichert eine Seiten-Vorlage ohne `replaces`', async () => {
      const source = await formWithReplaces('Quelle mit Typwechsel (Seite)');

      const template = (
        await saveTemplate(alphaAdmin, source.id, {
          kind: 'page',
          name: 'Seite mit Nachfolger',
          pageId: PAGE_ONE,
        })
      ).body as TemplateBody;

      const content = await storedContent(template.id);
      expect(content).not.toContain('replaces');
      expect(content).not.toContain(RETIRED);
    });

    it('speichert eine Fragen-Vorlage ohne `replaces`', async () => {
      const source = await formWithReplaces('Quelle mit Typwechsel (Frage)');

      const template = (
        await saveTemplate(alphaAdmin, source.id, {
          kind: 'question',
          name: 'Nachfolgerfrage',
          questionId: SUCCESSOR,
        })
      ).body as TemplateBody;

      const content = await storedContent(template.id);
      expect(content).not.toContain('replaces');
      expect(content).not.toContain(RETIRED);
    });

    /**
     * And what a form template **keeps**: every condition. In a whole form no
     * source stays behind, so there is nothing to drop — the difference
     * because of which `detachFormDefinition` hands the questions over in
     * *one* set instead of page by page.
     *
     * *Reproduction:* call `detachQuestions` per page → the cross-page
     * condition disappears and this assertion turns red.
     */
    it('behält in einer Formular-Vorlage auch die seitenübergreifende Bedingung', async () => {
      const source = await buildForm(alphaAdmin, 'Quelle mit Bedingungen');

      const template = (
        await saveTemplate(alphaAdmin, source.id, {
          kind: 'form',
          name: 'Formular mit Bedingungen',
        })
      ).body as TemplateBody;

      const created = (
        await createFrom(alphaAdmin, template.id, 'Aus dem ganzen Formular')
      ).body as FormBody;
      const conditional = created.definition.pages
        .flatMap((page) => page.questions)
        .filter((question) => question.visibleIf !== undefined);
      // Both: the condition on page one and the one from page two onto page
      // one — with new ids, but present.
      expect(conditional).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // the evidence — a page template appends a page, with new ids
  // -------------------------------------------------------------------------

  describe('der Nachweis — eine Seiten-Vorlage hängt eine Seite an', () => {
    it('liefert bei jedem Einsetzen neue IDs, sodass zweimal Einsetzen ein gültiges Formular ergibt', async () => {
      const source = await buildForm(alphaAdmin, 'Quelle der Seite');
      const template = (
        await saveTemplate(alphaAdmin, source.id, {
          kind: 'page',
          name: 'Ihre Daten',
          pageId: PAGE_ONE,
        })
      ).body as TemplateBody;
      expect(template.questionCount).toBe(2);

      const target = await buildForm(alphaAdmin, 'Zielformular');

      const first = (await instantiate(alphaAdmin, template.id)).body as {
        page: { id: string; title: string; questions: { id: string }[] };
      };
      const second = (await instantiate(alphaAdmin, template.id)).body as {
        page: { id: string; title: string; questions: { id: string }[] };
      };

      // Reproduction from the requirement: „die IDs beim Einsetzen
      // beibehalten" — then these three assertions would be red, and the save
      // below would run into `formDefinitionSchema`'s duplicate-id refusal.
      expect(first.page.id).not.toBe(PAGE_ONE);
      expect(first.page.questions.map((q) => q.id)).not.toContain(
        MAIL_QUESTION,
      );
      expect(first.page.questions[0]?.id).not.toBe(
        second.page.questions[0]?.id,
      );

      const appended = await request(app().server)
        .put(apiPath(`/forms/${target.id}`))
        .set(authedMutation(alphaAdmin))
        .send({
          title: target.title,
          definition: {
            pages: [...target.definition.pages, first.page, second.page],
          },
          revision: target.revision,
        });
      expect(appended.status).toBe(200);
      const updated = appended.body as FormBody;
      expect(updated.definition.pages).toHaveLength(4);
      expect(updated.definition.pages[2]?.title).toBe('Ihre Daten');

      // The whole document still holds together: it publishes.
      const published = await request(app().server)
        .post(apiPath(`/forms/${target.id}/publish`))
        .set(authedMutation(alphaAdmin))
        .send({ revision: updated.revision });
      expect(published.status).toBe(200);
    });

    it('weigert sich, eine Formular-Vorlage einzufügen, und eine Seiten-Vorlage zum Formular zu machen', async () => {
      const source = await buildForm(alphaAdmin, 'Zwei Richtungen');
      const formTemplate = (
        await saveTemplate(alphaAdmin, source.id, {
          kind: 'form',
          name: 'Ganzes Formular',
        })
      ).body as TemplateBody;
      const pageTemplate = (
        await saveTemplate(alphaAdmin, source.id, {
          kind: 'page',
          name: 'Eine Seite',
          pageId: PAGE_ONE,
        })
      ).body as TemplateBody;

      const inserted = await instantiate(alphaAdmin, formTemplate.id);
      const createdFromPage = await createFrom(
        alphaAdmin,
        pageTemplate.id,
        'Aus einer Seite',
      );

      expect(inserted.status).toBe(422);
      expect(createdFromPage.status).toBe(422);
      // Nothing was created by the refused request.
      expect(
        await app().prisma.form.count({
          where: { tenantId: alpha.id, title: 'Aus einer Seite' },
        }),
      ).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // the evidence — bound to the tenant
  // -------------------------------------------------------------------------

  describe('der Nachweis — eine Vorlage ist tenant-gebunden', () => {
    it('zeigt die Vorlage einer fremden Organisation nicht in der Liste', async () => {
      const betaForm = await buildForm(betaAdmin, 'BETA-Formular');
      const betaTemplate = (
        await saveTemplate(betaAdmin, betaForm.id, {
          kind: 'form',
          name: 'BETA-Vorlage',
        })
      ).body as TemplateBody;

      const alphaList = await listTemplates(alphaAdmin);
      const betaList = await listTemplates(betaAdmin);

      // Reproduction: remove the tenant filter from the template list → the
      // first assertion turns red. The second keeps the probe honest: the
      // organisation it belongs to does see it.
      expect(alphaList.map((entry) => entry.id)).not.toContain(betaTemplate.id);
      expect(betaList.map((entry) => entry.id)).toContain(betaTemplate.id);
    });

    it('lässt sie nicht einfügen und nicht löschen — 404, wortgleich mit einer unbekannten ID', async () => {
      const betaForm = await buildForm(betaAdmin, 'BETA-Quelle');
      const betaTemplate = (
        await saveTemplate(betaAdmin, betaForm.id, {
          kind: 'page',
          name: 'BETA-Seite',
          pageId: PAGE_ONE,
        })
      ).body as TemplateBody;

      const foreign = await instantiate(alphaAdmin, betaTemplate.id);
      const unknown = await instantiate(
        alphaAdmin,
        '019fe900-0000-7000-8000-0000000000fd',
      );
      const foreignDelete = await request(app().server)
        .delete(apiPath(`/form-templates/${betaTemplate.id}`))
        .set(authedMutation(alphaAdmin));

      expect(foreign.status).toBe(404);
      expect(foreign.text).toBe(unknown.text);
      expect(foreign.text).toContain(FORM_TEMPLATE_NOT_FOUND_MESSAGE);
      expect(foreignDelete.status).toBe(404);

      // And it is still there — a 404 that deleted all the same would be the
      // actual violation.
      expect(
        await app().prisma.formTemplate.findUnique({
          where: { id: betaTemplate.id },
        }),
      ).not.toBeNull();
    });

    it('legt aus ihr kein Formular an', async () => {
      const betaForm = await buildForm(betaAdmin, 'BETA-Formularquelle');
      const betaTemplate = (
        await saveTemplate(betaAdmin, betaForm.id, {
          kind: 'form',
          name: 'BETA-Formularvorlage',
        })
      ).body as TemplateBody;
      const before = await app().prisma.form.count({
        where: { tenantId: alpha.id },
      });

      const refused = await createFrom(alphaAdmin, betaTemplate.id, 'Geklaut');

      expect(refused.status).toBe(404);
      expect(refused.text).toContain(FORM_TEMPLATE_NOT_FOUND_MESSAGE);
      expect(
        await app().prisma.form.count({ where: { tenantId: alpha.id } }),
      ).toBe(before);
    });

    it('speichert keine Vorlage aus dem Formular einer fremden Organisation', async () => {
      const betaForm = await buildForm(betaAdmin, 'BETA-Fremdzugriff');
      const before = await app().prisma.formTemplate.count({
        where: { tenantId: alpha.id },
      });

      const refused = await saveTemplate(alphaAdmin, betaForm.id, {
        kind: 'form',
        name: 'Fremd',
      });

      expect(refused.status).toBe(404);
      expect(refused.text).toContain(FORM_NOT_FOUND_MESSAGE);
      expect(
        await app().prisma.formTemplate.count({
          where: { tenantId: alpha.id },
        }),
      ).toBe(before);
    });
  });

  // -------------------------------------------------------------------------
  // the evidence — copy, not reference
  // -------------------------------------------------------------------------

  describe('der Nachweis — Kopie, nicht Referenz', () => {
    it('lässt eine spätere Änderung am Quellformular die Vorlage unberührt', async () => {
      const source = await buildForm(alphaAdmin, 'Quelle');
      const template = (
        await saveTemplate(alphaAdmin, source.id, {
          kind: 'form',
          name: 'Momentaufnahme',
        })
      ).body as TemplateBody;

      const emptied = await request(app().server)
        .put(apiPath(`/forms/${source.id}`))
        .set(authedMutation(alphaAdmin))
        .send({
          title: 'Quelle, jetzt leer',
          definition: {
            pages: [
              {
                id: PAGE_ONE,
                title: 'Nur noch eine Seite',
                description: null,
                questions: [],
              },
            ],
          },
          revision: source.revision,
        });
      expect(emptied.status).toBe(200);

      const stillThere = await listTemplates(alphaAdmin);
      const entry = stillThere.find((row) => row.id === template.id);
      expect(entry?.questionCount).toBe(3);

      const form = (await createFrom(alphaAdmin, template.id, 'Aus der Kopie'))
        .body as FormBody;
      expect(form.definition.pages).toHaveLength(2);
      expect(
        form.definition.pages.flatMap((page) => page.questions),
      ).toHaveLength(3);
    });

    it('lässt das Löschen der Vorlage das daraus gebaute Formular unberührt — und umgekehrt', async () => {
      const source = await buildForm(alphaAdmin, 'Beidseitig');
      const template = (
        await saveTemplate(alphaAdmin, source.id, {
          kind: 'form',
          name: 'Beidseitig',
        })
      ).body as TemplateBody;
      const form = (await createFrom(alphaAdmin, template.id, 'Kind'))
        .body as FormBody;

      const removed = await request(app().server)
        .delete(apiPath(`/form-templates/${template.id}`))
        .set(authedMutation(alphaAdmin));
      expect(removed.status).toBe(204);

      const stillReadable = await request(app().server)
        .get(apiPath(`/forms/${form.id}`))
        .set('Cookie', cookieHeader(alphaAdmin));
      expect(stillReadable.status).toBe(200);
      expect(
        (stillReadable.body as FormBody).definition.pages.flatMap(
          (page) => page.questions,
        ),
      ).toHaveLength(3);

      // And the source form is still there as well — the template held no
      // foreign key onto it.
      const sourceStillThere = await request(app().server)
        .get(apiPath(`/forms/${source.id}`))
        .set('Cookie', cookieHeader(alphaAdmin));
      expect(sourceStillThere.status).toBe(200);
    });

    it('lässt das Löschen des Quellformulars die Vorlage stehen', async () => {
      const source = await buildForm(alphaAdmin, 'Wird gelöscht');
      const template = (
        await saveTemplate(alphaAdmin, source.id, {
          kind: 'form',
          name: 'Überlebt',
        })
      ).body as TemplateBody;

      const deleted = await request(app().server)
        .delete(apiPath(`/forms/${source.id}`))
        .set(authedMutation(alphaAdmin));
      expect(deleted.status).toBe(204);

      const list = await listTemplates(alphaAdmin);
      expect(list.map((entry) => entry.id)).toContain(template.id);
    });
  });

  // -------------------------------------------------------------------------
  // permissions: „Vorlagen anlegen und einsetzen darf, wer bauen darf"
  // -------------------------------------------------------------------------

  describe('Rechte — Vorlagen gehören zu canBuild', () => {
    it('weist Speichern, Liste, Einsetzen und Löschen ohne canBuild ab und lässt Speichern, Liste und Einsetzen mit zu', async () => {
      const source = await buildForm(alphaAdmin, 'Rechteprüfung Vorlagen');
      const template = (
        await saveTemplate(alphaAdmin, source.id, {
          kind: 'page',
          name: 'Rechte',
          pageId: PAGE_ONE,
        })
      ).body as TemplateBody;

      const withoutBuild = await createRestrictedMember(app().prisma, alpha, {
        email: 'viewer-tpl@example.org',
        groupName: 'viewer-tpl',
        permissions: {
          canBuild: false,
          canViewResponses: true,
          canExport: true,
          canManageSettings: true,
          canManageFormSettings: true,
          canManageUsers: true,
        },
      });
      const withBuild = await createRestrictedMember(app().prisma, alpha, {
        email: 'editor-tpl@example.org',
        groupName: 'editor-tpl',
        permissions: { canBuild: true },
      });
      const denied = await openSession(app(), withoutBuild.id, alpha.id);
      const allowed = await openSession(app(), withBuild.id, alpha.id);

      const refusedSave = await saveTemplate(denied, source.id, {
        kind: 'form',
        name: 'Darf nicht',
      });
      const refusedList = await request(app().server)
        .get(apiPath('/form-templates'))
        .set('Cookie', cookieHeader(denied));
      const refusedInstance = await instantiate(denied, template.id);
      const refusedDelete = await request(app().server)
        .delete(apiPath(`/form-templates/${template.id}`))
        .set(authedMutation(denied));

      expect(refusedSave.status).toBe(403);
      expect(refusedSave.text).toContain(MISSING_PERMISSION_MESSAGE);
      expect(refusedList.status).toBe(403);
      expect(refusedInstance.status).toBe(403);
      expect(refusedDelete.status).toBe(403);
      // Nothing happened on the way past the refusal.
      expect(
        await app().prisma.formTemplate.findUnique({
          where: { id: template.id },
        }),
      ).not.toBeNull();

      // …and three of the four succeed for somebody who may build. The fourth
      // is „endgültig löschen" and needs the pair — measured in
      // its own block below, not asserted away here.
      expect(
        (
          await saveTemplate(allowed, source.id, {
            kind: 'form',
            name: 'Darf',
          })
        ).status,
      ).toBe(201);
      expect(
        (
          await request(app().server)
            .get(apiPath('/form-templates'))
            .set('Cookie', cookieHeader(allowed))
        ).status,
      ).toBe(200);
      expect((await instantiate(allowed, template.id)).status).toBe(200);
    });

    /**
     * **The fourth link of the chain, measured at the save route** . It is inherited from the controller decorator, and inherited
     * means decided by nobody for this route — a route that falls out of the
     * chain would look exactly like this one until this case runs.
     */
    it('antwortet 404, wenn der Zugriff auf genau dieses Formular entzogen ist', async () => {
      const source = await buildForm(alphaAdmin, 'Entzogenes Formular');
      const before = await app().prisma.formTemplate.count({
        where: { tenantId: alpha.id },
      });

      const member = await createRestrictedMember(app().prisma, alpha, {
        email: 'revoked-tpl@example.org',
        groupName: 'revoked-tpl',
        permissions: { canBuild: true, canViewResponses: true },
      });
      await app().prisma.formPermission.create({
        data: {
          tenantId: alpha.id,
          formId: source.id,
          userId: member.id,
          accessRevoked: true,
          cappedGroupId: null,
        },
      });
      const locked = await openSession(app(), member.id, alpha.id);

      const refused = await saveTemplate(locked, source.id, {
        kind: 'form',
        name: 'Trotzdem',
      });
      const unknown = await saveTemplate(
        locked,
        '019fe900-0000-7000-8000-0000000000fc',
        { kind: 'form', name: 'Trotzdem' },
      );

      expect(refused.status).toBe(404);
      expect(refused.text).toBe(unknown.text);
      expect(
        await app().prisma.formTemplate.count({
          where: { tenantId: alpha.id },
        }),
      ).toBe(before);
    });
  });

  // -------------------------------------------------------------------------
  // the specification — a template belongs to the organisation; only the final
  // deletion is restricted
  // -------------------------------------------------------------------------

  /**
   * **The decision of 2026-08-05, measured in both of its halves.**
   *
   * The finding read: whoever has `canBuild` and had access to *one* form
   * withdrawn (`form_permission.accessRevoked`) could list that form's
   * template (200), insert it (200, question text included) **and delete it
   * for good** (204, irreversible).
   *
   * Two thirds of that are **no** finding, but the rule — and therefore stand
   * here as a promise, not as a side effect: a template is a copy without a
   * back-reference, it belongs to the organisation. If this openness
   * disappears, one of the first two cases turns red.
   *
   * *Reproduction of the third:* turn `@RequireAllPermissions('canViewResponses',
   * 'canBuild')` on `DELETE /form-templates/:id` back to
   * `@RequirePermission('canBuild')` → the third case turns red.
   */
  describe('die Spezifikation Nr. 72 — die Vorlage gehört der Organisation, das Löschen ist die Ausnahme', () => {
    /** Source form, locked-out member with `canBuild`, and a template. */
    async function lockedOutMember(options: {
      readonly email: string;
      readonly groupName: string;
      readonly canViewResponses: boolean;
    }): Promise<{ token: string; templateId: string; sourceId: string }> {
      const source = await buildForm(alphaAdmin, `Quelle ${options.groupName}`);
      const template = (
        await saveTemplate(alphaAdmin, source.id, {
          kind: 'page',
          name: `Vorlage ${options.groupName}`,
          pageId: PAGE_ONE,
        })
      ).body as TemplateBody;

      const member = await createRestrictedMember(app().prisma, alpha, {
        email: options.email,
        groupName: options.groupName,
        permissions: {
          canBuild: true,
          canViewResponses: options.canViewResponses,
        },
      });
      await app().prisma.formPermission.create({
        data: {
          tenantId: alpha.id,
          formId: source.id,
          userId: member.id,
          accessRevoked: true,
          cappedGroupId: null,
        },
      });

      return {
        token: await openSession(app(), member.id, alpha.id),
        templateId: template.id,
        sourceId: source.id,
      };
    }

    it('listet sie weiter auf, obwohl der Zugriff auf das Quellformular entzogen ist', async () => {
      const locked = await lockedOutMember({
        email: 'revoked-list-tpl@example.org',
        groupName: 'revoked-list-tpl',
        canViewResponses: false,
      });

      // The locked form itself is unreachable — the lock works, so the promise
      // below it is not a broken restriction but the rule.
      const lockedForm = await request(app().server)
        .get(apiPath(`/forms/${locked.sourceId}`))
        .set('Cookie', cookieHeader(locked.token));
      expect(lockedForm.status).toBe(404);
      expect(lockedForm.text).toContain(FORM_NOT_FOUND_MESSAGE);

      const listed = await listTemplates(locked.token);
      expect(listed.map((entry) => entry.id)).toContain(locked.templateId);
    });

    it('setzt sie weiter ein — samt des Fragetexts aus dem gesperrten Formular', async () => {
      const locked = await lockedOutMember({
        email: 'revoked-insert-tpl@example.org',
        groupName: 'revoked-insert-tpl',
        canViewResponses: false,
      });

      const inserted = await instantiate(locked.token, locked.templateId);
      const body = inserted.body as {
        kind: string;
        page: { questions: { label: string }[] };
      };

      expect(inserted.status).toBe(200);
      expect(body.kind).toBe('page');
      // The question text is exactly what the finding measured as a „Leck" and
      // what the decision leaves standing as a copy.
      expect(body.page.questions.map((question) => question.label)).toContain(
        'E-Mail',
      );
    });

    it('weist das endgültige Löschen ohne can_view_responses ab — und lässt es dem Paar, auch gesperrt', async () => {
      const withoutPair = await lockedOutMember({
        email: 'revoked-purge-tpl@example.org',
        groupName: 'revoked-purge-tpl',
        canViewResponses: false,
      });

      const refused = await request(app().server)
        .delete(apiPath(`/form-templates/${withoutPair.templateId}`))
        .set(authedMutation(withoutPair.token));

      expect(refused.status).toBe(403);
      expect(refused.text).toContain(MISSING_PERMISSION_MESSAGE);
      // 403 and the row is still there: a refusal that deleted all the same
      // would be the actual violation — and here there would be nothing to
      // fetch it back from.
      expect(
        await app().prisma.formTemplate.findUnique({
          where: { id: withoutPair.templateId },
        }),
      ).not.toBeNull();

      // The same lock, the same template, plus `can_view_responses`: 204. That
      // is the decision and no gap — on the template routes there is **no**
      // form restriction, otherwise this would be a 404.
      const withPair = await lockedOutMember({
        email: 'revoked-purge-pair-tpl@example.org',
        groupName: 'revoked-purge-pair-tpl',
        canViewResponses: true,
      });
      const allowed = await request(app().server)
        .delete(apiPath(`/form-templates/${withPair.templateId}`))
        .set(authedMutation(withPair.token));

      expect(allowed.status).toBe(204);
      expect(
        await app().prisma.formTemplate.findUnique({
          where: { id: withPair.templateId },
        }),
      ).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // the specification — renaming and „Aus diesem Formular aktualisieren"
  // -------------------------------------------------------------------------

  /**
   * **The decision of 2026-08-05, in its two unequal halves.**
   *
   * Without both of them every correction produces a **second template of the
   * same name** — and the name is the only thing a template is recognisable
   * by (it deliberately carries no back-reference). Aggravating: only somebody
   * who may also see responses may remove the wrong one.
   *
   * The two halves are **not** the same thing, and precisely that is measured
   * here:
   *
   * - *Renaming* is reversible → `can_build` alone. *Reproduction:* hang the
   *   permission pair on `PATCH /form-templates/:id` → the case „darf bauen,
   *   darf keine Antworten sehen" turns red, and with it the reasoning of the
   *   decision.
   * - *Updating* is **irreversible** — there is no trash for templates →
   *   `can_view_responses` **and** `can_build`. *Reproduction:* turn
   *   `@RequireAllPermissions` on `PUT /forms/:formId/templates/:id` back to
   *   `@RequirePermission('canBuild')` → the 403 case turns red.
   *
   * And the trap that would have cost this package: *updating is not a second
   * save.* It runs through the same `contentOf` — no access word, no
   * `replaces`, no dangling condition. *Reproduction:* build a second write
   * path beside it that does not call `stripOverridePassword` → the
   * access-word case turns red.
   */
  describe('die Spezifikation Nr. 74 — Umbenennen und Aktualisieren', () => {
    /** A page template out of a fresh form. */
    async function pageTemplate(
      label: string,
    ): Promise<{ source: FormBody; template: TemplateBody }> {
      const source = await buildForm(alphaAdmin, `Quelle ${label}`);
      const saved = await saveTemplate(alphaAdmin, source.id, {
        kind: 'page',
        name: `Vorlage ${label}`,
        pageId: PAGE_ONE,
      });
      expect(saved.status).toBe(201);
      return { source, template: saved.body as TemplateBody };
    }

    /** Replaces the content of the form with **one** page holding one question. */
    async function shrinkForm(
      form: FormBody,
      questionLabel: string,
    ): Promise<void> {
      const reread = await request(app().server)
        .get(apiPath(`/forms/${form.id}`))
        .set('Cookie', cookieHeader(alphaAdmin));
      const current = reread.body as FormBody;

      const saved = await request(app().server)
        .put(apiPath(`/forms/${form.id}`))
        .set(authedMutation(alphaAdmin))
        .send({
          title: current.title,
          definition: {
            pages: [
              {
                id: PAGE_ONE,
                title: 'Ihre Daten',
                description: null,
                questions: [
                  {
                    id: MAIL_QUESTION,
                    type: 'text',
                    label: questionLabel,
                    hint: null,
                    required: false,
                    width: 'full',
                    minLength: null,
                    maxLength: null,
                    pattern: null,
                  },
                ],
              },
            ],
          },
          revision: current.revision,
        });
      expect(saved.status).toBe(200);
    }

    describe('Umbenennen', () => {
      it('ändert den Namen, lässt den Inhalt Byte für Byte stehen und legt keine zweite Zeile an', async () => {
        const { template } = await pageTemplate('Umbenennen');
        const before = await app().prisma.formTemplate.findUniqueOrThrow({
          where: { id: template.id },
        });

        const renamed = await renameTemplate(alphaAdmin, template.id, {
          name: 'BT-Anmeldung 2027',
        });
        const body = renamed.body as TemplateBody;

        expect(renamed.status).toBe(200);
        expect(body.id).toBe(template.id);
        expect(body.name).toBe('BT-Anmeldung 2027');
        expect(body.kind).toBe('page');
        expect(body.questionCount).toBe(template.questionCount);

        const after = await app().prisma.formTemplate.findUniqueOrThrow({
          where: { id: template.id },
        });
        // The content is untouched — renaming touches exactly one field.
        expect(JSON.stringify(after.content)).toBe(
          JSON.stringify(before.content),
        );
        // The same row, not a second one: `created_at` stands still.
        expect(after.createdAt.toISOString()).toBe(
          before.createdAt.toISOString(),
        );

        // And that is the whole reason for the decision: **one** row in the
        // drawer, not two of the same name.
        const listed = await listTemplates(alphaAdmin);
        expect(
          listed.filter((entry) => entry.name === 'BT-Anmeldung 2027'),
        ).toHaveLength(1);
        expect(listed.filter((entry) => entry.name === template.name)).toEqual(
          [],
        );
      });

      it('weist einen leeren Namen ab, genau wie das Speichern', async () => {
        const { template } = await pageTemplate('Leerer Name');

        const refused = await renameTemplate(alphaAdmin, template.id, {
          name: '   ',
        });

        expect(refused.status).toBe(400);
        expect(
          (
            await app().prisma.formTemplate.findUniqueOrThrow({
              where: { id: template.id },
            })
          ).name,
        ).toBe(template.name);
      });

      /**
       * **Rework of the specification** — the same permission pair as deleting
       * and updating, and not `canBuild` alone.
       *
       * *Measured on 2026-08-06:* a `canBuild` member renamed the admin's
       * template (**200**) and afterwards created one of its own under the
       * name that had become free (**201**) — replacement of the content under
       * an established name, so exactly the effect the pair on `PUT` stands
       * against. On `PUT` and `DELETE` of the same row the same member got
       * 403. The reasoning „umkehrbar" did not carry: there is no owner, no
       * versioning, no trash and no audit log, the old name stands nowhere
       * afterwards.
       *
       * *Reproduction:* `@RequirePermission('canBuild')` back on `PATCH` →
       * the first three assertions turn red.
       */
      it('verlangt dasselbe Rechte-Paar wie Löschen und Aktualisieren — canBuild allein reicht nicht', async () => {
        const { template } = await pageTemplate('Rechte Umbenennen');

        const buildOnly = await createRestrictedMember(app().prisma, alpha, {
          email: 'builder-rename-tpl@example.org',
          groupName: 'builder-rename-tpl',
          permissions: { canBuild: true, canViewResponses: false },
        });
        const pair = await createRestrictedMember(app().prisma, alpha, {
          email: 'pair-rename-tpl@example.org',
          groupName: 'pair-rename-tpl',
          permissions: { canBuild: true, canViewResponses: true },
        });
        const denied = await openSession(app(), buildOnly.id, alpha.id);
        const allowed = await openSession(app(), pair.id, alpha.id);

        const refused = await renameTemplate(denied, template.id, {
          name: 'Von niemandem',
        });
        expect(refused.status).toBe(403);
        expect(refused.text).toContain(MISSING_PERMISSION_MESSAGE);
        // The name still stands where it stood — it is the only thing a
        // template is recognisable by, and nobody would hold on to the old
        // one.
        expect(
          (
            await app().prisma.formTemplate.findUniqueOrThrow({
              where: { id: template.id },
            })
          ).name,
        ).toBe(template.name);

        // The same session at the same two neighbouring routes: three ways,
        // one permission. Before, this one way was open while the others were
        // shut.
        expect(
          (
            await request(app().server)
              .delete(apiPath(`/form-templates/${template.id}`))
              .set(authedMutation(denied))
          ).status,
        ).toBe(403);

        const done = await renameTemplate(allowed, template.id, {
          name: 'Vom Paar',
        });
        expect(done.status).toBe(200);
        expect((done.body as TemplateBody).name).toBe('Vom Paar');
      });

      /**
       * **A review finding of the rework** — a refusal that has already taken
       * effect.
       *
       * `rename` wrote first and built the response afterwards out of a
       * **second** read that parses the stored content. *Measured on
       * 2026-08-06:* hand-written row with broken `content` →
       * `PATCH {name:'…'}` → **400**, and the name in the row was changed
       * afterwards. The caller read an error message and had renamed all the
       * same.
       *
       * The 400 stays — the response of this route contains `questionCount`,
       * and nobody can compute that from a row that does not parse. What
       * changes is the moment: it falls **before** the write.
       *
       * *Reproduction:* build the summary after the `update` out of a second
       * `requireTemplate` again → the second assertion turns red.
       */
      it('ändert nichts, wenn es die Antwort nicht bauen kann', async () => {
        const row = await app().prisma.formTemplate.create({
          data: {
            tenantId: alpha.id,
            kind: 'page',
            name: 'Kaputt gespeichert',
            // Past the write path — standing in for a hand-written UPDATE, an
            // import, a restore. A page template without `page` is exactly
            // what `formTemplateContentSchema` refuses and the column takes
            // all the same.
            content: { kind: 'page' },
          },
        });

        try {
          const refused = await renameTemplate(alphaAdmin, row.id, {
            name: 'Trotzdem umbenannt',
          });

          expect(refused.status).toBe(400);
          expect(
            (
              await app().prisma.formTemplate.findUniqueOrThrow({
                where: { id: row.id },
              })
            ).name,
          ).toBe('Kaputt gespeichert');
        } finally {
          // As in the block „ein Review-Befund": `GET /form-templates` reads
          // every row of the organisation, so this one must not outlive the
          // test.
          await app().prisma.formTemplate.delete({ where: { id: row.id } });
        }
      });

      it('benennt die Vorlage einer fremden Organisation nicht um — 404, wortgleich mit einer unbekannten ID', async () => {
        const betaSource = await buildForm(betaAdmin, 'BETA Umbenennen');
        const betaTemplate = (
          await saveTemplate(betaAdmin, betaSource.id, {
            kind: 'page',
            name: 'BETA Vorlage',
            pageId: PAGE_ONE,
          })
        ).body as TemplateBody;

        const foreign = await renameTemplate(alphaAdmin, betaTemplate.id, {
          name: 'Übernommen',
        });
        const unknown = await renameTemplate(
          alphaAdmin,
          '019fe900-0000-7000-8000-0000000000fd',
          { name: 'Übernommen' },
        );

        expect(foreign.status).toBe(404);
        expect(foreign.text).toContain(FORM_TEMPLATE_NOT_FOUND_MESSAGE);
        expect(foreign.text).toBe(unknown.text);
        expect(
          (
            await app().prisma.formTemplate.findUniqueOrThrow({
              where: { id: betaTemplate.id },
            })
          ).name,
        ).toBe('BETA Vorlage');
      });
    });

    describe('Aus diesem Formular aktualisieren', () => {
      it('ersetzt den Inhalt und behält Zeile, Name und Art', async () => {
        const source = await buildForm(alphaAdmin, 'Aktualisieren Quelle');
        const template = (
          await saveTemplate(alphaAdmin, source.id, {
            kind: 'form',
            name: 'Meine BT-Anmeldung',
          })
        ).body as TemplateBody;
        expect(template.questionCount).toBe(3);

        await shrinkForm(source, 'Nur noch das');

        const updated = await updateTemplate(
          alphaAdmin,
          source.id,
          template.id,
          {
            kind: 'form',
          },
        );
        const body = updated.body as TemplateBody;

        expect(updated.status).toBe(200);
        expect(body.id).toBe(template.id);
        expect(body.name).toBe('Meine BT-Anmeldung');
        expect(body.kind).toBe('form');
        expect(body.questionCount).toBe(1);

        // The old content is **gone** — there is no trash it would come back
        // from, and exactly for that reason the interface asks first.
        expect(await storedContent(template.id)).not.toContain('Anmerkung');

        // And the drawer still holds exactly one row of that name.
        const listed = await listTemplates(alphaAdmin);
        expect(
          listed.filter((entry) => entry.name === 'Meine BT-Anmeldung'),
        ).toHaveLength(1);

        // The updated form arises out of the **new** content.
        const form = (
          await createFrom(alphaAdmin, template.id, 'Aus der Aktualisierung')
        ).body as FormBody;
        expect(form.definition.pages).toHaveLength(1);
        expect(
          form.definition.pages.flatMap((page) =>
            page.questions.map((question) => question.label),
          ),
        ).toEqual(['Nur noch das']);
      });

      /**
       * **The trap of this package.** A second write path without
       * `stripOverridePassword` is exactly the shape that in this project
       * would already have passed a secret on twice — and here nobody would
       * notice, because the row already exists.
       */
      it('nimmt beim Aktualisieren so wenig mit wie beim Speichern — kein Zugangswort, kein `replaces`', async () => {
        const plain = await buildForm(alphaAdmin, 'Erst ohne Wort');
        const template = (
          await saveTemplate(alphaAdmin, plain.id, {
            kind: 'form',
            name: 'Wird geschützt',
          })
        ).body as TemplateBody;

        const guarded = await buildForm(alphaAdmin, 'Jetzt mit Wort', {
          withAccessWord: true,
        });
        const updated = await updateTemplate(
          alphaAdmin,
          guarded.id,
          template.id,
          {
            kind: 'form',
          },
        );
        expect(updated.status).toBe(200);
        expect(await storedContent(template.id)).not.toContain(ACCESS_WORD);

        // The kind that until the rework did **not** run through the filter
        // at all: a whole form with `replaces`. The old test checked
        // `replaces` only against a page template.
        const wholeForm = await formWithReplaces('Quelle Aktualisierung ganz');
        expect(
          (
            await updateTemplate(alphaAdmin, wholeForm.id, template.id, {
              kind: 'form',
            })
          ).status,
        ).toBe(200);
        const formContent = await storedContent(template.id);
        expect(formContent).not.toContain('replaces');
        expect(formContent).not.toContain(RETIRED);

        // The same check for the second half of the filter: a page with
        // `replaces` and a question whose condition source does not travel
        // along.
        const pageVorlage = (await pageTemplate('Filter')).template;
        const withReplaces = await formWithReplaces('Quelle Aktualisierung');
        const second = await updateTemplate(
          alphaAdmin,
          withReplaces.id,
          pageVorlage.id,
          { kind: 'page', pageId: PAGE_ONE },
        );
        expect(second.status).toBe(200);
        const content = await storedContent(pageVorlage.id);
        expect(content).not.toContain('replaces');
        expect(content).not.toContain(RETIRED);

        // And the template of the *second* page loses its condition, whose
        // source stays behind on page one — on updating as on saving.
        const crossPage = await buildForm(alphaAdmin, 'Quelle Bedingung');
        const third = await updateTemplate(
          alphaAdmin,
          crossPage.id,
          pageVorlage.id,
          { kind: 'page', pageId: PAGE_TWO },
        );
        expect(third.status).toBe(200);
        expect(await storedContent(pageVorlage.id)).not.toContain('visibleIf');
      });

      it('gibt der aktualisierten Vorlage beim Einsetzen weiterhin neue IDs', async () => {
        const { template } = await pageTemplate('Neue IDs');
        const other = await buildForm(alphaAdmin, 'Zweite Quelle');

        expect(
          (
            await updateTemplate(alphaAdmin, other.id, template.id, {
              kind: 'page',
              pageId: PAGE_ONE,
            })
          ).status,
        ).toBe(200);

        const first = await instantiate(alphaAdmin, template.id);
        const second = await instantiate(alphaAdmin, template.id);
        const idsOf = (response: request.Response): string[] => {
          const body = response.body as {
            page: { id: string; questions: { id: string }[] };
          };
          return [body.page.id, ...body.page.questions.map((q) => q.id)];
        };
        const firstIds = idsOf(first);
        const secondIds = idsOf(second);

        // Reproduction: if the updating fixed the ids of the source form,
        // conditions and placeholders of the template would point there — and
        // inserting twice would yield duplicate ids.
        expect(firstIds).not.toContain(PAGE_ONE);
        expect(firstIds).not.toContain(MAIL_QUESTION);
        expect(new Set([...firstIds, ...secondIds]).size).toBe(
          firstIds.length + secondIds.length,
        );
      });

      /**
       * **A command, not a subscription** . The name of the action
       * suggests the opposite, which is why it stands here as a measurement
       * and not only as a comment on the code.
       */
      it('lässt die Vorlage dem Formular danach nicht weiter folgen — und bereits eingesetzte Kopien unberührt', async () => {
        const { source, template } = await pageTemplate('Abonnement');

        // A copy that landed somewhere else before the update.
        const inserted = (await instantiate(alphaAdmin, template.id)).body as {
          page: { questions: { label: string }[] };
        };
        expect(inserted.page.questions.map((q) => q.label)).toContain('E-Mail');

        await shrinkForm(source, 'Nach dem Aktualisieren');
        expect(
          (
            await updateTemplate(alphaAdmin, source.id, template.id, {
              kind: 'page',
              pageId: PAGE_ONE,
            })
          ).status,
        ).toBe(200);

        // Afterwards the form changes a second time — the template does
        // **not** follow along.
        await shrinkForm(source, 'Danach noch einmal geändert');

        const content = await storedContent(template.id);
        expect(content).toContain('Nach dem Aktualisieren');
        expect(content).not.toContain('Danach noch einmal geändert');
        // And the copy inserted earlier is what it was.
        expect(inserted.page.questions.map((q) => q.label)).toContain('E-Mail');
      });

      it('weist eine andere Art ab, statt die Vorlage umzuwidmen', async () => {
        const { source, template } = await pageTemplate('Art');
        const before = await storedContent(template.id);

        const refused = await updateTemplate(
          alphaAdmin,
          source.id,
          template.id,
          { kind: 'form' },
        );

        expect(refused.status).toBe(422);
        expect(refused.text).toContain(FORM_TEMPLATE_KIND_MISMATCH_MESSAGE);
        expect(await storedContent(template.id)).toBe(before);
        expect(
          (
            await app().prisma.formTemplate.findUniqueOrThrow({
              where: { id: template.id },
            })
          ).kind,
        ).toBe('page');
      });

      /**
       * **A review finding of the rework** — the kind check came before the
       * resolution of the form.
       *
       * *Measured on 2026-08-06:* ALPHA session, **BETA** form id, own page
       * template, body `{kind:'form'}` → **422**, while the same request with
       * a matching kind gave **404**. No cross leak — but the word-for-word
       * sameness of the refusal this project otherwise insists on
       * (`FORM_TEMPLATE_NOT_FOUND_MESSAGE`) thereby held for only one of the
       * two bodies: a field in the body distinguished „gibt es" from „gibt es
       * nicht".
       *
       * *Reproduction:* pull `requireFullForm` behind the kind check again →
       * the first two assertions turn red.
       */
      it('antwortet auf ein fremdes Formular 404, auch wenn die Art nicht passt', async () => {
        const { template } = await pageTemplate('Reihenfolge');
        const betaSource = await buildForm(betaAdmin, 'BETA Reihenfolge');
        const before = await storedContent(template.id);

        const mismatched = await updateTemplate(
          alphaAdmin,
          betaSource.id,
          template.id,
          { kind: 'form' },
        );
        const matching = await updateTemplate(
          alphaAdmin,
          betaSource.id,
          template.id,
          { kind: 'page', pageId: PAGE_ONE },
        );

        expect(mismatched.status).toBe(404);
        expect(mismatched.text).toBe(matching.text);
        expect(mismatched.text).toContain(FORM_NOT_FOUND_MESSAGE);
        expect(await storedContent(template.id)).toBe(before);
      });

      it('verlangt das Rechte-Paar — canBuild allein reicht nicht', async () => {
        const { source, template } = await pageTemplate('Rechte Aktualisieren');
        const before = await storedContent(template.id);

        const buildOnly = await createRestrictedMember(app().prisma, alpha, {
          email: 'builder-update-tpl@example.org',
          groupName: 'builder-update-tpl',
          permissions: { canBuild: true, canViewResponses: false },
        });
        const pair = await createRestrictedMember(app().prisma, alpha, {
          email: 'pair-update-tpl@example.org',
          groupName: 'pair-update-tpl',
          permissions: { canBuild: true, canViewResponses: true },
        });
        const denied = await openSession(app(), buildOnly.id, alpha.id);
        const allowed = await openSession(app(), pair.id, alpha.id);

        const refused = await updateTemplate(denied, source.id, template.id, {
          kind: 'page',
          pageId: PAGE_ONE,
        });

        expect(refused.status).toBe(403);
        expect(refused.text).toContain(MISSING_PERMISSION_MESSAGE);
        // 403 and the content stands unchanged: a refusal that overwrote all
        // the same would be the actual violation here — there is nothing the
        // old content could be fetched back from.
        expect(await storedContent(template.id)).toBe(before);

        expect(
          (
            await updateTemplate(allowed, source.id, template.id, {
              kind: 'page',
              pageId: PAGE_ONE,
            })
          ).status,
        ).toBe(200);
      });

      it('antwortet 404, wenn der Zugriff auf genau dieses Quellformular entzogen ist', async () => {
        const { source, template } = await pageTemplate('Entzogen');
        const before = await storedContent(template.id);

        const member = await createRestrictedMember(app().prisma, alpha, {
          email: 'revoked-update-tpl@example.org',
          groupName: 'revoked-update-tpl',
          permissions: { canBuild: true, canViewResponses: true },
        });
        await app().prisma.formPermission.create({
          data: {
            tenantId: alpha.id,
            formId: source.id,
            userId: member.id,
            accessRevoked: true,
            cappedGroupId: null,
          },
        });
        const locked = await openSession(app(), member.id, alpha.id);

        const refused = await updateTemplate(locked, source.id, template.id, {
          kind: 'page',
          pageId: PAGE_ONE,
        });
        const unknownForm = await updateTemplate(
          locked,
          '019fe900-0000-7000-8000-0000000000fb',
          template.id,
          { kind: 'page', pageId: PAGE_ONE },
        );

        // The fourth link of the chain, measured at this route: inherited
        // means decided by nobody, until this case runs.
        expect(refused.status).toBe(404);
        expect(refused.text).toBe(unknownForm.text);
        expect(await storedContent(template.id)).toBe(before);
      });

      it('aktualisiert weder eine fremde Vorlage noch aus einem fremden Formular — 404, wortgleich mit einer unbekannten ID', async () => {
        const alphaSide = await pageTemplate('Isolation');
        const betaSource = await buildForm(betaAdmin, 'BETA Aktualisieren');
        const betaTemplate = (
          await saveTemplate(betaAdmin, betaSource.id, {
            kind: 'page',
            name: 'BETA Inhalt',
            pageId: PAGE_ONE,
          })
        ).body as TemplateBody;
        const betaBefore = await storedContent(betaTemplate.id);

        // Foreign template, own form.
        const foreignTemplate = await updateTemplate(
          alphaAdmin,
          alphaSide.source.id,
          betaTemplate.id,
          { kind: 'page', pageId: PAGE_ONE },
        );
        const unknownTemplate = await updateTemplate(
          alphaAdmin,
          alphaSide.source.id,
          '019fe900-0000-7000-8000-0000000000fe',
          { kind: 'page', pageId: PAGE_ONE },
        );
        // Own template, foreign form.
        const foreignForm = await updateTemplate(
          alphaAdmin,
          betaSource.id,
          alphaSide.template.id,
          { kind: 'page', pageId: PAGE_ONE },
        );

        expect(foreignTemplate.status).toBe(404);
        expect(foreignTemplate.text).toContain(FORM_TEMPLATE_NOT_FOUND_MESSAGE);
        expect(foreignTemplate.text).toBe(unknownTemplate.text);
        expect(foreignForm.status).toBe(404);
        expect(foreignForm.text).toContain(FORM_NOT_FOUND_MESSAGE);

        // Nothing happened on the way past the refusals.
        expect(await storedContent(betaTemplate.id)).toBe(betaBefore);
      });
    });
  });
});
