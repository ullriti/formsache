import { Client } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  acquireTestDatabase,
  creationTimeOf,
  dropOrphans,
  uniqueDatabaseName,
  type TestDatabase,
} from './test-database';

/**
 * Starting a container pulls an image on a cold machine; the external path is
 * fast but still crosses a network socket. Generous, because a timeout here
 * would look like a provider bug.
 */
const ACQUIRE_TIMEOUT_MS = 180_000;

const acquired: TestDatabase[] = [];

/** Registers a database so that a failing assertion cannot leak it. */
async function acquire(): Promise<TestDatabase> {
  const database = await acquireTestDatabase();
  acquired.push(database);
  return database;
}

async function withClient<T>(
  url: string,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

afterEach(async () => {
  await Promise.all(acquired.splice(0).map((database) => database.release()));
}, ACQUIRE_TIMEOUT_MS);

describe('acquireTestDatabase', () => {
  it(
    'hands out a database that accepts writes and reads them back',
    async () => {
      const database = await acquire();

      // A name PostgreSQL accepts unquoted — both strategies must produce one.
      expect(database.name).toMatch(/^[a-z][a-z0-9_]*$/);

      const rows = await withClient(database.url, async (client) => {
        await client.query('CREATE TABLE probe (marker text NOT NULL)');
        await client.query("INSERT INTO probe (marker) VALUES ('written')");
        const result = await client.query<{ marker: string }>(
          'SELECT marker FROM probe',
        );
        return result.rows;
      });

      expect(rows).toEqual([{ marker: 'written' }]);
    },
    ACQUIRE_TIMEOUT_MS,
  );

  // The point of the provider, and the reason the requirement can be trusted:
  // two databases obtained at the same time must not be able to see each
  // other. Asserting that both work would prove nothing — this asserts that
  // the forbidden read *fails*.
  it(
    'keeps two concurrently acquired databases invisible to each other',
    async () => {
      const [first, second] = await Promise.all([acquire(), acquire()]);

      expect(first.name).not.toBe(second.name);
      expect(first.url).not.toBe(second.url);

      await withClient(first.url, async (client) => {
        await client.query('CREATE TABLE isolation_probe (marker text)');
        await client.query(
          "INSERT INTO isolation_probe (marker) VALUES ('tenant-a')",
        );
      });

      await withClient(second.url, async (client) => {
        // 42P01 = undefined_table. The exact statement that just succeeded in
        // the first database has to fail here.
        await expect(
          client.query('SELECT marker FROM isolation_probe'),
        ).rejects.toMatchObject({ code: '42P01' });

        // …and even once the same table exists, the rows stay apart: the
        // failure above is separation, not a missing schema by accident.
        await client.query('CREATE TABLE isolation_probe (marker text)');
        const result = await client.query<{ marker: string }>(
          'SELECT marker FROM isolation_probe',
        );
        expect(result.rows).toEqual([]);
      });

      const survivors = await withClient(first.url, async (client) => {
        const result = await client.query<{ marker: string }>(
          'SELECT marker FROM isolation_probe',
        );
        return result.rows;
      });
      expect(survivors).toEqual([{ marker: 'tenant-a' }]);
    },
    ACQUIRE_TIMEOUT_MS,
  );

  it(
    'reports how the database was obtained instead of leaving it to guesswork',
    async () => {
      const announced = vi.spyOn(console, 'info');
      const database = await acquire();

      expect(['testcontainers', 'external']).toContain(database.strategy);
      // Without `apps/api/prisma/schema.prisma` in place, the migration step
      // has nothing to apply — and says so.
      expect(['applied', 'skipped']).toContain(database.migrations.status);

      // The announcement is the only thing standing between a green run and
      // the belief that Testcontainers produced it, so its content is part of
      // the contract — not decoration.
      const lines = announced.mock.calls.map(([line]) => String(line));
      expect(lines).toContainEqual(
        expect.stringContaining(`strategy=${database.strategy}`),
      );
      expect(lines).toContainEqual(
        expect.stringContaining(`database=${database.name}`),
      );
      announced.mockRestore();
    },
    ACQUIRE_TIMEOUT_MS,
  );

  // Guards the invariant the isolation rests on: whatever the strategy, the
  // URL must address a database this provider created — never the base
  // database it connected through.
  it(
    'addresses the freshly created database, never a pre-existing one',
    async () => {
      const database = await acquire();

      expect(new URL(database.url).pathname).toBe(`/${database.name}`);
      expect(creationTimeOf(database.name)).toBeTypeOf('number');
    },
    ACQUIRE_TIMEOUT_MS,
  );

  // A killed run (`SIGKILL`) never reaches `release()`; a signal handler
  // cannot help. The sweep on the way in is the only thing that keeps a
  // shared server from accumulating leftovers — measured here on both guards
  // at once: the aged database goes, the fresh one stays.
  it(
    'sweeps throwaway databases that outlived any possible run',
    async () => {
      const database = await acquire();
      const stale = uniqueDatabaseName(Date.now() - 3 * 60 * 60 * 1000);
      const fresh = uniqueDatabaseName();

      await withClient(database.url, async (client) => {
        await client.query(`CREATE DATABASE "${stale}"`);
        await client.query(`CREATE DATABASE "${fresh}"`);
        try {
          await dropOrphans(client);

          const result = await client.query<{ datname: string }>(
            'SELECT datname FROM pg_database WHERE datname = ANY($1)',
            [[stale, fresh]],
          );
          expect(result.rows.map((row) => row.datname)).toEqual([fresh]);
        } finally {
          await client.query(`DROP DATABASE IF EXISTS "${fresh}"`);
          await client.query(`DROP DATABASE IF EXISTS "${stale}"`);
        }
      });
    },
    ACQUIRE_TIMEOUT_MS,
  );

  it(
    'makes the database unreachable after release, and tolerates a second release',
    async () => {
      const database = await acquireTestDatabase();
      const { url } = database;

      await database.release();
      await database.release();

      await expect(
        withClient(url, (client) => client.query('SELECT 1')),
      ).rejects.toThrow();
    },
    ACQUIRE_TIMEOUT_MS,
  );
});
