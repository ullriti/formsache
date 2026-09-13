import { formDefinitionSchema, type FormDefinition } from '@formsache/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { activePage, useBuilderStore } from './builder-store';
import { PageList } from './PageList';
import { QuestionCanvas } from './QuestionCanvas';

/**
 * The gesture, end to end: grip → pointer events → geometry → document.
 *
 * `drag-geometry.test.ts` proves the arithmetic and `builder-store.test.ts`
 * the document rules. Neither would have caught the reported bug on its own,
 * because it lived exactly in the seam between them — a drop target that named
 * a card but not a side. This file drives the real components with real
 * pointer events, which is the level the user is complaining about.
 *
 * jsdom has no layout, so the rectangles are stubbed. That is honest here:
 * what is under test is the reasoning about rectangles, not the browser's
 * ability to produce them — the browser's part is `e2e/builder-drag.spec.ts`.
 */

const P1 = '019fe100-0000-7000-8000-0000000000b1';
const P2 = '019fe100-0000-7000-8000-0000000000b2';
const P3 = '019fe100-0000-7000-8000-0000000000b3';
const Q1 = '019fe100-0000-7000-8000-000000000011';
const Q2 = '019fe100-0000-7000-8000-000000000012';
const Q3 = '019fe100-0000-7000-8000-000000000013';

interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Gives an element a layout jsdom will never compute for it. */
function stubRect(element: Element, box: Box): void {
  const rect: DOMRect = {
    ...box,
    x: box.left,
    y: box.top,
    right: box.left + box.width,
    bottom: box.top + box.height,
    toJSON: () => box,
  };
  element.getBoundingClientRect = () => rect;
}

function question(id: string, label: string, width: 'full' | 'half' = 'full') {
  return {
    id,
    type: 'text' as const,
    label,
    hint: null,
    required: false,
    width,
    minLength: null,
    maxLength: null,
    pattern: null,
  };
}

function definition(): FormDefinition {
  return formDefinitionSchema.parse({
    pages: [
      {
        id: P1,
        title: 'Seite 1',
        questions: [
          question(Q1, 'Eins'),
          question(Q2, 'Zwei'),
          question(Q3, 'Drei'),
        ],
      },
      { id: P2, title: 'Seite 2', questions: [] },
      { id: P3, title: 'Seite 3', questions: [] },
    ],
  });
}

function questionOrder(): string[] {
  const page = activePage(useBuilderStore.getState());
  return (page?.questions ?? []).map((entry) => entry.label);
}

function widths(): string[] {
  const page = activePage(useBuilderStore.getState());
  return (page?.questions ?? []).map((entry) => entry.width);
}

function pageOrder(): string[] {
  return useBuilderStore.getState().pages.map((page) => page.id);
}

/**
 * The measurements of the real builder, not round numbers.
 *
 * A full-width card is about 600 px wide and 64 px tall with 8 px between
 * cards, and `.q-card__grip` sits 23 px from the left edge — four percent of
 * the card. That distance is the whole reason the first fix was wrong: with
 * 100 px cards the grip is halfway into the card and every drag looks central.
 */
const CARD_LEFT = 20;
const CARD_WIDTH = 600;
const CARD_HEIGHT = 64;
const CARD_PITCH = CARD_HEIGHT + 8;
const CANVAS = { left: 12, top: 0, width: 616, height: 260 };

/** The x a straight-down drag really has: the grip's, not the card's middle. */
const GRIP_X = CARD_LEFT + 23;

function canvasElement(): Element | null {
  const canvas = document.querySelector('.canvas');
  expect(canvas).not.toBeNull();
  return canvas;
}

/** Three full-width cards stacked, inside a canvas with a little padding. */
function layOutCanvas(): void {
  const canvas = canvasElement();
  if (canvas === null) {
    return;
  }
  stubRect(canvas, CANVAS);

  [...document.querySelectorAll('[data-question-id]')].forEach(
    (card, index) => {
      stubRect(card, {
        left: CARD_LEFT,
        top: cardTop(index),
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
      });
    },
  );
}

/** Two half-width cards side by side — the only multi-column row there is. */
function layOutHalves(): void {
  const canvas = canvasElement();
  if (canvas === null) {
    return;
  }
  stubRect(canvas, { ...CANVAS, height: 120 });

  const half = (CARD_WIDTH - 8) / 2;
  [...document.querySelectorAll('[data-question-id]')].forEach(
    (card, index) => {
      stubRect(card, {
        left: CARD_LEFT + index * (half + 8),
        top: cardTop(0),
        width: half,
        height: CARD_HEIGHT,
      });
    },
  );
}

function cardTop(index: number): number {
  return 20 + index * CARD_PITCH;
}

/** Vertical middle of the n-th card in the stub layout. */
function cardCentre(index: number): number {
  return cardTop(index) + CARD_HEIGHT / 2;
}

function grip(name: string): HTMLElement {
  return screen.getByRole('button', { name });
}

function drag(handle: HTMLElement, points: readonly [number, number][]): void {
  fireEvent.pointerDown(handle, { button: 0, pointerId: 1 });
  for (const [x, y] of points) {
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: x, clientY: y });
  }
  fireEvent.pointerUp(handle, { pointerId: 1 });
}

/**
 * jsdom implements neither pointer capture nor `PointerEvent` fully. The drag
 * only ever *calls* these, so no-ops are a faithful stand-in — and they are
 * restored afterwards so no other suite inherits them.
 */
const pointerCaptureStubs = {
  setPointerCapture(): void {
    // Nothing to capture without a real pointer.
  },
  hasPointerCapture(): boolean {
    return false;
  },
  releasePointerCapture(): void {
    // Mirror of `setPointerCapture`.
  },
};

describe('pointer drag of the builder ', () => {
  const original = new Map<string, unknown>();

  beforeAll(() => {
    for (const [name, stub] of Object.entries(pointerCaptureStubs)) {
      original.set(name, Reflect.get(HTMLElement.prototype, name));
      Reflect.set(HTMLElement.prototype, name, stub);
    }
  });

  afterAll(() => {
    for (const [name, value] of original) {
      Reflect.set(HTMLElement.prototype, name, value);
    }
  });

  beforeEach(() => {
    useBuilderStore.getState().reset();
    useBuilderStore.getState().load({
      id: 'form-1',
      title: 'Testformular',
      definition: definition(),
      revision: 1,
    });
  });

  describe('question cards', () => {
    /**
     * The bug as the user reported it, dragged the way a user drags it:
     * straight down the grip column. Two things had to be true for this to
     * work — the drop has to carry a direction, and four percent into the card
     * must not be read as "dock to the left". Either one alone still loses the
     * move.
     */
    it('moves a card downwards along the grip column', () => {
      render(<QuestionCanvas />);
      layOutCanvas();

      drag(grip('Frage 1 verschieben'), [
        [GRIP_X, cardCentre(1) - 24],
        [GRIP_X, cardCentre(1) + 24],
      ]);

      expect(questionOrder()).toStrictEqual(['Zwei', 'Eins', 'Drei']);
      // And it stayed a reorder: nothing was docked to half width on the way.
      expect(widths()).toStrictEqual(['full', 'full', 'full']);
    });

    it('still moves a card upwards along the grip column', () => {
      render(<QuestionCanvas />);
      layOutCanvas();

      drag(grip('Frage 3 verschieben'), [[GRIP_X, cardCentre(0) - 24]]);

      expect(questionOrder()).toStrictEqual(['Drei', 'Eins', 'Zwei']);
      expect(widths()).toStrictEqual(['full', 'full', 'full']);
    });

    /**
     * Docking is still reachable — it is a *sideways* gesture, so it asks for
     * a pointer level with the target card and well into its side third.
     */
    it('still docks two cards to half width', () => {
      render(<QuestionCanvas />);
      layOutCanvas();

      drag(grip('Frage 2 verschieben'), [
        [300, cardCentre(0)],
        [CARD_LEFT + 30, cardCentre(0)],
      ]);

      expect(questionOrder()).toStrictEqual(['Zwei', 'Eins', 'Drei']);
      expect(widths()).toStrictEqual(['half', 'half', 'full']);
    });

    /**
     * The second regression, at the level it bites: two docked half cards are
     * the only multi-column row the builder produces, and swapping them is a
     * sideways drag. Reading the row's axis after removing the dragged card
     * turns it into a column and the swap into a no-op.
     */
    it('swaps two docked half cards sideways', () => {
      useBuilderStore.getState().load({
        id: 'form-2',
        title: 'Testformular',
        definition: formDefinitionSchema.parse({
          pages: [
            {
              id: P1,
              title: 'Seite 1',
              questions: [
                question(Q1, 'Eins', 'half'),
                question(Q2, 'Zwei', 'half'),
              ],
            },
          ],
        }),
        revision: 1,
      });
      render(<QuestionCanvas />);
      layOutHalves();

      // From the left card's grip into the right half of the right card.
      drag(grip('Frage 1 verschieben'), [[500, cardCentre(0)]]);

      expect(questionOrder()).toStrictEqual(['Zwei', 'Eins']);
    });

    /**
     * The dead zones. Both points used to answer "no target", so releasing
     * there did nothing at all — which is what "geht nur an wenigen Punkten"
     * describes.
     */
    it('accepts a drop in the gap between two cards', () => {
      render(<QuestionCanvas />);
      layOutCanvas();

      // y = 88 is inside the 8 px gap between card 1 (20–84) and card 2
      // (92–156).
      drag(grip('Frage 3 verschieben'), [[GRIP_X, 88]]);

      expect(questionOrder()).toStrictEqual(['Eins', 'Drei', 'Zwei']);
    });

    it('accepts a drop in the canvas padding below the last card', () => {
      render(<QuestionCanvas />);
      layOutCanvas();

      drag(grip('Frage 1 verschieben'), [[GRIP_X, 250]]);

      expect(questionOrder()).toStrictEqual(['Zwei', 'Drei', 'Eins']);
    });

    /**
     * The deliberate cancel, kept: released over the page list or the
     * properties panel, nothing moves. It is now a rule of its own
     * (`isWithinDropRange`) rather than a side effect of missing every card.
     */
    it('cancels a release beside the canvas, where the other columns are', () => {
      render(<QuestionCanvas />);
      layOutCanvas();

      drag(grip('Frage 1 verschieben'), [
        [GRIP_X, cardCentre(1) + 24],
        // Eight pixels to the left of the canvas is the page list, not a
        // sloppy aim — no vertical tolerance may reach it.
        [CANVAS.left - 8, cardCentre(1)],
      ]);

      expect(questionOrder()).toStrictEqual(['Eins', 'Zwei', 'Drei']);
      expect(useBuilderStore.getState().draggingQuestionId).toBeNull();
    });

    it('marks the card it would land on, and on which side', () => {
      render(<QuestionCanvas />);
      layOutCanvas();

      const handle = grip('Frage 1 verschieben');
      fireEvent.pointerDown(handle, { button: 0, pointerId: 1 });
      fireEvent.pointerMove(handle, {
        pointerId: 1,
        clientX: GRIP_X,
        clientY: cardCentre(1) + 24,
      });

      const cards = [...document.querySelectorAll('[data-question-id]')];
      expect(cards[0]?.className).toContain('q-card--dragging');
      expect(cards[1]?.className).toContain('q-card--over-after');

      fireEvent.pointerUp(handle, { pointerId: 1 });
    });
  });

  describe('page rows', () => {
    const ROW_HEIGHT = 40;

    function layOutRows(): void {
      const rows = [...document.querySelectorAll('[data-page-index]')];
      const list = document.querySelector('.page-list__rows');
      expect(list).not.toBeNull();
      if (list !== null) {
        stubRect(list, {
          left: 0,
          top: 0,
          width: 200,
          height: rows.length * ROW_HEIGHT,
        });
      }
      rows.forEach((row, index) => {
        stubRect(row, {
          left: 0,
          top: index * ROW_HEIGHT,
          width: 200,
          height: ROW_HEIGHT,
        });
      });
    }

    it('moves a page down to the end', () => {
      render(<PageList />);
      layOutRows();

      // Past the midpoint of the last row — the gap below everything.
      drag(grip('Seite 1 verschieben'), [[100, 130]]);

      expect(pageOrder()).toStrictEqual([P2, P3, P1]);
    });

    it('moves a page up', () => {
      render(<PageList />);
      layOutRows();

      drag(grip('Seite 3 verschieben'), [[100, 10]]);

      expect(pageOrder()).toStrictEqual([P3, P1, P2]);
    });

    /**
     * The feedback a downward page drag was missing. The gap below the last
     * row is the target of "move this page to the end", and it has no row of
     * its own — so the last row marks it. Both gaps that touch the dragged row
     * mean "stays here" and must stay unmarked, or the line promises a move
     * that will not happen.
     */
    it('shows where the row would land, and nothing where it would not', () => {
      render(<PageList />);
      layOutRows();

      const handle = grip('Seite 1 verschieben');
      fireEvent.pointerDown(handle, { button: 0, pointerId: 1 });

      const rows = (): Element[] => [
        ...document.querySelectorAll('[data-page-index]'),
      ];
      expect(rows()[0]?.className).toContain('page-row--dragging');
      expect(document.querySelector('.page-row--drop-before')).toBeNull();

      // Still inside the two gaps that change nothing.
      fireEvent.pointerMove(handle, {
        pointerId: 1,
        clientX: 100,
        clientY: 50,
      });
      expect(document.querySelector('.page-row--drop-before')).toBeNull();
      expect(document.querySelector('.page-row--drop-after')).toBeNull();

      // Past the midpoint of the last row: it would land at the very end.
      fireEvent.pointerMove(handle, {
        pointerId: 1,
        clientX: 100,
        clientY: 130,
      });
      expect(rows()[2]?.className).toContain('page-row--drop-after');

      fireEvent.pointerUp(handle, { pointerId: 1 });
      expect(document.querySelector('.page-row--dragging')).toBeNull();
    });

    /**
     * The row switches pages on a click, so the drag must not read as one.
     * The grip is a control of its own and swallows the gesture; what a drag
     * changes is the *order* of the pages, never which one is being edited.
     */
    it('does not switch pages while a row is dragged', () => {
      render(<PageList />);
      layOutRows();

      expect(useBuilderStore.getState().activePageIndex).toBe(0);
      drag(grip('Seite 3 verschieben'), [[100, 10]]);

      const state = useBuilderStore.getState();
      expect(pageOrder()).toStrictEqual([P3, P1, P2]);
      // Still the page that was being edited — now at another index.
      expect(state.pages[state.activePageIndex]?.id).toBe(P1);
    });

    /**
     * The same deliberate cancel the question drag makes. Released beside the
     * list — over the canvas — the page stays where it is; before this the row
     * moved to wherever the pointer's *height* happened to be, whatever column
     * it was over.
     */
    it('cancels a release outside the list', () => {
      render(<PageList />);
      layOutRows();

      drag(grip('Seite 1 verschieben'), [
        [100, 130],
        [400, 130],
      ]);

      expect(pageOrder()).toStrictEqual([P1, P2, P3]);
      expect(useBuilderStore.getState().draggingPageIndex).toBeNull();
      expect(useBuilderStore.getState().pageDropIndex).toBeNull();
    });
  });
});
