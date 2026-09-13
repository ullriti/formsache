import { useEffect, useState } from 'react';

/**
 * A locally typed draft that a server answer may replace — but **never while
 * somebody is typing** .
 *
 * ## The race this exists for
 *
 * All three settings surfaces of this application do the same thing: they load
 * a document, keep the unsaved edits beside it, `PUT` them, and take the
 * server's answer as the new baseline. That last step is not optional — a save
 * answers with values the client deliberately did not compute
 * (`setSectionOverride` copies a whole section into a form that has just taken
 * it over) and with the revision the next write has to echo back.
 *
 * Written the obvious way it is also a data loss. `SettingsView` had
 * `onSuccess: (saved) => setState({ formId, draft: draftOf(saved) })`, and
 * `TenantFormDefaultsView` the same line with `patch: {}`: whoever keeps typing
 * during the round trip watches their input disappear the moment the answer
 * arrives. It is the third member of a family this project has already paid for
 * twice — `ResponseEditView` replacing the whole page on a failed background
 * refetch and the ref mutated during render found in an earlier review.
 * All three are an **asynchronous answer overwriting synchronously created user
 * state**, which is why what is required is one shared shape rather than
 * three fixes.
 *
 * ## How it tells „typed" from „not typed"
 *
 * By counting edits, not by comparing values. {@link ServerDraft.beginSave}
 * takes the count as it stands when the save starts and hands back the callback
 * for the mutation's `onSuccess`; that callback adopts the answer only if the
 * count has not moved since. Comparing the *values* instead would be wrong in
 * the one case that matters: typing a field back to what it held is still
 * typing, and the editor is still looking at a cursor in that field.
 *
 * ## Why adopting means „forget the draft" rather than „store the answer"
 *
 * The draft is an overlay over the loaded document, and the loaded document is
 * the query cache — which the mutation itself refreshes with the answer
 * (`setQueryData` in `api/settings.ts` and `api/system-settings.ts`). Dropping
 * the local state therefore *is* taking the answer as the new baseline, in one
 * place instead of two, and it is why this hook never has to know what a
 * document looks like. `Draft` stays whatever the view finds useful: a patch, a
 * patch plus four switches, anything.
 *
 * ## Nothing is ever copied into state, and one thing is cleared out of it
 *
 * The seed comes from the render, not from an effect that copies the loaded
 * document into state: a draft nobody has touched *is* the baseline, so there
 * is nothing to copy. That removes a frame the two existing views had to
 * comment on — while their effect was still pending, the page showed the
 * previous organisation's unsaved edits next to the new organisation's document.
 *
 * The one effect that remains does the opposite of copying: it **forgets** a
 * draft whose subject is gone. See the comment at it — leaving that out was a
 * data-loss bug a review caught.
 */

/** The local state, tagged with the subject it was typed for. */
interface DraftState<Draft> {
  /**
   * Which document this draft belongs to — the form id, the organisation id, or the
   * one system row.
   *
   * The tag is not bookkeeping. Without it, switching organisations in the header left
   * one organisation's edits in state while the loaded document became the other's, and
   * „Speichern" wrote them into the wrong organisation's standards — a review
   * reproduced it before this shipped.
   */
  readonly key: string;
  readonly draft: Draft;
  /** How often {@link ServerDraft.setDraft} has been called for this `key`. */
  readonly edits: number;
}

export interface ServerDraft<Draft> {
  /**
   * What the view renders: the local draft, or the baseline while nothing has
   * been typed. `null` means the document has not arrived yet.
   */
  readonly draft: Draft | null;
  /**
   * Records one local edit.
   *
   * **The updater form is the one to reach for from an async handler.** A
   * caller that spreads the `draft` of its own render closes over the state as
   * it was when that render happened, and an answer arriving later then writes
   * it back over whatever was typed in the meantime — measured in a review,
   * where a colour changed during a logo upload was lost the moment the
   * upload answered.
   */
  readonly setDraft: (next: Draft | ((previous: Draft) => Draft)) => void;
  /**
   * Starts a save.
   *
   * Call it **when the request goes out** and hand the result to the mutation's
   * `onSuccess`; it adopts the answer as the new baseline unless something was
   * typed in between.
   */
  readonly beginSave: () => () => void;
}

/**
 * @param key    the document the draft belongs to; `undefined` while there is
 *               none (no organisation scoped yet, say).
 * @param baseline what the fields show before anything is typed — derived from
 *               the loaded document, `undefined` while it is still loading.
 */
export function useServerDraft<Draft>(
  key: string | undefined,
  baseline: Draft | undefined,
): ServerDraft<Draft> {
  const [state, setState] = useState<DraftState<Draft> | null>(null);

  /**
   * Read through the tag, so a render that happens *before* the effect below has
   * run already shows the new document rather than the previous subject's edits.
   *
   * ⚠️ **No test can tell this line from `const current = state`, and that is
   * worth writing down rather than pretending otherwise.** Removing it leaves the
   * whole suite green: the effect clears the slot on every key change, and with
   * `fireEvent` inside `act()` effects flush before anything is observable, so
   * the frame this guards is not reachable from jsdom. It stays because React is
   * allowed to render without committing — a deferred or suspended render of the
   * new subject would otherwise paint the old subject's draft — and because it is
   * the cheap half of the pair. It is belt to the effect's braces, not a
   * mechanism of its own; the effect is what carries the rule.
   */
  const current = state !== null && state.key === key ? state : null;

  /**
   * Forget a draft that was typed for another subject.
   *
   * **Reading through the tag is not enough, and a review found out why.** It
   * hides the stale draft while another organisation is on screen, but it leaves it in
   * the slot: typing in Organisation A, switching to B and back to A brought A's old
   * entries *back* — now laid over a freshly loaded document with a **newer
   * revision**. Saving then overwrote somebody else's write with values typed
   * before it, silently, which is exactly what the revision check exists to
   * prevent. The `useEffect` this hook replaced did not only copy the loaded
   * document into state, it also cleared it, and only the copying was worth
   * removing.
   *
   * **An effect, and deliberately not two alternatives:**
   *
   * - Not `setState` during render. Adjusting state while rendering is a
   *   documented React pattern, but „asynchronous answer overwrites synchronous
   *   user state" is the family this whole hook is about, and
   *   a review found its render-phase variant in this code base already.
   *   Not the shape to reach for here.
   * - Not one draft **per key** in a `Map`. That is the bug rather than the fix:
   *   keeping A's draft for a possible return is precisely what must not happen,
   *   because the document it was typed against has been reloaded since.
   *
   * There is no window in between: `setDraft` builds a fresh slot whenever the
   * key differs, so typing in B never lands on A's count, and an effect flushes
   * before anybody can interact with what it cleaned up.
   */
  useEffect(() => {
    setState((previous) =>
      previous === null || previous.key === key ? previous : null,
    );
  }, [key]);

  return {
    draft: current !== null ? current.draft : (baseline ?? null),

    setDraft: (next: Draft | ((previous: Draft) => Draft)): void => {
      if (key === undefined) {
        // Loud rather than defensive. A draft typed for no subject has nowhere
        // to be saved, so swallowing it would produce a page whose fields
        // accept input and whose „Speichern" does nothing — the failure mode
        // this project keeps writing tests against. Unreachable today: all
        // three views render their fields only once they have a subject.
        throw new Error('A draft was typed while no document was loaded.');
      }
      setState((previous) => {
        const base =
          previous !== null && previous.key === key
            ? previous.draft
            : (baseline as Draft);
        return {
          key,
          draft:
            typeof next === 'function'
              ? (next as (previous: Draft) => Draft)(base)
              : next,
          edits:
            (previous !== null && previous.key === key ? previous.edits : 0) +
            1,
        };
      });
    },

    beginSave: (): (() => void) => {
      // Both marks are read from the render the save was triggered in — an
      // event handler always belongs to the latest one, so this is the state as
      // it was when the editor pressed the button.
      const savedKey = key;
      const savedEdits = current?.edits ?? 0;

      return (): void => {
        setState((previous) => {
          const untouched =
            previous === null
              ? savedEdits === 0
              : previous.key === savedKey && previous.edits === savedEdits;
          // Dropping the local state hands the fields back to the baseline,
          // which by now is built from this very answer.
          return untouched ? null : previous;
        });
      };
    },
  };
}
