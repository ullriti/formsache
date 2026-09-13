import { describe, expect, it } from 'vitest';

import {
  DOCK_BAND_FRACTION,
  DOCK_ZONE_FRACTION,
  isWithinDropRange,
  pageDropIndex,
  questionDropTarget,
  toDestinationIndex,
  type CardRect,
} from './drag-geometry';

/**
 * The arithmetic behind the requirements, tested without a browser.
 *
 * Everything here is a rule the handoff states in prose — "linkes Drittel
 * dockt links an", "Ziel-Index über die Zeilenmitten" — and a rule proven
 * through Playwright is proven once, slowly, and only for the pixel positions
 * that run happened to produce.
 *
 * **The measurements are the real ones.** Round numbers hid two bugs once: a
 * card is about 600 px wide and 64 px tall with 8 px between cards, a docked
 * pair is two 296 px cards, and — the detail both bugs turned on — the grip
 * sits 23 px from the left edge, at four percent of a full-width card. A
 * fixture whose cards are 100 px wide makes that distance disappear.
 */

/** Where `.q-card__grip` sits inside a card, measured from its left edge. */
const GRIP_OFFSET = 23;

/** Three full-width cards, as the canvas stacks them. */
const stack: CardRect[] = [
  { id: 'a', left: 20, top: 20, width: 600, height: 64 },
  { id: 'b', left: 20, top: 92, width: 600, height: 64 },
  { id: 'c', left: 20, top: 164, width: 600, height: 64 },
];

/** The one layout that produces a multi-column row: two docked half cards. */
const halves: CardRect[] = [
  { id: 'a', left: 20, top: 20, width: 296, height: 64 },
  { id: 'b', left: 324, top: 20, width: 296, height: 64 },
];

/** The x a straight-down drag actually has — the grip's, not the card's. */
const gripX = 20 + GRIP_OFFSET;

/** Vertical middle of the n-th card of `stack`. */
function stackCentre(index: number): number {
  return 20 + index * 72 + 32;
}

describe('questionDropTarget', () => {
  /**
   * Docking, the requirement. The side thirds are unchanged; what is new is that
   * they only apply across the middle band of the card's height — see the
   * regression below for why.
   */
  describe('docking to half width', () => {
    it('docks left on the left zone and right on the right zone', () => {
      expect(questionDropTarget(halves, 'a', 340, 52)).toStrictEqual({
        id: 'b',
        zone: 'left',
      });
      expect(questionDropTarget(halves, 'a', 600, 52)).toStrictEqual({
        id: 'b',
        zone: 'right',
      });
    });

    /**
     * The boundary itself, because "a third" is where two behaviours meet and
     * an off-by-one there is invisible in a screenshot.
     */
    it('puts the docking boundary exactly at the documented fraction', () => {
      const boundary = 324 + 296 * DOCK_ZONE_FRACTION;

      expect(questionDropTarget(halves, 'a', boundary, 52)?.zone).not.toBe(
        'left',
      );
      expect(questionDropTarget(halves, 'a', boundary - 1, 52)?.zone).toBe(
        'left',
      );
    });

    /**
     * **The regression that matters.** Docking is a *sideways* gesture;
     * reordering is a vertical one. The grip sits at four percent of a
     * full-width card, so a perfectly ordinary straight-down drag has its
     * pointer deep inside the left docking third the whole way — and every
     * such drag used to end in two half-width cards instead of a reorder.
     *
     * The height decides: only across the middle band of the target card is a
     * side third a dock. The requirement speaks of the left and right third and
     * says nothing about the height, so this makes the rule precise rather
     * than narrower.
     */
    it('does not dock a straight-down drag along the grip column', () => {
      expect(questionDropTarget(stack, 'a', gripX, 100)).toStrictEqual({
        id: 'b',
        zone: 'before',
      });
      expect(questionDropTarget(stack, 'a', gripX, 148)).toStrictEqual({
        id: 'b',
        zone: 'after',
      });
    });

    it('docks along the grip column only level with the card', () => {
      const centre = stackCentre(1);
      const band = 64 * DOCK_BAND_FRACTION;

      expect(questionDropTarget(stack, 'a', gripX, centre)?.zone).toBe('left');
      // One pixel outside the band is a reorder again, in both directions.
      expect(questionDropTarget(stack, 'a', gripX, centre - band)?.zone).toBe(
        'before',
      );
      expect(questionDropTarget(stack, 'a', gripX, centre + band)?.zone).toBe(
        'after',
      );
    });
  });

  /**
   * The reported bug, as arithmetic: the middle zone has to say *which side*
   * of the target the card lands on. A middle zone that always meant "before"
   * made every downward drag a no-op — the card was lifted out and put back
   * exactly where it came from.
   */
  describe('the middle zone carries a direction', () => {
    it('lands before a stacked card while the pointer is in its upper half', () => {
      expect(questionDropTarget(stack, 'a', 320, 100)).toStrictEqual({
        id: 'b',
        zone: 'before',
      });
    });

    it('lands after a stacked card once the pointer passes its middle', () => {
      expect(questionDropTarget(stack, 'a', 320, 148)).toStrictEqual({
        id: 'b',
        zone: 'after',
      });
    });

    /**
     * **The second regression.** In a row of two docked half cards the
     * neighbours are left and right, so the horizontal midpoint decides. The
     * axis has to be read from the row as it is *laid out* — counting only the
     * cards that are not being dragged leaves one card in the row, calls it a
     * column, and swaps the two halves back onto the vertical axis, where a
     * sideways drag is a no-op. That is the original bug, mirrored.
     */
    it('swaps two docked half cards along the horizontal axis', () => {
      expect(questionDropTarget(halves, 'a', 500, 52)).toStrictEqual({
        id: 'b',
        zone: 'after',
      });
      expect(questionDropTarget(halves, 'a', 430, 52)).toStrictEqual({
        id: 'b',
        zone: 'before',
      });
    });
  });

  /**
   * The dead zones. Every one of these used to answer `null`, which is why
   * dropping a question "only worked at a few points": the gaps between cards,
   * the space beside a half-width card and the canvas padding above the first
   * and below the last card are all places a pointer naturally ends up.
   */
  describe('has no dead zones between and around the cards', () => {
    it('resolves the 8 px gap between two stacked cards', () => {
      // y = 88 is the middle of the gap between card a (20–84) and card b
      // (92–156) — equally far from both, so the earlier card wins and the
      // drop lands behind it.
      expect(questionDropTarget(stack, 'c', 320, 88)).toStrictEqual({
        id: 'a',
        zone: 'after',
      });
    });

    it('picks the nearer card when the gap is not crossed evenly', () => {
      expect(questionDropTarget(stack, 'c', 320, 85)).toStrictEqual({
        id: 'a',
        zone: 'after',
      });
      expect(questionDropTarget(stack, 'c', 320, 91)).toStrictEqual({
        id: 'b',
        zone: 'before',
      });
    });

    it('resolves the gap between two half-width cards', () => {
      // x = 320 is the middle of the 8 px gap between the two cards — no
      // card's rectangle, and card `a` is the one being dragged.
      expect(questionDropTarget(halves, 'a', 320, 52)).toStrictEqual({
        id: 'b',
        zone: 'before',
      });
    });

    it('targets beside the cards, where no rectangle reaches', () => {
      expect(questionDropTarget(halves, 'a', 700, 52)).toStrictEqual({
        id: 'b',
        zone: 'after',
      });
    });

    it('lands before the first card above the first row', () => {
      expect(questionDropTarget(stack, 'c', 320, -30)).toStrictEqual({
        id: 'a',
        zone: 'before',
      });
    });

    it('lands after the last card below the last row', () => {
      expect(questionDropTarget(stack, 'a', 320, 400)).toStrictEqual({
        id: 'c',
        zone: 'after',
      });
    });

    /**
     * The dragged card's own row is not a target either. With full-width
     * cards it is a row of its own, and a pointer resting on it has to reach
     * past it to the neighbour it is actually aiming at.
     */
    it('ignores the row the dragged card occupies alone', () => {
      expect(questionDropTarget(stack, 'b', 320, 120)?.id).not.toBe('b');
    });
  });

  it('never targets the card being dragged — it is always under its own pointer', () => {
    expect(questionDropTarget(halves, 'b', 400, 52)?.id).not.toBe('b');
    expect(questionDropTarget(stack, 'b', 320, 120)?.id).not.toBe('b');
  });

  it('has no target when the dragged card is the only one', () => {
    const sole: CardRect = {
      id: 'a',
      left: 20,
      top: 20,
      width: 600,
      height: 64,
    };

    expect(questionDropTarget([sole], 'a', 320, 52)).toBeNull();
    expect(questionDropTarget([], 'a', 320, 52)).toBeNull();
  });
});

/**
 * The deliberate cancel of `use-pointer-drag.ts`: a release outside the canvas
 * moves nothing. Now that the geometry always names a target, this is the rule
 * that keeps "let go over the page list" from reordering questions.
 */
describe('isWithinDropRange', () => {
  const canvas = { left: 100, top: 100, width: 400, height: 300 };

  it('accepts the canvas itself', () => {
    expect(isWithinDropRange(canvas, 300, 250)).toBe(true);
    expect(isWithinDropRange(canvas, 100, 100)).toBe(true);
    expect(isWithinDropRange(canvas, 500, 400)).toBe(true);
  });

  /**
   * Vertically forgiving, horizontally not. Above and below the canvas there
   * is nothing but more canvas — that is where "to the very top" and "to the
   * very end" are aimed, and losing a card there is the old complaint again.
   * Left and right there are the page list and the properties panel, only
   * 8 px away (`--space-3`), so a margin there would silently swallow drops
   * meant for a different column.
   */
  it('forgives a little above and below, but never sideways', () => {
    expect(isWithinDropRange(canvas, 300, 90)).toBe(true);
    expect(isWithinDropRange(canvas, 300, 410)).toBe(true);
    expect(isWithinDropRange(canvas, 96, 250)).toBe(false);
    expect(isWithinDropRange(canvas, 504, 250)).toBe(false);
  });

  it('rejects a release well outside it', () => {
    expect(isWithinDropRange(canvas, 20, 250)).toBe(false);
    expect(isWithinDropRange(canvas, 300, 600)).toBe(false);
  });
});

describe('pageDropIndex', () => {
  const rows = [
    { left: 0, top: 0, width: 200, height: 40 },
    { left: 0, top: 40, width: 200, height: 40 },
    { left: 0, top: 80, width: 200, height: 40 },
  ];

  it('returns the gap above a row while the pointer is in its upper half', () => {
    expect(pageDropIndex(rows, 5)).toBe(0);
    expect(pageDropIndex(rows, 45)).toBe(1);
    expect(pageDropIndex(rows, 85)).toBe(2);
  });

  it('returns the gap below the last row when the pointer is past every midpoint', () => {
    expect(pageDropIndex(rows, 300)).toBe(3);
  });

  it('has no rows to compare against in an empty list', () => {
    expect(pageDropIndex([], 10)).toBe(0);
  });
});

describe('toDestinationIndex', () => {
  /**
   * The off-by-one of every list reorder: once the row is lifted out, the gaps
   * after it shift down by one. Dropping row 0 into gap 2 lands at index 1.
   */
  it('corrects for the row that was lifted out', () => {
    expect(toDestinationIndex(0, 2)).toBe(1);
    expect(toDestinationIndex(2, 0)).toBe(0);
    expect(toDestinationIndex(1, 1)).toBe(1);
  });

  /**
   * Both gaps that touch the dragged row mean "stays where it is" — the fact
   * `PageList` needs in order *not* to draw an insertion line there. A line at
   * a gap that changes nothing is what made a downward page drag look broken.
   */
  it('maps both gaps around the dragged row back onto it', () => {
    expect(toDestinationIndex(1, 1)).toBe(1);
    expect(toDestinationIndex(1, 2)).toBe(1);
  });
});
