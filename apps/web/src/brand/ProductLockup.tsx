import type { ReactElement } from 'react';

import './product-lockup.css';

/**
 * The product's own name — the software, not the installation.
 *
 * Deliberately not read from any tenant or setting: „Formsache" is what this
 * application *is*, and it stays the same on every installation. The name of
 * the installation is a different thing and is rendered next to this one
 * (`LoginView`'s title).
 */
export const PRODUCT_NAME = 'Formsache';

/**
 * The signet of the product mark (ADR-0019, draft B) — the arms of the F
 * continue to the right as form lines, a third one joins below.
 *
 * **Inline SVG, not `<img src="….svg">`, and that is the whole reason this is
 * a component at all.** The colours have to come from the token layer, because
 * `formsache/no-hardcoded-colors` forbids a literal in `apps/web/src/**`; a
 * referenced file cannot read the document's custom properties, an inline tree
 * can. The same reasoning applies to the word mark next to it, which needs the
 * PT Serif shipped with the bundle.
 *
 * `aria-hidden`: this never appears without {@link PRODUCT_NAME} as text right
 * beside it, so a label here would only make screen readers say the name
 * twice — the same call `TenantMark` makes with its empty `alt`.
 */
function Signet(): ReactElement {
  return (
    <svg
      className="product-lockup__signet"
      viewBox="0 0 64 64"
      aria-hidden="true"
      focusable="false"
    >
      <rect
        className="product-lockup__ground"
        x="2"
        y="2"
        width="60"
        height="60"
        rx="15"
      />
      {/* The F: stem and two arms, one colour, overlapping flush. */}
      <g className="product-lockup__letter">
        <rect x="16" y="15" width="6" height="34" rx="3" />
        <rect x="16" y="15" width="19" height="6" rx="3" />
        <rect x="16" y="28" width="15" height="6" rx="3" />
      </g>
      {/* The continuation: three lines, each shorter than the one above. */}
      <g className="product-lockup__lines">
        <rect x="38.5" y="15" width="10.5" height="6" rx="3" />
        <rect x="34.5" y="28" width="13" height="6" rx="3" />
        <rect x="22" y="41" width="17" height="6" rx="3" />
      </g>
    </svg>
  );
}

/**
 * Signet and word mark, side by side — the product mark as it is used.
 *
 * The golden rule under the word is part of the design, not decoration: the
 * name stands on a form line, the same line the signet is built from.
 *
 * **Where this does *not* belong is the app header.** That header carries the
 * logo of the organisation whose data is on screen (`TenantMark`), and a
 * second mark next to it would put the vendor's badge where the tenant's
 * identity is. The product mark's places are the ones with no tenant in them:
 * the browser tab (`public/favicon.svg`) and the signed-out login card.
 *
 * Carries no placement of its own — no margins, no alignment. Where it sits is
 * the caller's business, and the caller wraps it (`LoginView`'s
 * `.login__brand`); a component that positions itself has to be un-positioned
 * at the second place it is used.
 */
export function ProductLockup(): ReactElement {
  return (
    <span className="product-lockup" data-testid="product-lockup">
      <Signet />
      <span className="product-lockup__word">{PRODUCT_NAME}</span>
    </span>
  );
}
