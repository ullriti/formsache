/**
 * Shared detection of hardcoded colour literals.
 *
 * Used by the ESLint rule `formsache/no-hardcoded-colors` for components and by the
 * guard test in `apps/web/src/styles/tokens.test.ts` for stylesheets, so both
 * gates agree on what "a colour" is.
 */

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` — not part of a longer word. */
export const HEX_COLOR_PATTERN =
  /(?<![\w#])#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})(?![0-9a-z])/gi;

/** CSS colour functions. Their arguments are literal colours by definition. */
export const COLOR_FUNCTION_PATTERN =
  /(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(/gi;

/**
 * Named CSS colours that realistically show up by accident. Not the full list
 * of 148 — `transparent`, `currentColor` and `inherit` stay allowed because
 * they carry no brand value.
 */
export const NAMED_COLORS = [
  'aqua',
  'azure',
  'beige',
  'black',
  'blue',
  'brown',
  'coral',
  'crimson',
  'cyan',
  'darkblue',
  'darkgray',
  'darkgreen',
  'darkgrey',
  'darkred',
  'fuchsia',
  'gold',
  'gray',
  'green',
  'grey',
  'indigo',
  'ivory',
  'khaki',
  'lightblue',
  'lightgray',
  'lightgrey',
  'lime',
  'magenta',
  'maroon',
  'navy',
  'olive',
  'orange',
  'orchid',
  'pink',
  'plum',
  'purple',
  'red',
  'salmon',
  'sienna',
  'silver',
  'snow',
  'tan',
  'teal',
  'tomato',
  'turquoise',
  'violet',
  'wheat',
  'white',
  'whitesmoke',
  'yellow',
];

/**
 * A named colour, but not when it is part of an identifier or custom property
 * (`--color-gold`, `goldMedal`) — those are names, not values.
 */
export const NAMED_COLOR_PATTERN = new RegExp(
  `(?<![\\w-])(?:${NAMED_COLORS.join('|')})(?![\\w-])`,
  'gi',
);

/**
 * Returns the first hex or colour-function literal in `text`, or `null`.
 * Named colours are handled separately, because they only count in a context
 * that is known to be a colour (a CSS declaration value, a `color`-ish
 * property) — as a bare word they are far too often just a word.
 */
export function findColorLiteral(text) {
  for (const pattern of [HEX_COLOR_PATTERN, COLOR_FUNCTION_PATTERN]) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match !== null) {
      return match[0];
    }
  }

  return null;
}

/** Returns the first named CSS colour in `text`, or `null`. */
export function findNamedColor(text) {
  NAMED_COLOR_PATTERN.lastIndex = 0;
  const match = NAMED_COLOR_PATTERN.exec(text);

  return match === null ? null : match[0];
}
