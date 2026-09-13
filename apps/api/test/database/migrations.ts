import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { z } from 'zod';

const execFileAsync = promisify(execFile);

/** Name of the `apps/api` workspace, used to recognise its root folder. */
const API_PACKAGE_NAME = '@formsache/api';

const packageManifestSchema = z.object({ name: z.string() });

/** Shape of a failed `execFile` — everything on it is optional to us. */
const execFailureSchema = z.object({ stderr: z.string().optional() });

/**
 * Locates the root of `apps/api` by walking upwards until a `package.json`
 * names this workspace.
 *
 * Deriving the path from `import.meta.url` would be shorter but does not
 * compile: `apps/api` is a CommonJS project (`module: "CommonJS"`, because
 * NestJS needs `emitDecoratorMetadata` via SWC/tsc, see
 * `docs/kb/04-build-run.md`), and `__dirname` in turn does not survive the
 * ESM transform Vitest applies. The walk mirrors `findEnvFile` in
 * `src/config/env.ts` and works from any working directory below the package.
 */
export function findApiRoot(start: string = process.cwd()): string | undefined {
  let directory = start;
  for (;;) {
    const manifest = join(directory, 'package.json');
    if (existsSync(manifest) && readsAs(manifest, API_PACKAGE_NAME)) {
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
}

function readsAs(manifest: string, name: string): boolean {
  const raw: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
  const parsed = packageManifestSchema.safeParse(raw);
  return parsed.success && parsed.data.name === name;
}

/**
 * Outcome of the migration step. `skipped` is a first-class result, not a
 * failure: not every checkout has the Prisma schema in place yet, and until
 * it does there is nothing to apply. The reason is reported so that a skip
 * can never be mistaken for a successful migration run.
 */
export type MigrationOutcome =
  | { readonly status: 'applied'; readonly schema: string }
  | { readonly status: 'skipped'; readonly reason: string };

/** Where the Prisma schema is expected to live — relative to the `apps/api` root. */
export const PRISMA_SCHEMA_RELATIVE_PATH = join('prisma', 'schema.prisma');

/**
 * Applies the versioned Prisma migrations to a freshly created database.
 *
 * `migrate deploy` (not `db push`) is used on purpose: it replays the
 * committed migration files, so the test database is built the same way a
 * production database is — that is what the requirement promises.
 */
export async function applyMigrations(
  databaseUrl: string,
): Promise<MigrationOutcome> {
  const apiRoot = findApiRoot();
  if (apiRoot === undefined) {
    // Not a "skip": a missing package root is a broken setup, not a state the
    // project passes through. Reporting it as `skipped` would let every
    // integration test run against an unmigrated database, with one word in
    // the log as the only trace.
    throw new Error(
      `cannot locate the ${API_PACKAGE_NAME} package root above ${process.cwd()} — ` +
        'run the API tests from inside the workspace',
    );
  }

  const schema = join(apiRoot, PRISMA_SCHEMA_RELATIVE_PATH);
  if (!existsSync(schema)) {
    return { status: 'skipped', reason: `no Prisma schema at ${schema}` };
  }

  try {
    await execFileAsync(
      'pnpm',
      ['exec', 'prisma', 'migrate', 'deploy', '--schema', schema],
      {
        cwd: apiRoot,
        // Prisma reads the target from the environment; handing it in per call
        // keeps the URL of the throwaway database out of any config file.
        env: { ...process.env, DATABASE_URL: databaseUrl },
      },
    );
  } catch (cause: unknown) {
    const details = execFailureSchema.safeParse(cause);
    const stderr = details.success ? (details.data.stderr ?? '') : '';
    // Prisma echoes the connection string it was handed. Test credentials are
    // local, but a message that travels into a CI log must not carry a
    // password out of the process.
    const safe = redactCredentials(stderr);
    throw new Error(
      `prisma migrate deploy failed for ${schema}${safe === '' ? '' : `: ${safe}`}`,
      { cause },
    );
  }

  return { status: 'applied', schema };
}

/**
 * Replaces the password in any `scheme://user:password@host` occurrence.
 * Deliberately blunt — it runs over foreign output, where the safe assumption
 * is that anything URL-shaped may carry a secret.
 */
export function redactCredentials(text: string): string {
  return text.replaceAll(/(:\/\/[^\s/:@]+):[^\s/@]*@/g, '$1:***@');
}
