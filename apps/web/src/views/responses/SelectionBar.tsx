import { TRASH_RETENTION_DAYS } from '@formsache/shared';
import type { ReactElement } from 'react';

import { ConfirmPrompt } from '../tenant-admin/ConfirmPrompt';

/**
 * **The action bar of the Mehrfachauswahl** (Handoff).
 *
 * The handoff draws it as a dark bar that appears above the table as soon as
 * anything is ticked: „n Antworten ausgewählt" · *Auswahl aufheben* ·
 * *Löschen*. It is rendered only while something is selected — an empty bar
 * would be a permanent strip of dead controls, and „erscheint bei Auswahl" is
 * what the prototype does.
 *
 * ## The count is the *rendered* one
 *
 * `count` is handed in already reduced to the rows on screen — see
 * `ResponsesView`, which intersects the tick marks with the **filtered** rows
 * before anything reaches here. This component deliberately owns no selection
 * state at all: a bar that counted its own set could disagree with the table it
 * sits above, and the direction it would disagree in is the expensive one
 * („alle" meaning rows nobody has seen).
 *
 * ## „Löschen" asks first, and says where it leads
 *
 * The same `ConfirmPrompt` in the same `reversible` tone the detail panel's
 * single delete uses, with the same confirming label: it is the same
 * act on more rows, and two spellings of „in den Papierkorb legen" would be two
 * promises. The sentence names the number, because that is the one thing a
 * reader cannot check once the bar has covered the tick marks.
 *
 * ## Mobil ohne eigenen Umbau
 *
 * The bar is a wrapping flex row: the count keeps its line, the two buttons
 * drop under it at 360 px rather than being cut off, and neither is hidden
 * behind a menu. Nothing here measures a viewport, so the Feinschliff has a
 * layout to tune and not a component to rebuild.
 */
export function SelectionBar({
  count,
  isConfirming,
  isPending,
  error,
  onClear,
  onDeleteRequested,
  onConfirmDelete,
  onCancelDelete,
}: {
  /** How many of the **rendered** rows are selected — never fewer, never more. */
  readonly count: number;
  readonly isConfirming: boolean;
  readonly isPending: boolean;
  /** The server's own sentence about a refused delete, if there was one. */
  readonly error: string | undefined;
  readonly onClear: () => void;
  readonly onDeleteRequested: () => void;
  readonly onConfirmDelete: () => void;
  readonly onCancelDelete: () => void;
}): ReactElement {
  const answers = count === 1 ? '1 Antwort' : `${String(count)} Antworten`;

  return (
    /*
      A labelled group, not a bare `div`: the bar appears in the middle of the
      page once something is ticked, and its controls act on the ticked rows
      rather than on the table below it. Without the label a screen reader
      announces „Auswahl aufheben" and „Löschen" as two buttons belonging to
      nothing in particular.
    */
    <div
      className="responses__selection"
      role="group"
      aria-label="Ausgewählte Antworten"
    >
      <div className="responses__selection-bar">
        {/*
          `role="status"`, so the number is announced as it changes rather than
          only being visible — the bar appears and disappears under the reader's
          hands, and its whole content is one fact.
        */}
        <span className="responses__selection-count" role="status">
          {answers} ausgewählt
        </span>

        <button
          type="button"
          className="responses__selection-button"
          onClick={onClear}
        >
          Auswahl aufheben
        </button>

        {/*
          `aria-label` rather than the bare visible word: „Löschen" on its own
          says nothing about *what*, and the panel behind this bar carries a
          button of the same name for a single answer. The visible caption
          stays the handoff's.
        */}
        <button
          type="button"
          className="responses__selection-button responses__selection-button--danger"
          aria-label="Ausgewählte Antworten löschen"
          onClick={onDeleteRequested}
          disabled={isPending}
        >
          Löschen
        </button>
      </div>

      {isConfirming ? (
        <ConfirmPrompt
          question={
            count === 1
              ? `1 Antwort wird in den Papierkorb verschoben und bleibt dort ${String(TRASH_RETENTION_DAYS)} Tage wiederherstellbar.`
              : `${String(count)} Antworten werden in den Papierkorb verschoben und bleiben dort ${String(TRASH_RETENTION_DAYS)} Tage wiederherstellbar.`
          }
          confirmLabel="In den Papierkorb legen"
          // Reversible, like the single answer's — this is the trash, not
          // the physical deletion `TrashView.tsx` offers afterwards.
          tone="reversible"
          isPending={isPending}
          onConfirm={onConfirmDelete}
          onCancel={onCancelDelete}
        />
      ) : null}

      {error === undefined ? null : (
        <p className="responses__selection-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
