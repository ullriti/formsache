import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { DEFAULT_TENANT_BRANDING } from '@formsache/shared';
import { describe, expect, it } from 'vitest';

import {
  findColorLiteral,
  findNamedColor,
} from '../../../../tools/eslint-rules/color-literals.js';
import { DESKTOP_BREAKPOINT_PX } from './breakpoints';

// The jsdom environment turns `import.meta.url` into an http URL, so the paths
// are taken from the working directory instead — Vitest runs each workspace
// project from its own package root.
const SRC_DIR = resolve(process.cwd(), 'src');
const STYLES_DIR = join(SRC_DIR, 'styles');

/**
 * The token layer is the one place where colour literals belong; every other
 * stylesheet has to go through `var(--…)`.
 */
const TOKEN_STYLESHEET = 'tokens.css';

function collectStylesheets(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      return collectStylesheets(path);
    }

    return entry.isFile() && entry.name.endsWith('.css') ? [path] : [];
  });
}

/** Strips `/* … *\/` comments so prose about colours is not mistaken for one. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Declaration values only. Property names are skipped on purpose: a token
 * called `--color-danger-bg` is a name, not a hardcoded value.
 */
function declarationValues(css: string): string[] {
  return [...stripComments(css).matchAll(/:([^;{}]*)[;}]/g)].map(
    (match) => match[1] ?? '',
  );
}

/** The token layer's text — read once, used by every block below. */
const TOKEN_CSS = readFileSync(join(STYLES_DIR, TOKEN_STYLESHEET), 'utf8');

/**
 * The literal behind a token name, resolving one level of `var(…)`.
 *
 * Throws rather than answering `undefined` for a token that is not declared: a
 * missing token is a renamed axis, and every caller here would otherwise
 * compare `undefined` with `undefined` somewhere and pass.
 */
function tokenValue(name: string): string {
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(
    stripComments(TOKEN_CSS),
  );
  const raw = match?.[1]?.trim();
  if (raw === undefined) {
    throw new Error(`Token ${name} is not declared in ${TOKEN_STYLESHEET}`);
  }
  const reference = /^var\((--[\w-]+)\)$/.exec(raw);
  return reference?.[1] === undefined ? raw : tokenValue(reference[1]);
}

/** The two tokens a focus indicator may be drawn in (Konzept no. 19). */
const FOCUS_TOKENS = new Set(['--color-focus', '--color-focus-on-ink']);

/**
 * Declarations that actually paint a focus indicator.
 *
 * `outline-offset` and `outline-width` carry no colour, and a `background` on a
 * focused row is a hover-style affordance rather than the indicator WCAG 2.4.11
 * measures — listing the ring properties explicitly keeps the check about the
 * ring.
 */
const RING_PROPERTIES =
  /^(outline|box-shadow|border-color|border-[a-z]+-color)$/;

interface CssRule {
  readonly selector: string;
  readonly body: string;
}

/**
 * Relative luminance of an `#rrggbb` colour, per WCAG 2.x.
 *
 * At file scope because two blocks below need it — the focus indicator (3:1,
 * WCAG 1.4.11) and the text tones (4.5:1, WCAG 1.4.3).
 */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const [red = 0, green = 0, blue = 0] = channels;
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(a: string, b: string): number {
  const [dark, light] = [luminance(a), luminance(b)].sort(
    (one, other) => one - other,
  );
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

/**
 * Every declaration block whose selector list mentions `:focus`.
 *
 * Blocks are matched by their own braces — `[^{}]` on both sides — so an
 * `@media` prelude cannot swallow the rule inside it and, more importantly, a
 * rule cannot be read as running to the end of the file. That second mistake
 * would make the check report offenders from the *next* rule.
 */
function collectFocusRules(css: string): CssRule[] {
  return [...stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((match) => ({
      selector: (match[1] ?? '').trim().replace(/\s+/g, ' '),
      body: match[2] ?? '',
    }))
    .filter((rule) => rule.selector.includes(':focus'));
}

/** Colour tokens a focus rule references that are not focus tokens. */
function offendingColors(body: string): string[] {
  const offenders: string[] = [];

  for (const declaration of body.split(';')) {
    const [rawProperty, ...rest] = declaration.split(':');
    const property = (rawProperty ?? '').trim();
    const value = rest.join(':');
    if (!RING_PROPERTIES.test(property)) {
      continue;
    }

    for (const reference of value.matchAll(/var\((--[\w-]+)/g)) {
      const token = reference[1] ?? '';
      // Only colour tokens are judged; `--focus-ring-width` is a length that
      // legitimately appears in the same `outline` shorthand.
      if (token.startsWith('--color') && !FOCUS_TOKENS.has(token)) {
        offenders.push(token);
      }
    }
  }

  return offenders;
}

describe('design tokens', () => {
  const stylesheets = collectStylesheets(SRC_DIR);

  it('finds the stylesheets it is supposed to guard', () => {
    // Without this the suite would pass happily on an empty file list.
    expect(stylesheets.length).toBeGreaterThan(0);
    expect(stylesheets.some((path) => path.endsWith(TOKEN_STYLESHEET))).toBe(
      true,
    );
  });

  it.each(stylesheets.filter((path) => !path.endsWith(TOKEN_STYLESHEET)))(
    'uses no hardcoded colour outside the token layer: %s',
    (path) => {
      const offenders = declarationValues(readFileSync(path, 'utf8')).filter(
        (value) =>
          findColorLiteral(value) !== null || findNamedColor(value) !== null,
      );

      expect(offenders).toEqual([]);
    },
  );

  it('detects a hardcoded colour when there is one', () => {
    // Proves the check above is a check and not a tautology.
    expect(findColorLiteral('  background: #c8102e;')).toBe('#c8102e');
    expect(findColorLiteral('  color: rgba(0, 0, 0, 0.5);')).toBe('rgba(');
    expect(findNamedColor('  border-color: crimson;')).toBe('crimson');
  });

  it('accepts token references and non-colour values', () => {
    for (const value of [
      ' var(--color-accent)',
      ' 0 2px 8px var(--shadow-raised)',
      ' transparent',
      ' 1180px',
      " 'PT Serif', Georgia, serif",
    ]) {
      expect(findColorLiteral(value)).toBeNull();
      expect(findNamedColor(value)).toBeNull();
    }
  });

  describe('tenant overridability', () => {
    // These are the axes the tenant data model owns. Losing one
    // would silently make part of the branding unswitchable.
    it.each([
      '--tenant-accent',
      '--tenant-header-bg',
      '--tenant-canvas-bg',
      '--tenant-stripe-1',
      '--tenant-logo-height',
      '--gradient-stripe',
    ])('declares the tenant axis %s', (name) => {
      expect(TOKEN_CSS).toContain(`${name}:`);
    });

    // The semantic tokens components use must read through the tenant axes,
    // otherwise a tenant switch would change nothing visible.
    it.each([
      ['--color-accent', 'var(--tenant-accent)'],
      ['--color-header-bg', 'var(--tenant-header-bg)'],
      ['--color-canvas', 'var(--tenant-canvas-bg)'],
    ])('derives %s from %s', (token, source) => {
      expect(TOKEN_CSS).toContain(`${token}: ${source};`);
    });
  });

  /**
   * The defaults of the tenant axes **are** {@link DEFAULT_TENANT_BRANDING}.
   *
   * These three colours are written down twice and one of the two copies cannot
   * be removed: a CSS custom property cannot import a TypeScript constant, and
   * the shared constant cannot be a stylesheet. So the agreement is guarded
   * instead of assumed — which is the whole difference between a duplication
   * that is decided and one that is inherited.
   *
   * Why it has to hold: a branding colour the shared gate rejects makes the axis
   * **absent** from the inline style (`tenantThemeStyle` omits rather than
   * corrects), so the visitor sees the value from *this* file — while the API
   * reports `DEFAULT_TENANT_BRANDING` to the *Erscheinungsbild* tab as the
   * fallback in force. Drift means an organisation with one bad colour column is shown
   * one accent on the page and a different one in the editor that claims to be
   * showing the fallback. Nothing in either package noticed until this test.
   *
   * The seed's `UMBRELLA_TENANT` (`apps/api/prisma/seed.ts`) holds the same three
   * colours a third time and is deliberately **not** guarded here: that is one
   * concrete organisation's branding on its way into a database column. It looks like
   * the shipped default today and may be recoloured tomorrow without anything
   * here having an opinion — data, not a second definition.
   */
  describe('the fallback branding', () => {
    it.each([
      ['--tenant-accent', DEFAULT_TENANT_BRANDING.accent],
      ['--tenant-header-bg', DEFAULT_TENANT_BRANDING.headerBg],
      ['--tenant-canvas-bg', DEFAULT_TENANT_BRANDING.canvasBg],
    ])('states %s as the shared fallback does', (token, expected) => {
      expect(
        tokenValue(token),
        `${token} and DEFAULT_TENANT_BRANDING disagree — they are one look in ` +
          'two languages (packages/shared/src/branding.ts).',
      ).toBe(expected);
    });

    it('states the default stripe as the shared fallback does', () => {
      // In order, and complete: a stripe rebuilt from two of the three colours
      // is a different design, not a partly-right one.
      expect(
        ['1', '2', '3'].map((index) => tokenValue(`--tenant-stripe-${index}`)),
      ).toEqual([...DEFAULT_TENANT_BRANDING.stripeColors]);
    });
  });

  /**
   * The focus indicator, measured rather than asserted (Konzept no. 19).
   *
   * WCAG 1.4.11 („Non-text Contrast") and 2.4.11 („Focus Appearance") both ask
   * for at least 3:1 between the indicator and what it sits on. Until this
   * change the ring read `var(--color-accent-strong)`, so its contrast was
   * whatever an organisation had typed into its branding — the Dachorganisation gold lands at ~2.4:1
   * against white, and nothing stopped an organisation from choosing a pale silver.
   *
   * The numbers are computed from the token file itself, so a later „small
   * adjustment" to the colour has to survive this test rather than a reviewer's
   * eye.
   */
  describe('focus indicator contrast', () => {
    const WCAG_NON_TEXT_MINIMUM = 3;

    // Every light surface a focused control can sit on. `--color-canvas` is
    // absent on purpose: it is a tenant axis, so no fixed value could be
    // asserted — which is precisely why the ring must not be one either.
    it.each([
      '--color-surface',
      '--color-panel',
      '--color-panel-raised',
      '--color-surface-sunken',
      '--color-shell',
    ])('reaches 3:1 against %s', (surface) => {
      expect(
        contrast(tokenValue('--color-focus'), tokenValue(surface)),
      ).toBeGreaterThanOrEqual(WCAG_NON_TEXT_MINIMUM);
    });

    it.each(['--color-ink', '--color-ink-raised', '--color-ink-muted'])(
      'reaches 3:1 against the dark chrome %s',
      (surface) => {
        expect(
          contrast(tokenValue('--color-focus-on-ink'), tokenValue(surface)),
        ).toBeGreaterThanOrEqual(WCAG_NON_TEXT_MINIMUM);
      },
    );

    /**
     * The reason the token exists. Not a curiosity: if this ever passed, the
     * two assertions above would be satisfiable by the old accent as well and
     * would stop saying anything.
     */
    it('records that the Dachorganisation colour would not have reached it', () => {
      expect(
        contrast(tokenValue('--tenant-accent'), tokenValue('--color-surface')),
      ).toBeLessThan(WCAG_NON_TEXT_MINIMUM);
    });

    it('keeps the ring independent of the tenant axes', () => {
      // A `var(--tenant-…)` anywhere in the chain would put branding data back
      // in charge of the indicator, which is the decision being implemented.
      expect(tokenValue('--color-focus')).toMatch(/^#[0-9a-f]{6}$/i);
      expect(tokenValue('--color-focus-on-ink')).toMatch(/^#[0-9a-f]{6}$/i);
    });
  });

  /**
   * The text tones, measured — the requirement.
   *
   * 30 of the axe gate's 34 blocking findings were one and the same thing seen
   * from sixteen views: `--color-text-subtle` and `--color-text-faint` carried
   * the handoff's values (`#8b8474`, `#a29b8a`), which reach 3.72:1 and 2.77:1
   * on **white** — the friendliest background in the palette — where WCAG 1.4.3
   * asks 4.5:1 for text under 24 px. Every use of both is small text.
   *
   * The axe run is what proves the *views* are clean; this block is what keeps
   * the *values* honest between runs. It exists because the tempting repair for
   * a design review that finds these tones „too heavy" is to nudge the hex back
   * a step, and a nudge of one step is invisible in a diff and fatal here.
   *
   * `--color-canvas` is deliberately absent from the surfaces below, exactly as
   * it is from the focus block: it is a tenant axis. An organisation that picks a dark
   * canvas breaks these tones, and no value asserted here could prevent it —
   * that is the requirement's territory and is written up, not silently patched
   * (`docs/worklog/2026-08-10-f1-a11y-befunde.md`).
   */
  describe('text contrast', () => {
    const WCAG_TEXT_MINIMUM = 4.5;

    /** Every fixed light surface of the application, darkest last. */
    const LIGHT_SURFACES = [
      '--color-surface',
      '--color-panel-raised',
      '--color-surface-sunken',
      '--color-panel',
    ] as const;

    it.each([...LIGHT_SURFACES, '--color-shell'])(
      '--color-text-subtle reaches 4.5:1 against %s',
      (surface) => {
        expect(
          contrast(tokenValue('--color-text-subtle'), tokenValue(surface)),
        ).toBeGreaterThanOrEqual(WCAG_TEXT_MINIMUM);
      },
    );

    // `--color-shell` is **not** in this list, and that is the one asymmetry of
    // the scale: the lightest step clears AA on the card surfaces it is used
    // on and not on the canvas tone. The token's own comment says so; what
    // enforces it is the axe gate, which walks the rendered views.
    it.each(LIGHT_SURFACES)(
      '--color-text-faint reaches 4.5:1 against %s',
      (surface) => {
        expect(
          contrast(tokenValue('--color-text-faint'), tokenValue(surface)),
        ).toBeGreaterThanOrEqual(WCAG_TEXT_MINIMUM);
      },
    );

    // The two warning tones, where they are **text** rather than a dot or a
    // rule: „Tenant-Standard" on `.settings-card__inherited` and the „Entwurf"
    // pill of a form card, both 11.5 px on the soft warning ground.
    //
    // The second one is here because it was found the way these things are
    // normally found — a change elsewhere started rendering draft cards on the
    // dashboard, and the gate went red on a token nobody had touched. The tone
    // was always 3.60:1; only nothing had put text in it on a view axe visits.
    it.each([
      ['--color-warning', '--color-warning-bg-soft'],
      ['--color-warning', '--color-warning-bg'],
      ['--color-warning', '--color-surface'],
      ['--color-warning-alt', '--color-warning-bg-soft'],
      ['--color-warning-alt', '--color-warning-bg'],
      ['--color-warning-alt', '--color-surface'],
    ])('%s reaches 4.5:1 against %s', (tone, surface) => {
      expect(
        contrast(tokenValue(tone), tokenValue(surface)),
      ).toBeGreaterThanOrEqual(WCAG_TEXT_MINIMUM);
    });

    /**
     * The scale still has to *look* like a scale.
     *
     * Without this, „make it pass" has an obvious cheap answer — set both to
     * the body colour — which would satisfy every assertion above and throw
     * away the visual hierarchy the handoff is binding for.
     */
    it('keeps the four text steps in order and apart', () => {
      const steps = [
        '--color-text',
        '--color-text-muted',
        '--color-text-subtle',
        '--color-text-faint',
      ].map((token) => luminance(tokenValue(token)));

      for (const [index, step] of steps.entries()) {
        const previous = steps[index - 1];
        if (previous === undefined) {
          continue;
        }
        expect(
          step,
          `step ${String(index)} is lighter than the one before`,
        ).toBeGreaterThan(previous);
      }
    });
  });

  /**
   * The focus **call sites**, not the token.
   *
   * The contrast block above proves that `--color-focus` is a good colour; it
   * says nothing about whether anything uses it. A review turned every ring in
   * the application back to the tenant colour — undoing Konzept no. 19
   * completely — and the whole suite stayed green. This is the check that was
   * missing: every focus rule that draws a ring has to draw it in one of the
   * two focus tokens, and in nothing derived from the branding.
   */
  describe('focus rules', () => {
    const focusRules = stylesheets.flatMap((path) =>
      collectFocusRules(readFileSync(path, 'utf8')).map((rule) => ({
        ...rule,
        path,
      })),
    );

    it('finds the focus rules it is supposed to guard', () => {
      // Without this the check below would pass on an empty list — which is
      // exactly what a refactor that renames `:focus-visible` away looks like.
      expect(focusRules.length).toBeGreaterThanOrEqual(15);
    });

    it.each(
      focusRules.map((rule) => [`${rule.path} › ${rule.selector}`, rule]),
    )('draws %s in a focus token', (_name, rule) => {
      expect(offendingColors(rule.body)).toEqual([]);
    });

    it('detects a ring painted in the tenant colour', () => {
      // Proves the check is a check: this is verbatim what the call sites
      // looked like before Konzept no. 19, and what the review reverted them to.
      const reverted = collectFocusRules(
        '.q-card__grip:focus-visible { outline: 2px solid var(--color-accent); }',
      );

      expect(reverted).toHaveLength(1);
      expect(offendingColors(reverted[0]?.body ?? '')).toEqual([
        '--color-accent',
      ]);
    });

    it('reads only the rule’s own block, not the rest of the file', () => {
      // The trap this check has to avoid: cutting at the *file* end rather than
      // at the closing brace would drag the next rule's declarations in and
      // report an offender that is not in a focus rule at all.
      const rules = collectFocusRules(
        '.a:focus-visible { outline: 2px solid var(--color-focus); }\n' +
          '.b { border-color: var(--color-accent); }',
      );

      expect(rules).toHaveLength(1);
      expect(offendingColors(rules[0]?.body ?? '')).toEqual([]);
    });
  });

  /**
   * The wide container token: Antworten and
   * mail log read the wide variant, Benachrichtigungen keeps the
   * narrow one on purpose — the client said explicitly that 1200 px does not
   * suit that view. A regression here is either value drifting or a view
   * silently switching to the wrong token.
   */
  describe('wide container token', () => {
    const tokens = readFileSync(join(STYLES_DIR, TOKEN_STYLESHEET), 'utf8');
    const VIEWS_DIR = join(SRC_DIR, 'views');

    it('declares the wide variant next to the narrow one', () => {
      expect(tokens).toContain('--layout-container-max: 1000px;');
      expect(tokens).toContain('--layout-container-max-wide: 1200px;');
    });

    /**
     * What this test form can and cannot do, stated rather than implied: it
     * reads the stylesheet as text, so it catches a view that switches token
     * or drops the declaration — the regression it exists for. It does **not**
     * see a later override in a media query, in a more specific selector, or
     * in another stylesheet loaded alongside; only a browser resolves that.
     * `toContain('var(--layout-container-max-wide)')` would have been weaker
     * still: it matches the token *anywhere* in the file, including inside a
     * comment, so the assertion below binds it to the container's own
     * `max-width`.
     */
    function containerMaxWidth(fileName: string): string | undefined {
      const css = readFileSync(join(VIEWS_DIR, fileName), 'utf8');
      return /max-width:\s*var\((--layout-container-max(?:-wide)?)\)/.exec(
        css,
      )?.[1];
    }

    it.each(['responses-view.css', 'mail-log-view.css'])(
      '%s caps its container with the wide token',
      (fileName) => {
        expect(containerMaxWidth(fileName)).toBe('--layout-container-max-wide');
      },
    );

    it('notifications-view.css keeps capping its container with the narrow token', () => {
      expect(containerMaxWidth('notifications-view.css')).toBe(
        '--layout-container-max',
      );
    });
  });

  it('keeps the CSS breakpoint and the TypeScript constant in sync', () => {
    const tokens = readFileSync(join(STYLES_DIR, TOKEN_STYLESHEET), 'utf8');
    const match = /--layout-breakpoint-desktop:\s*(\d+)px/.exec(tokens);

    expect(match?.[1]).toBe(String(DESKTOP_BREAKPOINT_PX));
  });
});
