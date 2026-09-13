import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * **Evaluating a stylesheet on a rendered tree.**
 *
 * jsdom computes no cascade: `getComputedStyle` knows neither the rules of a
 * `.css` file nor `var(--token)`. Until now a test about appearance could therefore
 * only do two things — check the class name of an element (that is, the
 * implementation, not the statement) or search the source of the CSS file for a
 * string (that is, the spelling of a rule, not its effect).
 * Both pass green right by exactly the bug that is usually at stake: the rule
 * is there, it just does not take hold on the element one has in mind.
 *
 * This file closes the gap for the three properties on which
 * review findings hung — opacity, alignment, padding:
 *
 * 1. It reads the rules of the file (comments, `@media` blocks included),
 * 2. checks them with `element.matches()` against the **really rendered** tree,
 * 3. decides by specificity and order like a browser,
 * 4. and resolves `var(--token)` against `styles/tokens.css`.
 *
 * With that a test measures "the button is not dimmed" and "header and cell
 * stand on the same edge" — and stays green when someone renames the
 * classes, as long as the statement holds.
 *
 * ## Limits, so that nobody reads more into it than is in it
 *
 * It is **no** browser: inheritance is modelled only for `text-align`
 * (`inheritedValue`), `!important`, `@layer`, `:hover` and the
 * shorthand notations other than `padding`/`margin` stay outside. What
 * does not stand here is checked by the Playwright run.
 *
 * Three further limits that can make a measurement **silently** wrong and
 * therefore stand here, not only in the head of whoever wrote the file:
 *
 * 1. **A cascade only sees the files one gives it.** `fromFile` therefore takes
 *    several paths. Whoever loads only the file of the view and renders the tree in
 *    its shell reads every rule from `app-shell.css` as "not
 *    present" — with {@link effectiveOpacity} that means: an inherited
 *    dimming counts as 1, that is exactly the case on which finding 25 hung. Today
 *    `FormMemberRow.test.tsx` is right, because it renders without a shell; that is a
 *    property of the test, not of the tool.
 * 2. **`readTokens()` knows no context.** It reads `styles/tokens.css`
 *    linearly, last assignment wins — across `@media` blocks,
 *    `prefers-color-scheme` and tenant areas. A token that gets a different value
 *    in a media block is therefore read here with *that*
 *    value, regardless of which block would apply.
 * 3. **Selectors are checked with `element.matches()`**, that is, on the
 *    element alone. Combinators over ancestors work through that (jsdom
 *    knows the tree), but everything state-dependent (`:hover`, `:focus-visible`)
 *    never applies here, even if it would apply in the browser.
 */

interface CssRule {
  readonly selectors: readonly string[];
  readonly declarations: ReadonlyMap<string, string>;
  /** Position in the file — with equal specificity the later one wins. */
  readonly order: number;
}

/** Nesting at-rules: their content is rules again. */
const NESTING_AT_RULE = /^@(media|supports|layer|container)\b/u;

const SHORTHAND_SIDES = ['top', 'right', 'bottom', 'left'] as const;

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//gu, ' ');
}

/** Index of the closing brace matching the one opened at `open`. */
function matchingBrace(css: string, open: number): number {
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    const char = css[index];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  throw new Error('css-cascade: unbalanced braces');
}

/** Split at depth 0 — `:is(a, b)` is *one* selector, not two. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
    }
    if (char === separator && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/**
 * Tracing `padding-left` back to `padding`. Without that, "padding-left"
 * would answer the question with `undefined`, although the padding is there —
 * and the test would be green right past the point. Splitting happens **after**
 * the tokens are resolved, otherwise `split` would cut through the spaces in
 * `var(--space-7)`.
 */
function boxShorthandOf(
  property: string,
): { shorthand: string; index: number } | undefined {
  const match = /^(padding|margin)-(top|right|bottom|left)$/u.exec(property);
  const shorthand = match?.[1];
  const side = match?.[2];
  if (shorthand === undefined || side === undefined) {
    return undefined;
  }
  return {
    shorthand,
    index: SHORTHAND_SIDES.indexOf(side as (typeof SHORTHAND_SIDES)[number]),
  };
}

/** The side out of `0 20px 18px` — the fill-in rules of CSS, written out. */
function boxSide(value: string, index: number): string {
  const parts = value.split(/\s+/u).filter((part) => part.length > 0);
  const [top, right = top, bottom = top, left = right] = parts;
  if (top === undefined) {
    throw new Error('css-cascade: leere Kurzschreibweise');
  }
  return [top, right, bottom, left][index] ?? top;
}

function parseDeclarations(body: string): Map<string, string> {
  const declarations = new Map<string, string>();
  for (const part of splitTopLevel(body, ';')) {
    const colon = part.indexOf(':');
    if (colon === -1) {
      continue;
    }
    declarations.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim());
  }
  return declarations;
}

function parseInto(css: string, rules: CssRule[]): void {
  let index = 0;
  let prelude = '';
  while (index < css.length) {
    const char = css.charAt(index);
    if (char !== '{') {
      prelude += char;
      index += 1;
      continue;
    }
    const end = matchingBrace(css, index);
    const body = css.slice(index + 1, end);
    const head = prelude.trim();
    if (NESTING_AT_RULE.test(head)) {
      parseInto(body, rules);
    } else if (head.length > 0 && !head.startsWith('@')) {
      rules.push({
        selectors: splitTopLevel(head, ','),
        declarations: parseDeclarations(body),
        order: rules.length,
      });
    }
    index = end + 1;
    prelude = '';
  }
}

/**
 * Specificity as one number. Rough, but exact for the selectors of this
 * project: `#` counts a hundredfold, classes/attributes/pseudo-classes singly,
 * element names as a fraction.
 */
function specificity(selector: string): number {
  const ids = selector.match(/#[\w-]+/gu)?.length ?? 0;
  const withoutElements = selector.replace(/::[\w-]+/gu, ' ');
  const classes =
    withoutElements.match(/\.[\w-]+|\[[^\]]*\]|:[\w-]+/gu)?.length ?? 0;
  const types =
    selector
      .replace(/\[[^\]]*\]/gu, ' ')
      .replace(/::?[\w-]+(\([^)]*\))?/gu, ' ')
      .match(/(^|[\s>+~])[a-zA-Z][\w-]*/gu)?.length ?? 0;
  return ids * 10_000 + classes * 100 + types;
}

/** Resolve a `var(--x)`/`var(--x, y)` until nothing is left of it. */
function resolveValue(
  value: string,
  tokens: ReadonlyMap<string, string>,
  depth = 0,
): string {
  if (!value.includes('var(') || depth > 10) {
    return value;
  }
  const start = value.indexOf('var(');
  const end = matchingParen(value, start + 3);
  const args = splitTopLevel(value.slice(start + 4, end), ',');
  const name = args[0] ?? '';
  const fallback = args.slice(1).join(', ');
  const token = tokens.get(name);
  if (token === undefined && fallback === '') {
    throw new Error(`css-cascade: unbekanntes Token ${name}`);
  }
  const replacement = token ?? fallback;
  return resolveValue(
    `${value.slice(0, start)}${replacement}${value.slice(end + 1)}`,
    tokens,
    depth + 1,
  );
}

function matchingParen(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '(') {
      depth += 1;
    } else if (text[index] === ')') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  throw new Error('css-cascade: unbalanced parentheses');
}

interface Declaration {
  readonly value: string;
  readonly rank: number;
  readonly order: number;
}

/** Higher specificity wins, in a tie the later rule. */
function beats(candidate: Declaration, held: Declaration): boolean {
  return (
    candidate.rank > held.rank ||
    (candidate.rank === held.rank && candidate.order >= held.order)
  );
}

/** The assignments of `styles/tokens.css`, last assignment wins. */
function readTokens(): Map<string, string> {
  const source = stripComments(
    readFileSync(resolve(process.cwd(), 'src/styles/tokens.css'), 'utf8'),
  );
  const tokens = new Map<string, string>();
  for (const match of source.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/gu)) {
    const [, name, value] = match;
    if (name !== undefined && value !== undefined) {
      tokens.set(name, value.trim());
    }
  }
  return tokens;
}

export class Cascade {
  private readonly rules: readonly CssRule[];
  private readonly tokens: ReadonlyMap<string, string>;

  private constructor(rules: readonly CssRule[], tokens: Map<string, string>) {
    this.rules = rules;
    this.tokens = tokens;
  }

  /**
   * Loads stylesheet files relative to `apps/web` (for instance `src/views/x.css`).
   *
   * **Several paths are allowed, and often necessary** — in the order in which
   * the application includes them, because with equal specificity the
   * later rule wins. Whoever measures a tree *in its shell* has to pass that
   * shell's stylesheet too; otherwise the cascade reads every rule from it as not
   * present (limit 1 in the file header).
   */
  static fromFile(...relativePaths: readonly string[]): Cascade {
    if (relativePaths.length === 0) {
      throw new Error('css-cascade: keine Datei angegeben');
    }
    const rules: CssRule[] = [];
    for (const relativePath of relativePaths) {
      const before = rules.length;
      parseInto(
        stripComments(
          readFileSync(resolve(process.cwd(), relativePath), 'utf8'),
        ),
        rules,
      );
      if (rules.length === before) {
        // Floor under the guard: a moved file would turn every measurement
        // below it into a claim about nothing.
        throw new Error(`css-cascade: keine Regeln in ${relativePath}`);
      }
    }
    return new Cascade(rules, readTokens());
  }

  /** The value that the cascade assigns to this element **itself**. */
  declaredValue(element: Element, property: string): string | undefined {
    const direct = this.winner(element, property);
    const box = boxShorthandOf(property);
    const shorthand =
      box === undefined ? undefined : this.winner(element, box.shorthand);

    if (box === undefined || shorthand === undefined) {
      return direct === undefined
        ? undefined
        : resolveValue(direct.value, this.tokens);
    }
    if (direct !== undefined && beats(direct, shorthand)) {
      return resolveValue(direct.value, this.tokens);
    }
    return boxSide(resolveValue(shorthand.value, this.tokens), box.index);
  }

  /** The rule that wins for exactly this property on this element. */
  private winner(element: Element, property: string): Declaration | undefined {
    let best: Declaration | undefined;
    for (const rule of this.rules) {
      const value = rule.declarations.get(property);
      if (value === undefined) {
        continue;
      }
      for (const selector of rule.selectors) {
        if (!element.matches(selector)) {
          continue;
        }
        const candidate = {
          value,
          rank: specificity(selector),
          order: rule.order,
        };
        if (best === undefined || beats(candidate, best)) {
          best = candidate;
        }
      }
    }
    return best;
  }

  /**
   * The **effective** opacity: opacity is not inherited, it
   * multiplies — a button in a row with `opacity: 0.55` is
   * dimmed without any rule ever naming it. Exactly on that hung finding 25.
   */
  effectiveOpacity(element: Element): number {
    let opacity = 1;
    let current: Element | null = element;
    while (current !== null) {
      const declared = this.declaredValue(current, 'opacity');
      if (declared !== undefined) {
        const factor = Number(declared);
        if (Number.isNaN(factor)) {
          throw new Error(
            `css-cascade: opacity ist keine Zahl ("${declared}")`,
          );
        }
        opacity *= factor;
      }
      current = current.parentElement;
    }
    return opacity;
  }

  /**
   * The value of an **inherited** property (`text-align`): the nearest
   * element upwards that says something about it.
   */
  inheritedValue(element: Element, property: string): string | undefined {
    let current: Element | null = element;
    while (current !== null) {
      const declared = this.declaredValue(current, property);
      if (declared !== undefined) {
        return declared;
      }
      current = current.parentElement;
    }
    return undefined;
  }

  /**
   * A length in pixels — `undefined` if nothing is assigned.
   *
   * **The unitless zero counts too.** CSS allows it for every length, and
   * a shorthand notation writes it down all the time: `padding: 0 var(--space-7)
   * var(--space-6)` yields plain `0` for `padding-top`. A pattern that only
   * accepts `…px` threw an exception there that looked like a defect in the
   * CSS file — the error was in the measuring device. Everything else without a unit
   * remains an error: `1.5` is not a valid statement for a length, and
   * to read it silently as `1.5px` would mean guessing.
   */
  pixels(element: Element, property: string): number | undefined {
    const value = this.declaredValue(element, property);
    if (value === undefined) {
      return undefined;
    }
    const match = /^(-?[\d.]+)(px)?$/u.exec(value.trim());
    const amount = match?.[1];
    if (
      amount === undefined ||
      (match?.[2] === undefined && Number(amount) !== 0)
    ) {
      throw new Error(
        `css-cascade: ${property} ist keine Pixel-Länge ("${value}")`,
      );
    }
    return Number(amount);
  }
}
