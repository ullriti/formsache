import type { OpsStatus } from '@formsache/shared';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

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
 * **Quittieren gehört der Systemverwaltung** (ADR-0016, Fortschreibung
 * 2026-09-16).
 *
 * Die Überwachung zählt über alle Organisationen; wer sie stillstellen darf,
 * ist damit dieselbe Frage wie beim Lesen — `SessionGuard`, dann
 * `SuperadminGuard`, und sonst nichts. Der abgewiesene Aufrufer hier ist
 * `admin` seiner Organisation mit allen fünf Gruppenrechten: ein Abgewiesener
 * ohne Rechte belegte nur, dass *irgendein* Wächter feuert.
 *
 * *Gegenprobe:* `SuperadminGuard` vom Controller nehmen → die beiden
 * 403-Fälle werden rot.
 */
const PASSWORD = 'test-password';
const QUEUE_ACK = apiPath('/admin/ops/alerts/mail_queue_age/acknowledgement');

describe('die Quittierung eines Betriebsalarms', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  let alpha: TenantFixture;
  let tenantAdmin: string;
  let superadmin: string;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });

    alpha = await createTenant(testApp.prisma, 'OPSQ');

    const admin = await createUser(testApp.prisma, {
      email: 'organisation-admin@example.org',
      password: PASSWORD,
      tenants: [alpha],
    });
    tenantAdmin = await openSession(testApp, admin.id, alpha.id);

    const root = await createUser(testApp.prisma, {
      email: 'betrieb@example.org',
      name: 'Betriebsleitung',
      password: PASSWORD,
      isSuperadmin: true,
    });
    superadmin = await openSession(testApp, root.id, null);
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  afterEach(async () => {
    // Die Zeile ist installationsweit; eine liegengebliebene entschiede für
    // jeden folgenden Fall, was „nicht quittiert" heißt.
    await app().prisma.opsAlert.deleteMany({});
  });

  /** `object` and not `unknown`: supertest types its body, and the wrong values
   * this file sends are objects too — the schema is what rejects them. */
  function acknowledge(
    session: string,
    body: object = { duration: 'day' },
    path = QUEUE_ACK,
  ): Promise<request.Response> {
    return request(app().server)
      .post(path)
      .set(authedMutation(session))
      .send(body);
  }

  function release(session: string): Promise<request.Response> {
    return request(app().server).delete(QUEUE_ACK).set(authedMutation(session));
  }

  function stateOf(body: unknown): OpsStatus['alerts'][number] | undefined {
    return (body as OpsStatus).alerts.find(
      (state) => state.metric === 'mail_queue_age',
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Der unerlaubte Zugriff — beide Richtungen
  // ═══════════════════════════════════════════════════════════════════════

  it('weist den Organisations-Admin mit 403 ab und legt nichts an', async () => {
    const refused = await acknowledge(tenantAdmin);

    expect(refused.status).toBe(403);
    expect(await app().prisma.opsAlert.count()).toBe(0);
  });

  it('weist den Organisations-Admin auch beim Aufheben mit 403 ab', async () => {
    await acknowledge(superadmin);

    const refused = await release(tenantAdmin);

    expect(refused.status).toBe(403);
    // Die fremde Quittierung steht noch — eine abgewiesene Anfrage darf nichts
    // hinterlassen.
    const row = await app().prisma.opsAlert.findUnique({
      where: { metric: 'mail_queue_age' },
    });
    expect(row?.acknowledgedAt).not.toBeNull();
  });

  it('weist ohne Anmeldung mit 401 ab', async () => {
    const refused = await request(app().server)
      .post(QUEUE_ACK)
      .send({ duration: 'day' });

    expect(refused.status).toBe(401);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Der erlaubte Weg
  // ═══════════════════════════════════════════════════════════════════════

  it('quittiert und antwortet mit dem ganzen Betriebsstatus', async () => {
    const response = await acknowledge(superadmin, {
      duration: 'week',
      note: 'Mailserver zieht am Freitag um',
    });

    expect(response.status).toBe(201);
    const state = stateOf(response.body);
    expect(state?.acknowledgement).toMatchObject({
      by: 'Betriebsleitung',
      note: 'Mailserver zieht am Freitag um',
    });
    // Eine Frist wird **gerechnet**, nicht geschickt: `until` steht in der
    // Antwort, obwohl die Anfrage nur „7 Tage" gesagt hat.
    expect(state?.acknowledgement?.until).not.toBeNull();
  });

  it('lässt „bis auf Weiteres" ohne Frist stehen', async () => {
    const response = await acknowledge(superadmin, { duration: 'open' });

    expect(stateOf(response.body)?.acknowledgement?.until).toBeNull();
  });

  it('nimmt die Quittierung zurück', async () => {
    await acknowledge(superadmin);

    const response = await release(superadmin);

    expect(response.status).toBe(200);
    expect(stateOf(response.body)?.acknowledgement).toBeNull();
  });

  /**
   * Aufheben ohne Quittierung ist kein Fehler: der Aufrufer will den Zustand,
   * den er schon hat, und ein 404 wäre hier ein Rätsel statt einer Antwort.
   */
  it('nimmt auch zurück, was nie quittiert war', async () => {
    const response = await release(superadmin);

    expect(response.status).toBe(200);
    expect(await app().prisma.opsAlert.count()).toBe(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Fremdwerte
  // ═══════════════════════════════════════════════════════════════════════

  it('antwortet 400 auf eine Kennzahl, die es nicht gibt', async () => {
    const refused = await acknowledge(
      superadmin,
      { duration: 'day' },
      apiPath('/admin/ops/alerts/plattenplatz/acknowledgement'),
    );

    expect(refused.status).toBe(400);
    expect(await app().prisma.opsAlert.count()).toBe(0);
  });

  it('antwortet 400 auf eine Frist, die es nicht gibt', async () => {
    // ⚠️ Der eigentliche Punkt: ohne diese Grenze könnte ein Aufrufer sich
    // seine eigene Dauer ausdenken und die Überwachung auf Jahre stilllegen.
    const refused = await acknowledge(superadmin, { duration: 'forever' });

    expect(refused.status).toBe(400);
    expect(await app().prisma.opsAlert.count()).toBe(0);
  });

  it('antwortet 400 auf eine zu lange Begründung', async () => {
    const refused = await acknowledge(superadmin, {
      duration: 'day',
      note: 'x'.repeat(201),
    });

    expect(refused.status).toBe(400);
  });
});
