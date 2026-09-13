import type { KeyboardEvent, RefObject } from 'react';
import { useEffect, useRef } from 'react';

/**
 * The modal-dialog behaviour the app's overlays share.
 *
 * Three of them exist — the off-canvas menu, the response slide-in and the
 * publish notice — and each carried its own, word-for-word identical copy of
 * this. That is how they came to share a defect as well (see `openerRef` and
 * the Shift+Tab case below): a fix landed on one and missed the other two.
 *
 * What a caller gets is the panel ref (the element that takes focus and holds
 * the cage) and a `keydown` handler to put on it. Everything else — the role,
 * the label, the scrim — stays with the caller, because those differ.
 */

/**
 * Elements that can hold focus inside a panel.
 *
 * **Form controls were missing here at first, and four overlays paid for
 * it** — `TemplateDrawer` (the rename field), `TemplateSavePrompt` (the
 * template's name), `AiFormDialog` (the description `<textarea>` and the title
 * field) and the mail log's detail panel (the `<iframe>` of
 * `SandboxedHtmlFrame`). The defect is worse than „one element is skipped":
 * the cage is built from *this* list, so an element the list does not know is
 * not merely passed over on the way round — it is **unreachable**. Tab from
 * what the list believes is the last control gets `preventDefault`ed and jumps
 * back to the first, and the field in between never sees the caret. Somebody
 * navigating by keyboard cannot type a template's name at all.
 *
 * `input[type="hidden"]` is excluded because it is not focusable — including
 * it would make `first.focus()` a no-op and drop focus out of the panel, which
 * is the very failure this hook exists to prevent. `disabled` controls are
 * excluded for the same reason.
 *
 * **Visibility is deliberately not filtered.** A control that is in the DOM but
 * `display: none` is not focusable either, and no `querySelectorAll` can say so
 * — it takes a layout query (`offsetParent`, `checkVisibility()`), which jsdom
 * answers „invisible" for *everything*, so every component test of every
 * overlay would go dark. None of the panels above hides a control while
 * rendering it (measured for all eight callers of this hook); if one
 * ever does, this is the line that has to grow a real visibility check, and
 * the symptom will be focus landing on nothing after a Tab at the edge.
 */
const FOCUSABLE = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  // Reachable by Tab in every browser, and the mail log puts the mail
  // body in one — see `SandboxedHtmlFrame`.
  'iframe',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export interface FocusTrap<T extends HTMLElement> {
  /** Goes on the panel, which needs `tabIndex={-1}` to be able to take focus. */
  readonly panelRef: RefObject<T | null>;
  readonly onKeyDown: (event: KeyboardEvent<T>) => void;
}

export function useFocusTrap<T extends HTMLElement = HTMLDivElement>({
  onClose,
  openerRef,
  fallbackRef,
}: {
  /** Escape. The caller decides what closing means. */
  readonly onClose: () => void;
  /**
   * The control that opened the panel, so focus can go back to it.
   *
   * Pass it whenever the trigger can be **disabled while the panel is open** —
   * a publish button that goes busy, for instance. Reading the opener off
   * `document.activeElement` at mount time fails exactly there: the browser
   * blurs a control the moment it becomes `disabled`, so what gets remembered
   * is `<body>`, and closing then focuses nothing at all. (jsdom does not blur
   * on `disabled`, which is why a component test does not notice.)
   *
   * Optional: for a trigger that stays enabled — the hamburger, a table row's
   * button — `document.activeElement` at mount is the same element, and there
   * is nothing to thread through.
   */
  readonly openerRef?: RefObject<HTMLElement | null>;
  /**
   * Where focus goes when the opener cannot take it back.
   *
   * `openerRef` covers a trigger that is disabled **while** the panel is open;
   * this covers the one that is disabled **by closing it**. The logo crop
   * dialog is exactly that: confirming starts the upload, the upload disables
   * the file picker, and `focus()` on a disabled control is a no-op in every
   * browser — focus lands on `<body>` and the next Tab starts at the top of the
   * page. jsdom focuses it anyway, so no component test can see this
   * (measured in a review).
   *
   * Give it something that survives the close: the field the panel belongs to,
   * carrying `tabIndex={-1}` so it can be focused programmatically without
   * joining the tab order.
   */
  readonly fallbackRef?: RefObject<HTMLElement | null>;
}): FocusTrap<T> {
  const panelRef = useRef<T>(null);

  /*
   * **`react-hooks/exhaustive-deps` warns twice about this effect, and it is
   * wrong both times.** Its advice — „copy `ref.current` into a variable inside
   * the effect" — is exactly what must not happen here: this cleanup wants the
   * element that exists at *unmount*, not the one that existed when the panel
   * opened. Copying early would restore focus to a control that has since been
   * replaced, or to `null` for a ref that was still empty on the first render.
   * The two warnings stood for four milestones so that a reader would meet
   * this paragraph instead of a bare `eslint-disable`. They are suppressed
   * since 2026-08-12 — with a line each that points back here, and for the
   * reason a tolerated warning always ends up being suppressed: it makes the
   * next, real warning invisible in a wall of yellow.
   *
   * The rule's warning is about a *stale* read, and the one thing that could
   * make it a real defect is a `openerRef`/`fallbackRef` whose **identity**
   * changes between renders: the effect would then re-run, its cleanup would
   * pull focus back to the opener while the panel is still open, and the
   * re-run would yank it into the panel again. That was checked rather than
   * assumed — all five refs handed to this hook come from `useRef`
   * (`BuilderView`'s `publishButtonRef` and `templatesButtonRef`,
   * `ResponsesView`'s `headingRef`, `TenantAppearanceTab`'s `field`), so their
   * identity is stable for the life of the component and the effect runs
   * exactly once. A future caller passing a freshly built object here would
   * break that, and it is the reason the parameters are typed `RefObject`
   * rather than „anything with a `.current`".
   */
  useEffect(() => {
    const focusedAtMount = document.activeElement;
    panelRef.current?.focus();

    return () => {
      // Without this, focus falls back to <body> and the next Tab starts at
      // the top of the page instead of at the control just used.
      //
      // The rule's advice — copy `.current` into a variable inside the effect —
      // is the defect here, not the fix; the paragraph above this `useEffect`
      // is the reason. Suppressed rather than left warning: a warning that is
      // permanently tolerated hides the next real one.
      // eslint-disable-next-line react-hooks/exhaustive-deps -- reading at unmount is the point
      const opener = openerRef?.current ?? focusedAtMount;
      if (opener instanceof HTMLElement) {
        opener.focus();
      }
      // **And check where it landed.** A disabled control silently refuses
      // focus, and so does one that has been unmounted — asking afterwards is
      // the only way to tell „it went back" from „it went nowhere" without
      // duplicating the browser's own idea of what is focusable.
      //
      // The test is „focus is nowhere", not „focus is not the opener": when the
      // panel was opened without anything focused — a file picker driven by a
      // label, for instance — the remembered element already *is* `<body>`, and
      // comparing against it would call that a successful restore. Measured in
      // a review, where exactly that made the fallback never fire.
      const landed = document.activeElement;
      if (
        fallbackRef?.current != null &&
        (landed === null || landed === document.body)
      ) {
        // Same rule, same reason as above: the fallback element wanted here is
        // the one that exists at unmount.
        // eslint-disable-next-line react-hooks/exhaustive-deps -- reading at unmount is the point
        fallbackRef.current.focus();
      }
    };
  }, [openerRef, fallbackRef]);

  const onKeyDown = (event: KeyboardEvent<T>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }

    if (event.key !== 'Tab') {
      return;
    }

    const panel = panelRef.current;
    if (panel === null) {
      return;
    }

    const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first === undefined || last === undefined) {
      return;
    }

    /*
      `-1` is the panel itself, which holds focus right after opening and is
      deliberately not in `FOCUSABLE` (`tabindex="-1"`). It is the reason this
      is an index rather than two identity comparisons: comparing against
      `first` alone let Shift+Tab out of the dialog on the very first keystroke
      after opening — the browser's own backwards step from the panel leads
      *before* it, into the page behind.
    */
    const index = focusable.indexOf(
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : panel,
    );

    if (event.shiftKey) {
      if (index <= 0) {
        event.preventDefault();
        last.focus();
      }
      return;
    }

    if (index === focusable.length - 1) {
      event.preventDefault();
      first.focus();
    }
  };

  return { panelRef, onKeyDown };
}
