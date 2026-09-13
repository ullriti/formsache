import { describe, expect, it } from 'vitest';

import {
  ADDRESS_PARTS,
  COLUMN_KEY_SEPARATOR,
  COLUMN_LABEL_SEPARATOR,
  formatAnswerCell,
  questionColumns,
  type CellGuard,
  type QuestionColumn,
} from './answer-columns.ts';
import { buildCsv, escapeCsvCell, type CsvRow } from './csv.ts';
import { NO_ANSWERS } from './form-history.ts';
import {
  allQuestions,
  parseFormDefinition,
  questionTypeSchema,
  TABLE_ROWS_MAX,
  type Question,
  type QuestionType,
} from './form-schema.ts';
import { sampleAnswers } from './sample-answers.ts';
import type { AnswerMap } from './response-validation.ts';

/**
 * The seam at rest: **every question type that exists today produces exactly
 * one column**, keyed and labelled the way the export has always keyed and
 * labelled it.
 *
 * That is the other half of the byte-identity promise. `export-golden.test.ts`
 * measures the files; this measures the rule they come from, per type, so a
 * change that only shows up for a type the golden fixture happens not to
 * exercise still fails here.
 *
 * `NO_ANSWERS` — the empty second source the plan now takes — is imported rather than
 * declared here, so „keine Antworten" is the same value the production path
 * passes down. It is spelled out at all thirty call sites rather than defaulted
 * away: everything above `describe('questionColumns — die zweite Quelle
 * ')` measures the plan of the form alone, which is what it measured
 * before the parameter existed.
 */

const P = '019ff000-0000-7000-8000-0000000000c0';
const base = { hint: null, required: false, width: 'full' } as const;

/**
 * One question of every type, and the guard its single column carries.
 *
 * `satisfies Record<QuestionType, …>` on purpose: an eighth type is a compile
 * error here as well as in `questionColumns`, so the type cannot arrive with
 * its columns unmeasured. That is the same mechanism the exhaustive switch
 * uses, applied to the test — a switch nobody exercises proves only that it
 * compiles.
 */
const SAMPLES = {
  text: {
    question: {
      ...base,
      type: 'text',
      label: 'Name',
      minLength: null,
      maxLength: null,
      pattern: null,
    },
    guard: 'auto',
  },
  textarea: {
    question: {
      ...base,
      type: 'textarea',
      label: 'Bemerkung',
      minLength: null,
      maxLength: null,
      rows: 4,
    },
    guard: 'auto',
  },
  number: {
    question: {
      ...base,
      type: 'number',
      label: 'Semester',
      min: null,
      max: null,
      integer: false,
    },
    guard: 'number',
  },
  date: {
    question: {
      ...base,
      type: 'date',
      label: 'Stichtag',
      minDate: null,
      maxDate: null,
    },
    // By now its own guard: in the CSV not to be told apart from the `'auto'`
    // next to it, in Excel a date cell — and thereby the second half of the
    // requirement.
    guard: 'date',
  },
  email: {
    question: { ...base, type: 'email', label: 'E-Mail' },
    guard: 'auto',
  },
  phone: {
    question: { ...base, type: 'phone', label: 'Telefon' },
    guard: 'text',
  },
  select: {
    question: {
      ...base,
      type: 'select',
      label: 'Organisation',
      options: [{ value: 'a', label: 'Nord' }],
      allowOther: false,
      otherLabel: null,
    },
    guard: 'auto',
  },
  radio: {
    question: {
      ...base,
      type: 'radio',
      label: 'Verpflegung',
      options: [{ value: 'v', label: 'Vegetarisch' }],
      allowOther: false,
      otherLabel: null,
    },
    guard: 'auto',
  },
  checkbox: {
    question: {
      ...base,
      type: 'checkbox',
      label: 'Tage',
      options: [{ value: 'fr', label: 'Freitag' }],
      allowOther: false,
      otherLabel: null,
      minSelected: null,
      maxSelected: null,
    },
    guard: 'auto',
  },
  rating: {
    question: {
      ...base,
      type: 'rating',
      label: 'Zufriedenheit',
      max: 5,
    },
    // The star count is a number, guarded as
    // such so Excel sorts it numerically instead of as text.
    guard: 'number',
  },
  info: {
    question: {
      ...base,
      type: 'info',
      label: 'Bitte vollständig ausfüllen.',
    },
    // No column exists to guard — `null` rather than one of
    // `CellGuard`'s three values, so the two tests below that assume "exactly
    // one column" can tell `info` apart and skip it instead of asserting a
    // guard nothing produces.
    guard: null,
  },
  address: {
    question: {
      ...base,
      type: 'address',
      label: 'Anschrift',
    },
    // `null` for the opposite reason `info`'s is: not "no column", but "no
    // single one to name a guard for" — four columns, each with its own guard
    // (`describe('questionColumns — Adresse ')` below). Excluded from
    // `SINGLE_COLUMN_TYPES` the same way `info` is.
    guard: null,
  },
  matrix: {
    question: {
      ...base,
      type: 'matrix',
      label: 'Bewerte folgende Punkte',
      rows: [
        { value: 'organisation', label: 'Organisation' },
        { value: 'programm', label: 'Programm' },
      ],
      columns: [
        { value: 'sehr-gut', label: 'Sehr gut' },
        { value: 'gut', label: 'Gut' },
      ],
      multiple: false,
    },
    // One column **per row** , so there is no single guard to name —
    // the same `null` `address` carries, for the same reason.
    guard: null,
  },
  table: {
    question: {
      ...base,
      type: 'table',
      label: 'Begleitpersonen',
      columns: [
        { key: 'name', label: 'Name', type: 'text' },
        { key: 'anzahl', label: 'Anzahl', type: 'number' },
      ],
      rows: 2,
    },
    // One column **per cell**  — and the guards differ *within* the
    // question (`'auto'` for Text, `'number'` for Zahl), which is exactly what
    // a single guard could not express.
    guard: null,
  },
  file: {
    question: { ...base, type: 'file', label: 'Nachweis', maxFiles: 2 },
    // One column, holding the **file names** (ADR-0014 no. 17) — free text a
    // stranger chose, guarded exactly like every other free-text column. The
    // proof that this is not decoration is „neutralises a file name
    // that begins like a formula", further down in this file — it writes the
    // CSV and reads the bytes back.
    guard: 'auto',
  },
  event: {
    question: {
      ...base,
      type: 'event',
      label: 'Veranstaltungen',
      events: [
        {
          key: 'sommerfest',
          label: 'Sommerfest',
          when: 'Fr, 19:00',
          capacity: 120,
          showRemaining: true,
        },
        {
          key: 'stadtfest',
          label: 'Stadtfest',
          when: null,
          capacity: null,
          showRemaining: false,
        },
      ],
    },
    // One column **per Veranstaltung** , so there is no single guard to
    // name here — the same `null` `matrix` carries, for the same reason. Each of
    // them is `'number'`, which is asserted where the columns themselves are.
    guard: null,
  },
} satisfies Record<
  QuestionType,
  { question: Record<string, unknown>; guard: CellGuard | null }
>;

/** Parsed rather than cast: the fixture has to be a document the schema accepts. */
function questionOf(type: QuestionType): Question {
  // Hex, not decimal: past the ninth type (`info` is the eleventh)
  // `String(index)` produces two digits and the id stops being 36 characters
  // long — `parseFormDefinition` then rejects it as "Invalid UUID" on a type
  // that has nothing wrong with it. `toString(16)` keeps one digit through
  // every type this schema can hold up to hex `f` (16 types).
  const id = `019ff000-0000-7000-8000-0000000000d${questionTypeSchema.options
    .indexOf(type)
    .toString(16)}`;
  const definition = parseFormDefinition({
    pages: [
      {
        id: P,
        title: 'Seite 1',
        description: null,
        questions: [{ ...SAMPLES[type].question, id }],
      },
    ],
  });
  const [question] = allQuestions(definition);
  if (question === undefined) {
    throw new Error(`fixture has no question for ${type}`);
  }
  return question;
}

/**
 * Every type whose column count is „exactly one".
 *
 * Five are not: `info` (none), `address` (four), `matrix` (one per row),
 * `table` (one per cell) and `event` (one per Veranstaltung) — each with
 * its own `describe` below or, for `event`, in `event-question.test.ts`. Written as an
 * exclusion list rather than an inclusion one on purpose: a type added to the
 * schema lands **here**, in the group that asserts a single column keyed by
 * the question id, and a multi-column type that forgets to exclude itself is
 * caught by that assertion rather than by nothing.
 */
const SINGLE_COLUMN_TYPES = questionTypeSchema.options.filter(
  (type) =>
    type !== 'info' &&
    type !== 'address' &&
    type !== 'matrix' &&
    type !== 'table' &&
    type !== 'event',
);

/** The one question of a parsed document — a fixture the schema accepts. */
function questionFrom(shape: Record<string, unknown>): Question {
  const definition = parseFormDefinition({
    pages: [{ id: P, title: 'Seite 1', description: null, questions: [shape] }],
  });
  const [question] = allQuestions(definition);
  if (question === undefined) {
    throw new Error('fixture has no question');
  }
  return question;
}

/** A Matrix of `rows` Aussagen × `columns` Skalenstufen. */
function matrixOf(rows: number, columns: number, multiple = false): Question {
  return questionFrom({
    ...base,
    id: '019ff000-0000-7000-8000-0000000000e1',
    type: 'matrix',
    label: 'Bewertung',
    rows: Array.from({ length: rows }, (_, index) => ({
      value: `zeile-${String(index + 1)}`,
      label: `Aussage ${String(index + 1)}`,
    })),
    columns: Array.from({ length: columns }, (_, index) => ({
      value: `stufe-${String(index + 1)}`,
      label: `Stufe ${String(index + 1)}`,
    })),
    multiple,
  });
}

/**
 * A table of three columns — Text, Zahl, Haken — over `rows` rows.
 *
 * Three *different* cell types on purpose: the guards then differ within the
 * one question, which is the property „jede Zelle trägt den Schutz ihrer
 * Spalte" is about.
 */
function tableOf(rows: number): Question {
  return questionFrom({
    ...base,
    id: '019ff000-0000-7000-8000-0000000000e2',
    type: 'table',
    label: 'Begleitpersonen',
    columns: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'anzahl', label: 'Anzahl', type: 'number' },
      { key: 'vegetarisch', label: 'Vegetarisch', type: 'checkbox' },
    ],
    rows,
  });
}

describe('questionColumns', () => {
  it.each(SINGLE_COLUMN_TYPES)(
    'gives a %s question exactly one column, keyed by the question id',
    (type) => {
      const question = questionOf(type);
      const columns = questionColumns(question, NO_ANSWERS);

      expect(columns).toHaveLength(1);
      expect(columns[0]?.key).toBe(question.id);
      // No part suffix: the header of a single-column question is its label,
      // which is what every file written so far contains.
      expect(columns[0]?.label).toBe(question.label);
    },
  );

  it.each(SINGLE_COLUMN_TYPES)('guards a %s column as decided', (type) => {
    expect(questionColumns(questionOf(type), NO_ANSWERS)[0]?.guard).toBe(
      SAMPLES[type].guard,
    );
  });

  /**
   * The empty case A0b built its two downstream locks for:
   * an `info` is a callout, not a question, and contributes **no** column at
   * all — not one with an empty render, none. `questionOf('info')` still runs
   * the fixture through `parseFormDefinition`, which is the point: this is a
   * document the schema actually accepts, not a hand-built `Question` value
   * that happens to compile.
   */
  it('gives an info question no column at all', () => {
    expect(questionColumns(questionOf('info'), NO_ANSWERS)).toEqual([]);
  });

  /**
   * **Four columns**, keyed and labelled by
   * part, PLZ guarded as text so `01067` cannot be reinterpreted as a number.
   */
  describe('Adresse ', () => {
    it('gives an address question exactly four columns, one per part', () => {
      const columns = questionColumns(questionOf('address'), NO_ANSWERS);

      expect(columns).toHaveLength(4);
      expect(columns.map((column) => column.key)).toStrictEqual(
        ADDRESS_PARTS.map(
          (part) =>
            `${questionOf('address').id}${COLUMN_KEY_SEPARATOR}${part.key}`,
        ),
      );
      expect(columns.map((column) => column.label)).toStrictEqual([
        `Anschrift${COLUMN_LABEL_SEPARATOR}Straße & Hausnummer`,
        `Anschrift${COLUMN_LABEL_SEPARATOR}PLZ`,
        `Anschrift${COLUMN_LABEL_SEPARATOR}Ort`,
        `Anschrift${COLUMN_LABEL_SEPARATOR}Land`,
      ]);
    });

    /**
     * The one guard that differs — and it is called out explicitly: the PLZ
     * column is `'text'`, not `'auto'`, because unlike a phone number a
     * five-digit Postleitzahl has no formula character to fall back on for
     * `escapeCsvCell`'s digit-string round trip (`csv.test.ts` proves the
     * consequence — `01067` surviving the export).
     */
    it('guards every part — PLZ as text, the rest free text', () => {
      const guards = questionColumns(questionOf('address'), NO_ANSWERS).map(
        (column) => column.guard,
      );

      expect(guards).toStrictEqual(['auto', 'text', 'auto', 'auto']);
    });

    it('renders the part of the answer each column belongs to, and nothing for a foreign shape', () => {
      const address = questionOf('address');
      const [street, zip, city, country] = questionColumns(address, NO_ANSWERS);
      const answer = {
        street: 'Musterstraße 12',
        zip: '01067',
        city: 'Dresden',
        country: 'Deutschland',
      };

      expect(street?.render(answer)).toBe('Musterstraße 12');
      expect(zip?.render(answer)).toBe('01067');
      expect(city?.render(answer)).toBe('Dresden');
      expect(country?.render(answer)).toBe('Deutschland');

      // A choice answer is also a plain object, but shares no key with an
      // address answer — every part column reads it as unanswered rather
      // than reaching into a shape it does not recognise.
      const foreign = { values: ['a'], other: null };
      expect(street?.render(foreign)).toBe('');
    });
  });

  /**
   * **A 3×4 matrix and a table of 3 columns × 2 rows produce the expected
   * number of columns** — three and six.
   *
   * The numbers are the assertion, not decoration: 3×4 is the case where the
   * two plausible wrong answers are visibly wrong (one folded column, or
   * twelve — one per cell of the grid), and 3×2 is the case where „eine Spalte
   * je Zelle" and „eine je Spalte" differ.
   */
  describe('Matrix und Tabelle ', () => {
    it('gives a 3×4 matrix three columns — one per Zeile, not per cell', () => {
      const matrix = matrixOf(3, 4);
      const columns = questionColumns(matrix, NO_ANSWERS);

      expect(columns).toHaveLength(3);
      expect(columns.map((column) => column.key)).toStrictEqual([
        `${matrix.id}${COLUMN_KEY_SEPARATOR}zeile-1`,
        `${matrix.id}${COLUMN_KEY_SEPARATOR}zeile-2`,
        `${matrix.id}${COLUMN_KEY_SEPARATOR}zeile-3`,
      ]);
      // The statement is the header — that is what makes the file evaluable.
      expect(columns.map((column) => column.label)).toStrictEqual([
        `Bewertung${COLUMN_LABEL_SEPARATOR}Aussage 1`,
        `Bewertung${COLUMN_LABEL_SEPARATOR}Aussage 2`,
        `Bewertung${COLUMN_LABEL_SEPARATOR}Aussage 3`,
      ]);
    });

    it('puts the picked scale step in the row it belongs to, as its label', () => {
      const columns = questionColumns(matrixOf(3, 4), NO_ANSWERS);
      const answer = { rows: { 'zeile-2': ['stufe-3'] } };

      expect(columns[0]?.render(answer)).toBe('');
      expect(columns[1]?.render(answer)).toBe('Stufe 3');
      expect(columns[2]?.render(answer)).toBe('');
    });

    it('joins several picks of one row when Mehrfachauswahl is on', () => {
      const columns = questionColumns(matrixOf(3, 4, true), NO_ANSWERS);

      expect(
        columns[0]?.render({ rows: { 'zeile-1': ['stufe-1', 'stufe-4'] } }),
      ).toBe('Stufe 1, Stufe 4');
    });

    it('gives a 3-column, 2-row table six columns — one per Zelle', () => {
      const table = tableOf(2);
      const columns = questionColumns(table, NO_ANSWERS);

      expect(columns).toHaveLength(6);
      // Column by column, row within column: the file reads „Name (Zeile 1),
      // Name (Zeile 2), Anzahl (Zeile 1) …", which keeps one participant's
      // answers to one question next to each other.
      expect(columns.map((column) => column.label)).toStrictEqual([
        `Begleitpersonen${COLUMN_LABEL_SEPARATOR}Name (Zeile 1)`,
        `Begleitpersonen${COLUMN_LABEL_SEPARATOR}Name (Zeile 2)`,
        `Begleitpersonen${COLUMN_LABEL_SEPARATOR}Anzahl (Zeile 1)`,
        `Begleitpersonen${COLUMN_LABEL_SEPARATOR}Anzahl (Zeile 2)`,
        `Begleitpersonen${COLUMN_LABEL_SEPARATOR}Vegetarisch (Zeile 1)`,
        `Begleitpersonen${COLUMN_LABEL_SEPARATOR}Vegetarisch (Zeile 2)`,
      ]);
      expect(columns.every((column) => column.key.startsWith(table.id))).toBe(
        true,
      );
    });

    /**
     * The half of the rule that says „jede Zelle trägt den Schutz **ihrer**
     * Spalte": the guards differ *within* one question, which is exactly what
     * a per-question guard could not express.
     */
    it('guards each cell by its own column type', () => {
      expect(
        questionColumns(tableOf(2), NO_ANSWERS).map((column) => column.guard),
      ).toStrictEqual(['auto', 'auto', 'number', 'number', 'auto', 'auto']);
    });

    it('renders each cell from its own row and column', () => {
      const columns = questionColumns(tableOf(2), NO_ANSWERS);
      const answer = {
        cells: [
          { name: 'Anna', anzahl: 2, vegetarisch: true },
          { name: 'Bert' },
        ],
      };

      expect(columns.map((column) => column.render(answer))).toStrictEqual([
        'Anna',
        'Bert',
        // German decimal comma, the rule every other number in the file follows.
        '2',
        '',
        // A ticked Haken reads „Ja"; an absent one is an empty cell rather
        // than „Nein", which would claim something nobody said.
        'Ja',
        '',
      ]);
    });

    it('reads a foreign answer shape as unanswered rather than reaching into it', () => {
      const foreign = { values: ['a'], other: null };

      expect(
        questionColumns(matrixOf(3, 4), NO_ANSWERS)[0]?.render(foreign),
      ).toBe('');
      expect(questionColumns(tableOf(2), NO_ANSWERS)[0]?.render(foreign)).toBe(
        '',
      );
    });
  });

  /**
   * ADR-0014 no. 17: **one column, the file names, and
   * nothing else** — no address, no reference, no identifier.
   *
   * The negative half is the assertion that matters, so it is spelled as one:
   * the reference of the stored file must not appear in the cell in any form.
   * An export is the document that gets mailed on and left on network drives,
   * and an opaque string a known prefix turns into an address is a URL with a
   * piece missing rather than a compromise between „URL" and „nichts".
   */
  describe('Datei-Upload ', () => {
    const answer = {
      files: [
        { ref: 'AbCdEfGhIjKlMnOpQrStUv', name: 'Nachweis.pdf' },
        { ref: 'ZyXwVuTsRqPoNmLkJiHgFe', name: 'Vollmacht.pdf' },
      ],
    };

    it('renders the names, joined — and never the reference', () => {
      const cell = questionColumns(questionOf('file'), NO_ANSWERS)[0]?.render(
        answer,
      );

      expect(cell).toBe('Nachweis.pdf, Vollmacht.pdf');
      expect(cell).not.toContain('AbCdEfGhIjKlMnOpQrStUv');
      expect(cell).not.toContain('/api/');
    });

    it('reads an answer of the wrong shape as unanswered', () => {
      const column = questionColumns(questionOf('file'), NO_ANSWERS)[0];

      // A choice answer is a plain object too; only the disjoint keys keep the
      // two apart. And `{files: 5}` is what a hand-built request body carries —
      // it must read as nothing rather than throw inside the export.
      expect(column?.render({ values: ['a'], other: null })).toBe('');
      expect(column?.render({ files: 5 } as never)).toBe('');
      expect(column?.render({ files: [{ ref: 5 }] } as never)).toBe('');
    });

    /**
     * **The rule this actually enforces**, and it is measured on a written file
     * rather than on the column definition: „die Zelle im Export trägt den
     * Schutz ihrer Spalte aus `questionColumns` (ein Dateiname, der mit `=`
     * beginnt, ist eine Formel)".
     *
     * `=cmd|'…'!A1.xlsx` is a legal file name on every system a participant
     * uploads from, and „ist ja nur ein Dateiname" is exactly how a column
     * inherits „ungeschützt".
     *
     * **Two names, because one of them alone would not measure the guard.**
     * The formula prefix is caught under *every* guard — that is a property of
     * `guardValue`, so swapping this branch's guard to `'number'` leaves the
     * first assertion green. The self-assessment written here first said that
     * made a reproduction impossible; a later review showed it does not.
     * `01067` is a legal file name (`fileNameSchema` takes it) and it is where
     * the guards differ: `'auto'` writes `'01067` and the leading zero
     * survives, `'number'` writes `01067` and Excel reads 1067. Both halves of
     * the promise are therefore measured on the **written bytes** — that the
     * name reaches the file neutralised, and that it carries *this* column's
     * guard rather than any guard at all.
     */
    it('neutralises a file name that begins like a formula', () => {
      const question = questionOf('file');
      const definition = parseFormDefinition({
        pages: [
          {
            id: P,
            title: 'Seite 1',
            description: null,
            questions: [{ ...SAMPLES.file.question, id: question.id }],
          },
        ],
      });
      const columns = questionColumns(question, NO_ANSWERS).map((column) => ({
        key: column.key,
        label: column.label,
      }));

      const rowWith = (
        name: string,
      ): Parameters<typeof buildCsv>[1][number] => ({
        submittedAt: '2026-07-27T09:05:00.000Z',
        answers: {
          [question.id]: { files: [{ ref: 'AbCdEfGhIjKlMnOpQrStUv', name }] },
        },
        definition,
      });

      const csv = buildCsv(columns, [
        rowWith("=cmd|'/c calc'!A1"),
        rowWith('01067'),
      ]);
      const [, formula = '', postcode = ''] = csv.split('\r\n');

      expect(formula).toContain("'=cmd|");
      expect(formula.startsWith('=')).toBe(false);

      // The half that is sensitive to *this* column's guard: under `'number'`
      // the apostrophe is gone and the leading zero with it.
      expect(postcode).toContain("'01067");
    });
  });

  /**
   * The pairing that makes the seam safe: a column cannot exist without saying
   * what goes in it. Two functions — one for the headers, one for the values —
   * would be two descriptions of the same thing, and the failure mode when they
   * drift is a value under the wrong header, silently.
   */
  it('carries the rendering of its cell with every column', () => {
    for (const type of questionTypeSchema.options) {
      for (const column of questionColumns(questionOf(type), NO_ANSWERS)) {
        expect(typeof column.render).toBe('function');
        expect(column.render(undefined)).toBe('');
      }
    }
  });
});

/**
 * There is **no `cellGuardFor`** any more, and its absence is the point (a review
 * finding): the guard is decided in exactly one place, by the same object that
 * renders the cell, and `buildCsv` reads it from there. A second function that
 * looked the guard up again would be a thing tests could exercise while the file
 * took a different route — which is what it had become.
 */
/**
 * **What a `render` may assume about the value it gets: nothing**
 * (a review finding, measured on 2026-07-31).
 *
 * The three `is…Answer` guards check **one key**, never what stands beneath it
 * — that is written at every one of them. An address with `zip: 5` therefore
 * came out of `render` as a number, ran into `escapeCsvCell` → `guardValue` →
 * `value.startsWith(…)` and threw a `TypeError` no `try` catches: **one**
 * damaged row tore the **whole** export down with it. That is exactly what
 * `formatAnswerCell` argues against two screens further up, for the value it
 * cannot render.
 *
 * **All three** new types are checked, not only the reported one, and each of
 * them both ways: the split column (`render`) and the folded cell
 * (`formatAnswerCell`), because they are two separate code paths.
 */
describe('a value this application did not write', () => {
  /** Both ways one cell can be produced, for the same question and value. */
  function cellsOf(question: Question, value: unknown): string[] {
    return [
      ...questionColumns(question, NO_ANSWERS).map((column) =>
        column.render(value as never),
      ),
      formatAnswerCell(question, value as never),
    ];
  }

  it.each([
    ['eine Adresse mit einer Zahl in der PLZ', { zip: 5, street: 'A-Weg 1' }],
    ['eine Adresse ohne Teilfelder', { street: null }],
  ])('renders %s without throwing', (_name, broken) => {
    const question = questionOf('address');

    expect(() => cellsOf(question, broken)).not.toThrow();
    // The postcode column is the damaged one: empty instead of „5", because a
    // number is not a postcode, and an invented value would be worse than
    // nothing.
    const columns = questionColumns(question, NO_ANSWERS);
    const zip = columns.find((column) => column.key.endsWith('#zip'));
    expect(zip?.render(broken as never)).toBe('');
  });

  it.each([
    ['eine Matrix, deren Zeilen kein Objekt sind', { rows: 'zeile-1' }],
    [
      'eine Matrix-Zeile, die kein Array ist',
      { rows: { 'zeile-1': 'stufe-1' } },
    ],
    [
      'eine Matrix-Zeile mit einem Eintrag, der kein String ist',
      { rows: { 'zeile-1': [5] } },
    ],
  ])('renders %s as blank instead of throwing', (_name, broken) => {
    const question = matrixOf(2, 2);

    expect(() => cellsOf(question, broken)).not.toThrow();
    expect(cellsOf(question, broken)).toStrictEqual(['', '', '']);
  });

  it.each([
    ['eine Tabelle, deren Zellen kein Array sind', { cells: 'x' }],
    ['eine Tabellenzeile, die kein Objekt ist', { cells: [null] }],
    [
      'eine Tabellenzelle, die ein Objekt ist',
      { cells: [{ name: { tief: true } }] },
    ],
  ])('renders %s as blank instead of throwing', (_name, broken) => {
    const question = tableOf(1);

    expect(() => cellsOf(question, broken)).not.toThrow();
    expect(cellsOf(question, broken)).toStrictEqual(['', '', '', '']);
  });

  /**
   * What this is actually about: **one** broken row costs its own cells, not
   * the file. The healthy row before it and the one after it stand in there
   * completely, and the row count is right — the same promise `buildCsv` gives
   * for a row without a schema.
   */
  it('lets the whole export survive one damaged row', () => {
    const question = questionOf('address');
    const definition = parseFormDefinition({
      pages: [
        {
          id: P,
          title: 'Seite 1',
          description: null,
          questions: [{ ...SAMPLES.address.question, id: question.id }],
        },
      ],
    });
    const columns = questionColumns(question, NO_ANSWERS).map((column) => ({
      key: column.key,
      label: column.label,
    }));
    const rowOf = (answer: unknown): CsvRow => ({
      submittedAt: '2026-07-27T09:05:00.000Z',
      answers: { [question.id]: answer as never },
      definition,
    });

    const csv = buildCsv(columns, [
      rowOf({
        street: 'Hauptstraße 1',
        zip: '01067',
        city: 'Dresden',
        country: 'Deutschland',
      }),
      // Two damaged part fields, and both count — they fail differently: the
      // postcode is a `'text'` column, where a number silently *falsifies* the
      // value; the street an `'auto'` column, and there it is `guardValue`'s
      // `startsWith` that takes the **whole** file down with a `TypeError`.
      rowOf({
        street: { strasse: 'Nebenweg 2' },
        zip: 1067,
        city: 'Dresden',
        country: 'Deutschland',
      }),
      rowOf({
        street: 'Ringstraße 3',
        zip: '01069',
        city: 'Dresden',
        country: 'Deutschland',
      }),
    ]);

    const all = csv
      .replace(/^\ufeff/u, '')
      .split('\r\n')
      .slice(1);
    const lines = all.at(-1) === '' ? all.slice(0, -1) : all;
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('Hauptstraße 1');
    expect(lines[2]).toContain('Ringstraße 3');
    // The damaged row stays one row — the readable part fields stand in it,
    // the unreadable ones are empty instead of invented or falsified.
    expect(lines[1]).toContain('Dresden');
    expect(lines[1]).not.toContain('1067');
    expect(lines[1]).not.toContain('Nebenweg');
  });
});

describe('the guard a column carries', () => {
  it('is the one the export applies, taken from the column itself', () => {
    const phone = questionOf('phone');
    const [column] = questionColumns(phone, NO_ANSWERS);

    expect(column?.key).toBe(phone.id);
    expect(column?.guard).toBe('text');
  });
});

/**
 * **The second source of the column plan: the answers.**
 *
 * Two tests that do opposite jobs, by design:
 *
 * - the **counter-check** below asserts that a type produces the *same* plan with
 *   and without answers, and it runs over **all sixteen** — `table` included,
 *   which passes it too because its sample answer is one cell row against a
 *   fixture form that offers two (`max(2, 1)` is the form's own count). So it
 *   proves nothing about `table` and is not meant to: it guards that the change
 *   knocked nothing else over, which is the whole reason this
 *   comes before Excel, HTML and „+ Zeile";
 * - the growing table proves it, and is the only place where the two plans
 *   are allowed to differ.
 *
 * The answers of the counter-check come from {@link sampleAnswers} rather than
 * from a stub: they are real values that the validator of that very question
 * accepts, so a type that started reading the set would be handed something it
 * could plausibly act on. A stub of `null`s would let a type consult the
 * answers, find nothing, and stay green.
 *
 * **Reproductions run on 2026-08-06**, both of them from the requirement:
 *
 * - taking the length from the **first** answer instead of from the maximum →
 *   „gives the longest answer a block", „leaves a shorter answer empty" and
 *   „is the same plan whichever way" red (and the cost measurement with them);
 * - building the plan from the **form alone** → four cases of the growing
 *   table red, the counter-check **green** — exactly the division of labour, as
 *   intended: the counter-check does not prove the change, it guards the rest.
 */
describe('questionColumns — die zweite Quelle ', () => {
  /** The one question and one valid sample answer to it. */
  function withSampleAnswer(type: QuestionType): {
    question: Question;
    answers: AnswerMap;
  } {
    const question = questionOf(type);
    // A parsed question is itself a document the schema accepts, so the sample
    // generator gets the same shape the fill-in view would be given.
    const definition = parseFormDefinition({
      pages: [
        { id: P, title: 'Seite 1', description: null, questions: [question] },
      ],
    });
    return { question, answers: sampleAnswers(definition).answers };
  }

  /** A plan reduced to what can be compared — `render` is a closure. */
  function shapeOf(
    question: Question,
    answers: AnswerMap,
    plan: readonly QuestionColumn[],
  ): unknown[] {
    return plan.map((column) => ({
      key: column.key,
      label: column.label,
      guard: column.guard,
      // The rendered cell as well as the header: two plans that agree on every
      // key and disagree on what goes under it would pass a comparison of keys
      // alone, and that is the one drift this module exists against.
      cell: column.render(answers[question.id]),
    }));
  }

  it.each(questionTypeSchema.options)(
    'plans a %s question the same with answers as without',
    (type) => {
      const { question, answers } = withSampleAnswer(type);

      // That `sampleAnswers` handed over something to compare with: an `info`
      // carries no answer, every other type carries exactly one. It is
      // **not** what keeps the comparison below from being two empty plans —
      // that is the assertion after it.
      expect(Object.keys(answers)).toHaveLength(type === 'info' ? 0 : 1);

      const withAnswers = questionColumns(question, [answers]);
      // `toStrictEqual` over two empty arrays passes, so the one type whose
      // plan may legally be empty is named rather than trusted: `info` writes
      // no column at all, everything else writes at least one.
      if (type !== 'info') {
        expect(withAnswers.length).toBeGreaterThan(0);
      }

      expect(shapeOf(question, answers, withAnswers)).toStrictEqual(
        shapeOf(question, answers, questionColumns(question, NO_ANSWERS)),
      );
    },
  );

  describe('die wachsende Tabelle', () => {
    /** The form offers two rows; the participants decide the rest. */
    const table = tableOf(2);

    /** One submission's answer to the table, as the answer set carries it. */
    function submission(
      ...rows: readonly Record<string, string | number | boolean>[]
    ): AnswerMap {
      return { [table.id]: { cells: rows } };
    }

    /** How many distinct row numbers the plan writes — „Spaltenblöcke". */
    function rowBlocks(plan: readonly { key: string }[]): number {
      return new Set(
        plan.map((column) => column.key.split(COLUMN_KEY_SEPARATOR)[1]),
      ).size;
    }

    /**
     * The answer set for this case: five rows in the longest, and
     * the longest is deliberately **not** the first — deriving the width from
     * `answers[0]` leaves the plan at the two rows the form offers, and three
     * of one participant's rows are then in no file at all. *Measured on
     * 2026-08-06:* `expected 2 to be 5`.
     */
    const answers: AnswerMap[] = [
      submission({ name: 'Anna' }),
      submission({ name: 'Bert' }, {}, { name: 'Cäsar' }),
      submission(
        { name: 'Dora' },
        { name: 'Emil' },
        { name: 'Frida' },
        { name: 'Gustav' },
        { name: 'Hans' },
      ),
    ];

    it('gives the longest answer a block, not the first', () => {
      const plan = questionColumns(table, answers);

      expect(rowBlocks(plan)).toBe(5);
      // Three Zelltypen × five rows: the nesting is unchanged (column by
      // column, row within column), only the row count grew.
      expect(plan).toHaveLength(15);
      expect(plan.slice(0, 5).map((column) => column.label)).toStrictEqual([
        `Begleitpersonen${COLUMN_LABEL_SEPARATOR}Name (Zeile 1)`,
        `Begleitpersonen${COLUMN_LABEL_SEPARATOR}Name (Zeile 2)`,
        `Begleitpersonen${COLUMN_LABEL_SEPARATOR}Name (Zeile 3)`,
        `Begleitpersonen${COLUMN_LABEL_SEPARATOR}Name (Zeile 4)`,
        `Begleitpersonen${COLUMN_LABEL_SEPARATOR}Name (Zeile 5)`,
      ]);
    });

    /**
     * The half of the same requirement that a column *count* cannot show: a shorter
     * answer has to carry **empty** cells, not shifted ones. The middle row of
     * the second submission is blank on purpose — that is where a plan indexing
     * „the next value present" instead of „the value at this row" pulls
     * „Cäsar" up into row 2 and puts every later name one row too high.
     */
    it('leaves a shorter answer empty rather than shifting it up', () => {
      const nameColumns = questionColumns(table, answers).slice(0, 5);

      expect(
        nameColumns.map((column) => column.render(answers[1]?.[table.id])),
      ).toStrictEqual(['Bert', '', 'Cäsar', '', '']);
      expect(
        nameColumns.map((column) => column.render(answers[0]?.[table.id])),
      ).toStrictEqual(['Anna', '', '', '', '']);
    });

    /**
     * The third case. The reversal is the measurement: a plan built
     * from a running „widen as you go" walk would come out the same here by
     * luck, one built from „the first answer" or „the last answer" would not.
     */
    it('is the same plan whichever way the answer set is walked', () => {
      const forwards = questionColumns(table, answers);
      const backwards = questionColumns(table, [...answers].reverse());

      expect(
        backwards.map((column) => ({
          key: column.key,
          label: column.label,
          guard: column.guard,
          cell: column.render(answers[2]?.[table.id]),
        })),
      ).toStrictEqual(
        forwards.map((column) => ({
          key: column.key,
          label: column.label,
          guard: column.guard,
          cell: column.render(answers[2]?.[table.id]),
        })),
      );
    });

    /**
     * „Mindestens die vom Formular vorgegebenen Startzeilen": otherwise a
     * table nobody filled in would have no columns at all, and the question
     * would vanish from the file exactly when the export is used to find out
     * that nobody answered.
     */
    it('keeps the form’s own rows when no answer carries any', () => {
      expect(rowBlocks(questionColumns(table, NO_ANSWERS))).toBe(2);
      expect(rowBlocks(questionColumns(table, [submission()]))).toBe(2);
      expect(rowBlocks(questionColumns(table, [{}]))).toBe(2);
    });

    /**
     * The answer to **this** question, found under its own id. An answer set
     * read as „every table in it" would let a wide table on the same form
     * widen every other one.
     */
    it('reads only the answers to this question', () => {
      const someOtherQuestion = '019ff000-0000-7000-8000-0000000000ff';
      const foreign: AnswerMap[] = [
        {
          [someOtherQuestion]: {
            cells: Array.from({ length: 9 }, () => ({ name: 'x' })),
          },
        },
      ];

      expect(rowBlocks(questionColumns(table, foreign))).toBe(2);
    });

    /**
     * ⚠️ **The per-column guard applies to a column that would not exist
     * without the answer either** (the warning under the requirement). The
     * formula character sits in the **fourth** row — two rows past anything the
     * form offers — and the two lines asserted here are exactly the two
     * `buildCsv` runs on a cell: `column.render`, then `escapeCsvCell` with
     * `column.guard`.
     *
     * *Reproduction run on 2026-08-06:* letting a row that only comes into
     * being out of an answer fall back to `'auto'` → red at the Zahl column
     * (`{guard: 'auto'}` instead of `'number'`), i.e. at exactly the half a
     * pure formula check does not see.
     */
    it('guards a formula in a row that only the answer created', () => {
      const attack = submission({}, {}, {}, { name: '=SUM(A1)', anzahl: 3 });
      const plan = questionColumns(table, [attack]);
      const cellAt = (label: string): { guarded: string; guard: CellGuard } => {
        const column = plan.find((candidate) =>
          candidate.label.endsWith(label),
        );
        if (column === undefined) {
          throw new Error(`no column ${label}`);
        }
        return {
          guarded: escapeCsvCell(column.render(attack[table.id]), column.guard),
          guard: column.guard,
        };
      };

      // Free text, so `'auto'` — and neutralised, because it begins like a
      // formula. Not because the row is dynamic: because the *column* is text.
      expect(cellAt('Name (Zeile 4)')).toStrictEqual({
        guard: 'auto',
        guarded: `'=SUM(A1)`,
      });
      // The Zahl column of the same dynamic row keeps `'number'`, so the
      // office can still sum it — a guard read off „this row came from an
      // answer" would have made both cells text.
      expect(cellAt('Anzahl (Zeile 4)')).toStrictEqual({
        guard: 'number',
        guarded: '3',
      });
    });

    /**
     * The ceiling. It is a second lock, not the product rule — that one belongs
     * in the rejection chain of the submission, in `response-validation.ts`.
     * What is bounded here is what **one** stored row may decide about the
     * width of everybody's file, over JSONB that reaches this function through
     * a cast.
     *
     * **What the cap costs, measured rather than implied:** the five rows past
     * `TABLE_ROWS_MAX` in the fixture below are in the answer and in no column
     * of the file — no header, no empty cell, no marker. This test asserts the
     * cap; it does **not** assert a warning, because there is none.
     *
     * ⚠️ **This test cannot notice when the cap starts losing accepted data.**
     * It is written against the constant it measures, so raising
     * `TABLE_ROWS_MAX` moves both sides and it stays green — which is right for
     * what it is, and useless as an alarm. The alarm belongs at the **schema**:
     * the schema's per-question Obergrenze must be bounded by `TABLE_ROWS_MAX` in
     * `tableQuestionSchema`, so a form that could be answered wider than the
     * file can be written stops parsing. Nothing in this file can stand in for
     * that check — it never sees what the request path accepts.
     */
    it('stops at the ceiling of the document model', () => {
      const huge = submission(
        ...Array.from({ length: TABLE_ROWS_MAX + 5 }, () => ({ name: 'x' })),
      );

      expect(rowBlocks(questionColumns(table, [huge]))).toBe(TABLE_ROWS_MAX);
    });
  });
});
