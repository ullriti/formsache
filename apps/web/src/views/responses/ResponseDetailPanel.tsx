import type { ReactElement, RefObject } from 'react';
import { useId, useState } from 'react';
import type { AnswerMap, Question } from '@formsache/shared';
import {
  RETIRED_COLUMN_NOTE,
  SUBMITTED_AT_COLUMN,
  allQuestions,
  eventChips,
  TRASH_RETENTION_DAYS,
} from '@formsache/shared';

import { useDeleteResponse } from '../../api/trash';
import { useFocusTrap } from '../../shell/use-focus-trap';
import {
  actionErrorMessage,
  TRASH_DELETE_RESPONSE_SUBJECT,
} from '../api-messages';
import { ConfirmPrompt } from '../tenant-admin/ConfirmPrompt';
import { AttachmentLinks } from './AttachmentLinks';
import type { Row } from './response-rows';

/**
 * The slide-in of the handoff: every field of one response, including the
 * ones the table does not show.
 *
 * It behaves as a modal dialog — focus moves in on open, Tab stays inside,
 * Escape and the scrim close it, and focus returns to the row control that
 * opened it. The table behind it is a long list of look-alike rows, and losing
 * the way back to the one you came from is exactly what a keyboard user cannot
 * afford there.
 *
 * ## It lists the questions **this** participant was asked
 *
 * The fields come from the row's own published version, not from today's form
 * . That is the only way an answer to a question
 * that has since been removed is readable at all — and it is why a question
 * that is no longer asked is marked here too: without the note it would look
 * like an ordinary field of a form that no longer has it.
 *
 * ## „Löschen"
 *
 * Moves this one answer into the trash — reversibly, for 30 days
 * (`DELETE /forms/:formId/responses/:responseId`). `ConfirmPrompt` asks
 * first, in words that say so explicitly: this is not the *endgültig* pair
 * `TrashView.tsx` offers once an answer is already there.
 *
 * **Its success closes the panel through `onClose`, and closing is where the
 * focus problem lives.** The row that opened this panel is gone the moment
 * the table refetches — `useFocusTrap`'s own opener-restore step then finds
 * nothing to focus and, per its own contract, tries `fallbackRef` instead.
 * `ResponsesView` hands in its `<h1>` for exactly that: the one element in
 * this view that survives every possible deletion.
 */
export function ResponseDetailPanel({
  row,
  retiredKeys,
  formId,
  canDelete,
  fallbackRef,
  onClose,
}: {
  readonly row: Row;
  /** Column keys the server reports as no longer asked. */
  readonly retiredKeys: ReadonlySet<string>;
  /** The form this answer belongs to — half of the delete route's address. */
  readonly formId: string;
  /**
   * `canBuild` of the active membership on **this** form. `canViewResponses`
   * needs no prop of its own: reaching this panel already proves it, because
   * `ResponsesView` shows its own 403 rather than a table when it is missing.
   */
  readonly canDelete: boolean;
  /** Where focus goes when the opener cannot take it back — see above. */
  readonly fallbackRef: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
}): ReactElement {
  const { response, definition, cells, attachments } = row;
  const titleId = useId();
  const deleteResponse = useDeleteResponse();
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined);
  // The row button that opened this stays enabled while the panel is merely
  // open, so the element focused at mount is the opener — no `openerRef` to
  // thread through. `fallbackRef` covers the one case that button is gone by
  // the time this closes: a delete, from the button below.
  const { panelRef, onKeyDown } = useFocusTrap({
    onClose,
    fallbackRef,
  });

  const onConfirmDelete = (): void => {
    deleteResponse.mutate(
      { formId, responseId: response.id },
      {
        onSuccess: onClose,
        onError: (error) => {
          // Closes the confirmation rather than leaving it open next to the
          // error — the same fix `TrashView.tsx` and `DashboardView.tsx`
          // apply for the identical shape (both are `role="alert"`).
          setIsConfirmingDelete(false);
          setDeleteError(
            actionErrorMessage(error, TRASH_DELETE_RESPONSE_SUBJECT),
          );
        },
      },
    );
  };

  // Already rendered once, by `toRow`, against this row's own version — the
  // panel reads the same cells the table does rather than formatting them a
  // second time. `definition` is `undefined` only when the payload did not
  // carry the version this row names, which the server does not do; the panel
  // then says so instead of showing a list of no fields.
  const questions = definition === undefined ? [] : allQuestions(definition);

  return (
    <div className="responses__detail">
      {/* Redundant convenience: Escape and the close button do the same, so
          this stays out of the accessibility tree instead of becoming a
          second, unlabelled "close" control. */}
      <div
        className="responses__detail-scrim"
        aria-hidden="true"
        onClick={onClose}
      />
      <div
        className="responses__detail-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={panelRef}
        onKeyDown={onKeyDown}
      >
        <div className="responses__detail-head">
          <div>
            <h2 className="responses__detail-title" id={titleId}>
              Antwort
            </h2>
            <p className="responses__detail-meta">
              Eingereicht am {cells[SUBMITTED_AT_COLUMN]} · Fassung{' '}
              {response.formVersion}
            </p>
          </div>
          <div className="responses__detail-head-actions">
            {/*
              Hidden, not disabled, without `canDelete` — the same convention
              `TrashView.tsx` and `DashboardView.tsx` follow for a control
              nobody may press.
            */}
            {canDelete && !isConfirmingDelete ? (
              <button
                type="button"
                className="responses__detail-delete"
                data-testid="responses-detail-delete"
                onClick={() => {
                  setIsConfirmingDelete(true);
                }}
                disabled={deleteResponse.isPending}
              >
                <span aria-hidden="true">🗑 </span>
                Löschen
              </button>
            ) : null}
            <button
              type="button"
              className="responses__detail-close"
              onClick={onClose}
            >
              <span className="visually-hidden">Schließen</span>
              <span aria-hidden="true">✕</span>
            </button>
          </div>
        </div>

        {isConfirmingDelete ? (
          <div className="responses__detail-confirm">
            <ConfirmPrompt
              question={`Diese Antwort wird in den Papierkorb verschoben und bleibt dort ${String(TRASH_RETENTION_DAYS)} Tage wiederherstellbar.`}
              confirmLabel="In den Papierkorb legen"
              // Reversible, like the Dashboard's own „× Löschen".
              tone="reversible"
              isPending={deleteResponse.isPending}
              onConfirm={onConfirmDelete}
              onCancel={() => {
                setIsConfirmingDelete(false);
              }}
            />
          </div>
        ) : null}

        {deleteError === undefined ? null : (
          <p className="responses__detail-delete-error" role="alert">
            {deleteError}
          </p>
        )}

        {definition === undefined ? (
          <p className="responses__detail-note">
            Die Fassung dieser Antwort liegt nicht vor. Die Angaben können
            deshalb nicht beschriftet angezeigt werden.
          </p>
        ) : (
          <dl className="responses__detail-list">
            {questions.map((question) => {
              const files = attachments[question.id];
              return (
                <div className="responses__detail-row" key={question.id}>
                  <dt>
                    {question.label}
                    {/* Words, not only a colour: „leer" and „danach nicht mehr
                      gefragt" are different statements, and the same constant
                      says it here, in the column header and in the CSV. */}
                    {retiredKeys.has(question.id) ? (
                      <span className="responses__retired">
                        {RETIRED_COLUMN_NOTE}
                      </span>
                    ) : null}
                  </dt>
                  {/* An em dash for "not answered" — an empty `<dd>` reads as a
                    rendering fault rather than as an answer nobody gave.

                    A Datei-Upload shows its names as **links** , through the same component the table cell uses so
                    the two cannot point at different addresses. A
                    Veranstaltungsfeld shows **chips** . */}
                  <dd>
                    {files !== undefined ? (
                      <AttachmentLinks files={files} />
                    ) : question.type === 'event' ? (
                      <EventChips
                        question={question}
                        value={(response.answers as AnswerMap)[question.id]}
                      />
                    ) : cells[question.id] === undefined ||
                      cells[question.id] === '' ? (
                      '—'
                    ) : (
                      cells[question.id]
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        )}
      </div>
    </div>
  );
}

/**
 * **Ein Veranstaltungsfeld als Chips** (Handoff).
 *
 * One chip per Veranstaltung the participant registered for, carrying its name
 * and the Personenzahl — not the folded „Sommerfest: 3; Stadtfest: 2" that the
 * table cell and the export write. Which Veranstaltungen those are and in
 * which order comes from `eventChips` in `@formsache/shared`, the same list the
 * folded cell is written from: two walks over one answer would be two
 * decisions about „was zählt als angemeldet" (CONTRIBUTING.md rule 5).
 *
 * **A registration of nobody is no chip**, not an empty one — the list simply
 * does not contain it. A field with no registrations at all falls back to the
 * em dash every other unanswered field uses, rather than to an empty box that
 * reads as a rendering fault.
 *
 * A `<ul>` and not a row of `<span>`s: it is a list of separate facts, and a
 * screen reader saying „Liste mit 2 Einträgen" is the difference between
 * hearing two registrations and hearing one run-on sentence.
 */
function EventChips({
  question,
  value,
}: {
  readonly question: Question;
  readonly value: unknown;
}): ReactElement {
  const chips = eventChips(question, value);
  if (chips.length === 0) {
    return <>—</>;
  }

  return (
    <ul className="responses__chips">
      {chips.map((chip) => (
        <li className="responses__chip" key={chip.key}>
          {chip.label} · {String(chip.seats)}{' '}
          {chip.seats === 1 ? 'Person' : 'Personen'}
        </li>
      ))}
    </ul>
  );
}
