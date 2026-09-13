/**
 * A `window.matchMedia` that actually evaluates.
 *
 * jsdom ships a stub whose `matches` is always `false` and never changes, so
 * every responsive test would silently run in one layout — and the mobile
 * requirement would be "proven" by a test that cannot fail. This fake
 * evaluates `(min-width: Npx)` against a viewport width the test sets, and
 * notifies listeners when that width changes.
 *
 * Unsupported query shapes throw instead of returning `false`: a typo in a
 * query is a broken test, not a mobile viewport.
 */

const MIN_WIDTH = /^\(min-width:\s*(\d+)px\)$/;

interface Registration {
  readonly query: string;
  readonly target: EventTarget;
}

const registrations: Registration[] = [];
let viewportWidth = 1280;

function evaluate(query: string): boolean {
  const match = MIN_WIDTH.exec(query.trim());
  const bound = match?.[1];

  if (bound === undefined) {
    throw new Error(`match-media fake: unsupported media query "${query}"`);
  }

  return viewportWidth >= Number(bound);
}

function createMediaQueryList(query: string): MediaQueryList {
  const target = new EventTarget();
  registrations.push({ query, target });

  const list = {
    media: query,
    get matches(): boolean {
      return evaluate(query);
    },
    onchange: null,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    // Deprecated aliases, kept because the interface still declares them.
    addListener: () => undefined,
    removeListener: () => undefined,
  };

  return list;
}

/** Installs the fake on `window`. Called once from the Vitest setup file. */
export function installMatchMedia(): void {
  window.matchMedia = createMediaQueryList;
}

/**
 * Sets the viewport width used by every media query and notifies listeners —
 * this is how a test moves across the 1180 px breakpoint.
 */
export function setViewportWidth(width: number): void {
  viewportWidth = width;

  for (const registration of registrations) {
    registration.target.dispatchEvent(new Event('change'));
  }
}

/** Resets to a desktop viewport and forgets listeners of finished tests. */
export function resetViewport(): void {
  viewportWidth = 1280;
  registrations.length = 0;
}
