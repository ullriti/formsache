import { describe, expect, it } from 'vitest';

import { CSV_BOM, buildCsv, chooseColumns, type CsvRow } from './csv.ts';
import { csvColumns, responseColumnGroups } from './form-history.ts';
import { parseFormDefinition, type FormDefinition } from './form-schema.ts';

/**
 * **The load-bearing assurance: every export the application writes
 * today is byte for byte the one it wrote before the column seam existed.**
 *
 * The seam took the export apart — a question no longer *is* a column, it
 * *produces* columns — and the whole point of doing that before Adresse, Matrix
 * and Tabelle arrive is that nothing about the nine existing types changes. A
 * refactoring of a CSV writer is the kind of change whose damage is silent: a
 * shifted separator, a lost apostrophe or a dropped BOM does not raise, it
 * produces a file that opens wrong on somebody else's machine weeks later.
 *
 * The expectations below are not hand-written. They were **measured** from the
 * code as it stood before the seam (`git show HEAD:…/csv.ts`) and pasted in
 * unchanged, which is what makes this a comparison rather than a restatement:
 * a test whose expectation was written after the change would agree with
 * whatever the change happens to do.
 *
 * The fixture covers all nine question types, every guard (`'text'` for the
 * Telefon, `'number'` for the Zahl, `'auto'` for the rest), the round-trip
 * check that keeps `01067` a string, quoting (delimiter, quote, line break), a
 * retired column, a row from an older version and a row whose snapshot no
 * longer parses.
 */

const P = '019ff000-0000-7000-8000-0000000000f0';
const ids = {
  text: '019ff000-0000-7000-8000-000000000001',
  textarea: '019ff000-0000-7000-8000-000000000002',
  number: '019ff000-0000-7000-8000-000000000003',
  date: '019ff000-0000-7000-8000-000000000004',
  email: '019ff000-0000-7000-8000-000000000005',
  phone: '019ff000-0000-7000-8000-000000000006',
  select: '019ff000-0000-7000-8000-000000000007',
  radio: '019ff000-0000-7000-8000-000000000008',
  checkbox: '019ff000-0000-7000-8000-000000000009',
  gone: '019ff000-0000-7000-8000-00000000000a',
};

const base = { hint: null, required: false, width: 'full' } as const;

const questions = {
  text: {
    ...base,
    id: ids.text,
    type: 'text',
    label: 'Name',
    minLength: null,
    maxLength: null,
    pattern: null,
  },
  textarea: {
    ...base,
    id: ids.textarea,
    type: 'textarea',
    label: 'Bemerkung',
    minLength: null,
    maxLength: null,
    rows: 4,
  },
  number: {
    ...base,
    id: ids.number,
    type: 'number',
    label: 'Semester',
    min: null,
    max: null,
    integer: false,
  },
  date: {
    ...base,
    id: ids.date,
    type: 'date',
    label: 'Stichtag',
    minDate: null,
    maxDate: null,
  },
  email: { ...base, id: ids.email, type: 'email', label: 'E-Mail' },
  phone: { ...base, id: ids.phone, type: 'phone', label: 'Telefon' },
  select: {
    ...base,
    id: ids.select,
    type: 'select',
    label: 'Organisation',
    options: [
      { value: 'a', label: 'Nord' },
      { value: 'b', label: 'Süd' },
    ],
    allowOther: false,
    otherLabel: null,
  },
  radio: {
    ...base,
    id: ids.radio,
    type: 'radio',
    label: 'Verpflegung',
    options: [
      { value: 'v', label: 'Vegetarisch' },
      { value: 'f', label: 'Fleisch' },
    ],
    allowOther: true,
    otherLabel: 'Anders',
  },
  checkbox: {
    ...base,
    id: ids.checkbox,
    type: 'checkbox',
    label: 'Tage',
    options: [
      { value: 'fr', label: 'Freitag' },
      { value: 'sa', label: 'Samstag' },
    ],
    allowOther: true,
    otherLabel: 'Anderer Tag',
    minSelected: null,
    maxSelected: null,
  },
  /** Asked in version 1, gone in version 2 — the retired column. */
  gone: {
    ...base,
    id: ids.gone,
    type: 'text',
    label: 'Zimmerwunsch',
    minLength: null,
    maxLength: null,
    pattern: null,
  },
};

function definition(keys: readonly (keyof typeof questions)[]): FormDefinition {
  return parseFormDefinition({
    pages: [
      { id: P, title: 'Seite 1', questions: keys.map((key) => questions[key]) },
    ],
  });
}

const EVERY_TYPE = [
  'text',
  'textarea',
  'number',
  'date',
  'email',
  'phone',
  'select',
  'radio',
  'checkbox',
] as const;

const v1 = definition([...EVERY_TYPE, 'gone']);
const v2 = definition(EVERY_TYPE);

const snapshots = [
  { version: 1, definition: v1 },
  { version: 2, definition: v2 },
];

const answers = {
  // A Postleitzahl in a text question: the round-trip check has to keep it.
  [ids.text]: '01067',
  // Delimiter, quote and line break in one value — all three quoting rules.
  [ids.textarea]: 'zwei\nZeilen; mit "Zitat"',
  // Negative: begins like a formula, and must stay a number all the same.
  [ids.number]: -0.25,
  [ids.date]: '2026-05-15',
  [ids.email]: 'anton@example.org',
  // The leading zero a spreadsheet eats without the `'text'` guard.
  [ids.phone]: '01603884482',
  [ids.select]: { values: ['a'], other: null },
  // A formula typed into the „Sonstiges" box of a choice question.
  [ids.radio]: { values: [], other: '=1+1' },
  [ids.checkbox]: { values: ['fr', 'sa'], other: 'Sonntag' },
  [ids.gone]: 'Einzelzimmer',
};

const rows: CsvRow[] = [
  { submittedAt: '2026-07-27T09:05:00.000Z', answers, definition: v1 },
  { submittedAt: '2026-07-28T10:06:00.000Z', answers, definition: v2 },
  // The snapshot no longer parses: kept, timestamp only.
  { submittedAt: '2026-07-29T11:07:00.000Z', answers, definition: null },
];

/**
 * The answer set the header list is built from — **the rows of this very file**.
 *
 * The header and the cells have to be built over the same rows since a
 * question's column count may depend on them; `buildCsv` takes its
 * cell plan from the rows it is handed, so the list beside it is built from the
 * same array rather than from a second, plausible-looking one. None of the nine
 * types in this fixture reads it, which is exactly why the golden files below
 * are unchanged.
 */
const answerSet = rows.map((row) => row.answers);

/**
 * The frame — BOM, CRLF, trailing newline — spelled out here so a change to any
 * of the three fails, and the content below stays readable line by line.
 */
function file(lines: readonly string[]): string {
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}

describe('the export is byte-identical to the one before the column seam', () => {
  it('writes every column of every published version', () => {
    const csv = buildCsv(
      csvColumns(responseColumnGroups(snapshots, answerSet)),
      rows,
    );

    expect(csv).toBe(
      file([
        'Name;Bemerkung;Semester;Stichtag;E-Mail;Telefon;Organisation;Verpflegung;Tage;Zimmerwunsch (nicht mehr gefragt);Eingereicht am (UTC)',
        `'01067;"zwei\nZeilen; mit ""Zitat""";-0,25;15.05.2026;anton@example.org;'01603884482;Nord;Anders: =1+1;Freitag, Samstag, Anderer Tag: Sonntag;Einzelzimmer;27.07.2026 09:05`,
        `'01067;"zwei\nZeilen; mit ""Zitat""";-0,25;15.05.2026;anton@example.org;'01603884482;Nord;Anders: =1+1;Freitag, Samstag, Anderer Tag: Sonntag;;28.07.2026 10:06`,
        ';;;;;;;;;;29.07.2026 11:07',
      ]),
    );
  });

  /**
   * **The one file whose bytes deliberately changed** .
   *
   * An untouched export used to carry only „die ersten drei Fragen plus
   * Eingereicht am" — the four columns the *table* shows. The client decided
   * that a file is a statement about data rather than about screen space, so the
   * untouched export is now the whole form: byte for byte the file of the case
   * above.
   *
   * That it *is* byte for byte that file is the assertion, not a coincidence to
   * be tidied away: both come out of the same writer over the same rows, and the
   * only difference is that one names every column and the other names none.
   * The table's own default is measured on the very next case, from the very
   * same function.
   */
  it('writes every column into the untouched export', () => {
    const csv = buildCsv(
      csvColumns(
        chooseColumns(
          responseColumnGroups(snapshots, answerSet),
          undefined,
          'export',
        ),
      ),
      rows,
    );

    expect(csv).toBe(
      buildCsv(csvColumns(responseColumnGroups(snapshots, answerSet)), rows),
    );
    expect(csv).toContain(
      'Name;Bemerkung;Semester;Stichtag;E-Mail;Telefon;Organisation;Verpflegung;Tage;Zimmerwunsch (nicht mehr gefragt);Eingereicht am (UTC)',
    );
  });

  /**
   * And the table's default, unchanged — the bytes that stood here before that change,
   * measured through `buildCsv` because that is the only way to see a *column
   * selection* as a file.
   *
   * The table writes no file, so this is not an export anybody downloads. It is
   * kept because it is the one place where the two preselections stand side by
   * side over one fixture: if `'table'` ever produced what `'export'` produces
   * (or the other way round), exactly one of these two cases goes red, and the
   * diff names which.
   */
  it('keeps the three-question preselection for the table', () => {
    const csv = buildCsv(
      csvColumns(
        chooseColumns(
          responseColumnGroups(snapshots, answerSet),
          undefined,
          'table',
        ),
      ),
      rows,
    );

    expect(csv).toBe(
      file([
        'Name;Bemerkung;Semester;Eingereicht am (UTC)',
        `'01067;"zwei\nZeilen; mit ""Zitat""";-0,25;27.07.2026 09:05`,
        `'01067;"zwei\nZeilen; mit ""Zitat""";-0,25;28.07.2026 10:06`,
        ';;;29.07.2026 11:07',
      ]),
    );
  });

  it('writes a hand-picked selection, retired column included', () => {
    const csv = buildCsv(
      csvColumns(
        chooseColumns(
          responseColumnGroups(snapshots, answerSet),
          [ids.phone, ids.gone],
          'export',
        ),
      ),
      rows,
    );

    expect(csv).toBe(
      file([
        'Telefon;Zimmerwunsch (nicht mehr gefragt)',
        `'01603884482;Einzelzimmer`,
        `'01603884482;`,
        ';',
      ]),
    );
  });

  /**
   * The wire contract with the frontend, unchanged: one entry per question plus
   * the timestamp, with the retired one marked. The file expands each of these
   * into its columns; the client never sees that expansion, which is why adding
   * it needed no change to `responseColumnSchema`.
   */
  it('leaves the columns the client receives exactly as they were', () => {
    expect(
      responseColumnGroups(snapshots, answerSet).map(
        ({ key, label, retired }) => ({
          key,
          label,
          retired,
        }),
      ),
    ).toEqual([
      { key: ids.text, label: 'Name', retired: false },
      { key: ids.textarea, label: 'Bemerkung', retired: false },
      { key: ids.number, label: 'Semester', retired: false },
      { key: ids.date, label: 'Stichtag', retired: false },
      { key: ids.email, label: 'E-Mail', retired: false },
      { key: ids.phone, label: 'Telefon', retired: false },
      { key: ids.select, label: 'Organisation', retired: false },
      { key: ids.radio, label: 'Verpflegung', retired: false },
      { key: ids.checkbox, label: 'Tage', retired: false },
      { key: ids.gone, label: 'Zimmerwunsch', retired: true },
      {
        key: '__submitted_at__',
        label: 'Eingereicht am (UTC)',
        retired: false,
      },
    ]);
  });
});

/**
 * **The golden case of the growing table** .
 *
 * The block above proves that nothing *changed*. This one proves the one thing
 * that did — and it is measured at the **file**, not at the plan, because the
 * failure cannot be seen anywhere else:
 *
 * > „die Kopfzeile aus dem Formular bilden und die Zellen aus den Antworten →
 * > Werte stehen unter falschen Köpfen; das ist die wahrscheinlichste Form des
 * > Fehlers, weil Kopf und Zelle heute an zwei Stellen entstehen."
 *
 * They really do: `responseColumnGroups` → `csvColumns` builds the header list,
 * `buildExportSheet` → `exportPlan` builds the cells, and each of them asks
 * `questionColumns` for itself. Every assertion that stops short of the file —
 * the plan tests in `answer-columns.test.ts`, the cost measurement in
 * `export-cost.test.ts` (which mocks `render` and counts calls) — sees exactly
 * one of the two halves and stays green while the other drifts. Only a written
 * file has both under one another.
 *
 * ## What the fixture is built to catch
 *
 * - **Unequal lengths.** Three answers with 1, 3 and 5 rows over a form that
 *   offers 2. Nothing about „fünf Blöcke" can be read off the document, and
 *   nothing about „zwei" can be read off the longest answer.
 * - **The deliberately empty middle row of the middle answer.** `Cäsar` is the
 *   *third* row of an answer whose second row is blank. An export that walked
 *   the rows a participant actually filled — the obvious `filter(…).map(…)` —
 *   would put them under „Zeile 2" and their age under „Alter (Zeile 2)", and
 *   the file would still look perfectly plausible. This is the row that says the
 *   index into the stored array is the index of the column.
 * - **A shorter answer's empty cells.** The first answer has one row and ten
 *   columns to fill; nine of them are empty **in their own place**, not absent
 *   and not shifted left.
 * - **The guard of a row that only an answer created.** `=SUM(A1)` sits in the
 *   *fourth* row of the third answer — a block no reading of the form predicts
 *   — and reaches the file as `'=SUM(A1)`. „Der Schutz liegt je Spalte" has to
 *   hold for a column the document never mentioned (the warning above).
 * - **A neighbour on each side.** „Organisation" before the table and the timestamp
 *   after it: a block one column too wide or too narrow moves them, so the two
 *   are the alignment witnesses that a table-only fixture would not have.
 */
const TABLE_PAGE = '019ff000-0000-7000-8000-0000000000f1';
const tableIds = {
  Organisation: '019ff000-0000-7000-8000-000000000011',
  table: '019ff000-0000-7000-8000-000000000012',
};

/** Two Startzeilen, growable to twenty — the gap to the answers is the point. */
const TABLE_START_ROWS = 2;

/**
 * The fixture form, with and without „Zeilen ergänzbar" — **the two versions
 * this file is exported over** (a review finding).
 *
 * `growth === undefined` is the table in its original shape: two rows, fixed. That
 * is version 1, and it is the version history the application actually produces —
 * an existing form gets the switch ticked, and the answers filed before that
 * stay in the same export as the ones filed after.
 *
 * Everything else is identical between the two, deliberately: the label, the
 * columns and the Startzeilen all appear in the file, so a difference in any of
 * them would move a header and hide the thing being measured behind it.
 */
function growingTableWith(
  growth: { readonly maxRows: number } | undefined,
): FormDefinition {
  return parseFormDefinition({
    pages: [
      {
        id: TABLE_PAGE,
        title: 'Seite 1',
        questions: [
          {
            ...base,
            id: tableIds.Organisation,
            type: 'text',
            label: 'Organisation',
            minLength: null,
            maxLength: null,
            pattern: null,
          },
          {
            ...base,
            id: tableIds.table,
            type: 'table',
            label: 'Begleitpersonen',
            columns: [
              { key: 'name', label: 'Name', type: 'text' },
              // A Zahl column beside a Text one, so the file carries both
              // guards through the dynamic rows: `'number'` must not pick up
              // the apostrophe, `'auto'` must.
              { key: 'age', label: 'Alter', type: 'number' },
            ],
            rows: TABLE_START_ROWS,
            ...(growth === undefined ? {} : { addRows: growth }),
          },
        ],
      },
    ],
  });
}

/** Version 1 — the fixed table, before anybody ticked „Zeilen ergänzbar". */
const fixedTable = growingTableWith(undefined);
/** Version 2 — the same questions, now growable to twenty. */
const growingTable = growingTableWith({ maxRows: 20 });

/**
 * **Two versions, and the expected file does not change because of it** — that
 * is the statement (a review finding).
 *
 * The header of a table is one list over the **whole** file: the question
 * keeps its id across versions, so „Zeile 5" is a column of the file and not a
 * column of version 2. The cells are planned **per version** (`exportPlan`), so
 * the short answer below is rendered through a plan built for a table that
 * could not grow at all — into a header five row blocks wide, made so by two
 * answers filed under a later version.
 *
 * **What this does not prove, and it was measured** (same review): splitting
 * the answer set by version inside `exportPlan` leaves this file byte-identical
 * — all 1392 tests of the package stayed green under that change. The reason is
 * at `exportPlan`; it is a property of the seam, not a gap in this fixture. A
 * plan built over a set *smaller* than the header's does show here: handing it
 * the first answer alone makes the first case below red.
 */
const growingSnapshots = [
  { version: 1, definition: fixedTable },
  { version: 2, definition: growingTable },
];

/**
 * One row filled — nine of its ten table cells are empty, each in its place.
 *
 * **Filed under version 1**, the table that could not grow: one row inside
 * the two the form offered, and it still has to reach the file under a header
 * that is five rows wide because *other* answers made it so.
 */
const shortAnswer = {
  [tableIds.Organisation]: 'Nord',
  [tableIds.table]: { cells: [{ name: 'Anton', age: 21 }] },
};

/**
 * Three rows, **the middle one blank** — the load-bearing answer of this file.
 *
 * `{}` rather than a missing entry, because that is what a participant who
 * added three rows and filled the first and the last leaves behind
 * (`TableAnswer` is sparse per cell, positional per row).
 */
const gappedAnswer = {
  [tableIds.Organisation]: 'Süd',
  [tableIds.table]: {
    cells: [{ name: 'Berta', age: 22 }, {}, { name: 'Cäsar', age: 23 }],
  },
};

/** Five rows — the longest, and therefore the width of everybody's file. */
const longAnswer = {
  [tableIds.Organisation]: 'Ost',
  [tableIds.table]: {
    cells: [
      { name: 'Dora', age: 24 },
      { name: 'Emil', age: 25 },
      { name: 'Frida', age: 26 },
      // Row four exists only because somebody added it: no reading of the
      // document produces this column, and it still has to be guarded.
      { name: '=SUM(A1)', age: 27 },
      { name: 'Gustav', age: 28 },
    ],
  },
};

const growingRows: CsvRow[] = [
  {
    submittedAt: '2026-08-07T08:01:00.000Z',
    answers: shortAnswer,
    // Version 1 — see {@link growingSnapshots}. The other two rows were filed
    // after the switch was ticked and carry version 2.
    definition: fixedTable,
  },
  {
    submittedAt: '2026-08-07T09:02:00.000Z',
    answers: gappedAnswer,
    definition: growingTable,
  },
  {
    submittedAt: '2026-08-07T10:03:00.000Z',
    answers: longAnswer,
    definition: growingTable,
  },
];

/**
 * Header **and** cells from one and the same answer set — the production path
 * (`exportResponses` filters first and then builds both from the result).
 *
 * Written as one function rather than spelled out per case so that no case in
 * this block can accidentally feed the two halves from two sets: that is the
 * defect being tested, and a test that could commit it by hand would be
 * measuring its own fixture.
 */
function growingCsv(
  rows: readonly CsvRow[],
  chosen?: readonly string[],
): string {
  const answerSet = rows.map((row) => row.answers);
  const groups = responseColumnGroups(growingSnapshots, answerSet);
  return buildCsv(
    csvColumns(
      chosen === undefined ? groups : chooseColumns(groups, chosen, 'export'),
    ),
    rows,
  );
}

/** The header line of a written file — the bytes, not a rebuilt list. */
function headerOf(csv: string): string {
  return csv.slice(CSV_BOM.length).split('\r\n')[0] ?? '';
}

describe('the export carries the rows the answers added', () => {
  it('writes unequal tables into one grid, shorter answers empty rather than shifted', () => {
    expect(growingCsv(growingRows)).toBe(
      file([
        'Organisation;' +
          'Begleitpersonen — Name (Zeile 1);Begleitpersonen — Name (Zeile 2);' +
          'Begleitpersonen — Name (Zeile 3);Begleitpersonen — Name (Zeile 4);' +
          'Begleitpersonen — Name (Zeile 5);' +
          'Begleitpersonen — Alter (Zeile 1);Begleitpersonen — Alter (Zeile 2);' +
          'Begleitpersonen — Alter (Zeile 3);Begleitpersonen — Alter (Zeile 4);' +
          'Begleitpersonen — Alter (Zeile 5);' +
          'Eingereicht am (UTC)',
        // One row filled: everything after it is empty, and „21" stays under
        // „Alter (Zeile 1)" rather than sliding to the first free column.
        'Nord;Anton;;;;;21;;;;;07.08.2026 08:01',
        // **The row this is about.** Two blanks — one for the row the
        // participant left empty, one for the row nobody has — and „Cäsar"
        // under „Zeile 3", where it was entered.
        'Süd;Berta;;Cäsar;;;22;;23;;;07.08.2026 09:02',
        // Row four is a column no reading of the form produces, and its Text
        // cell is guarded there exactly as in row one; the Zahl beside it is
        // not, so „Summe" over „Alter (Zeile 4)" still works.
        `Ost;Dora;Emil;Frida;'=SUM(A1);Gustav;24;25;26;27;28;07.08.2026 10:03`,
      ]),
    );
  });

  /**
   * The first half of the requirement, on its own: **the header names the block and the
   * row number.** Asserted against the written line rather than against
   * `csvColumns`, because that is the surface the Mitglied reads — and
   * because a header that agreed with the plan and disagreed with the file
   * would be exactly the drift this block exists for.
   */
  it('names question, column and row number in every header', () => {
    expect(headerOf(growingCsv(growingRows, [tableIds.table]))).toBe(
      'Begleitpersonen — Name (Zeile 1);Begleitpersonen — Name (Zeile 2);' +
        'Begleitpersonen — Name (Zeile 3);Begleitpersonen — Name (Zeile 4);' +
        'Begleitpersonen — Name (Zeile 5);' +
        'Begleitpersonen — Alter (Zeile 1);Begleitpersonen — Alter (Zeile 2);' +
        'Begleitpersonen — Alter (Zeile 3);Begleitpersonen — Alter (Zeile 4);' +
        'Begleitpersonen — Alter (Zeile 5)',
    );
  });

  /**
   * **The longest answer, not the number of answers.**
   *
   * Six answers, the longest of them three rows, over a form offering two — so
   * the four readings a column count could have are four different files and
   * the assertion tells them apart:
   *
   * | wrong rule | blocks per column |
   * |---|---|
   * | the document alone | 2 |
   * | **the longest answer** | **3** |
   * | one per answer | 6 |
   * | one per answered row | 8 |
   */
  it('grows the column count with the longest answer, not with the number of answers', () => {
    const many: CsvRow[] = [
      { cells: [{ name: 'Anton' }] },
      { cells: [{ name: 'Berta' }] },
      { cells: [{ name: 'Cäsar' }, { name: 'Dora' }, { name: 'Emil' }] },
      { cells: [{ name: 'Frida' }] },
      { cells: [{ name: 'Gustav' }] },
      { cells: [{ name: 'Hanna' }] },
    ].map((cells, index) => ({
      submittedAt: `2026-08-07T0${String(index)}:00:00.000Z`,
      answers: { [tableIds.table]: cells },
      definition: growingTable,
    }));

    expect(headerOf(growingCsv(many, [tableIds.table]))).toBe(
      'Begleitpersonen — Name (Zeile 1);Begleitpersonen — Name (Zeile 2);' +
        'Begleitpersonen — Name (Zeile 3);' +
        'Begleitpersonen — Alter (Zeile 1);Begleitpersonen — Alter (Zeile 2);' +
        'Begleitpersonen — Alter (Zeile 3)',
    );
  });

  /**
   * **Zero filled rows, and the question is in the file all the
   * same** — with the Startspalten the form prescribes.
   *
   * Both spellings of „nothing", because they arrive on different paths and
   * only one of them is what a stored answer looks like: a submission that
   * never touched the table carries no entry at all, an edit that removed every
   * row carries `cells: []`. A `max(question.rows, …)` that had been written as
   * „the longest answer, or the form's rows when there is no answer" would pass
   * the first and drop the second to a header of nothing.
   */
  it('keeps the form’s start columns when nobody filled a single row', () => {
    const untouched: CsvRow[] = [
      {
        submittedAt: '2026-08-07T08:01:00.000Z',
        answers: { [tableIds.Organisation]: 'Nord' },
        definition: growingTable,
      },
      {
        submittedAt: '2026-08-07T09:02:00.000Z',
        answers: {
          [tableIds.Organisation]: 'Süd',
          [tableIds.table]: { cells: [] },
        },
        definition: growingTable,
      },
    ];

    expect(growingCsv(untouched)).toBe(
      file([
        'Organisation;' +
          'Begleitpersonen — Name (Zeile 1);Begleitpersonen — Name (Zeile 2);' +
          'Begleitpersonen — Alter (Zeile 1);Begleitpersonen — Alter (Zeile 2);' +
          'Eingereicht am (UTC)',
        'Nord;;;;;07.08.2026 08:01',
        'Süd;;;;;07.08.2026 09:02',
      ]),
    );
  });
});
