import type { ReactElement } from 'react';
import { useEffect, useRef } from 'react';
import type { Question } from '@formsache/shared';

import { useBuilderStore } from './builder-store';
import type { ConditionMark } from './condition-status';
import { QUESTION_TYPE_LABELS } from './question-defaults';
import { QuestionPreview } from './QuestionPreview';
import { QUESTION_CARD_ATTRIBUTE, useKeyboardDrag } from './use-pointer-drag';

export interface QuestionCardProps {
  readonly question: Question;
  readonly index: number;
  readonly total: number;
  readonly isSelected: boolean;
  /**
   * How this question's *Bedingte Anzeige* stands, or `null` for the majority
   * that have none. Handed down rather than derived here: the verdict is about
   * the whole document (`conditionMarks`), and asking it once per card would
   * walk the form once per card.
   */
  readonly conditionMark: ConditionMark | null;
  readonly onGripPointerDown: (
    event: React.PointerEvent<HTMLElement>,
    questionId: string,
  ) => void;
}

/**
 * One question in the canvas.
 *
 * The action row carries **⧉** and **×**. The prototype shows ▲ ▼ ⧉ ×, but
 * Konzept no. 9 removed the arrows entirely (the grip is the only way to
 * reorder); ⧉ "Duplizieren" arrived with the requirement.
 *
 * The card is a `<li>` with a click handler for selection rather than a
 * `<button>` wrapping everything: it contains the grip and the action
 * buttons, and a button inside a button is invalid HTML — which is the same
 * reason the handoff gives for dropping the arrows.
 */
export function QuestionCard({
  question,
  index,
  total,
  isSelected,
  conditionMark,
  onGripPointerDown,
}: QuestionCardProps): ReactElement {
  const selectQuestion = useBuilderStore((state) => state.selectQuestion);
  const deleteQuestion = useBuilderStore((state) => state.deleteQuestion);
  const duplicateQuestion = useBuilderStore((state) => state.duplicateQuestion);
  const nudgeQuestion = useBuilderStore((state) => state.nudgeQuestion);
  const dragOverQuestionId = useBuilderStore(
    (state) => state.dragOverQuestionId,
  );
  const dragZone = useBuilderStore((state) => state.dragZone);
  const draggingQuestionId = useBuilderStore(
    (state) => state.draggingQuestionId,
  );

  const label = `Frage ${String(index + 1)}`;
  const origin = useRef<number | null>(null);

  const keyboard = useKeyboardDrag({
    label,
    position: index + 1,
    total,
    horizontal: true,
    onMove: (direction) => {
      nudgeQuestion(question.id, direction);
    },
    onCancel: () => {
      // Back to where the card was picked up, one step at a time — the store
      // only knows single steps, and a card three places away needs three.
      //
      // The direction is the part that was wrong once and is worth stating:
      // `origin > index` means the card has moved *towards the front*, so
      // undoing it moves it back — `next`. Getting this inverted made Escape
      // a no-op, which looks exactly like "Escape is not wired up".
      const from = origin.current;
      if (from === null) {
        return;
      }
      const distance = from - index;
      for (let step = 0; step < Math.abs(distance); step += 1) {
        nudgeQuestion(question.id, distance > 0 ? 'next' : 'prev');
      }
    },
  });

  // Remembered on the transition into "held", not on every render while held:
  // otherwise the origin would follow the card and Escape would restore it to
  // where it already is.
  useEffect(() => {
    origin.current = keyboard.held ? (origin.current ?? index) : null;
  }, [keyboard.held, index]);

  const isDropTarget = dragOverQuestionId === question.id;
  const classes = [
    'q-card',
    question.width === 'half' ? 'q-card--half' : 'q-card--full',
    isSelected ? 'q-card--selected' : '',
    draggingQuestionId === question.id ? 'q-card--dragging' : '',
    isDropTarget && dragZone !== null ? `q-card--over-${dragZone}` : '',
    keyboard.held ? 'q-card--held' : '',
  ]
    .filter((entry) => entry !== '')
    .join(' ');

  return (
    <li
      className={classes}
      data-testid="question-card"
      {...{ [QUESTION_CARD_ATTRIBUTE]: question.id }}
      onClick={() => {
        selectQuestion(question.id);
      }}
    >
      <div className="q-card__head">
        <button
          type="button"
          className="q-card__grip"
          // The name says what moves, not what the glyph is: "⠿" tells a
          // screen-reader user nothing.
          aria-label={`${label} verschieben`}
          aria-pressed={keyboard.held}
          onPointerDown={(event) => {
            onGripPointerDown(event, question.id);
          }}
          onKeyDown={keyboard.onKeyDown}
          onClick={(event) => {
            event.stopPropagation();
          }}
        >
          <span aria-hidden="true">⠿</span>
        </button>

        {/*
          **The way to a question without a mouse** (a review finding,
          2026-08-12). Until then `selectQuestion` hung on the `onClick` of this
          `<li>` alone, and the `<li>` was neither focusable nor did it have a
          role: a **saved** question could not be opened by keyboard, so
          label, options, required flag and Bedingte Anzeige were
          unreachable (WCAG 2.1.1, Level A). While *creating* one it went
          unnoticed, because `addQuestion` selects by itself — which is exactly
          why `keyboard-flow.spec.ts` did not see it.

          **The type mark carries the button, not the card.** A
          `role="button"` on the `<li>` would be a button containing the grip
          and the action buttons — the same nesting because of which the card
          is no `<button>` at all. A visible button of its own would be an
          element the handoff does not know. The mark stands there anyway,
          names the type and is thus the one place that says something about
          *this* question; it gets the full name as its `aria-label`, because
          „Kurztext" alone is not one.

          `aria-pressed` says whether the question is currently open — the same
          form the grip uses for „festgehalten".
        */}
        <button
          type="button"
          className="q-card__type"
          aria-label={`${label} bearbeiten`}
          aria-pressed={isSelected}
          onClick={(event) => {
            event.stopPropagation();
            selectQuestion(question.id);
          }}
        >
          {QUESTION_TYPE_LABELS[question.type]}
        </button>
        {/*
          The requirement — a question with a *Bedingte Anzeige* is
          recognisable **on the card**, not only in the properties panel.
          Without it, an editor who scrolls the canvas to find a field
          missing from the fill-in view has nothing here to point them at the
          reason („sonst sucht ein
          Bearbeiter, warum ein Feld beim Ausfüllen fehlt"). The prototype
          itself has no such mark — this is not a handoff detail to match, it
          is a gap the requirement names in as many words.

          **Two captions, not one.** A condition whose source was deleted,
          retyped or dragged behind this card is exactly the case the mark is
          here for, and „Bedingt" on both said the opposite: that the form was
          fine. The full sentence — which source, which comparison, or why it
          resolves to nothing — is the badge's accessible name and its
          tooltip, so it is available without opening the panel.
        */}
        {conditionMark === null ? null : (
          <span
            className={
              conditionMark.problem === null
                ? 'q-card__condition'
                : 'q-card__condition q-card__condition--broken'
            }
            data-testid="question-condition-badge"
            role="note"
            aria-label={conditionMark.description}
            title={conditionMark.description}
          >
            {conditionMark.text}
          </span>
        )}
        <span className="q-card__title">
          {question.label}
          {/*
            **The star is decoration, the word is the message** — the shape
            `fill/FieldInput.tsx` already uses, pulled over here after
            an acceptance run measured this card as the one place that did it
            the other way.

            It carried `aria-label="Pflichtfeld"` on this `<span>` until then,
            which *ARIA in HTML* forbids: an element without a role has the
            `generic` role, and naming a `generic` is one of the cases the
            spec rules out. Browsers and screen readers are free to drop it,
            and several do — the announcement was then „Stern" or nothing, so
            the one thing the mark exists to say reached nobody listening.

            The fill-in view solves it by hiding the star and letting the
            control's own `required` carry the fact. A builder card has no
            control, so the fact is carried by text instead: hidden from the
            eye, part of the title's accessible text, announced once.
          */}
          {question.required ? (
            <>
              <span className="q-card__required" aria-hidden="true">
                {' '}
                *
              </span>
              <span className="visually-hidden"> (Pflichtfeld)</span>
            </>
          ) : null}
        </span>

        <button
          type="button"
          className="q-card__duplicate"
          aria-label={`${label} duplizieren`}
          title="Duplizieren"
          onClick={(event) => {
            event.stopPropagation();
            duplicateQuestion(question.id, crypto.randomUUID());
          }}
        >
          <span aria-hidden="true">⧉</span>
        </button>

        <button
          type="button"
          className="q-card__delete"
          aria-label={`${label} löschen`}
          onClick={(event) => {
            event.stopPropagation();
            deleteQuestion(question.id);
          }}
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>

      {question.hint === null || question.hint === '' ? null : (
        <p className="q-card__hint">{question.hint}</p>
      )}

      <QuestionPreview question={question} />

      {isDropTarget && (dragZone === 'left' || dragZone === 'right') ? (
        <span className="q-card__split-hint">↔ nebeneinander</span>
      ) : null}

      {/*
        One live region per card rather than one for the canvas: the message is
        about *this* item, and a shared region would be updated by whichever
        card moved last — which is not necessarily the one the user is holding.
      */}
      <span className="visually-hidden" role="status">
        {keyboard.announcement}
      </span>
    </li>
  );
}
