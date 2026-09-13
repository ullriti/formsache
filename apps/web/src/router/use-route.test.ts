import { afterEach, describe, expect, it } from 'vitest';

import {
  clearNavigationBlocker,
  navigate,
  setNavigationBlocker,
  type NavigationBlocker,
} from './use-route';

/**
 * **The one slot for the navigation blocker** (review finding 14).
 *
 * `use-route.ts` holds exactly *one* blocker, and that is deliberate: two views
 * never leave at the same time, and a chain of vetoes would raise the question
 * of which dialogue wins. What of that was so far only a comment is the
 * assumption *under* the one slot — that two hooks are never
 * mounted at the same time. Today it holds, because `AppShell` only ever mounts
 * one of the two views and React runs all tear-down phases first, then all set-up ones.
 * A dialogue, a side panel or a `<Suspense>` boundary would break it, and a
 * silent break would mean: the application navigates past a query that
 * somebody is still entitled to.
 *
 * What is measured is therefore both — that a foreign clean-up **leaves** one's
 * own blocker **standing**, and that a second set fails **loudly**.
 */
describe('Navigationssperre', () => {
  /** A blocker that intercepts everything and records what was asked about. */
  function recordingBlocker(): NavigationBlocker & {
    readonly asked: string[];
  } {
    const asked: string[] = [];
    const blocker = (path: string): boolean => {
      asked.push(path);
      return true;
    };
    return Object.assign(blocker, { asked });
  }

  /** What this test has set — otherwise the module state outlives the test. */
  let installed: NavigationBlocker | null = null;

  function install(blocker: NavigationBlocker): void {
    setNavigationBlocker(blocker);
    installed = blocker;
  }

  afterEach(() => {
    if (installed !== null) {
      clearNavigationBlocker(installed);
      installed = null;
    }
    window.history.replaceState(null, '', '/');
  });

  it('hält die Navigation an, solange sie gesetzt ist', () => {
    const mine = recordingBlocker();
    install(mine);

    navigate('/admin/trash');

    expect(mine.asked).toStrictEqual(['/admin/trash']);
    expect(window.location.pathname).toBe('/');
  });

  /**
   * **The finding.** A clean-up that does not check whom the blocker belongs to
   * removes the other one's — and the next navigation goes through unasked.
   */
  it('lässt sich von einem fremden Aufräumen nicht abräumen', () => {
    const mine = recordingBlocker();
    install(mine);

    clearNavigationBlocker(() => true);

    navigate('/admin/trash');

    expect(mine.asked).toStrictEqual(['/admin/trash']);
    expect(window.location.pathname).toBe('/');
  });

  it('gibt den Platz frei, wenn die eigene Sperre aufräumt', () => {
    const mine = recordingBlocker();
    install(mine);

    clearNavigationBlocker(mine);
    installed = null;

    navigate('/admin/trash');

    expect(mine.asked).toStrictEqual([]);
    expect(window.location.pathname).toBe('/admin/trash');
  });

  /**
   * The second half: the comment justifies the single slot, so the
   * violation of the assumption has to be loud instead of winning silently.
   */
  it('scheitert laut, wenn eine zweite Sperre gesetzt wird', () => {
    const mine = recordingBlocker();
    install(mine);

    expect(() => {
      setNavigationBlocker(() => true);
    }).toThrow(/Navigationssperre steht bereits/u);

    // …and the first one still stands unharmed.
    navigate('/admin/trash');
    expect(mine.asked).toStrictEqual(['/admin/trash']);
  });

  /**
   * Setting the same function again is **no** conflict: React calls
   * an effect twice in StrictMode, and an effect that ran again with
   * an unchanged dependency list must not blow up.
   */
  it('nimmt dieselbe Sperre ein zweites Mal an', () => {
    const mine = recordingBlocker();
    install(mine);

    expect(() => {
      setNavigationBlocker(mine);
    }).not.toThrow();
  });
});
