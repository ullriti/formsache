import { describe, expect, it, vi } from 'vitest';

import type * as AnswerColumns from './answer-columns.ts';
import type { QuestionColumn } from './answer-columns.ts';
import { formatAnswerCell } from './answer-columns.ts';
import { buildCsv, chooseColumns, type CsvRow } from './csv.ts';
import { csvColumns, responseColumnGroups } from './form-history.ts';
import {
  parseFormDefinition,
  type FormDefinition,
  type Question,
} from './form-schema.ts';
import type { AnswerMap } from './response-validation.ts';

/**
 * **What an export costs**, measured rather than reasoned about (a review finding).
 *
 * The export is a user action with a progress bar in front of it, and the work
 * it does is not visible in any assertion about the file's *contents*: a
 * `buildCsv` that formats every column of every question of every row produces
 * byte-identical output to one that formats only the chosen ones. That is
 * exactly why it needs a test of its own — the defect this file pins was
 * introduced by a refactor whose whole point was that the files stayed the same,
 * and every existing test stayed green through it.
 *
 * Two numbers are asserted, both per *row*:
 *
 * 1. **How often a cell is formatted.** One chosen column of a 60-question form
 *    is one `formatAnswerCell` call per row, not sixty.
 * 2. **How often the column plan is built.** Once per published version the
 *    rows point at, not once per row — the rows of an export share a handful of
 *    snapshots, and asking each of them again is work with a known answer.
 *
 * The spy is installed by replacing the module the plan comes from, the same
 * device `multi-column-export.test.ts` uses: `questionColumns` is the one
 * function that decides both, so counting there counts the whole path.
 */

const counters = vi.hoisted(() => ({ planned: 0 }));

vi.mock('./answer-columns.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof AnswerColumns>();

  // The real `formatAnswerCell`, wrapped so calls can be counted. Every column
  // of every type that exists today renders its cell with exactly this call
  // (`wholeAnswer`), so its call count *is* the number of cells formatted.
  const spied = vi.fn(actual.formatAnswerCell);

  return {
    ...actual,
    formatAnswerCell: spied,
    /**
     * ⚠️ **`answers` is forwarded, and that is not bookkeeping** (the
     * warning above). This spy stands between the export and the
     * one function that decides how wide the file is. A wrapper that dropped
     * the second argument would plan a table from the *document* alone — the
     * measurement would then count the calls of a file **smaller** than the one
     * the application writes, and the cost cap would pass on a file it never
     * measured. The seam is only measurable through a stand-in that is on the
     * seam. *Reproduction, run on 2026-08-06:* a stand-in that forwards `[]`
     * (`actual.questionColumns(question, [])`) → `expected 20 to be 200`, that
     * is exactly the form's two Startzeilen instead of the twenty answered
     * ones. **Dropping the argument altogether does not measure that**:
     * `tableRowCount` then runs over `undefined` and the run ends in a
     * `TypeError` before a number comes about.
     */
    questionColumns: (
      question: Question,
      answers: readonly AnswerMap[],
    ): QuestionColumn[] => {
      counters.planned += 1;
      return actual.questionColumns(question, answers).map((column) => ({
        ...column,
        render: (value) => spied(question, value),
      }));
    },
  };
});

const PAGE = '019ff000-0000-7000-8000-0000000000e0';
const QUESTIONS = 60;
const ROWS = 500;

function id(index: number): string {
  return `019ff000-0000-7000-8000-${String(index).padStart(12, '0')}`;
}

function text(index: number): Record<string, unknown> {
  return {
    id: id(index),
    label: `Frage ${String(index)}`,
    type: 'text',
    hint: null,
    required: false,
    width: 'full',
    minLength: null,
    maxLength: null,
    pattern: null,
  };
}

/** One published version with sixty questions — a long Jahrestagung form. */
const definition: FormDefinition = parseFormDefinition({
  pages: [
    {
      id: PAGE,
      title: 'Seite 1',
      questions: Array.from({ length: QUESTIONS }, (_, index) => text(index)),
    },
  ],
});

const answers = Object.fromEntries(
  Array.from({ length: QUESTIONS }, (_, index) => [
    id(index),
    `Antwort ${String(index)}`,
  ]),
);

/**
 * Every row against the **same** snapshot object, which is what the export
 * hands over: `exportCsv` parses each published version once and shares it
 * across the rows that point at it.
 */
const rows: CsvRow[] = Array.from({ length: ROWS }, (_, index) => ({
  submittedAt: `2026-07-27T09:${String(index % 60).padStart(2, '0')}:00.000Z`,
  answers,
  definition,
}));

const groups = responseColumnGroups(
  [{ version: 1, definition }],
  rows.map((row) => row.answers),
);

function measure(columnKeys: readonly string[]): {
  formatted: number;
  planned: number;
} {
  vi.mocked(formatAnswerCell).mockClear();
  counters.planned = 0;

  buildCsv(csvColumns(chooseColumns(groups, columnKeys, 'export')), rows);

  return {
    formatted: vi.mocked(formatAnswerCell).mock.calls.length,
    planned: counters.planned,
  };
}

describe('what buildCsv does per row', () => {
  it('formats the chosen column and no other', () => {
    // 500 rows, one chosen column of sixty questions. Rendering every column of
    // every question would be 30 000 calls for a file with 500 values in it.
    expect(measure([id(7)]).formatted).toBe(ROWS);
  });

  it('formats every chosen column, and only those', () => {
    expect(measure([id(7), id(8), id(9)]).formatted).toBe(3 * ROWS);
  });

  /**
   * The plan is a function of the *definition*, not of the row. Sixty questions
   * asked again for each of five hundred rows is 30 000 switch evaluations and
   * 30 000 closures, for five hundred cells.
   */
  it('builds the column plan once per version, not once per row', () => {
    // Twice at most: `responseColumnGroups` is measured separately below, so
    // what is counted here is what `buildCsv` itself asks.
    expect(measure([id(7)]).planned).toBeLessThanOrEqual(QUESTIONS);
  });

  /** Two versions in the file — one plan each, still not one per row. */
  it('keeps one plan per version when the rows carry several', () => {
    const older = parseFormDefinition({
      pages: [
        {
          id: PAGE,
          title: 'Seite 1',
          questions: Array.from({ length: QUESTIONS }, (_, index) =>
            text(index),
          ),
        },
      ],
    });
    const mixed = rows.map((row, index) => ({
      ...row,
      definition: index % 2 === 0 ? definition : older,
    }));

    vi.mocked(formatAnswerCell).mockClear();
    counters.planned = 0;
    buildCsv(csvColumns(chooseColumns(groups, [id(7)], 'export')), mixed);

    expect(vi.mocked(formatAnswerCell).mock.calls.length).toBe(ROWS);
    expect(counters.planned).toBeLessThanOrEqual(2 * QUESTIONS);
  });
});

/**
 * **What the export costs when the rows come from the answers** (the warning
 * above).
 *
 * The measurement above rests on a number the *form* knows: sixty questions,
 * one column each. The requirement takes that away — a table whose participants
 * added rows writes more columns than any reading of the document can predict,
 * and the cost of a file is the first thing that notices.
 *
 * What is asserted is an **equality**, not an upper bound: the file writes as
 * many cells as it has columns, and the columns come from the longest answer.
 * A cost model that consults the document alone lands at `TABLE_START_ROWS`
 * per row and under-reports the file it is supposed to be capping — „sie
 * deckelt eine Datei, die sie für kleiner hält, als sie ist".
 */
const TABLE = '019ff000-0000-7000-8000-0000000000f7';
/** What the form offers. Two, so the gap to what is answered is unmistakable. */
const TABLE_START_ROWS = 2;
/** What the longest answer carries — the ceiling of the document model. */
const TABLE_ANSWERED_ROWS = 20;

const tableDefinition: FormDefinition = parseFormDefinition({
  pages: [
    {
      id: PAGE,
      title: 'Seite 1',
      questions: [
        {
          id: TABLE,
          label: 'Begleitpersonen',
          type: 'table',
          hint: null,
          required: false,
          width: 'full',
          columns: [{ key: 'name', label: 'Name', type: 'text' }],
          rows: TABLE_START_ROWS,
          // **Added, and it changes no number below.** Without it
          // `tableRowLimit` is `rows`, so the twenty-row answer this fixture is
          // built around is one the request path refuses and the schema
          // would never have licensed — a cost model measured against a
          // document that cannot exist. `maxRows: 20` makes the fixture a form
          // an editor may actually save, so the measurement is about a file the
          // application can really be asked to write.
          addRows: { maxRows: TABLE_ANSWERED_ROWS },
        },
      ],
    },
  ],
});

/**
 * Ten answers, and **one** of them long — the shape of a real registration,
 * where most people bring nobody and one organisation brings the whole Aktive.
 */
const TABLE_ROWS_IN_FILE = 10;
const tableRows: CsvRow[] = Array.from(
  { length: TABLE_ROWS_IN_FILE },
  (_, index) => ({
    submittedAt: '2026-08-06T09:00:00.000Z',
    answers: {
      [TABLE]: {
        cells: Array.from(
          { length: index === 3 ? TABLE_ANSWERED_ROWS : 1 },
          (_, row) => ({ name: `Gast ${String(row + 1)}` }),
        ),
      },
    },
    definition: tableDefinition,
  }),
);

describe('what an answer-grown table costs', () => {
  it('formats one cell per column the answers created, for every row', () => {
    const groupsWithRows = responseColumnGroups(
      [{ version: 1, definition: tableDefinition }],
      tableRows.map((row) => row.answers),
    );

    vi.mocked(formatAnswerCell).mockClear();
    counters.planned = 0;
    buildCsv(
      csvColumns(chooseColumns(groupsWithRows, [TABLE], 'export')),
      tableRows,
    );

    // Twenty columns because one answer has twenty rows — not two, which is all
    // the form ever says, and not two hundred, which is what „eine Spalte je
    // Antwortzeile" would give.
    expect(vi.mocked(formatAnswerCell).mock.calls.length).toBe(
      TABLE_ANSWERED_ROWS * TABLE_ROWS_IN_FILE,
    );
    // Still one plan for the one version, however wide it turned out.
    expect(counters.planned).toBe(1);
  });
});

/**
 * **What the case above *cannot* measure** — and the reason this second one
 * exists (the Kostenwarnung above).
 *
 * `TABLE_ANSWERED_ROWS` is 20, and so is `TABLE_ROWS_MAX`. The number the
 * measurement above asserts is therefore the answer to two different questions
 * at once — „so viele Zeilen, wie die längste Antwort hat" and „so viele
 * Zeilen, wie die Datei höchstens schreibt" — and a `tableRowCount` that had
 * stopped reading the answers altogether and simply returned the ceiling would
 * keep it green. That is the question this file exists to ask of every
 * assertion in it: *what would the application have to get wrong for it to go
 * red?*
 *
 * So the fixture below is deliberately clear of both bounds: a table that
 * **starts** with two rows, may legally grow to twelve, and whose longest
 * answer carries seven. Every reading a cost model could have is then a
 * different number, and the equality tells them apart:
 *
 * | wrong rule | cells formatted |
 * |---|---|
 * | the document alone (`rows`) | 20 |
 * | the Obergrenze (`maxRows`) | 120 |
 * | the writing ceiling (`TABLE_ROWS_MAX`) | 200 |
 * | one block per answer | 100 |
 * | one block per answered row | 160 |
 * | **the longest answer** | **70** |
 *
 * „Die Antwortmenge in der Kostenmessung ignorieren" — the naive approach —
 * lands on the first row of that table and undershoots by a
 * factor of three and a half: the cap would be passing a file it never measured.
 */
const GROWABLE = '019ff000-0000-7000-8000-0000000000f8';
/** Startzeilen — what a reading of the document alone would find. */
const GROWABLE_START_ROWS = 2;
/** „Zeilen ergänzbar" up to here — legal, and below `TABLE_ROWS_MAX`. */
const GROWABLE_MAX_ROWS = 12;
/** What the longest answer carries: above the Startzeilen, below both bounds. */
const GROWABLE_ANSWERED_ROWS = 7;
/** Ten answers, so „eine Spalte je Antwort" is a different number again. */
const GROWABLE_ROWS_IN_FILE = 10;

const growableDefinition: FormDefinition = parseFormDefinition({
  pages: [
    {
      id: PAGE,
      title: 'Seite 1',
      questions: [
        {
          id: GROWABLE,
          label: 'Begleitpersonen',
          type: 'table',
          hint: null,
          required: false,
          width: 'full',
          columns: [{ key: 'name', label: 'Name', type: 'text' }],
          rows: GROWABLE_START_ROWS,
          addRows: { maxRows: GROWABLE_MAX_ROWS },
        },
      ],
    },
  ],
});

const growableRows: CsvRow[] = Array.from(
  { length: GROWABLE_ROWS_IN_FILE },
  (_, index) => ({
    submittedAt: '2026-08-07T09:00:00.000Z',
    answers: {
      [GROWABLE]: {
        cells: Array.from(
          { length: index === 3 ? GROWABLE_ANSWERED_ROWS : 1 },
          (_, row) => ({ name: `Gast ${String(row + 1)}` }),
        ),
      },
    },
    definition: growableDefinition,
  }),
);

describe('what a table answered past its start rows costs', () => {
  it('follows the longest answer, and neither bound it sits between', () => {
    const groupsWithRows = responseColumnGroups(
      [{ version: 1, definition: growableDefinition }],
      growableRows.map((row) => row.answers),
    );

    vi.mocked(formatAnswerCell).mockClear();
    counters.planned = 0;
    buildCsv(
      csvColumns(chooseColumns(groupsWithRows, [GROWABLE], 'export')),
      growableRows,
    );

    expect(vi.mocked(formatAnswerCell).mock.calls.length).toBe(
      GROWABLE_ANSWERED_ROWS * GROWABLE_ROWS_IN_FILE,
    );
    expect(counters.planned).toBe(1);
  });
});
