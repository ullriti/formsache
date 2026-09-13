import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  MAIL_LOG_RETENTION_DAYS,
  SESSION_RETENTION_DAYS,
  TRASH_RETENTION_DAYS,
} from '@formsache/shared';
import { describe, expect, it } from 'vitest';

// As in `styles/tokens.test.ts`: jsdom turns `import.meta.url` into an
// http address, so the path comes from the working directory.
const SRC_DIR = resolve(process.cwd(), 'src');

/**
 * **A deadline stands once in the source text, not twice** (a review finding).
 *
 * The retention periods live as constants in `packages/shared`; the drift test
 * `retention-doc.test.ts` holds the **Löschkonzept** against that. What it does not
 * see is the third copy: six sentences in the surface wrote „30
 * Tage" as text — in the trash, in three deletion prompts, in the organisation deletion.
 *
 * The case this stands against is no typo but a
 * **half-truth**: whoever changes the constant changes the behaviour and the
 * documentation; the surface goes on telling the old number — and the surface is
 * the one an organisation reads. `MailLogView` shows how it is done right.
 *
 * ⚠️ **The guard reads text, not intentions.** It looks for the number with its
 * unit in strings and JSX text, after comments have been removed —
 * a comment that explains the deadline is no second source. It cannot
 * distinguish `${String(TAGE)} Tage` from an invention that happens to
 * carry the same number; that is why a named exception list stands below instead
 * of a heuristic.
 */
const DEADLINES: readonly { readonly days: number; readonly what: string }[] = [
  { days: TRASH_RETENTION_DAYS, what: 'Papierkorb und Entwürfe' },
  { days: MAIL_LOG_RETENTION_DAYS, what: 'Versandprotokoll' },
  { days: SESSION_RETENTION_DAYS, what: 'tote Sitzungen' },
];

/**
 * Places at which the number **may** stand as text — each with its reason.
 *
 * Today only one: `ResponseDraftView` tells in a comment the
 * story of the security review finding on the attachment deadline („24 Stunden"
 * against „30 Tage"), and the text belongs to the reasoning, not to the display.
 */
const ALLOWED_FILES: Readonly<Record<string, string>> = {};

function collectSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      return collectSources(path);
    }

    const isSource =
      entry.isFile() &&
      (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) &&
      !entry.name.includes('.test.');

    return isSource ? [path] : [];
  });
}

/**
 * Source text without comments — the same rough form as in
 * `apps/api/test/observability/log-hygiene.spec.ts`, and for the same reason:
 * a guard that takes the explanation of a fault for the fault forces
 * an exception list and is thereby finished.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('Fristen stehen einmal, nicht zweimal', () => {
  const sources = collectSources(SRC_DIR);

  it('liest überhaupt Quelltext (Boden unter dem Wächter)', () => {
    expect(sources.length).toBeGreaterThan(80);
  });

  for (const { days, what } of DEADLINES) {
    it(`schreibt die Frist für ${what} nirgends als Zahl in den Text`, () => {
      // `30 Tage`, `30 Tagen`, `dreißig Tage` — the forms in which the number
      // appears in a German sentence. The digit alone would be too coarse:
      // `30` also stands in geometry and time specifications.
      const pattern = new RegExp(`\\b${String(days)}\\s+Tage`, 'u');

      const offenders = sources
        .filter((path) => {
          const relative = path
            .slice(SRC_DIR.length + 1)
            .split('\\')
            .join('/');
          if (ALLOWED_FILES[relative] !== undefined) {
            return false;
          }
          return pattern.test(stripComments(readFileSync(path, 'utf8')));
        })
        .map((path) => path.slice(SRC_DIR.length + 1));

      expect(
        offenders,
        `Diese Dateien schreiben die Frist als Text statt aus der Konstante ` +
          `(${what}). \`MailLogView.tsx\` macht es vor.`,
      ).toStrictEqual([]);
    });
  }

  /**
   * The floor under the pattern: if it were broken, all the cases above would be green,
   * and the guard would be a claim about nothing.
   */
  it('erkennt die Form, gegen die es geht', () => {
    const pattern = new RegExp(
      `\\b${String(TRASH_RETENTION_DAYS)}\\s+Tage`,
      'u',
    );
    expect(pattern.test('bleibt dort 30 Tage wiederherstellbar')).toBe(true);
    expect(
      pattern.test('bleibt dort {String(TRASH_RETENTION_DAYS)} Tage'),
    ).toBe(false);
  });

  it('führt keine Ausnahme, die es nicht mehr gibt', () => {
    for (const file of Object.keys(ALLOWED_FILES)) {
      expect(sources.some((path) => path.endsWith(file))).toBe(true);
    }
  });
});
