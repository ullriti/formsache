import { describe, expect, it } from 'vitest';

import { asMatrix, pickedIn, toggleMatrixCell } from './matrix-answer';

/**
 * The calculation behind a Matrix's grid — asserted as a
 * function rather than through a rendered table, the split
 * `choice-answer.test.ts` and `address-answer.test.ts` already make: „welcher
 * Wert kommt heraus" is arithmetic, and jsdom is not a browser.
 * What the clicks do is `FieldInput.test.tsx`.
 */

describe('asMatrix', () => {
  it('reads any foreign or absent value as an empty matrix', () => {
    expect(asMatrix(undefined)).toStrictEqual({ rows: {} });
    expect(asMatrix(null)).toStrictEqual({ rows: {} });
    expect(asMatrix('')).toStrictEqual({ rows: {} });
    // A choice answer is also a plain object and shares no key with this one.
    expect(asMatrix({ values: ['a'], other: null })).toStrictEqual({
      rows: {},
    });
  });

  it('passes a real matrix answer through untouched', () => {
    const answer = { rows: { organisation: ['gut'] } };
    expect(asMatrix(answer)).toBe(answer);
  });
});

describe('toggleMatrixCell', () => {
  const empty = { rows: {} };

  /**
   * Single mode **replaces**, and a second click on the picked cell keeps it —
   * what a native radio group does. Inventing an „unpick" here would make the
   * Matrix behave differently from the Einfachauswahl in the same form.
   */
  it('replaces the pick of a row in single mode', () => {
    const first = toggleMatrixCell(empty, 'organisation', 'sehr-gut', false);
    expect(first).toStrictEqual({ rows: { organisation: ['sehr-gut'] } });

    expect(toggleMatrixCell(first, 'organisation', 'gut', false)).toStrictEqual(
      { rows: { organisation: ['gut'] } },
    );
    expect(
      toggleMatrixCell(first, 'organisation', 'sehr-gut', false),
    ).toStrictEqual({ rows: { organisation: ['sehr-gut'] } });
  });

  it('leaves the other rows alone', () => {
    const one = toggleMatrixCell(empty, 'organisation', 'gut', false);
    expect(toggleMatrixCell(one, 'programm', 'sehr-gut', false)).toStrictEqual({
      rows: { organisation: ['gut'], programm: ['sehr-gut'] },
    });
  });

  it('toggles in multiple mode, keeping the order things were picked in', () => {
    const one = toggleMatrixCell(empty, 'organisation', 'sehr-gut', true);
    const two = toggleMatrixCell(one, 'organisation', 'gut', true);

    expect(two).toStrictEqual({ rows: { organisation: ['sehr-gut', 'gut'] } });
    expect(
      toggleMatrixCell(two, 'organisation', 'sehr-gut', true),
    ).toStrictEqual({ rows: { organisation: ['gut'] } });
  });

  /**
   * A row emptied out **loses its key** rather than keeping `[]`: „nicht
   * beantwortet" is an absence, and a second spelling of it would make
   * `isBlankAnswer` and the Pflicht rule disagree about a row nobody touched.
   */
  it('drops the row entirely when its last pick is removed', () => {
    const one = toggleMatrixCell(empty, 'organisation', 'gut', true);
    const none = toggleMatrixCell(one, 'organisation', 'gut', true);

    expect(none).toStrictEqual({ rows: {} });
    expect(Object.keys(none.rows)).toStrictEqual([]);
  });

  it('never mutates the answer it was given', () => {
    const one = { rows: { organisation: ['gut'] } };
    toggleMatrixCell(one, 'programm', 'sehr-gut', false);

    expect(one).toStrictEqual({ rows: { organisation: ['gut'] } });
  });
});

describe('pickedIn', () => {
  it('gives the empty list for a row nobody answered', () => {
    expect(pickedIn({ rows: {} }, 'organisation')).toStrictEqual([]);
    expect(
      pickedIn({ rows: { programm: ['gut'] } }, 'organisation'),
    ).toStrictEqual([]);
  });
});
