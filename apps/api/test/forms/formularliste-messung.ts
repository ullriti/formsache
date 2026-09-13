/**
 * **How expensive is one page of `GET /api/forms`?** — the measurement the
 * page size of the wire contract comes from (the specification).
 *
 * ## Why this script exists
 *
 * the specification records that the number that has to be built against is
 * **not known**, and forbids guessing it. What it does know is a
 * measurement of the *client* side — 2748 accumulated forms brought
 * `page.goto('/')` to 2,8 s of stalled main thread. What nobody has measured
 * is the *server* side: response time and payload per page size. Without the
 * second half, "24" would be a number that only one of the two sides knows.
 *
 * Another load tool (`test/load/anmeldestart.ts`) measures the
 * **submit** route and expressly does not serve as a justification here.
 *
 * ## What it measures
 *
 * Against `FORM_COUNT` forms of one tenant, with a real session through the
 * **whole** guard chain:
 *
 * - `GET /api/forms?limit=L&offset=0` for every step in {@link PAGE_SIZES},
 *   {@link SAMPLES} repetitions each after {@link WARMUP} warm-up runs;
 * - plus the **uncapped** comparison step ("everything", the way the route
 *   used to answer) — it is the reference point against which a page saves
 *   anything at all;
 * - per step p50/p95 of the response time and the **payload in bytes**, for it
 *   is the second one that turns into render time in the browser.
 *
 * ## How to run it
 *
 *     node --require @swc-node/register test/forms/formularliste-messung.ts
 *
 * It needs a reachable PostgreSQL (the same choice as the suite:
 * Testcontainers, otherwise `TEST_DATABASE_URL`/`DATABASE_URL`) and puts its
 * rows into a **throwaway database** which it clears away again at the end —
 * unlike the load test, whose measurement of the leftovers is itself part of
 * its proof. There is nothing to prove here but numbers.
 *
 * ⚠️ **No `*.spec.ts`.** It runs for minutes and writes thousands of rows; it
 * belongs in `pnpm -r test` as little as the load test does (`test/load/gate-exclusion.spec.ts`
 * guards the same rule for that file).
 */
import { performance } from 'node:perf_hooks';

import request from 'supertest';

import { FORM_PAGE_SIZE_MAX } from '@formsache/shared';

import { SESSION_COOKIE_NAME } from '../../src/auth/session-cookie';
import { SessionService } from '../../src/auth/session.service';
import {
  apiPath,
  createTestApp,
  type TestApp,
} from '../support/create-test-app';
import { createTenant, createUser } from '../support/fixtures';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';

/**
 * The session cookie, issued through the application's own `SessionService`.
 *
 * Spelled out here rather than imported from `test/support/http.ts` for the
 * reason `test/load/anmeldestart.ts` spells it out: that module imports
 * `vitest`, and this script is not run by Vitest — requiring it fails at load
 * time with „Vitest cannot be imported in a CommonJS module".
 */
async function sessionCookie(
  app: TestApp,
  userId: string,
  tenantId: string,
): Promise<string> {
  const { token } = await app.app.get(SessionService).issue(userId, tenantId);
  return `${SESSION_COOKIE_NAME}=${token}`;
}

/**
 * How many forms the tenant holds.
 *
 * 3000, so a little more than the 2748 from the specification — the number at
 * which the render time was actually measured in the test environment. A
 * smaller amount would answer the question nobody has.
 */
const FORM_COUNT = 3000;

/**
 * The steps. `FORM_PAGE_SIZE_MAX` is among them because the cap is a promise
 * one has to be able to measure; 500 and 1000 are above it and stand for "what
 * the cap prevents".
 */
const PAGE_SIZES = [12, 24, 50, FORM_PAGE_SIZE_MAX, 500, 1000] as const;

const WARMUP = 3;
const SAMPLES = 15;

/** One definition with one question — the list need not carry more. */
function definition(index: number) {
  return {
    pages: [
      {
        id: '019fd000-0000-7000-8000-0000000000a0',
        title: 'Seite 1',
        questions: [
          {
            id: '019fd000-0000-7000-8000-000000000001',
            type: 'text',
            label: `Name ${String(index)}`,
            hint: null,
            required: true,
            width: 'full',
            minLength: null,
            maxLength: null,
            pattern: null,
          },
        ],
      },
    ],
  };
}

interface Measurement {
  readonly label: string;
  readonly items: number;
  readonly bytes: number;
  readonly p50: number;
  readonly p95: number;
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const index = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[index] ?? Number.NaN;
}

async function measure(
  app: TestApp,
  session: string,
  label: string,
  query: string,
): Promise<Measurement> {
  const durations: number[] = [];
  let bytes = 0;
  let items = 0;

  for (let run = 0; run < WARMUP + SAMPLES; run += 1) {
    const started = performance.now();
    const response = await request(app.server)
      .get(`${apiPath('/forms')}${query}`)
      .set('Cookie', session);
    const elapsed = performance.now() - started;

    if (response.status !== 200) {
      throw new Error(
        `${label}: erwartet 200, bekommen ${String(response.status)}`,
      );
    }
    if (run >= WARMUP) {
      durations.push(elapsed);
    }
    bytes = Buffer.byteLength(JSON.stringify(response.body));
    // Counts the rows of the response, not the requested ones — the cap is
    // meant to become visible, after all.
    const body: unknown = response.body;
    items =
      typeof body === 'object' && body !== null && 'items' in body
        ? (body as { items: unknown[] }).items.length
        : Number.NaN;
  }

  durations.sort((a, b) => a - b);
  return {
    label,
    items,
    bytes,
    p50: quantile(durations, 0.5),
    p95: quantile(durations, 0.95),
  };
}

function report(rows: readonly Measurement[]): void {
  const header = ['Stufe', 'Zeilen', 'Bytes', 'p50 ms', 'p95 ms'];
  const table = rows.map((row) => [
    row.label,
    String(row.items),
    row.bytes.toLocaleString('de-DE'),
    row.p50.toFixed(1),
    row.p95.toFixed(1),
  ]);
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...table.map((line) => (line[column] ?? '').length)),
  );
  const line = (cells: readonly string[]): string =>
    cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ');

  console.log('');
  console.log(line(header));
  console.log(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const row of table) {
    console.log(line(row));
  }
  console.log('');
}

async function main(): Promise<void> {
  let database: TestDatabase | undefined;
  let app: TestApp | undefined;

  try {
    database = await acquireTestDatabase();
    console.log(
      `Datenbank: ${database.strategy} (${database.name}); ${String(FORM_COUNT)} Formulare werden angelegt…`,
    );
    app = await createTestApp({ databaseUrl: database.url });

    const tenant = await createTenant(app.prisma, 'mess');
    const user = await createUser(app.prisma, {
      email: 'messung@example.org',
      password: 'test-password',
      tenants: [tenant],
    });
    const session = await sessionCookie(app, user.id, tenant.id);

    // In blocks, so that a single `createMany` does not run into a parameter
    // cap.
    const BATCH = 250;
    for (let start = 0; start < FORM_COUNT; start += BATCH) {
      await app.prisma.form.createMany({
        data: Array.from(
          { length: Math.min(BATCH, FORM_COUNT - start) },
          (_unused, offset) => ({
            tenantId: tenant.id,
            title: `Formular ${String(start + offset).padStart(5, '0')}`,
            draftSchema: definition(start + offset),
            publicSlug: `slug-${String(start + offset)}`,
          }),
        ),
      });
    }

    const rows: Measurement[] = [];
    for (const size of PAGE_SIZES) {
      rows.push(
        await measure(
          app,
          session,
          `limit=${String(size)}`,
          `?limit=${String(size)}`,
        ),
      );
    }
    // The reference point: what the route used to do. Above the cap that no
    // longer works, which is why what the cap makes of it stands next to it.
    rows.push(
      await measure(app, session, 'limit=100000 (gedeckelt)', '?limit=100000'),
    );
    rows.push(await measure(app, session, 'ohne limit (Vorgabe)', ''));
    rows.push(
      await measure(
        app,
        session,
        'q=Formular 002 (Suche)',
        '?q=Formular%20002',
      ),
    );

    report(rows);
  } finally {
    await app?.close();
    await database?.release();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
