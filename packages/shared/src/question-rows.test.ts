import { describe, expect, it } from 'vitest';

import { questionSchema, type FormPage, type Question } from './form-schema.ts';
import {
  rowPartnerIndex,
  rowsOf,
  withPairedPageWidths,
  withPairedWidths,
  withReleasedRow,
} from './question-rows.ts';

/**
 * The row rule (design handoff) — the *document* half of half width.
 *
 * These tests are the reason the rule moved out of the builder store: builder
 * and fill-in view now read the same definition of "row", and a change that
 * makes one of them disagree fails here rather than in a screenshot.
 *
 * The builder's own suite (`apps/web/src/builder/builder-store.test.ts`) still
 * covers what the *gestures* do with these functions.
 */

const ID = '019fe200-0000-7000-8000-00000000000';

/** Parsed rather than cast: a fixture that the schema rejects proves nothing. */
function question(index: number, width: 'full' | 'half'): Question {
  return questionSchema.parse({
    id: `${ID}${String(index)}`,
    type: 'text',
    label: `Frage ${String(index)}`,
    hint: null,
    required: false,
    width,
    minLength: null,
    maxLength: null,
    pattern: null,
  });
}

/**
 * A question list from a compact width pattern, e.g. `'h h f'` — half, half,
 * full. Short enough that a test reads as the layout it describes.
 */
function questions(widths: string): Question[] {
  return widths
    .split(' ')
    .map((letter, index) =>
      question(index + 1, letter === 'h' ? 'half' : 'full'),
    );
}

function widthsOf(list: Question[]): string {
  return list.map((entry) => (entry.width === 'half' ? 'h' : 'f')).join(' ');
}

/** Rows as `'12|3'` — the grouping and the order in one readable string. */
function shapeOf(rows: Question[][]): string {
  return rows
    .map((row) =>
      row.map((entry) => entry.label.replace('Frage ', '')).join(''),
    )
    .join('|');
}

describe('rowPartnerIndex', () => {
  it('pairs two consecutive half-width questions', () => {
    const list = questions('h h');

    expect(rowPartnerIndex(list, 0)).toBe(1);
    expect(rowPartnerIndex(list, 1)).toBe(0);
  });

  it('leaves a full-width question without a partner', () => {
    expect(rowPartnerIndex(questions('f h h'), 0)).toBe(-1);
  });

  /**
   * A row holds *two*, so the third half card in a run starts a row of its own
   * — it is not a partner of the pair before it.
   */
  it('reads rows from the front, two at a time', () => {
    const list = questions('h h h');

    expect(rowPartnerIndex(list, 0)).toBe(1);
    expect(rowPartnerIndex(list, 1)).toBe(0);
    expect(rowPartnerIndex(list, 2)).toBe(-1);
  });
});

describe('withPairedWidths', () => {
  it('widens a half-width question that has no partner', () => {
    expect(widthsOf(withPairedWidths(questions('h')))).toBe('f');
    expect(widthsOf(withPairedWidths(questions('f h')))).toBe('f f');
    expect(widthsOf(withPairedWidths(questions('h h h')))).toBe('h h f');
  });

  it('leaves complete rows alone', () => {
    expect(widthsOf(withPairedWidths(questions('h h f h h')))).toBe(
      'h h f h h',
    );
  });

  /** So a commit that changed no width does not re-render the page. */
  it('returns the very same array when nothing has to change', () => {
    const list = questions('h h f');

    expect(withPairedWidths(list)).toBe(list);
  });
});

describe('withReleasedRow', () => {
  it('sets the partner of a docked question back to full width', () => {
    expect(widthsOf(withReleasedRow(questions('h h'), 0))).toBe('h f');
    expect(widthsOf(withReleasedRow(questions('h h'), 1))).toBe('f h');
  });

  it('changes nothing when the question is in no row', () => {
    const list = questions('f h h');

    expect(withReleasedRow(list, 0)).toBe(list);
  });
});

describe('withPairedPageWidths', () => {
  function page(id: string, widths: string): FormPage {
    return {
      id,
      title: `Seite ${id}`,
      description: null,
      questions: questions(widths),
    };
  }

  it('repairs every page of the document', () => {
    const repaired = withPairedPageWidths([
      page('a', 'h h h'),
      page('b', 'f h'),
    ]);

    expect(repaired.map((entry) => widthsOf(entry.questions))).toStrictEqual([
      'h h f',
      'f f',
    ]);
  });

  it('returns the same pages when the document is already sound', () => {
    const pages = [page('a', 'h h'), page('b', 'f')];

    expect(withPairedPageWidths(pages)).toBe(pages);
  });
});

describe('rowsOf', () => {
  it('puts two consecutive half-width questions in one row', () => {
    expect(shapeOf(rowsOf(questions('h h')))).toBe('12');
  });

  it('gives every full-width question a row of its own', () => {
    expect(shapeOf(rowsOf(questions('f f f')))).toBe('1|2|3');
  });

  it('starts a new row after a complete one', () => {
    expect(shapeOf(rowsOf(questions('h h h h')))).toBe('12|34');
  });

  /**
   * A stray half card gets a row to *itself* and keeps its stored `width` —
   * grouping only. The row is what makes it full width (`flex: 1 1 0` in
   * `public-form-view.css`), so there is nothing here to repair; repairing it
   * would cost the identity guarantee below for a value no renderer reads.
   */
  it('gives an orphaned half-width question a row of its own, unchanged', () => {
    const list = questions('h h h');
    const rows = rowsOf(list);

    expect(shapeOf(rows)).toBe('12|3');
    expect(rows[1]?.[0]).toBe(list[2]);
    expect(rows[1]?.[0]?.width).toBe('half');
  });

  /** A row of two is a row of two halves — the whole rule, from the outside. */
  it('pairs exactly the consecutive halves, whatever the pattern', () => {
    for (const shape of ['h', 'f h', 'h f', 'h h h', 'h f h', 'f h h h']) {
      for (const row of rowsOf(questions(shape))) {
        expect(row.length === 1 || widthsOf(row) === 'h h').toBe(true);
      }
    }
  });

  /**
   * Rows regroup; they never reorder, drop or copy. The tab order of the
   * fill-in view rests on the order, and the promise that *every* question is
   * rendered rests on the completeness — a grouping that silently loses one
   * would hide a field nobody can fill in.
   */
  it('reproduces the input element by element', () => {
    for (const shape of [
      'f',
      'h h',
      'h h h',
      'f h h f h h',
      'h f h f',
      'h h h h h',
    ]) {
      const list = questions(shape);
      const flattened = rowsOf(list).flat();

      expect(flattened).toHaveLength(list.length);
      for (const [index, entry] of flattened.entries()) {
        // `toBe`, not `toStrictEqual`: same object, so nothing was copied on
        // the way through.
        expect(entry).toBe(list[index]);
      }
    }
  });

  it('has no row for an empty page', () => {
    expect(rowsOf([])).toStrictEqual([]);
  });
});
