import type { ReactElement } from 'react';

export interface PageProgressBarProps {
  /** 1-based index of the page currently shown. */
  readonly currentPage: number;
  readonly totalPages: number;
  /** „Seite 2 von 3 · Verpflegung" — see `page-label.ts`. */
  readonly label: string;
}

/**
 * The bar alone — the surface `showProgress` switches.
 *
 * **Split from the page count on purpose.** The bar and the sentence
 * „Seite 2 von 3" used to be one component, so one conditional decided both.
 * But `showProgress` and `showPageNumbers` are *two* settings of the handoff (* *Darstellung*), and an editor who turns the bar off has said nothing about
 * the numbers. One component would have made „Balken aus, Nummern an"
 * unreachable — the defect this work item exists for, one level down.
 *
 * `role="progressbar"` on a plain `<div>`, not the native `<progress>`
 * element: the bar has to carry the tenant's accent colour exactly — a design
 * token, never a hardcoded value (`CONTRIBUTING.md`) — and cross-browser
 * `<progress>` styling only reaches that through vendor-prefixed
 * pseudo-elements (`::-webkit-progress-value`, `::-moz-progress-bar`) that
 * would have to be maintained in parallel forever. A `<div>` with the ARIA
 * attributes spelled out by hand costs a few lines and stays in the same
 * hand-built styling model as the rest of this project (ADR-0002).
 */
export function PageProgressBar({
  currentPage,
  totalPages,
  label,
}: PageProgressBarProps): ReactElement {
  const percent =
    totalPages <= 0 ? 0 : Math.round((currentPage / totalPages) * 100);

  return (
    <div
      className="public__page-progress-track"
      role="progressbar"
      aria-valuenow={currentPage}
      aria-valuemin={1}
      aria-valuemax={totalPages}
      aria-valuetext={label}
    >
      <div
        className="public__page-progress-fill"
        style={{ width: `${String(percent)}%` }}
      />
    </div>
  );
}
