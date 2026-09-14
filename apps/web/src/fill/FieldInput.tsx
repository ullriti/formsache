import type { ReactElement } from 'react';
import { useId, useState } from 'react';
import {
  ADDRESS_PARTS,
  DEFAULT_ADDRESS_COUNTRY,
  EVENT_SEATS_MAX,
  otherLabelOf,
  seatsOf,
  type AddressAnswer,
  type AnswerValue,
  type ChoiceQuestion,
  type PublicEventSeats,
  type Question,
  type QuestionType,
} from '@formsache/shared';

import type { UploadTarget } from '../api/public-form';
import { asAddress } from './address-answer';
import { withSeats } from './event-answer';
import { FileField } from './FileField';
import { asMatrix, pickedIn, toggleMatrixCell } from './matrix-answer';
import { TableField } from './TableField';
import {
  asChoice,
  otherFieldLabel,
  otherSentinelOf,
  singleValue,
  toChoice,
} from './choice-answer';

/**
 * One question as a real, fillable field.
 *
 * Deliberately a sibling of `builder/QuestionPreview.tsx` rather than a shared
 * component with a `disabled` flag. The two answer different questions — "what
 * will this look like" and "what did you answer" — and a single component
 * carrying both would grow a branch in every handler. What keeps them honest
 * is that both render from the same `Question`.
 *
 * The hint is a **description**, never part of the label: inside the label it
 * would become part of the field's accessible name, and a screen reader would
 * read the whole sentence back as the field's title. The builder learnt that
 * the hard way.
 */
export interface FieldInputProps {
  readonly question: Question;
  readonly value: AnswerValue | undefined;
  readonly error: string | undefined;
  readonly onChange: (value: AnswerValue) => void;
  /**
   * Where an attachment of this form is uploaded to, or `undefined`.
   *
   * The **one** prop this component takes that is not about the answer, and it
   * is here because the Datei-Upload field is the one type that talks to the
   * server while it is being filled in (ADR-0014 no. 4). It is threaded through
   * rather than read from a hook, for the reason `FillIn` states about its own
   * props: this component renders on two paths — the public fill-in and the
   * correction — and the two upload through different doors.
   */
  readonly uploadTarget?: UploadTarget;
  /**
   * Which attachments of this form no longer exist — handed through to
   * `FileField`, where the paragraph stands that explains why this set exists.
   *
   * Form-wide and not per question, unlike `eventSeats` next to it: the
   * references are unique across all file questions (16 bytes CSPRNG), and
   * a set split up per question would be a split without a difference.
   */
  readonly unavailableRefs?: ReadonlySet<string>;
  /**
   * The seat state of **this** question's Veranstaltungen, keyed by
   * `EventEntry.key`.
   *
   * Handed down already narrowed to the question rather than as the whole
   * payload list, for the reason `uploadTarget` is threaded through at all: this
   * component renders one question and should not have to search a form-wide
   * array for the part that concerns it.
   *
   * A key that is missing means „ohne Grenze" — the payload carries no entry for
   * an unbounded Veranstaltung (`publicEventSeatsSchema`). Absent altogether on
   * a form with no `event` question, which is why it is optional.
   */
  readonly eventSeats?: ReadonlyMap<string, PublicEventSeats>;
  /**
   * The Veranstaltung the server just refused as full, if it is in this
   * question (the evidence — `event_full` carries its position).
   *
   * The `EventEntry.key`, never a label: the wire sends the key for the reason
   * `submissionRefusalPositionSchema` states, and resolving it to a caption is
   * this side's job because this side is already rendering the definition.
   */
  readonly refusedEventKey?: string;
}

export function FieldInput({
  question,
  value,
  error,
  onChange,
  uploadTarget,
  unavailableRefs,
  eventSeats,
  refusedEventKey,
}: FieldInputProps): ReactElement {
  // Called unconditionally, **before** the early return below (a review
  // finding) — a hook behind a conditional return is a rules-of-hooks
  // violation regardless of whether today's branches keep the call count
  // stable: `question.type` is a prop, and nothing stops a future caller
  // from swapping it between renders of the same element, which is exactly
  // the case React's hook order depends on. The `info` branch below does not
  // use `id`, and that is fine — an unused hook result is cheap, an unstable
  // hook order is not.
  const id = useId();

  /*
   * An `info` is a callout, not a field — it has no label
   * element to point anything at, no control, and can never carry an error,
   * so it does not join the `.field` structure the rest of this component
   * builds below. Rendered on its own and returned early, rather than woven
   * through every branch beneath with an `isInfo` flag that each of them
   * would have to remember to check.
   */
  if (question.type === 'info') {
    return (
      <div className="field__info">
        {question.hint === null || question.hint === ''
          ? question.label
          : `${question.label} ${question.hint}`}
      </div>
    );
  }

  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  const described = [
    question.hint === null || question.hint === '' ? null : hintId,
    error === undefined ? null : errorId,
  ]
    .filter((entry) => entry !== null)
    .join(' ');

  const shared = {
    id,
    'aria-invalid': error !== undefined,
    ...(described === '' ? {} : { 'aria-describedby': described }),
  };

  /**
   * A choice question is a **group** of inputs, not one input.
   *
   * `<label htmlFor>` needs exactly one form control to point at, and a radio
   * group has none — so the label used to point at an id that did not exist,
   * and the question text was simply never announced. The group is therefore
   * labelled as a group: `role="group"` plus `aria-labelledby`, carrying the
   * same description and error references the single controls carry.
   */
  const isGroup = rendersAsGroup(question);
  const labelId = `${id}-label`;

  const control = (
    <Control
      question={question}
      value={value}
      onChange={onChange}
      shared={shared}
      uploadTarget={uploadTarget}
      unavailableRefs={unavailableRefs}
      eventSeats={eventSeats}
      refusedEventKey={refusedEventKey}
      controlId={id}
      describedBy={described === '' ? undefined : described}
      invalid={error !== undefined}
      /**
       * Shared `name` for the radios of one question. Without it every radio
       * is its own group: each becomes a tab stop and the arrow keys — the
       * way a radio group is *meant* to be operated — do nothing.
       */
      groupName={id}
    />
  );

  return (
    <div className={error === undefined ? 'field' : 'field field--invalid'}>
      {isGroup ? (
        <span className="field__label" id={labelId}>
          {question.label}
          {question.required ? (
            <span className="field__required" aria-hidden="true">
              {' '}
              *
            </span>
          ) : null}
        </span>
      ) : (
        <label className="field__label" htmlFor={id}>
          {question.label}
          {question.required ? (
            <span className="field__required" aria-hidden="true">
              {' '}
              *
            </span>
          ) : null}
        </label>
      )}

      {question.hint === null || question.hint === '' ? null : (
        <span className="field__hint" id={hintId}>
          {question.hint}
        </span>
      )}

      {/*
        The group wrapper is rendered **here**, once, and not inside the branch
        that happens to need it.

        It used to be handed to `Control` as an optional `groupProps` and spread
        by the radio/checkbox branch. That made `rendersAsGroup` decide the
        *classification* while every branch still had to remember the *wiring*:
        an `address` branch added that forgets `{...groupProps}` yields a
        question whose text is a `<span>` nobody points at — a group with no
        accessible name, which is the missing-accessible-name defect again and just as silent,
        because `groupProps` being `undefined` is a perfectly valid prop value
        and no compiler asks about it. Typing it as required per type would only
        have moved the reminder; rendering it here removes the thing that can be
        forgotten. The wrapper carries no class on purpose: it must not decide
        what a group *looks* like, that stays with the type's own container.
      */}
      {isGroup ? (
        <div
          role="group"
          aria-labelledby={labelId}
          aria-invalid={error !== undefined}
          {...(described === '' ? {} : { 'aria-describedby': described })}
        >
          {control}
        </div>
      ) : (
        control
      )}

      {error === undefined ? null : (
        <span className="field__error" id={errorId} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/**
 * Whether this question is a **group** of controls rather than one control —
 * and, with that, whether its text becomes a `<label htmlFor>` or an
 * `aria-labelledby` on a `role="group"`.
 *
 * A sixth silent place, found while closing five similar ones and closed the
 * same way. It read `type === 'radio' || type === 'checkbox'`, which is not a
 * fallback to a text field but has the same shape of failure: a new multi-part
 * type (Adresse with its four boxes, Matrix, Veranstaltung) would take the
 * `<label htmlFor={id}>` branch, and `htmlFor` would point at an id no element
 * carries — the question text is then simply never announced. That is exactly
 * the missing-accessible-name defect already paid for once; here the compiler asks instead.
 *
 * The `never` tail is what does the asking — not the missing `return` at the
 * end. Without it the function still failed to compile today (TS2366, "lacks
 * ending return statement"), but only for as long as the `: boolean` annotation
 * stands: drop it and the inferred type quietly becomes `boolean | undefined`,
 * `isGroup` stays usable and the hole is open again. Same tail as the other
 * five other places, for the same reason.
 */
function rendersAsGroup(question: Question): boolean {
  switch (question.type) {
    case 'radio':
    case 'checkbox':
      return true;
    // A star row is a **group of radios**, not one control — exactly the
    // shape `radio` already is above, decided the same way: `max` native
    // `<input type="radio">` elements share one `name` and only one of them
    // is ever checked. A single `<label htmlFor>` cannot point at `max`
    // elements, so this is a group and not the single-control half, even
    // though it looks like one dial rather than a list.
    case 'rating':
      return true;
    // Four inputs, one question — the same reasoning `radio` and
    // `checkbox` get above, for a different shape of "more than one control":
    // `<label htmlFor>` can point at exactly one of the four, so this is a
    // group too, named once by `question.label` rather than leaving three of
    // its four boxes unannounced.
    case 'address':
      return true;
    // A grid of controls — the most obviously plural of the lot. A
    // Matrix is a radio group *per row* and a Tabelle a field per cell, so
    // there is no single element for `<label htmlFor>` to point at, and the
    // group is named once by the question text. The row and column captions
    // then name each control inside it (`aria-label` per cell), which is the
    // only way „Programm: Gut" is announced as anything other than an
    // unlabelled radio.
    case 'matrix':
    case 'table':
      return true;
    // A number box per Veranstaltung — plural in the same way the
    // Adresse is, and named once by the question text. `<label htmlFor>` could
    // point at one of six boxes; the other five would be announced without the
    // question they belong to.
    case 'event':
      return true;
    // `select` sits with the single controls: a dropdown is one control even
    // with the „Sonstiges" box next to it, because the `<select>` carries the
    // id the label points at.
    case 'text':
    case 'textarea':
    case 'number':
    case 'date':
    case 'email':
    case 'phone':
    case 'select':
      return false;
    // A Datei-Upload is **one** control plus whatever is already attached
    // . The picker carries the id the question's `<label>` points at,
    // and the „Entfernen" buttons beside it are actions on an answer already
    // given, not further ways of giving one — the same way a Zurücksetzen next
    // to a rating is not what makes that type a group. So: single control.
    case 'file':
      return false;
    // Never reached: `FieldInput` returns its own callout for `info` before
    // calling this function at all. Present so the switch stays
    // exhaustive; the value is arbitrary because nothing reads it.
    case 'info':
      return false;
  }

  // Unreachable while the switch is exhaustive; a new question type narrows to
  // itself instead of `never` here and the assignment names it.
  const unhandled: never = question;
  return unhandled;
}

type SharedProps = Record<string, unknown>;

function Control({
  question,
  value,
  onChange,
  shared,
  groupName,
  uploadTarget,
  unavailableRefs,
  eventSeats,
  refusedEventKey,
  controlId,
  describedBy,
  invalid,
}: {
  readonly question: Question;
  readonly value: AnswerValue | undefined;
  readonly onChange: (value: AnswerValue) => void;
  readonly shared: SharedProps;
  readonly groupName: string;
  readonly uploadTarget: UploadTarget | undefined;
  readonly unavailableRefs: ReadonlySet<string> | undefined;
  readonly eventSeats: ReadonlyMap<string, PublicEventSeats> | undefined;
  readonly refusedEventKey: string | undefined;
  /** The `useId` of this field — the stem every generated id here is built on. */
  readonly controlId: string;
  /**
   * The two halves of `shared` the file field needs **by name**.
   *
   * It cannot spread `shared` like the other branches: the id belongs to the
   * `<input type="file">` buried inside its drop zone, not to the wrapper, so
   * the props have to be placed rather than forwarded in a bundle.
   */
  readonly describedBy: string | undefined;
  readonly invalid: boolean;
}): ReactElement {
  switch (question.type) {
    case 'textarea':
      return (
        <textarea
          {...shared}
          className="field__control"
          rows={4}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      );

    case 'number':
      return (
        <input
          {...shared}
          className="field__control"
          type="number"
          value={typeof value === 'number' ? value : ''}
          onChange={(event) => {
            // An empty box means "not answered", which the shared validator
            // spells `null` — `0` would be an answer nobody gave.
            onChange(
              event.target.value === '' ? null : event.target.valueAsNumber,
            );
          }}
        />
      );

    case 'select':
      /*
        A fragment, because the „Sonstiges" entry of a dropdown needs a second
        control: an `<option>` cannot hold text a participant types. Without it
        the entry was a promise the view did not keep — the Dachorganisation's own form
        offers „Nicht Mitglied der Dachorganisation – Name der Organisation" here, and the name of
        the organisation had nowhere to go.

        The two controls stack because `.field` is a column; the extra box
        therefore cannot widen the field, and a half-width question keeps its
        half of the row (`rowsOf`).
      */
      return (
        <>
          <select
            {...shared}
            className="field__control"
            value={singleValue(value, question)}
            onChange={(event) => {
              onChange(toChoice(event.target.value, question));
            }}
          >
            <option value="">Bitte wählen…</option>
            {question.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
            {question.allowOther ? (
              <option value={otherSentinelOf(question)}>
                {otherLabelOf(question)}
              </option>
            ) : null}
          </select>

          <OtherText question={question} value={value} onChange={onChange} />
        </>
      );

    case 'radio':
    case 'checkbox': {
      const answer = asChoice(value);
      const multiple = question.type === 'checkbox';

      return (
        <div className="field__choices">
          {question.options.map((option) => (
            <label className="field__choice" key={option.value}>
              <input
                type={multiple ? 'checkbox' : 'radio'}
                name={groupName}
                checked={answer.values.includes(option.value)}
                onChange={(event) => {
                  onChange(
                    multiple
                      ? {
                          values: event.target.checked
                            ? [...answer.values, option.value]
                            : answer.values.filter(
                                (entry) => entry !== option.value,
                              ),
                          other: answer.other,
                        }
                      : { values: [option.value], other: null },
                  );
                }}
              />
              <span>{option.label}</span>
            </label>
          ))}

          {question.allowOther ? (
            <label className="field__choice">
              <input
                type={multiple ? 'checkbox' : 'radio'}
                name={groupName}
                checked={answer.other !== null}
                onChange={(event) => {
                  onChange({
                    values: multiple ? answer.values : [],
                    other: event.target.checked ? '' : null,
                  });
                }}
              />
              <span>{otherLabelOf(question)}</span>
              <OtherText
                question={question}
                value={value}
                onChange={onChange}
              />
            </label>
          ) : null}
        </div>
      );
    }

    // A row of native radios rather than the prototype's plain `<span
    // onClick>` stars (Handoff, `renderPreview`'s rating branch): a `<span>`
    // takes no keyboard focus and has no accessible name of its own, so the
    // handoff's own control could only ever be set with a mouse — exactly the
    // gap this view has to close. Grouped the same way `radio` is
    // above (`groupName`), which is also why arrow keys move the selection
    // for free: that is what a browser already does for radios sharing one
    // `name`, and reimplementing it would only be a second, worse copy of it.
    case 'rating': {
      const current = typeof value === 'number' ? value : 0;

      return (
        <div className="field__rating">
          {Array.from({ length: question.max }, (_, index) => {
            const level = index + 1;
            const filled = level <= current;
            return (
              <label className="field__rating-star" key={level}>
                <input
                  type="radio"
                  name={groupName}
                  value={level}
                  checked={current === level}
                  aria-label={`${String(level)} von ${String(question.max)} Sternen`}
                  onChange={() => {
                    onChange(level);
                  }}
                />
                <span
                  aria-hidden="true"
                  className={
                    filled
                      ? 'field__rating-glyph field__rating-glyph--filled'
                      : 'field__rating-glyph'
                  }
                >
                  {filled ? '★' : '☆'}
                </span>
              </label>
            );
          })}
          {/*
            A review finding: a rating is a **radio group**, and a
            native radio cannot be unchecked by clicking it again — so once a
            star was picked, an *optional* question had no way back to "keine
            Angabe" at all, not even by mouse. The handoff's own control
            (`renderPreview`'s rating branch, a bare `<span onClick>`) has no
            answer to this either — clicking a filled star there only ever
            sets that star's level, the same one-way trap.

            A text control rather than "click the selected star again": the
            latter is the more common star-rating convention, but it is
            undiscoverable (nothing on screen says a filled star is also the
            un-rate control) and mouse-only in the same way the prototype's
            `<span>` was — exactly the gap already closed once for
            *setting* the rating. A labelled button reaches the same state
            by keyboard, is announced by a screen reader, and needs no
            invented gesture. Shown only once there is something to clear,
            so an untouched rating does not carry a control that does
            nothing yet.
          */}
          {current > 0 ? (
            <button
              type="button"
              className="field__rating-reset"
              onClick={() => {
                onChange(null);
              }}
            >
              Zurücksetzen
            </button>
          ) : null}
        </div>
      );
    }

    // The single-line controls, listed rather than caught by a `default`.
    // This is the fill-in view: a `default` here does not merely look wrong to
    // an editor, it decides what a participant can enter and what shape the
    // answer arrives in. A Matrix or a Datei-Upload rendered as a text box
    // would collect a string for a question whose validator expects something
    // else, and the first person to notice would be the one whose submission
    // is refused.
    case 'text':
    case 'date':
    case 'email':
    case 'phone':
      return (
        <input
          {...shared}
          className="field__control"
          type={inputType(question.type)}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      );

    // Four boxes in the grid the handoff's own address preview uses (Straße
    // full width, PLZ and Ort side by side, Land full width) — the requirement. `asAddress` is what carries the Land default „Deutschland" into
    // the first edit of *any* subfield: every `onChange` below merges onto
    // its result, not onto `value` directly, so the default is baked into
    // the stored answer exactly once something was actually filled in
    // (the field shows „Deutschland" before anything is typed, and
    // it is what gets submitted unless overwritten).
    case 'address': {
      const current = asAddress(value);
      const set = (part: keyof AddressAnswer, next: string): void => {
        const draft = { ...current, [part]: next };
        /*
          A review finding: an *optional* address nobody really
          answered must not read as answered just because the Land box
          carries its default. Measured on the actual write path: typing a
          character into Straße and deleting it again used to store
          `{street:'', zip:'', city:'', country:'Deutschland'}` — three
          empty subfields and the untouched default — which
          `isBlankAnswer` (`response-validation.ts`) counts as answered,
          because a Land typed *on purpose* with everything else blank is
          meant to count (that rule stays there and is not touched here).

          The two cases are told apart by what is being edited, not by
          reading the resulting value back apart — the stored string
          `'Deutschland'` looks identical either way:

          - editing Straße, PLZ or Ort is what bakes the default in
            (`asAddress`) and is exactly the edit this finding is about, so
            it is the one that can also undo the bake: if the edit leaves
            all three real subfields blank *and* Land still says exactly
            the untouched default, the whole answer resets to `null` —
            the same „nichts beantwortet" state a fresh question starts
            in, not a fourth spelling of it;
          - editing Land itself is never touched by that check, in either
            direction: overwriting the default with a real country while
            the rest stays blank is a deliberate answer (Land „auf sich
            allein gestellt" — `isBlankAnswer`'s own reasoning), and
            clearing Land on purpose has to stay cleared, not spring back
            — the same guarantee `asAddress`'s doc already gives once a
            value exists.

          `onChange(null)` rather than the half-blank object: `asAddress`
          then reads the reset the same way it reads a field nobody has
          touched yet, so the Land box shows „Deutschland" again instead of
          going empty — there is no third rendered state between
          "pristine" and "reset back to pristine".
        */
        if (part !== 'country') {
          const hasContent =
            draft.street.trim() !== '' ||
            draft.zip.trim() !== '' ||
            draft.city.trim() !== '';
          if (!hasContent && draft.country === DEFAULT_ADDRESS_COUNTRY) {
            onChange(null);
            return;
          }
        }
        onChange(draft);
      };

      return (
        <div className="field__address">
          {ADDRESS_PARTS.map((part) => (
            <input
              key={part.key}
              className={
                part.key === 'street' || part.key === 'country'
                  ? 'field__control field__address-wide'
                  : 'field__control'
              }
              aria-label={part.label}
              placeholder={part.label}
              value={current[part.key]}
              onChange={(event) => {
                set(part.key, event.target.value);
              }}
            />
          ))}
        </div>
      );
    }

    // The Matrix grid: statements down the side, the scale
    // across the top, one native control per cell.
    //
    // **Native `<input>`s rather than the prototype's `<span onClick>`** — the
    // same correction the rating branch above makes, and here it buys more
    // than focusability: one `name` per **row** makes each row a real radio
    // group, so the arrow keys move within a row and the browser enforces „eine
    // Auswahl je Zeile" itself. With „Mehrfachauswahl je Zeile" on they become
    // checkboxes, which is the same switch `radio`/`checkbox` make above.
    //
    // Each cell carries its own accessible name („Programm: Gut"): the group is
    // named by the question, the row header is only a `<th>` and would never be
    // announced with the control otherwise.
    case 'matrix': {
      const answer = asMatrix(value);

      return (
        <div className="field__scroll">
          <table className="field__grid">
            <thead>
              <tr>
                <td />
                {question.columns.map((column) => (
                  <th scope="col" key={column.value}>
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {question.rows.map((row) => {
                const picked = pickedIn(answer, row.value);
                return (
                  <tr key={row.value}>
                    <th scope="row">{row.label}</th>
                    {question.columns.map((column) => (
                      <td key={column.value}>
                        <input
                          type={question.multiple ? 'checkbox' : 'radio'}
                          name={`${groupName}-${row.value}`}
                          aria-label={`${row.label}: ${column.label}`}
                          checked={picked.includes(column.value)}
                          onChange={() => {
                            onChange(
                              toggleMatrixCell(
                                answer,
                                row.value,
                                column.value,
                                question.multiple,
                              ),
                            );
                          }}
                        />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      );
    }

    // The table — a component of its own, for
    // the reason `FileField` above and `EventField` below are: „+ Zeile" and
    // „Entfernen" need a stable identity per row that survives a removal, and a
    // `case` cannot hold a hook. See {@link TableField}.
    case 'table':
      return (
        <TableField question={question} value={value} onChange={onChange} />
      );

    // The Datei-Upload — the one type whose control talks to
    // the server while the form is being filled in, which is why it is a
    // component with state of its own rather than a branch here (`FileField`).
    case 'file':
      return (
        <FileField
          question={question}
          value={value}
          onChange={onChange}
          target={uploadTarget}
          {...(unavailableRefs === undefined
            ? {}
            : { unavailable: unavailableRefs })}
          controlId={String(shared.id)}
          describedBy={describedBy}
          invalid={invalid}
        />
      );

    // The Veranstaltungen — a component of its own, like
    // `FileField` above and for the same kind of reason: it is the one branch
    // that has to remember something across renders (which boxes have carried a
    // number), and a `case` cannot hold a hook. See {@link EventField}.
    case 'event':
      return (
        <EventField
          question={question}
          value={value}
          onChange={onChange}
          seatStates={eventSeats}
          refusedEventKey={refusedEventKey}
          controlId={controlId}
        />
      );

    // Never reached: `FieldInput` renders its own callout for `info` and
    // returns before `Control` is ever called — there is no control
    // for a question that takes no answer. Present only so this switch stays
    // exhaustive when a further type arrives.
    case 'info':
      throw new Error('Control: „info" hat kein Steuerelement.');
  }

  // Unreachable while the switch is exhaustive; a new question type narrows to
  // itself instead of `never` here and the assignment names it.
  const unhandled: never = question;
  return unhandled;
}

/**
 * The Veranstaltungen — **one number box per entry, the
 * Personenzahl** .
 *
 * The prototype has a *checkbox* list here: its event field toggles membership
 * in a set (`renderPreview`'s event branch), i.e. it can say „wir kommen" and
 * cannot say with how many. The domain decision of 2026-07-31 is the other
 * one — an organisation registers three people and three seats are gone — so the control
 * is a number, and the deviation is on purpose rather than an oversight.
 *
 * The Kachel is the handoff's (`renderPreview`'s event branch): a bordered tile
 * per Veranstaltung, name and Termin on the left, a badge on the right —
 * „Ausgebucht" in red, „n frei" in green.
 *
 * ## What the badge says, and what it must not
 *
 * **„Ausgebucht" always shows; the figure only where the editor allowed it**
 * . Neither is decided here: the payload either carries a
 * `remaining` for a position or it does not, and this component renders what it
 * was given. That is the whole point of putting the decision in
 * `publicEventSeats` — a client that computed „frei" from a capacity it can see
 * in `definition` would publish the registration state the switch is there to
 * withhold.
 *
 * ⚠️ **The lock is comfort, never the limit.** A disabled box stops a
 * participant from filling in a hall that is already full; it stops nobody from
 * posting the number anyway. The Obergrenze holds because the submission runs
 * through a transaction that refuses with 409 and the position it fired on
 *  — this view then *marks* that position, which is what
 * `refusedEventKey` is for.
 */
function EventField({
  question,
  value,
  onChange,
  seatStates,
  refusedEventKey,
  controlId,
}: {
  readonly question: Extract<Question, { type: 'event' }>;
  readonly value: AnswerValue | undefined;
  readonly onChange: (value: AnswerValue) => void;
  readonly seatStates: ReadonlyMap<string, PublicEventSeats> | undefined;
  readonly refusedEventKey: string | undefined;
  readonly controlId: string;
}): ReactElement {
  const seats = new Map(seatsOf(value));

  /**
   * The boxes that have **carried a Personenzahl** — seeded from the answer this
   * field opened with, and extended by every box a number is typed into.
   *
   * This, not the number standing in the box right now, is what the lock is
   * asked about (a review finding). „Der Kasten ist gerade leer" is
   * reached by *editing* as well as by never having answered: `withSeats` drops
   * the entry for an empty box, for a `0` and for anything else that is not a
   * whole number, so a participant who selects their „3" and presses Backspace
   * to type „1" is momentarily indistinguishable from one who never registered.
   * Locking on that would disable the box under their cursor and keep it
   * disabled until a reload — taking away the very correction the requirement
   * promises always works, lowering a number, through the back door.
   *
   * A `Set` that is mutated rather than state that is set: nothing on screen
   * depends on it changing, and the render that reads it is the one the answer
   * change causes anyway. Its lifetime is this field's, which is `FillIn`'s,
   * which is one loaded answer — the same lifetime `FillIn`'s `answers` state
   * has, and deliberately so: the two are seeded from the same document in the
   * same commit, and a snapshot that outlived a change of answer (another
   * Bearbeiten-Link, another form) would be describing somebody else's
   * registration. The two callers give `FillIn` a `key` so that this really is
   * one answer per mount.
   */
  const [everHeldSeats] = useState<Set<string>>(
    () => new Set(seatsOf(value).map(([key]) => key)),
  );

  return (
    <div className="field__events">
      {question.events.map((entry, index) => {
        const state = seatStates?.get(entry.key);
        const count = seats.get(entry.key);
        /*
         * Built from the **index**, never from `entry.key`: the key is an
         * editor-supplied string the schema only bounds in length
         * (`eventEntrySchema`), so „fest ball" would turn `aria-describedby`
         * into a two-token list pointing at nothing — and the badge, which is
         * the whole announcement of „Ausgebucht" for a screen reader, would go
         * silent without anything on screen looking wrong.
         */
        const badgeId = `${controlId}-event-${String(index)}-state`;
        const locked =
          state?.full === true &&
          count === undefined &&
          !everHeldSeats.has(entry.key);
        const refused = refusedEventKey === entry.key;
        /*
         * `null` where there is nothing to say — an unbounded Veranstaltung, or
         * a bounded one with room whose editor kept the figure to
         * themselves. Computed rather than branched inside the markup so that
         * „kein Text" cannot render as an **empty badge**: a green pill with
         * nothing in it is what the first draft of this did.
         */
        const badge =
          state === undefined
            ? null
            : state.full
              ? 'Ausgebucht'
              : state.remaining === undefined
                ? null
                : `${String(state.remaining)} frei`;

        return (
          <label
            className={
              refused
                ? 'field__event field__event--refused'
                : state?.full === true
                  ? 'field__event field__event--full'
                  : 'field__event'
            }
            key={entry.key}
          >
            <span className="field__event-name">
              {entry.label}
              {entry.when === null ? null : (
                <span className="field__event-when">{entry.when}</span>
              )}
            </span>
            {badge === null ? null : (
              <span
                className={
                  state?.full === true
                    ? 'field__event-badge field__event-badge--full'
                    : 'field__event-badge'
                }
                id={badgeId}
              >
                {badge}
              </span>
            )}
            <input
              className="field__control field__event-count"
              type="number"
              // `0`, not `1`: a Personenzahl of `0` is a valid spelling of
              // „nicht angemeldet" (`withSeats`, `canonicalSeats`), not an
              // error. `min={1}` used to fight the participant here — the
              // browser's own stepper and the Pfeiltasten refuse to go below
              // `min`, so a box holding `1` could climb but never come back
              // down to „leer" through the control itself, only by clearing
              // it by hand. `min={0}` lets the native control reach the value
              // this field already treats as absent everywhere downstream.
              min={0}
              max={EVENT_SEATS_MAX}
              // The name alone would be ambiguous: a screen reader announces
              // the box, and „Sommerfest" says nothing about what goes in it.
              // **Explicit, so the browser stops concatenating**: the wrapping
              // `<label>` also holds the Termin and the badge, and without this
              // the box would announce as „Stadtfest Sa, 20:00 Ausgebucht" —
              // three facts in the field's *name*, which is the accname trap
              // this stage hit three times. The state travels as the field's
              // **description** instead, below.
              aria-label={`${entry.label}: Anzahl Personen`}
              {...(badge === null ? {} : { 'aria-describedby': badgeId })}
              aria-invalid={refused}
              disabled={locked}
              value={count ?? ''}
              onChange={(event) => {
                const next = withSeats(seats, entry.key, event.target.value);
                if (next.seats[entry.key] !== undefined) {
                  everHeldSeats.add(entry.key);
                }
                onChange(next);
              }}
            />
          </label>
        );
      })}
    </div>
  );
}

/**
 * The free-text box behind „Sonstiges" — **one** implementation for all three
 * choice types.
 *
 * It owns the visibility rule as well as the box itself: the text field belongs
 * on screen exactly while the „Sonstiges" entry is the chosen one, which the
 * answer spells as `other !== null` (`''` is „gewählt und noch leer", `null` is
 * „nicht gewählt"). Written once, so dropdown, radio group and checkbox list
 * cannot disagree about when the field appears or what it is called.
 *
 * A required question with an empty box therefore stays unanswered — the
 * fill-in view asks `isBlankAnswer` from `@formsache/shared`, which reads `other: ''`
 * as blank, and the server runs the same rule again.
 */
function OtherText({
  question,
  value,
  onChange,
}: {
  readonly question: ChoiceQuestion;
  readonly value: AnswerValue | undefined;
  readonly onChange: (value: AnswerValue) => void;
}): ReactElement | null {
  const answer = asChoice(value);
  if (!question.allowOther || answer.other === null) {
    return null;
  }

  return (
    <input
      className="field__other"
      aria-label={otherFieldLabel(question)}
      value={answer.other}
      onChange={(event) => {
        onChange({ values: answer.values, other: event.target.value });
      }}
    />
  );
}

/**
 * The types `Control` routes to the single-line `<input>` branch.
 *
 * Derived from `QuestionType` rather than written out as a free literal union:
 * a hand-written union compiles happily against a schema it no longer matches,
 * so the two copies of this list — here and in `QuestionPreview` — could drift
 * apart from the schema and from each other without anything going red. Through
 * `Extract` a renamed or removed type drops out of the union, and the `case`
 * labels below stop overlapping it (TS2678).
 *
 * `number` is absent on purpose, and that is the one real difference to the
 * preview's list: it has its own branch in `Control` (`valueAsNumber`), while
 * the preview only needs the `type` attribute.
 */
export type SingleLineFillType = Extract<
  QuestionType,
  'text' | 'date' | 'email' | 'phone'
>;

/**
 * The `type` attribute — the same mapping the builder's preview uses, so what
 * an editor saw is what a participant gets.
 *
 * Takes the **narrowed** discriminant, like its counterpart in
 * `QuestionPreview`: which types are single-line fields at all is decided in
 * `Control`, once, and a type that is not routed here cannot reach it.
 */
function inputType(type: SingleLineFillType): string {
  switch (type) {
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
