import { useCallback, useEffect, useRef, useState } from 'react';

import { useBuilderStore } from './builder-store';
import {
  isWithinDropRange,
  pageDropIndex,
  questionDropTarget,
  toDestinationIndex,
  type CardRect,
  type QuestionDropTarget,
  type Rect,
} from './drag-geometry';

/**
 * Pointer-based drag for pages and questions.
 *
 * **No HTML5 drag-and-drop.** `dragstart`/`drop` do not fire for touch, and
 * the handoff is explicit that the two must behave identically. Pointer events
 * are one API for mouse, touch and pen, so there is one implementation rather
 * than two that drift.
 *
 * Three details carry the whole thing:
 *
 * - `setPointerCapture` on the grip, so a fast drag that outruns the cursor
 *   keeps receiving events instead of dropping the card in mid-air.
 * - `touch-action: none` on the grip (in CSS), or the browser scrolls the page
 *   instead of giving us the move — the single most common reason a
 *   hand-written touch drag "does not work on mobile".
 * - The move handler asks the DOM for rectangles and hands them to the pure
 *   functions in `drag-geometry.ts`; it decides nothing itself.
 */

/** Marks the elements the move handler measures. */
export const QUESTION_CARD_ATTRIBUTE = 'data-question-id';
export const PAGE_ROW_ATTRIBUTE = 'data-page-index';

function rectOf(element: Element): Rect {
  const box = element.getBoundingClientRect();
  return {
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
  };
}

function questionRects(container: HTMLElement): CardRect[] {
  return [
    ...container.querySelectorAll(`[${QUESTION_CARD_ATTRIBUTE}]`),
  ].flatMap((element) => {
    const id = element.getAttribute(QUESTION_CARD_ATTRIBUTE);
    return id === null ? [] : [{ id, ...rectOf(element) }];
  });
}

export interface QuestionDragHandlers {
  /** Ref for the canvas the cards live in — the measured container. */
  readonly containerRef: React.RefObject<HTMLDivElement | null>;
  /** `onPointerDown` for a card's grip. */
  readonly onGripPointerDown: (
    event: React.PointerEvent<HTMLElement>,
    questionId: string,
  ) => void;
}

export function useQuestionDrag(): QuestionDragHandlers {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const beginQuestionDrag = useBuilderStore((state) => state.beginQuestionDrag);
  const setDragTarget = useBuilderStore((state) => state.setDragTarget);
  const endQuestionDrag = useBuilderStore((state) => state.endQuestionDrag);
  const moveQuestion = useBuilderStore((state) => state.moveQuestion);

  const onGripPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>, questionId: string) => {
      // Secondary buttons open context menus; they are not a drag.
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();

      const grip = event.currentTarget;
      grip.setPointerCapture(event.pointerId);
      beginQuestionDrag(questionId);

      let target: QuestionDropTarget | null = null;

      const onMove = (moveEvent: PointerEvent): void => {
        const container = containerRef.current;
        if (container === null) {
          return;
        }
        const { clientX, clientY } = moveEvent;
        // Outside the canvas there is no target at all — not even a hinted
        // one. The geometry would happily name the nearest card from anywhere
        // on the screen; whether that counts is this hook's decision, and it
        // decides the same way it always has (see `onUp`).
        target = isWithinDropRange(rectOf(container), clientX, clientY)
          ? questionDropTarget(
              questionRects(container),
              questionId,
              clientX,
              clientY,
            )
          : null;
        setDragTarget(target?.id ?? null, target?.zone ?? null);
      };

      const finish = (): void => {
        grip.removeEventListener('pointermove', onMove);
        grip.removeEventListener('pointerup', onUp);
        grip.removeEventListener('pointercancel', onCancel);
        if (grip.hasPointerCapture(event.pointerId)) {
          grip.releasePointerCapture(event.pointerId);
        }
      };

      const onUp = (): void => {
        finish();
        if (target !== null && target.id !== questionId) {
          moveQuestion(questionId, target.id, target.zone);
        } else {
          // Released outside the canvas: the card stays where it was.
          // Cancelling is still the honest outcome — inside the canvas every
          // point now names a target, but guessing one from across the screen
          // would move cards the user did not aim at.
          endQuestionDrag();
        }
      };

      const onCancel = (): void => {
        finish();
        endQuestionDrag();
      };

      // Listeners on the *grip*, not on `window`: with pointer capture the
      // grip receives every move of this pointer wherever it goes, and keeping
      // them local means a second pointer (a second finger) cannot drive this
      // drag.
      grip.addEventListener('pointermove', onMove);
      grip.addEventListener('pointerup', onUp);
      grip.addEventListener('pointercancel', onCancel);
    },
    [beginQuestionDrag, setDragTarget, endQuestionDrag, moveQuestion],
  );

  return { containerRef, onGripPointerDown };
}

export interface PageDragHandlers {
  readonly containerRef: React.RefObject<HTMLUListElement | null>;
  readonly onGripPointerDown: (
    event: React.PointerEvent<HTMLElement>,
    index: number,
  ) => void;
}

export function usePageDrag(): PageDragHandlers {
  const containerRef = useRef<HTMLUListElement | null>(null);
  const beginPageDrag = useBuilderStore((state) => state.beginPageDrag);
  const setPageDropIndex = useBuilderStore((state) => state.setPageDropIndex);
  const endPageDrag = useBuilderStore((state) => state.endPageDrag);
  const movePage = useBuilderStore((state) => state.movePage);

  const onGripPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>, index: number) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();

      const grip = event.currentTarget;
      grip.setPointerCapture(event.pointerId);
      beginPageDrag(index);

      let gap = index;
      // A press that never moves ends on the grip, which is inside the list.
      let inRange = true;

      const onMove = (moveEvent: PointerEvent): void => {
        const container = containerRef.current;
        if (container === null) {
          return;
        }
        const rows = [
          ...container.querySelectorAll(`[${PAGE_ROW_ATTRIBUTE}]`),
        ].map(rectOf);
        inRange = isWithinDropRange(
          rectOf(container),
          moveEvent.clientX,
          moveEvent.clientY,
        );
        gap = pageDropIndex(rows, moveEvent.clientY);
        // Two of the gaps — the one above the dragged row and the one below
        // it — put the row back where it started. Showing an insertion line
        // there promises a move that will not happen, and half of a downward
        // drag is spent in exactly that gap.
        const idle = !inRange || toDestinationIndex(index, gap) === index;
        setPageDropIndex(idle ? null : gap);
      };

      const finish = (): void => {
        grip.removeEventListener('pointermove', onMove);
        grip.removeEventListener('pointerup', onUp);
        grip.removeEventListener('pointercancel', onCancel);
        if (grip.hasPointerCapture(event.pointerId)) {
          grip.releasePointerCapture(event.pointerId);
        }
      };

      const onUp = (): void => {
        finish();
        // The same deliberate cancel the question drag makes: released outside
        // the list — over the canvas, over the properties panel — the page
        // stays where it was. Without this a page moved wherever the pointer
        // happened to be let go, which is the one thing a drag must not do.
        if (inRange) {
          movePage(index, toDestinationIndex(index, gap));
        } else {
          endPageDrag();
        }
      };

      const onCancel = (): void => {
        finish();
        endPageDrag();
      };

      grip.addEventListener('pointermove', onMove);
      grip.addEventListener('pointerup', onUp);
      grip.addEventListener('pointercancel', onCancel);
    },
    [beginPageDrag, setPageDropIndex, endPageDrag, movePage],
  );

  return { containerRef, onGripPointerDown };
}

/**
 * Keyboard operation of a grip.
 *
 * The ▲/▼ buttons of the prototype were, incidentally, the keyboard's way of
 * reordering. Konzept no. 9 removed them, so the task moves onto the grip
 * itself: Space or Enter picks up, the arrows move, Enter drops, Escape
 * cancels and restores the original position.
 *
 * "Pick up" is a real mode rather than a decoration. Arrow keys move the
 * *document* only while something is held, so a user tabbing through the
 * builder cannot reorder a form by accident — and a screen reader is told when
 * the mode begins and ends, which is the difference between a control that is
 * operable and one that merely responds.
 */
export interface KeyboardDragOptions {
  /** Human name of the thing being moved — "Seite 2", "Frage 3". */
  readonly label: string;
  /** Current position, 1-based, for the announcement. */
  readonly position: number;
  readonly total: number;
  readonly onMove: (direction: 'prev' | 'next') => void;
  /** Puts the item back where it was picked up from. */
  readonly onCancel: () => void;
  /** Whether ←/→ count as movement, next to ↑/↓ (question cards wrap). */
  readonly horizontal: boolean;
}

export interface KeyboardDragResult {
  readonly held: boolean;
  readonly announcement: string;
  readonly onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
}

export function useKeyboardDrag(
  options: KeyboardDragOptions,
): KeyboardDragResult {
  const [held, setHeld] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const { label, position, total, onMove, onCancel, horizontal } = options;

  // A held item whose list changed under it (a save reloaded the form, the
  // page was switched) must not stay held: the next arrow key would move
  // something else.
  useEffect(() => {
    if (held && position > total) {
      setHeld(false);
    }
  }, [held, position, total]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      const moveKeys = horizontal
        ? ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']
        : ['ArrowUp', 'ArrowDown'];

      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        if (held) {
          setHeld(false);
          setAnnouncement(
            `${label} abgelegt an Position ${String(position)} von ${String(total)}.`,
          );
        } else {
          setHeld(true);
          setAnnouncement(
            `${label} angehoben. Mit den Pfeiltasten verschieben, Enter zum Ablegen, Escape zum Abbrechen.`,
          );
        }
        return;
      }

      if (event.key === 'Escape' && held) {
        event.preventDefault();
        setHeld(false);
        onCancel();
        setAnnouncement(`${label} zurückgesetzt.`);
        return;
      }

      if (held && moveKeys.includes(event.key)) {
        event.preventDefault();
        const direction =
          event.key === 'ArrowUp' || event.key === 'ArrowLeft'
            ? 'prev'
            : 'next';
        onMove(direction);
        return;
      }

      // Not held: the arrows belong to the page, not to us. Letting them
      // scroll is the correct behaviour, so nothing is prevented here.
    },
    [held, label, position, total, onMove, onCancel, horizontal],
  );

  return { held, announcement, onKeyDown };
}
