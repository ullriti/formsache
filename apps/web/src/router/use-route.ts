import { useCallback, useSyncExternalStore } from 'react';

import { parseRoute, type Route } from './routes';

/**
 * The current route, and the one way to change it.
 *
 * `useSyncExternalStore` rather than a `useState` plus an effect: the browser's
 * history *is* an external store, and this hook is the textbook shape for one.
 * It also means the first render already has the right route — an effect would
 * paint the dashboard for one frame before switching to the builder, which is
 * exactly the flicker a bookmarked builder URL must not have.
 */

/** Listeners of our own `navigate()`; `popstate` covers the browser's buttons. */
const listeners = new Set<() => void>();

/**
 * The address currently on screen.
 *
 * Kept beside `window.location` on purpose: a **blocked** Back has already
 * moved the browser by the time anyone can object, so undoing it needs the
 * address that was showing a moment ago — and `window.location` no longer
 * knows it. See {@link onPopState}.
 */
let shownPath = '/';

/**
 * A veto over a navigation — the builder's Verlassen-Dialog and nothing else
 * so far.
 *
 * Returning `true` means „I have taken this over": the address does **not**
 * change, and the blocker is responsible for asking the question and then
 * navigating with `force` once it has an answer. Returning `false` lets the
 * navigation through untouched.
 *
 * A single blocker rather than a set: two views cannot be leaving at the same
 * time, and a chain of vetoes would raise „which dialog wins" — a question no
 * caller has. It lives here rather than in the view because *this* is the one
 * door every in-app navigation goes through; a guard installed anywhere else
 * would cover the entries it knows about and silently miss the rest (measured:
 * before this existed there was no navigation lock in the repository at all,
 * and the builder lost unsaved work to the Vorschau tab without a word).
 */
export type NavigationBlocker = (path: string) => boolean;

let blocker: NavigationBlocker | null = null;

/**
 * Installs the veto.
 *
 * **Throws when another blocker already holds the slot** (review finding 14).
 * The single slot above is an assumption, not a law of the application: today
 * only `AppShell` mounts the two views that install one, and React runs every
 * destroy phase before every create phase, so a *replacement* is always
 * preceded by its own cleanup. The moment a second hook mounts beside the
 * first — a dialogue, a side panel, a `<Suspense>` boundary — that stops being
 * true, and a silent overwrite would leave the application navigating past a
 * question somebody is still owed. A comment cannot enforce that; this can.
 *
 * Re-installing the **same** function is not a conflict: React's StrictMode
 * double-invokes an effect, and an effect that reran with an unchanged
 * dependency list must not blow up.
 */
export function setNavigationBlocker(next: NavigationBlocker): void {
  if (blocker !== null && blocker !== next) {
    throw new Error(
      'use-route: eine Navigationssperre steht bereits — zwei gleichzeitige Sperren sind nicht vorgesehen.',
    );
  }
  blocker = next;
}

/**
 * Clears the veto — **only if it is still the caller's own**.
 *
 * The identity check is the other half of the single slot: an unconditional
 * `= null` in a cleanup removes whatever happens to be installed, including a
 * blocker a *different* hook put there a moment ago. Clearing a foreign
 * blocker is exactly the silent failure this pair exists to rule out, and
 * unlike the double-install above it cannot be made loud — a cleanup that runs
 * after somebody else took over is ordinary React, not a mistake.
 */
export function clearNavigationBlocker(mine: NavigationBlocker): void {
  if (blocker === mine) {
    blocker = null;
  }
}

function currentPath(): string {
  return window.location.pathname;
}

function notify(): void {
  shownPath = currentPath();
  for (const listener of listeners) {
    listener();
  }
}

/**
 * The browser's own Back and Forward.
 *
 * A blocked step has to be **undone**, not merely ignored: `popstate` fires
 * *after* the browser has already changed the address, so leaving it alone
 * would show the builder under the address of the page it refused to go to —
 * and the next reload would land there. Pushing `shownPath` back is the best
 * a History-API application can do; it costs one extra forward entry, which is
 * the price every router pays for this.
 */
function onPopState(): void {
  if (blocker?.(currentPath()) === true) {
    window.history.pushState(null, '', shownPath);
    return;
  }
  notify();
}

/**
 * One `popstate` listener for all subscribers, ref-counted.
 *
 * It used to be the subscriber's own callback, which cannot work any more: the
 * blocker has to be asked **once** per Back — before any view re-renders — and
 * one listener per mounted `useRoute()` would ask it once per subscriber and
 * push the address back as many times.
 */
function subscribe(onChange: () => void): () => void {
  if (listeners.size === 0) {
    shownPath = currentPath();
    window.addEventListener('popstate', onPopState);
  }
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0) {
      window.removeEventListener('popstate', onPopState);
    }
  };
}

/**
 * Goes to a path.
 *
 * `pushState` does not emit `popstate` — that event is the *browser's* to
 * fire — so subscribers are notified here. Missing this is the classic bug of
 * a hand-written router: the URL changes and nothing re-renders.
 *
 * `force` is how a blocker finishes what it started: the Verlassen-Dialog asks
 * its question and then navigates to the very path it just refused. Without an
 * explicit way past the veto it would refuse itself for ever.
 *
 * `replace` rewrites the address instead of laying a second one into the history
 * — for steps **nobody walked**: the redirect of an old
 * address and the start page of a superadmin without an organisation (`AppShell`).
 * With `pushState` there would be an entry behind it that the back button enters and
 * that immediately pushes it back out.
 */
export function navigate(
  path: string,
  options?: { readonly force?: boolean; readonly replace?: boolean },
): void {
  if (path === currentPath()) {
    return;
  }
  if (options?.force !== true && blocker?.(path) === true) {
    return;
  }
  if (options?.replace === true) {
    window.history.replaceState(null, '', path);
  } else {
    window.history.pushState(null, '', path);
  }
  notify();
}

/**
 * The address on screen, as a subscribed value.
 *
 * Getrennt von {@link useRoute}, weil eine Route **gröber** ist als ein Pfad:
 * zwei Adressen können auf dieselbe Route zeigen, und ein Effekt an der Route
 * sähe den Schritt dazwischen nicht. Der eine Anlass, der das brauchte —
 * das Heilen einer alten Adresse in der Adresszeile —, ist mit der
 * Weiterleitungstabelle fort (Review-Runde 4 Nr. 8); die Trennung bleibt,
 * weil {@link useRoute} auf ihr steht.
 *
 * Nicht exportiert: außerhalb dieser Datei liest niemand den rohen Pfad, und
 * ein Export ohne Aufrufer ist eine Einladung, die Route zu umgehen.
 */
function usePath(): string {
  return useSyncExternalStore(subscribe, currentPath, () => '/');
}

export function useRoute(): Route {
  return parseRoute(usePath());
}

/**
 * An `onClick` for internal links.
 *
 * Returns a handler that navigates *and* lets the browser do its normal thing
 * for a modified click — ctrl/cmd/shift/middle click must still open a tab, or
 * the link is a button wearing an anchor's clothes.
 */
export function useLinkHandler(
  path: string,
): (event: React.MouseEvent<HTMLAnchorElement>) => void {
  return useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      event.preventDefault();
      navigate(path);
    },
    [path],
  );
}
