import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  questionPlaceholderToken,
  systemPlaceholderToken,
} from '@formsache/shared';

import { MailWorkerService } from '../../src/mail/mail-worker.service';
import { mailBackoffMs } from '../../src/mail/mail-backoff';
import type { SUBMISSION_REFUSAL_MESSAGES } from '../../src/public/public-forms.service';
import {
  NO_RECIPIENT_PLACEHOLDER,
  UNREADABLE_RECIPIENTS_REASON,
} from '../../src/public/submission-mail';
import { StartTokenService } from '../../src/public/start-token.service';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import { MutableClock } from '../mail/mail-test-context';
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
import { MAIL_CATEGORY_REJECTED } from '../../src/mail/mail-error-category';
import { authedMutation, openSession } from '../support/http';
import { SmtpDouble } from '../support/smtp-double';

/**
 * **What an accepted submission sets off** (the requirements).
 *
 * Every case here counts rows in **`mail_log`**, and the refusal cases count
 * `response` as well. A mail is the one thing that cannot be taken back,
 * so „hat der Server das Richtige *nicht* getan" is the assertion that carries
 * this file — the status code alone would look identical either way.
 *
 * ## The negative probes, measured while writing this file
 *
 * - **The recipient resolution aimed at the *other* e-mail question**
 *   (`resolveRecipients` reading the first question id instead of the named
 *   one): the two-questions case turns red, because it asserts the **address in
 *   the row**, not the number of rows. Both questions are answered, with
 *   different addresses, so a count-based test would have stayed green.
 * - **The trigger filter removed** (`notification.trigger !== 'submit'`): the
 *   `save` case turns red. It is the only case that says the non-goal holds on
 *   the server, and its row is written straight into the database, because the
 *   API refuses `save` on the way in.
 * - **The `active` filter removed**: the paused case turns red.
 * - **The enqueue moved out of the transaction** (a second `prisma` call after
 *   the response is written): both fault cases turn red.
 *
 * ## What the suite deliberately does *not* re-prove
 *
 * The escaping, the CR/LF removal in a subject and the „one entry, one address"
 * rule are the requirement and are unit-proven in `packages/shared`
 * (`mail-template.test.ts`). Repeating them through HTTP would be slower, and a
 * second spelling of the expectation is a second thing to keep in step.
 */

const PASSWORD = 'test-password';

const PAGE = '019ff900-0000-7000-8000-0000000000a0';
const NAME_QUESTION = '019ff900-0000-7000-8000-000000000001';
const PRIVATE_MAIL = '019ff900-0000-7000-8000-000000000002';
const TENANT_MAIL = '019ff900-0000-7000-8000-000000000003';
/** A callout, not a question — the Infotext of the requirement. */
const NOTICE = '019ff900-0000-7000-8000-000000000004';
const NOTICE_TEXT = 'Bitte pünktlich erscheinen.';

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

/** Two address questions with **different** answers — the heart of the address-not-count case. */
const privateMailQuestion = {
  ...questionBase,
  id: PRIVATE_MAIL,
  type: 'email',
  label: 'Private E-Mail',
};
const tenantMailQuestion = {
  ...questionBase,
  id: TENANT_MAIL,
  type: 'email',
  label: 'E-Mail der Organisation',
};

const noticeQuestion = {
  ...questionBase,
  id: NOTICE,
  type: 'info',
  label: NOTICE_TEXT,
};

const PRIVATE_ADDRESS = 'privat@example.org';
const TENANT_ADDRESS = 'organisation@example.org';

const ANSWERS = {
  [NAME_QUESTION]: 'Anton Aktiv',
  [PRIVATE_MAIL]: PRIVATE_ADDRESS,
  [TENANT_MAIL]: TENANT_ADDRESS,
};

function definition(): unknown {
  return {
    pages: [
      {
        id: PAGE,
        title: 'Anmeldung',
        questions: [
          nameQuestion,
          privateMailQuestion,
          tenantMailQuestion,
          noticeQuestion,
        ],
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

describe('what an accepted submission queues', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  let tenant: TenantFixture;
  let editor: string;
  let transport: SmtpDouble;
  let clock: MutableClock;
  let worker: MailWorkerService;
  let startTokens: StartTokenService;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    // **The mail server is dead for the first delivery attempt of this file,
    // and answers afterwards** — the requirement's „jede Verbindung wird
    // verweigert", followed by „geht raus, sobald der Transport antwortet".
    //
    // One double for the whole suite rather than a swap mid-flight: exactly one
    // case here drives the worker, so the script is untouched until it does,
    // and every other case can assert `attemptCount === 0` to say that the
    // request path never sends.
    transport = new SmtpDouble({
      script: ['fail'],
      failureMessage: 'ECONNREFUSED',
    });
    clock = new MutableClock(new Date());
    testApp = await createTestApp({
      databaseUrl: database.url,
      // Own address per request: the public submit route allows 30 a minute per
      // address, and this file sends well over that. The limit itself is proven
      // in `public-forms.spec.ts`.
      env: { TRUST_PROXY_HOPS: 1 },
      transport,
      clock,
    });
    worker = testApp.app.get(MailWorkerService);
    startTokens = testApp.app.get(StartTokenService);

    tenant = await createTenant(testApp.prisma, 'MAIL');
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
    // Every case counts rows of its own form, but the one worker case drains
    // the whole queue — a leftover row from a previous case would be delivered
    // by a run that never mentions it.
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

  /** The switch of the requirement — off by default. */
  async function submit(
    slug: string,
    body: Record<string, unknown> = {},
  ): Promise<request.Response> {
    return request(app().server)
      .post(apiPath(`/public/forms/${slug}/responses`))
      .set('X-Forwarded-For', ownAddress())
      .send({ answers: ANSWERS, ...body });
  }

  function mailsOf(formId: string) {
    return app().prisma.mailLog.findMany({
      where: { formId },
      orderBy: { recipient: 'asc' },
    });
  }

  function responseCount(formId: string): Promise<number> {
    return app().prisma.response.count({ where: { formId } });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // The participant mail, the named question, the trigger
  // ═══════════════════════════════════════════════════════════════════════

  it('queues exactly one row for the participant', async () => {
    const form = await publishedForm('Teilnehmer-Bestätigung');
    await addNotification(form.id, {
      name: 'Bestätigung',
      subject: 'Anmeldung eingegangen',
      body: 'Danke.',
      recipients: [{ kind: 'question', questionId: PRIVATE_MAIL }],
    });

    expect((await submit(form.slug)).status).toBe(200);

    const mails = await mailsOf(form.id);
    expect(mails).toHaveLength(1);
    expect(mails[0]?.recipient).toBe(PRIVATE_ADDRESS);
    expect(mails[0]?.status).toBe('queued');
    expect(mails[0]?.tenantId).toBe(tenant.id);
  });

  /**
   * **The address, not the count.**
   *
   * Both e-mail questions are answered, with different addresses, and the
   * notification names the **second**. A test that counted rows would be green
   * with the resolution aimed at either one; this one names the address that
   * has to be in the row.
   */
  it('sends to the question the notification names, not to the first one', async () => {
    const form = await publishedForm('Zwei E-Mail-Fragen');
    await addNotification(form.id, {
      name: 'An die gewählte Adresse',
      subject: 'Anmeldung eingegangen',
      body: 'Danke.',
      recipients: [{ kind: 'question', questionId: TENANT_MAIL }],
    });

    expect((await submit(form.slug)).status).toBe(200);

    const mails = await mailsOf(form.id);
    expect(mails).toHaveLength(1);
    expect(mails[0]?.recipient).toBe(TENANT_ADDRESS);
    expect(mails[0]?.recipient).not.toBe(PRIVATE_ADDRESS);
  });

  /**
   * „abwesend, nicht deaktiviert" **holds on the server**.
   *
   * The row is written straight into the database because the API refuses
   * `save` on the way in (`notificationTriggerInputSchema`). That is exactly
   * why the case is worth having: without it, the non-goal would be enforced
   * only where a client can reach, and a row from a future migration — or
   * from `psql` — would start sending mail nobody asked for.
   */
  it('ignores a notification whose trigger is „save"', async () => {
    const form = await publishedForm('Zwischenspeichern');
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

    expect((await submit(form.slug)).status).toBe(200);

    expect(await responseCount(form.id)).toBe(1);
    expect(await mailsOf(form.id)).toHaveLength(0);
  });

  it('ignores a paused notification', async () => {
    const form = await publishedForm('Pausiert');
    const id = await addNotification(form.id, {
      name: 'Bestätigung',
      subject: 'Anmeldung eingegangen',
      body: 'Danke.',
      recipients: [{ kind: 'question', questionId: PRIVATE_MAIL }],
      active: false,
    });
    expect(id).toBeTruthy();

    expect((await submit(form.slug)).status).toBe(200);
    expect(await mailsOf(form.id)).toHaveLength(0);
  });

  /**
   * A notification to the organisation's office, side by side with the
   * participant's — one row **per recipient**, which is what makes „↻ Erneut"
   * per address possible at all.
   */
  it('queues one row per recipient of an office notification', async () => {
    const form = await publishedForm('An das Büro');
    await addNotification(form.id, {
      name: 'An das Büro',
      subject: 'Neue Anmeldung',
      body: 'Es gibt eine neue Anmeldung.',
      recipients: [
        { kind: 'literal', address: 'buero@example.org' },
        { kind: 'literal', address: 'kassenwart@example.org' },
      ],
    });

    expect((await submit(form.slug)).status).toBe(200);

    const mails = await mailsOf(form.id);
    expect(mails.map((row) => row.recipient)).toEqual([
      'buero@example.org',
      'kassenwart@example.org',
    ]);
    expect(mails.every((row) => row.status === 'queued')).toBe(true);
  });

  /**
   * **A question address is the address of the person filling in** , and that independently of the column `to_submitter`.
   *
   * **Written straight into the database on purpose.** The write side derives
   * the flag from the chip (`NotificationsService`), so this exact row can no
   * longer be created through the API — which is precisely why the enforcing
   * half needs its own case: it has to hold for a row that came from a
   * migration, from an older version of this application, or from a shell.
   */
  it('queues a hand-written row whose only marker is the question chip', async () => {
    const form = await publishedForm('Chip ohne Häkchen');
    await app().prisma.notification.create({
      data: {
        tenantId: tenant.id,
        formId: form.id,
        name: 'Bestätigung ohne Häkchen',
        subject: 'Anmeldung eingegangen',
        body: 'Danke.',
        // The combination the API refuses to write and the database accepts.
        toSubmitter: false,
        recipients: [{ kind: 'question', questionId: PRIVATE_MAIL }],
      },
    });

    expect((await submit(form.slug)).status).toBe(200);

    const mails = await mailsOf(form.id);
    expect(mails).toHaveLength(1);
    expect(mails[0]?.recipient).toBe(PRIVATE_ADDRESS);
    expect(mails[0]?.status).toBe('queued');
  });

  /**
   * …and the other legacy shape: a row with `to_submitter = true` and only one
   * literal address. It goes out like any other — the difference the column
   * once made vanished with the switch.
   */
  it('queues a legacy `to_submitter` row with only a literal recipient', async () => {
    const form = await publishedForm('Häkchen ohne Frage-Empfänger');
    await app().prisma.notification.create({
      data: {
        tenantId: tenant.id,
        formId: form.id,
        name: 'Altes Häkchen',
        subject: 'Anmeldung eingegangen',
        body: 'Danke.',
        toSubmitter: true,
        recipients: [{ kind: 'literal', address: 'buero@example.org' }],
      },
    });

    expect((await submit(form.slug)).status).toBe(200);

    const mails = await mailsOf(form.id);
    expect(mails).toHaveLength(1);
    expect(mails[0]?.recipient).toBe('buero@example.org');
    expect(mails[0]?.status).toBe('queued');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // A notification that reaches nobody says so — it does not vanish
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * The ordinary case, and the one that used to disappear without a trace: an
   * **optional** e-mail question the participant left blank.
   *
   * Nothing is wrong with the notification and nothing is wrong with the
   * answer — and yet the confirmation everybody expects does not exist. That is
   * the same failure shape the `invalid` branch already refuses to commit for
   * an unparseable address, so it gets the same treatment: a `failed` line with
   * a reason, in the mail log where somebody can see it.
   */
  it('records a failed line when the addressed question was left blank', async () => {
    const form = await publishedForm('Adresse nicht ausgefüllt');
    await addNotification(form.id, {
      name: 'Bestätigung',
      subject: 'Anmeldung eingegangen',
      body: 'Danke.',
      recipients: [{ kind: 'question', questionId: PRIVATE_MAIL }],
    });

    // Only the name — both e-mail questions are optional and stay empty.
    const answered = await submit(form.slug, {
      answers: { [NAME_QUESTION]: 'Anton Aktiv' },
    });
    expect(answered.status).toBe(200);
    expect(await responseCount(form.id)).toBe(1);

    const mails = await mailsOf(form.id);
    expect(mails).toHaveLength(1);
    expect(mails[0]?.status).toBe('failed');
    expect(mails[0]?.recipient).toBe(NO_RECIPIENT_PLACEHOLDER);
    // **The caption, not the id.** „die Frage 019ff900-…" is a sentence nobody
    // can act on; the label is what the editor sees in the builder.
    expect(mails[0]?.lastError).toContain('Private E-Mail');
    expect(mails[0]?.lastError).toContain('nicht beantwortet');
  });

  /**
   * An unreadable `recipients` column: nothing is sent, and — the half that was
   * missing — it is written down.
   *
   * Guessing a list would mean sending to addresses nobody can see on screen,
   * so the silence about *sending* is right. The silence about *the whole
   * event* was not: this is the one state in which „es ging keine Mail raus" had
   * no other trace at all.
   */
  it('records a failed line when the stored recipients cannot be read', async () => {
    const form = await publishedForm('Empfänger unlesbar');
    await app().prisma.notification.create({
      data: {
        tenantId: tenant.id,
        formId: form.id,
        name: 'Kaputte Empfänger',
        subject: 'Anmeldung eingegangen',
        body: 'Danke.',
        // JSONB accepts any JSON; this application never wrote this.
        recipients: { irgendwas: 'anderes' },
      },
    });

    expect((await submit(form.slug)).status).toBe(200);

    const mails = await mailsOf(form.id);
    expect(mails).toHaveLength(1);
    expect(mails[0]?.status).toBe('failed');
    expect(mails[0]?.recipient).toBe(NO_RECIPIENT_PLACEHOLDER);
    expect(mails[0]?.lastError).toBe(UNREADABLE_RECIPIENTS_REASON);
  });

  /**
   * **Every written line names the tenant, the form and the answer it came
   * from — and `mail_log` has nothing underneath it that would notice
   * otherwise** .
   *
   * `response` and `form_version` stand on the composite foreign key
   * `(form_id, tenant_id)`, so a row pairing Organisation A's tenant with Organisation B's form
   * is refused by PostgreSQL. Here it is not: Prisma cannot express a composite
   * key where the relation is optional and the tenant is required, so the only
   * thing preventing that pairing is that both values come out of **one**
   * resolved form row at the write site (`toMailLogRow`). Until this case
   * existed, only the *reading* side of that boundary was tested.
   *
   * The last assertion is a raw join over the whole table rather than over the
   * rows this case wrote: a per-row check that reads `form_id` back from a query
   * filtered by `form_id` cannot fail.
   */
  it('pairs every queued line with the tenant, form and answer it came from', async () => {
    const form = await publishedForm('Fremdschlüssel von Hand');
    await addNotification(form.id, {
      name: 'Bestätigung',
      subject: 'Anmeldung eingegangen',
      body: 'Danke.',
      recipients: [{ kind: 'question', questionId: PRIVATE_MAIL }],
    });
    await addNotification(form.id, {
      name: 'An das Büro',
      subject: 'Neue Anmeldung',
      body: 'Es gibt eine neue Anmeldung.',
      recipients: [{ kind: 'literal', address: 'buero@example.org' }],
    });

    expect((await submit(form.slug)).status).toBe(200);

    const stored = await app().prisma.form.findUniqueOrThrow({
      where: { id: form.id },
      select: { id: true, tenantId: true },
    });
    const response = await app().prisma.response.findFirstOrThrow({
      where: { formId: form.id },
      select: { id: true },
    });

    const mails = await mailsOf(form.id);
    expect(mails).toHaveLength(2);
    for (const row of mails) {
      expect(row.tenantId).toBe(stored.tenantId);
      expect(row.formId).toBe(stored.id);
      // The reference the body renderer resolves at send time — a line without
      // it renders no mail and fails for a reason that reads like a defect.
      expect(row.responseId).toBe(response.id);
    }

    const crossed = await app().prisma.$queryRaw<
      { count: bigint }[]
    >`SELECT count(*) AS "count" FROM "mail_log" m
        JOIN "form" f ON f."id" = m."form_id"
        LEFT JOIN "response" r ON r."id" = m."response_id"
       WHERE f."tenant_id" <> m."tenant_id"
          OR (r."id" IS NOT NULL AND r."form_id" <> m."form_id")`;
    expect(crossed[0]?.count).toBe(0n);
  });

  it('renders the subject against the version of the answer', async () => {
    const form = await publishedForm('Betreff');
    await addNotification(form.id, {
      name: 'An das Büro',
      subject: `Anmeldung von ${questionPlaceholderToken(NAME_QUESTION)} (${systemPlaceholderToken('formularorganisation')})`,
      body: 'Danke.',
      recipients: [{ kind: 'literal', address: 'buero@example.org' }],
    });

    expect((await submit(form.slug)).status).toBe(200);

    const mails = await mailsOf(form.id);
    expect(mails[0]?.subject).toBe(
      'Anmeldung von Anton Aktiv (Organisation MAIL)',
    );
  });

  /**
   * **a review finding, measured on the sending path** — „keine
   * Frage, keine Antwort"  holds for the mail that really goes out,
   * not only for the preview in the editor.
   *
   * Before the fix, the enqueued confirmation carried a real row
   * `<tr><th>Bitte pünktlich erscheinen.</th><td></td></tr>` for an Infotext;
   * the preview did not show it, because it had **a second** filter
   * (`sample-context.ts`). The case therefore stands here, at the `mail_log`
   * body: it is frozen at the enqueue and is exactly what gets delivered
   * (`frozen-mail-body.spec.ts`), while the preview never reaches a recipient.
   *
   * **Negative probe:** `answerableQuestions` in `notification-render.ts`
   * turned back to `allQuestions` → both halves red, text as well as HTML.
   */
  it('leaves the Infotext out of the answer table it queues', async () => {
    const form = await publishedForm('Infotext');
    await addNotification(form.id, {
      name: 'An das Büro',
      subject: 'Anmeldung eingegangen',
      format: 'html',
      body: `Das kam an:\n${systemPlaceholderToken('antworten')}`,
      recipients: [{ kind: 'literal', address: 'buero@example.org' }],
    });

    expect((await submit(form.slug)).status).toBe(200);

    const [row] = await mailsOf(form.id);
    // The positive side first: the table is there and carries the questions,
    // the unanswered ones too — otherwise the rest below would be green for
    // every empty mail.
    expect(row?.bodyHtml).toContain('Anton Aktiv');
    expect(row?.bodyHtml).toContain('Private E-Mail');
    // And now the row that must not exist — in both halves, for they are two
    // separate render passes (`renderNotificationBody`).
    expect(row?.bodyHtml).not.toContain(NOTICE_TEXT);
    expect(row?.bodyText).not.toContain(NOTICE_TEXT);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // The refusals of the enforcement gate queue nothing
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * **The chain is in front of the enqueue, and each of its links is checked
   * here** .
   *
   * `response` *and* `mail_log`, both unchanged: a refusal that had already
   * queued the confirmation is the one defect of this milestone that nothing
   * can undo, and it would be invisible in a test that only read the status.
   */
  async function expectRefusedWithoutMail(
    form: Form,
    reason: keyof typeof SUBMISSION_REFUSAL_MESSAGES,
    body: Record<string, unknown> = {},
  ): Promise<void> {
    const responsesBefore = await responseCount(form.id);
    const answered = await submit(form.slug, body);

    expect(answered.status).toBe(409);
    expect(answered.body).toMatchObject({ reason });
    expect(await responseCount(form.id)).toBe(responsesBefore);
    expect(await mailsOf(form.id)).toHaveLength(0);
  }

  /**
   * A form that **demonstrably** sends, and is then restricted.
   *
   * The control submission in the middle is what makes every case below mean
   * something. „Keine `mail_log`-Zeile nach einer Ablehnung" is trivially true
   * of a form that never queues anything — a mistyped fixture, a settings write
   * that dropped a section, an inactive notification — and the refusal cases
   * would all stay green while proving nothing at all. So the form is made to
   * queue exactly one row *first*, the row is cleared, and only then does the
   * rule that will refuse the next submission go in.
   *
   * **One write per state.** The settings route is a `PUT` over the whole
   * document: a second write with fewer sections would give the remaining ones
   * back to the default.
   */
  async function provenSendingForm(
    title: string,
    overridden: Record<string, boolean> = {},
    values: Record<string, unknown> = {},
  ): Promise<Form> {
    const form = await publishedForm(title);
    await addNotification(form.id, {
      name: 'Bestätigung',
      subject: 'Anmeldung eingegangen',
      body: 'Danke.',
      recipients: [{ kind: 'question', questionId: PRIVATE_MAIL }],
    });

    expect((await submit(form.slug)).status).toBe(200);
    expect(await mailsOf(form.id)).toHaveLength(1);
    await app().prisma.mailLog.deleteMany({ where: { formId: form.id } });

    if (Object.keys(values).length > 0) {
      await configure(form.id, overridden, values);
    }
    return form;
  }

  it('queues nothing when the deadline has passed', async () => {
    const form = await provenSendingForm(
      'Frist abgelaufen',
      {},
      { openEnabled: true, closeAt: '2020-01-01T00:00:00.000Z' },
    );

    await expectRefusedWithoutMail(form, 'closed');
  });

  it('queues nothing when the response limit is reached', async () => {
    // The control submission of the helper takes the only seat, so the limit
    // bites on the next one.
    const form = await provenSendingForm(
      'Limit erreicht',
      {},
      { maxResponsesEnabled: true, maxResponses: 1 },
    );

    await expectRefusedWithoutMail(form, 'limit_reached');
  });

  it('queues nothing without the access word', async () => {
    const form = await provenSendingForm(
      'Zugangswort',
      { access: true },
      { passwordEnabled: true, password: 'Fuxenstall2026' },
    );

    await expectRefusedWithoutMail(form, 'password_required');
  });

  it('queues nothing when the time limit has run out', async () => {
    const form = await provenSendingForm(
      'Zeitlimit',
      {},
      { timeLimitEnabled: true, timeLimitMin: 1 },
    );

    // The application's own signer, so the token is one this server accepts —
    // only its instant is old.
    const stale = startTokens.issue(form.slug, new Date(Date.now() - 600_000));

    await expectRefusedWithoutMail(form, 'time_limit', { startToken: stale });
  });

  it('queues nothing for an address that leads nowhere (404)', async () => {
    // No control here, and none is possible: an unknown slug resolves to no
    // form, so there is nothing that *would* have sent. What the case says is
    // that the 404 of the public routes is raised before anything is written.
    const answered = await request(app().server)
      .post(apiPath('/public/forms/AAAAAAAAAAAAAAAAAAAAAA/responses'))
      .set('X-Forwarded-For', ownAddress())
      .send({ answers: ANSWERS });

    expect(answered.status).toBe(404);
    expect(await app().prisma.mailLog.count()).toBe(0);
  });

  it('queues nothing when the answers do not validate (400)', async () => {
    const form = await provenSendingForm('Ungültige Antwort');
    const responsesBefore = await responseCount(form.id);

    const answered = await submit(form.slug, {
      answers: { ...ANSWERS, [PRIVATE_MAIL]: 'kein-adressat' },
    });

    expect(answered.status).toBe(400);
    expect(await responseCount(form.id)).toBe(responsesBefore);
    expect(await mailsOf(form.id)).toHaveLength(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // The delivery does not hang off the submission
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * **Test A of the requirement.** The transport refuses every connection — a
   * double rather than a switched-off server, because it refuses
   * deterministically instead of after whatever TCP timeout the host has.
   *
   * Both halves are asserted: the **status** and the **content of the
   * confirmation**. „Kein 500" alone would still be green with the send pulled
   * into the request path and merely swallowed.
   */
  it('confirms the submission although the mail server is dead, and sends later', async () => {
    const form = await publishedForm('Mailserver tot');
    await addNotification(form.id, {
      name: 'Bestätigung',
      subject: 'Anmeldung eingegangen',
      body: `Hallo ${questionPlaceholderToken(NAME_QUESTION)}, danke.`,
      recipients: [{ kind: 'question', questionId: PRIVATE_MAIL }],
    });

    const answered = await submit(form.slug);

    // The confirmation itself, not only its status: the sentence a participant
    // reads is what „die Absendung antwortet trotzdem mit der Bestätigung"
    // means.
    expect(answered.status).toBe(200);
    expect(answered.body).toMatchObject({
      confirmationTitle: 'Vielen Dank!',
      confirmationMessage:
        'Die Antwort wurde übermittelt. Diese Seite kann jetzt geschlossen werden.',
    });
    expect(await responseCount(form.id)).toBe(1);

    const queued = await mailsOf(form.id);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.status).toBe('queued');
    // Nothing has been attempted yet — the request path does not send.
    expect(queued[0]?.attempts).toBe(0);
    expect(transport.attemptCount).toBe(0);

    // Now the worker runs while the server is still refusing. This is the one
    // case in the file that drives the worker, which is why the shared double
    // can carry the „first attempt fails" script for the whole suite.
    const failedRun = await worker.runOnce();
    expect(failedRun).toMatchObject({ attempted: 1, sent: 0, deferred: 1 });

    const deferred = await mailsOf(form.id);
    // **`queued`, not `failed`** — nothing was delivered and nothing was
    // refused for good.
    expect(deferred[0]?.status).toBe('queued');
    expect(deferred[0]?.attempts).toBe(1);
    // **A category, not the wording of the other side.** Since ADR-0023 an
    // organisation sends over its own block, and for that the categorised
    // style applies (`queueReasonStyle`): the reader of this row is the
    // organisation, and an `ECONNREFUSED` passed straight through would be the
    // port scanner from ADR-0013 „Consequences".
    expect(deferred[0]?.lastError).toBe(MAIL_CATEGORY_REJECTED);
    expect(deferred[0]?.lastError).not.toContain('ECONNREFUSED');

    // …and it goes out as soon as the transport answers. Past the backoff
    // by moving the injected clock, never by sleeping.
    clock.advance(mailBackoffMs(1) + 1_000);
    const goodRun = await worker.runOnce();
    expect(goodRun).toMatchObject({ attempted: 1, sent: 1 });

    const sent = await mailsOf(form.id);
    expect(sent[0]?.status).toBe('sent');
    expect(sent[0]?.sentAt).not.toBeNull();

    // The body was rebuilt from the notification and the answer at send time —
    // `mail_log` never carried it (`schema.prisma`).
    const delivered = transport.attempts.at(-1);
    expect(delivered?.to).toBe(PRIVATE_ADDRESS);
    expect(delivered?.subject).toBe('Anmeldung eingegangen');
    expect(delivered?.text).toContain('Hallo Anton Aktiv, danke.');
    // The display name is the organisation's, the address is the installation's.
    expect(delivered?.fromName).toBe('Organisation MAIL');
  });

  /**
   * **Test B of the requirement — the one the requirement calls „der eigentliche
   * Nachweis".**
   *
   * The fault is a `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED` on
   * `response`, so it raises at **COMMIT**: the insert of the answer has
   * already run, the `mail_log` rows have already been written, and only then
   * does the transaction fail. That placement is the whole point — a fault
   * *before* the `response.create` (a bad slug, a deadline, an invalid answer)
   * would leave this green with the enqueue in a transaction of its own, and
   * would prove nothing about them sharing one.
   *
   * What it discriminates: an implementation that committed the `mail_log`
   * rows separately — the obvious shape, „write the answer, then queue the
   * mail" — leaves them behind when the answer rolls back, and the count below
   * is not zero.
   */
  it('leaves no mail behind when storing the answer fails at commit', async () => {
    const form = await provenSendingForm('Speichern scheitert');
    // The helper's control submission is on file; what this case asks is
    // whether the **next** one leaves anything behind.
    const responsesBefore = await responseCount(form.id);

    await guard(
      'CREATE OR REPLACE FUNCTION test_fail_response() RETURNS trigger ' +
        "LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'response blocked by test'; END $$",
      'CREATE CONSTRAINT TRIGGER test_response_commit_guard AFTER INSERT ON "response" ' +
        'DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_fail_response()',
      async () => {
        const answered = await submit(form.slug);
        // Nothing is promised to the participant either — a confirmation for an
        // answer that was rolled back would be the same lie in the other
        // direction.
        expect(answered.status).toBe(500);
      },
      'DROP TRIGGER test_response_commit_guard ON "response"',
      'DROP FUNCTION test_fail_response()',
    );

    expect(await responseCount(form.id)).toBe(responsesBefore);
    expect(await mailsOf(form.id)).toHaveLength(0);
  });

  /**
   * **The symmetry, and it is the more expensive direction.**
   *
   * „Antwort gespeichert, Bestätigung nie erzeugt" produces no error anybody
   * sees: the participant reads „Vielen Dank", the organisation sees a registration,
   * and the missing mail is noticed weeks later by the person who did not
   * receive it. So the enqueue failing has to take the answer with it.
   */
  it('stores no answer when the enqueue fails', async () => {
    const form = await provenSendingForm('Einreihen scheitert');
    const responsesBefore = await responseCount(form.id);

    await guard(
      'CREATE OR REPLACE FUNCTION test_fail_mail_log() RETURNS trigger ' +
        "LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'mail_log blocked by test'; END $$",
      'CREATE TRIGGER test_mail_log_guard BEFORE INSERT ON "mail_log" ' +
        'FOR EACH ROW EXECUTE FUNCTION test_fail_mail_log()',
      async () => {
        expect((await submit(form.slug)).status).toBe(500);
      },
      'DROP TRIGGER test_mail_log_guard ON "mail_log"',
      'DROP FUNCTION test_fail_mail_log()',
    );

    expect(await responseCount(form.id)).toBe(responsesBefore);
    expect(await mailsOf(form.id)).toHaveLength(0);
  });

  /**
   * Installs a database-level fault, runs the case, and takes the fault out
   * again whatever happened.
   *
   * A trigger rather than a mocked repository: the claim here is about a
   * *transaction*, and a fault injected above the database would be a fault in
   * a layer the transaction does not live in.
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
