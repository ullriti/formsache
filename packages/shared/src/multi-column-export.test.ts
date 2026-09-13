import { describe, expect, it, vi } from 'vitest';

import type * as AnswerColumns from './answer-columns.ts';
import type { CellGuard, QuestionColumn } from './answer-columns.ts';
import {
  CSV_BOM,
  SUBMITTED_AT_COLUMN,
  SUBMITTED_AT_LABEL,
  buildCsv,
  chooseColumns,
  type CsvRow,
} from './csv.ts';
import {
  NO_ANSWERS,
  csvColumns,
  responseColumnGroups,
  responseColumns,
  type ResponseColumnGroup,
} from './form-history.ts';
import { parseFormDefinition, type FormDefinition } from './form-schema.ts';
import type { Question } from './form-schema.ts';
import type { AnswerMap } from './response-validation.ts';

/**
 * **The proof that one question may produce several columns.**
 *
 * The seam is built before the three types that need it — Adresse, Matrix,
 * Tabelle — so there is no question type in the schema today
 * that occupies more than one column. Believing the machinery works because it
 * *looks* general is how a seam turns out not to fit the day three packages
 * reach for it at once. This file therefore constructs the multi-column case
 * itself: one question that expands into three columns with three different
 * guards, driven through the very functions the export runs
 * (`responseColumnGroups` → `chooseColumns` → `csvColumns` → `buildCsv`).
 *
 * ## Why the plan is replaced rather than a type added
 *
 * Adding an eighth question type here would be building multi-column support in a test file, and
 * the byte-identity this package promises (`export-golden.test.ts`) is measured
 * against the nine that exist. Replacing {@link questionColumns} for one
 * question id leaves everything else — the schema, the validator, the other
 * columns of the same fixture — exactly as it is, so what this file measures is
 * the machinery and nothing but.
 *
 * The stand-in is shaped like the table question type (one column per cell,
 * `Frage — Spalte`) and mixes the three guards on purpose, because that is what
 * makes „je Spalte" observable at all: a guard chosen once per question has to
 * be wrong about at least one of them.
 */

const fixture = vi.hoisted(() => ({
  MELDUNG: '019ff000-0000-7000-8000-0000000000b1',
  NAME: '019ff000-0000-7000-8000-0000000000b2',
  SEMESTER: '019ff000-0000-7000-8000-0000000000b3',
  DIET: '019ff000-0000-7000-8000-0000000000b4',
  /** The other end of the range: a question that writes **no** column. */
  INFO: '019ff000-0000-7000-8000-0000000000b5',
}));

vi.mock('./answer-columns.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof AnswerColumns>();

  /**
   * The stand-in plan: three cells of one table question, each with its own
   * header, its own guard and its own slice of the stored answer.
   *
   * The answer is stored as one `|`-separated string purely so the fixture needs
   * no schema of its own — what matters is that a column renders *part* of an
   * answer rather than the whole of it.
   */
  const parts: readonly {
    id: string;
    name: string;
    guard: CellGuard;
    at: number;
  }[] = [
    { id: 'bemerkung', name: 'Bemerkung', guard: 'auto', at: 0 },
    { id: 'nummer', name: 'Mitgliedsnummer', guard: 'text', at: 1 },
    { id: 'anzahl', name: 'Anzahl', guard: 'number', at: 2 },
  ];

  return {
    ...actual,
    questionColumns: (
      question: Question,
      answers: readonly AnswerMap[],
    ): QuestionColumn[] => {
      // The Infotext: part of the document, no question — „keine
      // Spalte in Tabelle und Export". An empty plan is how a type says so.
      if (question.id === fixture.INFO) {
        return [];
      }
      if (question.id !== fixture.MELDUNG) {
        // Forwarded rather than dropped: every other question of the fixture is
        // planned by the real function, and a stand-in that answered for it
        // with the document alone would be measuring a different seam than the
        // one the export runs on.
        return actual.questionColumns(question, answers);
      }
      // A retired part: the newest version asks for two cells, the older one
      // asked for three. `hint` carries which, so the fixture can publish two
      // shapes of the same question without a second question type.
      const live = question.hint === 'kurz' ? parts.slice(0, 2) : parts;
      return live.map((part) => ({
        key: `${question.id}${actual.COLUMN_KEY_SEPARATOR}${part.id}`,
        label: `${question.label}${actual.COLUMN_LABEL_SEPARATOR}${part.name}`,
        guard: part.guard,
        render: (value) =>
          typeof value === 'string' ? (value.split('|')[part.at] ?? '') : '',
      }));
    },
  };
});

const P = '019ff000-0000-7000-8000-0000000000f1';
const base = { hint: null, required: false, width: 'full' } as const;

// „Keine Antworten" (`NO_ANSWERS`, imported): what this file measures is the
// *machinery* that turns one question into several columns, and the stand-in
// plan above decides its three columns from the document. The second source —
// the answers — is measured where the type that reads it is
// (`answer-columns.test.ts`).

function text(
  id: string,
  label: string,
  hint: string | null = null,
): Record<string, unknown> {
  return {
    ...base,
    hint,
    id,
    type: 'text',
    label,
    minLength: null,
    maxLength: null,
    pattern: null,
  };
}

function definition(questions: readonly unknown[]): FormDefinition {
  return parseFormDefinition({
    pages: [{ id: P, title: 'Seite 1', questions }],
  });
}

/** Three cells in version 1, two in version 2 — „Mitgliedsnummer" is retired. */
const long = text(fixture.MELDUNG, 'Meldung');
const short = text(fixture.MELDUNG, 'Meldung', 'kurz');

/**
 * The Infotext stands **first** in the document on purpose.
 *
 * Everything this file already asserts about the column list and about the
 * default view is then also an assertion that it takes no place: a question
 * that writes no column must not appear in the list, and must not spend one of
 * the three slots of the untouched view on a callout box.
 */
const info = text(fixture.INFO, 'Hinweis zur Anreise');

const v1 = definition([
  info,
  long,
  text(fixture.NAME, 'Name'),
  text(fixture.SEMESTER, 'Semester'),
  text(fixture.DIET, 'Essenswunsch'),
]);
const v2 = definition([
  info,
  short,
  text(fixture.NAME, 'Name'),
  text(fixture.SEMESTER, 'Semester'),
  text(fixture.DIET, 'Essenswunsch'),
]);

const key = (part: string): string => `${fixture.MELDUNG}#${part}`;

function row(definitionOf: FormDefinition, meldung: string): CsvRow {
  return {
    submittedAt: '2026-07-27T09:05:00.000Z',
    answers: { [fixture.MELDUNG]: meldung, [fixture.NAME]: 'Anton' },
    definition: definitionOf,
  };
}

function dataLines(csv: string): string[] {
  const lines = csv.slice(CSV_BOM.length).split('\r\n').slice(1);
  return lines.at(-1) === '' ? lines.slice(0, -1) : lines;
}

function header(csv: string): string {
  return csv.slice(CSV_BOM.length).split('\r\n')[0] ?? '';
}

describe('a question that produces several columns', () => {
  const groups = responseColumnGroups(
    [{ version: 1, definition: v1 }],
    NO_ANSWERS,
  );

  it('is one entry for the client and three columns in the file', () => {
    // One tick in the field menu, one cell in the table.
    expect(groups.map((group) => group.key)).toEqual([
      fixture.MELDUNG,
      fixture.NAME,
      fixture.SEMESTER,
      fixture.DIET,
      SUBMITTED_AT_COLUMN,
    ]);

    // Three columns in the file, each named after the question and its part.
    expect(csvColumns(groups.slice(0, 1))).toEqual([
      { key: key('bemerkung'), label: 'Meldung — Bemerkung' },
      { key: key('nummer'), label: 'Meldung — Mitgliedsnummer' },
      { key: key('anzahl'), label: 'Meldung — Anzahl' },
    ]);
  });

  /**
   * **The guard is chosen per column, not per question** — the reason the seam
   * had to reach this far down at all.
   *
   * Every one of the three values below is damaged by the *other* two guards:
   * `01067` loses its leading zero under `'number'`, `-5` stops being a number
   * under `'text'` or `'auto'` (so „Summe" skips the row), and `=1+1` executes
   * without any guard at all. A single guard for the question cannot be right
   * about all three, which is what makes this test fail the moment somebody
   * folds the decision back up to the question.
   */
  it('guards every column on its own terms', () => {
    const csv = buildCsv(csvColumns(groups.slice(0, 1)), [
      row(v1, '=1+1|01067|-5'),
    ]);

    expect(dataLines(csv)).toStrictEqual([`'=1+1;'01067;-5`]);
  });

  /**
   * At the level this package can measure it: a
   * Postleitzahl survives as text. Here it holds because the *column* says
   * `'text'` — the round-trip check of `csv.ts` would catch this one too, and
   * that redundancy is deliberate, but the guard is what an Adresse's PLZ
   * column will rely on when the value is `1067` in a field that allows four
   * digits.
   */
  it('keeps a leading zero in the column that asks for text', () => {
    const csv = buildCsv(csvColumns(groups.slice(0, 1)), [
      row(v1, 'ok|01067|1'),
    ]);

    expect(dataLines(csv)[0]?.split(';')[1]).toBe(`'01067`);
  });

  it('renders each column from its own part of the answer', () => {
    const csv = buildCsv(csvColumns(groups.slice(0, 1)), [
      row(v1, 'Kein Zimmer|00815|2'),
    ]);

    expect(dataLines(csv)).toStrictEqual([`Kein Zimmer;'00815;2`]);
  });
});

/**
 * The same requirement, one level further down: the union is taken over
 * **columns**, not only over questions.
 *
 * A Matrix row or a Tabelle cell that an editor deleted is a column with
 * answers behind it. Reading the columns off the newest published shape alone
 * would make those answers unreachable through the interface — the same data
 * loss this guards against, and harder to notice, because the
 * question itself is still there.
 */
describe('the union over published versions, per column', () => {
  const groups = responseColumnGroups(
    [
      { version: 1, definition: v1 },
      { version: 2, definition: v2 },
    ],
    NO_ANSWERS,
  );

  it('keeps a column the newest version no longer produces, and marks it', () => {
    expect(csvColumns(groups.slice(0, 1))).toEqual([
      { key: key('bemerkung'), label: 'Meldung — Bemerkung' },
      { key: key('nummer'), label: 'Meldung — Mitgliedsnummer' },
      // Active columns first, in today's order; the retired one behind them,
      // named — exactly the rule that governs whole questions.
      {
        key: key('anzahl'),
        label: 'Meldung — Anzahl (nicht mehr gefragt)',
      },
    ]);
  });

  it('keeps the answers behind that column exportable', () => {
    const csv = buildCsv(csvColumns(groups.slice(0, 1)), [
      row(v1, 'alt|00815|7'),
      row(v2, 'neu|00816'),
    ]);

    expect(dataLines(csv)).toStrictEqual([
      `alt;'00815;7`,
      // The newer row was never asked the retired cell — empty, not invented.
      `neu;'00816;`,
    ]);
  });

  /**
   * The question is still asked, so it is **not** marked retired on the wire.
   * Only the column that disappeared says so, and only in the file's header —
   * the one place a reader of the CSV can be told.
   */
  it('does not call the question retired because one of its columns is', () => {
    expect(groups[0]?.retired).toBe(false);
  });
});

/**
 * **A question that writes no column at all** — the other end of the same seam
 * (der Infotext ist „keine Frage: … keine Spalte in Tabelle und
 * Export").
 *
 * One question, three promises, and before this it broke all three: it appeared
 * in the table and in the field menu, it spent one of the three slots of the
 * untouched view, and chosen on its own it produced a file consisting of a BOM,
 * an empty header line and one empty line per answer — the „header of nothing"
 * `chooseColumns` says in its own comment that it prevents.
 */
describe('a question that produces no column', () => {
  const groups = responseColumnGroups(
    [{ version: 1, definition: v1 }],
    NO_ANSWERS,
  );

  it('is no column of the responses view and none of the file', () => {
    expect(groups.map((group) => group.key)).not.toContain(fixture.INFO);
    // Asserted on the wire list as well, because that is what the field menu
    // and the table are built from — a tick for a column nobody can show.
    expect(
      responseColumns([{ version: 1, definition: v1 }]).map(
        (column) => column.key,
      ),
    ).not.toContain(fixture.INFO);
  });

  /**
   * „Die ersten drei Fragen" counts questions (`pickDefaultColumns`), so a
   * question with an empty plan sitting in front of them would silently make it
   * two — the file would be short of a question the table still showed.
   */
  it('does not spend a slot of the untouched default view', () => {
    expect(
      chooseColumns(groups, undefined, 'table').map((group) => group.key),
    ).toEqual([
      fixture.MELDUNG,
      fixture.NAME,
      fixture.SEMESTER,
      SUBMITTED_AT_COLUMN,
    ]);
  });

  /**
   * The second lock, tested where production can no longer reach: an entry with
   * an empty plan is built by hand, because `responseColumnGroups` now keeps it
   * off the list. `chooseColumns` promises „never a header of nothing", and a
   * promise that holds only because another module filters first is not the
   * property it states.
   */
  describe('chosen on its own', () => {
    const empty: ResponseColumnGroup = {
      key: fixture.INFO,
      label: 'Hinweis zur Anreise',
      retired: false,
      columns: [],
    };
    const withEmpty: ResponseColumnGroup[] = [empty, ...groups];

    it('falls back to the default view instead of choosing nothing', () => {
      expect(
        chooseColumns(withEmpty, [fixture.INFO], 'table').map(
          (group) => group.key,
        ),
      ).toEqual([
        fixture.MELDUNG,
        fixture.NAME,
        fixture.SEMESTER,
        SUBMITTED_AT_COLUMN,
      ]);
    });

    it('therefore writes a file with columns in it, not an empty header', () => {
      const csv = buildCsv(
        csvColumns(chooseColumns(withEmpty, [fixture.INFO], 'table')),
        [row(v1, 'Kein Zimmer|00815|2')],
      );

      // What it used to be: `CSV_BOM + '\r\n' + '\r\n'` — a header of nothing
      // and one empty line per answer.
      expect(header(csv)).not.toBe('');
      expect(dataLines(csv)).toStrictEqual([
        `Kein Zimmer;'00815;2;Anton;;27.07.2026 09:05`,
      ]);
    });

    /**
     * And beside a real column it writes nothing — no blank column, no shifted
     * value. The selection may still carry the entry; the file cannot.
     */
    it('writes nothing when it is only part of the selection', () => {
      const csv = buildCsv(
        csvColumns(
          chooseColumns(withEmpty, [fixture.INFO, fixture.NAME], 'table'),
        ),
        [row(v1, 'Kein Zimmer|00815|2')],
      );

      expect(header(csv)).toBe('Name');
      expect(dataLines(csv)).toStrictEqual(['Anton']);
    });
  });
});

/**
 * **The requirement under multi-column questions**: the table and the export
 * still run *one* default selection.
 *
 * The selection counts questions — that is what the field menu offers, what
 * `columns=` names and what the table shows — and the file expands what was
 * selected. Counting expanded columns instead would give this fixture a default
 * of one question plus the timestamp while the table showed three, which is the
 * drift `pickDefaultColumns` was written to end.
 */
describe('one default selection for table and export', () => {
  const groups = responseColumnGroups(
    [{ version: 1, definition: v1 }],
    NO_ANSWERS,
  );
  const chosen = chooseColumns(groups, undefined, 'table');

  it('picks the first three questions plus the timestamp', () => {
    expect(chosen.map((group) => group.key)).toEqual([
      fixture.MELDUNG,
      fixture.NAME,
      fixture.SEMESTER,
      SUBMITTED_AT_COLUMN,
    ]);
  });

  it('writes those three questions as five columns plus the timestamp', () => {
    const csv = buildCsv(csvColumns(chosen), []);

    expect(header(csv)).toBe(
      [
        'Meldung — Bemerkung',
        'Meldung — Mitgliedsnummer',
        'Meldung — Anzahl',
        'Name',
        'Semester',
        SUBMITTED_AT_LABEL,
      ].join(';'),
    );
  });

  /**
   * And an explicit selection names *questions*, not parts — the client cannot
   * tick half an Adresse, and the export route needs no vocabulary for one.
   */
  it('expands an explicitly chosen question into all of its columns', () => {
    const csv = buildCsv(
      csvColumns(chooseColumns(groups, [fixture.MELDUNG], 'table')),
      [],
    );

    expect(header(csv)).toBe(
      'Meldung — Bemerkung;Meldung — Mitgliedsnummer;Meldung — Anzahl',
    );
  });
});
