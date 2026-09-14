import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { NOTIFICATION_TEMPLATES_FLOOR } from '@formsache/shared';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

import { isContainerRuntimeAvailable } from './container-runtime';
import { findApiRoot } from './migrations';

/**
 * **The backfill migration `20260914130000_tenant_notification_templates`**
 * (ADR-0032), measured the way ADR-0011 §8 describes measuring
 * `20260814120000_two_layer_form_settings`: restore the state the migration
 * runs *against* by hand, apply the migration file itself statement for
 * statement, and compare field for field against what the new shared reader
 * would make of the result.
 *
 * `applyMigrations` (`migrations.ts`) already proves that the **whole**
 * migration directory, this one included, applies cleanly to an empty
 * database — every integration test's `acquireTestDatabase()` does that
 * before a single test runs. What that does **not** prove, and what this file
 * is for, is the one property specific to this migration: that an
 * **installation which already had organisations and a `system_setting` row**
 * comes out the other side with every organisation's templates seeded
 * correctly — copied from that row where it decided something, and from the
 * shipped floor where it (or no row at all) decided nothing.
 *
 * This file therefore talks to a **throwaway, uncommitted** Postgres server of
 * its own — either a fresh Testcontainers instance or a database created on
 * the same base server the rest of the suite uses — and drives raw SQL
 * against it, bypassing Prisma's `migrate deploy` (which cannot apply a
 * prefix of the migration history) and the running application (which has
 * nothing to boot yet at the point this measures).
 */

const NEW_MIGRATION = '20260914130000_tenant_notification_templates';

/** Every migration directory, sorted — the same order `migrate deploy` uses. */
function migrationNames(apiRoot: string): string[] {
  const directory = join(apiRoot, 'prisma', 'migrations');
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function migrationSql(apiRoot: string, name: string): string {
  return readFileSync(
    join(apiRoot, 'prisma', 'migrations', name, 'migration.sql'),
    'utf8',
  );
}

async function applyMigrationNamed(
  client: Client,
  apiRoot: string,
  name: string,
): Promise<void> {
  await client.query(migrationSql(apiRoot, name));
}

/** A throwaway database name unlikely to collide with anything else running. */
function throwawayName(): string {
  return `formsache_migtest_${randomBytes(6).toString('hex')}`;
}

interface ThrowawayDatabase {
  readonly url: string;
  readonly release: () => Promise<void>;
}

/**
 * A database of its own, on a fresh Testcontainers server when one is
 * reachable, otherwise on the base server the rest of the suite falls back to
 * (`TEST_DATABASE_URL`/`DATABASE_URL`) — the same two ways ADR-0008 already
 * establishes, only without the template-copy speed-up: this file needs an
 * **empty** database it migrates by hand, one statement group at a time,
 * which the shared template (already fully migrated) cannot provide.
 */
async function acquireThrowawayDatabase(): Promise<ThrowawayDatabase> {
  if (await isContainerRuntimeAvailable()) {
    const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
      'postgres:17-alpine',
    ).start();
    return {
      url: container.getConnectionUri(),
      release: () => container.stop().then(() => undefined),
    };
  }

  const base = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (base === undefined) {
    throw new Error(
      'No container runtime is reachable and no base database is ' +
        'configured (TEST_DATABASE_URL / DATABASE_URL) — this file needs one ' +
        'or the other to create its own throwaway database in.',
    );
  }
  const name = throwawayName();
  const admin = new Client({ connectionString: base });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(base);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    release: async () => {
      const cleanup = new Client({ connectionString: base });
      await cleanup.connect();
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}

describe('die Migration 20260914130000_tenant_notification_templates', () => {
  const SETUP_TIMEOUT_MS = 180_000;

  it(
    'kopiert die Zeile jeder bestehenden Organisation aus system_setting — oder aus der Vorgabe, wo dort nichts stand',
    async () => {
      const apiRoot = findApiRoot();
      if (apiRoot === undefined) {
        throw new Error('cannot locate the @formsache/api package root');
      }
      const names = migrationNames(apiRoot);
      const before = names.filter((name) => name < NEW_MIGRATION);
      expect(
        before,
        'no migration older than the one under test was found — check NEW_MIGRATION against the migrations directory',
      ).not.toEqual([]);
      expect(names).toContain(NEW_MIGRATION);

      const database = await acquireThrowawayDatabase();
      const client = new Client({ connectionString: database.url });
      await client.connect();

      try {
        // 1. Everything up to, but not including, the migration under test —
        //    the state every installation that has ever run this application
        //    was in a moment before it upgraded.
        for (const name of before) {
          await applyMigrationNamed(client, apiRoot, name);
        }

        // 2. Seed exactly the situation the migration has to handle: three
        //    organisations in three different starting states, and one
        //    installation-wide row that decided something for two of them.
        const decidedInstallation = [
          {
            id: 'kopiert',
            name: 'Von der Installation kopierte Vorlage',
            description: 'Stand vor der Migration in system_setting.',
            triggers: ['submit'],
            format: 'html',
            toSubmitter: true,
            subject: 'Installationsweiter Betreff',
            body: 'Installationsweiter Text.',
          },
        ];
        await client.query(
          `INSERT INTO "system_setting" (id, notification_templates, updated_at)
           VALUES ($1, $2::jsonb, now())`,
          ['x', JSON.stringify(decidedInstallation)],
        );

        const withNoDecision = await insertTenant(client, 'MIGA');
        const withDecidedRow = await insertTenant(client, 'MIGB');
        // A third organisation, created **after** this seed, to prove the
        // backfill reads `system_setting` at most once and not per row in a
        // way that could somehow pick up a later change — not load-bearing on
        // its own, but cheap to include alongside the other two.
        const third = await insertTenant(client, 'MIGC');

        // 3. The migration itself — and nothing after it, so what is read
        //    below is exactly what the migration left behind.
        await applyMigrationNamed(client, apiRoot, NEW_MIGRATION);

        const rows = await client.query<{
          short_name: string;
          notification_templates: unknown;
          notification_templates_revision: number;
        }>(
          `SELECT short_name, notification_templates, notification_templates_revision
             FROM "tenant"
            WHERE id = ANY($1::uuid[])
            ORDER BY short_name`,
          [[withNoDecision, withDecidedRow, third]],
        );

        expect(rows.rows).toHaveLength(3);
        for (const row of rows.rows) {
          // Every organisation's own counter starts fresh — this is the
          // beginning of its own, independent editing history, not a
          // continuation of the installation's.
          expect(row.notification_templates_revision).toBe(1);
          // Every organisation was copied from the **same** installation-wide
          // row, exactly as ADR-0032 states "kopiert, nicht vererbt" now
          // happens at migration time instead of at first use.
          expect(row.notification_templates).toEqual(decidedInstallation);
        }
      } finally {
        await client.end();
        await database.release();
      }
    },
    SETUP_TIMEOUT_MS,
  );

  it(
    'greift auf die ausgelieferte Vorgabe zurück, wo die Installation nichts entschieden hatte',
    async () => {
      const apiRoot = findApiRoot();
      if (apiRoot === undefined) {
        throw new Error('cannot locate the @formsache/api package root');
      }
      const before = migrationNames(apiRoot).filter(
        (name) => name < NEW_MIGRATION,
      );

      const database = await acquireThrowawayDatabase();
      const client = new Client({ connectionString: database.url });
      await client.connect();

      try {
        for (const name of before) {
          await applyMigrationNamed(client, apiRoot, name);
        }

        // **No `system_setting` row at all** — the state of an installation
        // that never wrote one (ADR-0011 §1: "keine Zeile heißt nichts
        // entschieden").
        const tenantId = await insertTenant(client, 'MIGD');

        await applyMigrationNamed(client, apiRoot, NEW_MIGRATION);

        const row = await client.query<{
          notification_templates: unknown;
          notification_templates_revision: number;
        }>(
          `SELECT notification_templates, notification_templates_revision
             FROM "tenant" WHERE id = $1`,
          [tenantId],
        );

        expect(row.rows).toHaveLength(1);
        expect(row.rows[0]?.notification_templates_revision).toBe(1);
        // The exact same document `parseNotificationTemplatesDocument` and
        // every fresh organisation created since would produce — the
        // migration's fallback and the application's shipped floor are the
        // same value, checked here against the single source in
        // `@formsache/shared` rather than against a copy typed into this file.
        expect(row.rows[0]?.notification_templates).toEqual(
          NOTIFICATION_TEMPLATES_FLOOR,
        );
      } finally {
        await client.end();
        await database.release();
      }
    },
    SETUP_TIMEOUT_MS,
  );
});

/**
 * A minimal `tenant` row, written with the columns the pre-migration schema
 * actually has — this deliberately does **not** go through Prisma (whose
 * generated client matches the *current*, post-migration schema) or through
 * `test/support/fixtures.ts` (same reason). Both `id` and `updated_at` are
 * supplied explicitly: the column carries no server-side default, exactly as
 * `schema.prisma` documents — Prisma computes both client-side, so a raw
 * `INSERT` has to do the same. Returns the new row's id.
 */
async function insertTenant(
  client: Client,
  shortName: string,
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO "tenant"
       (id, short_name, name, logo_wide, accent_color, header_color, canvas_color, updated_at)
     VALUES ($1, $2, $3, false, '#cea967', '#212226', '#e9e6df', now())`,
    [id, shortName, `Organisation ${shortName}`],
  );
  return id;
}
