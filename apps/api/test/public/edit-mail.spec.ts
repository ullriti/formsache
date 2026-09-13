import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  questionPlaceholderToken,
  systemPlaceholderToken,
} from '@formsache/shared';

import { StartTokenService } from '../../src/public/start-token.service';
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
 * **An edit triggers a mail** — the requirements.
 *
 * Until this file existed a correction made through the edit link sent
 * nothing at all, and that was not a forgotten line: the one trigger was called
 * „Bei Absendung", and an edit is not a submission. Two things pay for closing
 * it, and both are in the requirement rather than in a footnote.
 *
 * 1. The organisation's office receives the registration by mail and files it. The
 *    participant then changes their answers — **the filed mail is now wrong and
 *    nothing says so.** The mail log is not even misleading about it, because
 *    the body is frozen at the enqueue („that is how it went out"); it is the *state*
 *    that moved on. Silent divergence is the expensive direction.
 * 2. The edit link is an **owner capability**. A mail on every change is the
 *    only way a participant ever learns that their link has leaked. That is not
 *    a convenience, it is the burglar alarm.
 *
 * ## How every case here measures
 *
 * By **counting `mail_log` rows before and after**, never by looking at a status
 * code. A mail is the one thing that cannot be taken back, so „the server did
 * *not* do the right thing" is the assertion that carries this file —
 * and a refused edit has to leave `response` alone as well.
 *
 * ## The negative probes, measured while writing this file
 *
 * Each is listed at the case it belongs to. In short: the „no change, no
 * mail" rule of 2026-07-29, the recipient derivation on the edit path
 * and both directions were removed/inverted one at a time and the named
 * case turned red each time. The trigger filter
 * (`triggers.includes`) survived becoming a set — removing it still turns the
 * two `save` cases red, on **both** paths.
 */

const PASSWORD = 'test-password';

const PAGE = '019ffb00-0000-7000-8000-0000000000a0';
const NAME_QUESTION = '019ffb00-0000-7000-8000-000000000001';
const PRIVATE_MAIL = '019ffb00-0000-7000-8000-000000000002';
/** The one with a „Sonstiges" box — see the `other: ''`/`other: null` case. */
const MEAL_QUESTION = '019ffb00-0000-7000-8000-000000000003';

const questionBase = { hint: null, required: false, width: 'full' as const };

const nameQuestion = {
  ...questionBase,
  id: NAME_QUESTION,
  type: 'text',
  label: 'Name',
  minLength: null,
  maxLength: null,
  pattern: null,
};
const mailQuestion = {
  ...questionBase,
  id: PRIVATE_MAIL,
  type: 'email',
  label: 'Private E-Mail',
};
const mealQuestion = {
  ...questionBase,
  id: MEAL_QUESTION,
  type: 'checkbox',
  label: 'Verpflegung',
  options: [{ value: 'fleisch', label: 'Mit Fleisch' }],
  allowOther: true,
  otherLabel: 'Sonstiges',
  minSelected: null,
  maxSelected: null,
};

const PRIVATE_ADDRESS = 'privat@example.org';
const OFFICE_ADDRESS = 'buero@example.org';

const FIRST_NAME = 'Anton Aktiv';
const CORRECTED_NAME = 'Anton Bandinsky';

const ANSWERS = {
  [NAME_QUESTION]: FIRST_NAME,
  [PRIVATE_MAIL]: PRIVATE_ADDRESS,
};
const CORRECTED = {
  [NAME_QUESTION]: CORRECTED_NAME,
  [PRIVATE_MAIL]: PRIVATE_ADDRESS,
};

function definition(): unknown {
  return {
    pages: [
      { id: PAGE, title: 'Anmeldung', questions: [nameQuestion, mailQuestion] },
    ],
  };
}

/** {@link definition}, plus the „Sonstiges" checkbox for the blank-spelling case. */
function definitionWithMeal(): unknown {
  return {
    pages: [
      {
        id: PAGE,
        title: 'Anmeldung',
        questions: [nameQuestion, mailQuestion, mealQuestion],
      },
    ],
  };
}

/** Documentation range (RFC 5737) — never a real caller. */
let nextAddress = 0;
function ownAddress(): string {
  nextAddress += 1;
  return `198.51.100.${String((nextAddress % 250) + 1)}`;
}

describe('what an accepted edit queues', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  let tenant: TenantFixture;
  let editor: string;
  let startTokens: StartTokenService;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    // **No transport at all.** SMTP is unconfigured, so nothing this file
    // queues ever leaves — rows stay `queued`, which is what lets this file
    // count them without a worker racing it. The delivery itself is proven
    // next door in `submission-mail.spec.ts`.
    testApp = await createTestApp({
      databaseUrl: database.url,
      // The installation's own address is a **row**, not
      // `PUBLIC_BASE_URL` of the environment. A suite
      // that asserts on absolute links has to put one there — which is also
      // what makes „if it is missing, there is no link" a state of its own.
      systemMail: { publicBaseUrl: TEST_PUBLIC_BASE_URL },
      // Own address per request: the public write routes allow 30 a minute per
      // address, and this file sends well over that.
      env: { TRUST_PROXY_HOPS: 1 },
    });
    startTokens = testApp.app.get(StartTokenService);

    tenant = await createTenant(testApp.prisma, 'EDITMAIL');
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

  async function publishedForm(
    title: string,
    def: unknown = definition(),
  ): Promise<Form> {
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
      .send({ title, definition: def, revision: form.revision });
    expect(saved.status).toBe(200);

    const published = await request(app().server)
      .post(apiPath(`/forms/${form.id}/publish`))
      .set(authedMutation(editor))
      .send({ revision: (saved.body as { revision: number }).revision });
    expect(published.status).toBe(200);

    return { id: form.id, slug: form.publicSlug };
  }

  async function addNotification(
    formId: string,
    body: object,
  ): Promise<string> {
    const created = await request(app().server)
      .post(apiPath(`/forms/${formId}/notifications`))
      .set(authedMutation(editor))
      // `replyTo` first, so a caller can still say something else about it:
      // the field is required and nullable without a default, and
      // this suite has nothing to say about it.
      .send({ replyTo: null, ...body });
    expect(created.status).toBe(201);
    return (created.body as { id: string }).id;
  }

  /**
   * Writes a form's settings through the real route.
   *
   * **Every section this form needs in one call.** The settings route is a `PUT`
   * over the whole override document, so configuring
   * *Verfügbarkeit* in a second call would drop the *Zugriff*-override and with
   * it `allowEdit` — which is exactly how a suite ends up green for the wrong
   * reason.
   */
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

  /** Editing on — the one setting these cases need. */
  function allowEditing(formId: string) {
    return configure(formId, { access: true }, { allowEdit: true });
  }

  async function submit(slug: string): Promise<request.Response> {
    return request(app().server)
      .post(apiPath(`/public/forms/${slug}/responses`))
      .set('X-Forwarded-For', ownAddress())
      .send({ answers: ANSWERS });
  }

  function writeEdit(
    token: string,
    body: Record<string, unknown> = { answers: CORRECTED },
  ): Promise<request.Response> {
    return request(app().server)
      .put(apiPath(`/public/responses/${token}`))
      .set('X-Forwarded-For', ownAddress())
      .send(body);
  }

  function tokenOf(editUrl: string): string {
    const token = editUrl.slice(editUrl.lastIndexOf('/') + 1);
    expect(token).not.toBe('');
    return token;
  }

  /** A submitted, editable answer — and the token that opens it. */
  async function editableAnswer(
    title: string,
  ): Promise<{ form: Form; token: string }> {
    const form = await publishedForm(title);
    await allowEditing(form.id);

    const submitted = await submit(form.slug);
    expect(submitted.status).toBe(200);
    const editUrl = (submitted.body as { editUrl: string | null }).editUrl;
    expect(editUrl).not.toBeNull();
    return { form, token: tokenOf(editUrl ?? '') };
  }

  function mailsOf(formId: string) {
    return app().prisma.mailLog.findMany({
      where: { formId },
      orderBy: { recipient: 'asc' },
    });
  }

  function answerOf(formId: string) {
    return app().prisma.response.findFirstOrThrow({
      where: { formId },
      select: { id: true, answers: true, editedAt: true },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 1 — an edit queues one row per recipient, with the **new** values
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * The whole point of the work item, in one case.
   *
   * Two recipients — the participant's own address out of the answer, and the
   * office — because „exactly one row" is a claim **per recipient** , and a case with one recipient could not tell the two readings
   * apart.
   *
   * The body carries `{{frage:…}}`, so the assertion is not „a row exists" but
   * „the row says what is true **now**". A change mail repeating the old value
   * would be the divergence it is supposed to announce.
   */
  it('queues one row per recipient, carrying the new values', async () => {
    const { form, token } = await editableAnswer('Bearbeitung meldet');
    await addNotification(form.id, {
      name: 'Änderung',
      triggers: ['edit'],
      subject: 'Anmeldung geändert',
      body: `Neuer Stand: ${questionPlaceholderToken(NAME_QUESTION)}.`,
      recipients: [
        { kind: 'question', questionId: PRIVATE_MAIL },
        { kind: 'literal', address: OFFICE_ADDRESS },
      ],
    });

    // The submission itself queues nothing — this notification fires on `edit`
    // alone, which is what makes the count below unambiguous.
    expect(await mailsOf(form.id)).toHaveLength(0);

    expect((await writeEdit(token)).status).toBe(200);

    const mails = await mailsOf(form.id);
    expect(mails.map((row) => row.recipient)).toEqual([
      OFFICE_ADDRESS,
      PRIVATE_ADDRESS,
    ]);
    for (const row of mails) {
      expect(row.status).toBe('queued');
      expect(row.trigger).toBe('edit');
      expect(row.tenantId).toBe(tenant.id);
      expect(row.bodyText).toContain(CORRECTED_NAME);
      expect(row.bodyText).not.toContain(FIRST_NAME);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 2 — without the trigger, nothing
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * A notification that fires only „Bei Absendung" stays silent on an edit —
   * and the **control** is in the same case: the very same notification is shown
   * to queue a row for the submission first. „No row" is trivially true of
   * a fixture that never sends anything.
   */
  it('queues nothing for an edit when only the submit trigger is set', async () => {
    const form = await publishedForm('Nur Absendung');
    await allowEditing(form.id);
    await addNotification(form.id, {
      name: 'Bestätigung',
      triggers: ['submit'],
      subject: 'Anmeldung eingegangen',
      body: 'Danke.',
      recipients: [{ kind: 'question', questionId: PRIVATE_MAIL }],
    });

    const submitted = await submit(form.slug);
    expect(submitted.status).toBe(200);
    // The control: this form demonstrably sends.
    const queued = await mailsOf(form.id);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.trigger).toBe('submit');
    await app().prisma.mailLog.deleteMany({ where: { formId: form.id } });

    const token = tokenOf(
      (submitted.body as { editUrl: string | null }).editUrl ?? '',
    );
    expect((await writeEdit(token)).status).toBe(200);

    expect(await mailsOf(form.id)).toHaveLength(0);
  });

  /** Both triggers on one notification: it fires twice, once per event. */
  it('queues on both events when both triggers are set', async () => {
    const form = await publishedForm('Absendung und Bearbeitung');
    await allowEditing(form.id);
    await addNotification(form.id, {
      name: 'Immer',
      triggers: ['submit', 'edit'],
      subject: 'Stand der Anmeldung',
      body: 'Danke.',
      recipients: [{ kind: 'question', questionId: PRIVATE_MAIL }],
    });

    const submitted = await submit(form.slug);
    expect(submitted.status).toBe(200);
    expect(await mailsOf(form.id)).toHaveLength(1);

    const token = tokenOf(
      (submitted.body as { editUrl: string | null }).editUrl ?? '',
    );
    expect((await writeEdit(token)).status).toBe(200);

    const mails = await mailsOf(form.id);
    expect(mails).toHaveLength(2);
    expect(mails.map((row) => row.trigger).sort()).toEqual(['edit', 'submit']);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 3 — no change, no mail (replaces the debounce)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * An edit that resubmits the **same** values queues nothing, though the
   * response is still stored and `editedAt` still moves.
   *
   * **Negative probe:** the `context.changes.length === 0` early return in
   * `storeEditWithMails` removed → this case turns red (one row appears).
   */
  it('queues nothing when the edit changes no answer, but still stores it', async () => {
    const { form, token } = await editableAnswer('Nichts geändert');
    await addNotification(form.id, {
      name: 'Änderung',
      triggers: ['edit'],
      subject: 'Anmeldung geändert',
      body: `Neuer Stand: ${questionPlaceholderToken(NAME_QUESTION)}.`,
      recipients: [{ kind: 'question', questionId: PRIVATE_MAIL }],
    });

    const before = await answerOf(form.id);
    expect(before.editedAt).toBeNull();

    // The exact same values the submission already carries — a resend, not a
    // correction, e.g. a doubled click on „Speichern".
    expect((await writeEdit(token, { answers: ANSWERS })).status).toBe(200);

    expect(await mailsOf(form.id)).toHaveLength(0);
    const after = await answerOf(form.id);
    expect(after.editedAt).not.toBeNull();
    expect(after.answers).toEqual(before.answers);
  });

  /**
   * Regression for the rule above: a **real** correction still queues exactly
   * one row per recipient, precisely as before this work item. Without it, „no
   * change, no mail" could quietly have swallowed everything.
   */
  it('still queues one row per recipient for an edit with exactly one changed answer', async () => {
    const { form, token } = await editableAnswer('Eine Änderung');
    await addNotification(form.id, {
      name: 'Änderung',
      triggers: ['edit'],
      subject: 'Anmeldung geändert',
      body: `Neuer Stand: ${questionPlaceholderToken(NAME_QUESTION)}.`,
      recipients: [
        { kind: 'question', questionId: PRIVATE_MAIL },
        { kind: 'literal', address: OFFICE_ADDRESS },
      ],
    });

    expect((await writeEdit(token)).status).toBe(200);

    const mails = await mailsOf(form.id);
    expect(mails.map((row) => row.recipient)).toEqual([
      OFFICE_ADDRESS,
      PRIVATE_ADDRESS,
    ]);
  });

  /**
   * Two edits with **different** changes queue **two** rows, each carrying its
   * own, independent change block — what used to be the debounce's subject
   * („two edits while the first is still `queued`") now demonstrates the
   * opposite: nothing here is suppressed any more, because both edits really
   * changed something.
   */
  it('queues a separate row with its own change block for each of two differing edits', async () => {
    const { form, token } = await editableAnswer('Zweimal hintereinander');
    await addNotification(form.id, {
      name: 'Änderung',
      triggers: ['edit'],
      subject: 'Anmeldung geändert',
      body: `Neuer Stand: ${questionPlaceholderToken(NAME_QUESTION)}.`,
      recipients: [{ kind: 'question', questionId: PRIVATE_MAIL }],
    });

    expect((await writeEdit(token)).status).toBe(200);
    const first = await mailsOf(form.id);
    expect(first).toHaveLength(1);
    expect(first[0]?.bodyText).toContain(CORRECTED_NAME);

    expect(
      (
        await writeEdit(token, {
          answers: { ...CORRECTED, [NAME_QUESTION]: 'Anton Corrigiert' },
        })
      ).status,
    ).toBe(200);

    const mails = await mailsOf(form.id);
    expect(mails).toHaveLength(2);
    // The **second** row carries the second edit's own change block — the
    // first is frozen and untouched, the second
    // is a row of its own rather than a rewrite.
    const second = mails.find((row) => row.id !== first[0]?.id);
    expect(second?.bodyText).toContain('Anton Corrigiert');
    expect(await answerOf(form.id)).toMatchObject({
      answers: { [NAME_QUESTION]: 'Anton Corrigiert' },
    });
  });

  /**
   * **Unreadable previous values are not „nothing changed"** — the row still
   * queues. A stored `answers` column that is not an object at all (a
   * hand-written or restored row) makes `storedAnswersSchema.safeParse` take
   * the `null` branch (`public-forms.service.ts`); the edit rule has to fail
   * towards sending, not towards silence, when it cannot tell.
   *
   * **Negative probe:** the check inverted to `previousAnswers === null &&
   * context.changes.length === 0` (silencing the unreadable case instead of
   * exempting it) → this case turns red.
   */
  it('queues the row when the stored previous answers are unreadable', async () => {
    const { form, token } = await editableAnswer('Kaputte Vorwerte');
    await addNotification(form.id, {
      name: 'Änderung',
      triggers: ['edit'],
      subject: 'Anmeldung geändert',
      body: `Neuer Stand: ${questionPlaceholderToken(NAME_QUESTION)}.`,
      recipients: [{ kind: 'question', questionId: PRIVATE_MAIL }],
    });

    const stored = await answerOf(form.id);
    // An array, not merely an object with the wrong keys — a shape
    // `storedAnswersSchema` (`z.record`) refuses outright, so this cannot pass
    // by accident of matching keys.
    await app().prisma.response.update({
      where: { id: stored.id },
      data: { answers: [] },
    });

    // Same values as before the corruption — were the previous answers
    // readable, this would be „nothing changed". They are not, so it queues.
    expect((await writeEdit(token, { answers: ANSWERS })).status).toBe(200);

    expect(await mailsOf(form.id)).toHaveLength(1);
  });

  /**
   * The double spelling of a fully blank choice answer (`values: []` with
   * `other: ''` vs. `other: null`) proves nothing here for the row-level
   * spelling itself: with no option selected on either side, `answerChanges`
   * already reads both as blank outright (`isBlankAnswer`,
   * `notification-render.ts`), so this case would stay green even without the
   * `other`-collapse it was named after — checked at the 2026-07-29 review
   *  by disabling that collapse alone.
   *
   * **And since the requirement it no longer even reaches the column that
   * way**: both submissions below are canonicalised on the way in, so the two
   * documents this case compares are identical. It stays because the assertion
   * it makes is still true and still worth guarding — that this spelling
   * produces no `mail_log` row through the real enqueue path in
   * `storeEditWithMails`, end to end. The case that needs the collapse *after*
   * the fix is the **legacy-data** one, where the previous side comes out of the
   * column rather than through the validator:
   * `test/public/canonical-other.spec.ts`.
   */
  it('queues nothing for an edit that only swaps other: "" for other: null', async () => {
    const form = await publishedForm(
      'Sonstiges umgeschrieben',
      definitionWithMeal(),
    );
    await allowEditing(form.id);
    await addNotification(form.id, {
      name: 'Änderung',
      triggers: ['edit'],
      subject: 'Anmeldung geändert',
      body: `Neuer Stand: ${questionPlaceholderToken(NAME_QUESTION)}.`,
      recipients: [{ kind: 'question', questionId: PRIVATE_MAIL }],
    });

    const submitted = await request(app().server)
      .post(apiPath(`/public/forms/${form.slug}/responses`))
      .set('X-Forwarded-For', ownAddress())
      .send({
        answers: { ...ANSWERS, [MEAL_QUESTION]: { values: [], other: '' } },
      });
    expect(submitted.status).toBe(200);
    const token = tokenOf(
      (submitted.body as { editUrl: string | null }).editUrl ?? '',
    );

    expect(
      (
        await writeEdit(token, {
          answers: { ...ANSWERS, [MEAL_QUESTION]: { values: [], other: null } },
        })
      ).status,
    ).toBe(200);

    expect(await mailsOf(form.id)).toHaveLength(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 4 — a refused edit changes nothing and queues nothing
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * The refusal chain of the edit route is its own, and its order is
   * load-bearing: 404 → 503 *fail closed* → 409 `editing_disabled` →
   * 409 deadline. The **response limit does not apply** there, the **time
   * limit** does, and the **password gate** does not.
   *
   * What this helper asserts is the sentence that has to hold for each of them:
   * neither the answer nor the log moved.
   */
  async function expectRefusedWithoutTrace(
    form: Form,
    token: string,
    reason: string,
    body: Record<string, unknown> = { answers: CORRECTED },
  ): Promise<void> {
    const before = await answerOf(form.id);
    const mailsBefore = await mailsOf(form.id);

    const refused = await writeEdit(token, body);

    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ reason });
    expect(await answerOf(form.id)).toEqual(before);
    expect(await mailsOf(form.id)).toHaveLength(mailsBefore.length);
  }

  /**
   * A form that **demonstrably** queues on an edit, and is then restricted.
   *
   * The proving edit in the middle is what makes the refusal cases mean
   * something: „no row after a refusal" is trivially true of a form
   * that never queues anything at all.
   */
  async function provenChangeMail(
    title: string,
  ): Promise<{ form: Form; token: string }> {
    const { form, token } = await editableAnswer(title);
    await addNotification(form.id, {
      name: 'Änderung',
      triggers: ['edit'],
      subject: 'Anmeldung geändert',
      body: 'Geändert.',
      recipients: [{ kind: 'question', questionId: PRIVATE_MAIL }],
    });

    expect((await writeEdit(token)).status).toBe(200);
    expect(await mailsOf(form.id)).toHaveLength(1);
    await app().prisma.mailLog.deleteMany({ where: { formId: form.id } });

    return { form, token };
  }

  it('queues nothing and changes nothing once the deadline has passed', async () => {
    const { form, token } = await provenChangeMail('Frist abgelaufen');
    await configure(
      form.id,
      { access: true },
      {
        allowEdit: true,
        openEnabled: true,
        closeAt: '2020-01-01T00:00:00.000Z',
      },
    );

    await expectRefusedWithoutTrace(form, token, 'closed');
  });

  it('queues nothing and changes nothing once editing is switched off', async () => {
    const { form, token } = await provenChangeMail('Bearbeiten aus');
    await configure(form.id, { access: true }, { allowEdit: false });

    await expectRefusedWithoutTrace(form, token, 'editing_disabled');
  });

  it('queues nothing and changes nothing when the time limit has run out', async () => {
    const { form, token } = await provenChangeMail('Zeitlimit');
    await configure(
      form.id,
      { access: true },
      { allowEdit: true, timeLimitEnabled: true, timeLimitMin: 1 },
    );

    // The application's own signer, so the token is one this server accepts —
    // only its instant is old.
    const stale = startTokens.issue(form.slug, new Date(Date.now() - 600_000));

    await expectRefusedWithoutTrace(form, token, 'time_limit', {
      answers: CORRECTED,
      startToken: stale,
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 5 — „Bei Zwischenspeichern" holds on **both** paths
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * A hand-written `['save']` row: **readable, and sent by nothing**.
   *
   * The row is written straight into the database because the API refuses
   * `save` on the way in (`notificationTriggersInputSchema`). That is exactly
   * why it is worth a case — the non-goal would otherwise hold only where a
   * client can reach, and a row from a future migration or from `psql` would
   * start sending mail nobody asked for.
   *
   * The trigger filter became `triggers.includes(…)` with this work item, and
   * this is where that is measured: `['save'].includes('submit')` and
   * `['save'].includes('edit')` are both false, so **both** halves are asserted
   * here rather than only the submission's.
   */
  it('never sends a `save` row — neither on submit nor on edit — and still lists it', async () => {
    const form = await publishedForm('Zwischenspeichern');
    await allowEditing(form.id);
    await app().prisma.notification.create({
      data: {
        tenantId: tenant.id,
        formId: form.id,
        name: 'Beim Zwischenspeichern',
        triggers: ['save'],
        subject: 'Zwischenstand',
        body: 'Danke.',
        toSubmitter: true,
        recipients: [{ kind: 'question', questionId: PRIVATE_MAIL }],
      },
    });

    const submitted = await submit(form.slug);
    expect(submitted.status).toBe(200);
    expect(await mailsOf(form.id)).toHaveLength(0);

    const token = tokenOf(
      (submitted.body as { editUrl: string | null }).editUrl ?? '',
    );
    expect((await writeEdit(token)).status).toBe(200);
    expect(await mailsOf(form.id)).toHaveLength(0);

    // …and it is still listable. A read schema that refused it would turn a row
    // the application correctly ignores into a page nobody can open.
    const listed = await request(app().server)
      .get(apiPath(`/forms/${form.id}/notifications`))
      .set('Cookie', cookieHeader(editor));
    expect(listed.status).toBe(200);
    expect(
      (listed.body as { notifications: { triggers: string[] }[] })
        .notifications[0]?.triggers,
    ).toEqual(['save']);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Who gets a change mail — and that nothing stands in front of it any more
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * ⚠️ Three cases stood here around the switch *Bestätigung an Teilnehmer
   * senden*, which no longer exists (review finding 24, 2026-08-14). What
   * remains is the question this path really answers: a change notification to
   * a question address goes to the person filling in, one to the office goes
   * to the office — and both go out because they are set up.
   */
  it('queues a change mail to the address the participant typed', async () => {
    const { form, token } = await editableAnswer('An den Teilnehmer');
    await addNotification(form.id, {
      name: 'Änderung an den Teilnehmer',
      triggers: ['edit'],
      subject: 'Anmeldung geändert',
      body: 'Geändert.',
      recipients: [{ kind: 'question', questionId: PRIVATE_MAIL }],
    });

    expect((await writeEdit(token)).status).toBe(200);

    expect(await answerOf(form.id)).toMatchObject({
      answers: { [NAME_QUESTION]: CORRECTED_NAME },
    });
    const mails = await mailsOf(form.id);
    expect(mails).toHaveLength(1);
    expect(mails[0]?.recipient).toBe(PRIVATE_ADDRESS);
  });

  it('queues the office notification on the edit path too', async () => {
    const { form, token } = await editableAnswer('An das Büro');
    await addNotification(form.id, {
      name: 'Änderung an das Büro',
      triggers: ['edit'],
      subject: 'Eine Anmeldung wurde geändert',
      body: 'Geändert.',
      recipients: [{ kind: 'literal', address: OFFICE_ADDRESS }],
    });

    expect((await writeEdit(token)).status).toBe(200);

    const mails = await mailsOf(form.id);
    expect(mails).toHaveLength(1);
    expect(mails[0]?.recipient).toBe(OFFICE_ADDRESS);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 7 — `{{aenderungen}}`: what this edit changed, frozen at the enqueue
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * **The change block is built at the enqueue, from values that stop existing
   * a statement later** .
   *
   * There is no history of answers in this system: the old values live in the
   * row the `UPDATE` is about to overwrite. So this is not a rendering question
   * that could be deferred to the send step — it is a *read ordering* question,
   * and these cases go through the real route precisely because that ordering
   * is invisible to a unit test that is handed both documents.
   *
   * The shared package proves the escaping and the layout
   * (`mail-template.test.ts`), and `notification-render.spec.ts` proves which
   * answers count as changed — including the `other: ''`/`other: null` pair,
   * which needs a choice question this form does not have.
   */

  const CHANGES = systemPlaceholderToken('aenderungen');

  /** A form whose change mail carries the block, and the token that edits it. */
  async function changeMailForm(
    title: string,
    body = `Das ist neu:\n${CHANGES}`,
    triggers: readonly string[] = ['edit'],
  ): Promise<{ form: Form; token: string }> {
    const { form, token } = await editableAnswer(title);
    await addNotification(form.id, {
      name: 'Änderung',
      triggers: [...triggers],
      format: 'html',
      subject: 'Anmeldung geändert',
      body,
      recipients: [{ kind: 'literal', address: OFFICE_ADDRESS }],
    });
    return { form, token };
  }

  /** the evidence — exactly the changed question, in both halves of the mail. */
  it('names the changed answer with its old and new value, in text and HTML', async () => {
    const { form, token } = await changeMailForm('Änderungsblock');

    expect((await writeEdit(token)).status).toBe(200);

    const [row] = await mailsOf(form.id);
    // Since finding 34 the question stands on a line of its own and beneath
    // it the two values, each with its word beside it — the old version
    // `Name: alt → neu` was, with two long values, one line in which one had
    // to search for the arrow (`renderChangeTable` in `@formsache/shared`).
    expect(row?.bodyText).toContain(
      `Name\n  Bisher: ${FIRST_NAME}\n  Neu:    ${CORRECTED_NAME}`,
    );
    // In the HTML checked against the values and their captions, not against
    // the cell shape: the juxtaposition is no longer a three-column table but
    // a card per changed question.
    expect(row?.bodyHtml).toContain(FIRST_NAME);
    expect(row?.bodyHtml).toContain(CORRECTED_NAME);
    expect(row?.bodyHtml).toContain('>Bisher<');
    expect(row?.bodyHtml).toContain('>Neu<');
    // The unchanged answer is **absent**, not merely further down: with it the
    // block would be `{{antworten}}` with two columns more, and the one
    // sentence a change mail carries would be buried in the rows that did not
    // move. Its caption *and* its value, since either alone could be missing
    // for the wrong reason.
    expect(row?.bodyText).not.toContain('Private E-Mail');
    expect(row?.bodyText).not.toContain(PRIVATE_ADDRESS);
    expect(row?.bodyHtml).not.toContain('Private E-Mail');
  });

  /**
   * the evidence — **both** values are defused, the old one as much as the new.
   *
   * A stranger typed the old value into a public form, it sat in the database,
   * and the same stranger typed the new one: two contributions, one boundary.
   * A defusing pass applied to the „current" column alone would pass a test that
   * only carried the malicious value on one side, which is why both sides carry
   * it here.
   *
   * **Negative probe:** `neutralise` dropped from `renderChangeTable`
   * (`packages/shared/src/mail-template.ts`) → this case turns red in both
   * formats.
   */
  it('escapes an old and a new value that carry markup', async () => {
    const attack = '<img src=x onerror=alert(1)>';
    const form = await publishedForm('Änderungsblock escaped');
    await allowEditing(form.id);
    await addNotification(form.id, {
      name: 'Änderung',
      triggers: ['edit'],
      format: 'html',
      subject: 'Anmeldung geändert',
      body: CHANGES,
      recipients: [{ kind: 'literal', address: OFFICE_ADDRESS }],
    });

    // Submitted with the attack already in it, so the **old** value is the
    // dangerous one too.
    const submitted = await request(app().server)
      .post(apiPath(`/public/forms/${form.slug}/responses`))
      .set('X-Forwarded-For', ownAddress())
      .send({
        answers: { ...ANSWERS, [NAME_QUESTION]: `${attack}alt` },
      });
    expect(submitted.status).toBe(200);
    const token = tokenOf(
      (submitted.body as { editUrl: string | null }).editUrl ?? '',
    );

    expect(
      (
        await writeEdit(token, {
          answers: { ...ANSWERS, [NAME_QUESTION]: `${attack}neu` },
        })
      ).status,
    ).toBe(200);

    const [row] = await mailsOf(form.id);
    const html = row?.bodyHtml ?? '';
    // Positively: both sides arrive as text…
    expect(html.match(/&lt;img/g)).toHaveLength(2);
    // …negatively: no element, and no attribute inside one.
    expect(html).not.toMatch(/<[^>]*onerror/i);
    expect(html).not.toContain('<img');
    // The table itself survived — escaping our own markup as well would
    // satisfy both assertions above and send an unreadable mail.
    expect(html).toContain('<table');
    // The plain-text alternative is a separate render path and carries the same
    // promise; there the markup is removed rather than escaped.
    expect(row?.bodyText).not.toMatch(/<[a-zA-Z]/);
    expect(row?.bodyText).toContain('  Bisher: alt\n  Neu:    neu');
  });

  /**
   * the evidence — **an earlier row's body does not move when the answer moves
   * again.**
   *
   * Since 2026-07-29 a second edit that really changes something is no longer
   * suppressed (the specification above) — it queues its **own** row instead. What this case
   * asks is whether the *first* row still says what it said once that second
   * row exists. It has to: each body is assembled once, from the values as
   * they stood at its own enqueue, and a body that re-rendered later would
   * describe a step the office was never told about at the time — or, once the
   * older values are gone, describe nothing at all.
   */
  it('leaves an earlier row untouched when the answer changes again', async () => {
    const { form, token } = await changeMailForm('Eingefroren');

    expect((await writeEdit(token)).status).toBe(200);
    const first = await mailsOf(form.id);
    expect(first).toHaveLength(1);
    expect(first[0]?.bodyText).toContain(
      `Name\n  Bisher: ${FIRST_NAME}\n  Neu:    ${CORRECTED_NAME}`,
    );

    expect(
      (
        await writeEdit(token, {
          answers: { ...CORRECTED, [NAME_QUESTION]: 'Anton Cerevis' },
        })
      ).status,
    ).toBe(200);

    // The answer really did move on — otherwise this holds for the wrong
    // reason.
    expect(await answerOf(form.id)).toMatchObject({
      answers: { [NAME_QUESTION]: 'Anton Cerevis' },
    });

    // A second row now exists, carrying the second edit's own block…
    const mails = await mailsOf(form.id);
    expect(mails).toHaveLength(2);
    const second = mails.find((row) => row.id !== first[0]?.id);
    expect(second?.bodyText).toContain('Anton Cerevis');

    // …and the first is untouched — not rewritten to describe the later step.
    const original = mails.find((row) => row.id === first[0]?.id);
    expect(original?.bodyText).toBe(first[0]?.bodyText);
    expect(original?.bodyHtml).toBe(first[0]?.bodyHtml);
    expect(original?.bodyText).not.toContain('Cerevis');
  });

  /**
   * the evidence — **on a submission the placeholder is empty and the sentence
   * stands.**
   *
   * One notification, both triggers: since 2026-07-28 the same template can be
   * reached by a submission and by an edit, so „here the placeholder has
   * nothing to say" is the ordinary case. „Resolves to nothing" must not
   * become „the line falls away", which is why the surrounding text is asserted
   * positively — and the edit in the same case is the control that the block is
   * not simply always empty.
   */
  it('renders the block to nothing on a submission, keeping the text around it', async () => {
    const form = await publishedForm('Beide Auslöser');
    await allowEditing(form.id);
    await addNotification(form.id, {
      name: 'Stand der Anmeldung',
      triggers: ['submit', 'edit'],
      subject: 'Stand der Anmeldung',
      body: `Vorher. ${CHANGES} Nachher.`,
      recipients: [{ kind: 'literal', address: OFFICE_ADDRESS }],
    });

    const submitted = await submit(form.slug);
    expect(submitted.status).toBe(200);

    const [confirmation] = await mailsOf(form.id);
    expect(confirmation?.trigger).toBe('submit');
    expect(confirmation?.bodyText).toContain('Vorher.');
    expect(confirmation?.bodyText).toContain('Nachher.');
    // Neither the token nor the „(leer)" marker of a row that should not exist.
    expect(confirmation?.bodyText).not.toContain('aenderungen');
    expect(confirmation?.bodyText).not.toContain('(leer)');

    const token = tokenOf(
      (submitted.body as { editUrl: string | null }).editUrl ?? '',
    );
    expect((await writeEdit(token)).status).toBe(200);

    const change = (await mailsOf(form.id)).find(
      (row) => row.trigger === 'edit',
    );
    expect(change?.bodyText).toContain(
      `Name\n  Bisher: ${FIRST_NAME}\n  Neu:    ${CORRECTED_NAME}`,
    );
  });

  /**
   * a review finding of the 2026-07-28 review: a stored `answers` column that is not
   * an object at all — a hand-written or restored row —, so
   * `storedAnswersSchema.safeParse` takes the `null` branch
   * (`public-forms.service.ts`). The block must render to **nothing**, same
   * as a submission (the evidence above), and specifically **not** to „every
   * question was just filled in": that is what treating the unparseable
   * document as `{}` would say instead, since every current answer would then
   * read as newly answered against a blank.
   */
  it('renders the block to nothing when the stored answers are not an object at all', async () => {
    const { form, token } = await changeMailForm('Kaputte Vorwerte');
    const stored = await answerOf(form.id);
    // An array, not merely an object with the wrong keys — a shape
    // `storedAnswersSchema` (`z.record`) refuses outright, so this cannot
    // pass by accident of matching keys.
    await app().prisma.response.update({
      where: { id: stored.id },
      data: { answers: [] },
    });

    expect((await writeEdit(token)).status).toBe(200);

    const change = (await mailsOf(form.id)).find(
      (row) => row.trigger === 'edit',
    );
    expect(change?.bodyText).toContain('Das ist neu:');
    expect(change?.bodyText).not.toContain('(leer)');
    expect(change?.bodyText).not.toContain('Name:');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // The edit path: answer and mail commit together
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * **Direction A — the write of the answer fails at COMMIT.**
   *
   * The fault is a `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED` on
   * `response`, so it raises at commit: the `UPDATE` has already run, the
   * `mail_log` rows have already been written, and only then does the
   * transaction fail. That placement is the whole point — a fault *before* the
   * update would leave this green with the enqueue in a transaction of its own.
   *
   * **Negative probe:** the enqueue moved *behind* `this.prisma.$transaction`
   * in `storeEditWithMails` → this case turns red (a row is left behind), and
   * direction B stays green. That asymmetry is the reason both exist; it was
   * measured for the submission path and holds here identically.
   */
  it('leaves no mail behind when storing the edited answer fails at commit', async () => {
    const { form, token } = await provenChangeMail('Speichern scheitert');
    const before = await answerOf(form.id);

    await guard(
      'CREATE OR REPLACE FUNCTION test_fail_response_update() RETURNS trigger ' +
        "LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'response blocked by test'; END $$",
      'CREATE CONSTRAINT TRIGGER test_response_edit_commit_guard AFTER UPDATE ON "response" ' +
        'DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_fail_response_update()',
      async () => {
        // A **further** change, not a repeat of `provenChangeMail`'s own edit
        // (which already left the answer at `CORRECTED`) — since 2026-07-29 a
        // no-op edit never reaches `createMany`, let alone the `response`
        // `UPDATE` this trigger guards, which would make this case pass
        // without the fault ever firing (a finding of the 2026-07-29 review).
        //
        // Nothing is promised to the participant either — a confirmation for a
        // correction that was rolled back is the same lie in the other
        // direction.
        expect(
          (
            await writeEdit(token, {
              answers: {
                ...CORRECTED,
                [NAME_QUESTION]: 'Anton Speicherfehler',
              },
            })
          ).status,
        ).toBe(500);
      },
      'DROP TRIGGER test_response_edit_commit_guard ON "response"',
      'DROP FUNCTION test_fail_response_update()',
    );

    expect(await answerOf(form.id)).toEqual(before);
    expect(await mailsOf(form.id)).toHaveLength(0);
  });

  /**
   * **Direction B — the enqueue fails, and it is the more expensive one.**
   *
   * „Answer changed, change mail never created" produces no error anybody
   * sees: the participant reads „Vielen Dank", the organisation's filed mail stays
   * wrong, and nobody learns of it — which is precisely the silence this work
   * item exists to break. So a failing enqueue has to take the correction with
   * it.
   *
   * **Negative probe:** the enqueue given a `$transaction` of its own → this
   * case turns red (the answer is changed anyway) and direction A stays green.
   */
  it('stores no edit when the enqueue fails', async () => {
    const { form, token } = await provenChangeMail('Einreihen scheitert');
    const before = await answerOf(form.id);

    await guard(
      'CREATE OR REPLACE FUNCTION test_fail_mail_log_edit() RETURNS trigger ' +
        "LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'mail_log blocked by test'; END $$",
      'CREATE TRIGGER test_mail_log_edit_guard BEFORE INSERT ON "mail_log" ' +
        'FOR EACH ROW EXECUTE FUNCTION test_fail_mail_log_edit()',
      async () => {
        // A **further** change, not a repeat of `provenChangeMail`'s own edit —
        // since 2026-07-29 a no-op edit never reaches `createMany` at all
        // (the specification above), which would make this guard fire for the wrong reason.
        expect(
          (
            await writeEdit(token, {
              answers: { ...CORRECTED, [NAME_QUESTION]: 'Anton Einreihfehler' },
            })
          ).status,
        ).toBe(500);
      },
      'DROP TRIGGER test_mail_log_edit_guard ON "mail_log"',
      'DROP FUNCTION test_fail_mail_log_edit()',
    );

    expect(await answerOf(form.id)).toEqual(before);
    expect(await mailsOf(form.id)).toHaveLength(0);
  });

  /**
   * Installs a database-level fault, runs the case, and takes the fault out
   * again whatever happened.
   *
   * A trigger rather than a mocked repository: the claim here is about a
   * *transaction*, and a fault injected above the database would be a fault in a
   * layer the transaction does not live in.
   */
  async function guard(
    createFunction: string,
    createTrigger: string,
    run: () => Promise<void>,
    dropTrigger: string,
    dropFunction: string,
  ): Promise<void> {
    await app().prisma.$executeRawUnsafe(createFunction);
    await app().prisma.$executeRawUnsafe(createTrigger);
    try {
      await run();
    } finally {
      await app().prisma.$executeRawUnsafe(dropTrigger);
      await app().prisma.$executeRawUnsafe(dropFunction);
    }
  }
});
