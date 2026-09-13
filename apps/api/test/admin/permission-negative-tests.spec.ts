import 'reflect-metadata';

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import { createTestApp, type TestApp } from '../support/create-test-app';
import { routePermissions } from '../support/route-permissions';

/**
 * **Every route with `@RequirePermission` has a 403 case somewhere**
 * (a review finding).
 *
 * ## What the finding was
 *
 * On 2026-08-12 the permission matrix was **complete** — all 68 routes checked
 * one by one. What was missing was the guard above it: a new route with a
 * permission and **without** a negative test leaves the matrix without anything
 * going red. A test that only checks the permitted case proves nothing — and a route without the forbidden case is exactly that.
 *
 * ## How this is measured here, and what that cannot do
 *
 * From two directions:
 *
 * 1. The routes with a permission requirement come from the **metadata** of the
 *    same application that also runs (`routePermissions`) — no maintained list.
 * 2. The coverage comes from the **source text of the suite**: a file that
 *    carries a 403 expectation covers the paths it addresses.
 *
 * ⚠️ **That is a coverage statement, not a proof.** The guard sees „this file
 * expects a 403 somewhere and addresses this path with this method" — not that
 * *this* call got the 403. It prevents the **silent gap** (a route over which no
 * forbidden case stands anywhere), not the sloppy assignment. Sharper would only
 * be possible with an assignment per case, and that would be a third list to
 * maintain — exactly the kind that the finding one line above has proven
 * unusable.
 */

const TEST_ROOT = join(__dirname, '..');

/** The HTTP method, the way supertest writes it. */
const METHOD_CALLS: Readonly<Record<string, string>> = {
  GET: '.get(',
  POST: '.post(',
  PUT: '.put(',
  PATCH: '.patch(',
  DELETE: '.delete(',
};

/**
 * The fixed beginning of a path — everything up to the first parameter.
 *
 * `/api/tenant/users/:userId` becomes `/tenant/users/`: the `/api` falls away
 * (the suite calls through `apiPath()`, which prepends it itself), and the
 * parameter falls away, because in the test an identifier stands there.
 */
function staticPrefix(path: string): string {
  const withoutApi = path.replace(/^\/api/, '');
  const cut = withoutApi.indexOf('/:');
  return cut === -1 ? withoutApi : `${withoutApi.slice(0, cut)}/`;
}

/**
 * ⚠️ **This file itself does not count.**
 *
 * It carries `403` in its prose and names paths in its examples — it would
 * thereby read **itself** as coverage. The counter-check below has shown it: the
 * invented path `/erfunden/gibt-es-nicht` counted as covered, because it stands
 * in this file. A guard that accepts itself as evidence is the most expensive
 * green state of all.
 */
const SELF = 'permission-negative-tests.spec.ts';

function specFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...specFiles(full));
      continue;
    }
    if (entry.endsWith('.spec.ts') && entry !== SELF) {
      found.push(full);
    }
  }
  return found;
}

describe('jede Route mit Recht hat einen 403-Fall', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });
  }, 180_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  /** Files that expect a 403 somewhere — together with their content. */
  function refusingSpecs(): { file: string; source: string }[] {
    return specFiles(TEST_ROOT)
      .map((file) => ({ file, source: readFileSync(file, 'utf8') }))
      .filter(({ source }) => /\b403\b/.test(source));
  }

  it('findet überhaupt Routen und ablehnende Fälle (Boden)', () => {
    const guarded = routePermissions(testApp.app).filter(
      (route) => route.requirement !== undefined,
    );
    // Without these two numbers the check below would be green over two empty
    // sets — the lesson from the overall review.
    expect(guarded.length).toBeGreaterThan(40);
    expect(refusingSpecs().length).toBeGreaterThan(10);
  });

  it('lässt keine Route mit `@RequirePermission` ohne verbotenen Fall', () => {
    const specs = refusingSpecs();

    const uncovered = routePermissions(testApp.app)
      .filter((route) => route.requirement !== undefined)
      .filter((route) => {
        const prefix = staticPrefix(route.path);
        const call = METHOD_CALLS[route.method];
        if (call === undefined) {
          return true;
        }
        return !specs.some(
          ({ source }) => source.includes(prefix) && source.includes(call),
        );
      })
      .map((route) => `${route.method} ${route.path}`);

    expect(
      uncovered,
      'Diese Routen verlangen ein Recht, aber keine Suite mit einer ' +
        '403-Erwartung spricht sie an. Ein Test, der nur den erlaubten Fall ' +
        'prüft, belegt nichts.',
    ).toStrictEqual([]);
  });

  /**
   * The counter-check, run instead of described: an invented route that demands a
   * permission and that no suite addresses **must** show up in the list. Without
   * this case the guard would be green for a check that looks for nothing at all.
   */
  it('meldet eine Route, über die nirgends ein verbotener Fall steht', () => {
    const specs = refusingSpecs();
    const invented = {
      method: 'POST',
      path: '/api/erfunden/gibt-es-nicht',
    };

    const call = METHOD_CALLS[invented.method] ?? '';
    const covered = specs.some(
      ({ source }) =>
        source.includes(staticPrefix(invented.path)) && source.includes(call),
    );

    expect(covered).toBe(false);
  });

  /** The reader itself, against the shapes it has to hit. */
  it('schneidet einen Pfad am ersten Parameter ab', () => {
    expect(staticPrefix('/api/tenant/users/:userId')).toBe('/tenant/users/');
    expect(staticPrefix('/api/tenant/users')).toBe('/tenant/users');
    expect(staticPrefix('/api/forms/:id/settings')).toBe('/forms/');
  });

  it('liest die Suite von ihrer Wurzel aus', () => {
    const files = specFiles(TEST_ROOT).map((file) => relative(TEST_ROOT, file));
    expect(files.length).toBeGreaterThan(50);
    // And it does not read itself — see {@link SELF}.
    expect(files.some((file) => file.endsWith(SELF))).toBe(false);
    expect(files.some((file) => file.startsWith('tenant-admin/'))).toBe(true);
    expect(files.some((file) => file.startsWith('public/'))).toBe(true);
  });
});
