import {
  AA_TEXT_CONTRAST,
  bestInkContrast,
  bestInkContrastOnAccent,
  contrastAsText,
} from '../../styles/readable-ink';

/**
 * **What there is to say about a chosen Organisationsfarbe colour — and what there is
 * not** (2026-08-10).
 *
 * The decision is unambiguous and this module keeps to it: *a Organisationsfarbe that
 * breaks the contrast is **reported, not refused**.* There is therefore no
 * function here that answers „valid/invalid", and no return value a caller
 * could use as a lock — only sentences. It is the organisation’s own Organisationsfarbe; the
 * application explains it, it does not forbid it.
 *
 * ## Two questions, and why the message has to tell them apart
 *
 * One and the same colour has two different jobs in this application, and „too
 * little contrast" on its own does not tell an organisation which of them is stuck:
 *
 * - **Surface** (`Fläche`) — the colour is a filled background with text on
 *   it (button, permission pill, initials in a circle). The question is *which
 *   ink*, and `readable-ink.ts` answers it automatically.
 *   Reported is therefore only the one hole no choice of ink can close: in the
 *   **mid-tone** *neither* ink reaches 4.5:1 — at the worst point, a luminance
 *   of 0.2065, it is 4.09:1.
 * - **Text** (`Schrift`) — the colour *is* the ink, on a light card (the group
 *   name in the rights matrix, the accent in text buttons). There is nothing to
 *   switch here; the question is *is it enough at all*.
 *
 * ## Whom the sentences are written for (finding 13)
 *
 * Here once stood: „Als Schriftfarbe erreicht diese Farbe auf Weiß nur
 * 2,21:1 statt der geforderten 4,5:1." That is calculated correctly and
 * worthless for the person who reads it: they administer an organisation, not a
 * WCAG table, and no action follows from a metric. What follows is
 * the question "and now?" — and no sentence answered it.
 *
 * Every message therefore consists of two parts:
 *
 * - **`text`** carries on its own, without expert knowledge. It says *against what*
 *   the contrast is missing („zu hell für Text auf weißem Grund"), *in which direction*
 *   the colour would have to go, and names a **concrete hex value** from which it suffices.
 *   This value is calculated, not guessed: {@link suggestHex} shifts the
 *   lightness of the chosen colour, **keeps hue and saturation** and stops
 *   as soon as 4,5:1 is reached. The suggestion is thereby the same colour,
 *   only legible — and not a foreign one from a list.
 * - **`detail`** is the side note for those who want it: the measured
 *   ratio and the sentence that it is saved anyway. The number has thereby not
 *   disappeared, it merely no longer stands in the way.
 *
 * ## The Streifen der Organisationsfarben is **not** among them, and that is measured
 *
 * Nothing is written on the stripe — no text, no glyph — so neither question
 * applies. The obvious substitute („does the segment stand out from the header
 * bar", WCAG 1.4.11, 3:1) was built and taken out again, because it accuses
 * **both shipped organisations** wrongly: the Dachorganisation’s first segment is `#212226` and so
 * is its header (1.00:1), Musterstadt has `#131313` against `#212226` (1.17:1).
 * A black-red-gold stripe on a black header **is meant to look like that**, and
 * a message that glows for every organisation from the first second is one nobody
 * learns to read. The point is therefore open in the worklog rather than noise
 * in the interface.
 */

/** Which of the two jobs the message is about. */
export type ContrastCase = 'surface' | 'text';

export interface ContrastNote {
  /** Surface or text — see {@link ContrastCase}. */
  readonly kind: ContrastCase;
  /**
   * The visible lead word of the message („Fläche" / „Schrift").
   *
   * It is in the text **and** in the markup, because otherwise the state would
   * hang on the colour of the box alone — exactly what the axe gate marks
   * red, and what somebody without colour perception does not see.
   */
  readonly label: string;
  /** The measured ratio — for assertions, and for {@link detail}. */
  readonly ratio: number;
  /**
   * The load-bearing sentence: what is the matter, in which direction the colour
   * would have to go and from which hex value it suffices. Without the lead word
   * that the component puts in front of it.
   */
  readonly text: string;
  /** The quiet side note: measured ratio, and "it is saved anyway". */
  readonly detail: string;
  /**
   * The hex suggestions named in the sentence, in the same order — empty
   * if there was none to calculate. As a field and not only in the running text, so that a
   * test can check the **calculated value** instead of a string.
   */
  readonly suggestions: readonly string[];
}

/** „4,09:1" — German notation, without depending on an ICU locale. */
function formatRatio(value: number): string {
  return `${value.toFixed(2).replace('.', ',')}:1`;
}

/** „4,5" — the threshold itself, from the constant instead of as a second spelling. */
const REQUIRED = AA_TEXT_CONTRAST.toFixed(1).replace('.', ',');

/** The closing sentence every message carries: reported, not refused. */
const SAVED_ANYWAY = 'Gespeichert wird die Farbe trotzdem.';

/** The side note under every sentence. */
function detailOf(ratio: number): string {
  return `Gemessen: ${formatRatio(ratio)} — nötig sind ${REQUIRED}:1. ${SAVED_ANYWAY}`;
}

/* -------------------------------------------------------------------------
 * The suggestion: the same colour, only lighter or darker
 * ---------------------------------------------------------------------- */

interface Hsl {
  readonly hue: number;
  readonly saturation: number;
  readonly lightness: number;
}

/** `#rgb`/`#rrggbb` as three channels in 0–1, or `null`. */
function parseHex(color: string): readonly [number, number, number] | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/iu.exec(color.trim());
  const digits = match?.[1];
  if (digits === undefined) {
    return null;
  }
  const full =
    digits.length === 3 ? digits.replace(/([0-9a-f])/giu, '$1$1') : digits;
  const [red = 0, green = 0, blue = 0] = [0, 2, 4].map(
    (offset) => Number.parseInt(full.slice(offset, offset + 2), 16) / 255,
  );
  return [red, green, blue];
}

function toHsl(color: string): Hsl | null {
  const channels = parseHex(color);
  if (channels === null) {
    return null;
  }
  const [red, green, blue] = channels;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  const span = max - min;

  if (span === 0) {
    // Grey: no hue, no saturation — and both have to stay that way, otherwise
    // the application would suggest a blue for a grey.
    return { hue: 0, saturation: 0, lightness };
  }

  const saturation =
    lightness > 0.5 ? span / (2 - max - min) : span / (max + min);
  let hue: number;
  if (max === red) {
    hue = (green - blue) / span + (green < blue ? 6 : 0);
  } else if (max === green) {
    hue = (blue - red) / span + 2;
  } else {
    hue = (red - green) / span + 4;
  }
  return { hue: hue / 6, saturation, lightness };
}

/** One channel of the HSL back-conversion (the usual helper function). */
function hueChannel(p: number, q: number, offset: number): number {
  const t = (offset + 1) % 1;
  if (t < 1 / 6) {
    return p + (q - p) * 6 * t;
  }
  if (t < 1 / 2) {
    return q;
  }
  if (t < 2 / 3) {
    return p + (q - p) * (2 / 3 - t) * 6;
  }
  return p;
}

function toHex({ hue, saturation, lightness }: Hsl): string {
  const channels =
    saturation === 0
      ? [lightness, lightness, lightness]
      : (() => {
          const q =
            lightness < 0.5
              ? lightness * (1 + saturation)
              : lightness + saturation - lightness * saturation;
          const p = 2 * lightness - q;
          return [
            hueChannel(p, q, hue + 1 / 3),
            hueChannel(p, q, hue),
            hueChannel(p, q, hue - 1 / 3),
          ];
        })();

  return `#${channels
    .map((value) =>
      Math.round(Math.min(Math.max(value, 0), 1) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** How finely the search shifts the lightness — 0,5 % per step. */
const LIGHTNESS_STEP = 0.005;

/**
 * **The nearest version of the same colour that suffices.**
 *
 * Hue and saturation stay put, only the lightness moves — in *one*
 * direction, step by step, until `passes` accepts the candidate. What is checked
 * in the process is the **finished hex value**, not the intermediate value: that is the
 * string that the message names and that somebody types into the field right
 * afterwards, and it is rounded.
 *
 * Step by step instead of binary, although the contrast runs monotonically in
 * either direction: what is sought is the **nearest** version, not just any, and via
 * `bestInkContrast` the curve is a V — a binary search would need its own
 * bracket on each side in order not to jump over the turning point. 200
 * steps of simple arithmetic are not measurable at a colour choice.
 *
 * `null` if even black or white does not suffice — unreachable with the two
 * checks of this module, but "unreachable" is not
 * "impossible", and a message without a suggestion is better than one with an
 * invented one.
 */
function suggestHex(
  color: string,
  direction: 'darker' | 'lighter',
  passes: (candidate: string) => boolean,
): string | null {
  const hsl = toHsl(color);
  if (hsl === null) {
    return null;
  }
  const step = direction === 'darker' ? -LIGHTNESS_STEP : LIGHTNESS_STEP;

  for (
    let lightness = hsl.lightness + step;
    lightness >= 0 && lightness <= 1;
    lightness += step
  ) {
    const candidate = toHex({ ...hsl, lightness });
    if (passes(candidate)) {
      return candidate;
    }
  }
  // The edge itself — black or white respectively — has not been checked yet.
  const edge = toHex({ ...hsl, lightness: direction === 'darker' ? 0 : 1 });
  return passes(edge) ? edge : null;
}

/** Does this colour suffice as type on white? */
function passesAsText(color: string): boolean {
  const ratio = contrastAsText(color);
  return ratio !== null && ratio >= AA_TEXT_CONTRAST;
}

/**
 * The sentence for the mid tone — built the same for both jobs, because the
 * problem is the same: the colour is neither light nor dark enough, and neither
 * of the two type colours gets past it.
 */
function midToneText(
  place: string,
  darker: string | null,
  lighter: string | null,
): string {
  const advice =
    darker !== null && lighter !== null
      ? `Dunkler wählen — ab ungefähr ${darker} — oder heller, ab ungefähr ${lighter}.`
      : 'Eine dunklere oder eine hellere Farbe löst das.';

  return (
    `Diese Farbe liegt in der Mitte: für weiße Schrift zu hell, für dunkle zu ` +
    `dunkel. ${place} ist die Beschriftung deshalb schwer zu lesen — daran ` +
    `ändert auch die automatisch gewählte Schriftfarbe nichts. ${advice}`
  );
}

/**
 * The messages for the **accent** — the two holes Konzept no. 90 names.
 *
 * 1. *Surface:* the automatic ink applies across the button gradient, but in
 *    the mid-tone neither of the two inks is enough.
 * 2. *Text:* used as a text colour the accent is darkened (`--color-accent-ink`,
 *    40 % on black). That is **not a defect** — it is the reason a pale red is
 *    printed almost black in text, and without this sentence an organisation sees only
 *    the result and never the cause.
 */
export function accentNotes(accent: string): readonly ContrastNote[] {
  const notes: ContrastNote[] = [];

  const onButton = bestInkContrastOnAccent(accent);
  if (onButton !== null && onButton < AA_TEXT_CONTRAST) {
    const passes = (candidate: string): boolean => {
      const ratio = bestInkContrastOnAccent(candidate);
      return ratio !== null && ratio >= AA_TEXT_CONTRAST;
    };
    const darker = suggestHex(accent, 'darker', passes);
    const lighter = suggestHex(accent, 'lighter', passes);

    notes.push({
      kind: 'surface',
      label: 'Fläche',
      ratio: onButton,
      text: midToneText('Auf gefüllten Knöpfen', darker, lighter),
      detail: detailOf(onButton),
      suggestions: [darker, lighter].filter(
        (hex): hex is string => hex !== null,
      ),
    });
  }

  const asText = contrastAsText(accent);
  if (asText !== null && asText < AA_TEXT_CONTRAST) {
    const darker = suggestHex(accent, 'darker', passesAsText);

    notes.push({
      kind: 'text',
      label: 'Schrift',
      ratio: asText,
      // **No "all texts"**, and that has been looked up: `--color-accent-ink`
      // covers the underlined text buttons, but in `apps/web` there are
      // still places that set `--color-accent-strong` as `color`
      // (among others `.builder__link`). A sentence that described the
      // darkening as exceptionless would be a promise that this application does
      // not keep.
      text:
        'Diese Farbe ist zu hell für Text auf weißem Grund. ' +
        (darker === null
          ? 'Eine dunklere Farbe wäre lesbar. '
          : `Etwas dunkler wählen — ab ungefähr ${darker} ist sie als Text gut zu lesen. `) +
        'Bis dahin schreibt die Anwendung sie dort, wo sie als Text steht ' +
        '(Textknöpfe, Links), in einer abgedunkelten Fassung — darum wirkt ' +
        'sie an diesen Stellen dunkler als hier gewählt. Flächen, Knöpfe und ' +
        'der Fortschrittsbalken behalten genau diese Farbe.',
      detail: detailOf(asText),
      suggestions: darker === null ? [] : [darker],
    });
  }

  return notes;
}

/**
 * The messages for a **group colour** — both of the jobs it has.
 *
 * *Surface* is the permission pills and the initials in the circle next to a
 * member; *text* is the group name, which `PermissionMatrix` writes in exactly
 * this colour onto the white card. The second case is the one Konzept no. 90 names
 * explicitly: it is harmless today only because of the seeded colours (admin
 * red 11.10:1, editor gold 5.06:1, viewer green 5.72:1) and tips over the
 * moment an organisation picks a paler one.
 */
export function groupColorNotes(color: string): readonly ContrastNote[] {
  const notes: ContrastNote[] = [];

  const onFill = bestInkContrast(color);
  if (onFill !== null && onFill < AA_TEXT_CONTRAST) {
    const passes = (candidate: string): boolean => {
      const ratio = bestInkContrast(candidate);
      return ratio !== null && ratio >= AA_TEXT_CONTRAST;
    };
    const darker = suggestHex(color, 'darker', passes);
    const lighter = suggestHex(color, 'lighter', passes);

    notes.push({
      kind: 'surface',
      label: 'Fläche',
      ratio: onFill,
      text: midToneText(
        'Auf den Rechte-Plaketten und dem Kürzel im Kreis',
        darker,
        lighter,
      ),
      detail: detailOf(onFill),
      suggestions: [darker, lighter].filter(
        (hex): hex is string => hex !== null,
      ),
    });
  }

  const asText = contrastAsText(color);
  if (asText !== null && asText < AA_TEXT_CONTRAST) {
    const darker = suggestHex(color, 'darker', passesAsText);

    notes.push({
      kind: 'text',
      label: 'Schrift',
      ratio: asText,
      text:
        'In der Rechte-Matrix steht der Gruppenname in dieser Farbe auf ' +
        'weißem Grund — dort ist sie zu hell zum Lesen. ' +
        (darker === null
          ? 'Eine dunklere Farbe wäre lesbar. '
          : `Etwas dunkler wählen — ab ungefähr ${darker} reicht es. `) +
        'Umschalten lässt sich hier nichts: an dieser Stelle ist die Farbe ' +
        'die Schrift selbst.',
      detail: detailOf(asText),
      suggestions: darker === null ? [] : [darker],
    });
  }

  return notes;
}
