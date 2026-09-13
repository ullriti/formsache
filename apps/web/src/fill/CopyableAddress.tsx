import type { ReactElement } from 'react';
import { useState } from 'react';

/**
 * A server-built address that a participant has to be able to read, select
 * **and** copy in one press — the shape `EditLink` first built for the
 * confirmation page's „Antwort später ändern"-address and
 * that *Zwischenspeichern*'s saved-draft address reuses
 * rather than reinventing.
 *
 * ## Why copyable and not just a link
 *
 * In both cases the participant has no account: the address on
 * screen is the *only* way back to their own answer or their own half-filled
 * form, and it has to survive being written down, texted to a second device,
 * or copied into a second browser context.
 *
 * ## Why one component and not two
 *
 * The two screens differ only in what the address does and in the sentence
 * that explains it — the copying, the failure handling and the markup are one
 * mechanism, and a second implementation of the same interaction is exactly
 * the drift `CONTRIBUTING.md` warns a second-time-seen component into avoiding.
 */

/** @see writeToClipboard — `'failed'` exists because `navigator.clipboard` may not. */
type CopyState = 'idle' | 'copied' | 'failed';

/**
 * Writes to the clipboard, tolerating every way that can fail — an insecure
 * context (plain http) or an older browser leaves `navigator.clipboard`
 * `undefined` at runtime although the DOM types call it non-optional, and
 * reading `.writeText` off it throws synchronously into the same `catch`.
 */
async function writeToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export interface CopyableAddressProps {
  readonly url: string;
  /** What this address is and what is lost if it is not kept. */
  readonly hint: string;
  /** Distinguishes the confirmation's edit address from a saved draft's. */
  readonly testId: string;
  /**
   * The overline naming what is kept here — the panel's own caption, four or
   * five words. Defaulted rather than required: every caller keeps an address
   * for later, and a caller that says nothing gets the truthful generic line
   * instead of a nameless box.
   */
  readonly label?: string;
  /** Extra content rendered inside the panel, below the copy feedback. */
  readonly children?: ReactElement | null;
}

export function CopyableAddress({
  url,
  hint,
  testId,
  label = 'Adresse zum Aufbewahren',
  children = null,
}: CopyableAddressProps): ReactElement {
  const [copyState, setCopyState] = useState<CopyState>('idle');

  return (
    <div className="public__edit-link" data-testid={testId}>
      {/*
        The panel says what it is before it says anything else. The mark is
        decoration and is hidden from a reader — the caption next to it carries
        the whole meaning, so nothing is lost when the glyph is not rendered.
      */}
      <p className="public__edit-label">
        <span className="public__edit-mark" aria-hidden="true">
          🔖
        </span>
        {label}
      </p>
      <p className="public__edit-hint">{hint}</p>
      {/*
        Address and copy button in one row, so the button is visibly *this*
        address's button and not a control belonging to the page.
      */}
      <div className="public__edit-address">
        {/*
          A real anchor, so „Link in neuem Tab öffnen" and „Linkadresse
          kopieren" work from the browser's own menu. The visible text is the
          full address, so what is read and what is copied are the same string.
        */}
        <a className="public__edit-url" href={url}>
          {url}
        </a>
        <button
          type="button"
          className="public__edit-copy"
          onClick={() => {
            writeToClipboard(url)
              .then((success) => {
                setCopyState(success ? 'copied' : 'failed');
              })
              .catch(() => {
                // Unreachable — `writeToClipboard` never rejects — and here so
                // a future change to it cannot leave the press without an
                // outcome.
                setCopyState('failed');
              });
          }}
        >
          {copyState === 'copied' ? 'Kopiert' : 'Kopieren'}
        </button>
      </div>
      {/*
        `role="status"` and *always rendered*: a live region that is added to
        the page at the moment it gets its text is announced unreliably, and
        the reserved line also keeps the panel from jumping under the pointer
        that just pressed the button.
      */}
      <span
        className={
          copyState === 'failed'
            ? 'public__edit-feedback public__edit-feedback--error'
            : 'public__edit-feedback'
        }
        role="status"
      >
        {copyState === 'copied'
          ? 'Adresse in die Zwischenablage kopiert.'
          : copyState === 'failed'
            ? 'Kopieren war nicht möglich – bitte die Adresse markieren und manuell kopieren.'
            : null}
      </span>
      {children}
    </div>
  );
}
