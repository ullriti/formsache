import 'reflect-metadata';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseHealthResponse, parseOpsStatus } from '@formsache/shared';

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
import { cookieHeader, openSession } from '../support/http';
import {
  publishFormWithNotification,
  type PublishedForm,
} from './incident-form';

/**
 * **Incident 2 — the database is gone** (third of the four
 * cases; `docs/kb/09-betrieb.md`).
 *
 * ## Why this case gets a test of its own at all
 *
 * It is the **point** of the separation: `GET /api/health` does not touch the
 * database, `GET /api/health/ready` exactly once. Earlier there was only the
 * first route, and the Compose healthcheck asked it — an installation with a
 * dead database reported `healthy`. The separation is therefore not tidiness:
 * it is the only place at which a supervisor can distinguish „the process is
 * alive" from „it can work", and the price of a mix-up is a restart that
 * repairs nothing and throws away warm state.
 *
 * `readiness.controller.spec.ts` proves the two answers on a service with a
 * faked Prisma. This file pulls the database out from under the **running
 * application** and then measures what an operator really finds.
 *
 * ## How the database disappears
 *
 * Via `TestDatabase.release()` — and that is deliberately the *same* handle
 * every suite reaches for at the end. Depending on the strategy (ADR-0008) it
 * means two things: with Testcontainers it stops the container, without it it
 * throws the database away (`DROP DATABASE … WITH (FORCE)`, which clears away
 * the application's open connections along with it). For the application both
 * are the same state — the connection is no longer there —, and that is
 * exactly what matters: the test does not hang on *how* the database
 * disappears.
 *
 * ⚠️ **This file gives up its database in the middle.** Everything after the
 * section „nachdem sie weg ist" runs without a database; a further case that
 * needed one would not be red, but misleadingly red.
 *
 * *Reproduction:* take its `SELECT 1` away from `ReadinessService` (always
 * answer `true`) → the 503 case turns red while the liveness case stays green.
 * That is the fall back into an earlier state, and from outside it looks
 * healthy.
 */

const PASSWORD = 'change-me-locally';

describe('Störfall: die Datenbank ist weg ', () => {
  let database: TestDatabase | undefined;
  let testApp: TestApp;
  let superadmin: string;
  let tenant: TenantFixture;
  let form: PublishedForm;

  /** The uptime **before** the outage — the proof against a restart. */
  let uptimeBefore = 0;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({
      databaseUrl: database.url,
      env: { TRUST_PROXY_HOPS: 1 },
    });

    tenant = await createTenant(testApp.prisma, 'DBWEG');
    const root = await createUser(testApp.prisma, {
      email: 'root@dbweg.example',
      password: PASSWORD,
      tenants: [tenant],
      isSuperadmin: true,
    });
    superadmin = await openSession(testApp, root.id, tenant.id);

    const user = await createUser(testApp.prisma, {
      email: 'bearbeiter@dbweg.example',
      password: PASSWORD,
      tenants: [tenant],
    });
    const editor = await openSession(testApp, user.id, tenant.id);
    form = await publishFormWithNotification(testApp, editor, {
      title: 'Bestandsmeldung',
    });
  }, 180_000);

  afterAll(async () => {
    // Both may fail: the application closes against a database that no longer
    // exists, and `release()` has already run. An error while cleaning up must
    // not overwrite the reason we are standing here.
    await (testApp as TestApp | undefined)?.close().catch(() => undefined);
    await database?.release().catch(() => undefined);
  }, 120_000);

  // ═══════════════════════════════════════════════════════════════════════
  // While it stands — otherwise the second part would only prove that
  // something is broken
  // ═══════════════════════════════════════════════════════════════════════

  describe('solange die Datenbank steht', () => {
    it('antwortet auf beide Routen mit 200', async () => {
      const ready = await request(testApp.server).get(apiPath('/health/ready'));
      expect(ready.status).toBe(200);
      expect(ready.body).toStrictEqual({ ready: true });

      const health = await request(testApp.server).get(apiPath('/health'));
      expect(health.status).toBe(200);
      uptimeBefore = parseHealthResponse(health.body).uptimeSeconds;
    });

    it('lässt den Betriebsstatus und das öffentliche Formular durch', async () => {
      const ops = await request(testApp.server)
        .get(apiPath('/admin/ops'))
        .set('Cookie', cookieHeader(superadmin));
      expect(ops.status).toBe(200);
      expect(parseOpsStatus(ops.body).version).toBe('0.0.0-test');

      const publicForm = await request(testApp.server).get(
        apiPath(`/public/forms/${form.slug}`),
      );
      expect(publicForm.status).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // And after it is gone
  // ═══════════════════════════════════════════════════════════════════════

  describe('nachdem die Datenbank weg ist', () => {
    beforeAll(async () => {
      await database?.release();
    }, 120_000);

    it('antwortet auf die **Bereitschaft** mit 503 — und sagt nicht, warum', async () => {
      const response = await request(testApp.server).get(
        apiPath('/health/ready'),
      );

      expect(response.status).toBe(503);
      // The body is one field, not two. „Which dependency is down" is what
      // the operator wants to know and a stranger even more — this route
      // stands unauthenticated on the network, so the answer stands in the
      // status code.
      expect(response.body).toStrictEqual({ ready: false });
      expect(Object.keys(response.body as object)).toStrictEqual(['ready']);
    });

    it('antwortet auf die **Lebendigkeit** weiter mit 200 — der Prozess lebt', async () => {
      const response = await request(testApp.server).get(apiPath('/health'));

      expect(response.status).toBe(200);
      const health = parseHealthResponse(response.body);
      expect(health.status).toBe('ok');
      expect(health.version).toBe('0.0.0-test');
    });

    it('ist **nicht** neu gestartet — die Betriebszeit läuft weiter', async () => {
      const response = await request(testApp.server).get(apiPath('/health'));
      const health = parseHealthResponse(response.body);

      // ⚠️ **The actual proof of this incident.** A restart would set the
      // uptime back to near zero; it is instead larger than before. Exactly
      // for that reason the Compose healthcheck asks readiness and derives
      // **nothing** from it for `restart:`: restarting a healthy process
      // because the *database* is missing throws away warm state and repairs
      // nothing.
      expect(health.uptimeSeconds).toBeGreaterThan(uptimeBefore);
    });

    it('macht den Betriebsstatus unerreichbar — die Tagesansicht fällt mit aus', async () => {
      const response = await request(testApp.server)
        .get(apiPath('/admin/ops'))
        .set('Cookie', cookieHeader(superadmin));

      // ⚠️ **Measured, not assumed — and it is the uncomfortable answer.**
      // The five groups of numbers the handbook points at daily come from the
      // database themselves. In exactly the incident in which an operator
      // would read them most urgently, they are gone. That is no defect (the
      // numbers *are* the database), but it is the reason why the external
      // observer has to live outside this installation.
      expect(response.status).not.toBe(200);
      expect(response.status).toBeGreaterThanOrEqual(500);
    });

    it('lässt niemanden mehr anmelden — auch den Betreiber nicht', async () => {
      const response = await request(testApp.server)
        .post(apiPath('/auth/login'))
        .send({ email: 'root@dbweg.example', password: PASSWORD });

      // The session lies in the database. Whoever would first have to log in
      // in this state does not even get as far as the view that would tell
      // them what is going on.
      expect(response.status).not.toBe(200);
    });

    it('scheitert an jeder fachlichen Aktion, statt still Leeres zu liefern', async () => {
      const publicForm = await request(testApp.server).get(
        apiPath(`/public/forms/${form.slug}`),
      );
      // Not 404: „the form does not exist" would be a lie about the stored
      // data and would read like a deleted form. The error belongs on the
      // surface, not in an empty page.
      expect(publicForm.status).not.toBe(200);
      expect(publicForm.status).not.toBe(404);

      const submission = await request(testApp.server)
        .post(apiPath(`/public/forms/${form.slug}/responses`))
        .set('X-Forwarded-For', '198.51.100.42')
        .send({ answers: { [form.nameQuestionId]: 'Anton Aktiv' } });
      // `not.toBe(200)` and not `not.toBe(201)`: the public submission
      // **succeeds** with 200 (`public-forms.controller.ts`), and an assertion
      // against 201 would be green here without measuring anything — exactly
      // the kind of green CONTRIBUTING.md warns about.
      expect(submission.status).not.toBe(200);
      expect(submission.status).toBeGreaterThanOrEqual(500);
    });
  });
});
