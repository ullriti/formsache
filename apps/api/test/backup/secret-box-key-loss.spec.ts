import 'reflect-metadata';

import { randomBytes } from 'node:crypto';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SECRET_BOX_KEY_BYTES } from '../../src/common/secret-box/secret-box-key';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import { createTenant, createUser } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/create-test-app';
import { authedMutation, openSession } from '../support/http';

const PASSWORD = 'change-me-locally';
// At least twelve characters — the application refuses shorter ones.
const WORD = 'Fuxenstall-Verein';
const PAGE = '019ff400-0000-7000-8000-0000000000b0';
const QUESTION = '019ff400-0000-7000-8000-0000000000b1';

/**
 * **`SECRET_BOX_KEY` is the third object of the backup — and its loss is
 * the quietest conceivable loss of data** (ADR-0017).
 *
 * If a backup is restored with a *different* key, the
 * database is **complete**: every row is there, the application starts, every
 * page renders. Only at the protected form does it become apparent that something is
 * missing — and it looks like an application error, not like a loss of a key.
 *
 * This test drives exactly that at the **running application**: the same
 * database, two processes, two keys.
 *
 * ⚠️ **The hardest reproduction of this milestone** belongs to the gate case,
 * and it needed two attempts — both are held on record here, because the first
 * one is a lesson:
 *
 * 1. **Making `isLocked` fail-open left this file green.** And that is
 *    right so: with a foreign key the settings document still
 *    parses — `passwordEnabled: true` stands in plain text, sealed is only
 *    the word. The lock therefore correctly recognises the form as protected;
 *    unreadable it becomes only at the **opening**. Whoever reproduces here must hit
 *    the place that this test really runs through.
 * 2. **Making `AccessWordService.matches` fail-open** (`expected === null`
 *    as a hit instead of as a refusal) makes the gate case red — and that is the
 *    case that counts: a loss of a key would otherwise turn into an open
 *    form, and namely for **everyone** who has the address.
 */
describe('Wiederherstellung mit fremdem SECRET_BOX_KEY ', () => {
  let database: TestDatabase;
  /** The installation that set the access word. */
  let original: TestApp;
  /** The same database, a different key — the „restored" one. */
  let restored: TestApp;
  let guardedSlug: string;
  let openSlug: string;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    original = await createTestApp({ databaseUrl: database.url });

    const tenant = await createTenant(original.prisma, 'KEY');
    const user = await createUser(original.prisma, {
      email: 'editor@key.example',
      password: PASSWORD,
      tenants: [tenant],
    });
    const editor = await openSession(original, user.id, tenant.id);

    guardedSlug = await publish(original, editor, 'Mit Zugangswort', WORD);
    openSlug = await publish(original, editor, 'Ohne Zugangswort', null);

    // The move: the same rows, a different key. That is exactly what
    // a restore without the matching `SECRET_BOX_KEY` leaves behind.
    restored = await createTestApp({
      databaseUrl: database.url,
      env: {
        SECRET_BOX_KEY: randomBytes(SECRET_BOX_KEY_BYTES).toString('base64'),
      },
    });
  }, 180_000);

  afterAll(async () => {
    await restored.close();
    await original.close();
    await database.release();
  }, 120_000);

  it('startet trotzdem — und genau das macht den Verlust still', async () => {
    // No error at the start-up, no warning, no broken page. Whoever
    // asks after a restore only „does it run?" gets a yes.
    const health = await request(restored.server).get('/api/health');
    expect(health.status).toBe(200);
  });

  it('lässt ein Formular **ohne** Zugangswort unberührt', async () => {
    // The counter-check: the damage hits only what was sealed. Without this
    // case the next one would only prove that after the move something or other is broken.
    const response = await request(restored.server).get(
      `/api/public/forms/${openSlug}`,
    );
    expect(response.status).toBe(200);
  });

  it('gibt am geschützten Formular **keine Frage** heraus', async () => {
    const response = await request(restored.server).get(
      `/api/public/forms/${guardedSlug}`,
    );

    // 200 with `locked` — and that is right, not the damage: the
    // read path unseals nothing at all, it only sees **that** a word is
    // set. What it hands out is title and branding, as with every
    // protected form.
    expect(response.status).toBe(200);
    expect((response.body as { locked?: boolean }).locked).toBe(true);
    // The core: no question leaves the application. If the tolerant
    // read path hung on the lock decision, the form definition would stand here.
    expect(JSON.stringify(response.body)).not.toContain('questions');
  });

  it('lässt **niemanden** durch das Tor — auch nicht mit dem richtigen Wort', async () => {
    const response = await request(restored.server)
      .post(`/api/public/forms/${guardedSlug}/access`)
      .set('X-Forwarded-For', '198.51.100.7')
      .send({ password: WORD });

    // ⚠️ **404, not 503 — and that is the better answer.** The old assumption
    // had expected 503; what was measured was 404, byte-identical to the refusal of a
    // wrong word. Exactly so it must be: a 503 would be an **oracle** —
    // „this form exists, and its access word is broken" — that
    // is the decision that at the gate no answer reveals more than another
    // one. The loss of the key therefore locks out without giving itself away.
    expect(response.status).toBe(404);
    expect(
      (response.body as { accessToken?: unknown }).accessToken,
    ).toBeUndefined();
  });

  it('nimmt am geschützten Formular keine Antwort an', async () => {
    const response = await request(restored.server)
      .post(`/api/public/forms/${guardedSlug}/responses`)
      .send({ answers: {} });

    // A submission that got through while the access word is unreadable
    // would have bypassed the door that it guards.
    expect(response.status).toBe(409);
    expect((response.body as { reason?: string }).reason).toBe(
      'password_required',
    );
  });

  it('die *ursprüngliche* Installation kann es weiterhin lesen — der Schlüssel ist der Unterschied', async () => {
    // With that it is ruled out that the row itself is broken: the same
    // data, read with the right key, answers normally.
    const response = await request(original.server).get(
      `/api/public/forms/${guardedSlug}`,
    );
    expect(response.status).toBe(200);
    expect((response.body as { locked?: boolean }).locked).toBe(true);
  });
});

/**
 * A published form, over the **real** routes.
 *
 * Deliberately not shortened with `prisma.form.create`: the access word is sealed
 * when the settings are saved, and a value written past the
 * route would not be what this test wants to measure. The price
 * are the revisions — the optimistic locks that each
 * of these routes demands.
 */
async function publish(
  app: TestApp,
  editor: string,
  title: string,
  word: string | null,
): Promise<string> {
  const created = await request(app.server)
    .post('/api/forms')
    .set(authedMutation(editor))
    .send({ title });
  expect(created.status).toBe(201);
  const form = created.body as {
    id: string;
    revision: number;
    publicSlug: string;
  };

  const saved = await request(app.server)
    .put(`/api/forms/${form.id}`)
    .set(authedMutation(editor))
    .send({ title, definition: definition(), revision: form.revision });
  expect(saved.status).toBe(200);

  if (word !== null) {
    const row = await app.prisma.form.findUniqueOrThrow({
      where: { id: form.id },
      select: { settingsRevision: true, tenantId: true },
    });
    const tenant = await app.prisma.tenant.findUniqueOrThrow({
      where: { id: row.tenantId },
      select: { formDefaultsRevision: true },
    });
    const configured = await request(app.server)
      .put(`/api/forms/${form.id}/settings`)
      .set(authedMutation(editor))
      .send({
        overridden: {
          access: true,
          confirm: false,
          display: false,
          budget: false,
        },
        values: { passwordEnabled: true, password: word },
        revision: row.settingsRevision,
        tenantRevision: tenant.formDefaultsRevision,
      });
    expect(configured.status).toBe(200);
  }

  const published = await request(app.server)
    .post(`/api/forms/${form.id}/publish`)
    .set(authedMutation(editor))
    .send({ revision: (saved.body as { revision: number }).revision });
  expect(published.status).toBe(200);

  return form.publicSlug;
}

/**
 * A page with one question — enough to measure „does it hand out questions?".
 *
 * The shape comes from `password-gate.spec.ts` and is complete: the
 * form schema in `@formsache/shared` is `strictObject`, a missing field
 * ends the saving with 400 instead of with a half-valid form.
 */
function definition() {
  return {
    pages: [
      {
        id: PAGE,
        title: 'Seite',
        questions: [
          {
            id: QUESTION,
            type: 'text',
            label: 'Zuname',
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
