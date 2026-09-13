import type { ReactNode } from 'react';

import { useFocusTrap } from '../../shell/use-focus-trap';

/**
 * **The off-canvas sheet of the builder below 1180 px** — „Seiten" or
 * „Eigenschaften", depending on which trigger opened it.
 *
 * ## Why it is a component of its own, and not a `<div>` in `BuilderView`
 *
 * Exactly **that** was the finding (2026-08-10). It was the only one of the
 * eight overlays of this application without `useFocusTrap`: tab ran out of it
 * into the page behind, the focus did not wander into it on opening and not
 * back on closing, and **escape did not close it**. The affected test stayed
 * green because it only checked „Öffnen und Schließen" and both went through
 * the button; what found it was the **comparison** with the seven others.
 *
 * The first repair attempt called `useFocusTrap` at the top of `BuilderView`,
 * and **it had no effect** — the effect of the hook runs when the *view* is
 * mounted, and at that point the sheet does not exist yet; its `panelRef`
 * pointed at nothing, and a later opening does not hang it in afterwards. The
 * assertion in `keyboard-flow.spec.ts` uncovered that („Nach 1 × Tab hat der
 * Fokus das Sheet verlassen"), not a consideration.
 *
 * Hence this component: it is mounted **with** the sheet, so the effect runs
 * when the panel really exists. That is the same construction
 * `MobileMenuSheet`, `PublishNotice`, `TemplateDrawer`, `TemplateSavePrompt`,
 * `AiFormDialog`, `ResponseDetailPanel` and `LogoCropDialog` already have —
 * there is no second way of building a focus cage into this application.
 *
 * ## `aria-modal="true"`
 *
 * Formally a non-modal dialog is not obliged to catch the focus. At 360 px,
 * however, this sheet fills the screen and lies over everything, so "not
 * modal" does not describe what is to be seen — and a screen reader that goes
 * on offering the page behind leads along a content nobody can touch.
 *
 * ## No `openerRef`
 *
 * The two triggers („Seiten", „Eigenschaften") stay active while the sheet
 * stands, so the element with the focus at the moment of mounting *is* the
 * trigger — the same situation as with the hamburger in `MobileMenuSheet`, and
 * the detailed reasoning stands there.
 */
export interface BuilderSheetProps {
  /** Which of the two contents — determines the accessible name alone. */
  readonly kind: 'pages' | 'panel';
  readonly onClose: () => void;
  readonly children: ReactNode;
}

export function BuilderSheet({
  kind,
  onClose,
  children,
}: BuilderSheetProps): React.JSX.Element {
  const { panelRef, onKeyDown } = useFocusTrap({ onClose });

  return (
    <div
      className="builder__sheet"
      role="dialog"
      aria-modal="true"
      aria-label={kind === 'pages' ? 'Seiten' : 'Eigenschaften'}
      tabIndex={-1}
      ref={panelRef}
      onKeyDown={onKeyDown}
    >
      <button type="button" className="builder__sheet-close" onClick={onClose}>
        Schließen
      </button>
      {children}
    </div>
  );
}
