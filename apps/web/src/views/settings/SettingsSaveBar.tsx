import type { ReactElement, ReactNode } from 'react';

/**
 * The save row of the three settings surfaces (handoff): the state on
 * the left, „Speichern" on the right.
 *
 * Written once because it was written three times. Two rules live in these
 * fifteen lines, and both were found by review rather than by reading:
 *
 * 1. **`isSaving` is asked *before* `dirty`.** The draft stays dirty until the
 *    server answers, so a „dirty ? … : isSaving ? …" chain can never reach „Wird
 *    gespeichert…" at all — the row would sit on „Nicht gespeichert" through the
 *    whole request and look like nothing had happened.
 * 2. **The button is locked while saving *and* while there is nothing to save.**
 *    The first half is what keeps two overlapping writes out of reach, which is
 *    why the race of the requirement only ever has one answer to defend against.
 *
 * A third copy of that pair is a third chance to get the order wrong, and the
 * one that does is invisible in a screenshot.
 */
export interface SettingsSaveBarProps {
  readonly isSaving: boolean;
  /** Whether saving would change anything the server has. */
  readonly dirty: boolean;
  /**
   * What stands on the left instead of „Nicht gespeichert" as long as `dirty`
   * holds.
   *
   * Exactly one reason to need it, and it is not a cosmetic one: a
   * surface whose server has stored **nothing at all** yet and shows the
   * shipped state (`decided: false` of the templates). There
   * „Nicht gespeichert" is true, to be sure, but says the wrong thing — it
   * sounds like a change one would lose, and not like "nobody has decided
   * here yet". Absent where there is nothing to explain.
   */
  readonly dirtyLabel?: string | undefined;
  readonly onSave: () => void;
  /**
   * Extra actions left of the state — today only „Zum Builder" on the settings
   * of one form. Absent elsewhere rather than disabled.
   */
  readonly children?: ReactNode;
}

export function SettingsSaveBar({
  isSaving,
  dirty,
  dirtyLabel,
  onSave,
  children,
}: SettingsSaveBarProps): ReactElement {
  return (
    <div className="settings__actions">
      {children}
      <span className="settings__save-state" role="status">
        {isSaving
          ? 'Wird gespeichert…'
          : dirty
            ? (dirtyLabel ?? 'Nicht gespeichert')
            : 'Gespeichert'}
      </span>
      <button
        type="button"
        className="settings__save"
        disabled={isSaving || !dirty}
        onClick={onSave}
      >
        Speichern
      </button>
    </div>
  );
}
