/**
 * Which of the two brand inks a **data-driven** background can carry
 * (and the requirement's „automatische Textfarbe").
 *
 * An organisation names its groups and gives each one a colour, and that colour becomes
 * a filled surface with text on it: the member avatar's initials, the group's
 * permission pills. The foreground of those surfaces used to be
 * `--color-on-accent` — a fixed dark ink, written for the Dachorganisation's gold. On the
 * seeded admin red `#7c0800` it measures 1.51:1, on the viewer green 2.93:1;
 * the axe gate found eleven such nodes.
 *
 * **The organisation's colour is not the thing that gets corrected here.** It stays
 * exactly as chosen; what changes is the ink laid over it, and it is chosen per
 * colour instead of once for every organisation. That is one of the two answers
 * for this situation. The other one — telling an admin at
 * the moment they pick an unreadable colour — is decided in Konzept no. 90 and
 * built on top of this module: {@link bestInkContrast},
 * {@link bestInkContrastOnAccent} and {@link contrastAsText} are the numbers,
 * `views/tenant-admin/color-contrast.ts` turns them into German sentences.
 * **Reported, never refused** — the colour saves either way.
 *
 * **No colour literal leaves this module.** It returns a `var(--…)` reference,
 * so the two inks stay in `tokens.css` where every other colour of this
 * application lives (`CONTRIBUTING.md`). What it reads is the *data* colour, which
 * is not a token and never was.
 */

/**
 * **WCAG 1.4.3 AA for text under 24 px** — the bar Konzept no. 78 decided on.
 *
 * Here rather than in the component that writes the sentence, next to the
 * arithmetic that produces the number it is compared with: a threshold spelled
 * out at the call site is how two call sites come to disagree about what „zu
 * wenig" means.
 */
export const AA_TEXT_CONTRAST = 4.5;

/** The dark ink of `tokens.css`, for a light group colour. */
const DARK_INK = 'var(--color-on-accent)';
/** Its light counterpart, for a dark one. */
const LIGHT_INK = 'var(--color-on-accent-light)';

/**
 * Relative luminance per WCAG 2.x, of an `#rgb`/`#rrggbb` colour.
 *
 * Returns `null` for anything else. Group colours arrive from the server
 * through a Zod schema that only admits `#rrggbb`, so `null` is unreachable in
 * practice — but „unreachable" is not „absent", and the fallback below is the
 * one that keeps today's appearance rather than a guess.
 */
function luminance(color: string): number | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/iu.exec(color.trim());
  const digits = match?.[1];
  if (digits === undefined) {
    return null;
  }
  // `replace` rather than a spread: the pattern above admits hex digits only,
  // but `...` over a string is code points, and the lint rule that forbids it
  // is right in general even where this call site is safe.
  const full =
    digits.length === 3 ? digits.replace(/([0-9a-f])/giu, '$1$1') : digits;

  const channels = [0, 2, 4].map((offset) => {
    const value = Number.parseInt(full.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const [red = 0, green = 0, blue = 0] = channels;
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/**
 * Where the two inks are equally legible.
 *
 * Not a taste value: it is the luminance at which the contrast of
 * `--color-on-accent` (`#241d05`, luminance 0.01266) and of white against the
 * same background is the same number, i.e. the solution of
 * `(L + 0.05) / 0.06266 = 1.05 / (L + 0.05)`. Picking the better of the two on
 * either side of it is therefore the best either ink can do.
 */
const INK_CROSSOVER = 0.2065;

/**
 * The ink to write on `color`, as a CSS `var()` reference.
 *
 * **This is not a promise of 4.5:1.** Around the crossover — a mid-tone an organisation
 * is perfectly free to choose — *neither* ink reaches AA (roughly 4.0:1 at the
 * worst point), and no choice made here can change that. What it does promise
 * is the better of the two, always; the remaining gap is the case that needs
 * the warning at the input, and it is named in the worklog rather than hidden
 * behind a value that looks decided.
 */
export function inkOn(color: string): string {
  const value = luminance(color);
  if (value === null) {
    return DARK_INK;
  }
  return value >= INK_CROSSOVER ? DARK_INK : LIGHT_INK;
}

/**
 * **How good the answer of {@link inkOn} actually is**, as a contrast ratio.
 *
 * The same decision, read the other way round: `inkOn` says *which* ink, this
 * says *whether it is enough*. Both come from one luminance and one crossover,
 * so the two can never disagree — a second contrast calculation somewhere else
 * in this application is exactly what Konzept no. 90 is not asking for.
 *
 * `null` for a colour this module cannot read (see {@link luminance}).
 */
export function bestInkContrast(color: string): number | null {
  const value = luminance(color);
  if (value === null) {
    return null;
  }
  return Math.max(ratio(value, DARK_INK_LUMINANCE), ratio(value, 1));
}

/**
 * How `--color-accent-strong` is derived in `tokens.css` — the darker end of
 * the accent gradient every filled button carries.
 *
 * Duplicated here as a *number* because the token is a `color-mix()` the
 * browser resolves and this module has to reason about the colour **before**
 * the browser sees it. If the mix in `tokens.css` changes, this constant is
 * wrong and `readable-ink.test.ts` says so — the assertion compares against
 * the token file rather than against a copy of the value.
 */
const ACCENT_STRONG_MIX = 0.78;

/** Contrast of a luminance pair, per WCAG 2.x. */
function ratio(a: number, b: number): number {
  const [dark = 0, light = 0] = [a, b].sort((x, y) => x - y);
  return (light + 0.05) / (dark + 0.05);
}

/**
 * The ink for a **filled accent button** — the whole gradient, not one colour.
 *
 * `--gradient-accent` runs from `--color-accent` to `--color-accent-strong`
 * (78 % accent on black), so a button is never one background: its top and its
 * bottom are two different contrast problems, and {@link inkOn} answering for
 * the top alone would leave the bottom — the darker, harder end — unanswered.
 * This is the difference that made the finding: on the seeded Musterstadt red the
 * fixed dark ink measures **3.40:1** at the top and **2.29:1** at the bottom.
 *
 * Both ends are therefore evaluated with both inks, and the ink with the better
 * **worst** end wins. The same „better of the two, never a promise of AA"
 * caveat as {@link inkOn} applies, for the same reason.
 *
 * ⚠️ **The axe gate cannot see this case.** `e2e/a11y.spec.ts` runs under one
 * session and therefore one Organisationsfarbe (the Dachorganisation's gold), for which the dark ink is
 * right. Contrast that depends on tenant data is not measurable from one
 * sample — which is where the requirement begins, and why this function carries
 * unit tests over concrete Organisationsfarbe values instead.
 */
export function inkOnAccent(accent: string): string {
  const ends = accentInkEnds(accent);
  if (ends === null) {
    return DARK_INK;
  }
  return ends.lightInk > ends.darkInk ? LIGHT_INK : DARK_INK;
}

/**
 * **How good the answer of {@link inkOnAccent} actually is**, as a contrast
 * ratio — the worse of the gradient's two ends, which is the end that decides
 * whether a filled button can be read at all.
 *
 * The counterpart of {@link bestInkContrast} for the one surface that is not a
 * single colour, and for the same reason: Konzept no. 90 wants the *number* an
 * admin's colour reaches, and it has to be the number this module already
 * acted on.
 */
export function bestInkContrastOnAccent(accent: string): number | null {
  const ends = accentInkEnds(accent);
  if (ends === null) {
    return null;
  }
  return Math.max(ends.darkInk, ends.lightInk);
}

/** What each ink reaches across the **whole** gradient — its worse end. */
function accentInkEnds(
  accent: string,
): { readonly darkInk: number; readonly lightInk: number } | null {
  const top = luminance(accent);
  if (top === null) {
    return null;
  }
  // The mix is in linear light in `color-mix(in srgb, …)`; luminance is linear
  // too, so scaling it by the mix factor is the same operation.
  const bottom = top * ACCENT_STRONG_MIX;

  return {
    darkInk: Math.min(
      ratio(top, DARK_INK_LUMINANCE),
      ratio(bottom, DARK_INK_LUMINANCE),
    ),
    lightInk: Math.min(ratio(top, 1), ratio(bottom, 1)),
  };
}

/**
 * **The other direction: the colour as the *text*, on a card of this
 * application** .
 *
 * A group colour is not only a filled surface — `PermissionMatrix` writes the
 * group's *name* in it, on `--color-surface`. There is no ink to choose there:
 * the colour **is** the ink, so the question stops being „which of the two"
 * and becomes „is it enough at all", and only the organisation can answer it by
 * picking a different colour.
 *
 * `--color-surface` is white, so its luminance is 1 exactly — the brightest
 * background this application has, which makes this the *friendliest* number a
 * text use of the colour reaches anywhere. On `--color-panel` or the canvas it
 * is worse, never better, so a colour that fails here fails everywhere.
 * `readable-ink.test.ts` asserts the token really is `#ffffff`, the same way it
 * checks `ACCENT_STRONG_MIX` against `tokens.css`.
 */
export function contrastAsText(color: string): number | null {
  const value = luminance(color);
  if (value === null) {
    return null;
  }
  return ratio(value, CARD_SURFACE_LUMINANCE);
}

/** Luminance of `--color-on-accent` (`#241d05`) — see {@link INK_CROSSOVER}. */
const DARK_INK_LUMINANCE = 0.01266;

/** Luminance of `--color-surface` (`#ffffff`) — see {@link contrastAsText}. */
const CARD_SURFACE_LUMINANCE = 1;
