import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { defineConfig } from 'prisma/config';

/**
 * Prisma CLI configuration (Prisma 7).
 *
 * Since Prisma 7 the datasource URL no longer lives in `schema.prisma`; the
 * migration commands read it from here, the application reads it from the
 * driver adapter in `src/prisma/prisma.service.ts`. Both take it from
 * `DATABASE_URL`, so there is still exactly one place to configure it — the
 * environment.
 */

/**
 * Applies the nearest `.env`, exactly as `src/config/env.ts` does for the
 * running application — walking upwards, and never overriding what the host
 * already set.
 *
 * Deliberately duplicated instead of imported: this file is loaded by the
 * Prisma CLI through its own module loader, before any workspace resolution
 * exists, so importing the application's loader (which pulls in `@formsache/shared`)
 * would tie the migration commands to the state of the TypeScript build.
 *
 * Without this, `prisma migrate deploy` fails with "The datasource.url
 * property is required in your Prisma config file" on a machine that is
 * configured perfectly well — the seed worked, because `seed.ts` loads `.env`
 * itself. Two commands reading the same variable from different places is the
 * kind of difference nobody debugs twice happily.
 */
function loadEnvFile(): void {
  let directory = process.cwd();
  for (;;) {
    const candidate = join(directory, '.env');
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      // No `.env` at all is the normal case in production, where the host
      // hands the environment in directly.
      return;
    }
    directory = parent;
  }
}

loadEnvFile();

/**
 * The URL is attached only when it is actually set.
 *
 * `prisma generate` needs no database — it runs in the Docker build and in a
 * fresh checkout, where `DATABASE_URL` may legitimately be absent. Throwing
 * here (as Prisma's own `env()` helper does) would break those. Every command
 * that *does* need a database still fails loudly, with Prisma's own message,
 * because the datasource is then simply missing.
 */
const url = process.env.DATABASE_URL;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  ...(url === undefined ? {} : { datasource: { url } }),
  migrations: {
    path: 'prisma/migrations',
    // CommonJS + SWC, exactly like the dev server: NestJS-style decorator
    // metadata is irrelevant to the seed, but using one transformer across the
    // package keeps `docs/kb/04-build-run.md` true.
    seed: 'node --require @swc-node/register prisma/seed.ts',
  },
});
