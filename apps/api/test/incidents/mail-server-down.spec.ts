import 'reflect-metadata';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MAIL_MAX_ATTEMPTS,
  OPS_THRESHOLDS,
  exceeds,
  parseOpsStatus,
  type OpsStatus,
} from '@formsache/shared';

import { mailBackoffMs } from '../../src/mail/mail-backoff';
import { MailWorkerService } from '../../src/mail/mail-worker.service';
import { OpsAlertService } from '../../src/observability/ops-alert.service';
import { SYSTEM_SETTING_ID } from '../../src/system-settings/system-settings.repository';
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
import { cookieHeader, openSession } from '../support/http';
import { SmtpDouble } from '../support/smtp-double';
import {
  publishFormWithNotification,
  type PublishedForm,
} from './incident-form';

/**
 * **Incident 1 — the mail server does not answer** (first of the
 * four cases; `docs/kb/09-betrieb.md`).
 *
 * ## What distinguishes this test from the existing mail suites
 *
 * `mail-queue.spec.ts` proves the **mechanism** — backoff, upper limit,
 * `SKIP LOCKED` — on a module harness. This file proves the
 * **description**: it produces the incident on the whole application and then
 * holds every line of the operations manual against the state produced. The
 * checkpoint of this incident is explicitly not „does the queue work",
 * but **„does the operator really see what is there?"** — measurement therefore
 * runs over `GET /api/admin/ops`, that is over the view the manual names to
 * the operator, and not over the table behind it.
 *
 * ## The sequence is a narrative, and the order carries it
 *
 * The transport is a script: **six** refusals, after that it accepts again.
 * Five belong to the worker (up to `failed`), the sixth to the watchdog — for
 * „ein toter Mailserver kann seinen eigenen Ausfall nicht melden" is a promise
 * of the manual and is measured here, not believed. Every section therefore
 * additionally checks `transport.attemptCount`: if someone moves a case, that
 * goes red instead of quietly measuring a different script.
 *
 * *Reproduction:* set `MAIL_MAX_ATTEMPTS` to a very large value → the
 * `failed` section goes red, while every „the queue rises" case stays green.
 * That is exactly the difference between „the post is backing up" and „the post
 * is lost", and the manual claims both.
 */

const PASSWORD = 'change-me-locally';
const EMPFAENGER = 'geschaeftsfuehrung@example.invalid';
const BETREIBER = 'betrieb@example.invalid';

/** Documentation range (RFC 5737) — never a real caller. */
let nextAddress = 0;
function ownAddress(): string {
  nextAddress += 1;
  return `198.51.100.${String((nextAddress % 250) + 1)}`;
}

describe('Störfall: der Mailserver antwortet nicht ', () => {
  let database: TestDatabase | undefined;
  let testApp: TestApp;
  let transport: SmtpDouble;
  let clock: MutableClock;
  let worker: MailWorkerService;
  let alerts: OpsAlertService;
  let tenant: TenantFixture;
  let editor: string;
  let superadmin: string;
  let form: PublishedForm;

  /** The row this incident holds on to. */
  let stuckMailId: string;
  /** The gaps the worker itself laid between two attempts. */
  const gapsMs: number[] = [];

  beforeAll(async () => {
    database = await acquireTestDatabase();
    // Six refusals: five for the worker, one for the watchdog. After that the
    // server answers again — that is the recovery the manual describes as
    // „how they recognise that it is over".
    transport = new SmtpDouble({
      script: ['fail', 'fail', 'fail', 'fail', 'fail', 'fail'],
      then: 'ok',
      failureMessage: 'ECONNREFUSED',
    });
    clock = new MutableClock(new Date());
    testApp = await createTestApp({
      databaseUrl: database.url,
      env: { TRUST_PROXY_HOPS: 1 },
      transport,
      clock,
    });
    worker = testApp.app.get(MailWorkerService);
    alerts = testApp.app.get(OpsAlertService);

    tenant = await createTenant(testApp.prisma, 'POST');
    const user = await createUser(testApp.prisma, {
      email: 'bearbeiter@post.example',
      password: PASSWORD,
      tenants: [tenant],
    });
    editor = await openSession(testApp, user.id, tenant.id);

    const root = await createUser(testApp.prisma, {
      email: 'root@post.example',
      password: PASSWORD,
      tenants: [tenant],
      isSuperadmin: true,
    });
    superadmin = await openSession(testApp, root.id, tenant.id);

    form = await publishFormWithNotification(testApp, editor, {
      title: 'Jahrestagung-Anmeldung',
      recipient: EMPFAENGER,
    });

    // The operator address the watchdog reports to — without it, it would be
    // silent for a different reason than the one this test measures.
    await testApp.prisma.systemSetting.update({
      where: { id: SYSTEM_SETTING_ID },
      data: { opsAlertEmail: BETREIBER },
    });
  }, 180_000);

  afterAll(async () => {
    // `as … | undefined`: the declaration above is definite, but a run that
    // does not get the application up at all never reaches it — and an
    // unguarded clean-up would then report a second, unrelated failure on top
    // of the real one.
    await (testApp as TestApp | undefined)?.close();
    await database?.release();
  }, 120_000);

  const readOps = async (): Promise<OpsStatus> => {
    const response = await request(testApp.server)
      .get(apiPath('/admin/ops'))
      .set('Cookie', cookieHeader(superadmin));
    expect(response.status).toBe(200);
    return parseOpsStatus(response.body);
  };

  const submit = (): Promise<request.Response> =>
    request(testApp.server)
      .post(apiPath(`/public/forms/${form.slug}/responses`))
      .set('X-Forwarded-For', ownAddress())
      .send({ answers: { [form.nameQuestionId]: 'Anton Aktiv' } });

  // ═══════════════════════════════════════════════════════════════════════
  // What the operator sees
  // ═══════════════════════════════════════════════════════════════════════

  it('nimmt die Anmeldung weiter an — der Teilnehmer merkt nichts', async () => {
    const response = await submit();

    // ⚠️ **The first promise of the incident, and the most important one.** A
    // dead mail server must not stop the filling in: the response is stored,
    // the mail waits. If the route answered 500 here, the manual would carry
    // the wrong incident — then it would not be one of the post, but one of
    // the form.
    //
    // **200, not 201** — the public submission answers with the confirmation
    // payload, not with a created resource a participant could point at
    // (`public-forms.controller.ts`).
    expect(response.status).toBe(200);
    expect(
      await testApp.prisma.response.count({ where: { formId: form.id } }),
    ).toBe(1);

    const row = await testApp.prisma.mailLog.findFirstOrThrow({
      where: { formId: form.id },
    });
    expect(row.status).toBe('queued');
    expect(row.attempts).toBe(0);
    stuckMailId = row.id;

    // The request path sends nothing — the worker does that, and it has not
    // run yet.
    expect(transport.attemptCount).toBe(0);
  });

  it('zeigt die wartende Zeile im Betriebsstatus — dort, wo das Handbuch hinzeigt', async () => {
    const status = await readOps();

    // „Warteschlange — wartend, gescheitert, Alter der ältesten": all three
    // numbers really are there, and the first one has risen.
    expect(status.mailQueue.queued).toBe(1);
    expect(status.mailQueue.failed).toBe(0);
    expect(status.mailQueue.oldestQueuedAt).not.toBeNull();
  });

  it('lässt das Alter der ältesten Zeile über die 30-Minuten-Schwelle steigen', async () => {
    clock.advance(31 * 60 * 1000);
    const status = await readOps();

    const ageMs =
      new Date(status.observedAt).getTime() -
      new Date(status.mailQueue.oldestQueuedAt ?? 0).getTime();
    // Measured against **the same** shared threshold the watchdog uses. If the
    // 30 stood in the manual and a different number in `OPS_THRESHOLDS`, the
    // instructions would be a second truth — precisely what this comparison
    // rules out.
    expect(exceeds(ageMs, OPS_THRESHOLDS.mailQueueAgeMs)).toBe(true);
  });

  it('kann seinen eigenen Ausfall **nicht** melden — dafür gibt es den äußeren Beobachter', async () => {
    const before = transport.attemptCount;

    // The watchdog recognises the breached threshold and tries to report —
    // over the same mail server that is currently not answering.
    await expect(alerts.runOnce()).rejects.toThrow();

    // ⚠️ **This is the proof of the sentence in the manual**, not its
    // illustration: the attempt took place (so the watchdog is not silent out
    // of inertia) and it failed. An operator who only waits for the alarm mail
    // learns nothing of this incident.
    expect(transport.attemptCount).toBe(before + 1);
    // And the lock was **not** set: a failed alarm must not mute the figure
    // for six hours.
    expect(await testApp.prisma.opsAlert.count()).toBe(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // What happens while it does not answer
  // ═══════════════════════════════════════════════════════════════════════

  it('versucht es fünfmal mit wachsendem Abstand und gibt dann auf', async () => {
    for (let round = 0; round < MAIL_MAX_ATTEMPTS; round += 1) {
      const startedAt = clock.now();
      await worker.runOnce();
      const row = await testApp.prisma.mailLog.findUniqueOrThrow({
        where: { id: stuckMailId },
      });
      expect(row.attempts).toBe(round + 1);

      if (row.nextAttemptAt === null) break;
      gapsMs.push(row.nextAttemptAt.getTime() - startedAt.getTime());
      // To exactly the point in time the queue itself named — no sleeping, no
      // guessed waiting time.
      clock.set(row.nextAttemptAt);
    }

    const row = await testApp.prisma.mailLog.findUniqueOrThrow({
      where: { id: stuckMailId },
    });
    // **The number, not the status.** `failed` alone would also be had from a
    // queue without any retry at all.
    expect(row.attempts).toBe(MAIL_MAX_ATTEMPTS);
    expect(row.status).toBe('failed');
    expect(row.nextAttemptAt).toBeNull();
    expect(row.lastError).not.toBeNull();

    // The gaps really do grow, and they are those of the shared backoff.
    expect(gapsMs.length).toBe(MAIL_MAX_ATTEMPTS - 1);
    for (const [index, gap] of gapsMs.entries()) {
      expect(gap).toBe(mailBackoffMs(index + 1));
      if (index > 0) expect(gap).toBeGreaterThan(gapsMs[index - 1] ?? 0);
    }

    // Five refusals of the worker plus the one of the watchdog.
    expect(transport.attemptCount).toBe(MAIL_MAX_ATTEMPTS + 1);
  });

  it('trägt die Aufgabe danach im Betriebsstatus als **gescheitert**, nicht als wartend', async () => {
    const status = await readOps();

    // Exactly the transition the manual describes: the number moves from
    // „wartend" to „gescheitert". An operator who only looks at `queued` would
    // now hold the installation to be recovered.
    expect(status.mailQueue.queued).toBe(0);
    expect(status.mailQueue.failed).toBe(1);
    expect(status.mailQueue.oldestQueuedAt).toBeNull();
  });

  it('hält den Grund im Versandprotokoll fest — ohne die Meldung des Servers zu erfinden', async () => {
    const row = await testApp.prisma.mailLog.findUniqueOrThrow({
      where: { id: stuckMailId },
    });
    // The manual says: „sie stehen im Versandprotokoll mit ihrem Grund". So a
    // readable reason really does have to stand there.
    expect(row.lastError).toBeTruthy();
    expect(row.recipient).toBe(EMPFAENGER);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // How they recognise that it is over
  // ═══════════════════════════════════════════════════════════════════════

  it('liefert wieder aus, sobald der Server antwortet — die Warteschlange fällt', async () => {
    const response = await submit();
    expect(response.status).toBe(200);

    const queued = await readOps();
    expect(queued.mailQueue.queued).toBe(1);

    await worker.runOnce();

    const row = await testApp.prisma.mailLog.findFirstOrThrow({
      where: { formId: form.id, status: 'sent' },
    });
    expect(row.attempts).toBe(1);
    expect(row.sentAt).not.toBeNull();

    const after = await readOps();
    expect(after.mailQueue.queued).toBe(0);
    expect(after.mailQueue.oldestQueuedAt).toBeNull();
  });

  it('lässt die `failed`-Zeile **liegen** — sie läuft nicht von selbst wieder an', async () => {
    await worker.runOnce();

    const row = await testApp.prisma.mailLog.findUniqueOrThrow({
      where: { id: stuckMailId },
    });
    // ⚠️ **The uncomfortable half of the incident, and the only one that
    // makes work for the operator.** Everything else recovers by itself; this
    // registration was never delivered, and nobody but the number in the
    // operations status says so. If that did not stand in the manual, a
    // recovered counter would be read as „done".
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(MAIL_MAX_ATTEMPTS);

    const status = await readOps();
    expect(status.mailQueue.failed).toBe(1);
  });
});
