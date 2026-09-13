import type { ReactElement } from 'react';
import {
  SYSTEM_PLACEHOLDERS,
  questionPlaceholderToken,
  systemPlaceholderToken,
  type Question,
  type SystemPlaceholder,
} from '@formsache/shared';

/**
 * The placeholder chips — **the caption is shown, the id is
 * stored** .
 *
 * That split is the whole component's reason to exist, and it still runs
 * through `onInsert`: what a chip hands over here is always `{{frage:<id>}}`
 * (`questionPlaceholderToken`) — a chip reads „Vorname" because that is what
 * the editor's form asks, but it never has to know what an id looks like.
 * `NotificationEditor.onInsert` is what a caller of `onInsert` actually is:
 * it converts that id token to `{{frage:Vorname}}` (`toDisplayForm`,
 * `@formsache/shared`) before it ever reaches the field, so what an administrator
 * *sees* while writing the template is the caption too — see that module's
 * comment, point 3, for why the conversion happens there and not here.
 * Renaming the question later still leaves every notification intact and only
 * *removing* it can break anything, because the id underneath never changed —
 * which is the case the requirement locks at publish time.
 *
 * German labels for the six system placeholders, because `{{formularorganisation}}`
 * is what the token looks like and „Organisation (Name der Organisation)" is what it means.
 * Both are on the chip: the token is what an editor types by hand the second
 * time.
 */

const SYSTEM_LABELS: Readonly<Record<SystemPlaceholder, string>> = {
  formularorganisation: 'Organisation',
  formular: 'Formularname',
  datum: 'Datum',
  antworten: 'Alle Antworten',
  /*
    Only the answers that changed, with their old value beside the new one. It
    stays empty in a mail that is not a correction — the preview says so, for
    the same reason it says it about the link below.
  */
  aenderungen: 'Änderungen',
  /*
    The requirement: the link belongs in the confirmation mail as well as on the
    confirmation page. It stays empty in a form without „Bearbeiten nach dem
    Absenden erlaubt" — the preview says so, because a chip that promises a link
    a form cannot issue is worse than no chip.
  */
  bearbeiten: 'Bearbeiten-Link',
};

export interface PlaceholderChipsProps {
  /** Every question of the draft — in document order, captions as written. */
  readonly questions: readonly Question[];
  /** Called with the token to insert at the cursor. */
  readonly onInsert: (token: string) => void;
  /**
   * Where the token would land right now, for the row's label — „Betreff" or
   * „Text". Without it the chips are a row of buttons with no stated effect.
   */
  readonly targetLabel: string;
}

export function PlaceholderChips({
  questions,
  onInsert,
  targetLabel,
}: PlaceholderChipsProps): ReactElement {
  return (
    <div className="notifications__chips">
      <p className="notifications__chips-hint">
        Platzhalter einfügen in <strong>{targetLabel}</strong> – an der
        Cursorposition.
      </p>

      <div
        className="notifications__chip-row"
        role="group"
        aria-label="Allgemeine Platzhalter"
      >
        {SYSTEM_PLACEHOLDERS.map((name) => (
          <button
            key={name}
            type="button"
            className="notifications__chip"
            data-testid={`placeholder-chip-${name}`}
            onClick={() => {
              onInsert(systemPlaceholderToken(name));
            }}
          >
            {SYSTEM_LABELS[name]}
            <span className="notifications__chip-token" aria-hidden="true">
              {systemPlaceholderToken(name)}
            </span>
          </button>
        ))}
      </div>

      {questions.length === 0 ? (
        <p className="notifications__chips-empty">
          Dieses Formular hat noch keine Fragen – Platzhalter auf Antworten
          stehen erst zur Verfügung, wenn es welche gibt.
        </p>
      ) : (
        <div
          className="notifications__chip-row"
          role="group"
          aria-label="Platzhalter aus Fragen"
        >
          {questions.map((question) => (
            <button
              key={question.id}
              type="button"
              className="notifications__chip notifications__chip--question"
              data-testid={`placeholder-chip-question-${question.id}`}
              /*
                The accessible name carries the caption *and* what it does;
                the visible chip shows the caption alone, because a row of
                chips reading „Platzhalter für …" twenty times is unreadable.
              */
              aria-label={`Platzhalter für die Frage „${question.label}" einfügen`}
              onClick={() => {
                onInsert(questionPlaceholderToken(question.id));
              }}
            >
              {question.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
