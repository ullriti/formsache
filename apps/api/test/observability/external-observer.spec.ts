import 'reflect-metadata';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import { createTestApp, type TestApp } from '../support/create-test-app';
import { registeredRoutes } from '../support/registered-routes';

const READY = '/api/health/ready';

/**
 * **The external observer has something to ask — and learns exactly as much as
 * necessary** (ADR-0016).
 *
 * It is the only part of this monitoring that lives **outside** the
 * application, and the only one that sees the total outage: crashed container,
 * full disk, expired certificate, dead server. It is not built — set up, yes;
 * from this repository comes only what it can ask.
 *
 * What is measured here is exactly that: **reachable without login**,
 * **cheap**, **without disclosure**. That a real observer is running and that
 * its test alarm arrived can only be reported by the operator (the 🤝 half of
 * the requirement).
 */
describe('Die Bereitschaftsroute als Frage von außen ', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  it('antwortet **ohne Sitzung** — sonst sähe ein Beobachter jede 401 als „erreichbar"', async () => {
    const response = await request(testApp.server).get(READY);

    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({ ready: true });
  });

  it('gibt nichts preis außer der einen Aussage', async () => {
    const response = await request(testApp.server).get(READY);

    // „200 or 503" is already a disclosure about operations. A second field —
    // version, hostname, number of waiting mails — would be one that nobody
    // ordered and that would stand unauthenticated on the network.
    expect(Object.keys(response.body as object)).toStrictEqual(['ready']);
  });

  it('ist **billig**: ein Abruf rührt keine Fachtabelle an', async () => {
    // An observer asks every 60 seconds — 1 440 times a day. Every count over
    // `response`, `mail_log` or `job_run` in this route would be a permanent
    // run that nobody ordered; the numbers for that live in the operations
    // status behind the superadmin guard.
    const touched = watchDelegates(testApp, [
      'response',
      'mailLog',
      'jobRun',
      'aiUsage',
      'form',
      'tenant',
    ]);

    await request(testApp.server).get(READY);

    expect(touched()).toStrictEqual([]);
  });

  it('steht als öffentliche Route auf **einer** Adresse, nicht auf mehreren', () => {
    const ready = registeredRoutes(testApp).filter((route) =>
      route.path.endsWith('/health/ready'),
    );
    // A second address for the same question would be a second door that
    // nobody looks for on the allowlist in `07-oeffentliche-pfade.md`.
    expect(ready).toHaveLength(1);
    expect(ready[0]?.method).toBe('GET');
  });
});

/**
 * Reports which model delegates were **touched** during the call.
 *
 * Via an access counter on the instance instead of via Prisma's `query` event:
 * that would first have to be switched on with `log: ['query']`, and a test
 * that takes an empty list as proof would be green without having measured
 * anything — exactly the mistake that has already been made twelve times. A
 * touched delegate is by contrast a fact about this run.
 */
function watchDelegates(
  app: TestApp,
  names: readonly string[],
): () => string[] {
  const client = app.prisma as unknown as Record<string, unknown>;
  const touched: string[] = [];
  for (const name of names) {
    const original = client[name];
    Object.defineProperty(client, name, {
      configurable: true,
      get: () => {
        touched.push(name);
        return original;
      },
    });
  }
  return () => [...new Set(touched)];
}
