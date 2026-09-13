import { useSyncExternalStore } from 'react';

import { DESKTOP_MEDIA_QUERY } from '../styles/breakpoints';

/**
 * True while the viewport is at or above the desktop breakpoint (1180 px).
 *
 * The number itself lives once, in `breakpoints.ts` next to the CSS token —
 * this hook only consumes it. `matchMedia` rather than a resize listener: the
 * browser already evaluates the query, so there is no scroll-bar arithmetic to
 * get wrong and no listener firing on every pixel of a drag.
 *
 * `useSyncExternalStore` keeps the value out of component state, so there is
 * no render pass with the wrong layout before an effect corrects it.
 */
function subscribe(onStoreChange: () => void): () => void {
  const query = window.matchMedia(DESKTOP_MEDIA_QUERY);
  query.addEventListener('change', onStoreChange);

  return () => {
    query.removeEventListener('change', onStoreChange);
  };
}

function getSnapshot(): boolean {
  return window.matchMedia(DESKTOP_MEDIA_QUERY).matches;
}

export function useIsDesktop(): boolean {
  // The app is client-rendered; the server snapshot exists only to satisfy the
  // hook's signature and assumes the desktop layout.
  return useSyncExternalStore(subscribe, getSnapshot, () => true);
}
