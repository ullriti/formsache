/**
 * Layout breakpoints.
 *
 * CSS media queries cannot read custom properties, so the desktop breakpoint
 * exists twice: as `--layout-breakpoint-desktop` in `tokens.css` for style
 * rules, and here for the code that needs the number (off-canvas navigation,
 * pointer drag targets). `tokens.test.ts` fails when the two drift apart.
 */

/** Below this width the app switches to the compact/mobile layout. */
export const DESKTOP_BREAKPOINT_PX = 1180;

/** Media query string for "desktop layout", for `window.matchMedia`. */
export const DESKTOP_MEDIA_QUERY = `(min-width: ${String(DESKTOP_BREAKPOINT_PX)}px)`;

/**
 * **The second step of the header, between hamburger and full navigation.**
 *
 * The bar used to know one width. Above 1180 px it drew a fixed-height row and
 * let `text-overflow: ellipsis` decide what happened when the entries no longer
 * fit — which is how „Tenant-Verwal…" and „Systemverwal…" reached the screen:
 * a destination whose name is cut in half, on a wide desktop, with nothing in
 * the layout admitting that anything was dropped.
 *
 * Between the two widths the entries therefore carry **their symbol only**, and
 * the name travels along as a visually hidden span (plus `title`), so the
 * accessible name and the pointer tooltip stay whole while the row gets short
 * enough to fit. Nothing is truncated in either state, which is the property
 * `e2e/shell-desktop.spec.ts` measures.
 *
 * **Why a table and not one number.** How wide the labelled row needs to be
 * depends on how many entries a role actually sees — one for a plain member,
 * four for a superadmin working inside an organisation — and a single
 * threshold would have to serve the widest case, so a member would look at
 * bare symbols on a 1440 px screen for no reason. The numbers are the observed
 * break-off widths (a Organisations-Admin's three entries stopped fitting
 * below ~1300 px, a superadmin's four below ~1500 px) plus roughly 100 px of
 * headroom, because the exact width also depends on the organisation's name
 * and the signed-in person's address next to it.
 *
 * Index = number of entries. Index 0 never renders a nav at all.
 */
const NAV_LABEL_MIN_WIDTH_PX = [
  DESKTOP_BREAKPOINT_PX,
  DESKTOP_BREAKPOINT_PX,
  1260,
  1400,
  1600,
] as const;

/** Headroom per entry beyond the table, so a fifth one cannot fall through. */
const NAV_LABEL_STEP_PX = 200;

/**
 * From which viewport width a navigation of `entryCount` entries may show its
 * labels; below it the header draws symbols only.
 */
export function navLabelMinWidthPx(entryCount: number): number {
  const last = NAV_LABEL_MIN_WIDTH_PX.length - 1;
  if (entryCount <= last) {
    return (
      NAV_LABEL_MIN_WIDTH_PX[Math.max(entryCount, 0)] ?? DESKTOP_BREAKPOINT_PX
    );
  }
  // A fifth entry is not planned, but „not planned" is not „impossible", and
  // silently reusing the four-entry width would truncate again.
  return (
    (NAV_LABEL_MIN_WIDTH_PX[last] ?? DESKTOP_BREAKPOINT_PX) +
    (entryCount - last) * NAV_LABEL_STEP_PX
  );
}

/** The matching media query, for `window.matchMedia`. */
export function navLabelMediaQuery(entryCount: number): string {
  return `(min-width: ${String(navLabelMinWidthPx(entryCount))}px)`;
}
