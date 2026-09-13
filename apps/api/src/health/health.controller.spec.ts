import 'reflect-metadata';

import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { parseHealthResponse } from '@formsache/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { GLOBAL_API_PREFIX } from '../app.module';
import { HealthModule } from './health.module';

/**
 * `HealthModule`, not `AppModule`.
 *
 * The health endpoint needs nothing but its own module, and booting the whole
 * application here pulled in `AuthModule → PrismaModule` — a `PrismaService`
 * and a throttler in a suite about a version string, held up only by the pg
 * adapter building its pool lazily. (The environment itself is still read:
 * `HealthModule` provides `API_ENV` through `loadEnv()`, so `DATABASE_URL` and
 * `NODE_ENV` must be present — `test/setup-env.ts` sees to that. What goes
 * away is the client, not the variable.) The integration suites that really
 * want the whole application go through `test/support/create-test-app.ts`;
 * this one stays a unit test of the controller and its module.
 *
 * The global prefix is still applied exactly as `main.ts` applies it —
 * otherwise the suite would be green about a URL the server does not serve.
 */
describe('GET /api/health', () => {
  let app: INestApplication;

  beforeAll(async () => {
    vi.stubEnv('APP_VERSION', '9.9.9-test');
    const moduleRef = await Test.createTestingModule({
      imports: [HealthModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix(GLOBAL_API_PREFIX);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  it('answers with a payload that satisfies the shared schema', async () => {
    // `getHttpServer()` is typed as `any` by Nest; pin it down once.
    const server = app.getHttpServer() as Server;
    const response = await request(server).get(`/${GLOBAL_API_PREFIX}/health`);

    expect(response.status).toBe(200);
    // supertest types the body as `any`; it is foreign data and enters as
    // `unknown`, then gets parsed.
    const body = parseHealthResponse(response.body as unknown);
    expect(body.status).toBe('ok');
    expect(body.version).toBe('9.9.9-test');
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});
