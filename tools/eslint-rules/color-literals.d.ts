/**
 * Type surface of `color-literals.js`. The module itself stays JavaScript
 * because `eslint.config.js` loads it directly; this declaration lets the
 * stylesheet guard test in `apps/web` reuse the very same detection instead of
 * defining a second, drifting idea of what counts as a colour.
 */

export declare const HEX_COLOR_PATTERN: RegExp;
export declare const COLOR_FUNCTION_PATTERN: RegExp;
export declare const NAMED_COLORS: readonly string[];
export declare const NAMED_COLOR_PATTERN: RegExp;

/** First hex or colour-function literal in `text`, or `null`. */
export declare function findColorLiteral(text: string): string | null;

/** First named CSS colour in `text`, or `null`. */
export declare function findNamedColor(text: string): string | null;
