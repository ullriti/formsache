import type { ReactElement } from 'react';

/**
 * Live preview of the confirmation page (handoff).
 *
 * It follows the fields above it keystroke by keystroke, which is the whole
 * point: the confirmation text is the last thing a Mitglied reads after
 * filling in an Anmeldung, and nobody publishes a form twice just to see it.
 *
 * **The texts are rendered as text.** They are admin-authored free text that
 * ends up on a page strangers open, and `dangerouslySetInnerHTML` here would
 * turn a settings field into stored XSS on the public confirmation page — the
 * exact shape of the risk for the redirect URL.
 */
export function ConfirmationPreview({
  title,
  message,
  redirectDelay,
}: {
  readonly title: string;
  readonly message: string;
  /** Seconds until the redirect, or `null` when none is configured. */
  readonly redirectDelay: number | null;
}): ReactElement {
  return (
    <div className="confirm-preview">
      <p className="confirm-preview__eyebrow">Vorschau Bestätigungsseite</p>
      <p className="confirm-preview__mark" aria-hidden="true">
        ✓
      </p>
      <p className="confirm-preview__title">
        {title === '' ? 'Vielen Dank!' : title}
      </p>
      <p className="confirm-preview__message">{message}</p>
      {redirectDelay === null ? null : (
        <p className="confirm-preview__redirect">
          Weiterleitung in {String(redirectDelay)} Sekunden …
        </p>
      )}
    </div>
  );
}
