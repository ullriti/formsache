import { describe, expect, it } from 'vitest';

import {
  AA_TEXT_CONTRAST,
  bestInkContrast,
  bestInkContrastOnAccent,
  contrastAsText,
} from '../../styles/readable-ink';
import { accentNotes, groupColorNotes } from './color-contrast';

/**
 * **The notice at the colour choice** .
 *
 * Every assertion here has a counter-check next to it, and that is the actual
 * content of the file: a check that only shows "with a bad colour a
 * sentence is there" measures that an element exists. Only together with "with
 * a good colour **none** is there" does it measure that something is calculated.
 *
 * The numbers in it are recalculated (WCAG 2.x, `readable-ink.ts`):
 *
 * | Colour    | Surface, best ink   | as type on white     |
 * |-----------|---------------------|----------------------|
 * | `#7c0800` | 11,10:1             | 11,10:1              |
 * | `#8a6a12` |  5,06:1             |  5,06:1              |
 * | `#5b6b52` |  5,72:1             |  5,72:1              |
 * | `#cea967` |  7,58:1             |  2,21:1              |
 * | `#7f7f7f` |  4,19:1 (mid tone)  |  4,00:1              |
 * | `#9bd18a` |  9,48:1             |  1,77:1              |
 *
 * `#9bd18a` is the row that carries the difference: as a *surface* a
 * light green is effortlessly legible, as *type* on white it is almost nothing. Exactly
 * for that reason the notice has to say which of the two cases is at hand.
 *
 * **The suggestions are not fixed as a string** (finding 13).
 * A test that expects `'#a07e33'` checks the rounding of a helper function;
 * what ought to be checked is the promise that stands in the sentence — *from this colour
 * on it suffices, and it is still the same colour*. So: the suggestion holds 4,5:1, it lies in
 * the announced direction, and hue and saturation are those of the chosen
 * colour.
 */

/** The three group colours of the seed — "today harmless only with them". */
const SEEDED_GROUP_COLORS = ['#7c0800', '#8a6a12', '#5b6b52'];

/** A mid tone on the threshold: neither of the two inks suffices there. */
const MID_TONE = '#7f7f7f';

/** The three channels of a `#rrggbb`. */
function channels(hex: string): readonly number[] {
  return [1, 3, 5].map((offset) =>
    Number.parseInt(hex.slice(offset, offset + 2), 16),
  );
}

/** Relative lightness in the HSL sense — suffices for "lighter/darker than". */
function lightness(hex: string): number {
  const values = channels(hex);
  return (Math.max(...values) + Math.min(...values)) / 2;
}

/**
 * Hue and saturation, roughly: the ratio of the channels to one another.
 *
 * No second HSL calculator — what is checked is the *promise* ("the same hue"),
 * and that can be read off the order and the distance of the channels, without
 * writing down the conversion of the subject under test a second time.
 */
function hueOrder(hex: string): readonly number[] {
  const values = channels(hex);
  return values
    .map((_, index) => index)
    .sort((a, b) => (values[b] ?? 0) - (values[a] ?? 0));
}

describe('accentNotes', () => {
  it('meldet den Mittelton, in dem keine der beiden Tinten reicht', () => {
    const notes = accentNotes(MID_TONE);
    const surface = notes.find((note) => note.kind === 'surface');

    expect(surface).toBeDefined();
    expect(surface?.label).toBe('Fläche');
    // The first sentence carries without expert knowledge: it says *why* it
    // sticks, and that no type colour changes anything about it.
    expect(surface?.text).toContain('für weiße Schrift zu hell');
    expect(surface?.text).toContain('für dunkle zu dunkel');
    expect(surface?.text).toContain('Auf gefüllten Knöpfen');
    // And that the application chooses the type colour itself — otherwise
    // the notice reads like an invitation to fiddle with the type.
    expect(surface?.text).toContain('automatisch');
    expect(surface?.ratio).toBeLessThan(AA_TEXT_CONTRAST);
  });

  it('nennt für den Mittelton je einen dunkleren und einen helleren Ausweg', () => {
    const surface = accentNotes(MID_TONE).find(
      (note) => note.kind === 'surface',
    );
    const [darker, lighter] = surface?.suggestions ?? [];

    expect(darker).toBeDefined();
    expect(lighter).toBeDefined();
    // Both suggestions stand in the sentence — a calculated value that nobody
    // sees helps nobody.
    expect(surface?.text).toContain(String(darker));
    expect(surface?.text).toContain(String(lighter));

    // And both really solve what the sentence claims.
    for (const hex of [darker, lighter]) {
      expect(bestInkContrastOnAccent(String(hex))).toBeGreaterThanOrEqual(
        AA_TEXT_CONTRAST,
      );
    }
    expect(lightness(String(darker))).toBeLessThan(lightness(MID_TONE));
    expect(lightness(String(lighter))).toBeGreaterThan(lightness(MID_TONE));
  });

  it('schweigt zu einer Organisationsfarbe, die auf dem Knopf hält', () => {
    // The Musterstadt red: with the light ink 4,92:1 across the whole gradient.
    expect(
      accentNotes('#e30000').filter((note) => note.kind === 'surface'),
    ).toEqual([]);
    // And the admin red, with ample margin.
    expect(
      accentNotes('#7c0800').filter((note) => note.kind === 'surface'),
    ).toEqual([]);
  });

  /**
   * The second hole from no. 90: otherwise an organisation does not see **why** its
   * light red is printed almost black as type.
   */
  it('erklärt beim Gold der Dachorganisation, warum Schrift dunkler wirkt als gewählt', () => {
    const text = accentNotes('#cea967').find((note) => note.kind === 'text');

    expect(text).toBeDefined();
    expect(text?.label).toBe('Schrift');
    // The first sentence says the problem in everyday language — without a metric.
    expect(text?.text.startsWith('Diese Farbe ist zu hell für Text auf')).toBe(
      true,
    );
    expect(text?.text).toContain('abgedunkelte');
    // And the sentence says **where** — „wo sie als Text steht", not "everywhere":
    // `--color-accent-ink` covers the text buttons, but in `apps/web` there are
    // still places that set `--color-accent-strong` as `color`.
    expect(text?.text).toContain('wo sie als Text steht');
    // And the notice takes the sharpness out of itself: the surfaces keep the colour.
    // It is an explanation, not an error.
    expect(text?.text).toContain('behalten genau diese Farbe');
    expect(text?.ratio).toBeLessThan(AA_TEXT_CONTRAST);
  });

  it('schlägt für die Schrift-Aufgabe eine dunklere Fassung derselben Farbe vor', () => {
    const accent = '#cea967';
    const text = accentNotes(accent).find((note) => note.kind === 'text');
    const suggestion = text?.suggestions[0];

    expect(suggestion).toBeDefined();
    expect(text?.text).toContain(`ab ungefähr ${String(suggestion)}`);
    // The promise of the sentence, measured: from here on it suffices as text.
    expect(contrastAsText(String(suggestion))).toBeGreaterThanOrEqual(
      AA_TEXT_CONTRAST,
    );
    // "A bit darker" — and not: a different colour. The order of the channels
    // (that is, the hue) stays, the lightness drops.
    expect(lightness(String(suggestion))).toBeLessThan(lightness(accent));
    expect(hueOrder(String(suggestion))).toEqual(hueOrder(accent));
  });

  it('lässt ein Grau ein Grau', () => {
    // Hue and saturation stay put — with a grey that means: the
    // suggestion is a grey again. A calculation via the hue that drags the
    // saturation along would suggest a blue-grey here.
    const suggestion = groupColorNotes(MID_TONE).find(
      (note) => note.kind === 'text',
    )?.suggestions[0];

    expect(suggestion).toBeDefined();
    const [red, green, blue] = channels(String(suggestion));
    expect(red).toBe(green);
    expect(green).toBe(blue);
  });

  it('schweigt zu einer Organisationsfarbe, die auch als Schrift trägt', () => {
    // `#7c0800` reaches 11,10:1 on white — nothing is darkened here that
    // the organisation would not see anyway.
    expect(accentNotes('#7c0800')).toEqual([]);
  });

  it('meldet zu einer Farbe, die es nicht lesen kann, gar nichts', () => {
    // No guessing and no notice into the blue: `readable-ink.ts` answers
    // `null`, and `null` is no statement about the contrast.
    expect(accentNotes('rebeccapurple')).toEqual([]);
  });
});

describe('groupColorNotes', () => {
  it.each(SEEDED_GROUP_COLORS)(
    'schweigt zur Seed-Farbe %s — in beiden Aufgaben',
    (color) => {
      expect(groupColorNotes(color)).toEqual([]);
    },
  );

  /**
   * The case that concept no. 90 names explicitly for the permissions matrix: there
   * the group colour is **type** on white, and the seed colours are the
   * only thing that makes that harmless today.
   */
  it('meldet die Schrift-Aufgabe, sobald eine Organisation eine hellere Farbe wählt', () => {
    const notes = groupColorNotes('#9bd18a');
    const text = notes.find((note) => note.kind === 'text');

    expect(text).toBeDefined();
    expect(text?.label).toBe('Schrift');
    expect(text?.text).toContain('Rechte-Matrix');
    // The sentence says in everyday language against what the contrast is missing…
    expect(text?.text).toContain('zu hell zum Lesen');
    // …and that here there is **nothing to switch** — that is the difference
    // from the surface, and without it the notice does not help with changing.
    expect(text?.text).toContain('Umschalten lässt sich hier nichts');
    expect(text?.ratio).toBeLessThan(AA_TEXT_CONTRAST);
  });

  it('nennt auch für eine Gruppenfarbe einen tragfähigen dunkleren Wert', () => {
    const color = '#9bd18a';
    const text = groupColorNotes(color).find((note) => note.kind === 'text');
    const suggestion = text?.suggestions[0];

    expect(suggestion).toBeDefined();
    expect(text?.text).toContain(`ab ungefähr ${String(suggestion)}`);
    expect(contrastAsText(String(suggestion))).toBeGreaterThanOrEqual(
      AA_TEXT_CONTRAST,
    );
    expect(lightness(String(suggestion))).toBeLessThan(lightness(color));
    expect(hueOrder(String(suggestion))).toEqual(hueOrder(color));
  });

  it('unterscheidet die beiden Fälle an derselben Farbe', () => {
    const notes = groupColorNotes(MID_TONE);

    expect(notes.map((note) => note.kind)).toEqual(['surface', 'text']);
    expect(notes.map((note) => note.label)).toEqual(['Fläche', 'Schrift']);
  });

  it('rechnet den Flächen-Vorschlag gegen die Plaketten, nicht gegen den Verlauf', () => {
    // Two tasks, two yardsticks: the group colour is a *single-coloured*
    // surface (`bestInkContrast`), the organisation colour a gradient
    // (`bestInkContrastOnAccent`). A suggestion that was calculated against the
    // wrong one would not hold here.
    const surface = groupColorNotes(MID_TONE).find(
      (note) => note.kind === 'surface',
    );

    for (const hex of surface?.suggestions ?? []) {
      expect(bestInkContrast(hex)).toBeGreaterThanOrEqual(AA_TEXT_CONTRAST);
    }
    expect(surface?.suggestions).toHaveLength(2);
  });

  it('sagt in jeder Meldung, dass gespeichert wird — als Nebenangabe', () => {
    // No. 90 literally: „gemeldet — nicht abgelehnt". The sentence belongs on the
    // notice, not only in the concept — and since finding 13 in the second line,
    // together with the metric that previously occupied the first sentence.
    for (const note of groupColorNotes(MID_TONE)) {
      expect(note.detail).toContain('Gespeichert wird die Farbe trotzdem.');
      expect(note.detail).toContain('nötig sind 4,5:1');
      expect(note.text).not.toContain('4,5:1');
      expect(note.text).not.toContain('Gespeichert');
    }
  });
});
