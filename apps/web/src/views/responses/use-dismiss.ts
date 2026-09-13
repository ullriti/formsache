import { useEffect } from 'react';
import type { RefObject } from 'react';

/**
 * Closes a popover on Escape and on a pointer press outside it.
 *
 * Extracted when the responses view grew its **second** popover — the export
 * menu next to the „⚙ Felder" menu. A popover that only
 * closes through its own button is a trap for anyone who clicks or tabs past
 * it, and two hand-written copies of that contract are two chances to get one
 * of them wrong.
 *
 * `area` is the element a press counts as "inside". It is deliberately the
 * popover's **anchor container** rather than the popover itself, so pressing
 * the button that opened it is not read as an outside press — which would
 * close and immediately reopen it.
 *
 * `pointerdown` and not `click`: a press that starts inside and ends outside
 * (a drag over a scrollbar, a text selection) is not a dismissal, and `click`
 * fires late enough that the popover is still under the cursor.
 */
export function useDismiss(
  isOpen: boolean,
  area: RefObject<HTMLElement | null>,
  onDismiss: () => void,
  /**
   * The trigger that gets the focus back after **Escape**
   * (a review finding).
   *
   * ⚠️ **Only after Escape, not after a press beside it.** Escape means „I want
   * to get away from here and carry on where I was" — without the handover the
   * focus lands at the start of the document, and the next tab key starts the
   * whole header from the beginning. A press beside it, by contrast, means „I
   * want to go *there*", and tearing the focus back would take the effect out
   * of the click.
   *
   * Optional, so that a caller without a trigger reference stays unchanged.
   */
  trigger?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onDismiss();
        trigger?.current?.focus();
      }
    };
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && area.current?.contains(target) === true) {
        return;
      }
      onDismiss();
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [isOpen, area, onDismiss, trigger]);
}
