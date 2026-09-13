/**
 * **The slice of jsdom this package uses** — declared by hand.
 *
 * jsdom brings no types of its own, and `@types/jsdom` lags behind the version
 * that lies here (29.x): there the reloading valve is still called
 * `ResourceLoader`, here it is called `resources.interceptors` together with
 * {@link requestInterceptor}. An outdated type package would therefore refuse
 * exactly the call with which `export-html.test.ts` measures whether the file
 * loads anything — the one assurance it is about.
 *
 * That is why the slice stands here: **only** what the test really uses, and
 * every line of it as a statement about what it expects of jsdom. It is
 * deliberately narrow — what does not stand here a test cannot use by accident
 * either.
 *
 * ## Why DOM shapes of our own instead of `lib: ["DOM"]`
 *
 * `packages/shared` runs in the server **and** in the browser, and its
 * `tsconfig.json` deliberately carries only `ES2023`: no `document`, no
 * `window`, no temptation to bind shared core logic to an environment.
 * Switching the DOM library on for the *tests* would open that boundary for
 * the whole workspace. The few shapes below are the price for it staying
 * closed.
 *
 * `ArrayLike` instead of `Iterable`, because `NamedNodeMap`, `CSSRuleList` and
 * `StyleSheetList` are indexed collections without `Symbol.iterator` in the
 * specification; `Array.from` reads all three.
 */
declare module 'jsdom' {
  export interface DomAttribute {
    readonly name: string;
    readonly value: string;
  }

  export interface DomStyleDeclaration {
    getPropertyValue(property: string): string;
  }

  export interface DomElement {
    readonly tagName: string;
    readonly textContent: string | null;
    readonly innerHTML: string;
    readonly attributes: ArrayLike<DomAttribute>;
    getAttribute(name: string): string | null;
    querySelector(selectors: string): DomElement | null;
    querySelectorAll(selectors: string): ArrayLike<DomElement>;
    dispatchEvent(event: object): boolean;
  }

  export interface DomCssRule {
    readonly cssText: string;
    /** Set on a style rule, absent on `@media`. */
    readonly selectorText?: string;
    readonly style?: DomStyleDeclaration;
    /** Set on an `@media` rule — `mediaText` is its condition, e.g. `print`. */
    readonly media?: { readonly mediaText: string };
    /** The rules **inside** an `@media` block. */
    readonly cssRules?: ArrayLike<DomCssRule>;
  }

  export interface DomStyleSheet {
    readonly cssRules: ArrayLike<DomCssRule>;
  }

  export interface DomDocument extends DomElement {
    readonly body: DomElement;
    readonly styleSheets: ArrayLike<DomStyleSheet>;
  }

  /**
   * The window of a loaded document.
   *
   * The index signature is what lets a test read the canary a payload would
   * set (`window.__formsacheExecuted`) — a global that only exists if something ran.
   */
  export interface DomWindow {
    readonly document: DomDocument;
    getComputedStyle(element: DomElement): DomStyleDeclaration;
    readonly Event: new (type: string) => object;
    [global: string]: unknown;
  }

  export class VirtualConsole {
    on(event: string, listener: (payload: unknown) => void): this;
  }

  /** Sees every request the document makes; a `Response` answers it locally. */
  export function requestInterceptor(
    handler: (
      request: { readonly url: string },
      context: { readonly element: unknown },
    ) => Response | undefined,
  ): unknown;

  export class JSDOM {
    constructor(
      html: string,
      options?: {
        readonly url?: string;
        readonly runScripts?: 'dangerously' | 'outside-only';
        readonly virtualConsole?: VirtualConsole;
        readonly resources?: 'usable' | { readonly interceptors?: unknown[] };
        readonly beforeParse?: (window: DomWindow) => void;
      },
    );
    readonly window: DomWindow;
  }
}
