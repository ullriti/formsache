import { randomBytes } from 'node:crypto';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Client } from 'pg';
import { z } from 'zod';

import { isContainerRuntimeAvailable } from './container-runtime';
import {
  applyMigrations,
  findApiRoot,
  type MigrationOutcome,
} from './migrations';
import { ensureTemplate } from './template-database';

/**
 * Kept in sync with the `db` service in `docker-compose.yml`. When the two
 * drift apart, the Testcontainers path stops testing what production runs —
 * which is the whole reason it is the default (ADR-0008).
 */
const POSTGRES_IMAGE = 'postgres:17-alpine';

/** Marks every database this provider creates, for the orphan sweep below. */
const DATABASE_PREFIX = 'formsache_test_';

/**
 * A throwaway database older than this cannot belong to a running suite any
 * more. Deliberately far beyond any plausible test run: the sweep must never
 * pull the ground out from under a worker that is between `CREATE DATABASE`
 * and its first connection.
 */
const ORPHAN_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** How a test database was obtained. Reported, never guessed. */
export type TestDatabaseStrategy = 'testcontainers' | 'external';

/** What the caller may ask for; `auto` lets the runtime decide. */
export type StrategyPreference = 'auto' | TestDatabaseStrategy;

/**
 * `z.url()` alone is too permissive here: `new URL('localhost:5432')` parses
 * happily with protocol `localhost:`, so a forgotten scheme would slip through
 * and surface much later as an unrelated driver error.
 */
const postgresUrlSchema = z.url().refine(
  (value) => {
    const protocol = URL.parse(value)?.protocol;
    return protocol === 'postgres:' || protocol === 'postgresql:';
  },
  { message: 'must be a postgres:// or postgresql:// URL' },
);

const testDatabaseEnvSchema = z.object({
  TEST_DATABASE_URL: postgresUrlSchema.optional(),
  DATABASE_URL: postgresUrlSchema.optional(),
  TEST_DATABASE_STRATEGY: z
    .enum(['auto', 'testcontainers', 'external'])
    .default('auto'),
});
export type TestDatabaseEnv = z.infer<typeof testDatabaseEnvSchema>;

export interface TestDatabase {
  /** Connection URL of a database this caller owns exclusively. */
  readonly url: string;
  /** Name of that database — unique across parallel workers and reruns. */
  readonly name: string;
  readonly strategy: TestDatabaseStrategy;
  readonly migrations: MigrationOutcome;
  /** Drops the database or stops the container. Safe to call more than once. */
  release: () => Promise<void>;
}

/** What a strategy produces before migrations run. */
interface RawDatabase {
  readonly url: string;
  readonly name: string;
  /** Server description for the announcement — image tag and/or real version. */
  readonly server: string;
  readonly release: () => Promise<void>;
  /**
   * Set when the database brings its schema along **already** — it is then the
   * copy of a migrated template (`template-database.ts`). `undefined` means „not
   * filled yet", and the caller migrates itself.
   */
  readonly migrations?: MigrationOutcome;
}

/** A database created inside an already reachable server. */
interface CreatedDatabase {
  readonly url: string;
  readonly name: string;
  readonly serverVersion: string;
  readonly release: () => Promise<void>;
}

/**
 * Hands out a fresh, empty PostgreSQL database with the migrations applied.
 *
 * Two interchangeable ways lead there (ADR-0008): a Testcontainers instance
 * when a container runtime answers, otherwise an already running server named
 * by `TEST_DATABASE_URL` (falling back to `DATABASE_URL`). Callers see the
 * same object either way and must not care — but the chosen way is announced,
 * because a reader who assumes Testcontainers ran when it did not draws the
 * wrong conclusion from a green suite.
 */
export async function acquireTestDatabase(
  source: NodeJS.ProcessEnv = process.env,
): Promise<TestDatabase> {
  const env = readEnvironment(source);
  const preference = env.TEST_DATABASE_STRATEGY;
  // `external` does not ask: probing is slow when nothing answers, and the
  // answer could not change the outcome.
  const runtimeAvailable =
    preference === 'external' ? false : await isContainerRuntimeAvailable();
  const strategy = resolveStrategy(preference, runtimeAvailable);

  const raw =
    strategy === 'testcontainers'
      ? await startContainerDatabase()
      : await useExternalDatabase(selectBaseUrl(env));

  announce(strategy, raw);

  let migrations: MigrationOutcome;
  try {
    // A copy of the template carries the migrations already — replaying them
    // once more would not be wrong, only 2 seconds expensive, 120 times per
    // run.
    migrations = raw.migrations ?? (await applyMigrations(raw.url));
  } catch (error: unknown) {
    // A half-migrated database is worse than none — but cleaning it up must
    // not overwrite the reason we got here.
    await releaseQuietly(raw.release, raw.name);
    throw error;
  }
  announceMigrations(raw.name, migrations);

  // A cached promise rather than a boolean: two concurrent `release()` calls
  // would both pass a `released = false` check and issue two DROPs.
  let releasing: Promise<void> | undefined;
  return {
    url: raw.url,
    name: raw.name,
    strategy,
    migrations,
    release: () => {
      releasing ??= raw.release();
      return releasing;
    },
  };
}

/**
 * Validates the test-relevant environment. An empty variable counts as absent:
 * without that, an exported but unset `TEST_DATABASE_URL=` would fail URL
 * validation instead of falling back to `DATABASE_URL`.
 */
export function readEnvironment(source: NodeJS.ProcessEnv): TestDatabaseEnv {
  return testDatabaseEnvSchema.parse({
    TEST_DATABASE_URL: blankToUndefined(source.TEST_DATABASE_URL),
    DATABASE_URL: blankToUndefined(source.DATABASE_URL),
    TEST_DATABASE_STRATEGY: blankToUndefined(source.TEST_DATABASE_STRATEGY),
  });
}

/**
 * Turns a preference plus the measured runtime state into a decision.
 *
 * Split out from the probe on purpose: this is the rule ADR-0008 and the CI
 * recommendation rest on, and as a pure function it can be proven on a machine
 * that has no Docker at all.
 */
export function resolveStrategy(
  preference: StrategyPreference,
  runtimeAvailable: boolean,
): TestDatabaseStrategy {
  if (preference === 'external') {
    return 'external';
  }
  if (preference === 'testcontainers') {
    if (!runtimeAvailable) {
      throw new Error(
        'TEST_DATABASE_STRATEGY=testcontainers, but no container runtime ' +
          'answered. Start a Docker daemon, or set ' +
          'TEST_DATABASE_STRATEGY=auto to allow the external database.',
      );
    }
    return 'testcontainers';
  }
  return runtimeAvailable ? 'testcontainers' : 'external';
}

/** `TEST_DATABASE_URL` wins over `DATABASE_URL`; neither is an error. */
export function selectBaseUrl(env: TestDatabaseEnv): string {
  const base = env.TEST_DATABASE_URL ?? env.DATABASE_URL;
  if (base === undefined) {
    throw new Error(
      'No container runtime is reachable and no base database is configured. ' +
        'Start a Docker daemon (`docker compose up -d db` covers both), or ' +
        'point TEST_DATABASE_URL at a PostgreSQL server the tests may create ' +
        'and drop databases in.',
    );
  }
  return base;
}

function blankToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

async function useExternalDatabase(baseUrl: string): Promise<RawDatabase> {
  // ⚠️ **The accelerator must not make a run red.** `ensureTemplate` never
  // throws; if it fails, `unavailable` comes back with a reason, and this way is
  // exactly the old one — an empty database that the caller migrates.
  const apiRoot = findApiRoot();
  const template =
    apiRoot === undefined
      ? {
          status: 'unavailable' as const,
          reason: 'no @formsache/api package root',
        }
      : await ensureTemplate({
          apiRoot,
          withAdminClient: (run) => withAdminClient(baseUrl, run),
          urlFor: (database) => withDatabaseName(baseUrl, database),
          quoteIdentifier,
        });
  if (template.status === 'unavailable') {
    announceTemplateGap(template.reason);
  }

  const created = await createDatabaseIn(
    baseUrl,
    template.status === 'ready' ? template.template : undefined,
  );
  // `exactOptionalPropertyTypes`: „not set" and „set to undefined" are two
  // different things here, and only the first means „please migrate
  // yourself".
  const fromTemplate: Pick<RawDatabase, 'migrations'> =
    template.status === 'ready'
      ? {
          migrations: {
            status: 'applied',
            // The truth, not the convenient wording: they were replayed
            // **once**, into the template. This database is its copy.
            schema: `${template.template} (Vorlage, ${template.built ? 'gerade gebaut' : 'wiederverwendet'})`,
          },
        }
      : {};
  return {
    ...fromTemplate,
    url: created.url,
    name: created.name,
    // The *measured* version, not the expected one — this is the line that
    // tells a reader the run may not have been on the production version
    // (ADR-0008).
    server: `PostgreSQL ${created.serverVersion}`,
    release: created.release,
  };
}

async function startContainerDatabase(): Promise<RawDatabase> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    POSTGRES_IMAGE,
  ).start();
  try {
    // The container's own database is called `test` — a fixed name baked into
    // `@testcontainers/postgresql`. Handing that out would give two
    // concurrently started containers the same `name`, so this path creates
    // its database through exactly the same code as the external one and
    // inherits the generated, unique name.
    const created = await createDatabaseIn(container.getConnectionUri());
    return {
      url: created.url,
      name: created.name,
      server: `image ${POSTGRES_IMAGE} (PostgreSQL ${created.serverVersion})`,
      // Stopping the container takes the database with it; dropping first
      // would only add a round trip to a server about to disappear.
      release: () => container.stop().then(() => undefined),
    };
  } catch (error: unknown) {
    await releaseQuietly(
      () => container.stop().then(() => undefined),
      'the started container',
    );
    throw error;
  }
}

/**
 * Creates a throwaway database inside an existing server.
 *
 * Isolation rests on one database per caller: Vitest runs test files in
 * parallel workers, so a shared database would let one file see another's
 * rows. PostgreSQL does not allow cross-database queries, which makes the
 * boundary a hard one rather than a convention.
 */
async function createDatabaseIn(
  baseUrl: string,
  template?: string,
): Promise<CreatedDatabase> {
  const name = uniqueDatabaseName();
  const serverVersion = await withAdminClient(baseUrl, async (client) => {
    await dropOrphans(client);
    // `TEMPLATE` copies an already migrated database instead of creating an
    // empty one — the same isolation, one eighteenth of the time.
    await client.query(
      template === undefined
        ? `CREATE DATABASE ${quoteIdentifier(name)}`
        : `CREATE DATABASE ${quoteIdentifier(name)} TEMPLATE ${quoteIdentifier(template)}`,
    );
    // `current_setting` rather than `SHOW`, because only this spelling lets us
    // name the result column and keeps the row shape predictable.
    const result = await client.query<{ version: string }>(
      "SELECT current_setting('server_version') AS version",
    );
    return result.rows[0]?.version ?? 'unknown';
  });

  const url = withDatabaseName(baseUrl, name);
  requireOwnDatabase(baseUrl, url, name);

  return {
    url,
    name,
    serverVersion,
    release: async () => {
      await withAdminClient(baseUrl, async (client) => {
        // FORCE terminates leftover connections. Without it a client a test
        // forgot to close would keep the database alive until the server
        // restarts, and the next run would drown in orphans.
        await client.query(
          `DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`,
        );
      });
    },
  };
}

/**
 * Removes throwaway databases that no run can still own.
 *
 * A killed process (`SIGKILL`, a crashed CI runner) never reaches `release()`,
 * and no signal handler can change that — so the cleanup happens on the way
 * *in*, where a live process is guaranteed. Two guards must both agree before
 * anything is dropped: the name has to carry a creation timestamp older than
 * {@link ORPHAN_MAX_AGE_MS}, and nothing may be connected to it.
 */
export async function dropOrphans(
  client: Client,
  now: number = Date.now(),
): Promise<void> {
  const candidates = await client.query<{ datname: string }>(
    `SELECT d.datname
       FROM pg_database d
      WHERE d.datname LIKE '${DATABASE_PREFIX.replaceAll('_', '\\_')}%'
        AND NOT EXISTS (
              SELECT 1 FROM pg_stat_activity a WHERE a.datname = d.datname
            )`,
  );

  for (const { datname } of candidates.rows) {
    const createdAt = creationTimeOf(datname);
    if (createdAt === undefined || now - createdAt < ORPHAN_MAX_AGE_MS) {
      continue;
    }
    try {
      // No FORCE here: if someone connected between the query and now, the
      // drop is supposed to fail rather than tear their session down.
      await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(datname)}`);
    } catch {
      // Sweeping is opportunistic — another worker may have won the race, or
      // the role may lack the rights. Never a reason to fail a test run.
    }
  }
}

async function withAdminClient<T>(
  baseUrl: string,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: baseUrl });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

/**
 * The timestamp makes leftovers sweepable, the random part keeps parallel
 * workers and two checkouts on one server apart. A worker id would do neither.
 */
export function uniqueDatabaseName(now: number = Date.now()): string {
  return `${DATABASE_PREFIX}${String(now)}_${randomBytes(9).toString('hex')}`;
}

/** Reads back the creation time; `undefined` for anything not ours. */
export function creationTimeOf(name: string): number | undefined {
  // Built from the prefix constant so the two cannot drift apart.
  const match = new RegExp(`^${DATABASE_PREFIX}(\\d+)_[0-9a-f]+$`).exec(name);
  if (match?.[1] === undefined) {
    return undefined;
  }
  return Number(match[1]);
}

/**
 * The invariant the whole isolation story rests on: the URL handed out must
 * address the database we just created and never the base database. A slip in
 * the URL assembly would otherwise give every caller the shared database — and
 * turn the isolation test into a formality that passes for the wrong reason.
 */
export function requireOwnDatabase(
  baseUrl: string,
  url: string,
  name: string,
): void {
  const target = databaseNameOf(url);
  if (target !== name || target === databaseNameOf(baseUrl)) {
    throw new Error(
      `test database URL addresses ${target ?? '(no database)'} instead of the ` +
        `freshly created ${name} — refusing to hand out a shared database`,
    );
  }
}

function databaseNameOf(url: string): string | undefined {
  const path = new URL(url).pathname.replace(/^\//, '');
  return path === '' ? undefined : decodeURIComponent(path);
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function withDatabaseName(baseUrl: string, name: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${encodeURIComponent(name)}`;
  return url.toString();
}

async function releaseQuietly(
  release: () => Promise<void>,
  what: string,
): Promise<void> {
  try {
    await release();
  } catch (error: unknown) {
    // Cleanup must never overwrite the reason we are unwinding.
    console.warn(
      `[test-database] could not clean up ${what}: ${describeError(error)}`,
    );
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

function announce(strategy: TestDatabaseStrategy, raw: RawDatabase): void {
  const note =
    strategy === 'testcontainers'
      ? ''
      : ' — no container runtime reachable, using the configured base URL';
  console.info(
    `[test-database] strategy=${strategy} server=${raw.server} database=${raw.name}${note}`,
  );
}

/**
 * Why the template was not used — once per database, with a reason.
 *
 * Falling back silently would be the worse mistake: the run would stay green and
 * would take four times as long again, without anybody learning why.
 */
function announceTemplateGap(reason: string): void {
  console.info(`[test-database] template unavailable (${reason}) — migrating`);
}

function announceMigrations(name: string, outcome: MigrationOutcome): void {
  const detail =
    outcome.status === 'applied'
      ? `applied from ${outcome.schema}`
      : `skipped (${outcome.reason})`;
  console.info(`[test-database] migrations ${detail} database=${name}`);
}
