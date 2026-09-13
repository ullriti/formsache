import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { MAIL_LOG_HONEYPOT_NOT_RETRYABLE_MESSAGE } from '../../src/mail-log/mail-log.service';
import { HONEYPOT_SUPPRESSION_REASON } from '../../src/public/mail-suppression';
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
 * **The honeypot at the call site** — the requirement, the half a previous package
 * deliberately did not build.
 *
 * That earlier package shipped the rule (`src/public/honeypot.spec.ts`), the wire field and the
 * rendered decoy, and refused to write these three cases because without the
 * call site they would have been green while measuring nothing. This file is
 * where they become measurements.
 *
 * ⚠️ **A honeypot never proves that it works — only that it does no harm.**
 * All three assertions are negative, and that is the honest thing to say about
 * the measure rather than a gap: it must not lose a registration, it must not
 * change what the sender is told, and with the decoy left alone it must change
 * nothing at all.
 *
 * ## The negative probes, measured while writing this file
 *
 * - **the check removed** (the `honeypotFilled` arm of
 *   `PublicFormsService.suppressed`): the first case turns red — the row is
 *   `queued` and there is no reason to read.
 * - **the check made to discard the answer** (`return` before
 *   `tx.response.create`): the first case turns red on
 *   `expect(responses).toBe(1)` and on the stored answers, **before** it looks
 *   at `mail_log`. That is the load-bearing half: a password manager filling a
 *   hidden field is a real case, and a silently discarded registration is the
 *   data loss nobody notices.
 * - **the refusal answered differently** (any change to the body or the
 *   status on the suppressed path): the byte-equality case turns red.
 *
 * ## Why byte-equality lives here and not in Playwright
 *
 * It is a statement about the **response the server builds**, down to the byte,
 * and a browser cannot see one: it sees a rendered page. `e2e/public-form-honeypot.spec.ts`
 * keeps what only a real browser can measure — visibility, focus order, the
 * accessibility tree — and proves that a filled decoy still shows „Vielen
 * Dank!". The bytes are asserted here, where they exist.
 */

const PASSWORD = 'test-password';

const PAGE = '019fff00-0000-7000-8000-0000000000a0';
const NAME_QUESTION = '019fff00-0000-7000-8000-000000000001';
const MAIL_QUESTION = '019fff00-0000-7000-8000-000000000002';

const OFFICE_ADDRESS = 'buero@example.org';
const PARTICIPANT_ADDRESS = 'privat@example.org';

/** A plausible value — what an automated filler leaves behind. */
const BAIT = 'https://spam.example';

const questionBase = { hint: null, required: false, width: 'full' as const };

function definition(): unknown {
  return {
    pages: [
      {
        id: PAGE,
        title: 'Anmeldung',
        questions: [
          {
            ...questionBase,
            id: NAME_QUESTION,
            type: 'text',
            label: 'Name',
            minLength: null,
            maxLength: null,
            pattern: null,
          },
          {
            ...questionBase,
            id: MAIL_QUESTION,
            type: 'email',
            label: 'Private E-Mail',
          },
        ],
      },
    ],
  };
}

const ANSWERS = {
  [NAME_QUESTION]: 'Anton Aktiv',
  [MAIL_QUESTION]: PARTICIPANT_ADDRESS,
};

/** Documentation range (RFC 5737) — never a real caller. */
let nextAddress = 0;
function ownAddress(): string {
  nextAddress += 1;
  return `198.51.100.${String((nextAddress % 250) + 1)}`;
}

describe('Honeypot am Aufrufort ', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  let Organisation: TenantFixture;
  let editor: string;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({
      databaseUrl: database.url,
      env: { TRUST_PROXY_HOPS: 1 },
    });

    Organisation = await createTenant(testApp.prisma, 'HONE');
    const user = await createUser(testApp.prisma, {
      email: 'editor@example.org',
      password: PASSWORD,
      tenants: [Organisation],
    });
    editor = await openSession(testApp, user.id, Organisation.id);
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

  async function addNotification(formId: string): Promise<void> {
    const created = await request(app().server)
      .post(apiPath(`/forms/${formId}/notifications`))
      .set(authedMutation(editor))
      .send({
        name: 'An das Büro',
        subject: 'Anmeldung eingegangen',
        body: 'Danke.',
        recipients: [{ kind: 'literal', address: OFFICE_ADDRESS }],
        replyTo: null,
      });
    expect(created.status).toBe(201);
  }

  function submit(
    slug: string,
    body: Record<string, unknown> = {},
  ): Promise<request.Response> {
    return request(app().server)
      .post(apiPath(`/public/forms/${slug}/responses`))
      .set('X-Forwarded-For', ownAddress())
      .send({ answers: ANSWERS, ...body });
  }

  function mailsOf(formId: string) {
    return app().prisma.mailLog.findMany({ where: { formId } });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // the evidence — the response stands complete, the mail does not
  // ═══════════════════════════════════════════════════════════════════════

  it('behält die vollständige Antwort und deckelt nur die Mail', async () => {
    const form = await publishedForm('Köder gefüllt');
    await addNotification(form.id);

    const answered = await submit(form.slug, { honeypot: BAIT });
    expect(answered.status).toBe(200);

    // **First assertion, and the load-bearing one:** the registration is
    // there, with everything the sender wrote. A silently discarded record is
    // the loss nobody notices.
    const responses = await app().prisma.response.findMany({
      where: { formId: form.id },
    });
    expect(responses).toHaveLength(1);
    expect(responses[0]?.answers).toStrictEqual(ANSWERS);
    // The bait travels **beside** the answers and lands nowhere in them.
    expect(JSON.stringify(responses[0]?.answers)).not.toContain(BAIT);
    // Not in the log row either.
    expect(responses[0]?.editToken).not.toBeNull();

    const mails = await mailsOf(form.id);
    expect(mails).toHaveLength(1);
    expect(mails[0]?.status).toBe('failed');
    // The **text** of the column, not just the status.
    expect(mails[0]?.lastError).toBe(HONEYPOT_SUPPRESSION_REASON);
    // No `queued` row — nothing goes out.
    expect(mails.filter((mail) => mail.status === 'queued')).toHaveLength(0);
    // The row says whom it would have gone to, otherwise it is unreadable.
    expect(mails[0]?.recipient).toBe(OFFICE_ADDRESS);
    expect(mails[0]?.tenantId).toBe(Organisation.id);
    expect(JSON.stringify(mails[0]?.bodyText)).not.toContain(BAIT);
  }, 120_000);

  // ═══════════════════════════════════════════════════════════════════════
  // the evidence — empty field: everything as before
  // ═══════════════════════════════════════════════════════════════════════

  it('ändert nichts, wenn der Köder leer bleibt', async () => {
    const form = await publishedForm('Köder leer');
    await addNotification(form.id);

    // Three spellings of „empty", and the client of the application sends the
    // first on **every** submission (`FillIn.tsx`): that is the normal case,
    // not the edge case.
    for (const honeypot of ['', '   ', undefined]) {
      const answered = await submit(form.slug, { honeypot });
      expect(answered.status).toBe(200);
    }

    expect(
      await app().prisma.response.count({ where: { formId: form.id } }),
    ).toBe(3);

    const mails = await mailsOf(form.id);
    expect(mails).toHaveLength(3);
    expect(mails.every((mail) => mail.status === 'queued')).toBe(true);
    expect(mails.every((mail) => mail.lastError === null)).toBe(true);
  }, 120_000);

  // ═══════════════════════════════════════════════════════════════════════
  // the evidence — the answer to the sender is byte-identical
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Status **and** body, byte for byte.
   *
   * Whoever fills the bait must not be able to read anything off it —
   * otherwise a bot calibrates on exactly that and switches the measure off in
   * a single pass. The comparison runs on `res.text`, the unprocessed body:
   * `res.body` would be a parsed object and would let a changed order or an
   * additional space slip through.
   *
   * So that two submissions *can* be byte-identical at all, this form carries
   * no edit link: `editUrl` is `null`, because this installation has set no
   * base address (`create-test-app.ts`). That is no circumvention of the
   * assertion but its precondition — a token is different per response, and
   * what is compared here is everything else.
   */
  it('antwortet dem Absender byte-gleich zum Erfolgsfall', async () => {
    const form = await publishedForm('Köder byte-gleich');
    await addNotification(form.id);

    const clean = await submit(form.slug, { honeypot: '' });
    const baited = await submit(form.slug, { honeypot: BAIT });

    expect(baited.status).toBe(clean.status);
    expect(baited.text).toBe(clean.text);
    // No header giveaway: the body is of equal length and equally typed.
    expect(baited.headers['content-type']).toBe(clean.headers['content-type']);
    expect(baited.headers['content-length']).toBe(
      clean.headers['content-length'],
    );

    // …and the assertion really measures something: the second submission was
    // capped, the first was not.
    const mails = await mailsOf(form.id);
    expect(mails.filter((mail) => mail.status === 'queued')).toHaveLength(1);
    expect(mails.filter((mail) => mail.status === 'failed')).toHaveLength(1);
    expect(
      await app().prisma.response.count({ where: { formId: form.id } }),
    ).toBe(2);
  }, 120_000);

  // ═══════════════════════════════════════════════════════════════════════
  // the evidence — „↻ Erneut" must not send the intercepted mail after all
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * **The button that would undo the defence** (a security review finding).
   *
   * A baited submission puts a complete row into the mail log: recipient and
   * rendered body, both from a submission without login. Visibility is wanted
   * — sending is not. Up to here „↻ Erneut" coloured **every** `failed` row
   * back to `queued` without reading the reason: an editor who takes the row
   * for a false alarm (and the password-manager false alarm is the explicitly
   * planned-for case) would thereby have sent exactly the mail the honeypot
   * has just stopped.
   *
   * The case stands as a **pair**, otherwise it proves nothing: the ordinarily
   * failed row beside it must still be able to be sent again. Otherwise a
   * broken „↻ Erneut" would be green too — and the button is the only means of
   * an organisation whose mail server was away for an hour.
   */
  it('verweigert „↻ Erneut" auf einer geköderten Zeile — und nur auf ihr', async () => {
    const form = await publishedForm('Köder nicht nachversenden');
    await addNotification(form.id);

    // The ordinary row: real submission, then the state the worker leaves
    // behind after the last futile delivery.
    expect((await submit(form.slug, { honeypot: '' })).status).toBe(200);
    const ordinary = (await mailsOf(form.id))[0];
    await app().prisma.mailLog.update({
      where: { id: ordinary?.id ?? '' },
      data: {
        status: 'failed',
        attempts: 3,
        lastError: 'SMTP-Verbindung abgelehnt',
        nextAttemptAt: null,
      },
    });

    // And the baited one.
    expect((await submit(form.slug, { honeypot: BAIT })).status).toBe(200);
    const baited = (await mailsOf(form.id)).find(
      (mail) => mail.lastError === HONEYPOT_SUPPRESSION_REASON,
    );
    expect(baited).toBeDefined();

    // **The load-bearing assertion:** the button refuses, with a reason an
    // editor can read.
    const refused = await request(app().server)
      .post(apiPath(`/mail-log/${baited?.id ?? ''}/retry`))
      .set(authedMutation(editor));
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      message: MAIL_LOG_HONEYPOT_NOT_RETRYABLE_MESSAGE,
    });

    // …and the row stands unchanged: nothing was enqueued.
    const untouched = await app().prisma.mailLog.findUniqueOrThrow({
      where: { id: baited?.id ?? '' },
    });
    expect(untouched.status).toBe('failed');
    expect(untouched.lastError).toBe(HONEYPOT_SUPPRESSION_REASON);
    expect(untouched.nextAttemptAt).toBeNull();

    // **The counter-check**, without which the case measures nothing.
    const accepted = await request(app().server)
      .post(apiPath(`/mail-log/${ordinary?.id ?? ''}/retry`))
      .set(authedMutation(editor));
    expect(accepted.status).toBe(204);
    const requeued = await app().prisma.mailLog.findUniqueOrThrow({
      where: { id: ordinary?.id ?? '' },
    });
    expect(requeued.status).toBe('queued');
  }, 120_000);
});
