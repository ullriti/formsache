import { isBrandColor } from '@formsache/shared';

import type { CustomPropertyStyle } from './custom-property-style';
import { inkOnAccent } from './readable-ink';

/**
 * Runtime tenant theming.
 *
 * The tenant branding is turned into inline CSS custom properties on the app
 * root element. Everything below that element resolves the semantic tokens of
 * `tokens.css` against these values, so a tenant switch changes the whole
 * appearance without touching a single component.
 *
 * **Every element this style is put on also needs `data-tenant-theme`.** The
 * axes below are only half the mechanism: a semantic token like
 * `--color-accent: var(--tenant-accent)` is substituted where it is *declared*,
 * so it has to be declared on the scope element as well, and `tokens.css` does
 * that through a `[data-tenant-theme]` selector. Without the attribute the axes
 * are set and nothing reads them — which is exactly the defect the requirement
 * ran into; the long version of the story is in `tokens.css`.
 *
 * Why inline custom properties on a scope element and not a generated
 * stylesheet:
 * - Branding is per-tenant row data, so the values cannot be pre-authored in
 *   CSS; a generated stylesheet would have to be built and injected as text.
 * - Injecting CSS text means putting untrusted, admin-editable strings into
 *   the document — the same class of problem as `dangerouslySetInnerHTML`,
 *   which CONTRIBUTING.md rules out for user content.
 * - A scope element keeps the theme local: the tenant preview inside the
 *   tenant editor can render another tenant's colours without leaking them
 *   into the surrounding admin chrome.
 */

/**
 * The colour predicate is **imported, not restated** .
 *
 * It used to be a regular expression of its own here, next to a second one in
 * `packages/shared/src/auth.ts` — and the two had drifted to different
 * alphabets without anything going red, because a wider client-side rule is
 * invisible as long as the server refuses the difference anyway. Both
 * server-side gates and this last line of defence now ask `isBrandColor` from
 * `packages/shared/src/branding.ts`, and `single-source.test.ts` fails if a
 * copy comes back.
 *
 * This check stays in place regardless of the two server-side gates: what
 * reaches this module is a *parsed* string, and a parsed string is still an
 * arbitrary string. It is the last thing between admin-editable data and a CSS
 * declaration.
 */

/**
 * The branding axes a tenant owns, as this module is willing to receive them.
 *
 * Deliberately **more tolerant** than the shared `TenantBranding` (whose five
 * axes are all required): the tenant preview in the *Erscheinungsbild* tab
 * renders a half-filled draft while an editor is still picking colours, and the
 * shared type — the wire contract — has no shape for that. Parsing foreign data
 * stays at the fetch boundary; this module only renders what it is given, so a
 * structural type it can widen is the right one here. The shared type assigns
 * to it, which is what keeps the two from drifting apart.
 */
export interface TenantThemeInput {
  /** Primary colour: buttons, active states, stripes in the fill-out view. */
  readonly accent?: string | undefined;
  /** Background of the tenant header bar. */
  readonly headerBg?: string | undefined;
  /** Background tone of the form canvas; the admin chrome stays neutral. */
  readonly canvasBg?: string | undefined;
  /** Stripe of the organization colours, in order. Any length; three is the handoff default. */
  readonly stripe?: readonly string[] | undefined;
  /** `true` for wide word marks (Dachorganisation), `false`/absent for a logo. */
  readonly wideLogo?: boolean | undefined;
}

/** Inline style carrying CSS custom properties next to regular properties. */
export type TenantThemeStyle = CustomPropertyStyle;

/**
 * Builds the CSS stripe gradient the way the prototype does (`stripeFor()`):
 * equal hard-stop segments, left to right.
 *
 * All-or-nothing on purpose — a stripe with a rejected colour silently
 * dropped would render a different design than the tenant configured, so an
 * invalid list falls back to the default from `tokens.css`.
 */
export function stripeGradient(colors: readonly string[]): string | undefined {
  if (colors.length === 0 || !colors.every(isBrandColor)) {
    return undefined;
  }

  const segment = 100 / colors.length;
  const stops = colors.map(
    (color, index) =>
      `${color} ${(segment * index).toFixed(2)}% ${(segment * (index + 1)).toFixed(2)}%`,
  );

  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

/**
 * Translates tenant branding into the tenant token axes of `tokens.css`.
 *
 * Values that fail validation are omitted rather than corrected, so the
 * `:root` default stays in effect — a broken branding record degrades to the
 * Dachorganisation look instead of to an unstyled page.
 */
export function tenantThemeStyle(branding: TenantThemeInput): TenantThemeStyle {
  const style: TenantThemeStyle = {};

  if (branding.accent !== undefined && isBrandColor(branding.accent)) {
    style['--tenant-accent'] = branding.accent;
    // **And the ink on top of it** (finding of the a11y pass).
    //
    // In `:root`, `--color-on-accent` is the dark ink that was written for the
    // gold of the Dachorganisation. On a dark organization colour it is
    // unreadable — against the Musterstadt colour a filled button measures
    // **3,40:1** at the top and **2,29:1** at the lower end of its gradient.
    // Written here next to the axis, the inline declaration beats the `:root`
    // value for the whole subtree, without a single one of the ~15 button rules
    // having to know anything about it.
    //
    // The organization's colour stays **untouched**; what changes is the type
    // on top of it. That is one of the two answers this finding itself names.
    style['--color-on-accent'] = inkOnAccent(branding.accent);
  }

  if (branding.headerBg !== undefined && isBrandColor(branding.headerBg)) {
    style['--tenant-header-bg'] = branding.headerBg;
  }

  if (branding.canvasBg !== undefined && isBrandColor(branding.canvasBg)) {
    style['--tenant-canvas-bg'] = branding.canvasBg;
  }

  if (branding.stripe !== undefined) {
    // Overrides the composed gradient rather than the three `--tenant-stripe-*`
    // axes, because a tenant may configure a different number of colours.
    const gradient = stripeGradient(branding.stripe);
    if (gradient !== undefined) {
      style['--gradient-stripe'] = gradient;
    }
  }

  if (branding.wideLogo === true) {
    style['--tenant-logo-height'] = 'var(--layout-logo-height-wide)';
  }

  return style;
}
