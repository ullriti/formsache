import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TABLE_ROW_LIMIT_CODE } from '@formsache/shared';

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
 * **The upper bound of the extendable table, at the public path**
 * (Konzept no. 76).
 *
 * Every case here speaks **directly to the route**, past any browser. That is
 * the whole claim of the requirement: „+ Zeile" is a control the fill-in view
 * draws, and nothing forces a stranger to use it — a bound that only the client
 * applied would be no bound at all. The three write paths are all here, because
 * a second write path does not inherit the first one's filter:
 * the **submission**, the **correction** over the edit token and the
 * **draft**, which knows neither deadline nor response limit and is therefore
 * the cheapest way.
 *
 * ## Why the mail row is counted along
 *
 * The refusal has to sit **inside** the chain of `submit()`, in front of the
 * transaction that queues the notifications — a refusal behind the enqueue
 * sends „Ihre Anmeldung ist eingegangen" for a submission that was thrown away,
 * and that is the one mistake in this application nothing can take back. Two
 * counts make that measurable rather than merely stated: the accepted
 * submission of the same form queues **one** row, so the zero after the refused
 * one says "not queued" instead of "nothing is ever queued here anyway".
 *
 * *Reproductions (all three run on 2026-08-06):*
 * moving the answer validation behind `storeWithinLimit` makes „queues no mail"
 * red; enforcing the bound only in the fill-in view makes every case here red,
 * because none of them uses one; leaving the draft path out makes the two
 * draft cases red.
 */

const PASSWORD = 'test-password';
const PAGE = '019ff700-0000-7000-8000-0000000000a0';
const MAIL = '019ff700-0000-7000-8000-000000000001';
const GUESTS = '019ff700-0000-7000-8000-000000000002';

/** Start rows 2, upper bound 5 — „bis zu fünf Begleitpersonen". */
const START_ROWS = 2;
const MAX_ROWS = 5;

function definition(): unknown {
  return {
    pages: [
      {
        id: PAGE,
        title: 'Anmeldung',
        questions: [
          {
            id: MAIL,
            type: 'email',
            label: 'E-Mail',
            hint: null,
            required: false,
            width: 'full',
          },
          {
            id: GUESTS,
            type: 'table',
            label: 'Begleitpersonen',
            hint: null,
            required: false,
            width: 'full',
            rows: START_ROWS,
            addRows: { maxRows: MAX_ROWS },
            columns: [{ key: 'name', label: 'Name', type: 'text' }],
          },
        ],
      },
    ],
  };
}

/** `count` filled rows — what the fill-in view sends after „+ Zeile". */
function guests(count: number): Record<string, unknown> {
  return {
    [MAIL]: 'anton@example.org',
    [GUESTS]: {
      cells: Array.from({ length: count }, (_, index) => ({
        name: `Person ${String(index + 1)}`,
      })),
    },
  };
}

/** The same, untouched — a **blank** answer of `count` rows. */
function emptyGuests(count: number): Record<string, unknown> {
  return {
    [GUESTS]: { cells: Array.from({ length: count }, () => ({})) },
  };
}

/** Documentation range (RFC 5737) — never a real caller. */
let nextAddress = 0;
function ownAddress(): string {
  nextAddress += 1;
  return `198.51.100.${String((nextAddress % 250) + 1)}`;
}

describe('die Obergrenze der Tabellenzeilen ', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  let tenant: TenantFixture;
  let editor: string;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({
      databaseUrl: database.url,
      // An address of its own per request: the public routes allow 30 a minute
      // per address, and this file sends more than that. The limit itself is
      // covered in `public-forms.spec.ts`.
      env: { TRUST_PROXY_HOPS: 1 },
      // The edit address and the draft address are built from this, and a
      // suite without it gets `editUrl: null` and no draft address.
      systemMail: { publicBaseUrl: TEST_PUBLIC_BASE_URL },
    });

    tenant = await createTenant(testApp.prisma, 'ROWS');
    const user = await createUser(testApp.prisma, {
      email: 'editor@example.org',
      password: PASSWORD,
      tenants: [tenant],
    });
    editor = await openSession(testApp, user.id, tenant.id);
  }, 180_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  afterEach(async () => {
    await app().prisma.mailLog.deleteMany();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Fixtures, through the real routes
  // ═══════════════════════════════════════════════════════════════════════

  interface Form {
    readonly id: string;
    readonly slug: string;
  }

  async function publishedForm(title: string): Promise<Form> {
    const created = await request(app().server)
      .post(apiPath('/forms'))
      .set(authedMutation(editor))
      .send({ title });
    expect(created.status).toBe(201);
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

  /** An **active** confirmation to the participant — the fixture of the evidence. */
  async function addNotification(formId: string): Promise<void> {
    const created = await request(app().server)
      .post(apiPath(`/forms/${formId}/notifications`))
      .set(authedMutation(editor))
      .send({
        replyTo: null,
        name: 'Bestätigung',
        subject: 'Anmeldung eingegangen',
        body: 'Danke.',
        recipients: [{ kind: 'question', questionId: MAIL }],
      });
    expect(created.status).toBe(201);
  }

  function submit(
    slug: string,
    answers: Record<string, unknown>,
  ): Promise<request.Response> {
    return request(app().server)
      .post(apiPath(`/public/forms/${slug}/responses`))
      .set('X-Forwarded-For', ownAddress())
      .send({ answers });
  }

  function saveDraft(
    slug: string,
    answers: Record<string, unknown>,
  ): Promise<request.Response> {
    return request(app().server)
      .post(apiPath(`/public/forms/${slug}/drafts`))
      .set('X-Forwarded-For', ownAddress())
      .send({ answers });
  }

  function writeDraft(
    token: string,
    answers: Record<string, unknown>,
  ): Promise<request.Response> {
    return request(app().server)
      .put(apiPath(`/public/drafts/${token}`))
      .set('X-Forwarded-For', ownAddress())
      .send({ answers });
  }

  function writeEdit(
    token: string,
    answers: Record<string, unknown>,
  ): Promise<request.Response> {
    return request(app().server)
      .put(apiPath(`/public/responses/${token}`))
      .set('X-Forwarded-For', ownAddress())
      .send({ answers });
  }

  function responseCount(formId: string): Promise<number> {
    return app().prisma.response.count({ where: { formId } });
  }

  function mailCount(formId: string): Promise<number> {
    return app().prisma.mailLog.count({ where: { formId } });
  }

  function draftCount(formId: string): Promise<number> {
    return app().prisma.responseDraft.count({ where: { formId } });
  }

  /**
   * The 400 as a caller sees it: the status, the **field** and the
   * **machine-readable rule** — never the German sentence alone, which is the
   * one part of the body that may be reworded without anything breaking.
   */
  function expectRowLimitRefusal(response: request.Response): void {
    expect(response.status).toBe(400);
    const body = response.body as {
      issues?: { path: string; message: string; code?: string }[];
    };
    const issue = body.issues?.find(
      (entry) => entry.path === `${GUESTS}.cells`,
    );
    expect(issue).toBeDefined();
    expect(issue?.code).toBe(TABLE_ROW_LIMIT_CODE);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // the proof — the submission
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * The rows the form **invited** are accepted, the row past the upper bound is
   * not — asserted in one case, because a test that only shows the refusal
   * would be equally green if the route refused every table.
   */
  it('accepts the added rows and refuses the one past the Obergrenze', async () => {
    const form = await publishedForm('Anmeldung mit Begleitung');

    const grown = await submit(form.slug, guests(MAX_ROWS));
    expect(grown.status).toBe(200);

    const before = await responseCount(form.id);
    expectRowLimitRefusal(await submit(form.slug, guests(MAX_ROWS + 1)));
    expect(await responseCount(form.id)).toBe(before);
  });

  /**
   * **An empty row is a row too.** The cheapest payload of all: a
   * thousand rows that say nothing. Until this requirement existed it went through on every path,
   * because a blank answer never reaches the schema the bound used to live in.
   */
  it('refuses a flood of empty rows', async () => {
    const form = await publishedForm('Leere Zeilen');

    const before = await responseCount(form.id);
    expectRowLimitRefusal(await submit(form.slug, emptyGuests(1000)));
    expect(await responseCount(form.id)).toBe(before);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // the proof — the bound lies **inside** the chain
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * **The refused submission queued nothing** — and the accepted one
   * before it proves that this form would have. Without that first half the
   * assertion "no `mail_log` row" would be green on a form that never
   * queues anything, which is exactly the shape of the finding this
   * requirement was written against.
   */
  it('queues no mail for a submission it refuses', async () => {
    const form = await publishedForm('Bestätigung und Grenze');
    await addNotification(form.id);
    await configure(form.id, { confirm: true }, {});

    const accepted = await submit(form.slug, guests(START_ROWS));
    expect(accepted.status).toBe(200);
    expect(await mailCount(form.id)).toBe(1);

    expectRowLimitRefusal(await submit(form.slug, guests(MAX_ROWS + 1)));
    // Unchanged — the refused submission added none of its own.
    expect(await mailCount(form.id)).toBe(1);
    expect(await responseCount(form.id)).toBe(1);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // the proof — the edit path and the draft
  // ═══════════════════════════════════════════════════════════════════════

  it('refuses too many rows on the Bearbeiten-Pfad and leaves the answer alone', async () => {
    const form = await publishedForm('Korrektur');
    await configure(form.id, { access: true }, { allowEdit: true });

    const submitted = await submit(form.slug, guests(START_ROWS));
    expect(submitted.status).toBe(200);
    const editUrl = (submitted.body as { editUrl: string | null }).editUrl;
    expect(editUrl).not.toBeNull();
    const token = (editUrl ?? '').split('/').pop() ?? '';

    // The correction may grow the table — up to the same number.
    const grown = await writeEdit(token, guests(MAX_ROWS));
    expect(grown.status).toBe(200);

    expectRowLimitRefusal(await writeEdit(token, guests(MAX_ROWS + 1)));

    // **Measured at the content of the `response` row**, not at the status: a
    // refusal that had already written would look identical from outside.
    const stored = await app().prisma.response.findFirstOrThrow({
      where: { formId: form.id },
      select: { answers: true },
    });
    const cells = (stored.answers as Record<string, { cells: unknown[] }>)[
      GUESTS
    ]?.cells;
    expect(cells).toHaveLength(MAX_ROWS);
  });

  /**
   * **The draft is the cheapest way** — no deadline, no answer limit, and
   * they do not even have to fill anything in. Both doors are measured: the one
   * that creates a draft and the one that overwrites it.
   */
  it('refuses too many rows in the Entwurf, on both of its doors', async () => {
    const form = await publishedForm('Zwischenspeichern');
    await configure(form.id, { access: true }, { allowSaveDraft: true });

    const before = await draftCount(form.id);
    expectRowLimitRefusal(await saveDraft(form.slug, guests(MAX_ROWS + 1)));
    expectRowLimitRefusal(await saveDraft(form.slug, emptyGuests(1000)));
    expect(await draftCount(form.id)).toBe(before);

    // …and the second door, on a draft that exists.
    const saved = await saveDraft(form.slug, guests(START_ROWS));
    expect(saved.status).toBe(200);
    const { draftUrl } = saved.body as { draftUrl: string };
    const token = draftUrl.split('/').pop() ?? '';

    const grown = await writeDraft(token, guests(MAX_ROWS));
    expect(grown.status).toBe(200);
    expectRowLimitRefusal(await writeDraft(token, guests(MAX_ROWS + 1)));

    const stored = await app().prisma.responseDraft.findFirstOrThrow({
      where: { formId: form.id },
      select: { answers: true },
    });
    const cells = (stored.answers as Record<string, { cells: unknown[] }>)[
      GUESTS
    ]?.cells;
    expect(cells).toHaveLength(MAX_ROWS);
  });
});
