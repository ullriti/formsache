import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MailWorkerService } from '../../src/mail/mail-worker.service';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import { MutableClock } from '../mail/mail-test-context';
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
import { SmtpDouble } from '../support/smtp-double';

/**
 * **The trash holds the mail back** (a decision, 2026-08-03, out of a
 * review).
 *
 * ## The hole this closes
 *
 * The body of a queued mail is frozen into `mail_log.body_text/body_html` when
 * the answer arrives; the renderer only blanks `{{bearbeiten}}` at send
 * time. So deleting a form or an answer did **not** reach the one path that
 * actively carries data out of the house — it took the answer out of every
 * table and every view and left the mail about it on its way. And the recipient
 * of a notification can come out of the answer itself: an address the submitter
 * typed. Deleting is the only handle the interface gives an editor against a
 * form being misused, and it did not work on the way that matters.
 *
 * ## What is asserted, and why it is the transport
 *
 * „Der Worker hat nichts getan" is measurable in three places and only one of
 * them is worth anything: the **transport**. A run that claimed the row,
 * rendered it, asked SMTP and then wrote `queued` back would leave `status`
 * exactly as this suite finds it — and the mail would be out. So every case
 * below measures `SmtpDouble.attemptCount` first and the row second.
 *
 * ## And it is a withholding, not a failure
 *
 * `status` stays `queued`, `attempts` stays where it was: restoring the form or
 * the answer has to put the confirmation back on its way, or „gelöscht" would
 * be reversible for everything except the one thing that already left. That is
 * the same reading ADR-0013 no. 5 takes for an installation without a mail
 * server — nothing was refused, so nothing is recorded as refused.
 *
 * *Reproductions, measured on 2026-08-03 — see the individual cases.*
 */

const PASSWORD = 'test-password';

const PAGE = '019ffd00-0000-7000-8000-0000000000a0';
const NAME_QUESTION = '019ffd00-0000-7000-8000-000000000001';
const MAIL_QUESTION = '019ffd00-0000-7000-8000-000000000002';

/** The address the participant types in — the one deleting is meant to stop. */
const PARTICIPANT = 'anton@example.invalid';

const questionBase = { hint: null, required: false, width: 'full' as const };

const definition = {
  pages: [
    {
      id: PAGE,
      title: 'Anmeldung',
      description: null,
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
          label: 'E-Mail',
        },
      ],
    },
  ],
};

const ANSWERS = {
  [NAME_QUESTION]: 'Anton Aktiv',
  [MAIL_QUESTION]: PARTICIPANT,
};

/** Documentation range (RFC 5737) — never a real caller. */
let nextAddress = 0;
function ownAddress(): string {
  nextAddress += 1;
  return `198.51.100.${String((nextAddress % 250) + 1)}`;
}

describe('der Papierkorb hält eingereihte Mail zurück', () => {
  let database: TestDatabase | undefined;
  let testApp: TestApp;
  let tenant: TenantFixture;
  let editor: string;
  let transport: SmtpDouble;
  let worker: MailWorkerService;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    // Always answers: what is measured here is whether it is *asked*, never how
    // a refusal is recorded.
    transport = new SmtpDouble();
    testApp = await createTestApp({
      databaseUrl: database.url,
      systemMail: { publicBaseUrl: TEST_PUBLIC_BASE_URL },
      env: { TRUST_PROXY_HOPS: 1 },
      transport,
      clock: new MutableClock(new Date()),
    });
    worker = testApp.app.get(MailWorkerService);

    tenant = await createTenant(testApp.prisma, 'WITHHOLD');
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
      .send({ title, definition, revision: form.revision });
    expect(saved.status).toBe(200);

    const published = await request(app().server)
      .post(apiPath(`/forms/${form.id}/publish`))
      .set(authedMutation(editor))
      .send({ revision: (saved.body as { revision: number }).revision });
    expect(published.status).toBe(200);

    return { id: form.id, slug: form.publicSlug };
  }

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

  /**
   * A published form plus one notification to the address the participant
   * types in — the case the decision is about.
   */
  async function sendingForm(
    title: string,
  ): Promise<{ id: string; slug: string }> {
    const form = await publishedForm(title);
    await configure(
      form.id,
      { confirm: true, access: true },
      { allowEdit: true },
    );
    const created = await request(app().server)
      .post(apiPath(`/forms/${form.id}/notifications`))
      .set(authedMutation(editor))
      .send({
        name: 'Bestätigung',
        subject: 'Anmeldung eingegangen',
        body: 'Wir haben deine Anmeldung erhalten.',
        recipients: [{ kind: 'question', questionId: MAIL_QUESTION }],
        replyTo: null,
      });
    expect(created.status).toBe(201);
    return form;
  }

  /** One submission; returns the stored answer's id. */
  async function submit(slug: string): Promise<string> {
    const sent = await request(app().server)
      .post(apiPath(`/public/forms/${slug}/responses`))
      .set('X-Forwarded-For', ownAddress())
      .send({ answers: ANSWERS });
    expect(sent.status).toBe(200);

    const row = await app().prisma.response.findFirstOrThrow({
      where: { form: { publicSlug: slug } },
      orderBy: { submittedAt: 'desc' },
      select: { id: true },
    });
    return row.id;
  }

  /** The queued line for one form — the row this suite is about. */
  async function queuedRow(formId: string) {
    return app().prisma.mailLog.findFirstOrThrow({
      where: { formId, recipient: PARTICIPANT },
      select: { id: true, status: true, attempts: true, bodyText: true },
    });
  }

  /**
   * One worker run, reported as **what the outside world saw**.
   *
   * The count is taken around the run rather than read afterwards, because a
   * previous case's mail would otherwise make „nothing was sent" arithmetic
   * instead of an observation.
   */
  async function runWorker(): Promise<{ sends: number; sent: number }> {
    const before = transport.attemptCount;
    const run = await worker.runOnce();
    return { sends: transport.attemptCount - before, sent: run.sent };
  }

  function remove(path: string) {
    return request(app().server)
      .delete(apiPath(path))
      .set(authedMutation(editor));
  }

  function restore(path: string) {
    return request(app().server)
      .post(apiPath(path))
      .set(authedMutation(editor));
  }

  // ═════════════════════════════════════════════════════════════════════════

  /**
   * **The deleted answer.**
   *
   * The recipient here is an address out of the answer itself, which is the
   * whole reason this is a security property and not tidiness: deleting is what
   * an editor does when a form is used to send mail to somebody who did not ask
   * for it.
   *
   * *Reproduction, measured on 2026-08-03:* removing the `response` half of
   * `NOT_IN_TRASH` from `MailQueueRepository.claim` delivers **1 mail** where
   * `toBe(0)` is asserted — the confirmation for an answer that no longer
   * exists anywhere else.
   */
  it('sends nothing while the answer is in the Papierkorb, and sends after the restore', async () => {
    const form = await sendingForm('Antwort gelöscht');
    const answer = await submit(form.slug);
    const queued = await queuedRow(form.id);
    expect(queued.status).toBe('queued');
    expect(queued.bodyText).toContain('Wir haben deine Anmeldung erhalten.');

    expect((await remove(`/forms/${form.id}/responses/${answer}`)).status).toBe(
      204,
    );

    const withheld = await runWorker();
    // **The transport, first.** A run that claimed, rendered and asked SMTP
    // before writing `queued` back would leave the row exactly as below.
    expect(withheld.sends).toBe(0);
    expect(withheld.sent).toBe(0);
    expect(transport.attempts.map((mail) => mail.to)).not.toContain(
      PARTICIPANT,
    );

    // Held back, not failed: nothing was attempted, so nothing is counted.
    const stillQueued = await queuedRow(form.id);
    expect(stillQueued.status).toBe('queued');
    expect(stillQueued.attempts).toBe(0);

    expect(
      (await restore(`/forms/${form.id}/responses/${answer}/restore`)).status,
    ).toBe(204);

    const released = await runWorker();
    expect(released.sends).toBe(1);
    expect(transport.attempts.at(-1)?.to).toBe(PARTICIPANT);
    expect((await queuedRow(form.id)).status).toBe('sent');
  }, 120_000);

  /**
   * **The deleted form** — and it is a separate case because deleting a
   * form leaves its answers at `deleted_at IS NULL`. A condition that only
   * asked about the answer would be green above and wide open here.
   *
   * *Reproduction, measured on 2026-08-03:* removing the `form` half of
   * `NOT_IN_TRASH` delivers **1 mail** where `toBe(0)` is asserted.
   */
  it('sends nothing while the form is in the Papierkorb, and sends after the restore', async () => {
    const form = await sendingForm('Formular gelöscht');
    await submit(form.slug);
    expect((await queuedRow(form.id)).status).toBe('queued');

    expect((await remove(`/forms/${form.id}`)).status).toBe(204);

    const withheld = await runWorker();
    expect(withheld.sends).toBe(0);
    expect(withheld.sent).toBe(0);

    const stillQueued = await queuedRow(form.id);
    expect(stillQueued.status).toBe('queued');
    expect(stillQueued.attempts).toBe(0);
    // The answer was never in the trash — that is the state deleting a
    // form leaves, and the one an answer-only condition waves through.
    expect(
      await app().prisma.response.count({
        where: { formId: form.id, deletedAt: null },
      }),
    ).toBe(1);

    expect((await restore(`/forms/${form.id}/restore`)).status).toBe(204);

    const released = await runWorker();
    expect(released.sends).toBe(1);
    expect(transport.attempts.at(-1)?.to).toBe(PARTICIPANT);
    expect((await queuedRow(form.id)).status).toBe('sent');
  }, 120_000);

  /**
   * **An organisation whose whole queue is withheld must not eat a lane.**
   *
   * `dueTenants` carries the same condition, so an organisation with nothing claimable
   * is not handed one of the five lanes ahead of organisations that have something to
   * send. Measured as „the other organisation's mail goes out in the same run".
   */
  it('lets another organisation send in the same run', async () => {
    const held = await sendingForm('Zurückgehalten');
    const heldAnswer = await submit(held.slug);
    expect(
      (await remove(`/forms/${held.id}/responses/${heldAnswer}`)).status,
    ).toBe(204);

    const open = await sendingForm('Geht hinaus');
    await submit(open.slug);

    const run = await runWorker();
    expect(run.sends).toBe(1);
    expect((await queuedRow(open.id)).status).toBe('sent');
    expect((await queuedRow(held.id)).status).toBe('queued');
  }, 120_000);
});
