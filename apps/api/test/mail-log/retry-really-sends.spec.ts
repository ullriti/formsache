import { MAIL_MAX_ATTEMPTS } from '@formsache/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { mailBackoffMs } from '../../src/mail/mail-backoff';
import { MailWorkerService } from '../../src/mail/mail-worker.service';
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
 * The requirement, the half no single work package owned: **„↻ Erneut" leads to
 * an actual new attempt — „tatsächlich erneut versucht, nicht nur umgefärbt"**.
 *
 * Two suites already exist on either side of this seam and neither can make the
 * statement:
 *
 * - `mail-log.spec.ts` proves the **state change** the route
 *   writes — `queued`, `attempts = 0`, `next_attempt_at = jetzt`, the error text
 *   that stays, no second row. It says nothing about anybody acting on it.
 * - `mail-queue.spec.ts` proves the **worker** on rows the suite
 *   put there itself. It says nothing about the button.
 *
 * A row that is recoloured and never picked up would leave both of them green.
 * So this file walks the whole chain with one application, one transport and one
 * clock: a real submission queues a mail, the real worker burns it down to
 * `failed`, the real route requeues it, and the **transport counter** is what
 * decides whether anything happened.
 *
 * ## Why the counter alone is not the whole assertion
 *
 * Measured while writing this file, and it is the reason there is a second half:
 * `markFailed` sets `next_attempt_at` back to `NULL`, and the worker's claim
 * takes a `queued` row whose `next_attempt_at` is `NULL` or due. A requeue that
 * only wrote `status = 'queued'` would therefore **still** produce one attempt,
 * and a test that stopped at „der Zähler ist gestiegen" would stay green with
 * `attempts = 0` deleted from `ScopedMailLogDelegate.requeue`.
 *
 * What that deletion does change is what the click is *worth*: with the counter
 * left at five, the single attempt it buys is immediately terminal
 * (`attempts + 1 >= MAIL_MAX_ATTEMPTS`), so a mail server that is still down
 * takes the line straight back to `failed` and the next „↻ Erneut" is the same
 * dead end. With the counter reset the line has its full budget again. The
 * attempt after the requeue is therefore scripted to **fail**, and the assertion
 * is that the row comes back as `queued` with `attempts = 1` — the case that
 * distinguishes „wieder in der Warteschlange" from „einmal noch, dann endgültig
 * aus".
 *
 * ## The negative probes, measured while writing this file
 *
 * - `ScopedMailLogDelegate.requeue` reduced to `{ status: 'queued' }` (attempts
 *   and `next_attempt_at` untouched, as the specification asks): three
 *   cases go red, the first of them on `attempts` — and the transport counter
 *   **still rises**, for the reason above. The naive probe is the weaker one
 *   here, exactly as it is for `SKIP LOCKED` elsewhere.
 * - `requeue` made a no-op that still answers `true` — „nur umgefärbt", the
 *   failure the requirement names verbatim: the same three cases go red, starting
 *   at the state the route is supposed to have written, and the last run
 *   reports `attempted: 0` — the worker never claims the line, so the counter
 *   never moves at all.
 */

const PASSWORD = 'test-password';

const PAGE = '019ffa00-0000-7000-8000-0000000000a0';
const NAME_QUESTION = '019ffa00-0000-7000-8000-000000000001';

/** Where the office copy goes — `.invalid` can never resolve, see below. */
const OFFICE_ADDRESS = 'buero@example.invalid';

/** The reason the scripted transport gives — the *server's* words. */
const REFUSAL = '451 Mailserver antwortet nicht';

/**
 * What of it ends up in the row.
 *
 * Since ADR-0023 this organisation sends over its **own** mail server (it
 * inherits nothing any more), and for an own block the categorised style
 * applies: the reader of the mail log is the organisation, and a wording
 * passed straight through would be the port scanner from ADR-0013
 * „Consequences". A `451` is no known `nodemailer` code, so it falls back to
 * the general category — exactly the fail-closed direction written down there.
 */
const STORED_REASON = MAIL_CATEGORY_REJECTED;

const definition = {
  pages: [
    {
      id: PAGE,
      title: 'Anmeldung',
      questions: [
        {
          id: NAME_QUESTION,
          type: 'text',
          label: 'Name',
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
};

describe('„↻ Erneut" hands the line back to the worker ', () => {
  let database: TestDatabase | undefined;
  let testApp: TestApp | undefined;
  let app: TestApp;

  let transport: SmtpDouble;
  let clock: MutableClock;
  let worker: MailWorkerService;
  let tenant: TenantFixture;
  let editor: string;

  /** The one row this file follows from `queued` through `failed` and back. */
  let mailLogId: string;

  beforeAll(async () => {
    database = await acquireTestDatabase();

    /**
     * The script is the whole choreography of this file, in order:
     *
     * 1.–5. the five attempts of `MAIL_MAX_ATTEMPTS`, all refused, which is
     *       what puts the line on `failed` with a readable reason;
     * 6.    the attempt „↻ Erneut" buys — **also** refused, because the
     *       interesting question is what the line does afterwards;
     * 7.    and from `then` on the server answers, so the chain ends where a
     *       real one does: the mail goes out.
     */
    transport = new SmtpDouble({
      script: [
        ...Array.from({ length: MAIL_MAX_ATTEMPTS }, () => 'fail' as const),
        'fail',
      ],
      then: 'ok',
      failureMessage: REFUSAL,
    });
    // Started at the real instant and only ever moved forward: the retry route
    // stamps `next_attempt_at` with the API process's own `new Date()`, so a
    // clock that began in the past would make the requeued row look due in the
    // future for reasons that have nothing to do with the requirement.
    clock = new MutableClock(new Date());

    testApp = await createTestApp({
      databaseUrl: database.url,
      transport,
      clock,
    });
    app = testApp;
    worker = app.app.get(MailWorkerService);

    tenant = await createTenant(app.prisma, 'RETRY');
    const user = await createUser(app.prisma, {
      email: 'editor@example.org',
      password: PASSWORD,
      tenants: [tenant],
    });
    // The admin group of `createTenant` carries both flags the specification asks for;
    // that the conjunction is *enforced* is `mail-log.spec.ts`'s subject, not
    // this one's.
    editor = await openSession(app, user.id, tenant.id);

    // --- a real submission, so the row is the one the route writes ---------------
    const created = await request(app.server)
      .post(apiPath('/forms'))
      .set(authedMutation(editor))
      .send({ title: 'Anmeldung Jahrestagung' });
    expect(created.status).toBe(201);
    const form = created.body as {
      id: string;
      revision: number;
      publicSlug: string;
    };

    const saved = await request(app.server)
      .put(apiPath(`/forms/${form.id}`))
      .set(authedMutation(editor))
      .send({
        title: 'Anmeldung Jahrestagung',
        definition,
        revision: form.revision,
      });
    expect(saved.status).toBe(200);

    const published = await request(app.server)
      .post(apiPath(`/forms/${form.id}/publish`))
      .set(authedMutation(editor))
      .send({ revision: (saved.body as { revision: number }).revision });
    expect(published.status).toBe(200);

    const notification = await request(app.server)
      .post(apiPath(`/forms/${form.id}/notifications`))
      .set(authedMutation(editor))
      .send({
        name: 'Anmeldung an das Organisationsbüro',
        subject: 'Neue Anmeldung',
        body: 'Es ist eine Anmeldung eingegangen.',
        recipients: [{ kind: 'literal', address: OFFICE_ADDRESS }],
        replyTo: null,
      });
    expect(notification.status).toBe(201);

    const submitted = await request(app.server)
      .post(apiPath(`/public/forms/${form.publicSlug}/responses`))
      .send({ answers: { [NAME_QUESTION]: 'Anton Aktiv' } });
    expect(submitted.status).toBe(200);

    // Exactly one row, and it is the one every assertion below is about. The
    // renderer will find a real notification and a real answer behind
    // it — a hand-written row without either would fail *before* the transport
    // and the counter would never move, which is the one way this file could
    // be green about nothing.
    const rows = await app.prisma.mailLog.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipient: OFFICE_ADDRESS,
      status: 'queued',
      attempts: 0,
    });
    mailLogId = rows[0]?.id ?? '';
  }, 180_000);

  afterAll(async () => {
    await testApp?.close();
    await database?.release();
  }, 120_000);

  function row() {
    return app.prisma.mailLog.findUniqueOrThrow({ where: { id: mailLogId } });
  }

  function retry(id: string): request.Test {
    return request(app.server)
      .post(apiPath(`/mail-log/${id}/retry`))
      .set(authedMutation(editor));
  }

  /**
   * The five refusals, one worker run each, with the clock moved past the
   * backoff in between.
   *
   * Not one `runOnce()`: the worker re-reads `next_attempt_at` on every claim
   * , so a single run attempts the row exactly once and then
   * finds nothing due. Moving the injected clock is how this suite waits —
   * nothing here sleeps.
   */
  it('burns the line down to „Fehlgeschlagen" first', async () => {
    for (let attempt = 1; attempt <= MAIL_MAX_ATTEMPTS; attempt += 1) {
      const run = await worker.runOnce();
      expect(run.attempted).toBe(1);
      clock.advance(mailBackoffMs(attempt) + 1_000);
    }

    expect(transport.attemptCount).toBe(MAIL_MAX_ATTEMPTS);
    expect(transport.recipients).toEqual(
      Array.from({ length: MAIL_MAX_ATTEMPTS }, () => OFFICE_ADDRESS),
    );

    const stored = await row();
    expect(stored.status).toBe('failed');
    expect(stored.attempts).toBe(MAIL_MAX_ATTEMPTS);
    expect(stored.lastError).toBe(STORED_REASON);
    // The wording of the other side is **not** in it.
    expect(stored.lastError).not.toContain(REFUSAL);
    expect(stored.sentAt).toBe(null);
  });

  /**
   * The control that gives the next case its meaning: **without** the button
   * nothing happens, however often the worker runs. A rising counter after the
   * requeue would otherwise be indistinguishable from a queue that simply keeps
   * retrying — which is exactly what `failed` promises it does not.
   */
  it('is left alone by the worker while nobody presses the button', async () => {
    const before = transport.attemptCount;

    clock.advance(24 * 60 * 60 * 1_000);
    const run = await worker.runOnce();

    expect(run).toMatchObject({ attempted: 0, sent: 0, failed: 0 });
    expect(transport.attemptCount).toBe(before);
    expect((await row()).status).toBe('failed');
  });

  /**
   * The requirement itself: press, run, and the **transport** was asked again.
   *
   * The scripted attempt fails, on purpose — see the module note. What the two
   * assertions after the counter say is that the line kept its budget: `queued`
   * with `attempts = 1`, not `failed` with `attempts = 6`. That is the
   * difference between „wieder in der Warteschlange" and „ein Versuch, dann
   * endgültig aus", and it is the part `attempts = 0` in the requeue pays for.
   */
  it('really sends again after „↻ Erneut", instead of only recolouring', async () => {
    const before = transport.attemptCount;

    const pressed = await retry(mailLogId);
    // 204 and **no body** — a caller waiting for an object waits forever.
    expect(pressed.status).toBe(204);
    expect(pressed.text).toBe('');

    const requeued = await row();
    expect(requeued.status).toBe('queued');
    expect(requeued.attempts).toBe(0);
    // The reason stays readable until a new result replaces it.
    expect(requeued.lastError).toBe(STORED_REASON);

    // Nothing has been sent yet — the button hands the line back, it does not
    // deliver. Without this, the counter below could be the press's own doing.
    expect(transport.attemptCount).toBe(before);

    const run = await worker.runOnce();

    // **The assertion this file exists for.**
    expect(transport.attemptCount).toBe(before + 1);
    expect(transport.recipients.at(-1)).toBe(OFFICE_ADDRESS);
    expect(run).toMatchObject({ attempted: 1, deferred: 1, failed: 0 });

    const after = await row();
    expect(after.status).toBe('queued');
    expect(after.attempts).toBe(1);
    expect(after.sentAt).toBe(null);
    // One line per recipient — a retry is another attempt at the
    // same delivery, never a second row.
    expect(await app.prisma.mailLog.count()).toBe(1);
  });

  /** Only `failed` is retryable; the line is `queued` now. */
  it('refuses a second press while the line is waiting', async () => {
    const response = await retry(mailLogId);
    expect(response.status).toBe(409);
    expect((await row()).attempts).toBe(1);
  });

  /**
   * And the chain ends where a real one does: the mail server answers and the
   * line goes out — on the budget the requeue restored, not on a sixth attempt
   * that was never allowed.
   */
  it('delivers on the restored budget once the server answers', async () => {
    const before = transport.attemptCount;

    clock.advance(mailBackoffMs(1) + 1_000);
    const run = await worker.runOnce();

    expect(run).toMatchObject({ attempted: 1, sent: 1 });
    expect(transport.attemptCount).toBe(before + 1);

    const stored = await row();
    expect(stored.status).toBe('sent');
    expect(stored.attempts).toBe(2);
    expect(stored.sentAt).not.toBe(null);
    expect(stored.lastError).toBe(null);
    expect(await app.prisma.mailLog.count()).toBe(1);
  });
});
