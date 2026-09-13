import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * **The server clock stays immovable from the outside** (the requirement).
 *
 * An e2e run set the 30-day retention period over the **browser clock**,
 * because the server clock cannot be moved from e2e. The obvious fix
 * would have been a lever — a route or an environment variable that
 * adjusts {@link MailClock} from the outside. It is deliberately **not** built: in
 * the production image that would be a door nobody needs, and the retention period is
 * long since measured at the server (`MutableClock` in the API tests, 89/91 days).
 *
 * This file holds the renunciation on record, so that it is not taken back later
 * out of convenience.
 *
 * ⚠️ **It checks source text, not behaviour** — in the language of the marks
 * it is 📋 and not 🧪. It replaces **none** of the `MutableClock` tests; it
 * prevents a shortcut.
 *
 * *Reproduction:* introduce in `src/` an environment variable or a route that
 * sets the clock (e.g. `CLOCK_OFFSET_MS` or a `setNow(`), then exactly
 * the case below that names it turns red.
 */

const API_SRC = join(__dirname, '..', '..', 'src');

/** Every `.ts` below `src/`, without the `*.spec.ts` running alongside. */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) found.push(full);
  }
  return found;
}

/**
 * Names that *would be* a clock lever, if they existed.
 *
 * ⚠️ **What is searched for is the outside, not the word „clock".** The first draft
 * of this file searched for `[A-Z_]*CLOCK[A-Z_]*` and promptly found
 * `CLOCK_SKEW_GRACE_MS` in `public-forms.service.ts` and
 * `access-proof.service.ts` — two constants that tolerate a *foreign* clock
 * instead of adjusting the own one. A pattern that does not distinguish
 * the two is not a piece of evidence, but an exception list in spe.
 *
 * A lever has exactly two possible accesses, and both stand below: it comes
 * **out of the environment** (`process.env`, or a line in the Zod schema) or
 * **over a route** (a setter that a controller calls).
 */
const LEVER_PATTERNS: readonly {
  readonly what: string;
  readonly re: RegExp;
}[] = [
  {
    what: 'eine Umgebungsvariable, die Uhr verstellt',
    re: /process\.env(?:\.|\[['"])[A-Za-z_]*(?:CLOCK|FAKE_TIME|TIME_OFFSET|NOW)/i,
  },
  {
    what: 'ein Zeit-Offset aus der Umgebung',
    re: /\b(?:TIME_OFFSET|CLOCK_OFFSET|NOW_OFFSET|FAKE_(?:TIME|NOW|CLOCK))\b/i,
  },
  { what: 'ein Setzer auf der Uhr', re: /\bset(?:Now|Clock|Time)\s*\(/ },
  {
    what: 'ein Reiseschritt auf der Uhr',
    re: /\b(?:advance|travel|freeze)(?:Time|Clock|To)\s*\(/,
  },
];

/**
 * The keys of the shared env schema — the second access out of the environment,
 * and the only one that a pattern over `apps/api/src` does **not** see: it
 * would stand in `packages/shared`.
 */
const SHARED_ENV = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'shared',
  'src',
  'env.ts',
);

describe('Die Serveruhr hat keinen Hebel von außen', () => {
  const files = sourceFiles(API_SRC);

  it('findet überhaupt Quelldateien — sonst prüft der Rest nichts', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  for (const { what, re } of LEVER_PATTERNS) {
    it(`kennt keinen Weg über ${what}`, () => {
      const hits = files
        .filter((file) => re.test(readFileSync(file, 'utf8')))
        .map((file) => relative(API_SRC, file));
      expect(hits).toStrictEqual([]);
    });
  }

  it('kennt keine Uhr-Zeile im geteilten Env-Schema', () => {
    const schema = readFileSync(SHARED_ENV, 'utf8');
    const declared = [...schema.matchAll(/^\s+([A-Z][A-Z0-9_]{2,})\s*:/gm)].map(
      // Group 1 exists as soon as the pattern matches — `matchAll` types it
      // as optional nevertheless.
      (match) => match[1] ?? '',
    );
    // The barrier keeps the case „the regex no longer matches anything" red, instead of
    // letting it pass as an empty list of hits. It lies deliberately below the
    // state of today: it secures the measurement, it does not count the variables.
    // ⚠️ **This lower bound fell on 2026-08-11 from 15 to 10, and
    // namely because it worked.** The move into the system settings took five variables out of the
    // schema (the AI configuration moved into the system settings), the schema
    // had exactly 15 afterwards — and this watchman turned red although at the clock
    // nothing had happened. Exactly for that the line is there: it keeps the *measurement*
    // alive, not a count of variables. A schema that shrinks to ten entries
    // is something other than an empty set of hits.
    expect(declared.length).toBeGreaterThan(10);
    expect(
      declared.filter((key) => /CLOCK|FAKE_TIME|TIME_OFFSET|^NOW$/.test(key)),
    ).toStrictEqual([]);
  });

  it('lässt die Uhr weiterhin injizieren — der Verzicht gilt der *Außen*seite', async () => {
    // The lever is forbidden, the seam is not: without it the
    // retention-period tests (89/91 days) would be dependent on waiting again.
    const { MailClock, SystemMailClock } =
      await import('../../src/mail/mail-clock');
    expect(new SystemMailClock()).toBeInstanceOf(MailClock);
    expect(
      Math.abs(new SystemMailClock().now().getTime() - Date.now()),
    ).toBeLessThan(1_000);
  });
});
