import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import * as shared from './index.ts';

/**
 * **The guard of the deletion concept.**
 *
 * The deadlines of this application live as constants in `packages/shared`. A
 * document that **copies them down** drifts — the first time somebody
 * changes a constant, and silently: the deletion concept goes on telling the old
 * number afterwards, and the number it tells is the one a data subject
 * reads, while the one that deleted is a different one.
 *
 * This test holds two shores together:
 *
 * 1. the exported retention constants of `packages/shared`,
 * 2. the deadline table in `docs/kb/10-datenschutz.md`.
 *
 * ## Why the check runs in **both** directions
 *
 * A constant without a row is a deletion promise that no register knows —
 * exactly the entry that is missing at an audit. A row without a constant is
 * the opposite and worse: a document claims a deadline that nobody
 * keeps. A guard that knows only one direction covers up the other.
 *
 * ## Why the constants are searched for and not enumerated
 *
 * A maintained list of expected names would be a third shore. It is
 * therefore **read** out of the source files ({@link retentionConstants}) — a
 * new deadline thereby forces a row without anybody having to touch this
 * test. The price stands at the function: the pattern recognizes names, not
 * intentions.
 *
 * ## The special case: a population without a deadline
 *
 * A population **without** a deadline is admissible — precisely when the table
 * carries it as such **and gives a reason** ({@link NO_DEADLINE_POPULATIONS}).
 * Without this rule the anonymous `ai_usage` counter would be either a finding or
 * a free pass; with it an emptied reason column is red, because a
 * deliberately deadline-free row could otherwise not be told apart from a forgotten
 * one.
 */

/** Repo root — Vitest runs each workspace project from its own package root. */
const ROOT = resolve(process.cwd(), '..', '..');

const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

/** The document this file exists to keep honest. */
const DOC_PATH = 'docs/kb/10-datenschutz.md';

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;

/** The units the Frist column may use, and what one of them is worth. */
const UNITS: Readonly<Record<string, number>> = {
  Tage: MS_PER_DAY,
  Stunden: MS_PER_HOUR,
};

/** What the Frist column says for a population that deliberately has none. */
const NO_DEADLINE = 'ohne Frist';

/** What the Konstante column says for such a row. */
const NO_CONSTANT = '—';

/**
 * **Every population the deletion concept has to carry** — a closed
 * set, and yes, it is the table's key column a second time.
 *
 * *Measured on 2026-08-11, and it is the reason this list exists at
 * all:* the check "every constant has a row" is **per constant**
 * and not per population. `TRASH_RETENTION_DAYS` carries two rows —
 * trash and drafts (deliberately the same number). Removing the
 * trash row from the document left **all seven
 * assertions green**: the constant was still named, after all, by the
 * other row. A deletion deadline would thereby have disappeared from the register
 * without anything having turned red — exactly the silent case that
 * this check stands against.
 *
 * **The price is named rather than hidden:** a new population is a
 * decision at two places. That is the intention — a kind of data that is
 * deleted without anybody writing it into the register is the error
 * that this check prevents.
 */
const POPULATIONS: readonly string[] = [
  'Papierkorb',
  'Zwischengespeicherte Entwürfe',
  'Unbeanspruchte Anlagen',
  'Versandprotokoll (mail_log)',
  'KI-Freitext (ai_usage.prompt)',
  'KI-Nutzung — Personenbezug',
  'KI-Nutzung — Zähler',
  'Sitzungen',
  'Rücksetz-Links (password_reset)',
];

/**
 * The populations that live **without** a deletion deadline — a closed set,
 * spelled out, every entry with its reason.
 *
 * The shape is `COMPOSE_EXEMPT`'s in `env-contract.test.ts` and for the same
 * reason: an open-ended „and anything else without a deadline is fine" clause
 * would go green for the next population somebody forgets. A new one forces a
 * decision here, in writing.
 */
const NO_DEADLINE_POPULATIONS: Readonly<Record<string, string>> = {
  'KI-Nutzung — Zähler':
    'ohne Personenbezug kein personenbezogenes Datum mehr ',
};

/**
 * The sentence the reason of a deadline-free row has to point at.
 *
 * **That is the whole point of this exception rule.** „Keine Frist nötig" would be an assertion;
 * the number of the decision is a reference that the next session can
 * follow, instead of taking the missing deadline for an oversight.
 */
const NO_DEADLINE_DECISION = 'ADR-0015 Nr. 8';

/**
 * Every retention constant `packages/shared` exports, read out of the sources.
 *
 * **Recognised by their name**, and that is the honest limitation of this
 * guard: `…_RETENTION_DAYS` and `…_LIFETIME_MS` are the two spellings this
 * repository uses, and a future `DRAFT_TTL_DAYS` would slip past. The sanity
 * assertion below (the set is not small) is what keeps a broken pattern from
 * turning the whole file into a guard over nothing — it cannot make the
 * pattern complete.
 *
 * Test files are skipped: a fixture named like a constant is not one.
 */
function retentionConstants(): Map<string, number> {
  const dir = join(ROOT, 'packages/shared/src');
  const found = new Map<string, number>();
  const values = shared as unknown as Record<string, unknown>;

  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.ts') || entry.includes('.test.')) {
      continue;
    }
    const source = readFileSync(join(dir, entry), 'utf8');
    const pattern =
      /^export const ([A-Z][A-Z0-9_]*(?:_RETENTION_DAYS|_LIFETIME_MS))\s*=/gmu;
    for (const match of source.matchAll(pattern)) {
      const name = match[1];
      if (name === undefined) {
        continue;
      }
      const value = values[name];
      // A constant the barrel does not re-export cannot be compared against
      // anything — and it is the same finding as a missing row, so it is one
      // here rather than a silent skip.
      expect(
        typeof value,
        `${name} is declared in packages/shared/src/${entry} but not exported ` +
          'from index.ts, so the deletion concept cannot be checked against it.',
      ).toBe('number');
      found.set(name, value as number);
    }
  }
  return found;
}

/** A constant's value as milliseconds, decided by the suffix of its name. */
function constantMs(name: string, value: number): number {
  return name.endsWith('_LIFETIME_MS') ? value : value * MS_PER_DAY;
}

/** One row of the Fristentabelle, cell for cell. */
interface RetentionRow {
  readonly population: string;
  readonly disappears: string;
  readonly constant: string;
  readonly deadline: string;
  readonly reason: string;
}

/**
 * Markdown emphasis and code ticks removed — the table is prose as well as
 * data, and `**30 Tage**` is the same deadline as `30 Tage`.
 */
function plain(cell: string): string {
  return cell.replaceAll('`', '').replaceAll('*', '').trim();
}

/**
 * The Fristentabelle of {@link DOC_PATH}, found by its header row.
 *
 * Hand-parsed rather than through a Markdown dependency, for the reason
 * `env-contract.test.ts` gives for `docker-compose.yml`: it is one table in one
 * file this repository owns, and the assertions below fail loudly on a parse
 * that found nothing — a guard that silently reads an empty table is the
 * failure mode this file exists against.
 */
function retentionTable(): RetentionRow[] {
  const lines = read(DOC_PATH).split('\n');
  const header = lines.findIndex((line) => /^\|\s*Population\s*\|/u.test(line));
  if (header === -1) {
    return [];
  }
  const rows: RetentionRow[] = [];
  // +2 skips the header and the `|---|` separator beneath it.
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith('|')) {
      break;
    }
    const cells = line.slice(1, line.lastIndexOf('|')).split('|').map(plain);
    const [population, disappears, constant, deadline, reason] = cells;
    if (
      population === undefined ||
      disappears === undefined ||
      constant === undefined ||
      deadline === undefined ||
      reason === undefined
    ) {
      continue;
    }
    rows.push({ population, disappears, constant, deadline, reason });
  }
  return rows;
}

/** The deadline of a row as milliseconds, or `null` where it states none. */
function deadlineMs(row: RetentionRow): number | null {
  if (row.deadline === NO_DEADLINE) {
    return null;
  }
  const match = /^(\d+)\s+(\p{Lu}\p{L}+)$/u.exec(row.deadline);
  const amount = match?.[1];
  const unit = match?.[2];
  if (amount === undefined || unit === undefined) {
    throw new Error(
      `„${row.deadline}" (Zeile „${row.population}") ist keine Frist. ` +
        `Erwartet wird „<Zahl> <${Object.keys(UNITS).join('|')}>" oder ` +
        `„${NO_DEADLINE}".`,
    );
  }
  const factor = UNITS[unit];
  if (factor === undefined) {
    throw new Error(
      `Die Einheit „${unit}" (Zeile „${row.population}") ist keine der ` +
        `bekannten: ${Object.keys(UNITS).join(', ')}.`,
    );
  }
  return Number(amount) * factor;
}

const sorted = (names: Iterable<string>): string[] => [...names].sort();

const CONSTANTS = retentionConstants();
const ROWS = retentionTable();

describe('das Löschkonzept, gegen die Konstanten gehalten', () => {
  it('reads both shores rather than an empty set', () => {
    // Without this, a renamed constant or a moved table would make every check
    // below pass over nothing — a guard that fails quietly is worse than none.
    expect(
      CONSTANTS.size,
      'No retention constants found in packages/shared/src. Either the naming ' +
        'convention moved or this guard stopped looking.',
    ).toBeGreaterThanOrEqual(5);
    expect(
      ROWS.length,
      `No Fristentabelle found in ${DOC_PATH}. It is recognised by a header ` +
        'row whose first column is „Population".',
    ).toBeGreaterThanOrEqual(6);
    // The parse found the right table and not some other one.
    expect(CONSTANTS.has('TRASH_RETENTION_DAYS')).toBe(true);
    expect(CONSTANTS.has('MAIL_LOG_RETENTION_DAYS')).toBe(true);
    expect(
      sorted(ROWS.map((row) => row.population)),
      'Populations must be unique — they are the key every other assertion ' +
        'reports against.',
    ).toHaveLength(new Set(ROWS.map((row) => row.population)).size);
  });

  /**
   * The direction that sees a **removed row** — and the only one that
   * can, as long as one constant carries two populations. The reasoning stands
   * at {@link POPULATIONS}.
   */
  it('führt genau die Populationen, über die entschieden wurde', () => {
    expect(
      sorted(ROWS.map((row) => row.population)),
      'Die Fristentabelle und POPULATIONS müssen dieselben Populationen ' +
        'nennen. Eine fehlende Zeile ist eine Datenart, die gelöscht wird, ' +
        'ohne im Verzeichnis zu stehen; eine zusätzliche ist eine, über die ' +
        'niemand entschieden hat.',
    ).toEqual(sorted(POPULATIONS));
  });

  it('nennt jede Frist des Codes in der Fristentabelle', () => {
    const named = new Set(ROWS.map((row) => row.constant));
    expect(
      sorted([...CONSTANTS.keys()].filter((name) => !named.has(name))),
      `Diese Konstanten löschen etwas, und ${DOC_PATH} kennt sie nicht. Eine ` +
        'Löschfrist ohne Eintrag im Löschkonzept ist genau der Eintrag, der ' +
        'bei einer Prüfung fehlt.',
    ).toEqual([]);
  });

  /**
   * **The load-bearing direction.** It goes red for a row that claims a
   * deadline that does not (any longer) exist in the code — the case in which a
   * document promises something that nobody keeps.
   */
  it('führt keine Zeile, die keine Konstante hinter sich hat', () => {
    const invented = ROWS.filter(
      (row) =>
        !CONSTANTS.has(row.constant) &&
        !(row.population in NO_DEADLINE_POPULATIONS),
    );
    expect(
      sorted(invented.map((row) => `${row.population} → ${row.constant}`)),
      'Diese Zeilen nennen keine Konstante, die packages/shared exportiert, ' +
        'und stehen auch nicht in NO_DEADLINE_POPULATIONS. Entweder die ' +
        'Konstante ist verschwunden — dann löscht niemand mehr, was die ' +
        'Zeile verspricht — oder die Zeile ist erfunden.',
    ).toEqual([]);
  });

  it('vergleicht Zahl für Zahl, nicht Zeile für Zeile', () => {
    const drifted = ROWS.filter((row) => {
      const value = CONSTANTS.get(row.constant);
      return (
        value !== undefined &&
        deadlineMs(row) !== constantMs(row.constant, value)
      );
    }).map((row) => {
      const value = CONSTANTS.get(row.constant) ?? 0;
      return (
        `${row.population}: Tabelle „${row.deadline}", ` +
        `${row.constant} = ${String(value)}`
      );
    });
    expect(
      sorted(drifted),
      'Die Frist im Dokument und die Konstante im Code sind verschiedene ' +
        'Zahlen. Gelöscht wird nach der Konstante; gelesen wird das Dokument.',
    ).toEqual([]);
  });

  it('gibt jeder Zeile eine Begründung und einen Beleg', () => {
    expect(
      sorted(
        ROWS.filter((row) => row.reason === '').map((row) => row.population),
      ),
      'Eine Frist ohne Begründung ist eine Zahl, die niemand verteidigen ' +
        'kann — und die deshalb bei der nächsten Gelegenheit anders lautet.',
    ).toEqual([]);
  });

  /**
   * **Deliberately, not accidentally.** The deadline-free row is admissible; as a gap it is
   * not. Both directions: a declared population that has no „ohne
   * Frist" row with a reason, and an „ohne Frist" row that is not
   * declared.
   */
  it('trägt die fristlose Population mit Begründung und Verweis', () => {
    const declared = ROWS.filter(
      (row) => row.population in NO_DEADLINE_POPULATIONS,
    );
    expect(
      sorted(declared.map((row) => row.population)),
      'NO_DEADLINE_POPULATIONS nennt Populationen, die in der Fristentabelle ' +
        'nicht (mehr) stehen. Eine erklärte Ausnahme ohne Zeile erklärt nichts.',
    ).toEqual(sorted(Object.keys(NO_DEADLINE_POPULATIONS)));

    for (const row of declared) {
      expect(row.deadline, `Zeile „${row.population}"`).toBe(NO_DEADLINE);
      expect(row.constant, `Zeile „${row.population}"`).toBe(NO_CONSTANT);
      expect(
        row.reason,
        `Die Begründung der fristlosen Zeile „${row.population}" muss auf die ` +
          `Entscheidung zeigen (${NO_DEADLINE_DECISION}). Ohne sie ist eine ` +
          'bewusst fristlose Zeile von einer vergessenen nicht zu ' +
          'unterscheiden — und genau das verhindert diese Prüfung.',
      ).toContain(NO_DEADLINE_DECISION);
    }

    const undeclared = ROWS.filter(
      (row) =>
        row.deadline === NO_DEADLINE &&
        !(row.population in NO_DEADLINE_POPULATIONS),
    );
    expect(
      sorted(undeclared.map((row) => row.population)),
      'Diese Zeilen stehen ohne Frist da, ohne dass jemand entschieden hätte, ' +
        'dass sie keine braucht. Eine Population ohne Frist ist zulässig — ' +
        'aber nur ausgesprochen.',
    ).toEqual([]);
  });

  /**
   * **Every file reference of the whole document is opened** — the
   * reasons of the deadline table *and* the TOM table from section 3.
   *
   * A piece of evidence that points at nothing is worse than none: it looks like
   * a check that has taken place. per measure
   * a reference to code or test, and it names the dead path as what
   * must stand out — **`scripts/check-ai-docs.sh` does not find it
   * today, though**: its „dead links" section reads exclusively the
   * worklog index (`docs/worklog/README.md`) and no KB document. This
   * assertion closes the gap for the one file it can close.
   *
   * The threshold is deliberately high: it falls as soon as somebody replaces the
   * TOM table with adjectives.
   */
  it('zeigt mit jedem Beleg des Dokuments auf eine Datei, die es gibt', () => {
    const paths = [
      ...read(DOC_PATH).matchAll(
        /(?:apps|packages|scripts|docs|e2e)\/[A-Za-z0-9._/-]+\.[a-z]+/gu,
      ),
    ].map((match) => match[0]);
    expect(
      paths.length,
      `${DOC_PATH} nennt kaum noch Dateien. je Maßnahme ` +
        'einen Verweis auf Code oder Test — eine Zeile ohne Verweis ist ein ' +
        'Befund, und ein Dokument aus Adjektiven ist derselbe Befund in groß.',
    ).toBeGreaterThanOrEqual(30);
    const dead = paths.filter((path) => {
      try {
        readFileSync(join(ROOT, path));
        return false;
      } catch {
        return true;
      }
    });
    expect(
      sorted(new Set(dead)),
      'Diese Verweise gehen ins Leere. Ein toter Pfad in einem TOM-Dokument ' +
        'behauptet eine Maßnahme, deren Beleg umgezogen oder verschwunden ist.',
    ).toEqual([]);
  });
});
