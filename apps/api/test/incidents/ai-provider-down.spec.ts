import 'reflect-metadata';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  OPS_THRESHOLDS,
  exceeds,
  parseOpsStatus,
  type AiFormOutcome,
  type OpsStatus,
} from '@formsache/shared';

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
import {
  authedMutation,
  cookieHeader,
  login,
  openSession,
} from '../support/http';
import { RecordedFormGenerator } from '../support/recorded-form-generator';
import { RECORDED_DRAFT } from '../ai/recorded-answers';
import {
  publishFormWithNotification,
  type PublishedForm,
} from './incident-form';
import { JobKind } from '@prisma/client';

import { MailLogPurgeService } from '../../src/mail/mail-log-purge.service';
import { JobRunService } from '../../src/observability/job-run.service';

/**
 * **Incident 3 — the AI provider does not answer** (fourth
 * of the four cases; `docs/kb/09-betrieb.md`).
 *
 * ## The second half of the sentence is the proof
 *
 * "`unavailable`, **the rest of the application untouched**" — the first part
 * is a statement about a route and long since proven in
 * `provider-contract.spec.ts`. The second is the promise that counts in
 * operation and that nobody else measures: a provider that stays silent must
 * hold up no registration, no export and no login to the system. That is why a
 * complete core flow runs through here **during** the outage — filling in,
 * exporting, logging in —, and in the very application whose AI is not
 * answering at that moment.
 *
 * ## Why the provider "does not answer" by returning `unavailable`
 *
 * The seam contract (ADR-0015 no. 1) demands of every adapter a **result
 * instead of an exception**; network errors, 5xx and auth errors all run
 * together into `unavailable` (`anthropic-form-generator.ts`). A double that
 * threw instead would thereby not reproduce the provider but a broken
 * adapter — a different incident, and one that delivers 500 instead of 200.
 *
 * ## Where the installation gets its AI from
 *
 * ⚠️ Since the move into the system settings the configuration lives in `system_setting` and no longer
 * in the environment; a switch in `env` would therefore no longer make this
 * installation AI-capable at all. It comes here through `ai: { … }` of
 * `createTestApp` — the same row a superadmin writes, sealed with the
 * key — and the double through `aiGenerator`, which the helper binds as a
 * **factory**.
 */

const PASSWORD = 'change-me-locally';
const KEY = 'test-key-not-a-real-one';
const PROMPT = { prompt: 'Ein Formular für die Bestandsmeldung' };

const OUT: AiFormOutcome = { ok: false, failure: 'unavailable', usage: null };
const BACK: AiFormOutcome = { ok: true, draft: RECORDED_DRAFT, usage: null };

describe('Störfall: der KI-Anbieter antwortet nicht', () => {
  let database: TestDatabase | undefined;
  let testApp: TestApp;
  let generator: RecordedFormGenerator;
  let tenant: TenantFixture;
  let editor: string;
  let superadmin: string;
  let form: PublishedForm;

  beforeAll(async () => {
    database = await acquireTestDatabase();

    // The provider stays silent: three outages, then it answers again. The
    // order is the narrative of the incident, and `generator.attempts` is
    // checked along at every station — if someone moves a case, that turns
    // red instead of quietly measuring a different script.
    generator = new RecordedFormGenerator([OUT, OUT, OUT, BACK]);

    testApp = await createTestApp({
      databaseUrl: database.url,
      env: { TRUST_PROXY_HOPS: 1 },
      // The installation **has** an AI — as a row, as in operation.
      ai: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        // The default region, not just any one: a reproduction that
        // incidentally pinned `us` would be a data protection statement in a
        // test about operation.
        region: 'eu',
        apiKey: KEY,
      },
      aiGenerator: generator,
    });

    tenant = await createTenant(testApp.prisma, 'KIWEG');
    const user = await createUser(testApp.prisma, {
      email: 'bearbeiter@kiweg.example',
      password: PASSWORD,
      tenants: [tenant],
    });
    editor = await openSession(testApp, user.id, tenant.id);

    const root = await createUser(testApp.prisma, {
      email: 'root@kiweg.example',
      password: PASSWORD,
      tenants: [tenant],
      isSuperadmin: true,
    });
    superadmin = await openSession(testApp, root.id, tenant.id);

    // ⚠️ **`recipient` is no decoration here** (review finding). Without it
    // there is no notification, hence never a row in the queue — and the
    // assertion "queue untouched" further down would check a
    // zero that could not have been anything else.
    form = await publishFormWithNotification(testApp, editor, {
      title: 'Bestandsmeldung',
      recipient: 'betrieb@invalid.example',
    });
    // A real, successful background run — so that "no run has
    // failed" further down is a statement about rows and not about
    // an empty table. The schedulers are off in the test application, so
    // somebody triggers it by hand here.
    // ⚠️ Through **the same bracket** as in operation: `runOnce()` alone writes
    // no row — the bookkeeping lies in `runTick()`, which is private. A
    // direct `jobRun.create` would be the second write path that this very rule
    // excludes.
    const purge = testApp.app.get(MailLogPurgeService);
    await testApp.app
      .get(JobRunService)
      .record(JobKind.mail_log_purge, () => purge.runOnce());
  }, 180_000);

  afterAll(async () => {
    // `as … | undefined` as in the two neighbouring files: a run that cannot
    // get the application up should report **one** failure.
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

  const generate = (): Promise<request.Response> =>
    request(testApp.server)
      .post(apiPath('/ai/forms'))
      .set(authedMutation(editor))
      .send(PROMPT);

  // ═══════════════════════════════════════════════════════════════════════
  // What the operator sees
  // ═══════════════════════════════════════════════════════════════════════

  it('antwortet dem Bearbeiter mit `unavailable` — 200, nicht 500', async () => {
    const response = await generate();

    // 200 with a named failure, because the call **took place** and its
    // result is a piece of information. A 500 would be the statement "this
    // application is broken" and would wander into every error log the
    // operator goes through looking for *their own* defects.
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: false, failure: 'unavailable' });

    // One call, one attempt (ADR-0015 no. 6). An outage must not turn into a
    // threefold bill — that is why the number stands here and not only
    // the status.
    expect(generator.attempts).toBe(1);
  });

  it('zählt den Ausfall im Betriebsstatus — Aufrufe und Fehlerquote', async () => {
    const status = await readOps();

    expect(status.ai.calls).toBe(1);
    expect(status.ai.failed).toBe(1);
    expect(status.ai.failureRate).toBe(1);
    // The same shared threshold the watchdog uses: „Die KI antwortet
    // unzuverlässig" is not the verdict of this test but that of the
    // application.
    expect(exceeds(status.ai.failureRate, OPS_THRESHOLDS.aiFailureRate)).toBe(
      true,
    );
  });

  it('verbraucht das Kontingent der Organisation **trotzdem** — der Ausfall ist nicht gratis', async () => {
    const response = await request(testApp.server)
      .get(apiPath('/ai/quota'))
      .set('Cookie', cookieHeader(editor));
    expect(response.status).toBe(200);

    // ⚠️ **The sentence that belongs in the manual and that nobody expects.**
    // The quota is committed before the dialling (ADR-0015 no. 7), so that
    // an outage does not invite unlimited retrying. An organisation whose
    // provider stays silent for a morning can therefore use up its monthly
    // budget without having received a single draft.
    expect(response.body).toMatchObject({ used: 1 });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // "The rest of the application untouched" — the actual proof
  // ═══════════════════════════════════════════════════════════════════════

  describe('während der Anbieter schweigt', () => {
    beforeAll(async () => {
      // Two further failures, so that the outage lasts **during** the
      // following cases and did not merely take place before them.
      await generate();
      await generate();
      expect(generator.attempts).toBe(3);
    });

    it('geht eine öffentliche Anmeldung durch', async () => {
      const response = await request(testApp.server)
        .post(apiPath(`/public/forms/${form.slug}/responses`))
        .set('X-Forwarded-For', '198.51.100.11')
        .send({ answers: { [form.nameQuestionId]: 'Anton Aktiv' } });

      // 200, not 201 — the public submission answers with the
      // confirmation payload (`public-forms.controller.ts`).
      expect(response.status).toBe(200);
      expect(
        await testApp.prisma.response.count({ where: { formId: form.id } }),
      ).toBe(1);
    });

    it('geht ein Export durch — und die Datei trägt die Antwort', async () => {
      const response = await request(testApp.server)
        .get(apiPath(`/forms/${form.id}/export.csv`))
        .set('Cookie', cookieHeader(editor));

      expect(response.status).toBe(200);
      // The content, not the status code: the Excel finding was a 200
      // with correct headers and a wrong body.
      expect(response.text).toContain('Anton Aktiv');
    });

    it('geht eine Anmeldung am System durch', async () => {
      const token = await login(testApp, 'bearbeiter@kiweg.example', PASSWORD);
      expect(token).not.toBe('');
    });

    it('bleibt die Bereitschaft grün — ein KI-Ausfall ist kein Ausfall der Anwendung', async () => {
      const response = await request(testApp.server).get(
        apiPath('/health/ready'),
      );

      // ⚠️ **The line that keeps the outside observer from raising the wrong
      // alarm.** If readiness hung on the provider, a silent third party would
      // call somebody in the middle of the night — for a
      // feature that is not switched on at go-live at all.
      expect(response.status).toBe(200);
    });

    it('lässt Warteschlange und Läufe im Betriebsstatus unberührt', async () => {
      const status = await readOps();

      expect(status.ai.failed).toBe(3);

      // ⚠️ **Three assertions stood here that could not fail**
      // — a review measured it and wrote it down:
      //   * `mailQueue.queued === 0`: there was no notification at all, hence
      //     never a row. Now the form carries a recipient, the
      //     submission above produces a **real** waiting row, and the
      //     assertion accordingly reads "it is still waiting, it has not
      //     failed".
      //   * `storage.files >= 0`: a counter is never negative. Gone without
      //     replacement — that the storage answers is already said by
      //     `readOps()` itself, which would otherwise have thrown.
      //   * `jobs.every(… !== 'failed')`: all schedulers are off in the
      //     test application, **not a single** `job_run` row existed.
      //     Now a purge runs beforehand, so there is an `ok` row against
      //     which "no run has failed" means something.
      expect(status.mailQueue.queued).toBeGreaterThan(0);
      expect(status.mailQueue.failed).toBe(0);
      expect(status.jobs.some((job) => job.lastOutcome === 'ok')).toBe(true);
      expect(status.jobs.every((job) => job.lastOutcome !== 'failed')).toBe(
        true,
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // How the operator can tell that it is over
  // ═══════════════════════════════════════════════════════════════════════

  describe('wenn der Anbieter zurück ist', () => {
    it('liefert der nächste Versuch wieder einen Entwurf', async () => {
      const response = await generate();

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ ok: true });
      expect(generator.attempts).toBe(4);
    });

    it('erholt sich die Fehlerquote nur **langsam** — sie ist eine Monatszahl', async () => {
      const status = await readOps();

      expect(status.ai.calls).toBe(4);
      expect(status.ai.failed).toBe(3);
      // ⚠️ **That is why "one successful draft" stands in the manual as the
      // sign of recovery and not "the rate falls".** The period is the
      // running calendar month (so that rate and budget mean the same
      // period); after an outage the number stays red for days,
      // although everything has long been working again. Whoever waits for it
      // waits too long.
      expect(status.ai.failureRate).toBe(0.75);
      expect(exceeds(status.ai.failureRate, OPS_THRESHOLDS.aiFailureRate)).toBe(
        true,
      );
    });
  });
});
