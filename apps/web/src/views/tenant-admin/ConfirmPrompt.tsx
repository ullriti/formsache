import type { ReactElement } from 'react';

import './confirm-prompt.css';

/**
 * Whether the act can be taken back.
 *
 * Not a styling knob with two nice values: it is the statement the box makes
 * before anybody reads it. `'destructive'` is the red alarm — nothing comes
 * back. `'reversible'` is a plain notice for something that lands in the
 * trash and stays there for 30 days.
 */
export type ConfirmTone = 'reversible' | 'destructive';

export interface ConfirmPromptProps {
  /** What is about to happen, in one sentence — including what is lost. */
  readonly question: string;
  /** Caption of the confirming button; names the action, never „OK". */
  readonly confirmLabel: string;
  /**
   * Required on purpose — there is no sensible default here. A default would
   * be silently right for one half of the callers and silently wrong for the
   * other, which is exactly the state this prop was introduced to end.
   */
  readonly tone: ConfirmTone;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly isPending?: boolean;
}

/**
 * An inline confirmation before an action takes effect — in one of two tones.
 *
 * **The tone is the message, not the decoration.** Both callers this component
 * started with were irreversible (deleting a group takes its permissions with
 * it, leaving an organisation takes the membership that lets somebody back in), and the
 * red box said so. The requirement then added two that are not: „× Löschen" on
 * the Dashboard and „Löschen" in the answer detail move one thing into the
 * trash, where it stays restorable for 30 days. Rendering those in the
 * same red, with the same filled red button and the same bold weight, left the
 * difference living entirely in the sentence — and a person who has read the
 * red box twice this week does not read the third one. {@link ConfirmTone}
 * therefore reaches the CSS, and `confirm-prompt.css` makes the reversible
 * tone a plain notice.
 *
 * The handoff asks for one at the trash („🗑 Papierkorb leeren (mit
 * Bestätigung)"), which is where the requirement now uses it too — for
 * „Papierkorb leeren" itself and for a row's own „Endgültig löschen". All of
 * these used to fire on the first click.
 *
 * Inline rather than a modal `window.confirm`: a native dialog cannot be styled,
 * cannot be read by the tests as part of the page, and is suppressed in some
 * browsers — and a modal of our own would be the application's first, for two
 * buttons. `role="alertdialog"` is deliberately **not** claimed: nothing here
 * traps focus or takes over the page, and a role that promises modal behaviour
 * to a screen reader without delivering it is the same defect as a `role="tab"`
 * without a tab widget behind it. The text is announced (`role="alert"`), which
 * is what it actually is.
 */
export function ConfirmPrompt({
  question,
  confirmLabel,
  tone,
  onConfirm,
  onCancel,
  isPending = false,
}: ConfirmPromptProps): ReactElement {
  return (
    <div
      className={
        tone === 'reversible'
          ? 'tenant-admin__confirm tenant-admin__confirm--reversible'
          : 'tenant-admin__confirm'
      }
      role="alert"
    >
      <p className="tenant-admin__confirm-text">{question}</p>
      <div className="tenant-admin__confirm-actions">
        <button
          type="button"
          className="tenant-admin__confirm-yes"
          disabled={isPending}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
        <button
          type="button"
          className="tenant-admin__confirm-no"
          onClick={onCancel}
        >
          Abbrechen
        </button>
      </div>
    </div>
  );
}
