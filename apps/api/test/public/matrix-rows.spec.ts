import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MATRIX_UNKNOWN_ROW_CODE } from '@formsache/shared';

import { JSON_BODY_LIMIT_BYTES } from '../../src/app-setup';
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
 * **An unknown matrix row on the public path** (a review finding —
 * the older half of the same gap that was closed for the
 * table).
 *
 * Every case here speaks **directly to the route**, past any browser: "which
 * rows there are" is something the fill-in view draws, and nothing forces a
 * stranger to use it. All three write paths are here for the reason the rule
 * names — the **submission**, the **correction** through the edit token and
 * the **draft**, which knows neither deadline nor response limit.
 *
 * ## What applied before, measured on 2026-08-07
 *
 * The blank branch of the union was `z.record(z.string(), z.array(z.never()).
 * length(0))` — it bounded neither the number nor the length of the keys and
 * passed them through into the output unchanged. A matrix with **one** row
 * accepted `{rows: {r0…r4999: []}}` and stored all 5000 keys; at the real
 * transport limit (100 KiB) it was **9404** keys and **102 344 bytes**,
 * and a single key of 90 000 characters went through just as well.
 * Affected were the submission (optional matrix) **and** the draft, there
 * also a mandatory matrix, because `enforceRequired: false` leads it into the
 * same optional branch.
 *
 * ## Two limits, two responsibilities
 *
 * `JSON_BODY_LIMIT_BYTES` (100 KiB) caps the **request**, `checkKnownRows`
 * caps **what gets into the `response` row**. They catch different
 * payloads, and the dangerous one is the *smaller*: a flood that breaks the
 * body limit is refused with **413** — even when the
 * validator branch does not exist any more. A test that only drives such
 * cases is therefore green against a broken application. Every flood in this
 * file therefore stays **below** the transport limit, and the case that
 * stretches the number assures its own size first.
 *
 * ## Why this costs more than storage
 *
 * `questionColumns` plans the columns of a matrix from `question.rows`. A
 * key that nobody has defined therefore appears **neither in the
 * answers table nor in the export** — stored, invisible, and thus targetedly
 * deletable by nobody („endgültiges Löschen ist
 * physisches Löschen"). That is why the last case of this file is one about
 * the **content of the stored row** and not about a status code.
 *
 * *Reproduction, run on 2026-08-07:* remove the `matrix` branch from
 * `preUnionGuardFor` → **all five** cases red (the invented rows are accepted
 * and stored). Narrowing the blank branch **instead** of the guard is the
 * second, more tempting reproduction; it is run in the shared test and turns
 * out differently depending on the spelling — see the comment on the
 * `matrix` branch of `blankSchemaFor`.
 */

const PASSWORD = 'test-password';
const PAGE = '019ff700-0000-7000-8000-0000000000b0';
const MAIL = '019ff700-0000-7000-8000-000000000011';
const RATING = '019ff700-0000-7000-8000-000000000012';

const KNOWN_ROW = 'organisation';
const UNKNOWN_ROW = 'erfundenes';

function definition(required: boolean): unknown {
  return {
    pages: [
      {
        id: PAGE,
        title: 'Rückmeldung',
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
            id: RATING,
            type: 'matrix',
            label: 'Bewertung',
            hint: null,
            required,
            width: 'full',
            multiple: false,
            rows: [{ value: KNOWN_ROW, label: 'Organisation' }],
            columns: [
              { value: 'gut', label: 'Gut' },
              { value: 'schlecht', label: 'Schlecht' },
            ],
          },
        ],
      },
    ],
  };
}

/** The answer a fill-in view produces — the one row this question has. */
function answered(): Record<string, unknown> {
  return {
    [MAIL]: 'anton@example.org',
    [RATING]: { rows: { [KNOWN_ROW]: ['gut'] } },
  };
}

/** `count` invented row keys, every one of them without a pick. */
function invented(count: number): Record<string, unknown> {
  return {
    [RATING]: {
      rows: Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `${UNKNOWN_ROW}-${String(index)}`,
          [],
        ]),
      ),
    },
  };
}

/**
 * **The dangerous size: just *below* the transport limit.**
 *
 * Two limits, two responsibilities — and whoever confuses them removes the
 * validator branch at some point and notices nothing: `JSON_BODY_LIMIT_BYTES`
 * (100 KiB, `app-setup.ts`) caps the **request**, `checkKnownRows`
 * (`packages/shared`) caps what gets into the **`response` row**. A flood
 * that breaks the body limit therefore proves *nothing* about the validator:
 * it fails with **413**, and that even when the check is not there any
 * more. The case that counts fits inside — the review measured it at 9388 rows
 * and 102 209 bytes.
 *
 * Short keys (`r0`…) instead of the speaking ones from {@link invented},
 * because what matters here is the number per byte: 9200 rows are 100 153 bytes
 * (measured) and thus below the limit — the test recomputes that instead of
 * believing it.
 */
const FLOOD_ROWS = 9200;

function nearBodyLimit(): Record<string, unknown> {
  return {
    [RATING]: {
      rows: Object.fromEntries(
        Array.from({ length: FLOOD_ROWS }, (_, index) => [
          `r${String(index)}`,
          [],
        ]),
      ),
    },
  };
}

/**
 * The hostile spellings the review measured surviving verbatim.
 *
 * ⚠️ **Without a pick on the known row**, and that is not cosmetic:
 * as soon as *any* row carries a pick, the answer is no longer
 * "empty", runs into the filled branch and is refused by `matrixAnswerSchema`
 * already — this case would then stay green **even if the guard before the
 * union is missing**. Measured on 2026-08-07: with `[KNOWN_ROW]: ['gut']`
 * exactly this case survived the reproduction as the only one of five.
 */
function hostile(): Record<string, unknown> {
  return {
    [RATING]: {
      rows: {
        "=cmd|' /C calc'!A1": [],
        '<script>alert(1)</script>': [],
      },
    },
  };
}

/** Documentation range (RFC 5737) — never a real caller. */
let nextAddress = 0;
function ownAddress(): string {
  nextAddress += 1;
  return `198.51.100.${String((nextAddress % 250) + 1)}`;
}

describe('unbekannte Matrix-Zeilen am öffentlichen Pfad', () => {
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
      // per address, and this file sends more than that.
      env: { TRUST_PROXY_HOPS: 1 },
      systemMail: { publicBaseUrl: TEST_PUBLIC_BASE_URL },
    });

    tenant = await createTenant(testApp.prisma, 'MATRIX');
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

  async function publishedForm(title: string, required = false): Promise<Form> {
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
      .send({
        title,
        definition: definition(required),
        revision: form.revision,
      });
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

  function draftCount(formId: string): Promise<number> {
    return app().prisma.responseDraft.count({ where: { formId } });
  }

  /**
   * The 400 as a caller sees it: the status, the **field** and the
   * **machine-readable rule** — never the German sentence alone.
   *
   * The path is the assertion that matters most here: it is what tells the fix
   * "guard before the union" apart from the fix "blank branch narrowed", which
   * refuses just as loudly and loses both the path and the code in an
   * `invalid_union`.
   */
  function expectUnknownRowRefusal(
    response: request.Response,
    rowKey: string,
  ): void {
    expect(response.status).toBe(400);
    const body = response.body as {
      issues?: { path: string; message: string; code?: string }[];
    };
    const issue = body.issues?.find(
      (entry) => entry.path === `${RATING}.rows.${rowKey}`,
    );
    expect(issue).toBeDefined();
    expect(issue?.code).toBe(MATRIX_UNKNOWN_ROW_CODE);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // The submission
  // ═══════════════════════════════════════════════════════════════════════

  it('accepts the row the question has and refuses the invented one', async () => {
    const form = await publishedForm('Rückmeldung');

    const accepted = await submit(form.slug, answered());
    expect(accepted.status).toBe(200);

    const before = await responseCount(form.id);
    expectUnknownRowRefusal(
      await submit(form.slug, invented(1)),
      `${UNKNOWN_ROW}-0`,
    );
    expect(await responseCount(form.id)).toBe(before);
  });

  /**
   * **The case that made up the gap**: thousands of keys without a single
   * pick. Before this package it went through on every path, because an empty
   * pick hits the blank branch of the union and never sees the filled check.
   *
   * ⚠️ **The payload deliberately stays below `JSON_BODY_LIMIT_BYTES`** —
   * otherwise the case would prove the body limit instead of the validator and
   * would stay green once nobody checks {@link nearBodyLimit} any more. The
   * first assertion is therefore the size of the request, not its answer.
   */
  it('refuses a flood that the body limit lets through', async () => {
    const form = await publishedForm('Flut');
    const flood = nearBodyLimit();

    expect(Buffer.byteLength(JSON.stringify({ answers: flood }))).toBeLessThan(
      JSON_BODY_LIMIT_BYTES,
    );
    // …and far above what the form knows: **one** row.
    expect(FLOOD_ROWS).toBeGreaterThan(1000);

    const before = await responseCount(form.id);
    expectUnknownRowRefusal(await submit(form.slug, flood), 'r0');
    expect(await responseCount(form.id)).toBe(before);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // The edit path
  // ═══════════════════════════════════════════════════════════════════════

  it('refuses an invented row on the Bearbeiten-Pfad and leaves the answer alone', async () => {
    const form = await publishedForm('Korrektur');
    await configure(form.id, { access: true }, { allowEdit: true });

    const submitted = await submit(form.slug, answered());
    expect(submitted.status).toBe(200);
    const editUrl = (submitted.body as { editUrl: string | null }).editUrl;
    expect(editUrl).not.toBeNull();
    const token = (editUrl ?? '').split('/').pop() ?? '';

    expectUnknownRowRefusal(
      await writeEdit(token, invented(200)),
      `${UNKNOWN_ROW}-0`,
    );

    // **Measured on the content of the `response` row**, not on the status.
    const stored = await app().prisma.response.findFirstOrThrow({
      where: { formId: form.id },
      select: { answers: true },
    });
    const rows = (
      stored.answers as Record<string, { rows: Record<string, unknown> }>
    )[RATING]?.rows;
    expect(Object.keys(rows ?? {})).toEqual([KNOWN_ROW]);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // The draft — with a **mandatory** matrix as well
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * **The draft is the cheapest way**, and it carries the second half of the
   * finding: a **mandatory** matrix runs here through the same optional
   * branch as a voluntary one, because `enforceRequired: false` takes out the
   * mandatory rule — and only it.
   */
  it('refuses invented rows in the Entwurf of a Pflicht-Matrix, on both doors', async () => {
    const form = await publishedForm('Zwischenspeichern', true);
    await configure(form.id, { access: true }, { allowSaveDraft: true });

    const before = await draftCount(form.id);
    expectUnknownRowRefusal(
      await saveDraft(form.slug, invented(500)),
      `${UNKNOWN_ROW}-0`,
    );
    expect(await draftCount(form.id)).toBe(before);

    // …and the second door, on a draft that exists.
    const saved = await saveDraft(form.slug, { [RATING]: { rows: {} } });
    expect(saved.status).toBe(200);
    const { draftUrl } = saved.body as { draftUrl: string };
    const token = draftUrl.split('/').pop() ?? '';

    expectUnknownRowRefusal(
      await writeDraft(token, invented(1)),
      `${UNKNOWN_ROW}-0`,
    );

    const stored = await app().prisma.responseDraft.findFirstOrThrow({
      where: { formId: form.id },
      select: { answers: true },
    });
    const rows = (
      stored.answers as Record<string, { rows: Record<string, unknown> }>
    )[RATING]?.rows;
    expect(Object.keys(rows ?? {})).toEqual([]);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // What gets stored
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * **The stored row does not carry the foreign key** — the case that no
   * status code replaces. It additionally drives the two hostile
   * spellings that survived verbatim before this package: a
   * formula introduction and a script tag. Both are **refused**, not
   * silently discarded — the same decision that `matrixAnswerSchema`
   * promises for the filled row.
   */
  it('never stores a row the question does not have', async () => {
    const form = await publishedForm('Speicherung');

    const refused = await submit(form.slug, hostile());
    expectUnknownRowRefusal(refused, "=cmd|' /C calc'!A1");
    expectUnknownRowRefusal(refused, '<script>alert(1)</script>');
    expect(await responseCount(form.id)).toBe(0);

    const accepted = await submit(form.slug, answered());
    expect(accepted.status).toBe(200);

    const stored = await app().prisma.response.findFirstOrThrow({
      where: { formId: form.id },
      select: { answers: true },
    });
    const rows = (
      stored.answers as Record<string, { rows: Record<string, unknown> }>
    )[RATING]?.rows;
    expect(Object.keys(rows ?? {})).toEqual([KNOWN_ROW]);
  });
});
