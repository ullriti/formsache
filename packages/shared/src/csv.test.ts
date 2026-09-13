import { describe, expect, it } from 'vitest';

import {
  allQuestions,
  parseFormDefinition,
  type FormDefinition,
  type Question,
} from './form-schema.ts';
import type { AnswerMap } from './response-validation.ts';
import {
  formatAnswerCell,
  questionColumns,
  type CellGuard,
} from './answer-columns.ts';
import {
  CSV_BOM,
  CSV_DELIMITER,
  SUBMITTED_AT_COLUMN,
  SUBMITTED_AT_LABEL,
  buildCsv,
  escapeCsvCell,
  renderRow,
  renderSchemalessRow,
  rowMatchesSearch,
  type CsvRow,
} from './csv.ts';

/**
 * The formatting half, and the half where a mistake is
 * silent: a stray separator or a broken quote does not raise, it produces a
 * file that opens with every column shifted by one.
 */

/**
 * „Keine Antworten" — the answer set the plan takes as its second source,
 * empty. Nothing in this file exercises a table whose
 * answers are longer than the form; the plan of the form alone is what the CSV
 * rules below are about.
 */
const NO_ANSWERS: readonly AnswerMap[] = [];

const P = '019ff000-0000-7000-8000-0000000000f0';
const TEXT = '019ff000-0000-7000-8000-000000000001';
const NUMBER = '019ff000-0000-7000-8000-000000000002';
const CHOICE = '019ff000-0000-7000-8000-000000000003';
const DATE = '019ff000-0000-7000-8000-000000000004';
const PHONE = '019ff000-0000-7000-8000-000000000005';

const base = { hint: null, required: false, width: 'full' } as const;

function definition(): FormDefinition {
  return parseFormDefinition({
    pages: [
      {
        id: P,
        title: 'Seite 1',
        questions: [
          {
            ...base,
            id: TEXT,
            type: 'text',
            label: 'Name',
            minLength: null,
            maxLength: null,
            pattern: null,
          },
          {
            ...base,
            id: NUMBER,
            type: 'number',
            label: 'Semester',
            min: null,
            max: null,
            integer: false,
          },
          {
            ...base,
            id: CHOICE,
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
          {
            ...base,
            id: DATE,
            type: 'date',
            label: 'Stichtag',
            minDate: null,
            maxDate: null,
          },
          { ...base, id: PHONE, type: 'phone', label: 'Telefon' },
        ],
      },
    ],
  });
}

function row(
  answers: AnswerMap,
  submittedAt = '2026-07-27T09:05:00.000Z',
): CsvRow {
  return { submittedAt, answers, definition: definition() };
}

/**
 * Data lines without the BOM and the header.
 *
 * Only the **last** element is dropped, and only because the file ends with a
 * line break. Filtering every empty line would hide the case below where a row
 * legitimately renders as one empty cell.
 */
function dataLines(csv: string): string[] {
  const lines = csv.slice(CSV_BOM.length).split('\r\n').slice(1);
  return lines.at(-1) === '' ? lines.slice(0, -1) : lines;
}

/**
 * The guard of a single-column question, read off the **plan** — the one place
 * a guard is decided since a review closed the gap (`questionColumns`), and the
 * same object `buildCsv` takes it from.
 *
 * There used to be a `cellGuardFor` for this, and these tests were its only
 * caller. A guard that a test can look up by a route the export does not take
 * is a guard the export can lose without a test noticing.
 */
function guardOf(question: Question): CellGuard {
  const [column] = questionColumns(question, NO_ANSWERS);
  if (column === undefined) {
    throw new Error(`fixture question ${question.id} writes no column`);
  }
  return column.guard;
}

describe('escapeCsvCell', () => {
  it('leaves an ordinary value alone', () => {
    expect(escapeCsvCell('Anton', 'auto')).toBe('Anton');
  });

  it('quotes a value containing the delimiter, a quote or a line break', () => {
    expect(escapeCsvCell(`a${CSV_DELIMITER}b`, 'auto')).toBe(
      `"a${CSV_DELIMITER}b"`,
    );
    expect(escapeCsvCell('sagt "hallo"', 'auto')).toBe('"sagt ""hallo"""');
    expect(escapeCsvCell('zwei\nZeilen', 'auto')).toBe('"zwei\nZeilen"');
  });

  /**
   * The security half of a CSV export, and the reason it is not merely a
   * formatting concern: participants type free text into a **public** form,
   * and a value beginning with `=` is executed by Excel and LibreOffice when
   * the Mitglied who received the file opens it.
   */
  // `-1` **is** in this list. Without a guard argument the cell is free text,
  // and free text beginning with `-` is guarded like any other. The exemption
  // for numbers hangs on the question's column (`questionColumns`), not on the
  // string — see the block at the end of this file.
  it.each(['=1+1', '+1', '-1', '-1+1', '@SUM(A1)', '\tx', '\rx'])(
    'neutralises the formula prefix in %j without discarding the value',
    (value) => {
      const cell = escapeCsvCell(value, 'auto');

      expect(cell.startsWith("'") || cell.startsWith(`"'`)).toBe(true);
      // The answer is data. Stripping part of it would be worse than showing
      // a leading apostrophe.
      expect(cell).toContain(value.replace(/^[\t\r]/u, ''));
    },
  );

  it('puts the apostrophe inside the quotes, not around them', () => {
    // Order matters: the guard changes the value, the quoting describes it.
    expect(escapeCsvCell(`=a${CSV_DELIMITER}b`, 'auto')).toBe(
      `"'=a${CSV_DELIMITER}b"`,
    );
  });
});

describe('formatAnswerCell', () => {
  /**
   * The three questions of the fixture, resolved by id.
   *
   * By lookup rather than by position with a non-null assertion: the assertion
   * would be a claim this file cannot check, and a reordering of the fixture
   * would silently move every test onto the wrong question.
   */
  function question(id: string): Question {
    const found = allQuestions(definition()).find((entry) => entry.id === id);
    if (found === undefined) {
      throw new Error(`fixture has no question ${id}`);
    }
    return found;
  }

  const text = question(TEXT);
  const number = question(NUMBER);
  const choice = question(CHOICE);
  const date = question(DATE);

  it('renders an unanswered question as an empty cell', () => {
    expect(formatAnswerCell(text, undefined)).toBe('');
    expect(formatAnswerCell(text, null)).toBe('');
  });

  it('writes numbers with a German decimal comma', () => {
    // `4.5` would be read as a date by a German Excel.
    expect(formatAnswerCell(number, 4.5)).toBe('4,5');
    expect(formatAnswerCell(number, 4)).toBe('4');
  });

  /**
   * A negative number begins with `-`, which is a formula prefix — so the
   * guard used to turn every one of them into text. „Summe" over such a
   * column then skips exactly those rows, silently.
   */
  it('leaves a negative number a number', () => {
    const cell = (value: number): string =>
      escapeCsvCell(formatAnswerCell(number, value), guardOf(number));

    expect(cell(-5)).toBe('-5');
    expect(cell(-0.25)).toBe('-0,25');
  });

  it('still guards free text that only starts like a number', () => {
    // The exemption follows the *question*, not the shape of the string: a
    // text answer beginning with `-` is something somebody typed.
    expect(escapeCsvCell('-5 Grad', 'auto')).toBe("'-5 Grad");
    expect(escapeCsvCell('-1+1', 'auto')).toBe("'-1+1");
  });

  /**
   * A stored answer of the wrong shape must not take the whole file down.
   * Unreachable through any write path — checked because the alternative is
   * `.map` on foreign JSONB, and that throws.
   */
  it('renders a damaged choice answer as empty instead of throwing', () => {
    const broken = { values: 'vegetarisch', other: null };
    expect(() => formatAnswerCell(choice, broken as never)).not.toThrow();
    expect(formatAnswerCell(choice, broken as never)).toBe('');
  });

  /**
   * The stored format is `YYYY-MM-DD`; the file's own timestamp column writes
   * `TT.MM.JJJJ`. Two date notations in one spreadsheet is what an acceptance
   * run turned up, and it is the reader who pays for it.
   */
  it('writes a date answer the way the timestamp column writes dates', () => {
    expect(formatAnswerCell(date, '2026-05-15')).toBe('15.05.2026');
  });

  /**
   * Only a *date question* is reformatted. A text answer that happens to look
   * like a date is a value someone typed, and rewriting it would change what
   * they said.
   */
  it('leaves a date-shaped text answer alone', () => {
    expect(formatAnswerCell(text, '2026-05-15')).toBe('2026-05-15');
  });

  /**
   * Labels, not values: the export is read by a person, and `ja` says less
   * than `Ja, ich komme`. The labels come from the schema version the answer
   * was validated against.
   */
  it('renders choices as their labels, including „Sonstiges"', () => {
    expect(
      formatAnswerCell(choice, { values: ['fr', 'sa'], other: null }),
    ).toBe('Freitag, Samstag');
    expect(formatAnswerCell(choice, { values: ['fr'], other: 'Sonntag' })).toBe(
      'Freitag, Anderer Tag: Sonntag',
    );
  });

  it('shows a value whose option is gone rather than dropping it', () => {
    // The participant chose it. An empty cell would read as "did not answer".
    expect(formatAnswerCell(choice, { values: ['so'], other: null })).toBe(
      'so',
    );
  });

  /**
   * An optional question whose „Sonstiges" box was ticked and left empty is
   * stored as `{values: [], other: ''}` — the shape `isBlankAnswer` calls
   * unanswered. Reading the presence of the box as an answer wrote „Anderer
   * Tag: " into the cell, i.e. a Teilnehmerliste claiming somebody said
   * something they did not.
   */
  it('leaves the cell empty when the „Sonstiges" box was left empty', () => {
    expect(formatAnswerCell(choice, { values: [], other: '' })).toBe('');
    expect(formatAnswerCell(choice, { values: [], other: '   ' })).toBe('');
    // Same for a question that *was* answered next to an empty box: the ticks
    // are the answer, the empty caption is not part of it.
    expect(formatAnswerCell(choice, { values: ['fr'], other: '' })).toBe(
      'Freitag',
    );
  });
});

/**
 * The **folded** rendering of the two structured types — what the
 * responses table, the detail panel and the notification mails show. The requirement
 * calls exactly this rendering unusable *for the file* and keeps it *on
 * screen*: a table row has one cell per question, and a reader wants the whole
 * answer at a glance.
 */
describe('formatAnswerCell über Matrix und Tabelle', () => {
  const MATRIX = '019ff000-0000-7000-8000-00000000000a';
  const TABLE = '019ff000-0000-7000-8000-00000000000b';

  function foldDefinition(): FormDefinition {
    return parseFormDefinition({
      pages: [
        {
          id: P,
          title: 'Rückmeldung',
          description: null,
          questions: [
            {
              ...base,
              id: MATRIX,
              type: 'matrix',
              label: 'Bewertung',
              rows: [
                { value: 'organisation', label: 'Organisation' },
                { value: 'programm', label: 'Programm' },
              ],
              columns: [
                { value: 'sehr-gut', label: 'Sehr gut' },
                { value: 'gut', label: 'Gut' },
              ],
              multiple: true,
            },
            {
              ...base,
              id: TABLE,
              type: 'table',
              label: 'Begleitpersonen',
              columns: [
                { key: 'name', label: 'Name', type: 'text' },
                { key: 'anzahl', label: 'Anzahl', type: 'number' },
              ],
              rows: 2,
            },
          ],
        },
      ],
    });
  }

  const [matrix, table] = allQuestions(foldDefinition());
  if (matrix === undefined || table === undefined) {
    throw new Error('fixture is incomplete');
  }

  it('folds a matrix to one line, skipping the rows nobody answered', () => {
    expect(
      formatAnswerCell(matrix, {
        rows: { organisation: ['sehr-gut'], programm: ['gut'] },
      }),
    ).toBe('Organisation: Sehr gut; Programm: Gut');
    expect(
      formatAnswerCell(matrix, { rows: { programm: ['sehr-gut', 'gut'] } }),
    ).toBe('Programm: Sehr gut, Gut');
    expect(formatAnswerCell(matrix, { rows: {} })).toBe('');
  });

  it('folds a table row by row, skipping the cells and rows left empty', () => {
    expect(
      formatAnswerCell(table, {
        cells: [{ name: 'Anna', anzahl: 2 }, { name: 'Bert' }],
      }),
    ).toBe('Name: Anna, Anzahl: 2; Name: Bert');
    expect(formatAnswerCell(table, { cells: [{}, {}] })).toBe('');
  });

  /**
   * A structured answer that does not belong to this question is read as
   * unanswered rather than rendered by guesswork — the same defensive read
   * every other shape gets here.
   */
  it('renders nothing for an answer of the other shape', () => {
    expect(formatAnswerCell(matrix, { cells: [{ name: 'Anna' }] })).toBe('');
    expect(formatAnswerCell(table, { rows: { programm: ['gut'] } })).toBe('');
  });
});

describe('buildCsv', () => {
  it('starts with the BOM, so Excel does not mangle umlauts', () => {
    const csv = buildCsv(
      [
        { key: TEXT, label: 'Name' },
        { key: SUBMITTED_AT_COLUMN, label: SUBMITTED_AT_LABEL },
      ],
      [],
    );

    expect(csv.startsWith(CSV_BOM)).toBe(true);
    // Without the BOM this is where „Müller" becomes „MÃ¼ller".
    expect(csv).toContain('Name');
  });

  it('writes a header of the chosen columns and one line per row', () => {
    const csv = buildCsv(
      [
        { key: TEXT, label: 'Name' },
        { key: SUBMITTED_AT_COLUMN, label: SUBMITTED_AT_LABEL },
      ],
      [row({ [TEXT]: 'Müller' }), row({ [TEXT]: 'Schmidt' })],
    );

    const [header] = csv.slice(CSV_BOM.length).split('\r\n');
    expect(header).toBe(`Name${CSV_DELIMITER}${SUBMITTED_AT_LABEL}`);
    expect(dataLines(csv)).toStrictEqual([
      `Müller${CSV_DELIMITER}27.07.2026 09:05`,
      `Schmidt${CSV_DELIMITER}27.07.2026 09:05`,
    ]);
  });

  it('ends every line with CRLF, as RFC 4180 asks', () => {
    const csv = buildCsv(
      [{ key: TEXT, label: 'Name' }],
      [row({ [TEXT]: 'A' })],
    );

    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv).not.toContain('\n\n');
  });

  it('exports only the chosen columns, in the order they were chosen', () => {
    const csv = buildCsv(
      [
        { key: SUBMITTED_AT_COLUMN, label: 'Zeit' },
        { key: TEXT, label: 'Name' },
      ],
      [row({ [TEXT]: 'Anton', [NUMBER]: 3 })],
    );

    // No `Semester` column: it was not selected.
    expect(csv).not.toContain('3');
    expect(dataLines(csv)).toStrictEqual([
      `27.07.2026 09:05${CSV_DELIMITER}Anton`,
    ]);
  });

  /**
   * A column for a question this row's schema version does not have — a
   * question added after the row was submitted. Empty is the truthful
   * cell: the participant was never asked.
   */
  it('leaves a cell empty when the row predates its question', () => {
    const csv = buildCsv(
      [{ key: '019ff000-0000-7000-8000-0000000000ff', label: 'Neu' }],
      [row({ [TEXT]: 'Anton' })],
    );

    expect(dataLines(csv)).toStrictEqual(['']);
  });

  it('escapes values inside the file, not only in isolation', () => {
    const csv = buildCsv(
      [{ key: TEXT, label: 'Name' }],
      [row({ [TEXT]: `=cmd|'/c calc'!A0` })],
    );

    // Prefixed but **not** quoted: the value carries no delimiter, no quote
    // and no line break, so RFC 4180 asks for no quoting — and adding some
    // anyway would be a second, undocumented rule.
    expect(dataLines(csv)[0]).toBe(`'=cmd|'/c calc'!A0`);
  });

  /**
   * The guards, through `buildCsv` rather than through a hand-assembled call.
   *
   * The unit tests below pass the guard in themselves, so every one of them
   * would stay green if the argument were dropped at the single place it
   * decides anything — the cell loop of `buildCsv`. This is the test that fails
   * then, and that is the whole reason it exists.
   */
  it('applies the guard of each question when it writes the file', () => {
    const csv = buildCsv(
      [
        { key: PHONE, label: 'Telefon' },
        { key: NUMBER, label: 'Semester' },
        { key: TEXT, label: 'PLZ' },
      ],
      [row({ [PHONE]: '01603884482', [NUMBER]: -5, [TEXT]: '01067' })],
    );

    expect(dataLines(csv)).toStrictEqual([
      ["'01603884482", '-5', "'01067"].join(CSV_DELIMITER),
    ]);
  });

  it('produces a header-only file for no rows', () => {
    const csv = buildCsv([{ key: TEXT, label: 'Name' }], []);

    expect(dataLines(csv)).toStrictEqual([]);
  });
});

/**
 * A row whose stored snapshot no longer parses — `definition: null`.
 *
 * It is **kept** rather than dropped, because „der Export folgt der sichtbaren
 * Sicht"  is a promised property and the responses table keeps the row
 * too (`toRow`). A file that is one line shorter than the count on screen
 * teaches people to distrust the export, and nothing in it says *which* line
 * went missing.
 *
 * Covered here rather than only through the API integration test: this is the
 * formatting layer, and it is the layer where a mistake is silent (`CONTRIBUTING.md`
 * puts the weight of the pyramid down here).
 */
describe('buildCsv over a row without a schema', () => {
  const columns = [
    { key: TEXT, label: 'Name' },
    { key: NUMBER, label: 'Semester' },
    { key: SUBMITTED_AT_COLUMN, label: SUBMITTED_AT_LABEL },
  ];

  /** The same answers as a healthy row — none of them may reach the file. */
  const damaged: CsvRow = {
    submittedAt: '2026-07-27T09:05:00.000Z',
    answers: { [TEXT]: 'Anton', [NUMBER]: 4 },
    definition: null,
  };

  it('writes the row, with its timestamp and otherwise empty cells', () => {
    expect(dataLines(buildCsv(columns, [damaged]))).toStrictEqual([
      ';;27.07.2026 09:05',
    ]);
  });

  it('keeps the line count equal to the row count', () => {
    const rows = [row({ [TEXT]: 'Berta' }), damaged, row({ [TEXT]: 'Cäsar' })];

    expect(dataLines(buildCsv(columns, rows))).toHaveLength(3);
  });

  /**
   * The stored answers are *not* formatted against some other version as a
   * salvage attempt. Without its own schema there is no way to know what
   * `4` was asked as, and a value in the wrong column is worse than a blank.
   */
  it('does not fall back to another version to fill the cells', () => {
    const csv = buildCsv(columns, [damaged]);

    expect(csv).not.toContain('Anton');
    expect(csv).not.toContain('4');
  });

  /**
   * The timestamp is written through the same `renderSchemalessRow` the table
   * uses, so the one cell the row does have reads identically in both places —
   * and it stays escaped like any other cell.
   */
  it('formats the timestamp exactly as the table does', () => {
    const cells = dataLines(buildCsv(columns, [damaged]))[0]?.split(
      CSV_DELIMITER,
    );

    expect(cells?.at(-1)).toBe(
      renderSchemalessRow(damaged.submittedAt)[SUBMITTED_AT_COLUMN],
    );
  });

  /** A column set without the timestamp leaves the row genuinely empty. */
  it('writes an all-empty line when the timestamp is not among the columns', () => {
    expect(
      dataLines(buildCsv([{ key: TEXT, label: 'Name' }], [damaged])),
    ).toStrictEqual(['']);
  });
});

/**
 * The functions that make „der Export folgt der sichtbaren Sicht“  a
 * property rather than a coincidence: the table and the server run *these*, not
 * two lookalikes on either side of the wire. The rule about *which* columns are
 * the default lives with the union it applies to (`form-history.test.ts`) —
 * `pickDefaultColumns` has to skip retired questions, and that is only
 * observable over a list that has some.
 */
describe('renderRow / rowMatchesSearch', () => {
  it('renders every question and the timestamp into one row', () => {
    const cells = renderRow(definition(), '2026-07-20T08:00:00.000Z', {
      [TEXT]: 'Anton',
      [NUMBER]: 4,
      [CHOICE]: { values: ['sa'], other: null },
      [DATE]: '2026-05-15',
    });

    expect(cells[TEXT]).toBe('Anton');
    expect(cells[CHOICE]).toBe('Samstag');
    expect(cells[DATE]).toBe('15.05.2026');
    expect(cells[SUBMITTED_AT_COLUMN]).toBe('20.07.2026 08:00');
  });

  /**
   * `renderSchemalessRow` is what a row falls back to when the snapshot it
   * names is missing (`toRow` in the web app). It has to be the *same* cell
   * `renderRow` would produce — key and format — or the fallback path drifts
   * silently, being the rare one nobody looks at.
   *
   * Asserted against `renderRow`'s own output rather than against a literal, so
   * changing the column key or the timestamp format in this module cannot make
   * the two disagree without this failing.
   */
  it('falls back to exactly the timestamp cell renderRow produces', () => {
    const iso = '2026-07-20T08:00:00.000Z';

    expect(renderSchemalessRow(iso)).toStrictEqual({
      [SUBMITTED_AT_COLUMN]: renderRow(definition(), iso, {})[
        SUBMITTED_AT_COLUMN
      ],
    });
    // And nothing else — an answer cell without a schema would be invented.
    expect(Object.keys(renderSchemalessRow(iso))).toHaveLength(1);
  });

  /**
   * The timestamp is part of the searched set. Leaving it out is what made the
   * server and the table disagree: a search for a date listed rows on screen
   * and produced a file containing nothing but a header.
   */
  it('searches the timestamp as well as the answers', () => {
    const cells = renderRow(definition(), '2026-07-20T08:00:00.000Z', {
      [TEXT]: 'Anton',
    });

    expect(rowMatchesSearch(cells, '20.07.2026')).toBe(true);
    expect(rowMatchesSearch(cells, 'anton')).toBe(true);
    expect(rowMatchesSearch(cells, 'Zeppelin')).toBe(false);
  });

  it('treats an empty search as "everything"', () => {
    expect(rowMatchesSearch({ a: 'x' }, '   ')).toBe(true);
  });
});

/**
 * The guard follows the **question**, not the shape of the value — decided
 * with the client on 2026-07-27 after an acceptance run.
 */
describe('the guard of a question’s column', () => {
  function question(id: string): Question {
    const found = allQuestions(definition()).find((entry) => entry.id === id);
    if (found === undefined) {
      throw new Error(`fixture has no question ${id}`);
    }
    return found;
  }

  const phone = question(PHONE);
  const number = question(NUMBER);
  const text = question(TEXT);

  it('treats every phone number alike, whichever way it is written', () => {
    // The inconsistency the client spotted: `+49…` was neutralised because it
    // starts with a formula prefix, `01603884482` was not because it does not.
    for (const value of ['+49 6421 123456', '01603884482', '0160 388 44 82']) {
      expect(escapeCsvCell(value, guardOf(phone))).toBe(`'${value}`);
    }
  });

  /**
   * The half that is data loss rather than cosmetics: without the guard Excel
   * reads a digit string as a number, and `01603884482` becomes 1603884482 —
   * the leading zero of every German mobile number, gone.
   */
  it('keeps the leading zero of a phone number', () => {
    expect(escapeCsvCell('01603884482', guardOf(phone))).toBe("'01603884482");
  });

  it('leaves an unanswered phone cell empty rather than a lone apostrophe', () => {
    // Through the whole chain, not from a hand-written empty string: what has
    // to hold is „unbeantwortet → leere Zelle → kein Apostroph".
    expect(escapeCsvCell(formatAnswerCell(phone, null), guardOf(phone))).toBe(
      '',
    );
  });

  /**
   * A Postleitzahl is a **text** question, so nothing above marks it — and
   * `01067` opens in Excel as 1067. Same damage as the phone case one question
   * type further along; covered deliberately (2026-07-27).
   */
  it('keeps a digit string that a spreadsheet would change', () => {
    expect(escapeCsvCell('01067', guardOf(text))).toBe("'01067");
    // Past 2^53 the value is rounded rather than shortened — also a change.
    expect(escapeCsvCell('12345678901234567', guardOf(text))).toBe(
      "'12345678901234567",
    );
  });

  /**
   * And no wider than that. A digit string that survives being read as a
   * number is left alone, because an apostrophe there would be noise on a
   * value nothing threatens.
   */
  it('leaves a digit string alone when nothing would change it', () => {
    expect(escapeCsvCell('35037', guardOf(text))).toBe('35037');
    expect(escapeCsvCell('0', guardOf(text))).toBe('0');
  });

  it('never prefixes a numeric answer, so sums still see the row', () => {
    expect(guardOf(number)).toBe('number');
    expect(escapeCsvCell('-5', guardOf(number))).toBe('-5');
  });

  it('leaves ordinary free text unprefixed', () => {
    // Forcing text everywhere would put an apostrophe in front of every name.
    expect(guardOf(text)).toBe('auto');
    expect(escapeCsvCell('Anton Aktiv', guardOf(text))).toBe('Anton Aktiv');
  });
});

/**
 * The export **through the whole chain**
 * (`questionColumns` → `buildCsv`), not only the guard in isolation: four
 * columns, `01067` surviving as text, and the row written under the file's
 * chosen column order rather than the order `questionColumns` happens to
 * return them in.
 */
describe('buildCsv over an Adresse', () => {
  const ADDRESS = '019ff000-0000-7000-8000-000000000006';

  function addressDefinition(): FormDefinition {
    return parseFormDefinition({
      pages: [
        {
          id: P,
          title: 'Anschrift',
          description: null,
          questions: [
            { ...base, id: ADDRESS, type: 'address', label: 'Anschrift' },
          ],
        },
      ],
    });
  }

  const address = allQuestions(addressDefinition())[0];
  if (address === undefined) {
    throw new Error('fixture has no address question');
  }
  const columns = questionColumns(address, NO_ANSWERS);

  const addressRow: CsvRow = {
    submittedAt: '2026-07-27T09:05:00.000Z',
    answers: {
      [ADDRESS]: {
        street: 'Musterstraße 12',
        zip: '01067',
        city: 'Dresden',
        country: 'Deutschland',
      },
    },
    definition: addressDefinition(),
  };

  /**
   * Four columns land in the file, one line for the one row. PLZ
   * carries its apostrophe here too — `guard: 'text'` prefixes it whatever it
   * contains, which is exactly what the next test is about.
   */
  it('writes one column per part, in the order questionColumns gives them', () => {
    const csv = buildCsv(columns, [addressRow]);

    expect(dataLines(csv)).toStrictEqual([
      ['Musterstraße 12', "'01067", 'Dresden', 'Deutschland'].join(
        CSV_DELIMITER,
      ),
    ]);
  });

  /**
   * Word for word: **`01067` survives as text.** The PLZ column
   * carries `guard: 'text'` (`answer-columns.ts`), which prefixes it with an
   * apostrophe the moment the cell is not empty — Excel then reads the
   * digits rather than the number, and the leading zero survives.
   */
  it('keeps the PLZ leading zero, the way a Postleitzahl-Textfrage does', () => {
    const zipColumn = columns.find((column) => column.label.endsWith('PLZ'));
    if (zipColumn === undefined) {
      throw new Error('fixture has no PLZ column');
    }
    expect(zipColumn.guard).toBe('text');

    const csv = buildCsv([zipColumn], [addressRow]);
    expect(dataLines(csv)).toStrictEqual(["'01067"]);
  });
});

/**
 * The reproduction what is required is by name: set the PLZ column's
 * guard to `'number'` in `questionColumns` (`answer-columns.ts`) and watch
 * this exact test go red.
 *
 * Not a permanent test of its own — `buildCsv` takes a column's guard from
 * `questionColumns` itself (`exportPlan` re-derives it by key, ignoring
 * whatever guard a caller's own column object carries), so the only honest
 * way to reproduce the break is to change the source and run the suite, not
 * to fake a "wrong" column here and hand it to `buildCsv` — that would test
 * nothing real, since `buildCsv` would not have looked at it anyway.
 *
 * **Measured (2026-07-31):** with the PLZ branch temporarily changed to
 * `part.key === 'zip' ? 'number' : 'auto'`, both tests above went red:
 *
 * ```
 * keeps the PLZ leading zero, the way a Postleitzahl-Textfrage does
 *   AssertionError: expected 'number' to be 'text' // Object.is equality
 *
 * writes one column per part, in the order questionColumns gives them
 *   - "Musterstraße 12;'01067;Dresden;Deutschland"   (expected)
 *   + "Musterstraße 12;01067;Dresden;Deutschland"    (received)
 * ```
 *
 * The apostrophe is what is gone from the **file**, not the digits — with
 * `guard: 'number'`, `escapeCsvCell` trusts `01067` as an already-numeric
 * literal (`NUMBER_LITERAL` matches it) and writes it through unprefixed,
 * exactly as it would `1067`. The bytes on disk still read `01067`; it is
 * the spreadsheet's own CSV import that then reads an *unquoted* digit
 * string as the number 1067 and drops the leading zero — the same
 * distinction `reinterpretedAsNumber`'s doc comment draws for `text`
 * questions, one guard away. `guard: 'text'` prevents that reading by
 * prefixing the cell (`'01067`) so no spreadsheet parses it as a number at
 * all. Reverted immediately after measuring; `answer-columns.ts` carries
 * `'text'` again, which is what every test in this file runs against.
 */

describe('buildCsv über Matrix und Tabelle', () => {
  const MATRIX = '019ff000-0000-7000-8000-000000000007';
  const TABLE = '019ff000-0000-7000-8000-000000000008';

  /**
   * The fixture that matters: **eine Matrix 3×4 und eine Tabelle 3
   * Spalten × 2 Zeilen**, in one form, so the expected column count of the
   * whole file is a number one can check by hand — 3 + 6 = 9.
   */
  function gridDefinition(): FormDefinition {
    return parseFormDefinition({
      pages: [
        {
          id: P,
          title: 'Rückmeldung',
          description: null,
          questions: [
            {
              ...base,
              id: MATRIX,
              type: 'matrix',
              label: 'Bewertung',
              rows: [
                { value: 'organisation', label: 'Organisation' },
                { value: 'programm', label: 'Programm' },
                { value: 'verpflegung', label: 'Verpflegung' },
              ],
              columns: [
                { value: 'sehr-gut', label: 'Sehr gut' },
                { value: 'gut', label: 'Gut' },
                { value: 'neutral', label: 'Neutral' },
                { value: 'schlecht', label: 'Schlecht' },
              ],
              multiple: false,
            },
            {
              ...base,
              id: TABLE,
              type: 'table',
              label: 'Begleitpersonen',
              columns: [
                { key: 'name', label: 'Name', type: 'text' },
                { key: 'anzahl', label: 'Anzahl', type: 'number' },
                { key: 'vegetarisch', label: 'Vegetarisch', type: 'checkbox' },
              ],
              rows: 2,
            },
          ],
        },
      ],
    });
  }

  const questions = allQuestions(gridDefinition());
  const columns = questions.flatMap((question) =>
    questionColumns(question, NO_ANSWERS),
  );

  const gridRow: CsvRow = {
    submittedAt: '2026-07-27T09:05:00.000Z',
    answers: {
      [MATRIX]: {
        rows: {
          organisation: ['sehr-gut'],
          programm: ['gut'],
          verpflegung: ['neutral'],
        },
      },
      [TABLE]: {
        cells: [
          // The formula the reproduction asks for, typed into a free-text
          // cell by a participant — the same attack as anywhere else, one
          // nesting level deeper than the export used to look.
          { name: '=1+1', anzahl: 2, vegetarisch: true },
          { name: 'Bert' },
        ],
      },
    },
    definition: gridDefinition(),
  };

  /**
   * **Three columns for the Matrix,
   * six for the Tabelle**, nine in the file. A folded rendering would give
   * two, and „eine Spalte je Matrixzelle" would give twelve.
   */
  it('writes three columns for a 3×4 Matrix and six for a 3×2 Tabelle', () => {
    expect(columns).toHaveLength(9);

    const csv = buildCsv(columns, [gridRow]);
    const [header] = csv.slice(CSV_BOM.length).split('\r\n');

    expect(header?.split(CSV_DELIMITER)).toStrictEqual([
      'Bewertung — Organisation',
      'Bewertung — Programm',
      'Bewertung — Verpflegung',
      'Begleitpersonen — Name (Zeile 1)',
      'Begleitpersonen — Name (Zeile 2)',
      'Begleitpersonen — Anzahl (Zeile 1)',
      'Begleitpersonen — Anzahl (Zeile 2)',
      'Begleitpersonen — Vegetarisch (Zeile 1)',
      'Begleitpersonen — Vegetarisch (Zeile 2)',
    ]);
  });

  /**
   * The values, cell by cell — and a formula neutralised in the
   * same line: `=1+1` arrives **neutralised** (`'=1+1`), because the Text
   * column's own guard is applied to it.
   */
  it('fills every cell from its own row and column, and neutralises a formula', () => {
    expect(dataLines(buildCsv(columns, [gridRow]))).toStrictEqual([
      ['Sehr gut', 'Gut', 'Neutral', "'=1+1", 'Bert', '2', '', 'Ja', ''].join(
        CSV_DELIMITER,
      ),
    ]);
  });

  /**
   * „Jede Zelle trägt den Schutz **ihrer** Spalte" — measured on the plan the
   * export actually reads, and the assertion is that the guards **differ
   * within one question**: a per-question guard would have to pick one of the
   * two and lose the other.
   */
  it('gives each Tabellenzelle the guard of its column', () => {
    const table = questions.find((question) => question.id === TABLE);
    if (table === undefined) {
      throw new Error('fixture has no table question');
    }

    expect(
      questionColumns(table, NO_ANSWERS).map((column) => column.guard),
    ).toStrictEqual(['auto', 'auto', 'number', 'number', 'auto', 'auto']);
  });
});

/**
 * The reproduction for, and **what it does and does not
 * prove** — measured on 2026-07-31 rather than assumed.
 *
 * *„Eine Tabellenzelle mit `=1+1` befüllen und exportieren → die Zelle ist
 * geschützt; ohne Schutz wird der Test rot."* The first half is asserted above
 * and is real: `'=1+1` reaches the file. The second half needed measuring,
 * because „ohne Schutz" has to be *made* to happen, and the obvious way does
 * not do it:
 *
 * - **Changing the Text column's guard to `'number'`** (in
 *   `tableColumnGuard`, `answer-columns.ts`) leaves the test **green**. That
 *   is not a hole: `guardValue` only trusts a `'number'` cell when it *looks*
 *   like a number literal (`NUMBER_LITERAL`), and `=1+1` does not — it falls
 *   through to the formula-prefix check and is neutralised anyway. A formula
 *   is protected under every one of the three guards, which is worth knowing:
 *   the guard is not what protects against `=`, `escapeCsvCell` is.
 * - **What the guard does decide** is the case the Adresse already
 *   documents, and it goes red on demand. With `tableColumnGuard` returning
 *   `'number'` for the Text column and the cell holding `01067`, the file
 *   comes back:
 *
 *   ```
 *   fills every cell from its own row and column …
 *     - "…;'01067;…"   (expected, guard 'auto' → reinterpretedAsNumber → prefixed)
 *     + "…;01067;…"    (received, guard 'number' → NUMBER_LITERAL → written through)
 *   ```
 *
 *   That is the same distinction measured one type earlier: the bytes
 *   are the digits either way, and what the guard changes is whether a
 *   spreadsheet is allowed to read them as a number.
 * - **What makes the `=1+1` case itself red** is losing the per-cell column,
 *   not the guard. With the table folded into one column (`wholeAnswer`),
 *   all three tests above went red and the file came back:
 *
 *   ```
 *   + "Sehr gut;Gut;Neutral;\"Name: =1+1, Anzahl: 2, Vegetarisch: Ja; Name: Bert\""
 *   ```
 *
 *   — four columns instead of nine, and the formula no longer at the start of
 *   its cell, so nothing prefixes it. It is not an *attack* any more either;
 *   it is simply unevaluable, which is the failure the requirement is about.
 *
 * All three were run, in that order, and the source restored immediately
 * after each.
 */
