import type { DropZone } from './builder-store';

/**
 * Where a pointer is, expressed as a drop target — the arithmetic of docking cards to half width, separated from the DOM so it can be tested without one.
 *
 * The hook feeds these functions plain rectangles. That is the whole reason
 * they exist: "the left third docks left" is a rule, and a rule proven through
 * a browser is proven slowly and once.
 */

export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface CardRect extends Rect {
  readonly id: string;
}

/** A card and the side of it a dragged card would land on. */
export interface QuestionDropTarget {
  readonly id: string;
  readonly zone: DropZone;
}

/**
 * Fraction of a card's width that counts as its left (and, mirrored, right)
 * docking zone.
 *
 * `0.3`, taken from the prototype's own implementation rather than rounded to
 * a third: the handoff README says „linkes Drittel" as prose, the running
 * reference uses `fx < 0.3` and `fx > 0.7`, and the reference is what the
 * design was reviewed against. The difference is three percent of a card, but
 * "pixelnah nachbauen" (Handoff, *Fidelity*) is easier to keep when the number
 * is copied rather than re-derived.
 */
export const DOCK_ZONE_FRACTION = 0.3;

/**
 * Half-height of the band, as a fraction of a card's height, within which a
 * side third actually docks.
 *
 * Docking is a **sideways** gesture; reordering is a vertical one. Without
 * this band the two are indistinguishable, and the layout decides against the
 * user: `.q-card__grip` sits 23 px from the left edge of a ~600 px card, so a
 * pointer dragged straight down from a grip is at four percent of the card's
 * width for the whole gesture — deep inside the left docking third. Every
 * downward drag ended in two half-width cards instead of a reorder.
 *
 * The band makes the rule precise rather than narrower: the requirement speaks of
 * the left and right *third* and says nothing about the height, so "level with
 * the card, in its side third" still satisfies it. `0.25` puts the band across
 * the middle half of the card's height.
 */
export const DOCK_BAND_FRACTION = 0.25;

/**
 * How far above and below the canvas a release still counts as a drop, in
 * pixels.
 *
 * Not zero, because the canvas edge is exactly where a card being dragged to
 * the very top or bottom of the list ends up, and losing the move there is the
 * "it only works at a few points" complaint in miniature.
 *
 * **Vertical only.** The columns of the builder sit `--space-3` — 8 px — apart,
 * so any sideways tolerance would reach into the page list and the properties
 * panel and turn a release over *them* into a reorder. See `isWithinDropRange`.
 */
export const DROP_TOLERANCE = 24;

function bottomOf(card: Rect): number {
  return card.top + card.height;
}

function rowTop(row: readonly CardRect[]): number {
  return Math.min(...row.map((card) => card.top));
}

function rowBottom(row: readonly CardRect[]): number {
  return Math.max(...row.map(bottomOf));
}

/**
 * Groups the cards into visual rows.
 *
 * The canvas is a `flex-wrap` container, so "row" is a measured fact, not a
 * structural one: cards belong together when their vertical spans overlap.
 * Document order is kept exactly as it comes in — it is what `before` and
 * `after` are relative to, and the layout never reorders (no CSS `order`), so
 * document order and reading order are the same thing here.
 */
function rowsOf(cards: readonly CardRect[]): CardRect[][] {
  const rows: CardRect[][] = [];
  for (const card of cards) {
    const current = rows.at(-1);
    if (current !== undefined && card.top < rowBottom(current)) {
      current.push(card);
    } else {
      rows.push([card]);
    }
  }
  return rows;
}

/** 0 while the pointer is inside the row, otherwise the distance to it. */
function rowDistance(row: readonly CardRect[], y: number): number {
  const top = rowTop(row);
  const bottom = rowBottom(row);
  if (y < top) {
    return top - y;
  }
  return y > bottom ? y - bottom : 0;
}

function horizontalDistance(card: Rect, x: number): number {
  if (x < card.left) {
    return card.left - x;
  }
  const right = card.left + card.width;
  return x > right ? x - right : 0;
}

/**
 * The card a dragged card would land next to, and on which side.
 *
 * **Forgiving on purpose.** The earlier version answered only when the pointer
 * was inside a card's rectangle, which made the gaps between cards, the space
 * beside a half-width card and the padding above the first and below the last
 * card into dead zones — a drag that "only works at a few points". Anywhere in
 * the canvas now names a target: the nearest row, then the nearest card in it.
 * Whether a release *counts* is a separate question, answered by
 * `isWithinDropRange`.
 *
 * The zone is never merely "this card". `left` and `right` are the docking
 * gesture of the requirement: the documented side thirds, inside the rectangle,
 * and only across the middle band of the card's height (`DOCK_BAND_FRACTION`)
 * — docking is a deliberate sideways aim, not something a downward drag should
 * fall into. Everything else resolves to `before` or `after` — a direction,
 * which is what a reorder needs and what the ambiguous `mid` never had:
 * dropping onto the card below used to mean "insert before it", i.e. exactly
 * the slot the dragged card came from, so dragging downwards did nothing.
 *
 * Returns `null` only when there is nothing to aim at — an empty canvas, or one
 * holding just the card being dragged.
 */
export function questionDropTarget(
  cards: readonly CardRect[],
  draggedId: string,
  x: number,
  y: number,
): QuestionDropTarget | null {
  // Rows come from the **laid-out** list, dragged card included. The row is
  // what tells the two axes apart, and a row of two docked half cards has one
  // of them removed the moment it is picked up — counting only the others
  // would call that row a column and put a sideways swap back on the vertical
  // axis, where it is a no-op. Which card is dragged only matters when the
  // target inside the row is chosen.
  const rows = rowsOf(cards).filter((candidates) =>
    candidates.some((card) => card.id !== draggedId),
  );
  const firstRow = rows[0];
  const lastRow = rows.at(-1);
  if (firstRow === undefined || lastRow === undefined) {
    return null;
  }

  // Above everything and below everything are real targets, not "nothing":
  // the top and bottom of the list are where cards are most often dropped.
  const first = firstRow.find((card) => card.id !== draggedId);
  if (first !== undefined && y < rowTop(firstRow)) {
    return { id: first.id, zone: 'before' };
  }
  const last = lastRow.findLast((card) => card.id !== draggedId);
  if (last !== undefined && y > rowBottom(lastRow)) {
    return { id: last.id, zone: 'after' };
  }

  let row = firstRow;
  for (const candidate of rows) {
    if (rowDistance(candidate, y) < rowDistance(row, y)) {
      row = candidate;
    }
  }
  // The axis is a property of the row as laid out; the targets are not.
  const sideways = row.length > 1;
  const targets = row.filter((card) => card.id !== draggedId);

  const hit = targets.find(
    (card) =>
      x >= card.left &&
      x <= card.left + card.width &&
      y >= card.top &&
      y <= bottomOf(card),
  );
  if (hit !== undefined) {
    const centreY = hit.top + hit.height / 2;
    // Docking asks for a pointer *level with* the card, not merely somewhere
    // over its side third — see `DOCK_BAND_FRACTION`. Outside the band a side
    // third is an ordinary reorder, which is what a straight-down drag along
    // the grip column is.
    if (Math.abs(y - centreY) < hit.height * DOCK_BAND_FRACTION) {
      const fraction = (x - hit.left) / hit.width;
      if (fraction < DOCK_ZONE_FRACTION) {
        return { id: hit.id, zone: 'left' };
      }
      if (fraction > 1 - DOCK_ZONE_FRACTION) {
        return { id: hit.id, zone: 'right' };
      }
    }
    // Which midpoint decides follows the layout: in a row of one the
    // neighbours are above and below, in a row of several they are left and
    // right. Reading the axis the user is actually moving along is the
    // difference between a reorder that follows the hand and one that fights
    // it.
    const past = sideways ? x > hit.left + hit.width / 2 : y > centreY;
    return { id: hit.id, zone: past ? 'after' : 'before' };
  }

  let nearest = targets[0];
  if (nearest === undefined) {
    return null;
  }
  for (const card of targets) {
    if (horizontalDistance(card, x) < horizontalDistance(nearest, x)) {
      nearest = card;
    }
  }
  // Beside the card, the axis the pointer has actually left decides: above or
  // below it that is the vertical one (the gap between two stacked cards),
  // level with it the horizontal one (the empty half next to a docked card).
  if (y < nearest.top) {
    return { id: nearest.id, zone: 'before' };
  }
  if (y > bottomOf(nearest)) {
    return { id: nearest.id, zone: 'after' };
  }
  return {
    id: nearest.id,
    zone: x > nearest.left + nearest.width / 2 ? 'after' : 'before',
  };
}

/**
 * Whether a release at this point still belongs to the canvas.
 *
 * This is where the deliberate cancel of the requirement now lives. It used to be
 * implicit in `questionDropTarget` answering `null` outside any card — which
 * also cancelled between two cards, where the user very much meant something.
 * Splitting the two makes the rule explicit and keeps it: released over the
 * page list or the properties panel, a card stays where it was, because
 * guessing a nearest target across half the screen would move cards nobody
 * aimed at.
 *
 * The tolerance is deliberately **vertical only**. Above and below the canvas
 * there is nothing to confuse it with, and that is where "to the very top" and
 * "to the very end" are aimed. To the left and right the neighbouring columns
 * begin 8 px away (`--space-3`), so a margin there would quietly claim
 * releases meant for them.
 */
export function isWithinDropRange(canvas: Rect, x: number, y: number): boolean {
  return (
    x >= canvas.left &&
    x <= canvas.left + canvas.width &&
    y >= canvas.top - DROP_TOLERANCE &&
    y <= bottomOf(canvas) + DROP_TOLERANCE
  );
}

/**
 * Insertion index for a dragged page row, from the row midpoints.
 *
 * Returns a *gap* index in `0..rows.length`, not a row index — "before row 2"
 * and "after the last row" are different targets and only a gap index can say
 * both.
 */
export function pageDropIndex(rows: readonly Rect[], y: number): number {
  for (const [index, row] of rows.entries()) {
    if (y < row.top + row.height / 2) {
      return index;
    }
  }
  return rows.length;
}

/**
 * Turns a gap index into the destination index of a move.
 *
 * The correction is the classic off-by-one of list reordering: once the
 * dragged row is lifted out, every gap after it shifts down by one. Dropping
 * row 0 into gap 2 lands at index 1, not 2.
 *
 * Note that *two* gaps map back onto the dragged row itself — the one above it
 * and the one below it. `PageList` uses that to draw no insertion line there:
 * a line at a gap that changes nothing is what made a downward page drag look
 * like it had failed.
 */
export function toDestinationIndex(from: number, gapIndex: number): number {
  return gapIndex > from ? gapIndex - 1 : gapIndex;
}
