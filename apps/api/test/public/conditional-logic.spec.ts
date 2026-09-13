import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { resetAddressFormAllowances } from '../../src/public/address-form-tracker';
import { resetUploadQuota } from '../../src/public/upload-quota';
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
import { InMemoryFileStorage } from '../support/in-memory-file-storage';
import { NO_SECTIONS } from '../support/settings-sections';

/**
 * **Conditional display on the two write paths** .
 *
 * The evaluation itself is measured in `packages/shared` — across all
 * operator/type pairs. What is measured **here** is what those tests cannot
 * prove: that the *server* applies them, at both places at which an answer
 * gets into the database, and without the sender being asked what stood on their
 * screen. Every case goes past the client directly to the public route.
 *
 * ## The two directions in which the conditional required check can be wrong
 *
 * If the server checks the requirement **without** the condition, a form with a
 * hidden required field cannot be submitted; if it checks it the wrong way
 * round, every requirement can be evaded by hiding. Both have their **own**
 * case below, because a test that measures only one says nothing about the
 * other.
 *
 * ## And the direction that has no message
 *
 * A value for a hidden question is **discarded**. That cannot be seen on an
 * answer of the server — the submission does succeed —, but only on the
 * **content of the `response` row**. The cases below therefore read the
 * column and not the status code (the lesson).
 *
 * ## And the two question types for which the discarding costs something
 *
 * With a text question the discarding stays in the JSONB column. Two types
 * have consequences **outside** of it, and both run over the definition and
 * `answers[question.id]`:
 *
 * - **`file`** — `attachmentsIn` finds nothing for a hidden file question,
 *   so the upload is never claimed; when editing, the owner is withdrawn from
 *   it again and the purge deletes the bytes.
 * - **`event`** — `seatRequests` delivers nothing, the seats fall free.
 *
 * Both are the **right** consequence, but the expensive one, and neither of
 * them can be seen on the status code. The cases below therefore measure
 * `file.response_id` and the rows in `event_registration`.
 *
 * **A file of its own**, for the same measured reason as with
 * `question-types.spec.ts`: the submit route allows 30 requests per minute and
 * address, and a suite that shares the budget with another one measures the
 * rate limiter in the end.
 */

const PASSWORD = 'test-password';

const PAGE = '019ff600-0000-7000-8000-0000000000a0';
/** The source: „Wie reist du an?" */
const ANREISE = '019ff600-0000-7000-8000-000000000001';
/** Hangs on the source and is **required** — the whole point of contention of the conditional required check. */
const ABHOLUNG = '019ff600-0000-7000-8000-000000000002';
/** Hangs on the same source and carries an **upload**. */
const NACHWEIS = '019ff600-0000-7000-8000-000000000003';
/** Hangs on the same source and carries **seats**. */
const SONDERZUG = '019ff600-0000-7000-8000-000000000004';

/** The condition that all three dependent questions share. */
const NUR_BEI_BAHN = {
  questionId: ANREISE,
  operator: 'equals',
  value: 'bahn',
};

function conditionalDefinition() {
  return {
    pages: [
      {
        id: PAGE,
        title: 'Anmeldung',
        description: null,
        questions: [
          {
            id: ANREISE,
            type: 'radio',
            label: 'Wie reist du an?',
            hint: null,
            required: false,
            width: 'full',
            options: [
              { value: 'bahn', label: 'Mit der Bahn' },
              { value: 'auto', label: 'Mit dem Auto' },
            ],
            allowOther: false,
            otherLabel: null,
          },
          {
            id: ABHOLUNG,
            type: 'text',
            label: 'Ankunftszeit am Bahnhof',
            hint: null,
            required: true,
            width: 'full',
            minLength: null,
            maxLength: null,
            pattern: null,
            visibleIf: { ...NUR_BEI_BAHN },
          },
          /*
           * The two question types with consequences outside the JSONB column,
           * both **optional**: the point of contention here is the discarding,
           * not the requirement — that one is measured by `ABHOLUNG` one
           * question further up.
           */
          {
            id: NACHWEIS,
            type: 'file',
            label: 'Fahrkarte',
            hint: null,
            required: false,
            width: 'full',
            maxFiles: 2,
            visibleIf: { ...NUR_BEI_BAHN },
          },
          {
            id: SONDERZUG,
            type: 'event',
            label: 'Sonderzug',
            hint: null,
            required: false,
            width: 'full',
            events: [
              {
                key: 'hinfahrt',
                label: 'Hinfahrt',
                when: 'Fr, 08:00',
                capacity: null,
                showRemaining: false,
              },
            ],
            visibleIf: { ...NUR_BEI_BAHN },
          },
        ],
      },
    ],
  };
}

/** A real PDF header plus filler — the content is what the server checks. */
function pdf(size = 64): Buffer {
  const head = Buffer.from('%PDF-1.7\n');
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length))]);
}

interface Uploaded {
  ref: string;
  fileName: string;
}

const BAHN = { values: ['bahn'], other: null };
const AUTO = { values: ['auto'], other: null };

/** Documentation range (RFC 5737) — never a real caller. */
let nextAddress = 0;
function ownAddress(): string {
  nextAddress += 1;
  return `198.51.100.${String((nextAddress % 250) + 1)}`;
}

describe('Bedingte Anzeige auf der öffentlichen Route', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  let tenant: TenantFixture;
  let editor: string;
  let formId: string;
  let slug: string;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({
      databaseUrl: database.url,
      systemMail: { publicBaseUrl: TEST_PUBLIC_BASE_URL },
      env: { TRUST_PROXY_HOPS: 1 },
      storage: new InMemoryFileStorage(),
    });

    tenant = await createTenant(testApp.prisma, 'BED');
    const user = await createUser(testApp.prisma, {
      email: 'editor@example.org',
      password: PASSWORD,
      tenants: [tenant],
    });
    editor = await openSession(testApp, user.id, tenant.id);

    const created = await request(app().server)
      .post(apiPath('/forms'))
      .set(authedMutation(editor))
      .send({ title: 'Anmeldung mit Bedingung' });
    const form = created.body as {
      id: string;
      revision: number;
      publicSlug: string;
    };
    formId = form.id;
    slug = form.publicSlug;

    const saved = await request(app().server)
      .put(apiPath(`/forms/${form.id}`))
      .set(authedMutation(editor))
      .send({
        title: 'Anmeldung mit Bedingung',
        definition: conditionalDefinition(),
        revision: form.revision,
      });
    expect(saved.status).toBe(200);

    const published = await request(app().server)
      .post(apiPath(`/forms/${form.id}/publish`))
      .set(authedMutation(editor))
      .send({ revision: (saved.body as { revision: number }).revision });
    expect(published.status).toBe(200);

    // The second write path needs it: „Bearbeiten nach Absenden" .
    const settings = await app().prisma.form.findUniqueOrThrow({
      where: { id: form.id },
      select: { settingsRevision: true },
    });
    const tenantRow = await app().prisma.tenant.findUniqueOrThrow({
      where: { id: tenant.id },
      select: { formDefaultsRevision: true },
    });
    const configured = await request(app().server)
      .put(apiPath(`/forms/${form.id}/settings`))
      .set(authedMutation(editor))
      .send({
        overridden: { ...NO_SECTIONS, access: true },
        values: { allowEdit: true },
        revision: settings.settingsRevision,
        tenantRevision: tenantRow.formDefaultsRevision,
      });
    expect(configured.status).toBe(200);
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  afterEach(() => {
    resetUploadQuota();
    resetAddressFormAllowances();
  });

  async function submit(
    answers: Record<string, unknown>,
  ): Promise<request.Response> {
    return request(app().server)
      .post(apiPath(`/public/forms/${slug}/responses`))
      .set('X-Forwarded-For', ownAddress())
      .send({ answers });
  }

  async function edit(
    token: string,
    answers: Record<string, unknown>,
  ): Promise<request.Response> {
    return request(app().server)
      .put(apiPath(`/public/responses/${token}`))
      .set('X-Forwarded-For', ownAddress())
      .send({ answers });
  }

  function tokenOf(response: request.Response): string {
    const editUrl = (response.body as { editUrl: string | null }).editUrl;
    expect(editUrl).not.toBeNull();
    const token = (editUrl ?? '').slice((editUrl ?? '').lastIndexOf('/') + 1);
    expect(token).not.toBe('');
    return token;
  }

  /** The row written last — as content, not as message. */
  async function lastAnswers(): Promise<unknown> {
    const stored = await app().prisma.response.findFirst({
      where: { formId },
      orderBy: { submittedAt: 'desc' },
    });
    return stored?.answers;
  }

  /** One upload through the public form's door — unclaimed until a submission names it. */
  async function upload(fileName: string): Promise<Uploaded> {
    const answer = await request(app().server)
      .post(apiPath(`/public/forms/${slug}/files`))
      .set('X-Forwarded-For', ownAddress())
      .set('Content-Type', 'application/octet-stream')
      .set('X-File-Name', encodeURIComponent(fileName))
      .send(pdf());
    expect(answer.status).toBe(201);
    return answer.body as Uploaded;
  }

  /** Whom the upload belongs to — `null` means „ownerless", and the purge fetches it. */
  const ownerOf = async (ref: string): Promise<string | null> =>
    (await app().prisma.file.findUniqueOrThrow({ where: { publicRef: ref } }))
      .responseId;

  /** The occupied seats of this form, as rows and not as a sum. */
  async function seatRows(
    responseId?: string,
  ): Promise<{ eventKey: string; questionId: string; seats: number }[]> {
    return app().prisma.eventRegistration.findMany({
      where: { formId, ...(responseId === undefined ? {} : { responseId }) },
      select: { eventKey: true, questionId: true, seats: true },
      orderBy: { eventKey: 'asc' },
    });
  }

  function pathsOf(response: request.Response): string[] {
    const body = response.body as { issues?: { path: string }[] };
    return (body.issues ?? []).map((issue) => issue.path);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Submitting
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * **Direction 1 — the hidden requirement blocks nothing.** Without the
   * condition in the required check this form would be unsubmittable for
   * everyone who comes by car, and nobody could explain it from the outside.
   */
  it('nimmt eine Einreichung an, deren Pflichtfrage ausgeblendet ist', async () => {
    const before = await app().prisma.response.count({ where: { formId } });

    const response = await submit({ [ANREISE]: AUTO });

    expect(response.status).toBe(200);
    expect(await app().prisma.response.count({ where: { formId } })).toBe(
      before + 1,
    );
    expect(await lastAnswers()).toStrictEqual({ [ANREISE]: AUTO });
  });

  /**
   * **Direction 2 — shown, a requirement stays a requirement.** The case that
   * the first direction does *not* prove: whoever evaluates the condition the
   * wrong way round makes every required entry evadable by the hiding.
   */
  it('weist dieselbe Einreichung ab, sobald die Frage eingeblendet ist', async () => {
    const before = await app().prisma.response.count({ where: { formId } });

    const response = await submit({ [ANREISE]: BAHN });

    expect(response.status).toBe(400);
    expect(pathsOf(response)).toStrictEqual([ABHOLUNG]);
    expect(response.text).toContain('Pflichtfeld.');
    expect(await app().prisma.response.count({ where: { formId } })).toBe(
      before,
    );
  });

  /**
   * **The value of a hidden question is discarded**  —
   * measured at the column, not at the answer of the server.
   *
   * The sender here sends exactly what a browser sends along in which somebody
   * first chose „Bahn", typed the time and then switched to „Auto".
   * If the value stayed, an arrival time would stand in the evaluation for
   * somebody who was never asked for it.
   */
  it('verwirft den Wert einer ausgeblendeten Frage, statt ihn zu speichern', async () => {
    const response = await submit({
      [ANREISE]: AUTO,
      [ABHOLUNG]: '14:30 Uhr',
    });

    expect(response.status).toBe(200);
    expect(await lastAnswers()).toStrictEqual({ [ANREISE]: AUTO });
  });

  it('behält den Wert, solange die Frage eingeblendet ist', async () => {
    const response = await submit({ [ANREISE]: BAHN, [ABHOLUNG]: '14:30 Uhr' });

    expect(response.status).toBe(200);
    expect(await lastAnswers()).toStrictEqual({
      [ANREISE]: BAHN,
      [ABHOLUNG]: '14:30 Uhr',
    });
  });

  /**
   * The flip side of the discarding: it holds only for questions **of this
   * form**. „Question was hidden" and „question does not exist" stay two
   * different answers — otherwise the discarding would be a hole through which
   * any arbitrary key vanishes soundlessly.
   */
  it('weist einen Schlüssel ab, den dieses Formular nicht kennt', async () => {
    const before = await app().prisma.response.count({ where: { formId } });

    const response = await submit({
      [ANREISE]: AUTO,
      '019ff600-0000-7000-8000-0000000000fe': 'fremd',
    });

    expect(response.status).toBe(400);
    expect(await app().prisma.response.count({ where: { formId } })).toBe(
      before,
    );
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Editing — the same claim on the second write path
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * **Both write paths**, and here it is not an end in itself: the correction
   * is the only way on which an already stored value becomes invisible
   * *afterwards*. If it stayed there, the row would have an answer to a
   * question that this participant no longer had in front of them at all at the
   * second viewing of the form.
   */
  it('verwirft beim Bearbeiten den Wert, der durch die Änderung ausgeblendet wird', async () => {
    const submitted = await submit({ [ANREISE]: BAHN, [ABHOLUNG]: '9:15 Uhr' });
    expect(submitted.status).toBe(200);
    const token = tokenOf(submitted);

    const corrected = await edit(token, {
      [ANREISE]: AUTO,
      [ABHOLUNG]: '9:15 Uhr',
    });

    expect(corrected.status).toBe(200);
    const row = await app().prisma.response.findFirstOrThrow({
      where: { editToken: token },
    });
    expect(row.answers).toStrictEqual({ [ANREISE]: AUTO });
  });

  it('lässt beim Bearbeiten eine ausgeblendete Pflichtfrage leer', async () => {
    const submitted = await submit({ [ANREISE]: BAHN, [ABHOLUNG]: '9:15 Uhr' });
    expect(submitted.status).toBe(200);
    const token = tokenOf(submitted);

    const corrected = await edit(token, { [ANREISE]: AUTO });

    expect(corrected.status).toBe(200);
    const row = await app().prisma.response.findFirstOrThrow({
      where: { editToken: token },
    });
    expect(row.answers).toStrictEqual({ [ANREISE]: AUTO });
  });

  it('besteht beim Bearbeiten auf einer eingeblendeten Pflichtfrage', async () => {
    const submitted = await submit({ [ANREISE]: AUTO });
    expect(submitted.status).toBe(200);
    const token = tokenOf(submitted);

    const corrected = await edit(token, { [ANREISE]: BAHN });

    expect(corrected.status).toBe(400);
    expect(pathsOf(corrected)).toStrictEqual([ABHOLUNG]);
    // The row stays as it was — a rejected correction does not write.
    const row = await app().prisma.response.findFirstOrThrow({
      where: { editToken: token },
    });
    expect(row.answers).toStrictEqual({ [ANREISE]: AUTO });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // What the discarding costs outside the JSONB column
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * **The hidden file question does not take its upload into possession.**
   *
   * `attachmentsIn` runs over the definition and reads `answers[id]` — for
   * a hidden question nothing stands there after the discarding, so the upload
   * stays ownerless and falls to the purge. Measured at
   * `file.response_id`, not at the status code: the submission succeeds in both
   * cases.
   */
  it('beansprucht den Upload einer ausgeblendeten Datei-Frage nicht', async () => {
    const file = await upload('Fahrkarte.pdf');
    expect(await ownerOf(file.ref)).toBeNull();

    const response = await submit({
      [ANREISE]: AUTO,
      [NACHWEIS]: { files: [{ ref: file.ref, name: file.fileName }] },
    });

    expect(response.status).toBe(200);
    // The expensive consequence first — it is the subject of this case; the
    // column is measured by the case further up.
    expect(await ownerOf(file.ref)).toBeNull();
    expect(await lastAnswers()).toStrictEqual({ [ANREISE]: AUTO });
  });

  /**
   * The counter-check and the expensive case in one: shown, the same
   * upload is claimed, and the correction that hides the question withdraws
   * the owner from it again — after that it is ownerless and the purge deletes
   * the bytes. Without the counter-check the case above would only prove that
   * here nothing is ever claimed at all.
   */
  it('entzieht dem Upload den Eigentümer, sobald die Korrektur ihn ausblendet', async () => {
    const file = await upload('Fahrkarte.pdf');

    const submitted = await submit({
      [ANREISE]: BAHN,
      [ABHOLUNG]: '9:15 Uhr',
      [NACHWEIS]: { files: [{ ref: file.ref, name: file.fileName }] },
    });
    expect(submitted.status).toBe(200);
    const token = tokenOf(submitted);
    const row = await app().prisma.response.findFirstOrThrow({
      where: { editToken: token },
    });
    expect(await ownerOf(file.ref)).toBe(row.id);

    const corrected = await edit(token, {
      [ANREISE]: AUTO,
      [NACHWEIS]: { files: [{ ref: file.ref, name: file.fileName }] },
    });

    expect(corrected.status).toBe(200);
    expect(await ownerOf(file.ref)).toBeNull();
    const after = await app().prisma.response.findFirstOrThrow({
      where: { editToken: token },
    });
    expect(after.answers).toStrictEqual({ [ANREISE]: AUTO });
  });

  /**
   * **The hidden event question occupies no seat.**
   *
   * `seatRequests` reads the same column, so no row arises in
   * `event_registration` — measured at the rows, because the seats are counted
   * there and nowhere else.
   */
  it('belegt für eine ausgeblendete Veranstaltungsfrage keinen Platz', async () => {
    const before = await seatRows();

    const response = await submit({
      [ANREISE]: AUTO,
      [SONDERZUG]: { seats: { hinfahrt: 2 } },
    });

    expect(response.status).toBe(200);
    // The rows first, for the same reason as with the upload.
    expect(await seatRows()).toStrictEqual(before);
    expect(await lastAnswers()).toStrictEqual({ [ANREISE]: AUTO });
  });

  /** And the correction that hides releases the seats again. */
  it('gibt die Plätze frei, sobald die Korrektur die Frage ausblendet', async () => {
    const submitted = await submit({
      [ANREISE]: BAHN,
      [ABHOLUNG]: '9:15 Uhr',
      [SONDERZUG]: { seats: { hinfahrt: 2 } },
    });
    expect(submitted.status).toBe(200);
    const token = tokenOf(submitted);
    const row = await app().prisma.response.findFirstOrThrow({
      where: { editToken: token },
    });
    expect(await seatRows(row.id)).toStrictEqual([
      { eventKey: 'hinfahrt', questionId: SONDERZUG, seats: 2 },
    ]);

    const corrected = await edit(token, {
      [ANREISE]: AUTO,
      [SONDERZUG]: { seats: { hinfahrt: 2 } },
    });

    expect(corrected.status).toBe(200);
    expect(await seatRows(row.id)).toStrictEqual([]);
    const after = await app().prisma.response.findFirstOrThrow({
      where: { editToken: token },
    });
    expect(after.answers).toStrictEqual({ [ANREISE]: AUTO });
  });

  /**
   * **Responses across versions** : a row is rendered and checked against
   * **its own** version. If the condition is removed after the
   * submission, that changes nothing about this response — otherwise a
   * correction would suddenly demand a field that its participant never
   * saw, or throw away one that they had filled in.
   */
  it('bearbeitet gegen die Fassung der Antwort, nicht gegen den heutigen Entwurf', async () => {
    const submitted = await submit({ [ANREISE]: AUTO });
    expect(submitted.status).toBe(200);
    const token = tokenOf(submitted);

    // New version: the condition falls away, the required question stands for all.
    const unconditional = conditionalDefinition();
    delete (unconditional.pages[0]?.questions[1] as { visibleIf?: unknown })
      .visibleIf;
    const current = await app().prisma.form.findUniqueOrThrow({
      where: { id: formId },
      select: { revision: true },
    });
    const saved = await request(app().server)
      .put(apiPath(`/forms/${formId}`))
      .set(authedMutation(editor))
      .send({
        title: 'Anmeldung mit Bedingung',
        definition: unconditional,
        revision: current.revision,
      });
    expect(saved.status).toBe(200);
    const published = await request(app().server)
      .post(apiPath(`/forms/${formId}/publish`))
      .set(authedMutation(editor))
      .send({ revision: (saved.body as { revision: number }).revision });
    expect(published.status).toBe(200);

    // The old response hangs on the old version: „Auto" keeps on hiding,
    // although the form looks different today.
    const corrected = await edit(token, { [ANREISE]: AUTO });
    expect(corrected.status).toBe(200);

    // A **new** submission on the other hand runs against the new version, in
    // which the question is unconditionally required.
    const fresh = await submit({ [ANREISE]: AUTO });
    expect(fresh.status).toBe(400);
    expect(pathsOf(fresh)).toStrictEqual([ABHOLUNG]);
  });
});
