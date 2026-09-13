import { describe, expect, it } from 'vitest';

import * as shared from './index.ts';
import {
  SUBMITTED_AT_COLUMN,
  SUBMITTED_AT_LABEL,
  chooseColumns,
  pickDefaultColumns,
  type ColumnSurface,
  type CsvColumn,
} from './export-sheet.ts';

/**
 * **Two preselections, one function** .
 *
 * Decided on 2026-08-06: the **export** takes *all* columns by default,
 * the **table** stays at three. The reasoning is not a question of taste —
 * the three columns of the table are a statement about screen space, a
 * downloaded file is a statement about data, and a silently
 * trimmed export is data loss that nobody notices (a find from
 * practice: ten column-writing questions, three of them in the file).
 *
 * ⚠️ **What this sheet measures is not „stimmen die zwei Zahlen" but
 * „ist es eine Regel".** Two numbers could also be achieved with two functions
 * — and the two would then drift apart as soon as one of them skips the
 * retired question, counts the Infotext along or sorts the timestamp
 * somewhere else. That would be silent: the file would contain something other than
 * the screen, and no test of either side would see it. That is why
 * three kinds of assurance stand here side by side:
 *
 * 1. the **numbers** per surface (the decision itself);
 * 2. the **coupling**: the preselection of the table is the beginning of that of the
 *    export — same selection rule, same order, same timestamp,
 *    over six shapes that are built at exactly the places where two
 *    versions would drift apart;
 * 3. that `chooseColumns` **passes the argument through** and does nothing else
 *    with it: a selection that has been spelled out applies unchanged on both surfaces.
 *
 * *Reproduction (run, see report):* introduce a second default function
 * `pickExportColumns` and switch the server over to it → `rule 3` of
 * `single-source.test.ts` turns red **and** the coupling here, as soon as the second
 * version deviates in one of the six points. The entry in
 * `FILE_SCOPED_IDENTIFIERS` is therefore part of the requirement, not its optional extra.
 */

/** A column the file writes — `columnsWritten` counts it as one. */
function question(key: string): CsvColumn {
  return { key, label: `Frage ${key}` };
}

/**
 * A question that writes **no** column — the Infotext.
 *
 * It is in this file because it is one of the ways the two preselections could
 * disagree: a copy that counted entries rather than written columns would let a
 * callout box eat one of the table's three slots while the export, which takes
 * everything, would not notice.
 */
function infotext(key: string): CsvColumn & { columns: readonly never[] } {
  return { key, label: `Hinweis ${key}`, columns: [] };
}

/** A question that writes several columns — an Adresse. */
function address(key: string): CsvColumn & { columns: readonly string[] } {
  return {
    key,
    label: `Anschrift ${key}`,
    columns: [`${key}#street`, `${key}#zip`],
  };
}

const stamp: CsvColumn = {
  key: SUBMITTED_AT_COLUMN,
  label: SUBMITTED_AT_LABEL,
};

/**
 * The shapes the two preselections have to agree about.
 *
 * Each one is a way a second implementation would drift, not a variation for
 * its own sake: fewer questions than slots, more than slots, a question writing
 * nothing, a question writing several, and a list whose timestamp does not
 * arrive last.
 */
const SHAPES: readonly { name: string; columns: readonly CsvColumn[] }[] = [
  {
    name: 'fewer questions than the table has slots',
    columns: [question('a'), question('b'), stamp],
  },
  {
    name: 'exactly as many questions as slots',
    columns: [question('a'), question('b'), question('c'), stamp],
  },
  {
    name: 'more questions than slots',
    columns: [
      question('a'),
      question('b'),
      question('c'),
      question('d'),
      question('e'),
      stamp,
    ],
  },
  {
    name: 'a question that writes no column, in front',
    columns: [
      infotext('i'),
      question('a'),
      question('b'),
      question('c'),
      question('d'),
      stamp,
    ],
  },
  {
    name: 'a question that writes several columns',
    columns: [
      address('adr'),
      question('a'),
      question('b'),
      question('c'),
      stamp,
    ],
  },
  {
    name: 'the timestamp before the questions',
    columns: [
      stamp,
      question('a'),
      question('b'),
      question('c'),
      question('d'),
    ],
  },
];

const keysOf = (columns: readonly CsvColumn[]): string[] =>
  columns.map((column) => column.key);

/** The preselection of one surface, by key. */
function preselection(
  columns: readonly CsvColumn[],
  surface: ColumnSurface,
): string[] {
  return keysOf(pickDefaultColumns(columns, surface));
}

describe('die Vorbelegung der Tabelle ', () => {
  it('nimmt die ersten drei spaltentragenden Fragen plus den Zeitstempel', () => {
    expect(
      preselection(
        [
          infotext('i'),
          question('a'),
          question('b'),
          question('c'),
          question('d'),
          stamp,
        ],
        'table',
      ),
    ).toEqual(['a', 'b', 'c', SUBMITTED_AT_COLUMN]);
  });
});

describe('die Vorbelegung des Exports ', () => {
  /**
   * **The decision itself.** Formerly the same list as above stood here —
   * three out of ten questions in a file that is pulled for evaluating and
   * archiving.
   */
  it('nimmt jede spaltentragende Frage plus den Zeitstempel', () => {
    expect(
      preselection(
        [
          infotext('i'),
          question('a'),
          question('b'),
          question('c'),
          question('d'),
          stamp,
        ],
        'export',
      ),
    ).toEqual(['a', 'b', 'c', 'd', SUBMITTED_AT_COLUMN]);
  });

  /**
   * …and the Infotext gets no column here either. „Alle" means „jede Frage,
   * die etwas schreibt", not „jeder Eintrag der Liste": a file with an
   * empty column per callout box would be the other way of breaking the same
   * promise.
   */
  it('nimmt trotzdem keine Frage auf, die nichts schreibt', () => {
    expect(
      preselection([infotext('i'), question('a'), stamp], 'export'),
    ).toEqual(['a', SUBMITTED_AT_COLUMN]);
  });
});

/**
 * **The coupling** — the part two functions could not keep.
 *
 * It is a statement about the *same* rule, not about two results: what
 * the table shows are the first three questions **of the export view**, in
 * the same order, with the same timestamp behind them. Whoever wrote a second
 * preselection would have to write every one of these properties down correctly
 * again; the cases above are the places where that fails.
 */
describe('beide Vorbelegungen kommen aus einer Regel', () => {
  for (const shape of SHAPES) {
    it(`bleibt gekoppelt: ${shape.name}`, () => {
      const table = preselection(shape.columns, 'table');
      const exported = preselection(shape.columns, 'export');

      const exportedQuestions = exported.filter(
        (key) => key !== SUBMITTED_AT_COLUMN,
      );
      const tableQuestions = table.filter((key) => key !== SUBMITTED_AT_COLUMN);

      // The table is the **beginning** of the export view — not „dieselben
      // Schlüssel in irgendeiner Ordnung" and not „eine Teilmenge".
      expect(tableQuestions).toEqual(exportedQuestions.slice(0, 3));
      // Both carry the timestamp, and both carry it last.
      expect(table.at(-1)).toBe(SUBMITTED_AT_COLUMN);
      expect(exported.at(-1)).toBe(SUBMITTED_AT_COLUMN);
      // And neither of the two invents a column that did not stand in the
      // list.
      for (const key of [...table, ...exported]) {
        expect(keysOf(shape.columns)).toContain(key);
      }
    });
  }

  /**
   * The counter-check to the coupling: it is not an equality. As soon as there are
   * more questions than slots, the two **have to** diverge — otherwise the
   * decision would not have been built, only the call renamed.
   */
  it('unterscheidet sich, sobald es mehr als drei Fragen gibt', () => {
    const many = [
      question('a'),
      question('b'),
      question('c'),
      question('d'),
      stamp,
    ];

    expect(preselection(many, 'table')).not.toEqual(
      preselection(many, 'export'),
    );
    expect(preselection(many, 'export')).toHaveLength(5);
    expect(preselection(many, 'table')).toHaveLength(4);
  });
});

/**
 * **The third brake: the name under which a second preselection would arrive.**
 *
 * `single-source.test.ts` (rule 3) forbids **declaring** `pickDefaultColumns` a
 * second time — and is blind to the *renamed* second copy,
 * as is written out there for `evaluateCondition` and `neutraliseHtml`.
 * This line closes the one route by which the renamed version would
 * actually arrive: as a second public function of this package that the
 * server calls instead of the shared one.
 *
 * A brake, not a proof, and the boundary is **measured**: what is caught is a
 * public name that speaks of columns and carries either „pick" or
 * „default" — that is the shape a second preselection takes
 * (`pickExportColumns`, `exportDefaultColumns`). A `pickExportColumns` that
 * stands only *inside* `forms.service.ts` still runs through; against that
 * stands the integration test of the export route, which measures the file against the
 * shared function.
 */
describe('das Paket bietet genau eine Vorbelegung an', () => {
  it('exportiert keine zweite Default-Spaltenfunktion', () => {
    const defaults = Object.keys(shared).filter(
      (name) =>
        /column/iu.test(name) &&
        (name.startsWith('pick') || /default/iu.test(name)),
    );

    expect(
      defaults,
      'Tabelle und Export beantworten die Spaltenfrage mit einer Funktion und ' +
        'zwei Argumenten. Eine zweite öffentliche Vorbelegung — ' +
        'wie auch immer sie heißt — ist die Drift, gegen die sie geteilt ist.',
    ).toEqual(['pickDefaultColumns']);
  });
});

/**
 * `chooseColumns` passes the argument through — and does nothing else with it.
 *
 * Both fallbacks onto the preselection (nothing requested, and a selection that
 * writes no column) have to take the surface into account; the selection that has
 * been spelled out must **not** take it into account. A branch that applied the surface
 * to a valid selection as well would make „alle Spalten" the only
 * possibility of the export — and thereby silently abolish the question from the
 * concept.
 */
describe('chooseColumns reicht die Fläche an die Vorbelegung durch', () => {
  const columns = [
    question('a'),
    question('b'),
    question('c'),
    question('d'),
    stamp,
  ];

  it('fällt ohne Auswahl auf die Vorbelegung der jeweiligen Fläche zurück', () => {
    expect(keysOf(chooseColumns(columns, undefined, 'table'))).toEqual([
      'a',
      'b',
      'c',
      SUBMITTED_AT_COLUMN,
    ]);
    expect(keysOf(chooseColumns(columns, undefined, 'export'))).toEqual([
      'a',
      'b',
      'c',
      'd',
      SUBMITTED_AT_COLUMN,
    ]);
  });

  it('fällt auch dann zurück, wenn die Auswahl keine Spalte schreibt', () => {
    const withInfo = [infotext('i'), ...columns];

    expect(keysOf(chooseColumns(withInfo, ['i'], 'table'))).toEqual([
      'a',
      'b',
      'c',
      SUBMITTED_AT_COLUMN,
    ]);
    expect(keysOf(chooseColumns(withInfo, ['i'], 'export'))).toEqual([
      'a',
      'b',
      'c',
      'd',
      SUBMITTED_AT_COLUMN,
    ]);
  });

  it('lässt eine ausgesprochene Auswahl auf beiden Flächen unverändert', () => {
    for (const surface of ['table', 'export'] as const) {
      expect(keysOf(chooseColumns(columns, ['d'], surface))).toEqual(['d']);
      expect(keysOf(chooseColumns(columns, ['a', 'b'], surface))).toEqual([
        'a',
        'b',
      ]);
    }
  });
});
