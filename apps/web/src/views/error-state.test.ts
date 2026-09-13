import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// Same reason as `styles/tokens.test.ts`: jsdom turns `import.meta.url` into an
// http URL, so the path comes from the working directory instead — Vitest runs
// each workspace project from its own package root.
const SRC_DIR = resolve(process.cwd(), 'src');

/**
 * **An error state must not replace a view that still has something to show**
 * (a review finding, and its eighteen-fold repetition).
 *
 * After a failed background refetch `useQuery` holds on to the last good
 * answer — `isError` is then `true` **and** `data` stands. A guard that
 * returns an error page on `isError` alone thereby throws away what somebody
 * is typing right now; in the builder the only button on offer additionally
 * led to the store reset via the unmount effect, so the draft was gone for
 * good.
 *
 * The rule therefore reads: a return guard checks **the data**
 * (`… === undefined`), not the error. The error only decides *which* sentence
 * stands in the error page.
 *
 * This watchman holds the rule mechanically: `.isError` must stand in no `if`
 * condition in `apps/web/src`, unless the place is named and justified below.
 * For error banners in JSX (`{save.isError ? … : null}`) it does not apply —
 * those replace nothing, they stand beside.
 *
 * ⚠️ **The exception applies to the condition, not to the file.** The first
 * version of this watchman listed `BuilderView.tsx` as a whole — and thereby
 * let through exactly the relapse it is built against: the counter-check
 * restored `if (query.isError || form === undefined)`, and it stayed green. An
 * exception over a file is an exception over everything somebody writes into
 * it later.
 */
const ALLOWED: readonly {
  readonly file: string;
  readonly condition: string;
  readonly why: string;
}[] = [
  {
    file: 'views/BuilderView.tsx',
    condition: 'if (result.isError || result.data === undefined) {',
    why:
      'Keine Rückgabe-Wache, sondern der Klickpfad des Veröffentlichens: dort ' +
      'entscheidet der Fehler *dieses* Drucks, und `result.data` wäre die ' +
      'Antwort des vorherigen — genau umgekehrt zur Regel dieser Datei, und ' +
      'an Ort und Stelle begründet.',
  },
  {
    file: 'views/PublicFormView.tsx',
    condition: 'if (query.isError && query.data === undefined) {',
    why:
      'Trägt die Regel bereits ausgeschrieben (`isError && data === undefined`) ' +
      'seit K-2 — die Fassung, aus der die Regel stammt.',
  },
  {
    file: 'views/superadmin/AiQuotaSection.tsx',
    condition: 'if (setQuota.isError) {',
    why:
      'Keine Rückgabe-Wache, sondern ein `onChange`: eine abgelehnte Eingabe ' +
      'wird verworfen, sobald jemand das Feld ändert. Es ersetzt nichts.',
  },
];

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
 * Every `if (…)` head of a file, with its condition flattened onto one line.
 *
 * Deliberately naive about nesting: a condition that spans lines is joined
 * until its parenthesis balances, which is enough for the shape this guard
 * looks for and keeps it readable.
 */
function ifConditions(source: string): string[] {
  const lines = source.split('\n');
  const conditions: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*(?:\}\s*else\s+)?if \(/.test(lines[index] ?? '')) {
      continue;
    }

    let condition = '';
    let depth = 0;
    for (let cursor = index; cursor < lines.length; cursor += 1) {
      const line = lines[cursor] ?? '';
      condition += ` ${line.trim()}`;
      depth += (line.match(/\(/g) ?? []).length;
      depth -= (line.match(/\)/g) ?? []).length;
      if (depth <= 0) {
        break;
      }
    }
    conditions.push(condition.trim());
  }

  return conditions;
}

describe('ein Fehler ersetzt keine Ansicht, die Daten hat', () => {
  const sources = collectSources(SRC_DIR);

  it('liest überhaupt Quelltext (Boden unter dem Wächter)', () => {
    // Without this case an empty set would be green, and the watchman would
    // be a claim about nothing — the lesson from the overall review.
    expect(sources.length).toBeGreaterThan(80);
    expect(
      sources.some((path) => path.endsWith(join('views', 'BuilderView.tsx'))),
    ).toBe(true);
  });

  it('findet `if`-Bedingungen (Boden unter dem Leser)', () => {
    const builder = sources.find((path) =>
      path.endsWith(join('views', 'BuilderView.tsx')),
    );
    expect(builder).toBeDefined();
    expect(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- proven by the line above
      ifConditions(readFileSync(builder!, 'utf8')).length,
    ).toBeGreaterThan(5);
  });

  it('benutzt `.isError` in keiner Rückgabe-Wache', () => {
    const allowed = new Set(
      ALLOWED.map((entry) => `${entry.file}: ${entry.condition}`),
    );

    const offenders = sources.flatMap((path) => {
      const relative = path
        .slice(SRC_DIR.length + 1)
        .split('\\')
        .join('/');

      return ifConditions(readFileSync(path, 'utf8'))
        .filter((condition) => condition.includes('.isError'))
        .map((condition) => `${relative}: ${condition}`)
        .filter((entry) => !allowed.has(entry));
    });

    expect(offenders).toEqual([]);
  });

  it('führt keine Ausnahme, die es nicht mehr gibt', () => {
    // An exception list that points at places that have disappeared keeps
    // growing quietly and at some point covers something other than what it
    // says.
    for (const entry of ALLOWED) {
      const conditions = ifConditions(
        readFileSync(join(SRC_DIR, entry.file), 'utf8'),
      );
      expect(
        conditions,
        `${entry.file} braucht die Ausnahme nicht mehr`,
      ).toContain(entry.condition);
    }
  });
});
