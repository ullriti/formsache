import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';

import type { CellGuard } from './answer-columns.ts';
import { CSV_BOM, CSV_DELIMITER } from './csv.ts';
import { writeExport } from './export-formats.ts';
import {
  SUBMITTED_AT_COLUMN,
  buildExportSheet,
  formatTimestamp,
  renderRow,
  renderSchemalessRow,
  rowMatchesSearch,
  type CsvColumn,
  type CsvRow,
} from './export-sheet.ts';
import { writeXlsx } from './export-xlsx.ts';
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
 * **The Excel export**, measured at the file
 * rather than at the code that writes it.
 *
 * Every assertion below reads the workbook **back in** and looks at what OOXML
 * actually says. That is the shape the requirement insists on („gemessen am
 * Zelltyp beim Wiedereinlesen, nicht am sichtbaren String"), and it is the only
 * shape that can tell the two failures apart that matter here:
 *
 * - a cell that *shows* `=SUM(A1)` because it is text, and one that shows it
 *   because it is a formula waiting for the Mitglied who opens the file;
 * - a cell that *shows* `01067` because it is a string, and one that shows
 *   `'01067` because somebody applied the CSV guard on top of the type
 *   (the sixth case — „doppelt geschützt ist beschädigt", and the failure the first
 *   two cases stay green under).
 */

const PAGE = '019ff200-0000-7000-8000-0000000000f0';
const ids = {
  name: '019ff200-0000-7000-8000-000000000001',
  phone: '019ff200-0000-7000-8000-000000000002',
  semester: '019ff200-0000-7000-8000-000000000003',
  address: '019ff200-0000-7000-8000-000000000004',
  guests: '019ff200-0000-7000-8000-000000000005',
  arrival: '019ff200-0000-7000-8000-000000000006',
};

const base = { hint: null, required: false, width: 'full' } as const;

/**
 * One form carrying all three guards and both structured shapes: free text
 * (`'auto'`), a Telefon (`'text'`), a Zahl (`'number'`), an Adresse whose PLZ
 * column is text while its siblings are not, and a **Tabelle offering two
 * rows** — the question that grows past its own document when an answer carries
 * more, which is what the fifth case is about — and a **Datumsfrage**,
 * which is the second half of the fourth case: „ein Datum sortiert als Datum" held
 * for the submission timestamp long before it held for a date somebody
 * answered.
 */
const definition: FormDefinition = parseFormDefinition({
  pages: [
    {
      id: PAGE,
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
        {
          ...base,
          id: ids.guests,
          type: 'table',
          label: 'Begleitpersonen',
          columns: [
            { key: 'wer', label: 'Name', type: 'text' },
            { key: 'anzahl', label: 'Anzahl', type: 'number' },
          ],
          rows: 2,
        },
        {
          ...base,
          id: ids.arrival,
          type: 'date',
          label: 'Anreise',
          minDate: null,
          maxDate: null,
        },
      ],
    },
  ],
});

const snapshots = [{ version: 1, definition }];

/**
 * Two answers, and the two timestamps are chosen so that **text order and date
 * order disagree**: `31.12.2025 23:59` sorts *after* `01.01.2026 00:05` as a
 * string and *before* it as a date. The fourth case reads exactly that difference —
 * a date column that Excel sorts alphabetically is wrong across every turn of
 * the year, and right by accident the rest of the time.
 */
const everyRow: readonly CsvRow[] = [
  {
    submittedAt: '2025-12-31T23:59:00.000Z',
    answers: {
      [ids.name]: 'Anton',
      [ids.phone]: '01603884482',
      [ids.semester]: 4.5,
      [ids.address]: {
        street: 'Hauptstraße 1',
        zip: '01067',
        city: 'Dresden',
        country: 'Deutschland',
      },
      // **Four rows where the form offers two** : the last two
      // blocks exist only because this answer carries them, and the fourth
      // holds a formula. The guard of a column that came into being through an
      // answer has to be the guard of the column beside it.
      [ids.guests]: {
        cells: [
          { wer: 'Berta', anzahl: 1 },
          { wer: 'Cäsar', anzahl: 2 },
          { wer: 'Dora' },
          { wer: '=SUM(A1)', anzahl: 4 },
        ],
      },
      // The same trap as with the timestamps, one level deeper:
      // `31.12.2025` stands as a string **behind** `01.01.2026` and as a
      // date **in front of** it.
      [ids.arrival]: '2025-12-31',
    },
    definition,
  },
  {
    submittedAt: '2026-01-01T00:05:00.000Z',
    answers: {
      [ids.name]: '=SUM(A1)',
      [ids.phone]: '+49 6421 123456',
      [ids.semester]: 2,
      [ids.address]: {
        street: 'Am Markt 3',
        zip: '35037',
        city: 'Marburg',
        country: 'Deutschland',
      },
      [ids.guests]: { cells: [{ wer: 'Emil', anzahl: 1 }] },
      [ids.arrival]: '2026-01-01',
    },
    definition,
  },
];

/** The row question, exactly as `forms.service.ts` asks it. */
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

/** The column question, exactly as `forms.service.ts` asks it. */
function chosenColumns(
  rows: readonly CsvRow[],
  requested: readonly string[] | undefined,
): CsvColumn[] {
  return csvColumns(
    pick(
      responseColumnGroups(
        snapshots,
        rows.map((row) => row.answers),
      ),
      requested,
    ),
  );
}

/**
 * „Alle Spalten" without spelling the union of published versions out: the
 * whole list is what the export offers, and every test below wants all of it so
 * that no check can pass by looking at a column that is not in the file.
 */
function pick<T extends CsvColumn>(
  all: readonly T[],
  requested: readonly string[] | undefined,
): readonly T[] {
  if (requested === undefined) {
    return all;
  }
  const wanted = new Set(requested);
  return all.filter((column) => wanted.has(column.key));
}

/** One cell as the workbook gives it back. */
interface ReadCell {
  readonly type: ExcelJS.ValueType;
  readonly value: ExcelJS.CellValue;
}

/** A read-back workbook: the header row, and one array of cells per response. */
interface ReadSheet {
  readonly header: readonly ReadCell[];
  readonly rows: readonly (readonly ReadCell[])[];
}

/**
 * Reads the bytes back through ExcelJS — **the measurement every test
 * below relies on.**
 *
 * A fresh workbook rather than the one that wrote it: what is asserted has to
 * have survived the trip through OOXML, because that is the file the
 * Geschäftsstelle opens. A cell type read off the in-memory object would be the
 * writer agreeing with itself.
 */
async function readXlsx(
  bytes: Uint8Array,
  columns: number,
): Promise<ReadSheet> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(toArrayBuffer(bytes));
  const worksheet = workbook.worksheets[0];
  if (worksheet === undefined) {
    throw new Error('the workbook carries no worksheet');
  }

  const cellsOf = (rowNumber: number): ReadCell[] =>
    Array.from({ length: columns }, (_, index) => {
      const cell = worksheet.getRow(rowNumber).getCell(index + 1);
      return { type: cell.type, value: cell.value };
    });

  return {
    header: cellsOf(1),
    // `rowCount` counts every row the sheet has; the first is the header.
    rows: Array.from({ length: worksheet.rowCount - 1 }, (_, index) =>
      cellsOf(index + 2),
    ),
  };
}

/**
 * An exact `ArrayBuffer` of the bytes — what `xlsx.load` is typed for.
 *
 * A copy rather than `bytes.buffer`, which would be right only for as long as
 * the writer happens to return a view over an exactly sized buffer.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

/** One export of the given view, read back as a workbook. */
async function exportXlsx(
  search = '',
  requested?: readonly string[],
): Promise<ReadSheet & { readonly keys: readonly string[] }> {
  const rows = filterRows(everyRow, search);
  const columns = chosenColumns(rows, requested);
  const sheet = await readXlsx(
    await writeXlsx(buildExportSheet(columns, rows)),
    columns.length,
  );
  return { ...sheet, keys: columns.map((column) => column.key) };
}

/** The index of a column in the file, by its key. */
function columnOf(keys: readonly string[], key: string): number {
  const index = keys.indexOf(key);
  if (index < 0) {
    throw new Error(`the file has no column ${key}`);
  }
  return index;
}

describe('Excel führt nichts aus, und keine führende Null geht verloren', () => {
  /**
   * **The first case.** Measured at the cell *type*: `ValueType.Formula` is a
   * separate type from `ValueType.String`, so this assertion is the difference
   * between „shows `=SUM(A1)`" and „computes something when opened". The
   * visible string is identical in both cases, which is why measuring it
   * alone would prove nothing.
   */
  it('schreibt einen Freitext mit Formelzeichen als Text, nicht als Formel', async () => {
    const sheet = await exportXlsx();
    const name = columnOf(sheet.keys, ids.name);

    const cell = sheet.rows[1]?.[name];
    expect(cell?.value).toBe('=SUM(A1)');
    expect(cell?.type).toBe(ExcelJS.ValueType.String);
    // And not a single cell of the whole file is a formula — the header
    // included, because a question is allowed to be called „=Summe".
    expect(
      [sheet.header, ...sheet.rows]
        .flat()
        .filter((read) => read.type === ExcelJS.ValueType.Formula),
    ).toStrictEqual([]);
  });

  /**
   * **The second case.** The two values whose damage is silent: a Postleitzahl and
   * a German phone number both lose their leading zero the moment a
   * spreadsheet is allowed to read them as numbers, and nothing in the file
   * afterwards says that they did.
   *
   * Both columns are `'text'` by decision of the **question type** — the
   * Telefon as a whole, the PLZ as one of the Adresse's four columns while the
   * three beside it are free text. That the sibling columns are *not* text is
   * asserted too: a writer that made everything text would pass the first half
   * of this test and would have stopped honouring the decision.
   */
  it('behält die führende Null von PLZ und Telefonnummer, als Text', async () => {
    const sheet = await exportXlsx();
    const first = sheet.rows[0] ?? [];

    const phone = first[columnOf(sheet.keys, ids.phone)];
    expect(phone?.value).toBe('01603884482');
    expect(phone?.type).toBe(ExcelJS.ValueType.String);

    const zip = first[columnOf(sheet.keys, `${ids.address}#zip`)];
    expect(zip?.value).toBe('01067');
    expect(zip?.type).toBe(ExcelJS.ValueType.String);
  });

  /**
   * **The third case**, and the reason the format exists at all: a Zahl arrives as
   * a number, so a „Summe" over the column is a click rather than a morning.
   * `4,5` in the file is the number 4.5 — the German decimal comma is a
   * *rendering* of the answer, and writing it as the string it renders to would
   * make every arithmetic operation on the column manual work.
   */
  it('schreibt eine Zahlfrage als Zahl, nicht als Text', async () => {
    const sheet = await exportXlsx();
    const semester = columnOf(sheet.keys, ids.semester);

    expect(sheet.rows[0]?.[semester]).toStrictEqual({
      type: ExcelJS.ValueType.Number,
      value: 4.5,
    });
    expect(sheet.rows[1]?.[semester]).toStrictEqual({
      type: ExcelJS.ValueType.Number,
      value: 2,
    });
    // The table column „Anzahl" is the same decision one level deeper:
    // the protection lies per **column**, and in a table two
    // different ones stand next to each other.
    expect(
      sheet.rows[0]?.[columnOf(sheet.keys, `${ids.guests}#0#anzahl`)],
    ).toStrictEqual({ type: ExcelJS.ValueType.Number, value: 1 });
  });

  /**
   * **The fourth case.** „Sortiert als Datum" is not a claim about how the cell
   * looks — it is a claim about the **order** two cells stand in, and the
   * fixture is built so that the two orders disagree: as text `31.12.2025`
   * sorts after `01.01.2026`, as a date before it. Sorting the read-back values
   * therefore fails on a text column and passes on a date one.
   */
  it('schreibt den Zeitstempel so, dass Excel ihn als Datum sortiert', async () => {
    const sheet = await exportXlsx();
    const at = columnOf(sheet.keys, SUBMITTED_AT_COLUMN);
    const cells = sheet.rows.map((row) => row[at]);

    for (const cell of cells) {
      expect(cell?.type).toBe(ExcelJS.ValueType.Date);
    }
    // The header of the same column is text — „Eingereicht am (UTC)" is no
    // date, and a writer that types the column instead of the cell would come
    // out here.
    expect(sheet.header[at]?.type).toBe(ExcelJS.ValueType.String);

    const values = cells.map((cell) => cell?.value);
    const sorted = [...values].sort((left, right) =>
      left instanceof Date && right instanceof Date
        ? left.getTime() - right.getTime()
        : 0,
    );
    // Chronologically: New Year's Eve before New Year's Day.
    expect(sorted.map((value) => (value as Date).toISOString())).toStrictEqual([
      '2025-12-31T23:59:00.000Z',
      '2026-01-01T00:05:00.000Z',
    ]);
    // And exactly this order is the **other** one from the alphabetical —
    // otherwise the case above would prove nothing.
    const asText = everyRow
      .map((row) => formatTimestamp(row.submittedAt))
      .sort();
    expect(asText[0]).toBe('01.01.2026 00:05');
  });

  /**
   * **The fourth case, second half: a `date` *question*** .
   *
   * The case above measures the timestamp — the one column this package
   * produces itself. This one measures a participant's answer, and it is
   * the half that has been missing until now: „Anreise" carried
   * `guard: 'auto'`, stood as a string in the file and sorted `01.01.2026`
   * before `31.12.2025`.
   *
   * The same fixture trap as above, and for the same reason: if the case fell
   * on two dates of the same year, text order and date order would be equal
   * and the assertion would prove nothing.
   */
  it('schreibt eine Datumsfrage so, dass Excel sie als Datum sortiert', async () => {
    const sheet = await exportXlsx();
    const at = columnOf(sheet.keys, ids.arrival);
    const cells = sheet.rows.map((row) => row[at]);

    for (const cell of cells) {
      expect(cell?.type).toBe(ExcelJS.ValueType.Date);
    }
    // The header stays text — otherwise somebody types the column instead of
    // the cell.
    expect(sheet.header[at]?.type).toBe(ExcelJS.ValueType.String);

    const values = cells.map((cell) => cell?.value);
    const sorted = [...values].sort((left, right) =>
      left instanceof Date && right instanceof Date
        ? left.getTime() - right.getTime()
        : 0,
    );
    expect(sorted.map((value) => (value as Date).toISOString())).toStrictEqual([
      // Midnight **UTC**, not in the machine's zone: otherwise the day lands
      // on the previous day for every reader west of it.
      '2025-12-31T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    ]);
    // And again: the alphabetical order is the other one.
    expect(['31.12.2025', '01.01.2026'].sort()[0]).toBe('01.01.2026');
  });

  /**
   * **The counter-check to the decision „by question type".**
   *
   * A free text into which somebody typed `27.07.2026` looks like a
   * date and is none. It carries `'auto'` and has to stay text — a
   * writer that read the *shape* of the value instead would come out exactly
   * here, and only with the one participant who wrote their date into the
   * wrong field.
   */
  it('macht aus einem Freitext, der wie ein Datum aussieht, kein Datum', async () => {
    const rows: readonly CsvRow[] = [
      {
        submittedAt: '2026-07-27T09:05:00.000Z',
        answers: { [ids.name]: '27.07.2026' },
        definition,
      },
    ];
    const columns = chosenColumns(rows, undefined);
    const sheet = await readXlsx(
      await writeXlsx(buildExportSheet(columns, rows)),
      columns.length,
    );
    const keys = columns.map((column) => column.key);

    expect(sheet.rows[0]?.[columnOf(keys, ids.name)]).toStrictEqual({
      type: ExcelJS.ValueType.String,
      value: '27.07.2026',
    });
  });

  /**
   * **The fifth case**: the fourth row block of the table exists
   * only because one answer carried four rows where the form offers two. Its
   * cells got their key, their header and their guard from the same three lines
   * the form's own rows got them from — and this is the measurement that the
   * protection did not lapse at the seam between „vom Formular" and „von einer
   * Antwort".
   */
  it('schützt auch eine Zelle, die erst durch eine Antwort entstanden ist', async () => {
    const sheet = await exportXlsx();
    const grown = columnOf(sheet.keys, `${ids.guests}#3#wer`);

    // The column is there at all only because one answer carries four rows.
    expect(sheet.header[grown]?.value).toBe('Begleitpersonen — Name (Zeile 4)');
    expect(sheet.rows[0]?.[grown]).toStrictEqual({
      type: ExcelJS.ValueType.String,
      value: '=SUM(A1)',
    });
    // The second answer never filled this row in: an **empty** cell,
    // not a shifted one and not one with an empty string.
    expect(sheet.rows[1]?.[grown]?.type).toBe(ExcelJS.ValueType.Null);
  });

  /**
   * **The sixth case — the actual finding behind this requirement.**
   *
   * The first two cases measure the *type*, and a workbook that applied the CSV
   * apostrophe on top of the type would pass both of them: the cell would still
   * be text, only its contents would be `'01067` instead of `01067`. This is
   * the assertion that fails in that case, and it is written over **every** cell
   * of the file rather than over the two interesting ones, because „doppelt
   * geschützt" is a property of the writer and shows up wherever it is applied.
   *
   * The comparison is against the sheet the seam built — the raw rendered
   * answer, as the participant gave it (`export-sheet.ts` hands the value over
   * unescaped on purpose). So this also pins that nothing was quoted, wrapped or
   * padded on the way into OOXML.
   */
  it('enthält exakt den eingegebenen String — ohne Präfix, Anführung oder Leerzeichen', async () => {
    const rows = filterRows(everyRow, '');
    const columns = chosenColumns(rows, undefined);
    const built = buildExportSheet(columns, rows);
    const sheet = await readXlsx(await writeXlsx(built), columns.length);

    const written = [sheet.header, ...sheet.rows];
    [built.header, ...built.rows].forEach((expected, rowIndex) => {
      expected.forEach((cell, index) => {
        const value = written[rowIndex]?.[index]?.value;
        if (cell.value === '') {
          // An empty cell is empty, not an empty string: „not filled in" and
          // „filled in with nothing" are two things in a table.
          expect(value).toBeNull();
          return;
        }
        if (typeof value === 'number') {
          // The one permitted deviation („der entschärfte im CSV gegen den
          // typisierten in Excel"): a number stands there as a number and
          // renders back to the same string.
          expect(String(value).replace('.', ',')).toBe(cell.value);
          return;
        }
        if (value instanceof Date) {
          // Two date spellings, and the guard says which — see
          // `logicalValue`.
          expect(
            cell.guard === 'date'
              ? spellDate(value)
              : formatTimestamp(value.toISOString()),
          ).toBe(cell.value);
          return;
        }
        // And otherwise: **the same string**, character for character.
        expect(value).toBe(cell.value);
      });
    });

    // And expressly: no apostrophe, nowhere. That is the line that goes red
    // when somebody applies `escapeCsvCell` here too „to be on the safe side".
    const texts = written
      .flat()
      .map((read) => read.value)
      .filter((value): value is string => typeof value === 'string');
    expect(texts.filter((value) => value.startsWith("'"))).toStrictEqual([]);
    expect(texts.filter((value) => value.startsWith(' '))).toStrictEqual([]);
    expect(texts.filter((value) => value.startsWith('"'))).toStrictEqual([]);
  });
});

describe('Excel exportiert dieselbe Sicht wie CSV', () => {
  /**
   * **This case.** Both files come out of *one* call to `writeExport` per
   * format, over the same rows and the same columns — and the comparison is
   * over what they **produced**: how many rows, in which order the columns
   * stand, and what each cell logically says.
   *
   * „Logisch" and not „Zeichen für Zeichen", because the two formats are
   * *supposed* to differ in exactly the places the requirement names: the CSV
   * writes `'01067` and `4,5`, the workbook writes the string `01067` and the
   * number 4.5. The comparison therefore reduces both sides to the value a
   * reader sees — the CSV cell with its apostrophe removed, the Excel cell
   * rendered back through the same spelling the seam produced.
   */
  it.each([
    ['ohne Suche', '', undefined],
    ['mit Suche', 'Anton', undefined],
    ['mit Spaltenauswahl', '', [ids.name, ids.semester, SUBMITTED_AT_COLUMN]],
  ] as const)(
    'trägt %s dieselben Zeilen, Spalten und Werte wie die CSV',
    async (_name, search, requested) => {
      const rows = filterRows(everyRow, search);
      const columns = chosenColumns(rows, requested);

      const csv = await writeExport('csv', columns, rows, NO_HEAD);
      const xlsx = await writeExport('xlsx', columns, rows, NO_HEAD);
      expect(typeof csv.body).toBe('string');
      expect(xlsx.body).toBeInstanceOf(Uint8Array);

      const sheet = await readXlsx(xlsx.body as Uint8Array, columns.length);
      const csvCells = parseCsv(csv.body as string);

      // The same set of rows — counted on the produced files, not on the
      // input. That is the line that goes red as soon as a format determines
      // its rows itself.
      expect(sheet.rows).toHaveLength(csvCells.length - 1);
      // The same column order — the header row stands in both files in
      // the same order, and both carry the labels of the selection.
      expect(sheet.header.map((cell) => cell.value ?? '')).toStrictEqual(
        csvCells[0],
      );
      expect(sheet.header.map((cell) => cell.value ?? '')).toStrictEqual(
        columns.map((column) => column.label),
      );
      // And cell by cell the same logical value.
      // The guards come from the **seam**, not from a list in this
      // test: for a date cell `logicalValue` has to choose the same spelling
      // the writer chose, and `ExportSheet` is exactly what
      // both writers saw.
      const plan = buildExportSheet(columns, rows);
      sheet.rows.forEach((cells, index) => {
        expect(
          cells.map((cell, column) =>
            logicalValue(cell, plan.rows[index]?.[column]?.guard ?? 'auto'),
          ),
        ).toStrictEqual(csvCells[index + 1]);
      });
    },
  );

  /**
   * The row set really is the *filtered* one and not the whole table — stated
   * as its own assertion, because the comparison above would stay green if both
   * formats exported everything.
   */
  it('lässt die Suche auf beide Formate wirken', async () => {
    const rows = filterRows(everyRow, 'Anton');
    expect(rows).toHaveLength(1);

    const columns = chosenColumns(rows, undefined);
    const sheet = await readXlsx(
      (await writeExport('xlsx', columns, rows, NO_HEAD)).body as Uint8Array,
      columns.length,
    );

    expect(sheet.rows).toHaveLength(1);
    expect(
      sheet.rows[0]?.[
        columnOf(
          columns.map((c) => c.key),
          ids.name,
        )
      ]?.value,
    ).toBe('Anton');
  });

  /** The format is served as a workbook, not as text under an `.xlsx` name. */
  it('wird als Arbeitsmappe ausgeliefert', async () => {
    const rows = filterRows(everyRow, '');
    const written = await writeExport(
      'xlsx',
      chosenColumns(rows, undefined),
      rows,
      NO_HEAD,
    );

    expect(written.extension).toBe('xlsx');
    expect(written.contentType).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    // A ZIP archive begins with `PK` — the cheapest check that
    // bytes arrive here and not a JSON serialisation of a `Uint8Array`.
    const body = written.body as Uint8Array;
    expect([body[0], body[1]]).toStrictEqual([0x50, 0x4b]);
  });
});

/**
 * `TT.MM.JJJJ` of a date cell — the spelling the CSV carries for a `date`
 * question, written out here rather than imported because `formatIsoDate` is
 * module-private in `answer-columns.ts` and should stay so.
 */
function spellDate(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(at.getUTCDate())}.${pad(at.getUTCMonth() + 1)}.${String(at.getUTCFullYear())}`;
}

/**
 * The value a reader takes from an Excel cell, in the spelling the seam
 * produced it in — see the comparison above for why that is the right unit.
 *
 * The guard comes in as an argument for the **two** date cells this file now
 * has: the submission timestamp is `TT.MM.JJJJ HH:MM`, a `date` question is
 * `TT.MM.JJJJ`. Read off the column's guard rather than guessed from
 * the value, so this helper makes the same distinction the writer makes — a
 * version that looked at „ist es Mitternacht?" would agree with it until
 * somebody submits at 00:00.
 */
function logicalValue(cell: ReadCell, guard: CellGuard): string {
  if (cell.value === null || cell.value === undefined) {
    return '';
  }
  if (cell.value instanceof Date) {
    return guard === 'date'
      ? spellDate(cell.value)
      : formatTimestamp(cell.value.toISOString());
  }
  if (typeof cell.value === 'number') {
    return String(cell.value).replace('.', ',');
  }
  if (typeof cell.value === 'string') {
    return cell.value;
  }
  // The writer produces strings, numbers, dates and blanks and nothing else —
  // a rich-text or hyperlink cell here would be a shape this comparison cannot
  // speak about, and silently stringifying it would hide that.
  throw new Error(`unexpected cell shape: ${JSON.stringify(cell.value)}`);
}

/**
 * Reads the CSV back into cells, apostrophe removed.
 *
 * A small reader rather than a library: the file is written by this package, so
 * the two spellings that have to be undone are exactly the two `escapeCsvCell`
 * applies — RFC-4180 quoting and the formula guard's leading `'`. It is here so
 * that the comparison above runs over what the CSV **says**, not over how it
 * spells it.
 */
function parseCsv(csv: string): string[][] {
  const body = csv.slice(CSV_BOM.length);
  const rows: string[][] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < body.length; index += 1) {
    // `charAt` rather than `body[index]`, which is `string | undefined` under
    // `noUncheckedIndexedAccess` even inside a bounds-checked loop.
    const character = body.charAt(index);
    if (quoted) {
      if (character === '"' && body[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
      continue;
    }
    if (character === '"' && cell === '') {
      quoted = true;
    } else if (character === CSV_DELIMITER) {
      cells.push(cell);
      cell = '';
    } else if (character === '\r' && body[index + 1] === '\n') {
      cells.push(cell);
      rows.push(cells);
      cells = [];
      cell = '';
      index += 1;
    } else {
      cell += character;
    }
  }
  if (cell !== '' || cells.length > 0) {
    cells.push(cell);
    rows.push(cells);
  }

  return rows.map((row) =>
    row.map((value) => (value.startsWith("'") ? value.slice(1) : value)),
  );
}
