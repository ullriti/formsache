import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import vitestConfig from '../../vitest.config';

/**
 * **the evidence — the load test does not hang on the gate.**
 *
 * `pnpm -r test` runs on every change; the load test of `test/load/anmeldestart.ts`
 * takes minutes and writes into the development database. Hanging it on the gate
 * would be a slow, stateful gate — and the requirement names the reproduction
 * outright: „das Skript an `pnpm -r test` hängen → die Laufzeit des Gates steigt
 * messbar, und ein Test über die `package.json`-Skripte wird rot."
 *
 * This is that test. It reads the two things that actually decide the question —
 * the `scripts` block and the Vitest `include` patterns — as **data**, not as
 * file text: `package.json` *is* JSON, and the config is imported and asked, not
 * grepped. What it cannot do is measure the gate's runtime, so it measures the
 * two mechanisms that would let it grow.
 */

const API_ROOT = join(__dirname, '..', '..');
const LOAD_SCRIPT = 'test/load/anmeldestart.ts';

const packageSchema = z.looseObject({
  scripts: z.record(z.string(), z.string()),
});

/**
 * The one part of the Vitest configuration this file reasons about.
 *
 * Parsed rather than trusted: the config module is a `defineConfig(...)` value
 * whose type this workspace's `moduleResolution: "Node"` cannot see through, so
 * reading `.test.include` off it directly would be reading `any` — and an
 * assertion against `any` is the assertion that stays green when the shape
 * changes.
 */
const includeSchema = z.looseObject({
  test: z.looseObject({ include: z.array(z.string()) }),
});

function scripts(): Record<string, string> {
  const raw: unknown = JSON.parse(
    readFileSync(join(API_ROOT, 'package.json'), 'utf8'),
  );
  return packageSchema.parse(raw).scripts;
}

describe('the load test is a script, not part of the gate ', () => {
  /**
   * The entry point exists and points at the file. Without this the two
   * assertions below would be satisfied by a repository that has no load test
   * at all — the shape of „grün, weil nichts da ist" that the requirement
   * is about.
   */
  it('is runnable through a named script', () => {
    expect(scripts()['load-test']).toContain(LOAD_SCRIPT);
  });

  /**
   * `pnpm -r test` runs the `test` script of every workspace. Whatever it grows
   * into, it must not reach the load test — neither directly nor by chaining
   * `load-test`.
   */
  it('is not reachable from the workspace `test` script', () => {
    const test = scripts().test ?? '';
    expect(test).not.toContain('load');
    expect(test).not.toContain(LOAD_SCRIPT);
  });

  /**
   * The second way in, and the quieter one: Vitest collects by glob, so a load
   * test named `*.spec.ts` would join the gate without anybody editing a script.
   *
   * Asked of the imported config rather than of its source text — and asserted
   * in both directions, because „the patterns all end in `*.spec.ts`" alone
   * would stay green if the load script were renamed to one.
   */
  it('is not collected by the Vitest patterns of this workspace', () => {
    const { include } = includeSchema.parse(vitestConfig as unknown).test;
    expect(include.length).toBeGreaterThan(0);
    for (const pattern of include) {
      expect(pattern.endsWith('*.spec.ts')).toBe(true);
    }
    expect(LOAD_SCRIPT.endsWith('.spec.ts')).toBe(false);
  });
});
