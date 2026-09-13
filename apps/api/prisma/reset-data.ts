import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';

import { loadEnvFile } from '../src/config/env';

/**
 * Empties every data table so a test run starts from a known state.
 *
 * **Why this exists.** Nothing in the application could delete a form, so
 * every `pnpm e2e` left its forms behind — `e2e/app-flows.ts` says so
 * itself and gives each form a unique title to cope. What it did not foresee is
 * what the residue costs: `GET /api/forms` has no limit and the dashboard
 * renders every row, so each `page.goto('/')` grows by the length of the list.
 * Measured on 2026-08-01 with 2748 forms in a development database: two stalls
 * of ~2.8 s inside one `newForm`, with no request in flight between them, and
 * the five seconds it waits for the builder ran out. Six of seven failures in
 * that run were this and nothing else — the suite was measuring its own
 * history. CI never saw it, because CI gets a fresh database every time.
 *
 * The fix is to give every run what CI has. The seed then puts the fixtures
 * back; it is idempotent by construction, so the pair
 * "reset, then seed" is the known state, not merely a cleaner one.
 *
 * **This deletes data.** `pnpm e2e` therefore owns the database it points at.
 * That is a real contract and it is stated in `docs/kb/04-build-run.md`: point
 * `DATABASE_URL` somewhere else before running the suite if the database holds
 * anything worth keeping.
 *
 * The table list is read from the database rather than written down, so a
 * migration that adds a table cannot quietly reintroduce the problem for that
 * table alone. `_prisma_migrations` is the one exception — dropping it would
 * make the next `migrate deploy` replay every migration.
 */

const resetEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  NODE_ENV: z.string().optional(),
});

async function resetData(): Promise<void> {
  loadEnvFile();
  const env = resetEnvSchema.parse(process.env);

  // Cheap, and the one mistake worth making impossible: this script is run by
  // a test harness, and a harness pointed at the wrong environment is exactly
  // how production data disappears.
  if (env.NODE_ENV === 'production') {
    throw new Error(
      'refusing to empty the database with NODE_ENV=production. ' +
        'This script exists for development and test databases only.',
    );
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });

  try {
    const tables = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
    `;

    if (tables.length === 0) {
      console.info('[reset] no tables — nothing to empty');
      return;
    }

    // One statement, because `TRUNCATE a, b` defers the foreign keys between
    // the named tables; truncating them one by one would fail on the first
    // table something else still points at. `CASCADE` covers a table this
    // query cannot see, `RESTART IDENTITY` the sequences behind it.
    const list = tables
      .map((row) => `"${row.tablename.replace(/"/gu, '""')}"`)
      .join(', ');
    await prisma.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);

    console.info(`[reset] emptied ${String(tables.length)} tables`);
  } finally {
    await prisma.$disconnect();
  }
}

resetData().catch((error: unknown) => {
  console.error('[reset] failed:', error);
  process.exitCode = 1;
});
