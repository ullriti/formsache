import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PRODUCT_NAME, ProductLockup } from './ProductLockup';

/**
 * The two files that carry the same drawing.
 *
 * `public/favicon.svg` cannot read a design token — a favicon is fetched
 * without the document, so there is no cascade to resolve `var()` against — and
 * it therefore repeats what {@link ProductLockup} draws through the token
 * layer. Two copies of one mark drift apart the first time somebody nudges a
 * rectangle in one of them, and nothing in a build would notice; this file is
 * what notices.
 *
 * The jsdom environment turns `import.meta.url` into an http URL, so the paths
 * come from the working directory instead — Vitest runs each workspace project
 * from its own package root (the same reasoning as `styles/tokens.test.ts`).
 */
const FAVICON = readFileSync(
  resolve(process.cwd(), 'public', 'favicon.svg'),
  'utf8',
);
const TOKENS = readFileSync(
  join(resolve(process.cwd(), 'src'), 'styles', 'tokens.css'),
  'utf8',
);
const LOCKUP_CSS = readFileSync(
  join(resolve(process.cwd(), 'src'), 'brand', 'product-lockup.css'),
  'utf8',
);

/** The three colour roles of the mark, in the order the signet draws them. */
const MARK_TOKENS = [
  '--brand-mark-ground',
  '--brand-mark-ink',
  '--brand-mark-accent',
] as const;

/** The `viewBox` of an SVG — the coordinate system every rectangle below sits in. */
function viewBox(svg: string): string | undefined {
  return /viewBox="([^"]*)"/.exec(svg)?.[1];
}

/** The geometry of every `<rect>`, in document order, as comparable text. */
function rectangles(svg: string): string[] {
  return [...svg.matchAll(/<rect\b[^>]*>/g)].map((match) => {
    const tag = match[0];
    return ['x', 'y', 'width', 'height', 'rx']
      .map((name) => {
        const value = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
        return `${name}=${value?.[1] ?? ''}`;
      })
      .join(' ');
  });
}

/** The literal behind a token name in `tokens.css`. */
function token(name: string): string {
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(TOKENS);
  if (match?.[1] === undefined) {
    throw new Error(`tokens.css declares no ${name}`);
  }
  return match[1].trim();
}

describe('favicon.svg', () => {
  /**
   * **The file has to be well-formed XML, not merely SVG-shaped text.**
   *
   * `index.html` links it as `type="image/svg+xml"`, and that content type is
   * parsed strictly: one malformed byte and the browser drops the whole
   * document, so the tab shows the generic page icon and nothing anywhere
   * reports why. That is exactly what happened — the header comment named a
   * custom property, the `--` in it is forbidden inside an XML comment, and
   * the product mark was missing from every tab for as long as nobody parsed
   * the file. Every other assertion in this file reads the source with regular
   * expressions, which is blind to precisely this class of defect.
   */
  it('parses as well-formed XML', () => {
    const document_ = new DOMParser().parseFromString(FAVICON, 'image/svg+xml');
    const failure = document_.querySelector('parsererror');

    expect(failure?.textContent ?? null).toBeNull();
    expect(document_.documentElement.tagName).toBe('svg');
    // A parse failure yields a document whose root is the error report, so the
    // shape of the drawing is asserted through the parser as well.
    expect(document_.querySelectorAll('rect')).toHaveLength(7);
  });
});

describe('ProductLockup', () => {
  it('names the product', () => {
    render(<ProductLockup />);

    expect(screen.queryByText(PRODUCT_NAME)).not.toBeNull();
  });

  it('hides the signet from assistive technology', () => {
    const { container } = render(<ProductLockup />);
    const signet = container.querySelector('svg');

    // The name is right next to it as text, so a labelled image here would be
    // read out twice — the call `TenantMark` makes with its empty `alt`.
    expect(signet?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('takes every colour from the token layer', () => {
    const { container } = render(<ProductLockup />);

    // Not a rendered colour: jsdom applies no stylesheet, so this asserts the
    // one thing that can go wrong in a component — a `fill` attribute spelled
    // into the markup, which would be invisible to the tokens *and* to
    // `formsache/no-hardcoded-colors` if it ever moved to a CSS-in-JS shape.
    for (const shape of container.querySelectorAll('rect')) {
      expect(shape.getAttribute('fill')).toBeNull();
    }
  });

  it('draws the same mark as the favicon', () => {
    const { container } = render(<ProductLockup />);
    const rendered = container.querySelector('svg')?.outerHTML ?? '';

    expect(rectangles(rendered)).toEqual(rectangles(FAVICON));
    expect(rectangles(rendered)).toHaveLength(7);
    // The coordinate system, not only the coordinates. Seven identical
    // rectangles in two different `viewBox`es are two different drawings, and
    // the comparison above cannot see the difference.
    expect(viewBox(rendered)).toBe(viewBox(FAVICON));
    expect(viewBox(rendered)).toBe('0 0 64 64');
  });

  it('keeps the favicon on the mark colours', () => {
    // The other half of the same guard: the geometry above is compared shape by
    // shape, the colours cannot be — the component has none to compare against,
    // it has class names. So the favicon is held against the tokens those
    // classes read, which is where the values are written down.
    const fills = [...FAVICON.matchAll(/fill="([^"]*)"/g)].map(
      (match) => match[1],
    );

    expect(fills).toEqual(MARK_TOKENS.map((name) => token(name)));
  });

  it('paints the signet from the mark tokens and nothing else', () => {
    // The gap the two tests above leave open, and the one that matters most:
    // they prove the component spells no colour and the favicon spells the
    // right ones — neither can see which token the stylesheet reaches for.
    // `.product-lockup__lines { fill: var(--color-accent) }` would compile,
    // render, pass every other case here, and make the product mark follow
    // whatever accent colour an admin typed into their branding.
    const fills = [...LOCKUP_CSS.matchAll(/fill:\s*var\((--[\w-]+)\)/g)].map(
      (match) => match[1],
    );

    expect(fills).toEqual([...MARK_TOKENS]);
    // Nothing paints a fill from anywhere else — a fourth declaration reading
    // a plain colour or a tenant axis would not show up in the list above.
    expect([...LOCKUP_CSS.matchAll(/fill:/g)]).toHaveLength(MARK_TOKENS.length);
  });

  it('keeps the mark colours free of tenant branding', () => {
    // The point of ADR-0019 in one assertion. Every other colour of this
    // application follows the organisation whose data is on screen; if one of
    // these three ever started reading a tenant axis, the product mark would
    // change with the accent colour — and it appears where there is no tenant at all
    // (browser tab, signed-out login).
    for (const name of MARK_TOKENS) {
      expect(token(name)).not.toContain('var(');
    }
  });
});
