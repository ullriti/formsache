import {
  allQuestions,
  parsePublicFormResponse,
  type FormDefinition,
  type ResolvedAiConfig,
} from '@formsache/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { generateAiFormDraft } from '../../src/ai/ai-form-draft';
import type { AiFormGenerator } from '../../src/ai/ai-form-generator';
import { AnthropicFormGenerator } from '../../src/ai/anthropic-form-generator';
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
import { RecordedFormGenerator } from '../support/recorded-form-generator';
import { CONTRACT_ROWS, recordedTransport } from './recorded-answers';

/**
 * **A generated form is publishable without rework**.
 *
 * The requirement is explicit about *how* that is to be shown: „der Test fährt es
 * durch dieselbe Prüfung, die *Veröffentlichen* fährt
 * (`findUnresolvableConditions`, Platzhalter-Sperre)" — so this file drives the
 * real `POST /api/forms/:id/publish` and reads its status, rather than calling
 * the two lock functions itself. A rebuilt check would only prove that two
 * copies of one rule agree; it is the endpoint that refuses, and the endpoint
 * that has to answer 200 here.
 *
 * The earlier experience behind that wording: a preview that answered „blocked: []"
 * for itself kept a whole phase's worth of suites green while the server
 * half was unproven.
 *
 * **Both locks are exercised, and one of them is vacuous — deliberately named
 * rather than left to be discovered.** A form that came into existence a second
 * ago has no notification, so the Platzhalter-Sperre has nothing to find; what
 * this file proves about it is that the *route* runs it and still answers 200.
 * The condition lock is the one with teeth here: the generated form carries a
 * *Bedingte Anzeige*, so a pipeline that resolved positions badly would produce
 * exactly the 422 this test would then read.
 */

const PASSWORD = 'test-password';

const CONFIG: ResolvedAiConfig = {
  provider: 'anthropic',
  apiKey: 'sk-recorded-not-a-real-key',
  region: 'eu',
  model: 'claude-opus-5',
  timeoutMs: 60_000,
};

function successRow() {
  const row = CONTRACT_ROWS[0];
  if (row === undefined) {
    throw new Error('the contract table is empty');
  }
  return row;
}

async function draftFrom(generator: AiFormGenerator): Promise<FormDefinition> {
  const controller = new AbortController();
  const result = await generateAiFormDraft({
    generator,
    prompt: 'Ein Formular für die Bestandsmeldung mit Name und Anreise.',
    language: 'de',
    signal: controller.signal,
  });
  if (!result.ok) {
    throw new Error(
      `Expected a form, got ${result.failure}: ${result.detail ?? '—'}`,
    );
  }
  return result.definition;
}

describe('a generated form publishes without rework ', () => {
  let testApp: TestApp;
  let tenant: TenantFixture;
  let editor: string;
  let database: TestDatabase | undefined;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });

    tenant = await createTenant(testApp.prisma, 'C3PUB');
    const user = await createUser(testApp.prisma, {
      email: 'ai-publish@example.org',
      password: PASSWORD,
      tenants: [tenant],
    });
    editor = await openSession(testApp, user.id, tenant.id);
  }, 180_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  /**
   * Puts a generated definition through the **existing** creation path — the
   * same one *Übernehmen* will use (ADR-0015 no. 11) — and returns what the
   * routes answered at each step.
   */
  async function adoptAndPublish(
    title: string,
    definition: FormDefinition,
  ): Promise<{
    readonly formId: string;
    readonly publicSlug: string;
    readonly saveStatus: number;
    readonly publishStatus: number;
    readonly publishBody: unknown;
  }> {
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
      .send({ title, definition, revision: form.revision });

    const published = await request(app().server)
      .post(apiPath(`/forms/${form.id}/publish`))
      .set(authedMutation(editor))
      .send({ revision: (saved.body as { revision: number }).revision });

    return {
      formId: form.id,
      publicSlug: form.publicSlug,
      saveStatus: saved.status,
      publishStatus: published.status,
      publishBody: published.body,
    };
  }

  it('is saved and published by the real routes, condition and all', async () => {
    const definition = await draftFrom(
      new AnthropicFormGenerator(
        CONFIG,
        recordedTransport(successRow().anthropic).transport,
      ),
    );
    // The teeth of this case: without a condition, the publish lock this
    // requirement names would have nothing to resolve.
    expect(
      allQuestions(definition).filter(
        (question) => question.visibleIf !== undefined,
      ),
    ).toHaveLength(1);

    const outcome = await adoptAndPublish('KI-Bestandsmeldung', definition);

    expect(outcome.saveStatus).toBe(200);
    // 200 rather than „not 422": a publish that answered 409 or 500 would be
    // just as much a failure of „ohne Nacharbeit" as the refusal is.
    expect(outcome.publishStatus).toBe(200);

    // And it is really in force — a form the participant can open.
    const publicView = await request(app().server).get(
      apiPath(`/public/forms/${outcome.publicSlug}`),
    );
    expect(publicView.status).toBe(200);
  });

  /**
   * **The counter-probe of the case above** (the same requirement seen from
   * the other end): a generated form whose condition points at a *later*
   * question never reaches the publish route at all, because the adoption
   * refuses it. Without this case, „publiziert mit 200" could equally well mean
   * „diese Prüfung findet nie etwas".
   */
  it('never reaches publishing when the model pointed a condition forward', async () => {
    const controller = new AbortController();
    const result = await generateAiFormDraft({
      generator: new RecordedFormGenerator({
        ok: true,
        draft: {
          pages: [
            {
              title: 'Anmeldung',
              description: null,
              questions: [
                {
                  type: 'text',
                  label: 'Mitfahrgelegenheit',
                  hint: null,
                  required: false,
                  width: 'full',
                  minLength: null,
                  maxLength: null,
                  pattern: null,
                  visibleIf: {
                    operator: 'equals',
                    value: 'bahn',
                    questionIndex: 1,
                  },
                },
                {
                  type: 'select',
                  label: 'Anreise',
                  hint: null,
                  required: false,
                  width: 'full',
                  options: [{ value: 'bahn', label: 'Bahn' }],
                  allowOther: false,
                  otherLabel: null,
                },
              ],
            },
          ],
        },
        usage: null,
      }),
      prompt: 'Anmeldung mit Anreise und Mitfahrgelegenheit.',
      language: 'de',
      signal: controller.signal,
    });

    expect(result).toMatchObject({ ok: false, failure: 'invalid_output' });
    expect(result.ok ? '' : result.detail).toContain('Mitfahrgelegenheit');
  });

  /**
   * **The requirement, the half a server test can carry.** A `<script>` in a
   * question title travels as a **string** — through the parse, through the
   * `jsonb` column, out of the public route as a JSON value. The rendered half
   * (nothing puts it into `dangerouslySetInnerHTML`) is a web test and belongs
   * to the package that builds the preview.
   *
   * Measured on the **raw body text** rather than on the parsed object: a
   * response that had turned the label into markup would be a different byte
   * sequence, and `response.body` would hide that behind its own parse.
   */
  it('carries a <script> in a question title out as text, not as markup', async () => {
    const hostile = '<script>alert("kanarie")</script>';
    const controller = new AbortController();
    const result = await generateAiFormDraft({
      generator: new RecordedFormGenerator({
        ok: true,
        draft: {
          pages: [
            {
              title: 'Anmeldung',
              description: null,
              questions: [
                {
                  type: 'text',
                  label: hostile,
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
        usage: null,
      }),
      prompt: 'Ein Formular mit einer einzigen Frage.',
      language: 'de',
      signal: controller.signal,
    });
    if (!result.ok) {
      throw new Error(`Expected a form, got ${result.failure}`);
    }
    expect(allQuestions(result.definition)[0]?.label).toBe(hostile);

    const outcome = await adoptAndPublish('KI-Skript', result.definition);
    expect(outcome.publishStatus).toBe(200);

    const publicView = await request(app().server).get(
      apiPath(`/public/forms/${outcome.publicSlug}`),
    );
    expect(publicView.status).toBe(200);
    expect(publicView.headers['content-type']).toContain('application/json');
    // The label is a JSON string value, byte for byte what the model wrote.
    expect(publicView.text).toContain(JSON.stringify(hostile).slice(1, -1));

    // Read through the **wire schema**, so „was der Teilnehmer bekommt" is what
    // the contract lets through rather than what a cast in this file claims.
    const payload = parsePublicFormResponse(publicView.body);
    expect(payload.locked).toBe(false);
    expect(
      payload.locked ? [] : allQuestions(payload.definition),
    ).toMatchObject([{ label: hostile, type: 'text' }]);
  });
});
