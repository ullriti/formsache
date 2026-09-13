import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AA_TEXT_CONTRAST,
  bestInkContrast,
  bestInkContrastOnAccent,
  contrastAsText,
  inkOn,
  inkOnAccent,
} from './readable-ink';

/**
 * The ink on an organisation's own colour.
 *
 * The axe gate found eleven nodes where a fixed foreground sat on a group
 * colour that came out of the database: the member avatars and the permission
 * pills, at 1.51:1 on the seeded admin red. What is measured here is the
 * **contrast the pairing achieves**, not which of the two tokens comes back —
 * a later change to what „the light ink" is may not quietly make the pairing
 * unreadable, and a test that only compared strings would not notice.
 *
 * The token values are read out of `tokens.css` rather than written down here,
 * for the same reason: the assertion is about the pairing, and the pairing has
 * two ends.
 */

const TOKEN_CSS = readFileSync(
  join(resolve(process.cwd(), 'src'), 'styles', 'tokens.css'),
  'utf8',
);

/** The literal a `var(--…)` reference resolves to in the token layer. */
function resolveInk(reference: string): string {
  const name = /^var\((--[a-z-]+)\)$/u.exec(reference)?.[1];
  expect(name, `„${reference}" is not a plain var() reference`).toBeDefined();

  const pattern = new RegExp(`${String(name)}:\\s*(#[0-9a-f]{3,6})\\s*;`, 'iu');
  const literal = pattern.exec(TOKEN_CSS)?.[1];
  expect(
    literal,
    `${String(name)} is not declared as a literal in tokens.css`,
  ).toBeDefined();
  return String(literal);
}

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

describe('inkOn', () => {
  /** The four group colours the seed writes, plus two an organisation could type. */
  const COLORS = [
    '#7c0800', // admin red — 1.51:1 under the old fixed ink
    '#8a6a12', // editor gold
    '#5b6b52', // viewer green
    '#e30000', // Musterstadt red
    '#cad0d3', // a pale silver Organisationsfarbe
    '#131313', // a near-black one
  ];

  it.each(COLORS)('reaches 4.5:1 on %s', (color) => {
    expect(contrast(resolveInk(inkOn(color)), color)).toBeGreaterThanOrEqual(
      4.5,
    );
  });

  it('never picks the worse of the two inks', () => {
    // The claim the function actually makes. It is deliberately weaker than
    // „always 4.5:1": around the crossover neither ink reaches AA, and a
    // function that pretended otherwise would be hiding the case that needs a
    // warning at the input instead.
    for (let value = 0; value <= 0xff_ff_ff; value += 0x01_11_37) {
      const color = `#${value.toString(16).padStart(6, '0')}`;
      const chosen = contrast(resolveInk(inkOn(color)), color);
      const dark = contrast(resolveInk('var(--color-on-accent)'), color);
      const light = contrast(resolveInk('var(--color-on-accent-light)'), color);
      expect(chosen, `on ${color}`).toBeCloseTo(Math.max(dark, light), 10);
    }
  });

  it('returns a token reference, never a colour of its own', () => {
    // `CONTRIBUTING.md`: a hard-coded hex outside the token layer is a bug, and
    // this module is the one that would be tempted to spell one.
    for (const color of COLORS) {
      expect(inkOn(color)).toMatch(/^var\(--[a-z-]+\)$/u);
    }
  });

  it('falls back to the dark ink for a colour it cannot read', () => {
    // Unreachable through the API — the group schema admits `#rrggbb` only —
    // but „unreachable" is not „absent", and the fallback has to be the one
    // that keeps the surface looking as it did.
    expect(inkOn('rebeccapurple')).toBe('var(--color-on-accent)');
    expect(inkOn('')).toBe('var(--color-on-accent)');
  });

  it('reads the short form as the browser does', () => {
    expect(inkOn('#fff')).toBe(inkOn('#ffffff'));
    expect(inkOn('#000')).toBe(inkOn('#000000'));
  });
});

/**
 * **The case the axe gate cannot see** .
 *
 * `e2e/a11y.spec.ts` runs under *one* session and thereby under *one*
 * organisation colour — the gold of the umbrella organisation, for which the
 * dark ink is right. No run of this gate can ever show what happens on a dark
 * organisation colour. That is why the assertion stands here, over concrete
 * organisation colour values, and not there.
 *
 * What is measured is **both ends of the gradient**: a filled button is never
 * one area. `--gradient-accent` runs from `--color-accent` to
 * `--color-accent-strong` (78 % onto black), and exactly the lower end was
 * the worse of the two values — 2.29:1 against 3.40:1 on the
 * Musterstadt organisation colour.
 */
describe('inkOnAccent', () => {
  /** `--color-accent-strong` from `tokens.css`, computed as a colour. */
  function strongOf(accent: string): string {
    const mixed = [1, 3, 5].map((offset) =>
      Math.round(Number.parseInt(accent.slice(offset, offset + 2), 16) * 0.78),
    );
    return `#${mixed.map((part) => part.toString(16).padStart(2, '0')).join('')}`;
  }

  /**
   * The worse of the two ends — the number that counts. A button whose
   * top edge reads well and whose bottom edge does not is no readable button.
   */
  function worstEnd(accent: string, ink: string): number {
    const literal = resolveInk(ink);
    return Math.min(
      contrast(accent, literal),
      contrast(strongOf(accent), literal),
    );
  }

  it.each([
    // The organisation colour that produced the finding (seed: Musterstadt).
    ['#e30000'],
    // The admin red of the group colours — the same class, another axis.
    ['#7c0800'],
    // And the gold of the umbrella organisation, for which the fixed ink was
    // written: nothing may change here, otherwise the correction repairs the
    // normal case to pieces.
    ['#cea967'],
  ])('nimmt für %s nie die schlechtere der beiden Tinten', (accent) => {
    const chosen = worstEnd(accent, inkOnAccent(accent));
    const other = worstEnd(
      accent,
      inkOnAccent(accent) === 'var(--color-on-accent)'
        ? 'var(--color-on-accent-light)'
        : 'var(--color-on-accent)',
    );

    expect(chosen).toBeGreaterThanOrEqual(other);
  });

  it('behält die dunkle Tinte auf dem Gold der Dachorganisation', () => {
    // The normal case of the installation. A correction that turns it around
    // would be a worsening with a clear conscience.
    expect(inkOnAccent('#cea967')).toBe('var(--color-on-accent)');
  });

  it('dreht auf der Organisationsfarbe, die den Befund erzeugt hat, auf die helle', () => {
    expect(inkOnAccent('#e30000')).toBe('var(--color-on-accent-light)');
    // And the number to go with it: before 2.29:1 at the lower end, now over
    // 4.5:1.
    expect(worstEnd('#e30000', inkOnAccent('#e30000'))).toBeGreaterThan(4.5);
    expect(worstEnd('#e30000', 'var(--color-on-accent)')).toBeLessThan(2.5);
  });

  it('fällt für eine unlesbare Farbe auf die dunkle Tinte zurück', () => {
    expect(inkOnAccent('rebeccapurple')).toBe('var(--color-on-accent)');
  });

  /**
   * **The case for which the second half of the gradient is built at all.**
   *
   * This assertion arose from a failed reproduction: ignoring the
   * lower end of the gradient made **none** of the cases above
   * red. On `#e30000` both ends choose the same ink anyway, so nothing
   * proved that the computation over the gradient is more than decoration.
   *
   * `#0c88cc` is the colour at which the two ends **fall apart**:
   * its luminance (0.2205) lies above the threshold, that of its
   * `--color-accent-strong` (0.1720) below it. A decision that looks only at
   * the top edge takes the dark ink here — and the bottom edge of the
   * button is thereby the worse of the two.
   *
   * An organisation may choose exactly such a colour; it is nothing made up,
   * but an ordinary medium blue.
   */
  it('entscheidet am schlechteren Ende, nicht an der Oberkante', () => {
    const accent = '#0c88cc';

    // The top edge alone says "dark"…
    expect(inkOn(accent)).toBe('var(--color-on-accent)');
    // …the whole button says "light".
    expect(inkOnAccent(accent)).toBe('var(--color-on-accent-light)');

    // And the numbers to go with it, measured at the **lower** end.
    expect(worstEnd(accent, 'var(--color-on-accent-light)')).toBeGreaterThan(
      worstEnd(accent, 'var(--color-on-accent)'),
    );
  });
});

/**
 * **The numbers on which the message of Konzept no. 90 stands.**
 *
 * They are checked here and not only at the message, because the message
 * builds only a sentence out of them: what the application actually claims is
 * this contrast value. And because it has to be the same one that `inkOn` and
 * `inkOnAccent` *used* — a second computation would be exactly the
 * duplication that no. 90 expressly warns against.
 */
describe('Kontrastwerte für die Meldung ', () => {
  it('meldet für die Fläche denselben Wert, auf den `inkOn` gesetzt hat', () => {
    for (const color of ['#cea967', '#e30000', '#7c0800', '#5b6b52']) {
      const measured = bestInkContrast(color);
      expect(measured).not.toBeNull();
      expect(measured).toBeCloseTo(
        contrast(color, resolveInk(inkOn(color))),
        2,
      );
    }
  });

  it('meldet für den Knopf das schlechtere Ende des Verlaufs', () => {
    // `#0c88cc` is the colour whose ends fall apart (see above) —
    // a value that measures only the top edge would be too good here.
    const accent = '#0c88cc';
    const measured = bestInkContrastOnAccent(accent);
    expect(measured).not.toBeNull();
    expect(measured).toBeLessThan(Number(bestInkContrast(accent)));
  });

  /**
   * **The hole that no choice of ink closes** — the reason why no. 90
   * demands a message at all.
   */
  it('bleibt im Mittelton unter 4,5:1, egal welche Tinte', () => {
    // A colour whose luminance lies on `INK_CROSSOVER` (0.2065).
    const midTone = '#7f7f7f';
    const measured = bestInkContrast(midTone);
    expect(measured).not.toBeNull();
    expect(measured).toBeLessThan(AA_TEXT_CONTRAST);
    // And the counter-check: a dark organisation colour tears nothing.
    expect(Number(bestInkContrast('#7c0800'))).toBeGreaterThan(
      AA_TEXT_CONTRAST,
    );
  });

  /**
   * `contrastAsText` computes against `--color-surface`, and that is the
   * friendliest number only if the token really is white. The same check as
   * at `ACCENT_STRONG_MIX`: against the token file, not against a copy.
   */
  it('rechnet die Schrift gegen das Weiß aus `tokens.css`', () => {
    expect(resolveInk('var(--color-surface)')).toBe('#ffffff');

    for (const color of ['#cea967', '#7c0800', '#5b6b52']) {
      expect(contrastAsText(color)).toBeCloseTo(contrast(color, '#ffffff'), 2);
    }
  });

  it('antwortet `null`, statt für eine unlesbare Farbe zu raten', () => {
    expect(bestInkContrast('rebeccapurple')).toBeNull();
    expect(bestInkContrastOnAccent('rebeccapurple')).toBeNull();
    expect(contrastAsText('rebeccapurple')).toBeNull();
  });
});
