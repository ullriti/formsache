import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { stripeGradient, tenantThemeStyle } from './tenant-theme';

/**
 * The colour predicate itself is **not** tested here any more: it lives in `packages/shared/src/branding.ts` with the two server
 * gates, and its alphabet is pinned down in `branding.test.ts`. A second suite
 * over the same rule is how the two copies this module used to hold managed to
 * drift to different alphabets without anything going red.
 *
 * What is tested here is what this module actually decides — that a value the
 * predicate rejects does not reach a CSS declaration.
 *
 * That distinction cost a test: a probe used to stand here calling the imported
 * `isBrandColor` directly and asserting its alphabet. It was a test of
 * `packages/shared/src/branding.ts` that happened to live in this file — it
 * measured the shared module, never this one. A local copy reintroduced under a
 * *different name* (which is all `single-source.test.ts` can miss: it matches on
 * the guarded name) would have left it green while this module quietly widened
 * again. The replacement is `tenantThemeStyle` refusing `#fff` below: it asks
 * the output, so it holds whatever the rejection is spelled.
 */

describe('stripeGradient', () => {
  it('splits the stripe into equal hard-stop segments', () => {
    expect(stripeGradient(['#212226', '#7c0800', '#cea967'])).toBe(
      'linear-gradient(90deg, #212226 0.00% 33.33%, ' +
        '#7c0800 33.33% 66.67%, #cea967 66.67% 100.00%)',
    );
  });

  it('supports a colour count other than three', () => {
    expect(stripeGradient(['#131313', '#e30000'])).toBe(
      'linear-gradient(90deg, #131313 0.00% 50.00%, #e30000 50.00% 100.00%)',
    );
  });

  it('rejects the whole stripe when one colour is invalid', () => {
    // Dropping just the bad colour would silently render a stripe the tenant
    // never configured; falling back to the default is the honest outcome.
    expect(stripeGradient(['#212226', 'red', '#cea967'])).toBeUndefined();
  });

  it('returns nothing for an empty stripe', () => {
    expect(stripeGradient([])).toBeUndefined();
  });
});

describe('tenantThemeStyle', () => {
  it('maps the branding onto the tenant token axes', () => {
    const style = tenantThemeStyle({
      accent: '#e30000',
      headerBg: '#131313',
      canvasBg: '#cad0d3',
      stripe: ['#e30000', '#cad0d3', '#131313'],
      wideLogo: true,
    });

    expect(style['--tenant-accent']).toBe('#e30000');
    expect(style['--tenant-header-bg']).toBe('#131313');
    expect(style['--tenant-canvas-bg']).toBe('#cad0d3');
    expect(style['--gradient-stripe']).toContain('#e30000 0.00% 33.33%');
    expect(style['--tenant-logo-height']).toBe(
      'var(--layout-logo-height-wide)',
    );
  });

  it('omits axes the tenant does not configure', () => {
    const style = tenantThemeStyle({ accent: '#e30000' });

    // The ink stands **next to** the axis, not instead of it: it is not a
    // colour set by the Organisation but the consequence of one.
    expect(Object.keys(style).sort()).toEqual([
      '--color-on-accent',
      '--tenant-accent',
    ]);
  });

  /**
   * **The ink travels with the organisation colour** (finding of the a11y pass).
   *
   * `--color-on-accent` stands in the `:root` as dark ink, written for the gold
   * of the Dachorganisation. On a dark organisation colour a filled button is thereby
   * unreadable — 3,40:1 at the top and **2,29:1** at the lower end of the
   * gradient. Because the declaration lands inline next to the axis here, it
   * beats the `:root` value for the whole subtree, and **none** of the roughly
   * fifteen button rules has to know anything about it.
   *
   * What is measured is that the declaration **comes into being** — which ink
   * is the right one is measured by `readable-ink.test.ts` at the contrast
   * values. Without this case `inkOnAccent` stays a function nobody calls:
   * leaving out the one line in `tenantThemeStyle` made **no** test red before.
   */
  it('schreibt die Tinte neben die Organisationsfarbe, und wechselt sie mit ihr', () => {
    // Dark organisation colour → light text.
    expect(tenantThemeStyle({ accent: '#e30000' })['--color-on-accent']).toBe(
      'var(--color-on-accent-light)',
    );
    // The gold of the Dachorganisation → everything stays as it was.
    expect(tenantThemeStyle({ accent: '#cea967' })['--color-on-accent']).toBe(
      'var(--color-on-accent)',
    );
    // And without a valid organisation colour, nothing at all: the `:root`
    // value stays standing, as with every other axis of this module.
    expect(tenantThemeStyle({ accent: '#fff' })).toEqual({});
  });

  it('omits an axis whose value is not a safe colour literal', () => {
    // The default from tokens.css then stays in effect: broken branding
    // degrades to the Dachorganisation look, it does not inject CSS.
    const style = tenantThemeStyle({
      accent: '#fff; background: url(https://evil.example/pixel.png)',
      headerBg: '#131313',
    });

    expect(style['--tenant-accent']).toBeUndefined();
    expect(style['--tenant-header-bg']).toBe('#131313');
  });

  it('omits an axis whose colour is in the short form', () => {
    // The narrowing of the requirement, measured **through this module's output**
    // rather than by asking the predicate: `#fff` is a legal CSS colour and was
    // accepted by the wide rule that used to stand in this file, so it is
    // exactly the value a reintroduced local copy would let through. The axis
    // staying unset is the whole assertion — an alpha channel or a second
    // spelling of an organisation's colour never reaches a declaration.
    expect(tenantThemeStyle({ accent: '#fff' })).toEqual({});
    expect(tenantThemeStyle({ accent: '#ffffff80' })).toEqual({});
  });

  it('keeps the six-digit form the shared rule allows', () => {
    // The other side of the same coin: refusing everything would pass the test
    // above and render no branding at all.
    expect(tenantThemeStyle({ accent: '#cea967' })['--tenant-accent']).toBe(
      '#cea967',
    );
  });

  it('keeps a narrow logo at the default height', () => {
    expect(tenantThemeStyle({ wideLogo: false })).toEqual({});
  });
});

describe('tenant theme scope', () => {
  it('reaches the DOM as custom properties on the scope element', () => {
    // This is the whole mechanism behind B10: React has to hand `--…` keys to
    // `style.setProperty`, otherwise the cascade never sees the branding.
    render(
      <div data-testid="scope" style={tenantThemeStyle({ accent: '#e30000' })}>
        Inhalt
      </div>,
    );

    const scope = screen.getByTestId('scope');

    expect(scope.style.getPropertyValue('--tenant-accent')).toBe('#e30000');
  });
});
