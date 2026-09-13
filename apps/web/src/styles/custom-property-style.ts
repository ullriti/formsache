import type { CSSProperties } from 'react';

/**
 * An inline `style` that carries CSS custom properties.
 *
 * Data-driven colours reach the stylesheet as `--…` variables, never as a
 * generated declaration string and never as a hard-coded literal in a `.css`
 * file (`CONTRIBUTING.md`) — a group tint, an organisation's accent, a stripe gradient.
 * React's own `CSSProperties` has no room for a custom property, so every such
 * style needs this widening; it was declared three times under `views/` before
 * (`TintStyle` twice, `PreviewStyle` once) and is one type in one place now.
 * `TenantThemeStyle` in `tenant-theme.ts` is this type under the name the shell
 * knows it by — kept as an alias so the theme module reads as its own subject.
 */
export type CustomPropertyStyle = CSSProperties & Record<`--${string}`, string>;
