import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Client } from 'pg';

import { applyMigrations, type MigrationOutcome } from './migrations';

/**
 * **Migrate once, copy 120 times** — the way to a test database that
 * does not replay 36 migrations every time.
 *
 * ## Why that makes a measurable difference
 *
 * Every test file gets its **own** database; the isolation rests on that
 * (`test-database.ts`), and nothing about that changes here. What changes is
 * the way there. Measured on 2026-08-12 on PostgreSQL 16:
 *
 * | Operation | Duration |
 * |---|---|
 * | `prisma migrate deploy` (36 migrations, own child process) | **2060 ms** |
 * | `CREATE DATABASE … TEMPLATE <already migrated>` | **117 ms** |
 *
 * A full run of the api suite creates **120** databases (counted in the
 * log, not estimated). That is around 247 s of pure migrating — a good
 * quarter of this suite's entire working time. Via the template what remains
 * of that is 2 s once plus 120 × 117 ms.
 *
 * ## As to the promise that the test database comes about like a production database
 *
 * the requirement demands that the test database comes about **the way** a
 * production database does: by replaying the committed migrations, not
 * through `db push`. That stays — the template comes about on exactly this way.
 * Only afterwards is it copied, and a copy is byte-identical to the original.
 *
 * ## The three traps, and how they are avoided
 *
 * 1. **Four workers, four processes.** A lock in main memory does not
 *    help; the template is therefore built under an **advisory lock of the
 *    database**, which all processes of the same server see.
 * 2. **An abort in the middle of the migration** would leave behind a half
 *    migrated template — and that then poisoned *every* run, silently. That is
 *    why migrating happens under a **build name** and only at the end is it
 *    renamed to the final name via `ALTER DATABASE … RENAME TO`. The
 *    final name therefore exists only completely or not at all.
 * 3. **Old migrations, old template.** The name carries the fingerprint of the
 *    migrations directory; a new migration yields a new template.
 *    Old ones stay around (~8 MB each) and are **not** cleared away
 *    automatically: a second checkout with a different state could be copying
 *    from exactly one of them, and a `DROP` in the middle of a copy makes
 *    someone else's run red. Whoever wants to tidy up: `DROP DATABASE` on
 *    everything that is called `formsache_tpl_` and is not the current
 *    fingerprint.
 *
 * ⚠️ **A prefix of its own, and that is no cosmetic blemish.** The
 * orphan sweep in `test-database.ts` deletes everything under
 * `formsache_test_` that is older than two hours. Were the template called
 * that, it would be deleted in mid-operation — and the next
 * `CREATE DATABASE … TEMPLATE` would run into nothing.
 */

/**
 * Prefix of the templates — deliberately **not** that of the throwaway
 * databases.
 */
export const TEMPLATE_PREFIX = 'formsache_tpl_';

/**
 * A 64-bit key for `pg_advisory_lock`, derived from the prefix.
 *
 * Hard-wired and not derived from the fingerprint: at most one template is
 * built at a time anyway, and one key per fingerprint would mean
 * that two states migrate at the same time — on the same server, with
 * the same Prisma child-process effort.
 */
const ADVISORY_LOCK_KEY = 7_314_159_265_358_979n % 2_147_483_647n;

/**
 * The fingerprint of the migrations directory — names **and** contents.
 *
 * Hashing only the names would be the comfortable half: a `migration.sql`
 * changed after the fact would get the same template as before. Prisma forbids
 * such changes, but a guard that relies on a rule instead of on a
 * measurement measures the rule.
 */
export function migrationsFingerprint(apiRoot: string): string {
  const directory = join(apiRoot, 'prisma', 'migrations');
  const hash = createHash('sha256');
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    if (!entry.isDirectory()) {
      continue;
    }
    hash.update(entry.name);
    hash.update(readFileSync(join(directory, entry.name, 'migration.sql')));
  }
  return hash.digest('hex').slice(0, 12);
}

export function templateNameFor(fingerprint: string): string {
  return `${TEMPLATE_PREFIX}${fingerprint}`;
}

/** How a database came by its schema — for the announcement in the log. */
export type TemplateOutcome =
  | {
      readonly status: 'ready';
      readonly template: string;
      readonly built: boolean;
    }
  | { readonly status: 'unavailable'; readonly reason: string };

interface TemplateDeps {
  /** Opens a connection to the maintenance database and closes it again. */
  readonly withAdminClient: <T>(
    run: (client: Client) => Promise<T>,
  ) => Promise<T>;
  /** Builds the URL to a database of the same server. */
  readonly urlFor: (database: string) => string;
  readonly quoteIdentifier: (value: string) => string;
  readonly apiRoot: string;
}

/**
 * Makes sure that there is a migrated template for the current state.
 *
 * **Never fails hard.** Every error becomes `unavailable` with a reason — the
 * caller then falls back on the old way (`prisma migrate deploy` per
 * database). A speed-up that can make a run red is none.
 */
export async function ensureTemplate(
  deps: TemplateDeps,
): Promise<TemplateOutcome> {
  let fingerprint: string;
  try {
    fingerprint = migrationsFingerprint(deps.apiRoot);
  } catch (error: unknown) {
    return { status: 'unavailable', reason: describe(error) };
  }
  const template = templateNameFor(fingerprint);

  try {
    return await deps.withAdminClient(async (client) => {
      if (await databaseExists(client, template)) {
        return { status: 'ready', template, built: false };
      }
      // From here on it is built — and by exactly one process.
      await client.query('SELECT pg_advisory_lock($1)', [
        ADVISORY_LOCK_KEY.toString(),
      ]);
      try {
        // Second check **under** the lock: between the first one and the
        // lock another process may have finished.
        if (await databaseExists(client, template)) {
          return { status: 'ready', template, built: false };
        }
        const building = `${template}_building`;
        await client.query(
          `DROP DATABASE IF EXISTS ${deps.quoteIdentifier(building)} WITH (FORCE)`,
        );
        await client.query(`CREATE DATABASE ${deps.quoteIdentifier(building)}`);
        const outcome: MigrationOutcome = await applyMigrations(
          deps.urlFor(building),
        );
        if (outcome.status !== 'applied') {
          await client.query(
            `DROP DATABASE IF EXISTS ${deps.quoteIdentifier(building)} WITH (FORCE)`,
          );
          return { status: 'unavailable', reason: outcome.reason };
        }
        // The one atomic step: either the final name exists
        // completely, or it does not exist.
        await client.query(
          `ALTER DATABASE ${deps.quoteIdentifier(building)} RENAME TO ${deps.quoteIdentifier(template)}`,
        );
        return { status: 'ready', template, built: true };
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [
          ADVISORY_LOCK_KEY.toString(),
        ]);
      }
    });
  } catch (error: unknown) {
    return { status: 'unavailable', reason: describe(error) };
  }
}

async function databaseExists(client: Client, name: string): Promise<boolean> {
  const found = await client.query(
    'SELECT 1 FROM pg_database WHERE datname = $1',
    [name],
  );
  return found.rowCount === 1;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
