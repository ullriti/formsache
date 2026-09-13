import type { ReactElement } from 'react';
import { useId } from 'react';

import { useFocusTrap } from '../shell/use-focus-trap';
import type { DraftGuard } from './use-draft-guard';

/**
 * „Ungespeicherte Änderungen" — the prompt before leaving the builder
 * (review finding 21a).
 *
 * Three ways, and all three are honest: **Speichern** saves and then goes,
 * **Verwerfen** goes and throws away, **Abbrechen** stays. Escape and the
 * click beside the dialog are „Abbrechen" — the most harmless of the three, and the
 * only one that may be triggerable by accident.
 *
 * The dialog decides nothing itself: what the three buttons do stands in
 * {@link useDraftGuard}, which also holds the lock. What stands here is only how the
 * question is asked — the same split as with `PublishNotice` next door, with the same
 * focus trap (`useFocusTrap`).
 *
 * No `openerRef`: the triggers are navigation entries that stay open
 * while the dialog stands; `document.activeElement` on opening is the same
 * button. With the browser's back button there is no trigger in the
 * document at all — the focus then falls onto the panel and travels on from there,
 * which the trap covers.
 */
export function DraftGuardDialog({
  busy,
  error,
  canSave,
  onSave,
  onDiscard,
  onCancel,
}: Omit<DraftGuard, 'pending'>): ReactElement {
  const titleId = useId();
  const bodyId = useId();
  const { panelRef, onKeyDown } = useFocusTrap({ onClose: onCancel });

  return (
    <div className="draft-guard">
      {/* As with the publish notice: convenient, but no second,
          unlabelled „Abbrechen" in the accessibility tree. */}
      <div
        className="draft-guard__scrim"
        aria-hidden="true"
        onClick={busy ? undefined : onCancel}
      />
      <div
        className="draft-guard__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
        ref={panelRef}
        onKeyDown={onKeyDown}
      >
        <h2 className="draft-guard__title" id={titleId}>
          Ungespeicherte Änderungen
        </h2>

        <p className="draft-guard__body" id={bodyId}>
          An diesem Formular gibt es Änderungen, die noch nicht gespeichert
          sind. Wer die Seite ohne Speichern verlässt, verliert sie.
        </p>

        {canSave ? null : (
          <p className="draft-guard__note">
            Speichern ist der Rolle „Bearbeiten" vorbehalten – hier lassen sich
            die Änderungen nur verwerfen.
          </p>
        )}

        {error === null ? null : (
          <p className="draft-guard__error" role="alert">
            {error}
          </p>
        )}

        <div className="draft-guard__actions">
          {/*
            „Abbrechen" first, as in the publish notice: it is the
            answer that does nothing, and thus the one the focus can stand on
            harmlessly when the dialog opens.
          */}
          <button
            type="button"
            className="draft-guard__cancel"
            disabled={busy}
            onClick={onCancel}
          >
            Abbrechen
          </button>
          <button
            type="button"
            className="draft-guard__discard"
            disabled={busy}
            onClick={onDiscard}
          >
            Verwerfen
          </button>
          {canSave ? (
            <button
              type="button"
              className="draft-guard__save"
              disabled={busy}
              onClick={onSave}
            >
              {busy ? 'Wird gespeichert…' : 'Speichern'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
