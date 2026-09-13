import type { TableQuestion } from '@formsache/shared';
import { describe, expect, it } from 'vitest';

import {
  addTableRow,
  asTable,
  canAddTableRow,
  canRemoveTableRow,
  removeTableRow,
  setTableCell,
} from './table-answer';

/**
 * The calculation behind a table's cells — the sibling of
 * `matrix-answer.test.ts`, split out for the same reason.
 */

function question(overrides: Partial<TableQuestion> = {}): TableQuestion {
  return {
    id: '019fe600-0000-7000-8000-0000000000c6',
    label: 'Begleitpersonen',
    hint: null,
    required: false,
    width: 'full',
    type: 'table',
    columns: [{ key: 'name', label: 'Name', type: 'text' }],
    rows: 2,
    ...overrides,
  };
}

describe('asTable', () => {
  it('pads a foreign or absent value to the row count the form offers', () => {
    expect(asTable(undefined, question())).toStrictEqual({ cells: [{}, {}] });
    expect(asTable(null, question({ rows: 1 }))).toStrictEqual({ cells: [{}] });
    expect(asTable({ values: ['a'], other: null }, question())).toStrictEqual({
      cells: [{}, {}],
    });
  });

  it('keeps the stored rows and pads the ones the form gained', () => {
    expect(
      asTable({ cells: [{ name: 'Anna' }] }, question({ rows: 3 })),
    ).toStrictEqual({ cells: [{ name: 'Anna' }, {}, {}] });
  });

  /**
   * **The row count now has a second source: the answer.**
   *
   * Reading it from the question alone — what this used to do — cut the
   * answer back to the Startzeilen on the very next render, which is to say it
   * threw away exactly the rows „+ Zeile" had just produced.
   */
  it('keeps the rows a participant added beyond the Startzeilen', () => {
    const grown = question({ rows: 2, addRows: { maxRows: 5 } });

    expect(
      asTable(
        { cells: [{ name: 'Anna' }, { name: 'Bert' }, { name: 'Carla' }] },
        grown,
      ),
    ).toStrictEqual({
      cells: [{ name: 'Anna' }, { name: 'Bert' }, { name: 'Carla' }],
    });
  });

  /**
   * Rows past the Obergrenze are dropped rather than carried along: they are
   * cells this form does not offer, and sending them back would fail the
   * server's own „Höchstens n Zeilen" (`TABLE_ROW_LIMIT_CODE`) on a submission
   * the participant can see nothing wrong with.
   */
  it('drops rows above the Obergrenze', () => {
    expect(
      asTable(
        { cells: [{ name: 'Anna' }, { name: 'Bert' }, { name: 'Carla' }] },
        question({ rows: 1, addRows: { maxRows: 2 } }),
      ),
    ).toStrictEqual({ cells: [{ name: 'Anna' }, { name: 'Bert' }] });
  });

  /**
   * An older table has no `addRows`, so its Obergrenze **is** its row count
   * — nothing about such a question changes, including the truncation it
   * already did.
   */
  it('still cuts a Tabelle without addRows to its row count', () => {
    expect(
      asTable(
        { cells: [{ name: 'Anna' }, { name: 'Bert' }] },
        question({ rows: 1 }),
      ),
    ).toStrictEqual({ cells: [{ name: 'Anna' }] });
  });
});

describe('canAddTableRow', () => {
  it('never offers a row on a Tabelle that is not ergänzbar', () => {
    const fixed = question({ rows: 2 });

    expect(canAddTableRow(fixed, asTable(undefined, fixed))).toBe(false);
  });

  /** the evidence: the button is gone **at** the limit, not one row later. */
  it('stops exactly at the Obergrenze', () => {
    const grown = question({ rows: 1, addRows: { maxRows: 3 } });

    expect(canAddTableRow(grown, { cells: [{}] })).toBe(true);
    expect(canAddTableRow(grown, { cells: [{}, {}] })).toBe(true);
    expect(canAddTableRow(grown, { cells: [{}, {}, {}] })).toBe(false);
  });

  /**
   * `maxRows` counts **all** rows, the Startzeilen included — a question whose
   * Obergrenze equals its Startzeilen offers nothing to add, which is what the
   * shared schema says and must not be re-derived here.
   */
  it('offers nothing when the Obergrenze equals the Startzeilen', () => {
    const grown = question({ rows: 3, addRows: { maxRows: 3 } });

    expect(canAddTableRow(grown, asTable(undefined, grown))).toBe(false);
  });
});

describe('canRemoveTableRow', () => {
  /**
   * The floor is `question.rows`, and this is the test that says why: `asTable`
   * pads back up to it, so a removal below would visibly undo itself on the
   * next render — the row would return, empty, at the end.
   */
  it('stops at the Startzeilen the form offers', () => {
    const grown = question({ rows: 2, addRows: { maxRows: 5 } });

    expect(canRemoveTableRow(grown, { cells: [{}, {}] })).toBe(false);
    expect(canRemoveTableRow(grown, { cells: [{}, {}, {}] })).toBe(true);
  });
});

describe('addTableRow / removeTableRow', () => {
  it('adds an empty row at the end', () => {
    expect(addTableRow({ cells: [{ name: 'Anna' }] })).toStrictEqual({
      cells: [{ name: 'Anna' }, {}],
    });
  });

  /**
   * **Taken out, not blanked.** A row cleared instead of removed goes back to
   * the server as an empty row, and the evaluation then shows a line the
   * participant deleted.
   */
  it('takes the row out of the array instead of emptying it', () => {
    expect(
      removeTableRow(
        { cells: [{ name: 'Anna' }, { name: 'Bert' }, { name: 'Carla' }] },
        1,
      ),
    ).toStrictEqual({ cells: [{ name: 'Anna' }, { name: 'Carla' }] });
  });

  it('never mutates the answer it was given', () => {
    const one = { cells: [{ name: 'Anna' }, {}] };
    addTableRow(one);
    removeTableRow(one, 0);

    expect(one).toStrictEqual({ cells: [{ name: 'Anna' }, {}] });
  });
});

describe('setTableCell', () => {
  const empty = { cells: [{}, {}] };

  it('writes a cell into its own row, leaving the others alone', () => {
    const one = setTableCell(empty, 0, 'name', 'Anna');
    expect(one).toStrictEqual({ cells: [{ name: 'Anna' }, {}] });

    expect(setTableCell(one, 1, 'anzahl', 3)).toStrictEqual({
      cells: [{ name: 'Anna' }, { anzahl: 3 }],
    });
  });

  /**
   * **`undefined` removes the cell.** One spelling of „leer", so a cleared
   * text box, an unticked Haken and a Liste set back to „—" all end as the
   * same absence — which is what `isBlankAnswer` and the Pflicht rule read.
   */
  it('removes a cell instead of storing an empty value', () => {
    const one = setTableCell(empty, 0, 'name', 'Anna');

    expect(setTableCell(one, 0, 'name', undefined)).toStrictEqual({
      cells: [{}, {}],
    });
  });

  it('keeps a zero, which is a number someone typed', () => {
    expect(setTableCell(empty, 0, 'anzahl', 0)).toStrictEqual({
      cells: [{ anzahl: 0 }, {}],
    });
  });

  it('never mutates the answer it was given', () => {
    const one = { cells: [{ name: 'Anna' }, {}] };
    setTableCell(one, 0, 'anzahl', 2);

    expect(one).toStrictEqual({ cells: [{ name: 'Anna' }, {}] });
  });
});
