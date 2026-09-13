import { useEffect, useRef, useState } from 'react';

import { useSaveForm } from '../api/forms';
import { builderPath, previewPath } from '../router/routes';
import {
  clearNavigationBlocker,
  navigate,
  setNavigationBlocker,
} from '../router/use-route';
import { currentDefinition, useBuilderStore } from './builder-store';

/**
 * The leave dialog of the builder — review finding 21.
 *
 * The draft in the builder store is pure working memory: it survives no reload
 * and no closed tab. Up to here there was **no** navigation blocker in the whole
 * repository — no `beforeunload`, no query, nothing —, and the switch to another
 * tab threw the work away without a word. This hook therefore attaches itself to
 * the one door every navigation of the application goes through (`navigate`), to
 * the back button of the browser (`popstate`, handled in `use-route.ts`) and to
 * the closing of the tab (`beforeunload`).
 *
 * ## What is **not** blocked, and why
 *
 * The builder and the preview of the **same** form: since finding 21b the
 * document stays in the store when switching between them, the preview shows
 * exactly this unsaved state and names it. Nothing is lost there, so there is
 * nothing to ask — a query whose two answers („Speichern", „Verwerfen") both
 * *remove* the unsaved state would make the live preview unreachable, for which
 * it is posed. Every other way — the remaining entries of the form navigation,
 * the header navigation, back, closing the tab — asks.
 *
 * ## Why here and not in the view
 *
 * Two views hold the same draft open (builder and preview), and both have to ask
 * the same question. Two handwritten versions are exactly the construction in
 * which one of the two forgets a door.
 */
export interface DraftGuard {
  /** Where the intercepted navigation wanted to go, or `null`. */
  readonly pending: string | null;
  /** The saving of the dialog is running. */
  readonly busy: boolean;
  /** What went wrong while saving, or `null`. */
  readonly error: string | null;
  /** „Speichern" is offered. */
  readonly canSave: boolean;
  readonly onSave: () => void;
  readonly onDiscard: () => void;
  readonly onCancel: () => void;
}

export function useDraftGuard({
  formId,
  canSave,
}: {
  readonly formId: string;
  /**
   * `can_build` on **this** form. Without the permission every save fails at
   * the guard, so the button is not offered in the first place — the same rule
   * by which the bar of the builder leaves it out.
   */
  readonly canSave: boolean;
}): DraftGuard {
  const isDirty = useBuilderStore((state) => state.isDirty);
  const loadedFormId = useBuilderStore((state) => state.formId);
  const markSaved = useBuilderStore((state) => state.markSaved);
  const reset = useBuilderStore((state) => state.reset);
  const save = useSaveForm();

  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Counts the queries posed — the answer to an **aborted** one must not take
   * effect any more (review rework on finding 21).
   *
   * Escape closes the dialog while the saving is running as well (the focus
   * trap does not know „busy", and the three buttons are blocked then anyway).
   * Without this counter the returning mutation navigated afterwards precisely
   * to where the editor **no longer** wanted to go. It is saved nevertheless:
   * the request was on its way and has arrived — only the leaving is dropped.
   */
  const askedRef = useRef(0);

  /*
   * `loadedFormId === formId` is not decoration: the view is called with a form
   * id, the store possibly still carries a different one (the loading is
   * running), and a blocker over a foreign document would promise a save that
   * overwrote the wrong form.
   */
  const guarding = isDirty && loadedFormId === formId;

  useEffect(() => {
    if (!guarding) {
      return;
    }
    // The two addresses that keep the draft — see above.
    const keepsDraft = [builderPath(formId), previewPath(formId)];
    /*
     * The own blocker is held on to, so that the cleanup **recognises** it
     * again (review finding 14). An unconditional `= null` would also remove a
     * blocker that somebody else has set in the meantime — today unreachable
     * (the shell only ever mounts one of the two views, and React runs all
     * teardown phases first and all setup phases afterwards), tomorrow the
     * silent door through which a dialog or a side panel clears away the
     * other's query.
     */
    const mine = (path: string): boolean => {
      if (keepsDraft.includes(path)) {
        return false;
      }
      askedRef.current += 1;
      setPending(path);
      setError(null);
      return true;
    };
    setNavigationBlocker(mine);
    return () => {
      clearNavigationBlocker(mine);
    };
  }, [guarding, formId]);

  useEffect(() => {
    if (!guarding) {
      return;
    }
    const warn = (event: BeforeUnloadEvent): void => {
      /*
        **Both halves**, although `returnValue` is deprecated: the specification
        demands `preventDefault()`, older and individual current browsers
        (Safari) only ask when `returnValue` is set. The one without the other
        would mean that the closing of the tab goes through silently on some
        browser — and that is exactly the loss this hook exists against; no test
        could find it. The text is the browser's anyway, an own wording is not
        displayable.
      */
      event.preventDefault();
      // Deprecated and set nevertheless — the paragraph above says why.
      // Suppressed instead of tolerated: a permanently standing warning makes
      // the next, real one invisible (the same rule as in `use-focus-trap.ts`).
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- the second half of the query, see above
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
    };
  }, [guarding]);

  /** Goes where the intercepted navigation wanted to go. */
  const leave = (path: string): void => {
    setPending(null);
    // `force`, otherwise the own blocker would hold up the own answer.
    navigate(path, { force: true });
  };

  /*
    A **clean** document is thrown away when leaving — review rework on finding
    21b.

    Only what is unsaved stays standing; the staying is made for that (builder →
    preview → builder). A saved document on the other hand is merely a copy of
    what the server has, and the builder deliberately does not reload at
    `loadedFormId === formId`: if the copy stayed lying around, the next opening
    would show a possibly outdated state, and the editor would only learn of it
    at the revision conflict when saving.

    In the hook instead of in the two views, because both need the same rule —
    two handwritten versions are the construction in which one of them is
    forgotten (the preview was exactly that, until a review found it).
  */
  useEffect(
    () => () => {
      const state = useBuilderStore.getState();
      if (state.formId === formId && !state.isDirty) {
        state.reset();
      }
    },
    [formId],
  );

  return {
    pending,
    busy: save.isPending,
    error,
    canSave,
    onSave: () => {
      if (pending === null) {
        return;
      }
      setError(null);
      const asked = askedRef.current;
      const target = pending;
      const state = useBuilderStore.getState();
      save.mutate(
        {
          formId,
          request: {
            title: state.title,
            definition: currentDefinition(state),
            revision: state.revision,
          },
        },
        {
          onSuccess: (saved) => {
            markSaved(saved.revision);
            // The query has been aborted in the meantime (Escape while
            // saving): saved is saved, the page is nevertheless not left.
            if (askedRef.current === asked) {
              leave(target);
            }
          },
          // The dialog stays up and says what happened. Going on would mean
          // throwing the work away precisely in the moment in which the editor
          // wanted to rescue it.
          onError: () => {
            setError(
              'Der Entwurf konnte nicht gespeichert werden. Die Seite wurde deshalb nicht verlassen.',
            );
          },
        },
      );
    },
    onDiscard: () => {
      if (pending === null) {
        return;
      }
      // Empty it first, then go: a document left standing in the store would
      // be a „Verwerfen" that discards nothing — the preview would keep showing
      // it, and the builder would find it again at the next opening.
      reset();
      leave(pending);
    },
    onCancel: () => {
      askedRef.current += 1;
      setPending(null);
      setError(null);
    },
  };
}
