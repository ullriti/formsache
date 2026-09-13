import type { ReactElement, RefObject } from 'react';
import { useId, useState } from 'react';

import { useFocusTrap } from '../../shell/use-focus-trap';

/** What is being saved — decides the heading and the prefilled name. */
export type TemplateSaveKind = 'form' | 'page' | 'question';

const HEADINGS: Readonly<Record<TemplateSaveKind, string>> = {
  form: 'Formular als Vorlage speichern',
  page: 'Seite als Vorlage speichern',
  question: 'Frage als Vorlage speichern',
};

/**
 * The one step between „☆" and a stored template: **its name** .
 *
 * Prefilled from what is being saved — the form title, the page title, the
 * question's caption — because that is the name the person would type anyway,
 * and left editable because it is the only name this template will ever have:
 * there is no rename route, and a drawer of six entries called „Frage" is a
 * drawer nobody uses.
 *
 * Asked *before* the request rather than after, and never through
 * `window.prompt`: the prompt of the browser is unstyled, blocks the whole tab
 * and is not there at all in some embedded contexts — and it cannot say what
 * else is about to happen, which here is „der Entwurf wird zuerst gespeichert".
 */
export function TemplateSavePrompt({
  kind,
  defaultName,
  busy,
  error,
  openerRef,
  onCancel,
  onConfirm,
}: {
  readonly kind: TemplateSaveKind;
  readonly defaultName: string;
  readonly busy: boolean;
  /** What went wrong, if the last attempt did — shown in place, not swallowed. */
  readonly error: string | null;
  readonly openerRef: RefObject<HTMLElement | null>;
  readonly onCancel: () => void;
  readonly onConfirm: (name: string) => void;
}): ReactElement {
  const titleId = useId();
  const fieldId = useId();
  const [name, setName] = useState(defaultName);
  const { panelRef, onKeyDown } = useFocusTrap({
    onClose: onCancel,
    openerRef,
  });

  const trimmed = name.trim();

  return (
    <div className="publish-notice">
      <div
        className="publish-notice__scrim"
        aria-hidden="true"
        onClick={busy ? undefined : onCancel}
      />
      <div
        className="publish-notice__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={panelRef}
        onKeyDown={onKeyDown}
      >
        <h2 className="publish-notice__title" id={titleId}>
          {HEADINGS[kind]}
        </h2>
        <p className="publish-notice__note">
          Die Vorlage ist eine Kopie: Spätere Änderungen an diesem Formular
          lassen sie unberührt. Nicht gespeicherte Änderungen werden vorher
          gespeichert.
        </p>

        <div className="props__field">
          <label className="props__label" htmlFor={fieldId}>
            Name der Vorlage
          </label>
          <input
            id={fieldId}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </div>

        {error === null ? null : (
          <p className="publish-notice__problem" role="alert">
            {error}
          </p>
        )}

        <div className="publish-notice__actions">
          <button
            type="button"
            className="publish-notice__cancel"
            disabled={busy}
            onClick={onCancel}
          >
            Abbrechen
          </button>
          <button
            type="button"
            className="publish-notice__confirm"
            disabled={busy || trimmed === ''}
            onClick={() => {
              onConfirm(trimmed);
            }}
          >
            Als Vorlage speichern
          </button>
        </div>
      </div>
    </div>
  );
}
