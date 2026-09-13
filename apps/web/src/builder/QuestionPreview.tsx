import type { ReactElement } from 'react';
import {
  ATTACHMENT_HINT,
  otherLabelOf,
  type Question,
  type QuestionType,
  tableCanGrow,
  tableRowLimit,
} from '@formsache/shared';

/**
 * The live preview inside a question card.
 *
 * Rendered from the same `Question` the fill-in view will render from, so what
 * an editor sees while building is the field a participant gets — that is the
 * whole point of a preview, and it only holds while both sides read one schema.
 *
 * Every control here is **inert**: `disabled` on the real elements, and the
 * card as a whole is a click target for selecting the question. A preview that
 * accepted input would collect answers nobody stores and would steal the click
 * that is supposed to select the card.
 */
export function QuestionPreview({
  question,
}: {
  readonly question: Question;
}): ReactElement | null {
  switch (question.type) {
    case 'textarea':
      return (
        <textarea className="q-preview__input" rows={3} disabled aria-hidden />
      );

    case 'select':
      return (
        <select className="q-preview__input" disabled aria-hidden>
          {question.options.map((option) => (
            <option key={option.value}>{option.label}</option>
          ))}
          {question.allowOther ? (
            <option>{otherLabelOf(question)}</option>
          ) : null}
        </select>
      );

    case 'radio':
    case 'checkbox': {
      const control = question.type === 'radio' ? 'radio' : 'checkbox';
      return (
        <div className="q-preview__choices" aria-hidden>
          {question.options.map((option) => (
            <span className="q-preview__choice" key={option.value}>
              <input type={control} disabled />
              <span>{option.label}</span>
            </span>
          ))}
          {question.allowOther ? (
            <span className="q-preview__choice">
              <input type={control} disabled />
              <span>{otherLabelOf(question)}</span>
            </span>
          ) : null}
        </div>
      );
    }

    case 'rating':
      // Always unfilled: the preview is inert (no `live` state to read a
      // value from), and the handoff's own preview agrees — its `cur` is `0`
      // whenever `live` is false (`renderPreview`'s rating branch).
      return (
        <div className="q-preview__rating" aria-hidden>
          {Array.from({ length: question.max }, (_, index) => (
            <span key={index} className="q-preview__star">
              ☆
            </span>
          ))}
        </div>
      );

    // The single-line controls. Listed one by one instead of caught by a
    // `default`, because „looks like a text box" is the wrong guess for most of
    // what the newer types add (Matrix, Datei-Upload, Infotext) and the wrong guess is the
    // one nobody sees: the preview would simply show a text field and the
    // editor would believe it. Narrowed by the case labels, the
    // discriminant is exactly what `inputType` accepts.
    case 'text':
    case 'number':
    case 'date':
    case 'email':
    case 'phone':
      return (
        <input
          className="q-preview__input"
          type={inputType(question.type)}
          disabled
          aria-hidden
        />
      );

    // No preview control at all — an `info` is not a field,
    // it is the callout itself, and the callout is what `QuestionCard`
    // already renders from `label`/`hint` above this preview. A second box
    // here would repeat the same text a second time.
    case 'info':
      return null;

    // The handoff's own address preview (`renderPreview`'s address branch):
    // four inert inputs in a two-column grid, Straße and Land spanning both
    // columns. Inert like every other branch here — no `value`, no `onChange`
    // — because this is the builder's preview, not the fill-in view; wiring
    // the answer is `FieldInput.tsx`'s job.
    case 'address':
      return (
        <div className="q-preview__address" aria-hidden>
          <input
            className="q-preview__input q-preview__address-wide"
            placeholder="Straße & Hausnummer"
            disabled
          />
          <input className="q-preview__input" placeholder="PLZ" disabled />
          <input className="q-preview__input" placeholder="Ort" disabled />
          <input
            className="q-preview__input q-preview__address-wide"
            placeholder="Land"
            disabled
          />
        </div>
      );

    // The handoff's own matrix preview (`renderPreview`'s matrix branch): an
    // empty corner cell, the scale as column headers, one statement per row
    // and an inert control per cell — round for one choice per row, square
    // when „Mehrfachauswahl je Zeile" is on, exactly as the prototype draws it
    // (`borderRadius: q.multi ? '4px' : '50%'`). `aria-hidden`, like every
    // other branch: the card's own heading already names the question, and a
    // preview table announced cell by cell would bury it.
    case 'matrix':
      return (
        <div className="q-preview__scroll" aria-hidden>
          <table className="q-preview__grid">
            <thead>
              <tr>
                <th />
                {question.columns.map((column) => (
                  <th key={column.value}>{column.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {question.rows.map((row) => (
                <tr key={row.value}>
                  <th scope="row">{row.label}</th>
                  {question.columns.map((column) => (
                    <td key={column.value}>
                      <span
                        className={
                          question.multiple
                            ? 'q-preview__cell-box'
                            : 'q-preview__cell-box q-preview__cell-box--round'
                        }
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    // The handoff's own table preview (`renderPreview`'s table branch): the
    // column captions as headers and `rows` rows of inert cells, each drawn as
    // what its Zelltyp collects. The row count is shown rather than described,
    // because „2 Zeilen" in a caption is exactly the kind of statement an
    // editor has to take on trust.
    //
    // **„+ Zeile" is shown for the same reason** : „Zeilen
    // ergänzbar" is a switch whose whole effect is a button in somebody else's
    // browser, and the preview is where an editor finds out that the tick did
    // something.
    //
    // The condition is `tableCanGrow`, not „`addRows` is set", and it is the
    // **same call** the fill-in view makes (`TableField`). The two differ in
    // one reachable state — Startzeilen already at the Obergrenze, where it
    // cannot go any higher — and there the simpler condition would promise a
    // control no participant is ever offered. Written once in `@formsache/shared`
    // because it was written twice before and the two spellings had already
    // drifted apart.
    //
    // The ceiling beside it comes from `tableRowLimit` and never from `rows`,
    // which are the same number only while the switch is off.
    case 'table':
      return (
        <>
          <div className="q-preview__scroll" aria-hidden>
            <table className="q-preview__grid">
              <thead>
                <tr>
                  {question.columns.map((column) => (
                    <th key={column.key}>{column.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: question.rows }, (_, rowIndex) => (
                  <tr key={rowIndex}>
                    {question.columns.map((column) => (
                      <td key={column.key}>
                        {column.type === 'checkbox' ? (
                          <input type="checkbox" disabled />
                        ) : column.type === 'select' ? (
                          <select className="q-preview__input" disabled>
                            {column.options.map((option) => (
                              <option key={option.value}>{option.label}</option>
                            ))}
                          </select>
                        ) : (
                          <input
                            className="q-preview__input"
                            type={column.type === 'number' ? 'number' : 'text'}
                            disabled
                          />
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {tableCanGrow(question) ? (
            <div className="q-preview__add-row" aria-hidden>
              <button
                type="button"
                className="q-preview__add-row-button"
                disabled
              >
                + Zeile
              </button>
              <span className="q-preview__add-row-note">
                {`bis ${String(tableRowLimit(question))} Zeilen`}
              </span>
            </div>
          ) : null}
        </>
      );

    // The handoff's own file preview (`renderPreview`'s file branch): a dashed
    // drop area with the arrow, the type name and the caption underneath.
    //
    // The caption is `ATTACHMENT_HINT` from `@formsache/shared` rather than the
    // handoff's editable `q.accept`/`q.maxMb`, and that is the difference this
    // preview has to show: an editor sees the rule the **server** will apply,
    // not one they typed. „Mehrere Dateien" is added from `maxFiles`, which is
    // the one thing they *can* decide.
    case 'file':
      return (
        <div className="q-preview__dropzone" aria-hidden>
          <span className="q-preview__dropzone-glyph">↥</span>
          <span className="q-preview__dropzone-label">
            {question.maxFiles === 1
              ? 'Datei auswählen'
              : `Bis zu ${String(question.maxFiles)} Dateien auswählen`}
          </span>
          <span className="q-preview__dropzone-hint">{ATTACHMENT_HINT}</span>
        </div>
      );

    /*
     * The events — name, Termin, Obergrenze and a
     * **disabled number box**, because the answer is a Personenzahl and not a
     * tick. The prototype's own preview shows a checkbox and a
     * „84/120"-Badge; that counter is a field an editor types there, and here it
     * is the sum of `event_registration` and exists only once somebody has
     * registered.
     *
     * The Obergrenze is what an editor needs to see: it is the setting they just
     * typed, and „ohne Grenze" has to read as a state rather than as an empty
     * spot.
     *
     * **The badge says `max. n`, never „n frei"** . The
     * remaining-seat figure exists only against a live count of
     * `event_registration`, and this preview renders a *draft* — a form nobody
     * has registered for yet, or one whose published version is somewhere else
     * entirely. A „frei"-Zahl here would be a guess in the one place an editor
     * comes to check what they configured. The switch itself is shown as a
     * caption instead: „Restplätze sichtbar" says which of the two badges a
     * participant will get.
     */
    case 'event':
      return (
        <div className="q-preview__events">
          {question.events.map((entry) => (
            <div className="q-preview__event" key={entry.key}>
              <span className="q-preview__event-name">
                {entry.label}
                {entry.when === null || entry.when === '' ? null : (
                  <span className="q-preview__event-when">{entry.when}</span>
                )}
              </span>
              <span className="q-preview__event-limit">
                {entry.capacity === null
                  ? 'ohne Grenze'
                  : `max. ${String(entry.capacity)}`}
                {entry.showRemaining ? (
                  <span className="q-preview__event-note">
                    Restplätze sichtbar
                  </span>
                ) : null}
              </span>
              {/*
                `aria-hidden` as on every other dummy of this file
                (a review finding, 2026-08-12). This box is the only
                one that had forgotten it — axe reported `label:
                Form elements must have labels` as *critical* as soon as the
                test form got an event question.

                **Only at the field, not at the block above it**, unlike at the
                file upload next door: name, Termin and Obergrenze are text
                that a screen reader is meant to read — they are the setting the
                editor has just typed. What is to be taken away is only the
                control that is none.
              */}
              <input
                className="q-preview__input q-preview__event-count"
                type="number"
                disabled
                aria-hidden
              />
            </div>
          ))}
        </div>
      );
  }

  // Unreachable while the switch is exhaustive; a new question type narrows to
  // itself instead of `never` here and the assignment names it.
  const unhandled: never = question;
  return unhandled;
}

/**
 * The types the preview shows as a single-line `<input>`.
 *
 * Derived from `QuestionType` instead of written out freely: the fill-in view
 * keeps the same list (minus `number`, which has its own branch there), and two
 * hand-written literal unions drift — from each other and from the schema —
 * without anything going red. `Extract` drops a renamed or removed type out of
 * the union, and the `case` labels below stop overlapping it (TS2678).
 */
export type SingleLinePreviewType = Extract<
  QuestionType,
  'text' | 'number' | 'date' | 'email' | 'phone'
>;

/**
 * The `type` attribute a single-line preview uses.
 *
 * `email`, `tel`, `number` and `date` are not decoration: they decide the
 * keyboard a phone shows and the picker a browser offers, and the fill-in view
 * will use exactly the same mapping. Keeping it here, next to the
 * preview, means the two cannot disagree about what a "Telefon" field looks
 * like.
 *
 * It takes the **narrowed** discriminant rather than a whole `Question`, so
 * that the decision „is this a single-line field at all?" stays in the switch
 * above and is made exactly once. That is why this switch needs no `default`
 * either: a type added does not silently arrive here, it never reaches
 * this function until somebody routes it here.
 */
function inputType(type: SingleLinePreviewType): string {
  switch (type) {
    case 'number':
      return 'number';
    case 'date':
      return 'date';
    case 'email':
      return 'email';
    case 'phone':
      return 'tel';
    case 'text':
      return 'text';
  }
}
