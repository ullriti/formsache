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
import {
  createTenant,
  createUser,
  type TenantFixture,
} from '../support/fixtures';
import { authedMutation, openSession } from '../support/http';

/**
 * **The three question types no integration test guarded** (a review finding,
 * 2026-07-31): `info`, `rating` and `address` appeared in not a
 * single API assertion, although their requirements demand precisely these
 * proofs — and all three lie on the **public**, unprotected
 * route, where „the client does not even ask for it" proves nothing. The proofs themselves were reproduced and held; what was unguarded was
 * that they still hold tomorrow.
 *
 * Every case goes past the client straight to the API, without a session
 * cookie, and each additionally checks that **nothing** was written: a 400 with
 * a row in the database would be the worse error.
 *
 * **A file of its own and not a `describe` in `public-forms.spec.ts`**, for a
 * measured reason: the submit route allows 30 requests per minute and
 * address (`PUBLIC_SUBMIT_RATE_LIMIT`), that file already exhausts this
 * budget, and the eight submissions here would let seven of its cases fail
 * with 429 instead of the expected answer. The budget is part of the
 * fixture, not scenery.
 */

const PASSWORD = 'test-password';

const TYPES_PAGE = '019ff100-0000-7000-8000-0000000000d0';
const NOTICE = '019ff100-0000-7000-8000-0000000000d1';
const RATING = '019ff100-0000-7000-8000-0000000000d2';
const ADDRESS = '019ff100-0000-7000-8000-0000000000d3';

function typesDefinition() {
  return {
    pages: [
      {
        id: TYPES_PAGE,
        title: 'Anmeldung',
        description: null,
        questions: [
          {
            id: NOTICE,
            type: 'info',
            label: 'Bitte pünktlich erscheinen.',
            hint: 'Einlass ab 9 Uhr.',
            required: false,
            width: 'full',
          },
          {
            id: RATING,
            type: 'rating',
            label: 'Wie war der Jahrestagung?',
            hint: null,
            required: false,
            width: 'full',
            max: 5,
          },
          {
            id: ADDRESS,
            type: 'address',
            label: 'Anschrift',
            hint: null,
            // **Required**, because the proof hangs on exactly that: the
            // partly filled required address has to fail per field, not just
            // as a whole.
            required: true,
            width: 'full',
          },
        ],
      },
    ],
  };
}

const FULL_ADDRESS = {
  street: 'Hauptstraße 1',
  zip: '01067',
  city: 'Dresden',
  country: 'Deutschland',
};

describe('Infotext, Bewertung und Adresse auf der öffentlichen Route', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  let tenant: TenantFixture;
  let editor: string;
  let typesSlug: string;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });

    tenant = await createTenant(testApp.prisma, 'TYP');
    const user = await createUser(testApp.prisma, {
      email: 'editor@example.org',
      password: PASSWORD,
      tenants: [tenant],
    });
    editor = await openSession(testApp, user.id, tenant.id);

    const created = await request(app().server)
      .post(apiPath('/forms'))
      .set(authedMutation(editor))
      .send({ title: 'Fragetypen' });
    const form = created.body as {
      id: string;
      revision: number;
      publicSlug: string;
    };
    const saved = await request(app().server)
      .put(apiPath(`/forms/${form.id}`))
      .set(authedMutation(editor))
      .send({
        title: 'Fragetypen',
        definition: typesDefinition(),
        revision: form.revision,
      });
    expect(saved.status).toBe(200);
    const published = await request(app().server)
      .post(apiPath(`/forms/${form.id}/publish`))
      .set(authedMutation(editor))
      .send({ revision: (saved.body as { revision: number }).revision });
    expect(published.status).toBe(200);
    typesSlug = form.publicSlug;
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  async function submitTypes(
    answers: Record<string, unknown>,
  ): Promise<request.Response> {
    return request(app().server)
      .post(apiPath(`/public/forms/${typesSlug}/responses`))
      .send({ answers });
  }

  /** The issues of a 400, in the shape the route publishes them. */
  function pathsOf(response: request.Response): string[] {
    const body = response.body as { issues?: { path: string }[] };
    return (body.issues ?? []).map((issue) => issue.path);
  }

  /**
   * The requirement, the evidence — **an Infotext has no answer**, and a value
   * sent for it is an *unknown* field rather than something quietly dropped.
   * `buildAnswersSchema` gives it no key at all, and `.strict()` does the rest;
   * without that decision the callout would end up in the JSONB column and
   * reappear as a column nobody defined.
   */
  it('refuses an answer to an Infotext and stores nothing', async () => {
    const before = await app().prisma.response.count();

    const response = await submitTypes({
      [NOTICE]: 'Habe ich gelesen',
      [ADDRESS]: FULL_ADDRESS,
    });

    expect(response.status).toBe(400);
    expect(response.text).toContain(NOTICE);
    expect(await app().prisma.response.count()).toBe(before);
  });

  /**
   * The requirement — the star count is bounded by **this question's** `max`,
   * and it is a whole number. `0` is not something the control can produce
   * (`FieldInput.tsx` only ever sends `i + 1`), which is exactly why it is
   * submitted here: the rule has to hold against a payload that never touched
   * the control.
   */
  it.each([
    ['6 Sterne bei Höchstwert 5', 6],
    ['0 Sterne', 0],
    ['halbe Sterne', 2.5],
  ])('refuses %s and stores nothing', async (_name, stars) => {
    const before = await app().prisma.response.count();

    const response = await submitTypes({
      [RATING]: stars,
      [ADDRESS]: FULL_ADDRESS,
    });

    expect(response.status).toBe(400);
    expect(pathsOf(response)).toContain(RATING);
    expect(await app().prisma.response.count()).toBe(before);
  });

  it('names the question’s own maximum in the message', async () => {
    const response = await submitTypes({
      [RATING]: 6,
      [ADDRESS]: FULL_ADDRESS,
    });

    // The wording of the message, read from the question rather than from a constant:
    // two versions of one question may carry different maxima.
    expect(response.text).toContain('Höchstens 5 Sterne.');
  });

  /**
   * The requirement, the evidence — a **partly filled required address** fails per
   * subfield, not as one coarse „Pflichtfeld". The paths are what the fill-in
   * view marks the empty boxes by; without them a participant sees a red card
   * and no red field.
   */
  it('refuses a partly filled required address, naming the empty subfields', async () => {
    const before = await app().prisma.response.count();

    const response = await submitTypes({
      [ADDRESS]: {
        street: 'Hauptstraße 1',
        zip: '',
        city: '',
        country: 'Deutschland',
      },
    });

    expect(response.status).toBe(400);
    const paths = pathsOf(response);
    expect(paths).toContain(`${ADDRESS}.zip`);
    expect(paths).toContain(`${ADDRESS}.city`);
    // The street is filled in and must **not** be reported — otherwise the
    // message would read „something about the address", with four red fields.
    expect(paths).not.toContain(`${ADDRESS}.street`);
    // Country is never required (default „Deutschland", overridable).
    expect(paths).not.toContain(`${ADDRESS}.country`);
    expect(await app().prisma.response.count()).toBe(before);
  });

  it('refuses an entirely untouched required address as Pflichtfeld', async () => {
    const response = await submitTypes({});

    expect(response.status).toBe(400);
    expect(pathsOf(response)).toContain(ADDRESS);
  });

  /**
   * **What a stranger may write into the JSONB column *in addition*: nothing**
   * — the reverse side of a review finding, and the reason why
   * `toStoredAnswers` still names the keys per form instead of simply
   * deep-copying the value.
   *
   * Measured on 2026-07-31: `buildAnswersSchema` checks a **required** answer
   * with `z.unknown().superRefine(…)`, and that returns its **raw value**,
   * not the parsed result — proved against this project's Zod version.
   * The address here is required, which is why the `evil` field survives
   * validation and is only stripped off when writing. If the enumeration there
   * fell away, it would stand in the column and come back out in the export as
   * a key nobody has defined.
   */
  it('stores no key of a required answer that the schema does not name', async () => {
    const response = await submitTypes({
      [ADDRESS]: { ...FULL_ADDRESS, evil: '<script>' },
    });

    expect(response.status).toBe(200);

    const stored = await app().prisma.response.findFirst({
      orderBy: { submittedAt: 'desc' },
    });
    expect(stored?.answers).toStrictEqual({ [ADDRESS]: FULL_ADDRESS });
  });

  /**
   * The accepting half, and the one that says what actually lands in JSONB:
   * four subfields as themselves, the star count as a number — no composed
   * address string, nothing coerced, and no key for the Infotext.
   */
  it('stores an address as its four subfields and a rating as a number', async () => {
    const response = await submitTypes({
      [RATING]: 5,
      [ADDRESS]: FULL_ADDRESS,
    });

    expect(response.status).toBe(200);

    const stored = await app().prisma.response.findFirst({
      orderBy: { submittedAt: 'desc' },
    });
    expect(stored?.answers).toStrictEqual({
      [RATING]: 5,
      [ADDRESS]: FULL_ADDRESS,
    });
  });
});
