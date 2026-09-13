import 'reflect-metadata';

import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { parseHealthResponse, parseReadinessResponse } from '@formsache/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { GLOBAL_API_PREFIX } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { RateLimitModule } from '../common/rate-limit.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { API_ENV, loadEnv } from '../config/env';
import { READINESS_TIMEOUT_MS, ReadinessService } from './readiness.service';

/**
 * **Readiness and liveness are two routes** (* ADR-0016).
 *
 * The case this is about is the second one below: `/api/health` answered `ok`
 * for as long as the process was alive — even with a dead database —,
 * and the compose healthcheck of the `api` asked exactly that route. So the
 * nginx front door started via `depends_on: … condition: service_healthy`
 * in front of an API that could not store a single answer.
 *
 * *Reproduction:* remove the database contact from
 * {@link ReadinessService.isReady} (read only the environment again) → the 503
 * case turns red. Remove the deadline → the hanging case runs into the test's
 * timeout instead of answering 503, and **exactly that** is the state in which
 * a healthcheck does more harm than good.
 */
describe('GET /api/health/ready', () => {
  /** What the database does in this run. */
  let respond: () => Promise<unknown>;
  let app: INestApplication;
  // `getHttpServer()` is `any` in Nest; pinned down once, as next door.
  let server: Server;

  beforeAll(async () => {
    vi.stubEnv('APP_VERSION', '9.9.9-test');
    const moduleRef = await Test.createTestingModule({
      // ⚠️ By now `/ready` carries a rate limit per address (a review finding:
      // it was the only public route without one and the only unauthenticated
      // one that occupies a database connection). `ThrottlerGuard`
      // needs the module options — without this import the container does not
      // build the guard, and the whole file fails before the first assertion.
      imports: [RateLimitModule],
      controllers: [HealthController],
      providers: [
        HealthService,
        ReadinessService,
        { provide: API_ENV, useFactory: () => loadEnv() },
        // A double instead of a real connection: what is checked is the route's
        // *branching*, not the driver. The real contact runs in the `stack` job
        // against a stopped `db` container.
        { provide: PrismaService, useValue: { $queryRaw: () => respond() } },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix(GLOBAL_API_PREFIX);
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  it('antwortet 200 mit `ready: true`, wenn die Datenbank antwortet', async () => {
    respond = () => Promise.resolve([{ '?column?': 1 }]);

    const response = await request(server).get(
      `/${GLOBAL_API_PREFIX}/health/ready`,
    );

    expect(response.status).toBe(200);
    expect(parseReadinessResponse(response.body)).toStrictEqual({
      ready: true,
    });
  });

  it('antwortet 503, wenn die Datenbank weg ist — und `/api/health` bleibt 200', async () => {
    respond = () => Promise.reject(new Error('connect ECONNREFUSED'));

    const ready = await request(server).get(
      `/${GLOBAL_API_PREFIX}/health/ready`,
    );
    const live = await request(server).get(`/${GLOBAL_API_PREFIX}/health`);

    expect(ready.status).toBe(503);
    expect(parseReadinessResponse(ready.body)).toStrictEqual({ ready: false });
    // The pair is the actual assurance: the process is alive, it is only not
    // ready. A single route cannot say this difference.
    expect(live.status).toBe(200);
    expect(parseHealthResponse(live.body).status).toBe('ok');
  });

  it('antwortet 503 statt zu hängen, wenn die Verbindung nicht scheitert, sondern steht', async () => {
    // The commoner failure: the connection does not answer and does not refuse
    // either. Without a deadline of its own the checker would get *no* answer
    // at all.
    respond = () => new Promise(() => undefined);

    const started = Date.now();
    const response = await request(server).get(
      `/${GLOBAL_API_PREFIX}/health/ready`,
    );

    expect(response.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(READINESS_TIMEOUT_MS * 3);
  });

  it('gibt keine Auskunft über die Installation — auch nicht im Fehlerfall', async () => {
    respond = () =>
      Promise.reject(
        new Error('connect ECONNREFUSED 10.1.2.3:5432 (db.internal)'),
      );

    const response = await request(server).get(
      `/${GLOBAL_API_PREFIX}/health/ready`,
    );

    // The route is publicly reachable (07-oeffentliche-pfade.md). „200
    // oder 503" is already a disclosure; host name, address and driver class
    // would be a second one that nobody ordered.
    const body = JSON.stringify(response.body);
    expect(body).not.toMatch(/ECONNREFUSED|10\.1\.2\.3|db\.internal|5432/);
    expect(Object.keys(response.body as object)).toStrictEqual(['ready']);
  });

  it('fragt die Datenbank genau einmal je Abruf — ein Beobachter fragt 1 440-mal am Tag', async () => {
    let calls = 0;
    respond = () => {
      calls += 1;
      return Promise.resolve([{ '?column?': 1 }]);
    };

    await request(server).get(`/${GLOBAL_API_PREFIX}/health/ready`);

    expect(calls).toBe(1);
  });
});
