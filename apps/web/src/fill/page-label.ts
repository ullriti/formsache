/**
 * „Seite 2 von 3 · Verpflegung" — the one sentence both halves of the progress
 * block use.
 *
 * It lives outside the two components because they can now be shown
 * independently: `showPageNumbers` renders it as text, `showProgress` puts the
 * same sentence into the bar's `aria-valuetext`. With a form that shows only
 * the bar, this is the *only* place the page count is expressed at all — so a
 * screen reader still announces "Seite 2 von 3 · Verpflegung" instead of the
 * bare numbers `aria-valuenow`/`aria-valuemax` would imply.
 */
export function pageLabel(
  currentPage: number,
  totalPages: number,
  pageTitle: string | undefined,
): string {
  return (
    `Seite ${String(currentPage)} von ${String(totalPages)}` +
    (pageTitle === undefined || pageTitle === '' ? '' : ` · ${pageTitle}`)
  );
}
