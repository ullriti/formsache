import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { questionPlaceholderToken } from '@formsache/shared';

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
import { authedMutation, cookieHeader, openSession } from '../support/http';

/**
 * **The requirement — the canonical form of the „Sonstiges" answer, measured at
 * the column**.
 *
 * `packages/shared` proves the rule; this file proves the two things a unit
 * test cannot, and the second is the one the requirement insists on:
 *
 * 1. **What arrives lies canonically in the database.** A submission carrying
 *    `other: ''` is read back out of the JSONB column as `other: null` — not
 *    normalised again on the way out, but actually stored that way. The
 *    reproduction the requirement names (normalise on *read* instead of on
 *    write) turns exactly these cases red and nothing else.
 * 2. **The legacy stock stays readable.** Every row written before the fix
 *    carries the old spelling, and that is the reason the double form existed
 *    at all. A row planted the old way — past the validator, straight into the
 *    column, which is precisely how it got there — must still render in the
 *    export, still open in the edit view, still save, and an unchanged re-save
 *    must not announce a change to its participant.
 *
 * **A file of its own**, for the reason `question-types.spec.ts` gives next
 * door: the public write routes allow 30 requests a minute per address, and a
 * file that shares that budget with another suite measures the rate limit.
 */

const PASSWORD = 'test-password';

const PAGE = '019ffd00-0000-7000-8000-0000000000a0';
const NAME = '019ffd00-0000-7000-8000-000000000001';
const PRIVATE_MAIL = '019ffd00-0000-7000-8000-000000000002';
/** The question with the „Sonstiges" box — the whole subject of this fix. */
const MEAL = '019ffd00-0000-7000-8000-000000000003';

const questionBase = { hint: null, required: false, width: 'full' as const };

function definition(mealRequired: boolean): unknown {
  return {
    pages: [
      {
        id: PAGE,
        title: 'Anmeldung',
        questions: [
          {
            ...questionBase,
            id: NAME,
            type: 'text',
            label: 'Name',
            minLength: null,
            maxLength: null,
            pattern: null,
          },
          {
            ...questionBase,
            id: PRIVATE_MAIL,
            type: 'email',
            label: 'Private E-Mail',
          },
          {
            ...questionBase,
            id: MEAL,
            type: 'checkbox',
            label: 'Verpflegung',
            required: mealRequired,
            options: [
              { value: 'fleisch', label: 'Mit Fleisch' },
              { value: 'vegetarisch', label: 'Vegetarisch' },
            ],
            allowOther: true,
            otherLabel: 'Sonstiges',
            minSelected: null,
            maxSelected: null,
          },
        ],
      },
    ],
  };
}

const PRIVATE_ADDRESS = 'privat@example.org';

/** Documentation range (RFC 5737) — never a real caller. */
let nextAddress = 0;
function ownAddress(): string {
  nextAddress += 1;
  return `198.51.100.${String((nextAddress % 250) + 1)}`;
}

describe('die kanonische Form von „Sonstiges" in der Spalte', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  let tenant: TenantFixture;
  let editor: string;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    // No transport configured, so queued mails stay `queued` and can be
    // counted without a worker racing this file — the same setup
    // `edit-mail.spec.ts` uses, for the same reason.
    testApp = await createTestApp({
      databaseUrl: database.url,
      systemMail: { publicBaseUrl: TEST_PUBLIC_BASE_URL },
      env: { TRUST_PROXY_HOPS: 1 },
    });

    tenant = await createTenant(testApp.prisma, 'CANON');
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

  // ─── fixtures, through the real routes ──────────────────────────────────

  async function publishedForm(
    title: string,
    mealRequired = false,
  ): Promise<{ id: string; slug: string }> {
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
        definition: definition(mealRequired),
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

  /** Editing on, plus the participant's own copy — as `edit-mail.spec.ts` does. */
  async function allowEditing(formId: string): Promise<void> {
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
          access: true,
          confirm: true,
          display: false,
          budget: false,
        },
        // **`copyToSubmitter` on**, and it is load-bearing rather than
        // decoration: the change-mail case below addresses the participant's
        // own address out of the answer, and with the switch off
        // `submission-mail.ts` drops exactly that recipient — the case would
        // then count zero rows whatever the change block said.
        values: { allowEdit: true },
        revision: form.settingsRevision,
        tenantRevision: tenantRow.formDefaultsRevision,
      });
    expect(response.status).toBe(200);
  }

  async function submit(
    slug: string,
    answers: Record<string, unknown>,
  ): Promise<request.Response> {
    return request(app().server)
      .post(apiPath(`/public/forms/${slug}/responses`))
      .set('X-Forwarded-For', ownAddress())
      .send({ answers });
  }

  /** The stored document, straight out of the column. */
  async function storedAnswers(
    formId: string,
  ): Promise<Record<string, unknown>> {
    const row = await app().prisma.response.findFirstOrThrow({
      where: { formId },
      select: { answers: true },
    });
    return row.answers as Record<string, unknown>;
  }

  function tokenOf(editUrl: string | null): string {
    const url = editUrl ?? '';
    const token = url.slice(url.lastIndexOf('/') + 1);
    expect(token).not.toBe('');
    return token;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // the evidence — what arrives with other: '' lies as null in the column
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * The three shapes a fill-in view really produces, all three reachable past
   * the coarse „Pflichtfeld" check: nothing chosen beside an empty box, an
   * option chosen beside it, and the same on a **required** question — which
   * the blank check waves through because an option *is* selected.
   *
   * The assertion is on the **column**, not on the response body: an answer
   * repaired on the way out would satisfy a check on the reply and leave the
   * two spellings in the database, which is the whole thing this fix is about.
   */
  it.each([
    ['nichts gewählt', false, { values: [] }],
    ['eine Option gewählt', false, { values: ['fleisch'] }],
    ['Pflichtfrage, eine Option gewählt', true, { values: ['fleisch'] }],
  ])(
    'speichert %s mit leerem „Sonstiges" als other: null',
    async (name, mealRequired, answer) => {
      const form = await publishedForm(`Kanonisch — ${name}`, mealRequired);

      const submitted = await submit(form.slug, {
        [NAME]: 'Anton',
        [MEAL]: { ...answer, other: '' },
      });
      expect(submitted.status).toBe(200);

      expect(await storedAnswers(form.id)).toEqual({
        [NAME]: 'Anton',
        [MEAL]: { ...answer, other: null },
      });
    },
  );

  /**
   * Whitespace goes the same way — „no free text" has one spelling, not two
   * and a half. And a text somebody really wrote survives byte for byte,
   * because the rule spells emptiness rather than repairing input.
   */
  it('speichert Leerraum als null und einen echten Freitext unverändert', async () => {
    const blank = await publishedForm('Kanonisch — Leerraum');
    expect(
      (
        await submit(blank.slug, {
          [NAME]: 'Anton',
          [MEAL]: { values: ['fleisch'], other: '  \t ' },
        })
      ).status,
    ).toBe(200);
    expect((await storedAnswers(blank.id))[MEAL]).toEqual({
      values: ['fleisch'],
      other: null,
    });

    const written = await publishedForm('Kanonisch — Freitext');
    expect(
      (
        await submit(written.slug, {
          [NAME]: 'Anton',
          [MEAL]: { values: [], other: ' vegan, bitte ' },
        })
      ).status,
    ).toBe(200);
    expect((await storedAnswers(written.id))[MEAL]).toEqual({
      values: [],
      other: ' vegan, bitte ',
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // the evidence — the legacy stock stays readable
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * A row as it was written before the fix — **planted past the validator**,
   * straight into the column, because that is the only way the old spelling
   * exists now. Anything that went through `submit()` would already be
   * canonical, and a fixture that cannot carry the old form cannot prove the
   * old form still reads.
   */
  async function legacyRow(title: string): Promise<{
    form: { id: string; slug: string };
    token: string;
  }> {
    const form = await publishedForm(title);
    await allowEditing(form.id);

    const submitted = await submit(form.slug, {
      [NAME]: 'Anton',
      [PRIVATE_MAIL]: PRIVATE_ADDRESS,
      [MEAL]: { values: ['fleisch'], other: null },
    });
    expect(submitted.status).toBe(200);
    const token = tokenOf(
      (submitted.body as { editUrl: string | null }).editUrl,
    );

    const row = await app().prisma.response.findFirstOrThrow({
      where: { formId: form.id },
      select: { id: true },
    });
    await app().prisma.response.update({
      where: { id: row.id },
      data: {
        answers: {
          [NAME]: 'Anton',
          [PRIVATE_MAIL]: PRIVATE_ADDRESS,
          [MEAL]: { values: ['fleisch'], other: '' },
        },
      },
    });

    return { form, token };
  }

  it('exportiert eine vor der Normalisierung geschriebene Zeile', async () => {
    const { form } = await legacyRow('Altbestand — Export');

    const exported = await request(app().server)
      .get(apiPath(`/forms/${form.id}/export.csv`))
      .set('Cookie', cookieHeader(editor));

    expect(exported.status).toBe(200);
    expect(exported.text).toContain('Anton');
    // The answer itself, formatted the way the responses table shows it — the
    // empty „Sonstiges" contributes nothing, which it never did.
    expect(exported.text).toContain('Mit Fleisch');
    expect(exported.text).not.toContain('Sonstiges:');
  });

  it('öffnet eine vor der Normalisierung geschriebene Zeile zum Bearbeiten', async () => {
    const { token } = await legacyRow('Altbestand — Öffnen');

    const opened = await request(app().server)
      .get(apiPath(`/public/responses/${token}`))
      .set('X-Forwarded-For', ownAddress());

    expect(opened.status).toBe(200);
    // Handed out **as stored**: the edit route does not re-validate a stored
    // answer („because a snapshot that has grown stricter would otherwise yield
    // an answer that nobody can open any more"), so the old spelling travels and
    // the client's own parse is what canonicalises it.
    expect(
      (opened.body as { answers: Record<string, unknown> }).answers,
    ).toEqual({
      [NAME]: 'Anton',
      [PRIVATE_MAIL]: PRIVATE_ADDRESS,
      [MEAL]: { values: ['fleisch'], other: '' },
    });
  });

  /**
   * The correction itself: the old spelling is accepted on the way back in and
   * lands canonically — so a row heals the first time its participant touches
   * it, rather than needing a migration.
   */
  it('speichert eine Bearbeitung des Altbestands kanonisch', async () => {
    const { form, token } = await legacyRow('Altbestand — Bearbeiten');

    const saved = await request(app().server)
      .put(apiPath(`/public/responses/${token}`))
      .set('X-Forwarded-For', ownAddress())
      .send({
        answers: {
          [NAME]: 'Anton Bandinsky',
          [PRIVATE_MAIL]: PRIVATE_ADDRESS,
          [MEAL]: { values: ['fleisch'], other: '' },
        },
      });

    expect(saved.status).toBe(200);
    expect((await storedAnswers(form.id))[MEAL]).toEqual({
      values: ['fleisch'],
      other: null,
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // the evidence — the change comparison stays right
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * **Why `canonicalAnswerValue` is still applied in
   * `notification-render.ts`** after the fix, and why deleting it there would be a
   * regression rather than the simplification it sounds like.
   *
   * The *previous* side of an edit is whatever the column has held.
   * Here it is `{values: ['fleisch'], other: ''}`; the participant changes
   * nothing about the Verpflegung, so the new side is written canonically as
   * `{values: ['fleisch'], other: null}`. Neither side is blank — an option is
   * selected — so `isBlankAnswer` does not catch the pair, and without the
   * shared collapse the change mail would tell the participant „Verpflegung:
   * Mit Fleisch → Mit Fleisch" about an edit they did not make, in the very
   * mail that exists so a leaked Bearbeiten-Link is noticed.
   *
   * *Reproduction:* drop the `canonicalAnswerValue` call from `answerChanges`
   * → this case turns red.
   */
  it('meldet keine Änderung, wenn nur die alte Schreibweise kanonisch wird', async () => {
    const { form, token } = await legacyRow('Altbestand — Änderungsblock');
    const created = await request(app().server)
      .post(apiPath(`/forms/${form.id}/notifications`))
      .set(authedMutation(editor))
      .send({
        name: 'Änderung',
        triggers: ['edit'],
        subject: 'Anmeldung geändert',
        body: `Geändert: ${questionPlaceholderToken(NAME)}.`,
        recipients: [{ kind: 'question', questionId: PRIVATE_MAIL }],
        replyTo: null,
      });
    expect(created.status).toBe(201);

    const saved = await request(app().server)
      .put(apiPath(`/public/responses/${token}`))
      .set('X-Forwarded-For', ownAddress())
      .send({
        answers: {
          [NAME]: 'Anton',
          [PRIVATE_MAIL]: PRIVATE_ADDRESS,
          [MEAL]: { values: ['fleisch'], other: '' },
        },
      });
    expect(saved.status).toBe(200);

    // Nothing moved at all, so „no change, no mail" applies — which is
    // the strongest form the assertion can take: a phantom row in the change
    // block would have made this edit look like a change and queued one.
    expect(
      await app().prisma.mailLog.count({ where: { formId: form.id } }),
    ).toBe(0);

    // **The positive control**, in the same case and on the same fixture: a
    // real change on the very next edit *does* queue. Without it „zero rows"
    // would be satisfied by a form that never queues anything at all — the
    // shape this file's own first draft had, where `copyToSubmitter` was off
    // and the recipient was dropped before the change block was ever consulted.
    const changed = await request(app().server)
      .put(apiPath(`/public/responses/${token}`))
      .set('X-Forwarded-For', ownAddress())
      .send({
        answers: {
          [NAME]: 'Anton Bandinsky',
          [PRIVATE_MAIL]: PRIVATE_ADDRESS,
          [MEAL]: { values: ['fleisch'], other: null },
        },
      });
    expect(changed.status).toBe(200);
    expect(
      await app().prisma.mailLog.count({ where: { formId: form.id } }),
    ).toBe(1);
  });
});
