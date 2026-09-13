import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';

import type { CellGuard } from './answer-columns.ts';
import { CSV_BOM, CSV_DELIMITER, buildCsv, escapeCsvCell } from './csv.ts';
import { exportFormatSchema, type ExportFormat } from './export-format.ts';
import {
  EXPORT_FORMATS,
  writeExport,
  type ExportBody,
  type ExportFormatSpec,
} from './export-formats.ts';
import {
  SUBMITTED_AT_COLUMN,
  buildExportSheet,
  chooseColumns,
  renderRow,
  renderSchemalessRow,
  rowMatchesSearch,
  type CsvRow,
  type ExportCell,
} from './export-sheet.ts';
import { csvColumns, responseColumnGroups } from './form-history.ts';
import { parseFormDefinition, type FormDefinition } from './form-schema.ts';

/**
 * The head that has nothing to say in these tests.
 *
 * CSV and Excel do not write it anyway; it stands here only because
 * `writeExport` **demands** it — precisely so that the route cannot
 * forget it. What it does in the HTML is measured by `export-html.test.ts`.
 */
const NO_HEAD = { formTitle: '', tenantName: '', exportedAt: null } as const;

/**
 * **The export seam, proved by a second consumer** .
 *
 * A seam with one user is a claim, not a seam: as long as CSV is the only
 * format, „rows and columns come into being once" and „rows and columns
 * come into being in the CSV branch" produce byte-identical files and every test in this
 * repository stays green under either. Excel and HTML writers arrive later, so
 * the second user is built **here**, as a test double: a writer typed to the
 * production contract ({@link ExportFormatSpec.write}), which therefore sees an
 * `ExportSheet` and nothing else — no answers, no form, no column
 * selection, no search term.
 *
 * What the double writes is a text file of its own with the guard **beside**
 * each value, and the assertions read it back. That is the shape the requirement
 * asks for („liest die Excel-Datei wieder ein und vergleicht Zelle für Zelle
 * mit dem CSV") in the one form available before an Excel writer exists: the
 * comparison runs over what the second format *produced*, not over what it was
 * handed.
 *
 * ## What could actually go wrong here
 *
 * Every assertion below is written against a way the application could be
 * wrong, and the two that matter are the two the application got wrong twice:
 *
 * - a format that works out its own **rows** loses a filter — the file then
 *   contains answers the person exporting never saw (the requirement's
 *   *reproduction*, and the requirement's „alle Spalten heißt nie unbemerkt auch
 *   alle Antworten");
 * - a format that answers the **column question** again disagrees with the
 *   table about what „die angezeigten Spalten" are.
 *
 * *Reproduction run on 2026-08-06:* the second writer works out its
 * rows itself (`buildExportSheet(columns, everyRow)` instead of the filtered
 * set) → „the same set of rows when a search is set" fails with
 * `expected 3 to be 1`, and the cell comparison below it with a file that
 * carries two rows more than the CSV. Both lines are red, no other.
 */

const P = '019ff100-0000-7000-8000-0000000000f0';
const ids = {
  name: '019ff100-0000-7000-8000-000000000001',
  phone: '019ff100-0000-7000-8000-000000000002',
  semester: '019ff100-0000-7000-8000-000000000003',
  address: '019ff100-0000-7000-8000-000000000004',
};

const base = { hint: null, required: false, width: 'full' } as const;

/**
 * One form with the three guards on it: free text (`'auto'`), a Telefon
 * (`'text'`, the leading zero) and a Zahl (`'number'`). The Adresse is the
 * question that occupies **four** columns of which exactly one (PLZ) is guarded
 * differently from its siblings — the case where „ein Schutz je Frage" would be
 * wrong and only „je Spalte" is right.
 */
const definition: FormDefinition = parseFormDefinition({
  pages: [
    {
      id: P,
      title: 'Seite 1',
      questions: [
        {
          ...base,
          id: ids.name,
          type: 'text',
          label: 'Name',
          minLength: null,
          maxLength: null,
          pattern: null,
        },
        { ...base, id: ids.phone, type: 'phone', label: 'Telefon' },
        {
          ...base,
          id: ids.semester,
          type: 'number',
          label: 'Semester',
          min: null,
          max: null,
          integer: false,
        },
        { ...base, id: ids.address, type: 'address', label: 'Anschrift' },
      ],
    },
  ],
});

const snapshots = [{ version: 1, definition }];

const everyRow: readonly CsvRow[] = [
  {
    submittedAt: '2026-07-27T09:05:00.000Z',
    answers: {
      [ids.name]: 'Anton',
      [ids.phone]: '01603884482',
      [ids.semester]: 4.5,
      // The Postleitzahl with the leading zero a spreadsheet eats.
      [ids.address]: {
        street: 'Hauptstraße 1',
        zip: '01067',
        city: 'Dresden',
        country: 'Deutschland',
      },
    },
    definition,
  },
  {
    submittedAt: '2026-07-28T10:06:00.000Z',
    answers: {
      // A formula in free text — every format has to neutralise it, in its own
      // way, from the **same** decision.
      [ids.name]: '=SUM(A1)',
      [ids.phone]: '+49 6421 123456',
      [ids.semester]: 2,
      [ids.address]: {
        street: 'Am Markt 3',
        zip: '35037',
        city: 'Marburg',
        country: 'Deutschland',
      },
    },
    definition,
  },
  // A row whose snapshot no longer parses: it stays in the file with its
  // timestamp — in **every** format, which is a statement about the
  // seam rather than about CSV.
  {
    submittedAt: '2026-07-29T11:07:00.000Z',
    answers: { [ids.name]: 'Cäsar' },
    definition: null,
  },
];

/**
 * The row question, exactly as `forms.service.ts` asks it — the same two
 * functions, in the same order.
 *
 * Spelled out here rather than hidden in a helper of its own, because the point
 * of the tests below is that this happens **once** and both writers are handed
 * the result.
 */
function filterRows(rows: readonly CsvRow[], search: string): CsvRow[] {
  return rows.filter((row) =>
    rowMatchesSearch(
      row.definition === null
        ? renderSchemalessRow(row.submittedAt)
        : renderRow(row.definition, row.submittedAt, row.answers),
      search,
    ),
  );
}

/**
 * Separators of the probe format — control characters, so no answer can
 * contain one and the read-back cannot be fooled by a value that happens to
 * look like a separator. Written as escapes rather than as the characters
 * themselves: an invisible byte in a source file is a defect waiting for a
 * copy-paste.
 */
const CELL = '\u0001';
const FIELD = '\u0002';
const LINE = '\u0003';

/**
 * **The second writer.**
 *
 * Typed as `ExportFormatSpec['write']` on purpose: that is the contract the
 * Excel writer and the HTML writer are held to, and it is the whole guarantee
 * this package exists to give. A writer of this type cannot lose the search
 * filter, because it never receives a row it could keep; it cannot answer the
 * column question, because it never receives a column it was not given.
 *
 * It writes value **and** guard per cell, which is the property a second format
 * needs and CSV happens to hide: in a CSV the guard is visible only as an
 * apostrophe that some cells get and others do not, while `.xlsx` has to turn
 * the same decision into a cell type.
 */
const writeProbe: ExportFormatSpec['write'] = (sheet) =>
  [
    sheet.header
      .map((cell) => [cell.key, cell.guard, cell.value].join(FIELD))
      .join(CELL),
    ...sheet.rows.map((cells) =>
      cells.map((cell) => [cell.guard, cell.value].join(FIELD)).join(CELL),
    ),
  ].join(LINE);

interface ProbeFile {
  readonly keys: readonly string[];
  readonly header: readonly ExportCell[];
  readonly rows: readonly (readonly ExportCell[])[];
}

/** Reads the probe file back — the „wieder einlesen" half of the requirement. */
function readProbe(file: string): ProbeFile {
  const [header, ...rows] = file.split(LINE);
  const headerCells = (header ?? '')
    .split(CELL)
    .map((cell) => cell.split(FIELD));

  return {
    keys: headerCells.map(([key]) => key ?? ''),
    header: headerCells.map(([, guard, value]) => ({
      guard: (guard ?? 'auto') as CellGuard,
      value: value ?? '',
    })),
    rows: rows.map((row) =>
      row.split(CELL).map((cell) => {
        const [guard, value] = cell.split(FIELD);
        return { guard: (guard ?? 'auto') as CellGuard, value: value ?? '' };
      }),
    ),
  };
}

/**
 * One export of the same view in both formats — **the seam in use**.
 *
 * Rows are filtered once and columns chosen once, above the branch; from there
 * on the two formats receive the identical sheet. That is not a convenience of
 * this helper, it is what the production path does (`writeExport`), and the
 * assertions below measure that the two really do end up with the same cells.
 */
async function exportBoth(
  search: string,
  requested: readonly string[] | undefined,
): Promise<{ csv: string; probe: ProbeFile }> {
  const rows = filterRows(everyRow, search);
  const columns = csvColumns(
    chooseColumns(
      responseColumnGroups(
        snapshots,
        rows.map((row) => row.answers),
      ),
      requested,
      // The seam sits at the **export**: here „nothing chosen" means
      // „all columns" . The cases below that mean the
      // *shown* columns therefore name them explicitly — exactly
      // as the answers view writes them onto the wire.
      'export',
    ),
  );

  const written = await writeExport('csv', columns, rows, NO_HEAD);
  const probe = await writeProbe(buildExportSheet(columns, rows), NO_HEAD);

  return {
    csv: typeof written.body === 'string' ? written.body : '',
    probe: readProbe(typeof probe === 'string' ? probe : ''),
  };
}

/**
 * Every column of every published version — „alle Spalten" .
 *
 * The timestamp is in the list, because that is what „alle" means on the wire:
 * the selection names *questions* plus the one column that is not one, and
 * `chooseColumns` keeps exactly what it is given. Leaving it out here produced a
 * file without a submission date and a green test — the first thing this test
 * caught, and the reason the assertion below spells the keys out rather than
 * comparing two computed lists.
 */
const ALL_COLUMNS = [
  ids.name,
  ids.phone,
  ids.semester,
  ids.address,
  SUBMITTED_AT_COLUMN,
];

/**
 * „Angezeigte Spalten" — what the answers view has on the screen and
 * writes onto the wire in exactly that way: the three questions of the table's
 * default selection plus the timestamp.
 *
 * Enumerated explicitly since the export's *default* was turned to „alle":
 * „nothing chosen" is no longer the narrow
 * view here, and a case that means the narrow view has to name it. The figures
 * agree with the table's default selection because they descend from it —
 * `export-default-columns.test.ts` measures that they do.
 */
const SHOWN_COLUMNS = [ids.name, ids.phone, ids.semester, SUBMITTED_AT_COLUMN];

describe('die Ausgabe-Naht trägt beide Formate', () => {
  it('gibt beiden Schreibern dieselbe Zeilenmenge, wenn eine Suche gesetzt ist', async () => {
    const unfiltered = await exportBoth('', undefined);
    const filtered = await exportBoth('Anton', undefined);

    // Without a search: all three answers, the unreadable version included.
    expect(unfiltered.probe.rows).toHaveLength(everyRow.length);
    // With a search: exactly one — and the second writer sees **the same** one.
    // That is the line that turns red as soon as a format works out its rows
    // itself; it counts the rows of the *produced* file, not the input.
    expect(filtered.probe.rows).toHaveLength(1);
    expect(filtered.probe.rows).toHaveLength(csvBodyLines(filtered.csv).length);
    expect(filtered.probe.rows[0]?.[0]?.value).toBe('Anton');
  });

  it('gibt beiden Schreibern dieselbe Spaltenreihenfolge — angezeigte wie alle', async () => {
    const shown = await exportBoth('', SHOWN_COLUMNS);
    const all = await exportBoth('', ALL_COLUMNS);
    const untouched = await exportBoth('', undefined);

    // The shown view (design handoff): the first three questions plus
    // the timestamp — the address is not among them, so neither are any of its
    // four columns.
    expect(shown.probe.keys).toEqual([
      ids.name,
      ids.phone,
      ids.semester,
      '__submitted_at__',
    ]);
    // And the **untouched** export is by now the wide one, not
    // the narrow one: the same seam, the same sheet, both writers. This line
    // turns red as soon as the export falls back to three questions again.
    expect(untouched.probe.keys).toEqual(all.probe.keys);
    expect(untouched.probe.keys).not.toEqual(shown.probe.keys);
    // „Alle Spalten": the same order, plus the four parts of the address.
    // One question, four columns — the case for which the seam has to build the
    // header list and the cells from **one** source.
    expect(all.probe.keys).toEqual([
      ids.name,
      ids.phone,
      ids.semester,
      `${ids.address}#street`,
      `${ids.address}#zip`,
      `${ids.address}#city`,
      `${ids.address}#country`,
      '__submitted_at__',
    ]);
    // And the header line of the CSV is in the same order: the label of
    // every column, in its place.
    expect(all.csv.split('\r\n')[0]).toBe(
      CSV_BOM + all.probe.header.map((cell) => cell.value).join(CSV_DELIMITER),
    );
  });

  it('trägt das Schutz-Merkmal zum zweiten Schreiber, ohne dass er den Fragetyp kennt', async () => {
    const all = await exportBoth('', ALL_COLUMNS);
    const guards = new Map(
      all.probe.keys.map((key, index) => [
        key,
        all.probe.rows[0]?.[index]?.guard,
      ]),
    );

    // The decision is taken at the question type (`questionColumns`), the seam
    // transports it: Telefon stays text (leading zero), the number stays a
    // number (otherwise „Summe" in Excel would be handwork), the PLZ is text although
    // the three other parts of the same question are not.
    expect(guards.get(ids.phone)).toBe('text');
    expect(guards.get(ids.semester)).toBe('number');
    expect(guards.get(`${ids.address}#zip`)).toBe('text');
    expect(guards.get(`${ids.address}#city`)).toBe('auto');
    expect(guards.get(ids.name)).toBe('auto');

    // **And the raw value stays raw.** What the second writer gets is the
    // entered string — without a `'` prefix, without quoting. That is the
    // precondition for Excel typing the same value,
    // and a value already guarded here would arrive there doubly
    // guarded.
    const first = all.probe.rows[0] ?? [];
    expect(first[1]?.value).toBe('01603884482');
    expect(first[4]?.value).toBe('01067');
    // The CSV of the **same** cell carries the guard its format needs.
    expect(all.csv).toContain(`'01603884482`);
  });

  it('schreibt die CSV-Datei aus genau den Zellen, die der zweite Schreiber sieht', async () => {
    for (const [search, requested] of [
      ['', undefined],
      ['Anton', undefined],
      ['', ALL_COLUMNS],
      ['Marburg', ALL_COLUMNS],
    ] as const) {
      const { csv, probe } = await exportBoth(search, requested);

      // Cell by cell: the CSV is exactly the set of cells of the second
      // writer under the CSV spelling. The same rows, the same
      // order, the same values, the same guards — and if one of
      // them is not right, the file stands here beside it, on which one can see
      // which.
      expect(csv).toBe(
        CSV_BOM +
          [probe.header, ...probe.rows]
            .map((cells) =>
              cells
                .map((cell) => escapeCsvCell(cell.value, cell.guard))
                .join(CSV_DELIMITER),
            )
            .join('\r\n') +
          '\r\n',
      );
    }
  });

  it('führt die Route und den CSV-Kurzweg durch dieselbe Naht', async () => {
    const rows = filterRows(everyRow, '');
    const columns = csvColumns(
      chooseColumns(
        responseColumnGroups(
          snapshots,
          rows.map((row) => row.answers),
        ),
        undefined,
        'export',
      ),
    );

    // `buildCsv` is the way the golden files are measured against
    // (`export-golden.test.ts`), `writeExport` the way of the route. Were they two
    // ways into the same file, byte equality would be evidence about a
    // file nobody downloads.
    const written = await writeExport('csv', columns, rows, NO_HEAD);
    expect(written.body).toBe(buildCsv(columns, rows));
    expect(written.extension).toBe('csv');
    expect(written.contentType).toContain('text/csv');
  });

  /**
   * **The full-text search filters the set of rows of
   * *every* format.**
   *
   * „Alle Spalten" never unnoticedly also means „alle Antworten" . The
   * seam makes that structurally true — a writer sees only the sheet, never
   * the unfiltered rows —, and this assertion measures it at the **product**
   * rather than at the construction: the three real writers run, and what is
   * counted are the rows of the files that come out of it.
   *
   * Run under „alle Spalten", because that is exactly the combination
   * somebody can confuse: the widest column view with the narrowest
   * set of rows.
   *
   * *Reproduction, run:* `writeHtml` loses one row
   * (`sheet.rows.slice(0, -1)` — the shape of a drop a writer
   * actually builds: an off-by-one or a „skip the empty row"
   * shortcut) → `html ohne Suche: expected 2 to be 3`, and the message names
   * the format. Six assertions in `export-html.test.ts` go red with it.
   *
   * ⚠️ **What this line *cannot* check, and why that is in order:**
   * „a format works out its rows itself" can no longer be written down here at
   * all — a writer gets the sheet and nothing else
   * (`ExportFormatSpec.write`). The seam makes the mistake impossible instead of
   * detecting it; what is measured is therefore what can still go wrong afterwards:
   * a writer that writes the wrong number of rows out of the right sheet.
   */
  it('die Suche filtert die Zeilen jedes Formats', async () => {
    const counts = new Map<ExportFormat, { all: number; filtered: number }>();

    for (const format of exportFormatSchema.options) {
      counts.set(format, {
        all: await exportedRowCount(format, ''),
        filtered: await exportedRowCount(format, 'Anton'),
      });
    }

    for (const format of exportFormatSchema.options) {
      const measured = counts.get(format);
      // Without a search: all three answers, the unreadable version included.
      expect(measured?.all, `${format} ohne Suche`).toBe(everyRow.length);
      // With a search: exactly the one that carries „Anton".
      expect(measured?.filtered, `${format} mit Suche`).toBe(1);
    }
  });

  it('kennt genau die Formate, die einen Schreiber haben', () => {
    // An entry without a writer would be a 500 where a 400 belongs; a
    // writer without an entry would be a format the route does not accept.
    // Both are invisible from outside as long as nobody touches them.
    for (const [format, spec] of Object.entries(EXPORT_FORMATS)) {
      expect(spec.extension).toBe(format);
      expect(typeof spec.write).toBe('function');
      expect(spec.label.length).toBeGreaterThan(0);
    }
  });
});

/**
 * The body lines of a CSV file — everything after the header, without the
 * trailing newline.
 *
 * Split on the record separator and not on `\n`: one of the fixture's values
 * could carry a line break inside quotes, and a counter that split on `\n`
 * would report a row too many. None of them does today, which is exactly why it
 * is worth doing right here rather than after the first wrong count.
 */
function csvBodyLines(csv: string): string[] {
  return csv
    .slice(CSV_BOM.length)
    .split('\r\n')
    .slice(1)
    .filter((line) => line !== '');
}

/**
 * **How many answer rows the produced file carries** — counted per format in
 * that format's own language.
 *
 * That is the measurement that matters: not „how many rows
 * were handed over" but how many are in the file the browser
 * downloads. That is why every count goes through `writeExport` — the way of the
 * route — and reads the product afterwards.
 */
async function exportedRowCount(
  format: ExportFormat,
  search: string,
): Promise<number> {
  const rows = filterRows(everyRow, search);
  const columns = csvColumns(
    chooseColumns(
      responseColumnGroups(
        snapshots,
        rows.map((row) => row.answers),
      ),
      ALL_COLUMNS,
      'export',
    ),
  );
  const written = await writeExport(format, columns, rows, NO_HEAD);

  switch (format) {
    case 'csv':
      return csvBodyLines(asText(written.body)).length;
    case 'html':
      return htmlBodyRows(asText(written.body));
    case 'xlsx':
      return await xlsxBodyRows(written.body);
  }
}

function asText(body: ExportBody): string {
  if (typeof body !== 'string') {
    throw new Error('this format was expected to write text');
  }
  return body;
}

/**
 * The `<tr>`s inside `<tbody>` — read out of the delivered markup rather than
 * off the sheet that produced it.
 */
function htmlBodyRows(html: string): number {
  const body = html.split('<tbody>')[1]?.split('</tbody>')[0] ?? '';
  return body.split('<tr>').length - 1;
}

/** The rows of the workbook, header excluded, read back through ExcelJS. */
async function xlsxBodyRows(body: ExportBody): Promise<number> {
  if (typeof body === 'string') {
    throw new Error('a workbook was expected to be bytes');
  }
  const workbook = new ExcelJS.Workbook();
  // A copy rather than `body.buffer`, which would be right only for as long as
  // the writer happens to return a view over an exactly sized buffer.
  const buffer = new ArrayBuffer(body.byteLength);
  new Uint8Array(buffer).set(body);
  await workbook.xlsx.load(buffer);
  const worksheet = workbook.worksheets[0];
  if (worksheet === undefined) {
    throw new Error('the workbook carries no worksheet');
  }
  return worksheet.rowCount - 1;
}
