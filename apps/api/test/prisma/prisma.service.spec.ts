import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { API_ENV } from '../../src/config/env';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';

/**
 * Two things are proven here, and both were silent failures once already.
 *
 * 1. **The migration seam actually fires.** The provider runs
 *    `prisma migrate deploy` as soon as `prisma/schema.prisma` exists. Asserting
 *    `status === 'applied'` keeps a future refactor from quietly falling back
 *    to `skipped`, which would leave every integration test running against an
 *    empty database while still reporting green.
 *
 * 2. **NestJS dependency injection resolves `PrismaService`.** The API used
 *    to boot cleanly while injecting `undefined`, because esbuild cannot
 *    emit `design:paramtypes` (`docs/kb/04-build-run.md`). A test that only
 *    instantiated the class by hand would not have caught it — the container
 *    has to hand out the instance, and it has to reach the database.
 */
const SETUP_TIMEOUT_MS = 180_000;

describe('PrismaService', () => {
  let database: TestDatabase | undefined;
  let prisma: PrismaService;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    database = await acquireTestDatabase();

    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
    })
      // The application's own environment points at the development database;
      // the test has to run against the throwaway one.
      .overrideProvider(API_ENV)
      .useValue({
        NODE_ENV: 'test',
        API_PORT: 3000,
        APP_VERSION: '0.0.0-test',
        DATABASE_URL: database.url,
      })
      .compile();

    const app = await moduleRef.init();
    close = () => app.close();
    prisma = moduleRef.get(PrismaService);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await close?.();
    await database?.release();
  }, SETUP_TIMEOUT_MS);

  it('receives a migrated database rather than an empty one', () => {
    expect(database?.migrations.status).toBe('applied');
  });

  // Not `toBeInstanceOf`: the Prisma 7 client is a Proxy, and the identity
  // check recurses through its traps until the stack gives out. This asserts
  // something stronger anyway — that the *injected* environment arrived. Had
  // the container passed `undefined`, as it once silently did, the
  // connection string would be missing and this would not name the throwaway
  // database the test was handed.
  it('was constructed with the injected environment, not a default', async () => {
    const [row] = await prisma.$queryRaw<
      { current_database: string }[]
    >`SELECT current_database()`;

    expect(row?.current_database).toBe(database?.name);
  });

  it('reaches the database through the injected instance', async () => {
    const tenant = await prisma.tenant.create({
      data: {
        shortName: 'PROBE',
        name: 'Probe-Organisation',
        stripeColors: ['#212226'],
        accentColor: '#cea967',
        headerColor: '#212226',
        canvasColor: '#e9e6df',
      },
    });

    await expect(
      prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } }),
    ).resolves.toMatchObject({ shortName: 'PROBE' });
  });
});
