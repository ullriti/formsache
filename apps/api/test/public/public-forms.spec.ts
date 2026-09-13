import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  DEFAULT_OIDC_EMAIL_CLAIM,
  DEFAULT_OIDC_EMAIL_VERIFIED_CLAIM,
  parseFormDefinition,
} from '@formsache/shared';

import { JSON_BODY_LIMIT_BYTES } from '../../src/app-setup';
import { NO_STORE } from '../../src/common/no-store';
import { ACCESS_PROOF_HEADER } from '../../src/public/public-forms.controller';
import {
  PUBLIC_FORM_NOT_FOUND_MESSAGE,
  PublicFormsService,
  type PublicFormReadPayload,
} from '../../src/public/public-forms.service';
import { PUBLIC_SUBMIT_RATE_LIMIT } from '../../src/public/public-forms.rate-limit';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
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
 * The requirements — the public fill-in endpoints, the only routes of this
 * application that anyone on the internet may call.
 *
 * Every request below is made **without a session cookie**, deliberately and
 * throughout: a suite that authenticated first would prove that an editor can
 * submit a form, which is the opposite of what the requirements promise.
 */

const PASSWORD = 'test-password';
const PAGE = '019ff100-0000-7000-8000-0000000000a0';
const NAME = '019ff100-0000-7000-8000-000000000001';
const SEMESTER = '019ff100-0000-7000-8000-000000000002';
const POSTCODE = '019ff100-0000-7000-8000-000000000003';
const MEAL = '019ff100-0000-7000-8000-000000000004';

/**
 * The fixture form: one of every shape the requirements name — a required text, a bounded
 * number, a text with a pattern and a choice with a fixed option list.
 */
function definition() {
  return {
    pages: [
      {
        id: PAGE,
        title: 'Anmeldung',
        // The requirement: a real value, not `null`, so the allow list probe
        // below has something to find — every other test in this file that
        // reads `body.definition` only checks it has `pages` at all and does
        // not care what is in one, so a fixture-wide addition is safe here.
        description: 'Bitte vollständig ausfüllen.',
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
          {
            id: SEMESTER,
            type: 'number',
            label: 'Semester',
            hint: null,
            required: false,
            width: 'half',
            min: 1,
            max: 30,
            integer: true,
          },
          {
            id: POSTCODE,
            type: 'text',
            label: 'Postleitzahl',
            hint: null,
            required: false,
            width: 'half',
            minLength: null,
            maxLength: null,
            pattern: '^\\d{5}$',
          },
          {
            id: MEAL,
            type: 'radio',
            label: 'Verpflegung',
            hint: null,
            required: false,
            width: 'full',
            options: [
              { value: 'fleisch', label: 'Mit Fleisch' },
              { value: 'vegetarisch', label: 'Vegetarisch' },
            ],
            allowOther: false,
            otherLabel: null,
          },
        ],
      },
    ],
  };
}

describe('public fill-in', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  let tenant: TenantFixture;
  let editor: string;
  /** A published form; the slug is its public address. */
  let publishedSlug: string;
  /** A form that was never published — must be indistinguishable from absent. */
  let draftSlug: string;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({
      databaseUrl: database.url,
      // Only the branding suite below needs an absolute address — writing the
      // OIDC config of its fully-configured Organisation through the real route mints
      // a redirect URI (`PublicUrlService.oidcCallbackUrl`), and that call is
      // a 503 without one. Every other test in this file builds its
      // assertions from the response body, never from a link's exact text,
      // so seeding it here changes nothing they check.
      systemMail: { publicBaseUrl: TEST_PUBLIC_BASE_URL },
    });

    tenant = await createTenant(testApp.prisma, 'PUB');
    const user = await createUser(testApp.prisma, {
      email: 'editor@example.org',
      password: PASSWORD,
      tenants: [tenant],
    });
    editor = await openSession(testApp, user.id, tenant.id);

    publishedSlug = await createForm('Jahrestagung', true);
    draftSlug = await createForm('Noch nicht offen', false);
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  /** Builds a form through the real routes and returns its public slug. */
  async function createForm(title: string, publish: boolean): Promise<string> {
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

    if (publish) {
      await request(app().server)
        .post(apiPath(`/forms/${form.id}/publish`))
        .set(authedMutation(editor))
        .send({ revision: (saved.body as { revision: number }).revision });
    }
    return form.publicSlug;
  }

  describe('reading a published form without a login', () => {
    it('answers 200 with the questions and the organisation, and no cookie in sight', async () => {
      const response = await request(app().server).get(
        apiPath(`/public/forms/${publishedSlug}`),
      );

      expect(response.status).toBe(200);
      const body = response.body as {
        title: string;
        version: number;
        tenant: { name: string };
        definition: { pages: unknown[] };
      };
      expect(body.title).toBe('Jahrestagung');
      expect(body.version).toBe(1);
      expect(body.tenant.name).toBe('Organisation PUB');
      expect(body.definition.pages).toHaveLength(1);
      expect(response.headers['cache-control']).toBe(NO_STORE);
    });

    /**
     * The answer carries what the view renders and nothing more. Ids of any
     * kind would be information the public did not have before — and the
     * public slug exists precisely so the row id stays private.
     */
    it('leaks no internal identifiers', async () => {
      const response = await request(app().server).get(
        apiPath(`/public/forms/${publishedSlug}`),
      );

      expect(response.text).not.toContain(tenant.id);
      expect(response.text).not.toContain(tenant.adminGroupId);
      expect(JSON.parse(response.text)).not.toHaveProperty('id');
    });

    /**
     * The requirement owed this and could not pay it: a form that is not
     * published must be **indistinguishable** from one that does not exist.
     * Anything else turns the public URL into a probe — "this registration
     * exists but has not opened yet" is exactly the sentence it must not say.
     */
    it('answers an unpublished form byte-identically to an unknown address', async () => {
      const draft = await request(app().server).get(
        apiPath(`/public/forms/${draftSlug}`),
      );
      const unknown = await request(app().server).get(
        apiPath('/public/forms/gibtesnicht'),
      );

      expect(draft.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(draft.text).toBe(unknown.text);
      expect(draft.text).toContain(PUBLIC_FORM_NOT_FOUND_MESSAGE);
    });

    /**
     * **The single 404 has to survive an address nobody could type.**
     *
     * The slug used to be bounded by length alone, and length is not the
     * property that matters: `%00` in the path arrives decoded as a NUL byte,
     * PostgreSQL refuses U+0000 inside `text`, and the query blew up — a 500
     * where every other unknown address answers 404. That is the probe this
     * suite exists to close, and it does not need a real slug to work: the
     * *shape* of the answer is what differs.
     *
     * Asserted against a genuinely unknown address rather than against a bare
     * status, so „identical" is what it says.
     */
    it.each([
      ['a NUL byte', '%00'],
      ['a NUL byte inside an otherwise plausible address', 'AbCd%00Ef123456'],
      ['a space', 'AbCd%20Ef'],
      ['a character outside the base64url alphabet', 'AbCd.Ef'],
    ])('answers %s like an unknown address', async (_name, encoded) => {
      const unknown = await request(app().server).get(
        apiPath('/public/forms/gibtesnicht'),
      );
      const probe = await request(app().server).get(
        apiPath(`/public/forms/${encoded}`),
      );

      expect(probe.status).toBe(unknown.status);
      expect(probe.status).toBe(404);
      expect(probe.text).toBe(unknown.text);
    });

    /**
     * A deleted form is in the trash and answers like one that never
     * existed. Asserted separately from the draft case because they take
     * different branches — and a deleted form is the one whose address was
     * genuinely handed out to people, so it is the one most likely to be
     * called after the fact.
     */
    it('answers a deleted form byte-identically to an unknown address', async () => {
      const slug = await createForm('Wird gelöscht', true);
      const unknown = await request(app().server).get(
        apiPath('/public/forms/gibtesnicht'),
      );

      await app().prisma.form.updateMany({
        where: { publicSlug: slug },
        data: { deletedAt: new Date() },
      });

      const deleted = await request(app().server).get(
        apiPath(`/public/forms/${slug}`),
      );

      expect(deleted.status).toBe(unknown.status);
      expect(deleted.status).toBe(404);
      expect(deleted.text).toBe(unknown.text);
      expect(deleted.text).toContain(PUBLIC_FORM_NOT_FOUND_MESSAGE);
    });

    it('answers an oversized slug the same way instead of querying with it', async () => {
      const response = await request(app().server).get(
        apiPath(`/public/forms/${'x'.repeat(500)}`),
      );

      expect(response.status).toBe(404);
    });
  });

  describe('submitting without a login', () => {
    it('accepts a valid submission and confirms it', async () => {
      const response = await request(app().server)
        .post(apiPath(`/public/forms/${publishedSlug}/responses`))
        .send({ answers: { [NAME]: 'Anton', [SEMESTER]: 4 } });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        confirmationTitle: expect.any(String) as unknown,
        confirmationMessage: expect.any(String) as unknown,
      });

      const stored = await app().prisma.response.findFirst({
        orderBy: { submittedAt: 'desc' },
      });
      expect(stored?.answers).toMatchObject({ [NAME]: 'Anton', [SEMESTER]: 4 });
      // Written with the tenant of the resolved form, never from the request.
      expect(stored?.tenantId).toBe(tenant.id);
    });

    it('rejects a submission to a form that is not published', async () => {
      const response = await request(app().server)
        .post(apiPath(`/public/forms/${draftSlug}/responses`))
        .send({ answers: { [NAME]: 'Anton' } });

      expect(response.status).toBe(404);
    });

    /**
     * The requirement, and the tests go **straight at the API**, past any
     * client-side validation: that is the whole claim — the server validates
     * itself, and the client's check is UX.
     */
    describe('the server validates itself', () => {
      async function submit(answers: unknown): Promise<request.Response> {
        return request(app().server)
          .post(apiPath(`/public/forms/${publishedSlug}/responses`))
          .send({ answers });
      }

      async function countResponses(): Promise<number> {
        return app().prisma.response.count();
      }

      it('refuses an empty required field and creates nothing', async () => {
        const before = await countResponses();

        const response = await submit({ [NAME]: '' });

        expect(response.status).toBe(400);
        expect(response.text).toContain(NAME);
        expect(await countResponses()).toBe(before);
      });

      it('refuses a number outside its bounds', async () => {
        const response = await submit({ [NAME]: 'Anton', [SEMESTER]: 99 });

        expect(response.status).toBe(400);
        expect(response.text).toContain(SEMESTER);
      });

      /**
       * The pattern is compiled at save time and run here. A client
       * that skips its own check must not get past this one.
       */
      it('refuses a text that does not match its pattern', async () => {
        const before = await countResponses();

        const response = await submit({ [NAME]: 'Anton', [POSTCODE]: '3503' });

        expect(response.status).toBe(400);
        expect(response.text).toContain(POSTCODE);
        expect(await countResponses()).toBe(before);
      });

      /**
       * An option value the question does not offer. Refused rather than
       * dropped: the difference between „hat nichts gewählt" and „hat etwas
       * gewählt, das wir verworfen haben" is exactly what a Teilnehmerliste
       * must not blur.
       */
      it('refuses an option value the question does not offer', async () => {
        const before = await countResponses();

        const response = await submit({
          [NAME]: 'Anton',
          [MEAL]: { values: ['hummer'], other: null },
        });

        expect(response.status).toBe(400);
        expect(response.text).toContain(MEAL);
        expect(await countResponses()).toBe(before);
      });

      it('refuses a non-integer where the question asks for one', async () => {
        expect(
          (await submit({ [NAME]: 'Anton', [SEMESTER]: 4.5 })).status,
        ).toBe(400);
      });

      /**
       * The case the requirement singles out: a value for a question the form
       * does not have. Refused, not quietly dropped — otherwise a tampered
       * payload would land in the JSONB column and reappear in the export as a
       * column nobody defined.
       */
      it('refuses an answer to a question that does not exist', async () => {
        const before = await countResponses();

        const response = await submit({
          [NAME]: 'Anton',
          '019ff100-0000-7000-8000-0000000000ff': 'geschmuggelt',
        });

        expect(response.status).toBe(400);
        expect(await countResponses()).toBe(before);
      });

      it('refuses a body that is not a submission at all', async () => {
        const response = await request(app().server)
          .post(apiPath(`/public/forms/${publishedSlug}/responses`))
          .send({ nichts: true });

        expect(response.status).toBe(400);
      });
    });
  });

  /**
   * The requirement, the write path: the two **structured** answer shapes reach
   * the JSONB column as themselves.
   *
   * An integration test rather than a unit one, and the reason is what
   * `toStoredAnswers` is: the public write path, where nothing type-checks a
   * cast and a wrongly shaped write is invisible until somebody opens an
   * export. The `never` at its tail turned this package into a compile error
   * instead — and the first draft of the Matrix branch written against it
   * stored the rows **without their `rows` wrapper**, which compiled, passed
   * the validator and would have made every Matrix column of every export
   * empty. This test is what caught it.
   */
  describe('strukturierte Antworten im Speicher', () => {
    const GRID_PAGE = '019ff100-0000-7000-8000-0000000000b0';
    const MATRIX = '019ff100-0000-7000-8000-0000000000b1';
    const TABLE = '019ff100-0000-7000-8000-0000000000b2';

    function gridDefinition() {
      return {
        pages: [
          {
            id: GRID_PAGE,
            title: 'Rückmeldung',
            description: null,
            questions: [
              {
                id: MATRIX,
                type: 'matrix',
                label: 'Bewertung',
                hint: null,
                required: false,
                width: 'full',
                rows: [
                  { value: 'organisation', label: 'Organisation' },
                  { value: 'programm', label: 'Programm' },
                ],
                columns: [
                  { value: 'sehr-gut', label: 'Sehr gut' },
                  { value: 'gut', label: 'Gut' },
                ],
                multiple: false,
              },
              {
                id: TABLE,
                type: 'table',
                label: 'Begleitpersonen',
                hint: null,
                required: false,
                width: 'full',
                columns: [
                  { key: 'name', label: 'Name', type: 'text' },
                  { key: 'anzahl', label: 'Anzahl', type: 'number' },
                  {
                    key: 'vegetarisch',
                    label: 'Vegetarisch',
                    type: 'checkbox',
                  },
                ],
                rows: 2,
              },
            ],
          },
        ],
      };
    }

    let gridSlug: string;

    beforeAll(async () => {
      const created = await request(app().server)
        .post(apiPath('/forms'))
        .set(authedMutation(editor))
        .send({ title: 'Matrix und Tabelle' });
      const form = created.body as {
        id: string;
        revision: number;
        publicSlug: string;
      };
      const saved = await request(app().server)
        .put(apiPath(`/forms/${form.id}`))
        .set(authedMutation(editor))
        .send({
          title: 'Matrix und Tabelle',
          definition: gridDefinition(),
          revision: form.revision,
        });
      const published = await request(app().server)
        .post(apiPath(`/forms/${form.id}/publish`))
        .set(authedMutation(editor))
        .send({ revision: (saved.body as { revision: number }).revision });
      expect(published.status).toBe(200);
      gridSlug = form.publicSlug;
    });

    /**
     * The finding of a review, on the route it was measured on: a
     * **required** structured question answered with a payload of the wrong
     * shape came back as **500**, not 400 — `buildAnswersSchema` runs
     * `isBlankAnswer` on the raw body before any schema sees it, and a
     * `TypeError` thrown inside a Zod refinement is not caught by `safeParse`.
     *
     * This is a public, unauthenticated route, so the case
     * belongs here and not only in the shared unit tests: what matters is the
     * status code an anonymous request can provoke.
     */
    it('answers a required structured question of the wrong shape with 400, not 500', async () => {
      const REQUIRED_PAGE = '019ff100-0000-7000-8000-0000000000c0';
      const REQUIRED_TABLE = '019ff100-0000-7000-8000-0000000000c1';

      const created = await request(app().server)
        .post(apiPath('/forms'))
        .set(authedMutation(editor))
        .send({ title: 'Pflicht-Tabelle' });
      const form = created.body as {
        id: string;
        revision: number;
        publicSlug: string;
      };
      const saved = await request(app().server)
        .put(apiPath(`/forms/${form.id}`))
        .set(authedMutation(editor))
        .send({
          title: 'Pflicht-Tabelle',
          revision: form.revision,
          definition: {
            pages: [
              {
                id: REQUIRED_PAGE,
                title: 'Seite 1',
                description: null,
                questions: [
                  {
                    id: REQUIRED_TABLE,
                    type: 'table',
                    label: 'Begleitpersonen',
                    hint: null,
                    required: true,
                    width: 'full',
                    columns: [{ key: 'name', label: 'Name', type: 'text' }],
                    rows: 2,
                  },
                ],
              },
            ],
          },
        });
      await request(app().server)
        .post(apiPath(`/forms/${form.id}/publish`))
        .set(authedMutation(editor))
        .send({ revision: (saved.body as { revision: number }).revision });

      const before = await app().prisma.response.count();

      for (const answer of [{ cells: 'x' }, { cells: 5 }, { cells: [null] }]) {
        const response = await request(app().server)
          .post(apiPath(`/public/forms/${form.publicSlug}/responses`))
          .send({ answers: { [REQUIRED_TABLE]: answer } });

        expect(response.status).toBe(400);
      }
      expect(await app().prisma.response.count()).toBe(before);
    });

    it('stores a matrix and a table in the shape they were validated in', async () => {
      const response = await request(app().server)
        .post(apiPath(`/public/forms/${gridSlug}/responses`))
        .send({
          answers: {
            [MATRIX]: { rows: { organisation: ['sehr-gut'] } },
            [TABLE]: {
              cells: [{ name: 'Anna', anzahl: 2, vegetarisch: true }, {}],
            },
          },
        });

      expect(response.status).toBe(200);

      const stored = await app().prisma.response.findFirst({
        orderBy: { submittedAt: 'desc' },
      });
      expect(stored?.answers).toStrictEqual({
        [MATRIX]: { rows: { organisation: ['sehr-gut'] } },
        [TABLE]: {
          cells: [{ name: 'Anna', anzahl: 2, vegetarisch: true }, {}],
        },
      });
    });

    /**
     * The server validates itself here too: a scale step the question does not
     * offer, a cell of the wrong type for its column and a row past the count
     * the form offers are all refused — and nothing is written.
     */
    it.each([
      [
        'a scale step the Matrix does not offer',
        { [MATRIX]: { rows: { organisation: ['spitze'] } } },
      ],
      [
        'a row the Matrix does not have',
        { [MATRIX]: { rows: { erfunden: ['gut'] } } },
      ],
      [
        'two picks in one row without Mehrfachauswahl',
        { [MATRIX]: { rows: { organisation: ['sehr-gut', 'gut'] } } },
      ],
      [
        'a cell of the wrong type for its column',
        { [TABLE]: { cells: [{ anzahl: 'zwei' }] } },
      ],
      [
        'a column the Tabelle does not have',
        { [TABLE]: { cells: [{ erfunden: 'x' }] } },
      ],
      [
        'more rows than the form offers',
        { [TABLE]: { cells: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] } },
      ],
    ])('refuses %s and stores nothing', async (_name, answers) => {
      const before = await app().prisma.response.count();

      const response = await request(app().server)
        .post(apiPath(`/public/forms/${gridSlug}/responses`))
        .send({ answers });

      expect(response.status).toBe(400);
      expect(await app().prisma.response.count()).toBe(before);
    });
  });

  describe('the public routes and the guard chain', () => {
    /**
     * They are exempt from CSRF, and this is one of the two documented reasons
     * for the decorator: the route authenticates nobody, so there is no
     * session to ride on. Asserted here as well as in the route-coverage test,
     * because that test only checks that the exemption *list* is what it says.
     */
    it('accepts a submission without a CSRF token, having no session to protect', async () => {
      const slug = await createForm('Ohne Token', true);

      const response = await request(app().server)
        .post(apiPath(`/public/forms/${slug}/responses`))
        .send({ answers: { [NAME]: 'Anton' } });

      expect(response.status).toBe(200);
    });

    /**
     * And the boundary that still holds: the public routes give a stranger a
     * way to *write* one row into one form. They give no way to read anybody's
     * answers — that stays behind the session, the tenant scope and
     * `can_view_responses`.
     */
    it('opens no door to the answers of a form', async () => {
      const anonymous = await request(app().server).get(apiPath('/forms'));
      expect(anonymous.status).toBe(401);

      const withSession = await request(app().server)
        .get(apiPath('/forms'))
        .set('Cookie', cookieHeader(editor));
      expect(withSession.status).toBe(200);
    });
  });

  /**
   * The requirement — „die öffentliche Seite erfährt nur, was sie braucht".
   *
   * The proof the requirement asks for is an **allow list**, and the difference
   * from the obvious alternative is the whole point: „enthält kein Passwort"
   * stays green while a response counter, a form id or a redirect target sneaks
   * onto the wire. „Enthält genau diese Felder" fails the moment anything is
   * added — which is exactly when somebody has to justify sending it to
   * strangers.
   *
   * It sits in this file rather than in a new one because the other half
   * is that the original contract must **not** change: the fields it promised
   * are asserted a few describes above, and the two belong together.
   */
  describe('the public payload carries exactly these fields', () => {
    /**
     * A published form plus its id, so its settings can be configured.
     *
     * Takes the session to build it with, defaulting to the describe's shared
     * `editor` — a second parameter rather than a second function, so the
     * fully-configured Organisation below (its own SMTP block, its own OIDC login) can
     * reuse the exact same construction instead of a copy that could drift
     * from it.
     */
    async function publishedForm(
      title: string,
      session = editor,
    ): Promise<{ id: string; slug: string }> {
      const created = await request(app().server)
        .post(apiPath('/forms'))
        .set(authedMutation(session))
        .send({ title });
      const form = created.body as {
        id: string;
        revision: number;
        publicSlug: string;
      };

      const saved = await request(app().server)
        .put(apiPath(`/forms/${form.id}`))
        .set(authedMutation(session))
        .send({ title, definition: definition(), revision: form.revision });
      const published = await request(app().server)
        .post(apiPath(`/forms/${form.id}/publish`))
        .set(authedMutation(session))
        .send({ revision: (saved.body as { revision: number }).revision });
      expect(published.status).toBe(200);

      return { id: form.id, slug: form.publicSlug };
    }

    /**
     * Writes settings through the real route.
     *
     * The two counters are read from the row rather than guessed: a `PUT`
     * without them is a 400 by design, and this suite is
     * about the *payload*, not about the conflict protection — that has its own
     * tests in `test/settings/form-settings.spec.ts`.
     */
    async function configure(
      formId: string,
      overridden: Record<string, boolean>,
      values: Record<string, unknown>,
      session = editor,
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
        .set(authedMutation(session))
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

    /** The tenant standards, likewise through the real route. */
    async function configureTenant(
      values: Record<string, unknown>,
    ): Promise<void> {
      const tenantRow = await app().prisma.tenant.findUniqueOrThrow({
        where: { id: tenant.id },
        select: { formDefaultsRevision: true },
      });
      const response = await request(app().server)
        .put(apiPath('/tenant/form-defaults'))
        .set(authedMutation(editor))
        // A patch, not switches (review finding 10): the organisation carries
        // a complete set of values, and what changes is what gets written.
        .send({ values, revision: tenantRow.formDefaultsRevision });
      expect(response.status).toBe(200);
    }

    /**
     * **The organisation the closed list is measured against (the requirement).**
     *
     * This suite's own fixture Organisation carries nothing beyond the branding
     * `createTenant` always sets — no SMTP block, no OIDC login. Later work
     * added exactly those two secret-bearing blocks to the
     * `tenant` row, and neither is read anywhere on this path (the public
     * fill-in module cannot even import their openers — see the
     * `no-restricted-imports` allow-list in `eslint.config.js`). A list that
     * only ever measured an organisation without secrets could not tell "correctly
     * withheld" from "never fetched", so this organisation is given both, through the
     * real routes, before the payload below is read.
     */
    const A8_SMTP_PASSWORD = 'streng-geheimes-smtp-passwort-a8';
    const A8_OIDC_CLIENT_SECRET = 'streng-geheimes-oidc-client-secret-a8';

    let fullTenant: TenantFixture;
    let fullEditor: string;

    beforeAll(async () => {
      fullTenant = await createTenant(app().prisma, 'A8V');
      const user = await createUser(app().prisma, {
        email: 'a8-vollbund@example.org',
        password: PASSWORD,
        tenants: [fullTenant],
      });
      fullEditor = await openSession(app(), user.id, fullTenant.id);

      const smtp = await request(app().server)
        .put(apiPath('/tenant/smtp'))
        .set(authedMutation(fullEditor))
        .send({
          smtp: {
            host: 'mail.a8v.invalid',
            port: 587,
            secure: false,
            from: 'post@a8v.invalid',
            auth: { user: 'a8v', password: A8_SMTP_PASSWORD },
          },
        });
      expect(smtp.status).toBe(200);

      const oidc = await request(app().server)
        .put(apiPath('/tenant/oidc'))
        .set(authedMutation(fullEditor))
        .send({
          enabled: true,
          issuer: 'https://idp.a8v.invalid/realms/demo',
          clientId: 'formsache',
          scopes: ['openid', 'profile', 'email'],
          emailClaim: DEFAULT_OIDC_EMAIL_CLAIM,
          emailVerifiedClaim: DEFAULT_OIDC_EMAIL_VERIFIED_CLAIM,
          buttonLabel: 'Mit Organisation-Login anmelden',
          clientSecret: A8_OIDC_CLIENT_SECRET,
        });
      expect(oidc.status).toBe(200);
    }, 60_000);

    /**
     * The public read of a slug — optionally holding the access proof of a
     * password-protected form.
     *
     * The proof travels in the header the application defines, imported rather
     * than spelled out: a second literal here would keep agreeing with itself
     * after the real one changed.
     *
     * **Both halves come back**, `body` for the key checks and `text` for the
     * searches over the whole answer. It used to hand out the parsed object
     * only, so every test that needed the raw text built its own request next
     * to this one — four copies of the same three lines, and each of them a
     * place where the proof header or the status check could quietly go
     * missing.
     */
    async function payloadOf(
      slug: string,
      proof?: string,
    ): Promise<{ body: Record<string, unknown>; text: string }> {
      const call = request(app().server).get(apiPath(`/public/forms/${slug}`));
      const response =
        proof === undefined
          ? await call
          : await call.set(ACCESS_PROOF_HEADER, proof);
      expect(response.status).toBe(200);
      return {
        body: JSON.parse(response.text) as Record<string, unknown>,
        text: response.text,
      };
    }

    /** Passes the password gate through the real route and returns the proof. */
    async function unlock(slug: string, word: string): Promise<string> {
      const response = await request(app().server)
        .post(apiPath(`/public/forms/${slug}/access`))
        .send({ password: word });
      expect(response.status).toBe(200);
      return (response.body as { accessToken: string }).accessToken;
    }

    /** Object keys of a nested member, sorted — `{}` if it is not an object. */
    function keysOf(value: unknown): string[] {
      return typeof value === 'object' && value !== null
        ? Object.keys(value).sort()
        : [];
    }

    /**
     * The renderings a leaked **byte** column plausibly puts on the wire.
     *
     * `tenant.oidc_client_secret_encrypted` is the one secret that is not a
     * string, and JSON has no bytes — so there is no single spelling to search
     * for. Which one a leak produces depends on how the value arrives:
     * `JSON.stringify` of a `Buffer` follows its `toJSON` and writes
     * `{"type":"Buffer","data":[18,34,…]}`, a bare `Uint8Array` has no `toJSON`
     * and becomes the index map `{"0":18,"1":34,…}`, and a hand-written mapper
     * would reach for one of the three encodings. All of them are searched
     * rather than guessed between; each is long enough that a coincidental hit
     * is not a concern.
     */
    function renderingsOf(bytes: Uint8Array): string[] {
      const buffer = Buffer.from(bytes);
      return [
        buffer.toString('base64'),
        buffer.toString('base64url'),
        buffer.toString('hex'),
        buffer.join(','),
        Array.from(
          buffer,
          (byte, index) => `"${String(index)}":${String(byte)}`,
        ).join(','),
      ];
    }

    /** The sealed access word of a form, straight out of its column. */
    async function sealedAccessWordOf(formId: string): Promise<string> {
      const row = await app().prisma.form.findUniqueOrThrow({
        where: { id: formId },
        select: { settingsOverride: true },
      });
      return z
        .object({ values: z.object({ password: z.string().min(1) }) })
        .parse(row.settingsOverride).values.password;
    }

    /** The organisation's two sealed secrets, straight out of their columns. */
    async function sealedSecretsOfTenant(tenantId: string): Promise<string[]> {
      const row = await app().prisma.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { smtp: true, oidcClientSecret: true },
      });
      const smtp = z
        .object({ auth: z.object({ password: z.string().min(1) }) })
        .parse(row.smtp);
      const clientSecret = row.oidcClientSecret;
      if (clientSecret === null) {
        throw new Error(
          'the fully configured Organisation holds no sealed client secret',
        );
      }
      return [smtp.auth.password, ...renderingsOf(clientSecret)];
    }

    /**
     * **Every secret this organisation and this form hold, searched for on the whole
     * text — as the bytes that are actually in the columns.**
     *
     * The three plaintext searches are the obvious ones and they *cannot go
     * red*: all three values are sealed on the way in
     * (`MailSecretsService.sealTenantBlock`, `OidcSecretsService`,
     * `settings-secrets.ts`), so a payload that serialised the whole `tenant`
     * row or the whole `settings_override` would put **ciphertext** on the
     * wire and a search for the plaintext would stay green straight through
     * the leak. They are kept as the cheap statement of intent; they are not
     * the evidence.
     *
     * The evidence is the second half: the sealed values are read back from
     * the database *after* the fixture wrote them, and the answer is searched
     * for those. That is what a leak spits out. The nested loop also checks
     * that the columns really hold ciphertext — a column that held the
     * plaintext would turn the second half into a copy of the first.
     *
     * That this search can go red is not asserted by argument but measured:
     * see „sees the sealed secret …" at the end of this describe.
     */
    async function expectNoSecretOnTheWire(
      text: string,
      form: { id: string; accessWord: string },
    ): Promise<void> {
      const plaintext = [
        form.accessWord,
        A8_SMTP_PASSWORD,
        A8_OIDC_CLIENT_SECRET,
      ];
      for (const value of plaintext) {
        expect(text).not.toContain(value);
      }

      const sealed = [
        ...(await sealedSecretsOfTenant(fullTenant.id)),
        await sealedAccessWordOf(form.id),
      ];
      expect(sealed.length).toBeGreaterThanOrEqual(2);
      for (const value of sealed) {
        // Long enough to be a real value: searching for a short string would
        // be a coin toss rather than an assertion, and an empty one would make
        // `toContain` pass on everything.
        expect(value.length).toBeGreaterThan(20);
        for (const secret of plaintext) {
          expect(value).not.toContain(secret);
        }
        expect(text).not.toContain(value);
      }
    }

    /**
     * The list itself, on a form whose settings are configured as fully as
     * this stage allows: a deadline, a response limit, an access word, custom
     * confirmation texts, a redirect, **and — — a Versandbudget**
     * (`budget`, the fifth section). Everything behind those settings is
     * configuration; the payload may carry a judgement about it and the three
     * display flags, and nothing else.
     *
     * **Measured on the fully-configured Organisation (the requirement), not on the
     * describe's shared fixture.** `fullTenant` carries its own SMTP block and
     * its own OIDC login next to its own branding — the three things later work
     * added to the `tenant` row — so a field that started leaking one of
     * them has real secret material next to it, not an empty column that would
     * leak nothing whatever the code did wrong.
     */
    /**
     * **`startToken` is the one field added after the fact**, and the
     * requirement asks for exactly this: „ein später ergänztes Feld muss diesen
     * Test passieren und damit begründet werden."
     *
     * The justification is the requirement. The token is not configuration — it
     * carries no deadline, no limit, no minute count and no id; it is an
     * instant this server signed so that it can recognise its own answer later.
     * It travels with **every** form, including one without a time limit, so
     * that its presence does not disclose whether the setting is on. What it
     * says about the form is nothing the caller did not already know: that they
     * just read it.
     */
    /**
     * **`locked` is the second field added after the fact**, and the same
     * sentence applies: „ein später ergänztes Feld muss diesen Test passieren
     * und damit begründet werden."
     *
     * Its justification is the requirement. It is not configuration either — it is
     * a *verdict* about this request, in the same family as `availability`:
     * „you are past the gate" or „you are not". The value it can take is
     * unavoidable information, because the alternative to telling a participant
     * that a word is needed is a page that appears broken. What it does not say
     * is anything about the word: not its length, not whether it came from the
     * form or from the organisation's standard, not when it was set.
     *
     * The form below is configured **with** an access word and read **with** a
     * valid proof, so the list asserted here is the full payload of a protected
     * form after the gate. The locked half — three keys, no definition — is
     * asserted in `password-gate.spec.ts`, where the gate itself lives.
     */
    /**
     * **`eventSeats` is the third field added after the fact**, and it is
     * the one the requirement had in mind: „ein Feld, das nur der Server kennt
     * (Restplätze, Speicherpfad einer Datei), gehört nicht ins
     * `formDefinitionSchema`, sondern neben es — in einen eigenen
     * Payload-Schlüssel, den die geschlossene Liste oben dann sieht."
     *
     * Its justification is the requirement, and it is a *decision of the
     * editor* rather than a default: „ausgebucht" travels for every bounded
     * Veranstaltung, because a participant who cannot see that a hall is gone
     * types a number and is refused by the transaction; the **figure**
     * travels only where „Restplätze anzeigen" is on, because it is a statement
     * about an organisation's registration state and it leaves the house without a session.
     * What it never carries is the Obergrenze itself — that is in `definition`
     * already, where the editor put it — and nothing about who registered.
     *
     * The switch is measured where seats can actually be taken
     * (`event-limit.spec.ts`, „die Restplatz-Anzeige"). Here it only has
     * to be **named**: the form of this suite has no Veranstaltung, so the key
     * arrives as an empty array, and that is deliberate — the array is always
     * present so that its presence cannot say „dieses Formular hat
     * Veranstaltungen".
     */
    it('answers with the twelve documented keys and nothing on the defence side of the line', async () => {
      const form = await publishedForm('Positivliste', fullEditor);
      const accessWord = 'streng-geheimes-zugangswort-a8';
      await configure(
        form.id,
        {
          access: true,
          confirm: true,
          display: true,
          budget: true,
        },
        {
          openEnabled: true,
          closeAt: '2099-12-31T22:59:00.000Z',
          maxResponsesEnabled: true,
          maxResponses: 4711,
          passwordEnabled: true,
          password: accessWord,
          confirmTitle: 'Danke, Mitglied',
          confirmMsg: 'Die Anmeldung ist eingegangen.',
          redirectEnabled: true,
          redirectUrl: 'https://beispiel.invalid/danke',
          showProgress: false,
          showPageNumbers: false,
          showRequiredHint: false,
          // The fifth section.
          //
          // **Only the limit is searched by value below, and the window is
          // not.** `mailBudgetLimit` gets five digits that occur nowhere else
          // in this file, so a hit is unmistakably this setting.
          // `mailBudgetWindowMin` cannot have that property: it is bounded to
          // 24 hours (`MAIL_BUDGET_WINDOW_MIN_MAX`), so every legal value is
          // at most four digits, and a run that short collides with the digits
          // inside a uuid or a signed token often enough to make the search a
          // flake rather than an assertion. The window is therefore pinned by
          // its **key name** alone — which is the half that would break first
          // if the section ever reached this payload, since a leak of the
          // section carries the key with it.
          mailBudgetLimit: 62_401,
          mailBudgetWindowMin: 73,
        },
        fullEditor,
      );

      const { body, text } = await payloadOf(
        form.slug,
        await unlock(form.slug, accessWord),
      );

      // The closed list itself. **The literal is the expectation and has to
      // be** — a list derived from the answer would agree with whatever the
      // server sends and prove nothing. What is derived is the *Ist* side:
      // `Object.keys(body)`, so the moment a field is added the two stop
      // matching and somebody has to justify sending it to strangers.
      expect(Object.keys(body).sort()).toEqual([
        'availability',
        // The requirement — „bietet diese Ansicht Zwischenspeichern an". A
        // verdict about what this page can do, in the same category as
        // `availability.state` and `eventSeats[].full`, and it names no
        // configured value: no deadline, no limit, no word, no minute count.
        'canSaveDraft',
        'definition',
        'display',
        'eventSeats',
        'locked',
        // **The privacy notice of this form** (ADR-0028 no. 4) — the one key
        // of this list that was written expressly to be read by the
        // participating person. It does not bind them and wards nothing off;
        // it is the information Art. 13 Abs. 1 DSGVO demands „zum Zeitpunkt
        // der Erhebung", and withholding it would not be data economy but the
        // breach of duty itself. `null` means „nichts hinterlegt".
        'privacyNotice',
        'startToken',
        'tenant',
        // **The time limit** (finding 32) — the one key of this list that
        // *names a setting*, and the place at which the rule of this list was
        // sharpened: public is what binds the person filling in, not what the
        // form wards off
        // (`packages/shared/src/public-form.ts`, header comment). Here it is
        // `null` — this form has no time limit —, and that it stands there
        // *nonetheless* is half the statement: its presence must not say
        // whether the setting is on. The switched-on case is measured one
        // test further down.
        'timeLimitMin',
        'title',
        'version',
      ]);
      expect(body.timeLimitMin).toBeNull();
      expect(body.locked).toBe(false);
      expect(keysOf(body.tenant)).toEqual([
        'branding',
        'logoRef',
        'name',
        'shortName',
      ]);
      expect(keysOf((body.tenant as Record<string, unknown>).branding)).toEqual(
        ['accent', 'canvasBg', 'headerBg', 'stripe', 'wideLogo'],
      );
      expect(keysOf(body.display)).toEqual([
        'showPageNumbers',
        'showProgress',
        'showRequiredHint',
      ]);
      expect(keysOf(body.availability)).toEqual([
        'closesAt',
        'opensAt',
        'state',
      ]);
      // Empty, because this fixture has no Veranstaltung — present all the
      // same, for the reason `publicFormSchema` states.
      expect(body.eventSeats).toStrictEqual([]);
      // **`definition` stays an open list — with a lock in front of it**
      // (decided in a review, 2026-07-31, after the question had been asked
      // expressly).
      //
      // Listing the keys *individually* would mean writing
      // `formDefinitionSchema` a second time here — for fourteen question
      // types with fields of their own each. That list would go red on every
      // legitimate extension of the builder and would be pulled along
      // mechanically; exactly the opposite of „jemand muss rechtfertigen, dass
      // das an Fremde geht". And it would not be the boundary at issue
      // either: the `definition` **is** the document a participant is supposed
      // to fill in — it does not travel along by accident.
      //
      // What makes uploads (upload references) and Veranstaltungen (remaining
      // seats) dangerous is something else: **server-derived** values that
      // ride along in the snapshot because it is handed out raw from the JSONB
      // column. The round trip below stands against that: `parseFormDefinition`
      // strips unknown keys off, so a comparison with what was delivered goes
      // red as soon as something stands anywhere in the document that the
      // schema does not know — at every level, without a single field list.
      //
      // What it does **not** achieve, and where the boundary therefore lies
      // deliberately: a *new schema field* passes it by definition. A field
      // that only the server knows (remaining seats, storage path of a file)
      // therefore does not belong in `formDefinitionSchema` but beside it — in
      // a payload key of its own, which the closed list above then sees.
      expect(body.definition).toHaveProperty('pages');
      expect(body.definition).toStrictEqual(
        parseFormDefinition(body.definition),
      );

      // The requirement, the evidence: the page title and the page description
      // are both part of this payload — measured, not assumed from
      // `formDefinitionSchema` alone. The fixture's own value
      // (`definition()` above) reaches the wire unchanged.
      const definitionBody = body.definition as {
        pages: readonly { title: string; description: string | null }[];
      };
      expect(definitionBody.pages[0]).toMatchObject({
        title: 'Anmeldung',
        description: 'Bitte vollständig ausfüllen.',
      });

      // The harder half, on the **whole** text: a value nested inside a
      // member the key check above did not expect to hold anything would
      // pass that check and fail this one.
      await expectNoSecretOnTheWire(text, { id: form.id, accessWord });
      expect(text).not.toContain('62401');
      expect(text).not.toContain('mailBudgetLimit');
      expect(text).not.toContain('mailBudgetWindowMin');
    });

    /**
     * **The time limit a participant has to see beforehand** (finding 32).
     *
     * The damage of the previous state was concrete: whoever types thirty
     * fields and then runs into a `time_limit` 409 that nothing announced
     * loses their work. So the payload names the number of minutes — and only
     * it: the test beside it shows that the response limit, the access word
     * and the budgets stay behind their verdicts as before.
     *
     * The second half is the one that would be wrong without intent: the
     * settings **always** carry a `timeLimitMin` (30 as the default), even
     * while the switch is off. A server that handed it through raw would write
     * „30 Minuten" over a form without a time limit. Both are therefore
     * measured, on *one* form whose switch is on once and off once.
     */
    it('names the time limit while it is on, and null while it is off', async () => {
      const form = await publishedForm('Zeitlimit sichtbar', fullEditor);
      // A number that occurs nowhere else in this answer — that way a hit in
      // the text is unmistakably this setting.
      await configure(
        form.id,
        {},
        { timeLimitEnabled: true, timeLimitMin: 47 },
        fullEditor,
      );

      const on = await payloadOf(form.slug);
      expect(on.body.timeLimitMin).toBe(47);

      // The switch off, the stored number stays standing — and must not
      // reach the wire nonetheless.
      await configure(
        form.id,
        {},
        { timeLimitEnabled: false, timeLimitMin: 47 },
        fullEditor,
      );

      const off = await payloadOf(form.slug);
      expect(off.body.timeLimitMin).toBeNull();
      // What is searched for is the **key with its value**, not the number
      // alone: „47" hits by itself sooner or later in an answer full of uuids
      // and a base36 token, and an assertion that goes red by chance is none
      // (the same reason `mailBudgetWindowMin` above is checked through its
      // name alone).
      expect(off.text).not.toContain('"timeLimitMin":47');
    });

    /**
     * The same run, read the other way round: the **whole** text is searched,
     * not the fields that were expected. A value nested three levels down in
     * `definition` would pass a key check and fail this one.
     *
     * Read **through the gate**, and that is the harder half of the
     * claim rather than a formality: a payload that withheld the word only
     * while it also withheld the questions would prove nothing.
     * The search runs over the answer a participant gets *after* they entered
     * the word — the one place the plaintext is closest to the wire.
     *
     * **On the fully-configured Organisation, like the test above** (the requirement).
     * It used to run on this describe's thin fixture, and that split the suite
     * the wrong way round: the searches that can genuinely go red — the limit,
     * the two key names, the redirect target, the two ids — were the ones
     * pointed at an organisation with nothing in its secret-bearing columns, while the
     * grown Organisation was measured by the closed key list alone. The grown Organisation and
     * the sharp searches now meet.
     */
    it('carries neither the access word, nor the limit, nor an internal id', async () => {
      const form = await publishedForm('Nichts durchgelassen', fullEditor);
      const accessWord = 'streng-geheimes-zugangswort';
      await configure(
        form.id,
        { access: true, confirm: true },
        {
          openEnabled: true,
          closeAt: '2099-12-31T22:59:00.000Z',
          maxResponsesEnabled: true,
          maxResponses: 4711,
          passwordEnabled: true,
          password: accessWord,
          confirmTitle: 'Danke, Mitglied',
          confirmMsg: 'Die Anmeldung ist eingegangen.',
          redirectEnabled: true,
          redirectUrl: 'https://beispiel.invalid/danke',
        },
        fullEditor,
      );

      const { text } = await payloadOf(
        form.slug,
        await unlock(form.slug, accessWord),
      );

      await expectNoSecretOnTheWire(text, { id: form.id, accessWord });
      expect(text).not.toContain('4711');
      expect(text).not.toContain('maxResponses');
      expect(text).not.toContain('passwordEnabled');
      // The confirmation texts arrive with the answer to the submission, not
      // with the form — see the test below.
      expect(text).not.toContain('Danke, Mitglied');
      expect(text).not.toContain('beispiel.invalid');
      expect(text).not.toContain(form.id);
      expect(text).not.toContain(fullTenant.id);
      expect(text).not.toContain(fullTenant.adminGroupId);
    });

    /**
     * **The locked half of the union, measured where a leak would have
     * something to leak.**
     *
     * `password-gate.spec.ts` already pins the three keys of the locked
     * payload, and it does so on its own Organisation — one with no SMTP block and no
     * OIDC login, because that suite is about the *gate* and not about the row
     * behind it. That is the right fixture for what it proves and the wrong
     * one for this: the locked branch hands out `tenant` from the very row
     * that carries the two sealed secrets (`tenantOf(form.tenant)`, the same
     * call the open branch makes), and it hands it to the least-trusted reader
     * this application has — somebody who has **not** answered the password
     * prompt. So the closed list and the secret search are measured here, on
     * the grown Organisation; the gate keeps its own suite and its own fixture.
     */
    it('withholds the same secrets from a caller who has not passed the gate', async () => {
      const form = await publishedForm('Vor dem Wort', fullEditor);
      const accessWord = 'streng-geheimes-zugangswort-gesperrt';
      await configure(
        form.id,
        { access: true },
        { passwordEnabled: true, password: accessWord },
        fullEditor,
      );

      const { body, text } = await payloadOf(form.slug);

      expect(Object.keys(body).sort()).toEqual(['locked', 'tenant', 'title']);
      expect(body.locked).toBe(true);
      await expectNoSecretOnTheWire(text, { id: form.id, accessWord });
    });

    /** The four verdicts, each from the settings that produce it. */
    it('judges availability without saying what the judgement is based on', async () => {
      const open = await publishedForm('Offen');
      expect((await payloadOf(open.slug)).body).toMatchObject({
        availability: { state: 'open', opensAt: null, closesAt: null },
      });

      const soon = await publishedForm('Noch nicht offen');
      await configure(
        soon.id,
        {},
        { openEnabled: true, openAt: '2099-01-01T00:00:00.000Z' },
      );
      expect((await payloadOf(soon.slug)).body).toMatchObject({
        availability: {
          state: 'not_yet_open',
          opensAt: '2099-01-01T00:00:00.000Z',
          closesAt: null,
        },
      });

      const over = await publishedForm('Geschlossen');
      await configure(
        over.id,
        {},
        { openEnabled: true, closeAt: '2020-01-01T00:00:00.000Z' },
      );
      expect((await payloadOf(over.slug)).body).toMatchObject({
        availability: {
          state: 'closed',
          opensAt: null,
          closesAt: '2020-01-01T00:00:00.000Z',
        },
      });

      const full = await publishedForm('Limit erreicht');
      await configure(
        full.id,
        {},
        { maxResponsesEnabled: true, maxResponses: 1 },
      );
      const submitted = await request(app().server)
        .post(apiPath(`/public/forms/${full.slug}/responses`))
        .send({ answers: { [NAME]: 'Anton' } });
      expect(submitted.status).toBe(200);

      expect((await payloadOf(full.slug)).body).toMatchObject({
        availability: { state: 'limit_reached' },
      });
    });

    /**
     * **The verdict became enforcement later, and this is the test that
     * was written to flip.**
     *
     * It read „still accepts a submission past the limit — enforcement has not been
     * built" until enforcement landed, and it stays here rather than moving into the
     * other suite because what it pins is the *seam*: the verdict a
     * participant is shown (`limit_reached`, asserted right above) and the
     * refusal a submission meets are the same judgement. The concurrent half —
     * twenty submissions against a limit of ten — is in
     * `submission-gate.spec.ts`, where the clock and the addresses can be
     * controlled.
     */
    it('refuses a submission past the limit, and writes no row for it', async () => {
      const full = await publishedForm('Antwortlimit');
      await configure(
        full.id,
        {},
        { maxResponsesEnabled: true, maxResponses: 1 },
      );

      const accepted = await request(app().server)
        .post(apiPath(`/public/forms/${full.slug}/responses`))
        .send({ answers: { [NAME]: 'Anton' } });
      expect(accepted.status).toBe(200);

      const before = await app().prisma.response.count({
        where: { formId: full.id },
      });

      const refused = await request(app().server)
        .post(apiPath(`/public/forms/${full.slug}/responses`))
        .send({ answers: { [NAME]: 'Berthold' } });

      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ reason: 'limit_reached' });
      // Counted, not looked at (a preamble to a later stage).
      expect(
        await app().prisma.response.count({ where: { formId: full.id } }),
      ).toBe(before);
    });

    /** The display flags follow the merge, not the form alone. */
    it('takes the display flags from the tenant standard when the form inherits', async () => {
      const inheriting = await publishedForm('Erbt die Darstellung');
      const own = await publishedForm('Eigene Darstellung');
      await configure(own.id, { display: true }, { showProgress: true });

      await configureTenant({ showProgress: false });

      try {
        expect((await payloadOf(inheriting.slug)).body).toMatchObject({
          display: { showProgress: false },
        });
        // …and the form that took the section over keeps its own answer.
        expect((await payloadOf(own.slug)).body).toMatchObject({
          display: { showProgress: true },
        });
      } finally {
        // Put the organisation back, so a later test in this file is not reading a
        // standard this one happened to leave behind.
        await configureTenant({ showProgress: true });
      }
    });

    /**
     * **Unreadable settings must not take the fill-in page down with them.**
     *
     * The settings schemas are `strictObject`, so a key written by a *newer*
     * deployment is a parse error in an older one — the ordinary state during a
     * rolling deploy, a rollback, or with two replicas of different versions.
     * On this path the settings are incidental (three flags and a verdict), so
     * an unreadable document degrades to „nothing decided" and is logged,
     * exactly as an unparseable snapshot degrades to a logged 404 a few lines
     * up in the same service.
     *
     * The row is written directly, because the API cannot produce it — and
     * that is the point: the writer is a *different version of this API*.
     *
     * **Enforcement must not inherit this.** It reads the same values to *refuse*
     * submissions, and there „unreadable" cannot mean „no deadline, no limit,
     * no password". Enforcement fails closed; display falls back.
     *
     * **What changed later, and why it is not a retreat from the paragraph above.**
     * One of the values on this path stopped being incidental: whether the form
     * is behind the access word decides whether the *questions* are sent. That
     * one question is therefore read strictly and answers „locked" when the
     * document will not parse — otherwise a protected registration would fall
     * open in the minute a rolling deploy wrote a key this replica does not
     * know. Everything the tolerance was built for still holds: the route
     * **answers**, with the organisation and the title, instead of turning every form of
     * that organisation into a 500.
     */
    it('answers locked instead of 500 when the stored settings do not parse', async () => {
      const form = await publishedForm('Zukunftsschlüssel');

      await app().prisma.$executeRawUnsafe(
        `UPDATE "form" SET "settings_override" = jsonb_build_object(
           'overridden', jsonb_build_object(
             'access', false, 'confirm', false, 'display', false
           ),
           'values', jsonb_build_object('einstellungAusM9', true)
         ) WHERE "id" = $1::uuid`,
        form.id,
      );

      const { body } = await payloadOf(form.slug);

      expect(Object.keys(body).sort()).toEqual(['locked', 'tenant', 'title']);
      expect(body.locked).toBe(true);
      // The one thing the fallback still buys: an answer, not a 500.
      expect(body.title).toBe('Zukunftsschlüssel');
    });

    /**
     * The counter-example that keeps the paragraph above honest: a document
     * that parses **is** read tolerantly, and a form without a password is not
     * locked by anything added later.
     *
     * Without it, „locked" could be the answer to every read and the test
     * above would still pass.
     */
    it('does not lock a form that has no access word', async () => {
      const form = await publishedForm('Ohne Zugangswort');

      const { body } = await payloadOf(form.slug);

      expect(body.locked).toBe(false);
      expect(body.definition).toHaveProperty('pages');
    });

    /**
     * **A broken row must not turn the public read route into a log
     * amplifier.**
     *
     * The route above allows 120 requests a minute *per address* and asks for
     * no login, so one unreadable document used to be worth ~240 `error` lines
     * a minute from a single address — scalable across as many addresses as an
     * outsider cares to use, and aimed at the organisation whose row is already broken.
     * The first line carries the whole message; every repetition costs disk and
     * buries everything else.
     *
     * A **fresh form** is broken rather than the shared tenant row, so the
     * count is a statement about this test and not about which tests ran
     * before it.
     */
    it('logs an unreadable document once, not on every public read', async () => {
      const form = await publishedForm('Nur einmal im Protokoll');
      await app().prisma.$executeRawUnsafe(
        `UPDATE "form" SET "settings_override" = jsonb_build_object(
           'values', jsonb_build_object('einstellungAusM9', true)
         ) WHERE "id" = $1::uuid`,
        form.id,
      );

      const written = vi.spyOn(Logger.prototype, 'error');
      try {
        for (let attempt = 0; attempt < 5; attempt += 1) {
          expect((await payloadOf(form.slug)).body).toBeDefined();
        }

        const lines = written.mock.calls
          .map(([first]) => String(first))
          .filter((line) => line.includes(form.id));
        // Once, and the one line still names the form and what is wrong with
        // it — silence would be the other way of getting this wrong.
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('settings_override');
      } finally {
        written.mockRestore();
      }
    });

    /**
     * The same for the organisation's standards — and this is the worse of the two,
     * because one unreadable row would otherwise answer 500 for **every** form
     * of that organisation at once.
     *
     * Now the answer is the **locked** payload rather than the form with
     * system defaults (see „answers locked instead of 500" above for the
     * reasoning). What this test is here for is unchanged and is the whole
     * point: the route *answers*.
     */
    it('still answers when the tenant standards do not parse', async () => {
      const form = await publishedForm('Organisation mit Zukunftsschlüssel');
      const before = await app().prisma.tenant.findUniqueOrThrow({
        where: { id: tenant.id },
        select: { formDefaults: true },
      });

      await app().prisma.$executeRawUnsafe(
        `UPDATE "tenant" SET "form_defaults" =
           jsonb_build_object('einstellungAusM9', true)
         WHERE "id" = $1::uuid`,
        tenant.id,
      );

      try {
        const { body } = await payloadOf(form.slug);
        expect(Object.keys(body).sort()).toEqual(['locked', 'tenant', 'title']);
        expect(body.title).toBe('Organisation mit Zukunftsschlüssel');
      } finally {
        await app().prisma.tenant.update({
          where: { id: tenant.id },
          data: { formDefaults: before.formDefaults ?? {} },
        });
      }
    });

    /**
     * The other half of the requirement: the confirmation texts still arrive with the answer
     * to the submission, under the same two names they were originally given. A later change made them
     * configurable and added exactly one member next to them — it did not move
     * anything.
     */
    it('leaves the answer to a submission at its two fields plus the redirect and the edit link', async () => {
      const form = await publishedForm('Bestätigung');

      const response = await request(app().server)
        .post(apiPath(`/public/forms/${form.slug}/responses`))
        .send({ answers: { [NAME]: 'Anton' } });

      expect(response.status).toBe(200);
      expect(Object.keys(JSON.parse(response.text) as object).sort()).toEqual([
        'confirmationMessage',
        'confirmationTitle',
        // The requirement. The key stands here independently of its value:
        // the *shape* of the answer must not depend on a setting the client
        // is not supposed to be able to infer. Whether it is filled is decided
        // by `allowEdit` — „on" out of the box on this unconfigured form
        // (review finding 16), measured in `shipped-access-defaults.spec.ts`
        // and, switched off, further down.
        'editUrl',
        'redirect',
      ]);
    });

    /**
     * **The measurement that keeps `expectNoSecretOnTheWire` from being
     * decoration.**
     *
     * A search that cannot fail is not evidence, and the three searches this
     * suite started with could not: the values are sealed in their columns, so
     * even a payload that shipped the whole `tenant` row would have carried
     * ciphertext past a plaintext search. That is a lesson learned before („eine Fixture,
     * die sich selbst repariert") in its other shape — an assertion that
     * repairs itself.
     *
     * So the leak is staged. `bySlug` is wrapped for one request and the
     * `tenant.smtp` column is smuggled into the payload it returns — the
     * cheapest realistic mistake there is, and the exact shape of it: somebody
     * adds a field and hands it a row instead of a projection. The staged
     * answer must make the guard **throw**.
     *
     * The wrapper is a spy on the prototype, not a change to the service: the
     * application under test is the real one for every other test in this file,
     * and this one puts the fault back the moment it has been measured.
     */
    it('sees the sealed secret when a field carries the column into the payload', async () => {
      const form = await publishedForm('Geschmuggelte Spalte', fullEditor);
      const accessWord = 'streng-geheimes-zugangswort-schmuggel';
      await configure(
        form.id,
        { access: true },
        { passwordEnabled: true, password: accessWord },
        fullEditor,
      );

      const row = await app().prisma.tenant.findUniqueOrThrow({
        where: { id: fullTenant.id },
        select: { smtp: true },
      });
      // The one instance the controller holds, bound before it is replaced —
      // so the wrapper still calls the real reading and this suite is not
      // measuring a stub of its own making.
      const service = app().app.get(PublicFormsService);
      const honest = service.bySlug.bind(service);
      const leaking = vi
        .spyOn(service, 'bySlug')
        .mockImplementation(
          async (slug, proof): Promise<PublicFormReadPayload> =>
            Object.assign({}, await honest(slug, proof), { smtp: row.smtp }),
        );

      try {
        const { text } = await payloadOf(form.slug);
        // The staged leak is on the wire…
        expect(text).toContain('"smtp"');
        // …and the plaintext search — the one this suite started with — is
        // still green through it. That is the finding, not a side note.
        expect(text).not.toContain(A8_SMTP_PASSWORD);
        // …while the sealed bytes *are* there, named rather than left to the
        // guard below: this is the line that says which of the guard's checks
        // the rejection comes from.
        const sealedSmtpPassword = z
          .object({ auth: z.object({ password: z.string().min(1) }) })
          .parse(row.smtp).auth.password;
        expect(text).toContain(sealedSmtpPassword);
        // …while the search over the sealed bytes fails, which is the whole
        // claim. Asserted as a rejection rather than by catching, so a guard
        // that stopped asserting anything at all would not pass as „threw".
        await expect(
          expectNoSecretOnTheWire(text, { id: form.id, accessWord }),
        ).rejects.toThrow();
      } finally {
        leaking.mockRestore();
      }

      // And the same form, read through the real service again, is clean —
      // otherwise the assertion above could be about a broken spy rather than
      // about the payload.
      const honestRead = await payloadOf(form.slug);
      expect(honestRead.text).not.toContain('"smtp"');
      await expectNoSecretOnTheWire(honestRead.text, {
        id: form.id,
        accessWord,
      });
    });
  });

  /**
   * The requirement — the confirmation page comes out of the effective
   * settings, and the redirect target is checked **on the way out**.
   */
  describe('Bestätigung und Weiterleitung (effektive Einstellungen)', () => {
    /** Publishes a form and returns its id and public address. */
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

    /** Writes a form's settings through the real route. */
    async function configure(
      formId: string,
      overridden: Record<string, boolean>,
      values: Record<string, unknown>,
    ): Promise<request.Response> {
      const form = await app().prisma.form.findUniqueOrThrow({
        where: { id: formId },
        select: { settingsRevision: true, tenantId: true },
      });
      const tenantRow = await app().prisma.tenant.findUniqueOrThrow({
        where: { id: form.tenantId },
        select: { formDefaultsRevision: true },
      });

      return request(app().server)
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
    }

    /** Submits one valid answer and returns the parsed confirmation. */
    async function submitOnce(slug: string): Promise<Record<string, unknown>> {
      const response = await request(app().server)
        .post(apiPath(`/public/forms/${slug}/responses`))
        .send({ answers: { [NAME]: 'Anton' } });
      expect(response.status).toBe(200);
      return JSON.parse(response.text) as Record<string, unknown>;
    }

    it('answers with the configured texts instead of the built-in constants', async () => {
      const form = await publishedForm('Eigene Bestätigung');
      const written = await configure(
        form.id,
        // *Zugriff & Sicherheit* taken over as well, and solely in order to
        // **switch off** „Bearbeiten nach Absenden": the application's default
        // has been „on" since review finding 16, and without this line the
        // case would no longer answer the question it asks (the link is
        // withheld although the row carries a token).
        { confirm: true, access: true },
        {
          confirmTitle: 'Danke, Mitglied',
          confirmMsg: 'Die Anmeldung ist beim Organisationsbüro eingegangen.',
          allowEdit: false,
        },
      );
      expect(written.status).toBe(200);

      expect(await submitOnce(form.slug)).toEqual({
        confirmationTitle: 'Danke, Mitglied',
        confirmationMessage:
          'Die Anmeldung ist beim Organisationsbüro eingegangen.',
        redirect: null,
        // „Bearbeiten nach Absenden" is off for this form, so the link is
        // withheld — although the token stands on the row.
        editUrl: null,
      });
    });

    it('carries the redirect and its delay when one is configured', async () => {
      const form = await publishedForm('Mit Weiterleitung');
      const written = await configure(
        form.id,
        { confirm: true },
        {
          redirectEnabled: true,
          redirectUrl: 'https://beispiel.invalid/danke',
          redirectDelay: 7,
        },
      );
      expect(written.status).toBe(200);

      expect((await submitOnce(form.slug)).redirect).toEqual({
        url: 'https://beispiel.invalid/danke',
        delaySec: 7,
      });
    });

    it('carries no redirect while the switch is off, target or not', async () => {
      const form = await publishedForm('Ziel ohne Schalter');
      const written = await configure(
        form.id,
        { confirm: true },
        { redirectEnabled: false, redirectUrl: 'https://beispiel.invalid/aus' },
      );
      expect(written.status).toBe(200);

      const confirmation = await submitOnce(form.slug);
      expect(confirmation.redirect).toBeNull();
      // …and the target the editor kept is not mentioned either. It is a
      // configured value on a page strangers open, and „aus" has to mean gone.
      expect(JSON.stringify(confirmation)).not.toContain('beispiel.invalid');
    });

    /**
     * **The test that counts** (second half).
     *
     * The refusal *at the door* — a `PUT` with a `javascript:` target answering
     * 400 — is covered next door in `test/settings/form-settings.spec.ts`. It
     * proves the door and nothing else. This one writes the value the way an
     * attacker would have to get it in at all: **straight into the column**,
     * past the API, past every schema the write path runs. Nothing but the read
     * path stands between it and a stranger's browser.
     *
     * **Two gates stand there, and each has its own test elsewhere**, because
     * neither can be shown from here alone:
     *
     * 1. `externalUrlSchema` refuses the value while the document is *parsed*,
     *    so the row does not become a `FormSettings` at all. Removing it turns
     *    the last assertion below red — the texts stop falling back — and turns
     *    `packages/shared/src/form-settings.test.ts` red where it parses a
     *    stored document directly.
     * 2. `effectiveRedirect` refuses it again while the value is *handed out*.
     *    Removing that one alone leaves this test green, because gate 1 has
     *    already refused the document; it is covered by its own unit tests in
     *    `form-settings.test.ts` („refuses to hand out a … target"), which are
     *    built on a `FormSettings` value rather than a stored document — the
     *    one state a schema cannot vouch for.
     *
     * Removing **both** turns this test red on the `javascript:` assertion,
     * which is what it is here for.
     *
     * **What the answer is changed with enforcement, and the change is the point.**
     * A review saw a confirmation here: the *display* path degrades an unreadable
     * settings document to the system defaults, so the standard texts arrived
     * without a target. Enforcement does not degrade — it **fails closed**
     * (`settings/settings-enforcement.ts`), and a document that does not parse
     * is a document nothing may be decided from, deadline and response limit
     * included. So the submission is refused with 503 and no row is written.
     *
     * The gates are still told apart, and by a sharper signal than before:
     *
     * - remove gate 1 → the document parses → the submission is **accepted**
     *   (200, with the stored title „Gleich geht es weiter"), and this test goes
     *   red on the status;
     * - remove gate 2 only → gate 1 still refuses the document → 503, green,
     *   exactly as recorded before; its own unit tests in `form-settings.test.ts`
     *   cover it;
     * - remove both → 200 with a `javascript:` target on the wire → red twice.
     */
    it('does not hand out a javascript: target written straight into the database', async () => {
      const form = await publishedForm('Gespeichertes XSS');

      await app().prisma.$executeRawUnsafe(
        `UPDATE "form" SET "settings_override" = jsonb_build_object(
           'overridden', jsonb_build_object(
             'access', false, 'confirm', true, 'display', false
           ),
           'values', jsonb_build_object(
             'redirectEnabled', true,
             'redirectUrl', 'javascript:alert(document.cookie)',
             'redirectDelay', 0,
             'confirmTitle', 'Gleich geht es weiter',
             'confirmMsg', 'Bitte warten.'
           )
         ) WHERE "id" = $1::uuid`,
        form.id,
      );

      const before = await app().prisma.response.count();

      const response = await request(app().server)
        .post(apiPath(`/public/forms/${form.slug}/responses`))
        .send({ answers: { [NAME]: 'Anton' } });

      // Fail closed: the settings cannot be read, so nothing is decided from
      // them and nothing is stored.
      expect(response.status).toBe(503);
      expect(await app().prisma.response.count()).toBe(before);
      // Not „nowhere in the redirect member" — nowhere in the answer at all.
      // A value nested in a text would pass a member check and fail this one.
      expect(response.text).not.toContain('javascript:');
      // …and the title stored next to the bad URL does not travel either. Its
      // presence would mean the document had been read after all.
      expect(response.text).not.toContain('Gleich geht es weiter');

      // The *display* path still works, unchanged — the two readings are
      // different on purpose, and this is the line that says so.
      const shown = await request(app().server).get(
        apiPath(`/public/forms/${form.slug}`),
      );
      expect(shown.status).toBe(200);
    });

    /** The same, one level up: the organisation's standards row. */
    it('does not hand out a javascript: target written into the tenant standards', async () => {
      const form = await publishedForm('Organisation mit gespeichertem XSS');
      const before = await app().prisma.tenant.findUniqueOrThrow({
        where: { id: tenant.id },
        select: { formDefaults: true },
      });

      await app().prisma.$executeRawUnsafe(
        `UPDATE "tenant" SET "form_defaults" = jsonb_build_object(
           'redirectEnabled', true,
           'redirectUrl', 'javascript:alert(document.cookie)',
           'redirectDelay', 0,
           'confirmTitle', 'Gleich geht es weiter'
         ) WHERE "id" = $1::uuid`,
        tenant.id,
      );

      try {
        const before = await app().prisma.response.count();

        const response = await request(app().server)
          .post(apiPath(`/public/forms/${form.slug}/responses`))
          .send({ answers: { [NAME]: 'Anton' } });

        // Same reasoning as the form-level case one level up — and here the
        // unreadable row is the organisation's, so it refuses every form of that organisation.
        expect(response.status).toBe(503);
        expect(await app().prisma.response.count()).toBe(before);
        expect(response.text).not.toContain('javascript:');
        expect(response.text).not.toContain('Gleich geht es weiter');

        const shown = await request(app().server).get(
          apiPath(`/public/forms/${form.slug}`),
        );
        expect(shown.status).toBe(200);
      } finally {
        await app().prisma.tenant.update({
          where: { id: tenant.id },
          data: { formDefaults: before.formDefaults ?? {} },
        });
      }
    });
  });

  /**
   * The requirement — „die Vorschau erzeugt nichts".
   *
   * **What „die Vorschau" is today has to be said out loud, because the
   * requirement names something that does not exist yet.** It points at the
   * handoff's stand-alone test mode with the red „● Testmodus" banner, and that
   * view is not yet built (Konzept no. 28). What an
   * editor has *now* are two previews, and both are client-side renderings of
   * data they already hold:
   *
   * - the builder's live question preview (`apps/web/src/builder/QuestionPreview.tsx`),
   * - the confirmation preview on the settings page (`ConfirmationPreview.tsx`).
   *
   * Neither has a submit path — the only route that writes a `response` row is
   * `POST /public/forms/:slug/responses`, and no preview surface calls it. So
   * the honest proof is not „the preview did not submit" (there is nothing to
   * stop) but the stronger, structural one below: **every route a preview
   * touches is read-only.** Walk the whole editor-side preview round, count
   * before and after.
   *
   * **`mail_log` is counted too,.** The table used to belong to
   * a later package and this half of the requirement pointed at a later stage for its own
   * evidence — the open end nobody collects. That migration was pulled
   * forward (the specification) precisely so that the
   * second counter below is a real one. Nothing writes to the table yet, which
   * is what makes the assertion cheap today and load-bearing the day the mail
   * worker adds the enqueue: a preview that ever reaches it turns this red.
   *
   * The test-mode view still has to arrive with its own proof — it will be
   * the first surface that *could* produce something.
   */
  describe('die Vorschau erzeugt nichts', () => {
    it('leaves the answer and mail-log counts untouched across a full preview round', async () => {
      const created = await request(app().server)
        .post(apiPath('/forms'))
        .set(authedMutation(editor))
        .send({ title: 'Vorschau' });
      const form = created.body as {
        id: string;
        revision: number;
        publicSlug: string;
      };
      const saved = await request(app().server)
        .put(apiPath(`/forms/${form.id}`))
        .set(authedMutation(editor))
        .send({
          title: 'Vorschau',
          definition: definition(),
          revision: form.revision,
        });
      await request(app().server)
        .post(apiPath(`/forms/${form.id}/publish`))
        .set(authedMutation(editor))
        .send({ revision: (saved.body as { revision: number }).revision });

      const before = await app().prisma.response.count();
      // The second counter the requirement asks for — „löst keine Mail aus".
      const mailsBefore = await app().prisma.mailLog.count();

      // Everything the two preview surfaces read, in the order an editor
      // produces it: the draft the builder renders, the settings the
      // confirmation preview follows, the organisation's standards behind them, and
      // the public payload the participant would get.
      for (const path of [
        `/forms/${form.id}`,
        `/forms/${form.id}/settings`,
        '/tenant/form-defaults',
      ]) {
        const response = await request(app().server)
          .get(apiPath(path))
          .set('Cookie', cookieHeader(editor));
        expect(response.status).toBe(200);
      }
      const publicRead = await request(app().server).get(
        apiPath(`/public/forms/${form.publicSlug}`),
      );
      expect(publicRead.status).toBe(200);

      expect(await app().prisma.response.count()).toBe(before);
      // …and nothing was written against this form in particular either — a
      // global count could hide a row if another test deleted one meanwhile.
      expect(
        await app().prisma.response.count({ where: { formId: form.id } }),
      ).toBe(0);

      expect(await app().prisma.mailLog.count()).toBe(mailsBefore);
      expect(
        await app().prisma.mailLog.count({ where: { formId: form.id } }),
      ).toBe(0);
    });

    /**
     * The other half of the requirement's preview sentence: „zeigt dieselben effektiven
     * Einstellungen". What the editor's surfaces render comes from
     * `effective` on the settings route; what the participant gets comes from
     * `display` on the public payload. Both are `effectiveSettings()`, and this
     * is the assertion that they have not become two answers.
     */
    it('shows the editor the same effective display flags a participant gets', async () => {
      const created = await request(app().server)
        .post(apiPath('/forms'))
        .set(authedMutation(editor))
        .send({ title: 'Gleiche Sicht' });
      const form = created.body as {
        id: string;
        revision: number;
        publicSlug: string;
      };
      const saved = await request(app().server)
        .put(apiPath(`/forms/${form.id}`))
        .set(authedMutation(editor))
        .send({
          title: 'Gleiche Sicht',
          definition: definition(),
          revision: form.revision,
        });
      await request(app().server)
        .post(apiPath(`/forms/${form.id}/publish`))
        .set(authedMutation(editor))
        .send({ revision: (saved.body as { revision: number }).revision });

      const row = await app().prisma.form.findUniqueOrThrow({
        where: { id: form.id },
        select: { settingsRevision: true },
      });
      const tenantRow = await app().prisma.tenant.findUniqueOrThrow({
        where: { id: tenant.id },
        select: { formDefaultsRevision: true },
      });
      const written = await request(app().server)
        .put(apiPath(`/forms/${form.id}/settings`))
        .set(authedMutation(editor))
        .send({
          overridden: {
            access: false,
            confirm: false,
            display: true,
            budget: false,
          },
          values: {
            showProgress: false,
            showPageNumbers: true,
            showRequiredHint: false,
          },
          revision: row.settingsRevision,
          tenantRevision: tenantRow.formDefaultsRevision,
        });
      expect(written.status).toBe(200);

      const editorView = await request(app().server)
        .get(apiPath(`/forms/${form.id}/settings`))
        .set('Cookie', cookieHeader(editor));
      expect(editorView.status).toBe(200);
      const effective = (
        editorView.body as { effective: Record<string, unknown> }
      ).effective;

      const participantView = await request(app().server).get(
        apiPath(`/public/forms/${form.publicSlug}`),
      );
      expect(participantView.status).toBe(200);
      const display = (participantView.body as { display: unknown }).display;

      expect(display).toEqual({
        showProgress: effective.showProgress,
        showPageNumbers: effective.showPageNumbers,
        showRequiredHint: effective.showRequiredHint,
      });
      // Spelled out as well, so the assertion above cannot pass by both sides
      // being wrong in the same way.
      expect(display).toEqual({
        showProgress: false,
        showPageNumbers: true,
        showRequiredHint: false,
      });
    });
  });

  describe('hardening', () => {
    /**
     * The payload limit is the JSON parser's, not a check of ours — which is
     * the point: an oversized body is refused **before** any handler runs, so
     * it costs a parse and nothing else.
     */
    it('refuses an oversized payload with 413 and creates nothing', async () => {
      const before = await app().prisma.response.count();

      const response = await request(app().server)
        .post(apiPath(`/public/forms/${publishedSlug}/responses`))
        .set('Content-Type', 'application/json')
        .send(
          JSON.stringify({
            answers: { [NAME]: 'x'.repeat(JSON_BODY_LIMIT_BYTES + 1_000) },
          }),
        );

      expect(response.status).toBe(413);
      expect(await app().prisma.response.count()).toBe(before);
    });

    /**
     * The rate limit, driven to its edge — and the **last test of the file**,
     * which is not a stylistic choice: the tracker is the caller's address,
     * every test here comes from the same loopback address, and this one
     * empties the bucket for a minute. Anything after it would fail for a
     * reason that is not its own. Found the hard way when the CSRF test that
     * used to follow it started reporting 429.
     */
    it('refuses submissions past the limit with 429', async () => {
      const slug = await createForm('Rate-Limit', true);
      let lastStatus = 0;

      for (
        let attempt = 0;
        attempt <= PUBLIC_SUBMIT_RATE_LIMIT.limit;
        attempt += 1
      ) {
        const response = await request(app().server)
          .post(apiPath(`/public/forms/${slug}/responses`))
          .send({ answers: { [NAME]: `Anton ${String(attempt)}` } });
        lastStatus = response.status;
      }

      expect(lastStatus).toBe(429);

      /*
       * And the bucket cannot be escaped by claiming another address.
       *
       * `TRUST_PROXY_HOPS` is 0 in the test application, so `X-Forwarded-For`
       * is a caller-controlled string that must change nothing — otherwise the
       * limit is no limit at all, because the thirty-first submission simply
       * invents a new sender. The setting is application-wide
       * (`app.set('trust proxy', …)` in `app-setup.ts`), and * for the public route to follow the same rule as the login; this is
       * that rule, asserted on this route rather than inferred from the other.
       */
      const spoofed = await request(app().server)
        .post(apiPath(`/public/forms/${slug}/responses`))
        // Documentation range (RFC 5737) — never a real caller.
        .set('X-Forwarded-For', '203.0.113.42')
        .send({ answers: { [NAME]: 'Mit fremder Adresse' } });

      expect(spoofed.status).toBe(429);
    });
  });
});
