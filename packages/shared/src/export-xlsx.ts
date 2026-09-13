// The runtime lives behind a dynamic import inside `writeXlsx`; this one is
// erased at build time and pulls nothing into any bundle.
import type ExcelJS from 'exceljs';

import {
  SUBMITTED_AT_COLUMN,
  formatTimestamp,
  type ExportCell,
  type ExportSheet,
} from './export-sheet.ts';

/**
 * **The Excel writer** (the requirements) — the second output
 * format, and like the CSV writer nothing but a format.
 *
 * It receives an {@link ExportSheet} and **nothing else** — no answers, no
 * form, no column selection, no search term. That is the seam cut in
 * `export-sheet.ts`, and it is the whole of the requirement's „gleiche
 * Zeilenmenge, gleiche Spaltenwahl, gleiche Reihenfolge": a writer that never
 * sees an unfiltered row cannot write one, and a writer that never sees the
 * full column list cannot answer „angezeigte oder alle" a second time.
 *
 * ## Why the protection is **built differently** here than in the CSV
 *
 * A CSV has no types. The protection there is a leading apostrophe, and it
 * works because a spreadsheet *interprets* the text when it opens it. In an
 * `.xlsx` the type is **in the file**: a cell is a shared string or a number,
 * and the reader does not guess. So the same decision produces a different
 * artefact — the requirement's „anders **gebaut**, aber gleich **entschieden**".
 *
 * The decision itself is not taken here. It arrives per cell as
 * {@link ExportCell.guard}, minted at the **question type** in
 * `questionColumns`; this module only translates it into the alphabet of
 * OOXML:
 *
 * | guard | CSV | `.xlsx` |
 * |---|---|---|
 * | `'text'` | `'` prefix | shared string (`t="s"`) |
 * | `'auto'` | `'` prefix if it begins like a formula | shared string |
 * | `'number'` | unchanged if it is a number | number cell |
 *
 * **`'text'` and `'auto'` come out the same here, and that is right rather than
 * sloppy.** In a CSV they differ because the file has to say „do not
 * reinterpret this" in the only way it can; in a workbook a string cell already
 * says it. `01067` in a shared string keeps its zero and `=SUM(A1)` in a shared
 * string is not a formula — ExcelJS writes `<c t="s">` and never `<f>`, so
 * there is no spelling of a free-text answer that a spreadsheet executes. The
 * two guards therefore differ in what they *permit* (a `'number'` cell may
 * become a number, the other two may not), which is the distinction that
 * survives into this format.
 *
 * ## And why the CSV protection does **not** run here on top of it
 *
 * The requirement's the evidence exists for exactly this mistake: an apostrophe
 * prefix on top of a typed cell would make the workbook say `'01067` where the
 * participant typed `01067`. „Doppelt geschützt ist beschädigt" — and it is the
 * failure that the evidence would **not** catch, because the cell type
 * would still read as text. The sheet hands over the raw value on purpose
 * (`export-sheet.ts`), and this module writes it through unchanged.
 */

/** What an `.xlsx` is served as. */
export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * The one worksheet's name.
 *
 * A fixed German word rather than the form's title: a sheet name is limited to
 * 31 characters and forbids `[]:*?/\`, so a title would have to be mangled —
 * and the file already carries the title, in its file name
 * (`forms.service.ts`). One name that is always right beats a second slug rule.
 */
export const XLSX_SHEET_NAME = 'Antworten';

/**
 * How the submission timestamp is displayed.
 *
 * The **same** spelling {@link formatTimestamp} produces, so a reader sees in
 * Excel what they see in the CSV and on screen. It is a display format over a
 * real date value; the sorting is done on the value, which is the point of
 * writing one.
 */
export const XLSX_TIMESTAMP_FORMAT = 'DD.MM.YYYY HH:mm';

/**
 * How a `date` **question**'s cell is displayed.
 *
 * The same spelling `formatIsoDate` produces for the CSV, so the two files
 * still *read* alike — what differs is that this one is a number underneath and
 * therefore sorts as a date instead of as `01.12.` before `02.01.`.
 */
export const XLSX_DATE_FORMAT = 'DD.MM.YYYY';

/**
 * **Writes the sheet as an `.xlsx` workbook.**
 *
 * Header and body run through the same two functions, and the header through
 * the text-only one: a question an editor named „=Summe" is a string cell
 * exactly like an answer a participant typed, and a writer that treated the two
 * differently would have one unguarded row per file — the mistake the CSV
 * writer names in the same place.
 */
export async function writeXlsx(sheet: ExportSheet): Promise<Uint8Array> {
  // **Loaded here rather than at module scope, and that is a measurement, not
  // a preference.** `EXPORT_FORMATS` names this writer eagerly, and
  // `packages/shared` is consumed by Vite as source — a top-level import put
  // the whole of ExcelJS into the browser bundle, where nothing ever calls it
  // (measured: `exceljs` appeared in `apps/web/dist/assets/index-*.js`).
  // A dynamic import leaves a chunk the browser never fetches, and the API
  // pays one resolve on the first export of a process.
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet(XLSX_SHEET_NAME);

  const headerRow = worksheet.getRow(1);
  sheet.header.forEach((cell, index) => {
    writeText(headerRow.getCell(index + 1), cell.value);
  });

  sheet.rows.forEach((cells, rowIndex) => {
    // `getRow(n)` rather than `addRow`, so the row a cell lands in is
    // arithmetic rather than a counter the library keeps: a sheet with an empty
    // row in it must not shift everything below it by one, and that is the
    // failure a spreadsheet cannot report.
    const row = worksheet.getRow(rowIndex + 2);
    cells.forEach((cell, index) => {
      writeCell(row.getCell(index + 1), cell, sheet.header[index]?.key);
    });
  });

  const buffer = await workbook.xlsx.writeBuffer();
  // `Uint8Array` and not the library's own buffer type: `ExportBody` is what
  // the route serialises, and it runs in a package that has no `Buffer`.
  return new Uint8Array(buffer);
}

/**
 * One body cell — **the whole of the requirement in five lines.**
 *
 * The order of the three questions is the order of how much they claim:
 *
 * 1. **empty stays empty.** A blank cell, not an empty string: the CSV writes
 *    nothing there either, and a zero-length string cell is a value that reads
 *    as „answered with nothing".
 * 2. **the submission timestamp is a date** — identified by its column key,
 *    which is the one column the seam names (`SUBMITTED_AT_COLUMN`) and the one
 *    a writer is meant to recognise (`ExportHeader.key`). See
 *    {@link parseTimestamp} for why this is not "decided at the shape of the
 *    value".
 * 3. **a `'number'` column may become a number** — if, and only if, the string
 *    is exactly what that number renders back to ({@link parseNumberCell}).
 *
 * Everything else is text. Not „everything else is left to the library": the
 * cell is assigned a string, which ExcelJS types as a shared string, and the
 * default is therefore the guarded one rather than the interpreted one.
 */
function writeCell(
  target: ExcelJS.Cell,
  cell: ExportCell,
  columnKey: string | undefined,
): void {
  if (cell.value === '') {
    target.value = null;
    return;
  }

  if (columnKey === SUBMITTED_AT_COLUMN) {
    const at = parseTimestamp(cell.value);
    if (at !== null) {
      target.value = at;
      target.numFmt = XLSX_TIMESTAMP_FORMAT;
      return;
    }
  }

  // Decided at the question type, not at the shape of the value: the guard
  // comes from `questionColumns`, where the question is still known. A free
  // text into which somebody typed `27.07.2026` carries `'auto'` and stays
  // text.
  if (cell.guard === 'date') {
    const day = parseIsoDateCell(cell.value);
    if (day !== null) {
      target.value = day;
      target.numFmt = XLSX_DATE_FORMAT;
      return;
    }
  }

  if (cell.guard === 'number') {
    const numeric = parseNumberCell(cell.value);
    if (numeric !== null) {
      target.value = numeric;
      return;
    }
  }

  writeText(target, cell.value);
}

/**
 * A cell that is text and stays text — **exactly the string it was handed**.
 *
 * No apostrophe, no quoting, no leading space. An
 * empty string becomes a blank cell for the reason given at {@link writeCell}.
 */
function writeText(target: ExcelJS.Cell, value: string): void {
  target.value = value === '' ? null : value;
}

/**
 * `TT.MM.JJJJ HH:MM` back into the instant it names, or `null`.
 *
 * ## Why this is no decision "at the shape of the value"
 *
 * The rule the requirement lays down is that the protection is decided at the
 * **question type** and never at what a value happens to look like. This
 * function is not that decision: {@link writeCell} has already established
 * *which* column it is looking at — the submission timestamp, the one column of
 * the sheet that is not a question and whose contents this package itself
 * produced two functions earlier ({@link formatTimestamp}). No answer a
 * participant typed ever reaches it: a question id is a UUID, and a UUID cannot
 * be `__submitted_at__`.
 *
 * ## Why the way back through `formatTimestamp` is checked
 *
 * The parse is accepted only when formatting the result reproduces the input
 * **character for character**. That makes `formatTimestamp` the single
 * definition of the spelling rather than this regex: the day
 * {@link formatTimestamp} changes, this returns `null`, the cell falls back to
 * text — the safe direction — and the pinning test beside it goes red, which is
 * the half that stops a silent fallback from being a silent loss. It also
 * disposes of `32.13.2026` without a second calendar in this file: `Date.UTC`
 * rolls it over to a date that formats differently.
 *
 * A `date` **question** does **not** go through here but through
 * {@link parseIsoDateCell}: it carries `guard: 'date'`, and that is exactly
 * the difference this comment once named as an open one.
 */
function parseTimestamp(value: string): Date | null {
  const parts = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/u.exec(value);
  if (parts === null) {
    return null;
  }
  const [, day, month, year, hour, minute] = parts;
  const at = new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
    ),
  );
  if (Number.isNaN(at.getTime())) {
    return null;
  }
  return formatTimestamp(at.toISOString()) === value ? at : null;
}

/**
 * `TT.MM.JJJJ` back into the day it names, or `null`.
 *
 * Built exactly like {@link parseTimestamp} and for the same reasons — the
 * round trip is what makes the *renderer* the single definition of the
 * spelling, and it is what disposes of `32.13.2026` without a second calendar
 * in this file (`Date.UTC` rolls it over to a day that formats differently).
 *
 * Midnight **UTC**, like the timestamp above: a date written in the machine's
 * zone lands on the previous day for every reader west of it, which is the one
 * way a date cell can be worse than the text it replaced.
 *
 * `null` falls back to text, which is the safe direction: a date nobody can
 * sort is a nuisance, a date that says the wrong day is a defect.
 */
function parseIsoDateCell(value: string): Date | null {
  const parts = /^(\d{2})\.(\d{2})\.(\d{4})$/u.exec(value);
  if (parts === null) {
    return null;
  }
  const [, day, month, year] = parts;
  const at = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (Number.isNaN(at.getTime())) {
    return null;
  }
  // Formatted back through the same two-digit spelling the CSV writes, so a
  // change to `formatIsoDate` makes this return `null` rather than disagree
  // with it silently.
  const pad = (part: number): string => String(part).padStart(2, '0');
  const back = `${pad(at.getUTCDate())}.${pad(at.getUTCMonth() + 1)}.${String(at.getUTCFullYear())}`;
  return back === value ? at : null;
}

/**
 * A `'number'` column's string back into the number it renders from, or `null`.
 *
 * **Both halves are needed, and each catches what the other does not.**
 *
 * The pattern is the gate: German decimal comma, optional sign, digits — the
 * spelling `formatAnswerCell` writes (`String(value).replace('.', ',')`).
 * Without it `Number()` would happily accept `Infinity`, `0x10` and `1e400`,
 * and an `Infinity` assigned to a cell produces a workbook no spreadsheet
 * opens.
 *
 * The **round trip** is the check: the number is written only when rendering it
 * back yields the identical string. That is what makes this safe on foreign
 * data — the export reaches this module through an `as AnswerMap` cast over raw
 * JSONB (`forms.service.ts`), so „this column is numeric" is a promise about a
 * stored value rather than a fact about it. A string `007` on a Zahl question
 * passes the pattern and fails the round trip, and therefore keeps its leading
 * zero as text instead of arriving as `7`; `12345678901234567` fails it past
 * 2^53 and keeps its digits. Both are the same damage the requirement's the evidence
 * is about, one question type further along.
 *
 * Exponential notation (`String(1e-7)` is `1e-7`) does not match the pattern
 * and stays text — no realistic answer, and the safe direction.
 */
function parseNumberCell(value: string): number | null {
  if (!/^-?\d+(,\d+)?$/u.test(value)) {
    return null;
  }
  const numeric = Number(value.replace(',', '.'));
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return String(numeric).replace('.', ',') === value ? numeric : null;
}
