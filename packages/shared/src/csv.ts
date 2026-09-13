import type { CellGuard } from './answer-columns.ts';
import {
  buildExportSheet,
  type CsvColumn,
  type CsvRow,
  type ExportCell,
  type ExportSheet,
} from './export-sheet.ts';

/**
 * **Der CSV-Schreiber** — one of the export's output formats, and
 * nothing else.
 *
 * Here rather than in the API because the shape of an exported cell is core
 * logic, not transport ("Export-Formatierung" is among the
 * things `packages/shared` covers with unit tests). It is also the piece where
 * a mistake is silent: a broken quote or a stray separator does not raise, it
 * produces a file that opens with the columns shifted by one.
 *
 * **Which rows and which columns is not decided here** . This module
 * receives an {@link ExportSheet} — cells with their guards, in the order they
 * go into the file — and turns it into CSV bytes. Excel and HTML
 * receive the very same sheet and turn it into their own. What is left in this
 * file is therefore exactly what is CSV and nothing that another format would
 * have to agree with: the separator, the byte order mark, the quoting rules and
 * the formula guard.
 */

/**
 * `;`, not `,`.
 *
 * The people opening these files use a German Excel, whose list separator is
 * the semicolon. A comma-separated file lands there as a single column per
 * row, and the usual reaction is not "wrong separator" but "the export is
 * broken". The BOM below settles the encoding; nothing settles the separator
 * except picking the one the audience's spreadsheet expects.
 */
export const CSV_DELIMITER = ';';

/**
 * CRLF, because that is what RFC 4180 specifies and what Excel is happiest
 * with. Everything else reads it too.
 */
const CSV_NEWLINE = '\r\n';

/**
 * UTF-8 byte order mark.
 *
 * Without it Excel reads the file in the system's legacy code page and „Müller"
 * arrives as „MÃ¼ller" — every time, for every German name in the file. The
 * BOM is three bytes that make the difference between a usable export and a
 * support request.
 */
export const CSV_BOM = '﻿';

/**
 * Characters that make a spreadsheet treat a cell as a formula.
 *
 * This is the part of a CSV export that is a **security** concern rather than
 * a formatting one. Participants type free text into a public form; a value
 * beginning with `=` is executed by Excel and LibreOffice when the Mitglied
 * who received the export opens it, and `=cmd|'/c calc'!A0` is the textbook
 * demonstration. The value is preserved and neutralised, not stripped: the
 * answer someone gave is data, and an export that quietly deleted part of it
 * would be worse than one that shows a leading apostrophe.
 *
 * ⚠️ **This is the CSV answer to the guard, not the guard itself.** The
 * decision *which* cells need protecting is made at the question type
 * (`questionColumns`) and travels in `ExportCell.guard`; Excel will honour the
 * same decision by writing a typed cell instead of an apostrophe, and applying this prefix there **as well** would corrupt the value
 * („doppelt geschützt ist beschädigt").
 */
const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

/**
 * A number literal as **this module** writes one — `42`, `-5`, `4,5`, `-0,25`.
 *
 * Not the decision (that is `questionColumns`), only the check that the decision
 * held. `'number'` says "this string came from a numeric answer, so it cannot
 * be a formula" — and the export reaches this function through a `as AnswerMap`
 * cast over raw JSONB (`forms.service.ts`), so the claim is a promise about
 * foreign data rather than a fact. A stored string on a numeric question would
 * otherwise pass the guard untouched; under the value-shaped rule this replaced
 * it was still caught. Verifying costs one regex and removes the only way this
 * change could weaken the injection guard.
 *
 * Exponential notation (`-1e-7`, which `String()` produces below 1e-6) does not
 * match and therefore falls back to being guarded. That is the safe direction
 * and no realistic answer to a form question.
 */
const NUMBER_LITERAL = /^-?\d+(,\d+)?$/u;

/**
 * Applies the formula guard.
 *
 * The empty cell is never prefixed: a lone apostrophe in a column of blanks
 * reads as an answer that is not there.
 */
function guardValue(value: string, guard: CellGuard): string {
  if (value === '') {
    return value;
  }
  // Trusted only as far as it can be checked — see `NUMBER_LITERAL`.
  if (guard === 'number' && NUMBER_LITERAL.test(value)) {
    return value;
  }
  if (guard === 'text' || reinterpretedAsNumber(value)) {
    return `'${value}`;
  }
  return FORMULA_PREFIXES.some((prefix) => value.startsWith(prefix))
    ? `'${value}`
    : value;
}

/**
 * Whether a spreadsheet would read this free-text value as a number and give
 * back something **different** from what was typed.
 *
 * The same damage as the phone case, one question type further along, and the
 * client asked for it to be covered too: a Postleitzahl `01067` is a *text*
 * question, so nothing above marks it — and Excel opens it as 1067. The
 * project's own test fixture has that field (`public-forms.spec.ts`,
 * `label: 'Postleitzahl'`, `pattern: '^\\d{5}$'`), and a Mitgliedsnummer with a
 * leading zero is the same shape.
 *
 * The test is the question itself rather than a guess at what the value means:
 * parse it as a number, write it back, and see whether it survived. That is
 * exactly the round trip a spreadsheet performs.
 *
 * - `01067` → 1067 → `"1067"` — changed, so it is kept as text.
 * - `35037` → `"35037"` — unchanged, so it is left alone; reading a five-digit
 *   Postleitzahl as a number shows the same five digits.
 * - `12345678901234567` → rounded past 2^53 — changed, kept as text.
 * - `Anton`, `2026-05-15`, `4,5` — not a bare digit string, never considered.
 *
 * Restricted to digits-only values on purpose. Anything else either survives
 * the round trip anyway or is not a number to begin with, and widening this
 * would put an apostrophe in front of ordinary answers.
 */
function reinterpretedAsNumber(value: string): boolean {
  if (!/^\d+$/u.test(value)) {
    return false;
  }
  return String(Number(value)) !== value;
}

/**
 * Escapes one cell.
 *
 * Two independent jobs, and they are applied in this order for a reason: the
 * formula guard changes the *value*, the quoting describes it. Quoting first
 * and prefixing afterwards would put the apostrophe outside the quotes.
 *
 * `guard` is **required**. A default would make a forgotten argument invisible
 * at the one call site where it decides anything ({@link writeCsv}), and "the
 * caller forgot" would then read exactly like "the caller meant free text".
 */
export function escapeCsvCell(value: string, guard: CellGuard): string {
  const guarded = guardValue(value, guard);

  // RFC 4180: a field containing the delimiter, a quote or a line break is
  // wrapped in quotes, and quotes inside it are doubled.
  const needsQuotes =
    guarded.includes(CSV_DELIMITER) ||
    guarded.includes('"') ||
    guarded.includes('\n') ||
    guarded.includes('\r');

  return needsQuotes ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

/**
 * **Writes the sheet as CSV** — the format's whole share of the export.
 *
 * Header and body go through one function, because a header is a cell too
 * (`ExportHeader`): a question an editor named „=Summe" is neutralised exactly
 * like an answer a participant typed, and a writer that treated the two
 * differently would have one unguarded row per file.
 */
export function writeCsv(sheet: ExportSheet): string {
  const lines = [csvLine(sheet.header), ...sheet.rows.map(csvLine)];
  return CSV_BOM + lines.join(CSV_NEWLINE) + CSV_NEWLINE;
}

function csvLine(cells: readonly ExportCell[]): string {
  return cells
    .map((cell) => escapeCsvCell(cell.value, cell.guard))
    .join(CSV_DELIMITER);
}

/**
 * **The CSV path in one call**: the seam, then the writer, in the order the
 * export route runs them.
 *
 * It is what `export-golden.test.ts` measures — the assurance that every file
 * the application writes is byte for byte the one it wrote before the seam
 * existed — and it must stay this composition and nothing else. `writeExport`
 * (`export-formats.ts`) is the same two steps with the format chosen at
 * runtime; the seam test beside the golden files asserts that the two agree, so
 * this shortcut cannot quietly become a third way into a CSV file.
 */
export function buildCsv(
  columns: readonly CsvColumn[],
  rows: readonly CsvRow[],
): string {
  return writeCsv(buildExportSheet(columns, rows));
}

/**
 * **The vocabulary of the seam, at its old address.**
 *
 * Row and column selection, the timestamp column and the rendered row moved to
 * `export-sheet.ts` — they belong to *an export*, not to one of its
 * formats, and Excel importing them from `csv.ts` would say the opposite. They
 * are re-exported here because `export-golden.test.ts` reaches them through
 * this module, and that file is the proof that this change altered no byte of
 * any file: a proof one has to edit in order to make it pass is not one.
 */
export {
  SUBMITTED_AT_COLUMN,
  SUBMITTED_AT_LABEL,
  chooseColumns,
  formatTimestamp,
  pickDefaultColumns,
  renderRow,
  renderSchemalessRow,
  rowMatchesSearch,
  type ColumnSurface,
  type CsvColumn,
  type CsvRow,
} from './export-sheet.ts';
