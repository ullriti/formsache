import type { ReactElement } from 'react';
import { useId, useMemo, useState } from 'react';
import type {
  ConditionOperator,
  EventEntry,
  FormPage,
  Question,
  QuestionCondition,
  QuestionOption,
  QuestionType,
  TableCellType,
  TableColumn,
} from '@formsache/shared';
import {
  ATTACHMENT_HINT,
  conditionOperatorsFor,
  EVENT_CAPACITY_MAX,
  MAX_FILES_PER_RESPONSE,
  questionSchema,
  TABLE_COLUMNS_MAX,
  TABLE_ROWS_MAX,
} from '@formsache/shared';

import { useCaptionDraft } from './caption-draft';
import { earlierConditionSources } from './condition-sources';
import { conditionMarkOf, OPERATOR_LABELS } from './condition-status';
import { useBuilderStore } from './builder-store';
import {
  parseOptionBulkImport,
  QUESTION_TYPE_LABELS,
  QUESTION_TYPES,
  starterOptions,
} from './question-defaults';

/**
 * Properties of the selected question — the right panel's second face,
 * and where the requirement is operated: Pflicht, Min/Max and
 * Muster per type.
 *
 * Every edit goes through `questionSchema` before it reaches the store. That
 * is not belt-and-braces with the server check: the store feeds the *live
 * preview* and the save payload, and a question that cannot parse would
 * otherwise sit in the builder looking fine until the save reports a path
 * nobody can map back to a field. Here the field says so immediately.
 */
export function QuestionProperties({
  question,
  onSaveAsTemplate,
}: {
  readonly question: Question;
  /**
   * „☆ Als Vorlage speichern" — absent when the
   * signed-in person may not build, and then the button is not rendered at
   * all rather than rendered disabled: a control that can never work is not a
   * hint, it is noise.
   */
  readonly onSaveAsTemplate?: () => void;
}): ReactElement {
  const updateQuestion = useBuilderStore((state) => state.updateQuestion);
  const setQuestionWidth = useBuilderStore((state) => state.setQuestionWidth);
  const changeQuestionType = useBuilderStore(
    (state) => state.changeQuestionType,
  );
  const deselect = useBuilderStore((state) => state.selectQuestion);
  // Read for `ConditionEditor` below — the source picklist of the requirement needs every page's questions, not only the active one.
  const pages = useBuilderStore((state) => state.pages);
  const [issue, setIssue] = useState<string | null>(null);

  /**
   * What the live region below says (rest from the requirement).
   *
   * `QuestionPreview` stands entirely under `aria-hidden`, and that **stays
   * that way**: the preview is a duplication of what has just been set in this
   * column, and without `aria-hidden` a screen reader would read every question
   * twice. The price for it is that a switch whose whole effect lies *in* the
   * preview has no feedback at all: you press, the checkbox reports
   * „aktiviert" — and nothing says what that changed about the question.
   *
   * What is announced is therefore the **change of state**, not the content of
   * the preview; {@link switchMessage} builds the sentence. Which switches this
   * concerns is stated there.
   *
   * Reset at the change of question, because this panel is **not** rebuilt per
   * question (`BuilderView` renders it without `key`): a sentence left standing
   * would otherwise belong to the previous card. The adjustment during
   * rendering is React's own answer to "a property has changed, derived state
   * has to follow" — the same construction as in
   * {@link TableRowLimitField}.
   */
  const [announcement, setAnnouncement] = useState('');
  const [announcedFor, setAnnouncedFor] = useState(question.id);
  if (announcedFor !== question.id) {
    setAnnouncedFor(question.id);
    setAnnouncement('');
    /*
      **And the refusal goes with it** (review finding 17). `issue` is the
      sibling case of the announcement above and hung on the same nail: the panel
      is not rebuilt per question, so a message like „zu lang" stayed standing
      over the *next* selected question — over a field into which nobody has
      entered anything, and in a `role="alert"` region, which thereby asserts
      something false.
    */
    setIssue(null);
  }
  const announce: Announce = (message) => {
    setAnnouncement(message);
  };

  /**
   * Writes a candidate question, or reports why it was refused — never both.
   *
   * Takes `unknown` because that is what it hands to the schema anyway, which
   * also makes it usable as a {@link Replace}: a caller that has a **whole**
   * question in hand passes it straight through. That caller exists for one
   * reason — a merge cannot *remove* a key, and „nicht ergänzbar" is spelled
   * by the **absence** of `addRows` (`form-schema.ts`); see
   * {@link TableRowGrowth}.
   */
  function commit(candidate: unknown): void {
    const parsed = questionSchema.safeParse(candidate);
    if (!parsed.success) {
      setIssue(parsed.error.issues[0]?.message ?? 'Ungültige Eingabe.');
      return;
    }
    setIssue(null);
    updateQuestion(question.id, parsed.data);
  }

  /** Applies a patch, or reports why it was refused — never both. */
  function patch(changes: Partial<Question>): void {
    commit({ ...question, ...changes });
  }

  return (
    <div className="props">
      <div className="props__head">
        <p className="props__caption">Eigenschaften</p>
        {/*
          The way back to the palette, and the reason it exists at all: the
          panel shows either the type library or the properties of the selected
          question, and inserting a question selects it. Without
          this control the first question would be the last one anybody could
          add — found by the component test, not by reading the code.
        */}
        <button
          type="button"
          className="props__small"
          onClick={() => {
            deselect(null);
          }}
        >
          + Weitere Frage
        </button>
      </div>

      {/*
        Through {@link Field} and no longer as an enclosing `<label>`: the
        field's error message stands as a sibling beside the box, and inside a
        `<label>` it would become part of the box's *name* — a screen reader
        would read „Fragetext Ohne Text wird nichts gespeichert …" instead of
        name and description apart. Exactly the reason {@link Field} exists at
        all.
      */}
      <Field label="Fragetext">
        {(field) => (
          <CaptionInput
            /*
              At the question text the draft hangs on *this* question: the panel
              is not rebuilt per question, and two questions with the same text
              would show the half-deleted draft of the one at the other.
            */
            key={question.id}
            id={field.id}
            value={question.label}
            onCommit={(label) => {
              patch({ label });
            }}
          />
        )}
      </Field>

      <label className="props__field">
        <span className="props__label">Hinweistext</span>
        <input
          value={question.hint ?? ''}
          onChange={(event) => {
            // Empty means "no hint", and the schema spells that `null`. Storing
            // `''` instead would make an untouched field and a cleared one two
            // different documents.
            patch({
              hint: event.target.value === '' ? null : event.target.value,
            });
          }}
        />
      </label>

      {/*
        Hidden for `info`: the field still parses — every
        variant shares `questionBaseShape` — but nothing ever reads it for an
        `info`, which has no answer to be missing. A toggle that provably does
        nothing is worse than none; the schema keeps `required: false` from
        `createQuestion` and never asks the question again.
      */}
      {question.type === 'info' ? null : (
        <label className="props__check">
          <input
            type="checkbox"
            checked={question.required}
            onChange={(event) => {
              patch({ required: event.target.checked });
            }}
          />
          <span>Pflichtfeld</span>
        </label>
      )}

      {/*
        Width is also set by docking two cards. It is editable here as
        well because docking is a pointer gesture with no keyboard equivalent —
        without this control, a keyboard user could never make a card half
        width.

        `setQuestionWidth` rather than `patch`: half width is a pair, so the
        neighbouring card moves with it. Patching this one card alone would be
        reverted by the store's invariant, and the control would look dead.
      */}
      <Field
        label="Breite"
        note="Halbe Breite gilt für ein Paar: Die Nachbarkarte rückt daneben. Auch per Ziehen auf die linke oder rechte Seite einer anderen Karte."
      >
        {(field) => (
          <select
            {...field}
            value={question.width}
            onChange={(event) => {
              setQuestionWidth(
                question.id,
                event.target.value === 'half' ? 'half' : 'full',
              );
            }}
          >
            <option value="full">Ganze Breite</option>
            <option value="half">Halbe Breite</option>
          </select>
        )}
      </Field>

      {/*
        Konzept no. 24: a type change is internally a new question, so
        this does not go through `patch` — `changeQuestionType` mints a fresh
        id (the same way `TypePalette` does for a brand-new card, `CONTRIBUTING.md`) rather than editing the `type` field of this one in place. Label,
        hint, required and width carry over; everything type-specific
        (Min/Max, Muster, Optionen …) does not — see the store action's doc
        comment for why.
      */}
      <Field
        label="Typ"
        note="Ändert sich der Typ, beginnt die Frage für neue Antworten leer – bereits gegebene Antworten bleiben unverändert bei der bisherigen Frage stehen."
      >
        {(field) => (
          <select
            {...field}
            value={question.type}
            onChange={(event) => {
              const type = event.target.value as QuestionType;
              if (type === question.type) {
                return;
              }
              changeQuestionType(question.id, type, crypto.randomUUID());
            }}
          >
            {QUESTION_TYPES.map((type) => (
              <option key={type} value={type}>
                {QUESTION_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        )}
      </Field>

      <TypeSpecific
        /*
          **Rebuilt at the change of question** — for the same reason the
          question text above carries its `key` (review rework on finding 22).

          The drafts of the list captions live in the rows below, and the rows
          are keyed by `option.value` / `column.key` / `entry.key` — values that
          `question-defaults.ts` assigns **deterministically**: every new choice
          begins with `option-1` („Option 1"), every matrix with the same three
          rows. Without this `key` a half-deleted „Option 1" of the one question
          met the one of the same name of the next, `useCaptionDraft` would see
          the same stored text and showed the foreign draft including its error
          message over a question at which nobody has deleted anything.

          ⚠️ **This one `key` covers everything that hangs under `TypeSpecific`**
          (review finding 12): every local draft in the fields below —
          `RatingMaxField`, `TableRowGrowth` with its `TableRowLimitField`, the
          list rows — is rebuilt with this branch. A second
          `key={question.id}` on a child of it was without effect and
          nevertheless claimed that something was secured there.
          `ConditionEditor` stands **outside** this branch and needs its own.
        */
        key={question.id}
        question={question}
        patch={patch}
        replace={commit}
        announce={announce}
      />

      <ConditionEditor question={question} pages={pages} patch={patch} />

      {issue === null ? null : (
        <p className="props__issue" role="alert">
          {issue}
        </p>
      )}

      {/*
        **Rendered unconditionally, empty until there is something to say** —
        the same rule `TableField` and the builder's publish state follow: a
        `role="status"` region that comes into being only together with its
        text is new in the accessibility tree when the text arrives, and is then
        frequently not announced at all.

        One region per panel, not per switch: the panel always shows exactly
        one question, and every announcement carries the name of its switch
        with it ({@link switchMessage}), so even with two switches on the same
        question it is clear which one is meant.
      */}
      <span className="visually-hidden" role="status">
        {announcement}
      </span>

      {onSaveAsTemplate === undefined ? null : (
        <button
          type="button"
          className="props__template"
          onClick={onSaveAsTemplate}
        >
          <span aria-hidden="true">☆ </span>Als Vorlage speichern
        </button>
      )}
    </div>
  );
}

type Patch = (changes: Partial<Question>) => void;

/**
 * Writing a **whole** question instead of merging one in.
 *
 * The one edit {@link Patch} cannot express: `{ ...question, addRows:
 * undefined }` leaves the key present (Zod keeps it in its output, and
 * `exactOptionalPropertyTypes` refuses to let it be written that way at all),
 * while „nicht ergänzbar" is spelled by the absent key and nothing else.
 */
type Replace = (question: Question) => void;

/** Sends a sentence into the panel's live region. */
type Announce = (message: string) => void;

/**
 * The sentence with which a switch announces its new state.
 *
 * **The value is part of the sentence, and that is no decoration.** A live
 * region speaks the same text only **once**: an announcement „Zeilen ergänzbar"
 * would be word-identical with the first one when the same switch is flipped a
 * second time and therefore mute — that is exactly what the first version of
 * this announcement failed on. „ein"/„aus" alternate with every press, so every
 * announcement differs from its predecessor.
 *
 * **And the effect is stated with it**, because the state alone does not answer
 * the question the editor has: „Mehrfachauswahl je Zeile: ein" says nothing
 * about the cells of the matrix now being boxes instead of dots — and that is
 * exactly the part that stands exclusively in the `aria-hidden` preview.
 *
 * ## Which switches get this, and which do not
 *
 * Provided for are the four whose effect stands **nowhere** in the
 * accessibility tree, that is, only in the hidden preview or not at all:
 *
 * - „Zeilen ergänzbar" (Tabelle) — the effect is the „+ Zeile" button of the
 *   preview; the reported case.
 * - „Mehrfachauswahl je Zeile" (Matrix) — the effect is the cell shape of the
 *   preview (`q-preview__cell-box--round`), that is, pure drawing.
 * - „Nur ganze Zahlen" (Zahl) — the hardest case: the preview shows the switch
 *   **not at all**, it only takes effect in the schema when filling in. So far
 *   there was no feedback of any kind on any view for it.
 * - „„Sonstiges“ mit Freitext anbieten" (Auswahl) — the effect is the
 *   additional entry in the preview list. The field for its caption, which
 *   appears below it, is the *setting*, not the effect.
 *
 * Not provided for, because their effect stands in the accessibility tree and
 * is found there:
 *
 * - „Pflichtfeld" — the question card carries „(Pflichtfeld)" in its title
 *   (`QuestionCard`).
 * - „Bedingte Anzeige" — the condition block appears directly below the
 *   switch, with its own heading and its own controls.
 * - „ohne Grenze" and „Restplätze anzeigen" (per Veranstaltung) — the
 *   Veranstaltung preview is the only one that is **not** `aria-hidden` and
 *   names both („ohne Grenze"/„max. 50", „Restplätze sichtbar").
 *
 * ## The announcement follows the write without asking about its success
 *
 * {@link Patch} and {@link Replace} can **refuse** a document (then the reason
 * stands in the `props__issue` and the question stays as it was), and none of
 * the callers below asks about that. That is right today and a trap tomorrow:
 * the four provided switches write exclusively values that `questionSchema`
 * *cannot* refuse — two bare booleans, a pair `allowOther`/`otherLabel`, and an
 * upper limit that begins with {@link TABLE_ROWS_MAX} and therefore never lies
 * below the start rows. A **fifth** switch whose write can fail would have to
 * hang its announcement on that success; otherwise it announces a state the
 * document does not have.
 */
function switchMessage(name: string, on: boolean, effect: string): string {
  return `${name}: ${on ? 'ein' : 'aus'}. ${effect}`;
}

/**
 * A labelled control with an optional explanatory note.
 *
 * The note sits **outside** the `<label>` and is tied to the control with
 * `aria-describedby`. Inside the label it would become part of the control's
 * *name*: a screen reader would announce the field as „Muster (RegEx) Ein
 * Muster, das sich nicht übersetzen lässt, wird sofort abgelehnt …" instead of
 * naming it and describing it separately. Found by a component test that could
 * not address the field by its label — which is exactly what a user of
 * assistive technology would have hit.
 */
function Field({
  label,
  note,
  children,
}: {
  readonly label: string;
  readonly note?: string;
  readonly children: (props: {
    id: string;
    'aria-describedby'?: string;
  }) => ReactElement;
}): ReactElement {
  const id = useId();
  const noteId = `${id}-note`;

  return (
    <div className="props__field">
      <label className="props__label" htmlFor={id}>
        {label}
      </label>
      {children(
        note === undefined ? { id } : { id, 'aria-describedby': noteId },
      )}
      {note === undefined ? null : (
        <span className="props__note" id={noteId}>
          {note}
        </span>
      )}
    </div>
  );
}

/**
 * A **mandatory** caption: question text, option, matrix row, table column,
 * Veranstaltung.
 *
 * The field may become empty while being edited — the rule and its reasoning
 * stand at {@link useCaptionDraft}. What this component contributes to it is
 * the *display* of this intermediate state: `aria-invalid` on the box and a
 * message that hangs on it via `aria-describedby` and says what is **not**
 * being stored right now. A field that silently writes nothing would be only
 * the second half of the same mistake.
 *
 * Box and message stand together in a box of their own
 * (`props__caption-box`), so that in a row like `props__option` — caption,
 * ↑/↓, × — the message lands **below** the box instead of pushing itself
 * between the buttons.
 */
function CaptionInput({
  value,
  onCommit,
  id,
  className,
  ariaLabel,
}: {
  readonly value: string;
  readonly onCommit: (value: string) => void;
  readonly id?: string;
  readonly className?: string;
  /** For fields in list rows that carry no visible caption. */
  readonly ariaLabel?: string;
}): ReactElement {
  const draft = useCaptionDraft(value, onCommit);

  return (
    <span className="props__caption-box">
      <input
        {...(id === undefined ? {} : { id })}
        {...(className === undefined ? {} : { className })}
        {...(ariaLabel === undefined ? {} : { 'aria-label': ariaLabel })}
        {...(draft.invalid ? { 'aria-describedby': draft.errorId } : {})}
        value={draft.value}
        aria-invalid={draft.invalid}
        onChange={(event) => {
          draft.onChange(event.target.value);
        }}
      />
      {draft.invalid ? (
        <span className="props__field-error" id={draft.errorId} role="alert">
          Ohne Text wird nichts gespeichert – die bisherige Beschriftung bleibt
          bestehen.
        </span>
      ) : null}
    </span>
  );
}

/**
 * The validation rules that exist only for some types.
 *
 * A `switch` **without `default`**, closed by the `never` assignment below: the
 * panel is where a type states what can be configured about it, and „nothing"
 * is a legitimate answer (`email`, `phone`) — but it has to be *given*. Under a
 * `default: return null` a new type looked configured-by-design while nobody
 * had decided anything. A `Record` would not fit here: each branch
 * needs the question narrowed to its own variant to read `question.pattern`,
 * `question.options` and the rest.
 */
function TypeSpecific({
  question,
  patch,
  replace,
  announce,
}: {
  readonly question: Question;
  readonly patch: Patch;
  /** Only the table needs it — see {@link Replace} for why it exists. */
  readonly replace: Replace;
  /** The panel's live region — see {@link switchMessage}. */
  readonly announce: Announce;
}): ReactElement | null {
  switch (question.type) {
    case 'text':
      return (
        <>
          <NumberPair
            min={question.minLength}
            max={question.maxLength}
            patch={patch}
            minKey="minLength"
            maxKey="maxLength"
            minLabel="Mindestlänge"
            maxLabel="Höchstlänge"
          />
          <Field
            label="Muster (RegEx)"
            note="Ein Muster, das sich nicht übersetzen lässt, wird sofort abgelehnt – nicht erst beim Ausfüllen."
          >
            {(field) => (
              <input
                {...field}
                value={question.pattern ?? ''}
                placeholder="z. B. ^[A-Z]{2}\d+$"
                onChange={(event) => {
                  patch({
                    pattern:
                      event.target.value === '' ? null : event.target.value,
                  });
                }}
              />
            )}
          </Field>
        </>
      );

    case 'textarea':
      return (
        <NumberPair
          min={question.minLength}
          max={question.maxLength}
          patch={patch}
          minKey="minLength"
          maxKey="maxLength"
          minLabel="Mindestlänge"
          maxLabel="Höchstlänge"
        />
      );

    case 'number':
      return (
        <>
          <NumberPair
            min={question.min}
            max={question.max}
            patch={patch}
            minKey="min"
            maxKey="max"
            minLabel="Minimum"
            maxLabel="Maximum"
          />
          <label className="props__check">
            <input
              type="checkbox"
              checked={question.integer}
              onChange={(event) => {
                const on = event.target.checked;
                patch({ integer: on });
                announce(
                  switchMessage(
                    'Nur ganze Zahlen',
                    on,
                    on
                      ? 'Nachkommastellen werden beim Ausfüllen abgewiesen.'
                      : 'Nachkommastellen sind erlaubt.',
                  ),
                );
              }}
            />
            <span>Nur ganze Zahlen</span>
          </label>
        </>
      );

    case 'date':
      return (
        <div className="props__row">
          <label className="props__field">
            <span className="props__label">Frühestes Datum</span>
            <input
              type="date"
              value={question.minDate ?? ''}
              onChange={(event) => {
                patch({
                  minDate:
                    event.target.value === '' ? null : event.target.value,
                });
              }}
            />
          </label>
          <label className="props__field">
            <span className="props__label">Spätestes Datum</span>
            <input
              type="date"
              value={question.maxDate ?? ''}
              onChange={(event) => {
                patch({
                  maxDate:
                    event.target.value === '' ? null : event.target.value,
                });
              }}
            />
          </label>
        </div>
      );

    case 'select':
    case 'radio':
      return (
        <OptionsEditor question={question} patch={patch} announce={announce} />
      );

    case 'checkbox':
      return (
        <>
          <OptionsEditor
            question={question}
            patch={patch}
            announce={announce}
          />
          <NumberPair
            min={question.minSelected}
            max={question.maxSelected}
            patch={patch}
            minKey="minSelected"
            maxKey="maxSelected"
            minLabel="Mindestens auswählen"
            maxLabel="Höchstens auswählen"
          />
        </>
      );

    // No validation rules of their own — the format *is* the rule, and it is
    // checked by the schema (`answerSchemaFor`), not configured here.
    case 'email':
    case 'phone':
      return null;

    // Nothing type-specific either, for a different reason: an `info` has no
    // rule to configure at all. Fragetext and Hinweistext, edited
    // above like every type's, are the callout's whole content.
    case 'info':
      return null;

    case 'rating':
      // No `key` of its own: `TypeSpecific` carries it (see there), and this
      // branch is a child of it — so the draft in `RatingMaxField` begins
      // fresh at the change of question anyway.
      return <RatingMaxField max={question.max} patch={patch} />;

    // No rule to configure here either: unlike `rating`'s Sterne-
    // Maximum, the handoff's own inspector has no `q.type === 'address'`
    // branch — Pflicht (three of the four subfields, never Land) is decided
    // by `addressAnswerSchema`, not by anything an editor sets per question.
    case 'address':
      return null;

    // Rows, scale and the one flag the handoff's inspector offers
    // (`inspectorExtra()`'s matrix branch: two list editors plus
    // „Mehrfachauswahl je Zeile") — the requirement.
    case 'matrix':
      return (
        <>
          <LabelledListEditor
            caption="Zeilen (Aussagen)"
            addLabel="+ Zeile"
            newItemLabel="Neue Zeile"
            valuePrefix="zeile"
            items={question.rows}
            onChange={(rows) => {
              patch({ rows });
            }}
          />
          <LabelledListEditor
            caption="Spalten (Skala)"
            addLabel="+ Spalte"
            newItemLabel="Neue Spalte"
            valuePrefix="spalte"
            items={question.columns}
            onChange={(columns) => {
              patch({ columns });
            }}
          />
          <label className="props__check">
            <input
              type="checkbox"
              checked={question.multiple}
              onChange={(event) => {
                const on = event.target.checked;
                patch({ multiple: on });
                announce(
                  switchMessage(
                    'Mehrfachauswahl je Zeile',
                    on,
                    on
                      ? 'Je Zeile sind mehrere Spalten wählbar.'
                      : 'Je Zeile ist genau eine Spalte wählbar.',
                  ),
                );
              }}
            />
            <span>Mehrfachauswahl je Zeile</span>
          </label>
        </>
      );

    // Columns with their Zelltyp, the Startzeilen — which the handoff's
    // inspector does *not* offer at all (its `rows` lives only in the data
    // model), hence „im Editor einstellbar" in the requirement — and
    // what a participant may do with those rows.
    case 'table':
      return (
        <>
          <TableColumnsEditor question={question} patch={patch} />
          <Field
            label="Startzeilen"
            /*
              **Die Obergrenze nennt jetzt ihren Grund** (Review-Runde 5 Nr. 4:
              „Warum maximal 20 Zeilen in der Tabelle?").

              Dass die Frage gestellt wurde, war die Auskunft: hier stand
              „Höchstens 20; jede Zelle wird eine eigene Spalte im Export" — die
              Regel, aber nicht die Rechnung. Und die Rechnung ist der Grund:
              Zeilen und Spalten **multiplizieren** sich, eine einzige Frage
              schreibt bis zu 400 Spalten in die Auswertung, und darüber hinaus
              hört eine Tabelle auf, auswertbar zu sein. Beide Zahlen kommen aus
              `form-schema.ts` — die Zahl in einem Satz ist genau die Sorte
              Zweitschreibung, die beim Ändern stehen bleibt.
            */
            note={`Wie viele Zeilen das Formular anbietet — nicht, wie viele ausgefüllt werden müssen. Höchstens ${String(TABLE_ROWS_MAX)}, und der Grund steht im Export: jede Zelle wird dort eine eigene Spalte, ${String(TABLE_ROWS_MAX)} Zeilen × ${String(TABLE_COLUMNS_MAX)} Spalten sind ${String(TABLE_ROWS_MAX * TABLE_COLUMNS_MAX)} Spalten aus einer einzigen Frage.`}
          >
            {(field) => (
              <input
                {...field}
                type="number"
                min={1}
                max={TABLE_ROWS_MAX}
                value={question.rows}
                onChange={(event) => {
                  const raw = Number(event.target.value);
                  if (!Number.isFinite(raw)) {
                    return;
                  }
                  // Clamped for the reason the Sterne-Maximum above is: the
                  // schema still guards every write, but a field that visibly
                  // rejects the number just typed reads as broken.
                  const rows = Math.min(
                    TABLE_ROWS_MAX,
                    Math.max(1, Math.round(raw)),
                  );
                  // The Obergrenze is carried up with the Startzeilen rather
                  // than left to collide with them. `maxRows < rows` is a
                  // document the schema refuses (`tableQuestionWithBounds`),
                  // so the alternative is not „a lower ceiling" but „the
                  // Startzeilen box stops working, with an error under it" —
                  // and a ceiling below the floor was never a state anybody
                  // asked for.
                  patch(
                    question.addRows === undefined
                      ? { rows }
                      : {
                          rows,
                          addRows: {
                            maxRows: Math.max(question.addRows.maxRows, rows),
                          },
                        },
                  );
                }}
              />
            )}
          </Field>
          {/* No `key` of its own — `TypeSpecific` carries it, see there. */}
          <TableRowGrowth
            question={question}
            patch={patch}
            replace={replace}
            announce={announce}
          />
        </>
      );

    // **One setting, and the two the handoff offers are deliberately not
    // here** . Its inspector has „Erlaubte Dateitypen" as a
    // free text box and „Maximale Größe (MB)" as a number — both an editor's
    // opinion about a rule the server decides (ADR-0014 no. 5 and no. 6), and a
    // box whose value the server ignores is worse than no box: „DOCX" typed
    // there would produce a field that rejects every file a participant picks,
    // with no way for either of them to see why. The rule is shown instead of
    // asked for, in the note below and in the preview.
    case 'file':
      return (
        <Field
          label="Anzahl Dateien"
          note={`${ATTACHMENT_HINT} — das entscheidet der Server und ist nicht einstellbar. Höchstens ${String(MAX_FILES_PER_RESPONSE)} Dateien je Antwort insgesamt.`}
        >
          {(field) => (
            <input
              {...field}
              type="number"
              min={1}
              max={MAX_FILES_PER_RESPONSE}
              value={question.maxFiles}
              onChange={(event) => {
                const raw = Number(event.target.value);
                if (!Number.isFinite(raw)) {
                  return;
                }
                // Clamped like the two numeric settings above, for the same
                // reason: the schema guards every write, and a box that
                // visibly refuses the number just typed reads as broken.
                patch({
                  maxFiles: Math.min(
                    MAX_FILES_PER_RESPONSE,
                    Math.max(1, Math.round(raw)),
                  ),
                });
              }}
            />
          )}
        </Field>
      );

    // The Veranstaltungen and their Obergrenzen — the handoff's
    // „Veranstaltungen & Limits" block, minus its „angemeldet" box: that number
    // is a counter an editor may type there, and here it is the sum of the
    // `event_registration` rows and can only be read (`eventEntrySchema`).
    case 'event':
      return <EventListEditor events={question.events} patch={patch} />;
  }

  // Unreachable while the switch is exhaustive; a new question type narrows to
  // itself instead of `never` here and the assignment names it.
  const unhandled: never = question;
  return unhandled;
}

/**
 * The picklist a value control offers for a choice-type source — `null` for
 * every other type, which gets a plain number or text box instead.
 *
 * A `switch` **without `default`**, closed by the `never` assignment below,
 * like every other exhaustive one in this file — and this one earned it the
 * hard way: under `default: return null` a new auswahlartiger type fell into
 * the free-text box in silence, while `readingOf` (the function that decides
 * what the same answer *means*, `packages/shared/src/condition.ts`) forced a
 * compile error for the very same decision. Two places deciding „ist das eine
 * Auswahl", one of them mute.
 */
function sourceChoiceOptions(
  source: Question,
): readonly { readonly value: string; readonly label: string }[] | null {
  switch (source.type) {
    case 'select':
    case 'radio':
    case 'checkbox':
      return source.options;
    // The values a condition compares against are the event **keys** — the
    // same reading `readingOf` in `packages/shared/src/condition.ts` gives
    // an `event` answer.
    case 'event':
      return source.events.map((entry) => ({
        value: entry.key,
        label: entry.label,
      }));
    // No picklist: these are compared against a typed number or text. The five
    // types that cannot be a source at all (`info`, `file`, `table`, `matrix`,
    // `address`) are listed too — they never reach this function, because
    // `conditionOperatorsFor` hands them an empty operator list, but naming
    // them is what keeps the `never` below reachable only by a *new* type.
    case 'text':
    case 'textarea':
    case 'email':
    case 'phone':
    case 'date':
    case 'number':
    case 'rating':
    case 'info':
    case 'file':
    case 'table':
    case 'matrix':
    case 'address':
      return null;
  }

  // Unreachable while the switch is exhaustive; a new question type narrows to
  // itself instead of `never` here and the assignment names it.
  const unhandled: never = source;
  return unhandled;
}

/**
 * *Bedingte Anzeige* — Umschalter, Quellfrage, Operator, Wert. Rendered for every question type, including `info`: the toggle
 * lives on `questionBaseShape` in `packages/shared/src/form-schema.ts`, and a
 * callout that only appears once a participant has picked „Ich komme mit dem
 * Auto" is exactly what an Infotext is for.
 *
 * **This panel only ever writes a `QuestionCondition`, never judges one.**
 * The one evaluation — what the source's answer means, what „ist ausgefüllt"
 * reads as, what a hidden source does to a question depending on it — lives
 * in `packages/shared/src/condition.ts` and is reached through the one door
 * that module exports, `visibleQuestionIds`; the fill-in view's render and
 * `validatePage` read it, and the server enforces it again on its own (the requirement: „eine Suche findet die Auswertung genau einmal"). Duplicating any part
 * of it here would be exactly the second copy that search is built to catch.
 *
 * Every write leaves `visibleIf` **complete and valid** — never a source
 * chosen with no operator, or an operator that needs a value with none set —
 * because `questionConditionSchema` is a discriminated union with no partial
 * member. „Noch nicht fertig" is therefore **not written at all**: the
 * operator select and the Wert box run off a local draft
 * ({@link ConditionFields}) and the store keeps the last condition that
 * actually parsed. The alternative was measured and is worse than either: a
 * placeholder value (a single space) parsed, published, and meant the
 * *opposite* of what the panel showed — „ist gleich ␣" over a Freitextquelle
 * is „ist leer", because `equalsReading` trims both sides. Since the
 * conditional-visibility review, `conditionValueSchema` trims too, so the
 * placeholder no longer even parses; this panel is built along that refusal
 * instead of against it.
 */
function ConditionEditor({
  question,
  pages,
  patch,
}: {
  readonly question: Question;
  readonly pages: readonly FormPage[];
  readonly patch: Patch;
}): ReactElement {
  const toggleId = useId();
  const captionId = `${toggleId}-caption`;
  const sources = useMemo(
    () => earlierConditionSources(pages, question.id),
    [pages, question.id],
  );
  // The publish lock's own verdict on this question's condition — see
  // `condition-status.ts` for why the sentence is fetched rather than written.
  const mark = useMemo(
    () => conditionMarkOf(question, pages),
    [question, pages],
  );
  const condition = question.visibleIf;
  const enabled = condition !== undefined;
  /**
   * The source a fresh toggle would default to — read once here so both the
   * switch's `onChange` and the body below share it without a second lookup,
   * and so neither has to fall back to a non-null assertion: `sources[0]` is
   * `Question | undefined` however many times it is spelled out, and
   * `sources.length > 0` does not narrow it (`noUncheckedIndexedAccess`).
   */
  const firstSource = sources[0];
  const source =
    condition === undefined
      ? undefined
      : sources.find((candidate) => candidate.id === condition.questionId);

  const body =
    condition === undefined ? null : (
      <ConditionFields
        // **The one `key` that is needed outside of `TypeSpecific`**
        // (review finding 12): `ConditionEditor` hangs beside that branch, not
        // under it, so its `key` does not rebuild these fields along with it.
        // The local draft below belongs to the condition of *this* question and
        // must not survive a change of selection as leftover text.
        key={question.id}
        condition={condition}
        // `null` when `condition.questionId` names no earlier, eligible
        // question — deleted, retyped (Konzept no. 24 mints a new id) or dragged
        // behind this one. It used to fall back to the *first* source, which
        // showed a healthy-looking condition over a question the store does
        // not point at; `ConditionFields` renders the gap instead.
        source={source ?? null}
        sources={sources}
        problem={mark?.problem ?? null}
        patch={patch}
      />
    );

  return (
    <div className="props__condition">
      <div className="props__condition-head">
        <span className="props__label" id={captionId}>
          Bedingte Anzeige
        </span>
        <span className="switch">
          <input
            className="switch__input"
            id={toggleId}
            type="checkbox"
            role="switch"
            checked={enabled}
            // Disabled rather than a no-op click: there is nothing to switch
            // *on to* before a beantwortbare Frage exists above this one, and
            // a control that visibly refuses is the reason (a review measured
            // what a control that silently does nothing costs).
            disabled={!enabled && firstSource === undefined}
            aria-labelledby={captionId}
            onChange={(event) => {
              if (!event.target.checked) {
                // The absent key, not `null` beside it — see the field's own
                // doc comment in `packages/shared/src/form-schema.ts` for why
                // there is exactly one spelling of "keine Bedingung".
                patch({ visibleIf: undefined });
                return;
              }
              if (firstSource === undefined) {
                return;
              }
              patch({
                visibleIf: { questionId: firstSource.id, operator: 'filled' },
              });
            }}
          />
          <span className="switch__track" aria-hidden="true">
            <span className="switch__knob" />
          </span>
        </span>
      </div>

      {body}
    </div>
  );
}

/**
 * Quellfrage, Operator and — where the operator needs one — Wert.
 *
 * Split out of {@link ConditionEditor} for the same reason `TypeSpecific`'s
 * branches are their own functions: each of the three selects narrows what
 * the next one may show, and folding all of it into one body would make that
 * chain harder to follow, not easier.
 *
 * ## The local draft, and why the store is sometimes *not* written
 *
 * `questionConditionSchema` has no partial member, so „ist gleich" with
 * nothing to compare against cannot be stored — and, since the
 * conditional-visibility review, cannot be faked either:
 * `conditionValueSchema` trims before `min(1)`, so the single space this
 * panel used to write is refused. It was never a harmless
 * placeholder. „ist gleich ␣" over a Freitextquelle held *while the source was
 * unanswered* (`equalsReading` trims both sides) — the exact opposite of what
 * the panel showed — and „enthält ␣" matched every answer containing a space,
 * while the cursor sat behind that space so the next keystroke produced
 * `' Auto'`, which matches nothing.
 *
 * What is shown therefore comes from `draft` while an edit is unfinished, and
 * the document keeps the last condition that parsed. The state is visible
 * rather than silent: the hint under the box says the condition is not stored
 * yet. Nothing here can commit an incomplete condition, which is what makes
 * the publish lock the second line of defence it was meant to be instead
 * of the first.
 */
function ConditionFields({
  condition,
  source,
  sources,
  problem,
  patch,
}: {
  readonly condition: QuestionCondition;
  /** `null` while the stored condition points at no earlier, eligible question. */
  readonly source: Question | null;
  readonly sources: readonly Question[];
  /** The publish refusal for this condition, or `null` while it resolves. */
  readonly problem: string | null;
  readonly patch: Patch;
}): ReactElement {
  const sourceFieldId = useId();
  const operatorFieldId = useId();
  const [draft, setDraft] = useState<ConditionDraft | null>(null);

  const operators: readonly ConditionOperator[] =
    source === null ? [] : conditionOperatorsFor(source.type);
  const choices = source === null ? null : sourceChoiceOptions(source);
  /**
   * Whether the Wert box takes a number — read off the **operator table**
   * rather than listed a second time (`source.type === 'number' || … 'rating'`
   * was that second list). A new numeric type is added to
   * `CONDITION_OPERATORS_BY_SOURCE` in `packages/shared/src/form-schema.ts` by
   * anyone who gives it „größer als", and it gets the right keyboard here
   * without this file being touched.
   */
  const isNumeric = operators.includes('greaterThan');

  /** What the operator select shows — the draft's pick before the store's. */
  const operator = draft?.operator ?? condition.operator;
  const needsValue = operator !== 'filled' && operator !== 'empty';
  const value = draft?.value ?? conditionValue(condition);
  /** The operator is stored but the source type does not offer it (caught by the publish lock). */
  const operatorUnavailable =
    source !== null && !operators.includes(condition.operator);

  /** Applies a value box edit — or holds it back while it cannot be stored. */
  const commitValue = (raw: string): void => {
    setDraft({ operator, value: raw });
    if (source === null || operator === 'filled' || operator === 'empty') {
      return;
    }
    if (operator === 'greaterThan' || operator === 'lessThan') {
      const parsed = Number(raw);
      // An empty box is `Number('') === 0` — finite, and stored as a real „0"
      // nobody typed. Mid-edit texts („-", „1e") are the same case.
      if (raw.trim() === '' || !Number.isFinite(parsed)) {
        return;
      }
      patch({ visibleIf: { questionId: source.id, operator, value: parsed } });
      return;
    }
    if (raw.trim() === '') {
      return;
    }
    patch({ visibleIf: { questionId: source.id, operator, value: raw } });
  };

  return (
    <div className="props__condition-body">
      <p className="props__note">Diese Frage nur anzeigen, wenn:</p>

      {problem === null ? null : (
        <p className="props__issue" role="alert">
          {problem}
        </p>
      )}

      <label className="props__field">
        <span className="props__label" id={sourceFieldId}>
          Frage
        </span>
        <select
          aria-labelledby={sourceFieldId}
          // The empty string, not a stand-in source: an unresolvable condition
          // has no question to select, and showing the first one instead was
          // the review's finding — the panel then described a condition the
          // document does not carry.
          value={source?.id ?? ''}
          onChange={(event) => {
            const next = sources.find(
              (candidate) => candidate.id === event.target.value,
            );
            if (next === undefined) {
              return;
            }
            // A change of source can leave the current operator unavailable
            // (a Zahl's „größer als" over a newly chosen Freitext-Quelle,
            // say) — reset to the one operator every type offers rather than
            // write a combination `conditionOperatorsFor` would not hand out
            // in the first place.
            setDraft(null);
            patch({
              visibleIf: { questionId: next.id, operator: 'filled' },
            });
          }}
        >
          {source === null ? (
            // Disabled, so it cannot be chosen again once it is left — it
            // names a state, not a source.
            <option value="" disabled>
              (Quellfrage nicht auflösbar)
            </option>
          ) : null}
          {sources.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.label}
            </option>
          ))}
        </select>
      </label>

      {sources.length > 0 ? null : (
        <p className="props__note">
          Füge zuerst eine weitere (beantwortbare) Frage davor hinzu, auf die
          sich die Bedingung beziehen kann.
        </p>
      )}

      {source === null ? null : (
        <label className="props__field">
          <span className="props__label" id={operatorFieldId}>
            Bedingung
          </span>
          <select
            aria-labelledby={operatorFieldId}
            value={operator}
            onChange={(event) => {
              const picked = event.target.value as ConditionOperator;
              const next = nextCondition(source, picked, condition);
              if (next === null) {
                // Nothing to compare against yet — the operator is shown, the
                // document keeps what it had, and the hint below says so.
                setDraft({ operator: picked, value: '' });
                return;
              }
              setDraft(null);
              patch({ visibleIf: next });
            }}
          >
            {operatorUnavailable ? (
              // The stored operator, named rather than left as a `<select>`
              // with no selected entry: „Organisation bietet diesen Vergleich nicht
              // an" is the sentence in the alert above, and this is the
              // control it is about.
              <option value={condition.operator} disabled>
                {OPERATOR_LABELS[condition.operator]} (für diesen Fragetyp nicht
                verfügbar)
              </option>
            ) : null}
            {operators.map((entry) => (
              <option key={entry} value={entry}>
                {OPERATOR_LABELS[entry]}
              </option>
            ))}
          </select>
        </label>
      )}

      {source === null || operatorUnavailable || !needsValue ? null : (
        <>
          {choices !== null ? (
            <label className="props__field">
              <span className="props__label">Vergleichswert</span>
              <select
                value={value}
                onChange={(event) => {
                  commitValue(event.target.value);
                }}
              >
                {choices.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="props__field">
              <span className="props__label">Vergleichswert</span>
              {/*
                The box's `type` follows the **source** (a numeric keyboard
                makes sense for „Zahl ist gleich 3" too), but what gets written
                follows the **operator**: `questionConditionSchema` types
                `greaterThan`/`lessThan` as a number and every other
                value-carrying operator as a string, whatever the source is —
                `equalsReading` does its own `Number(value)` conversion for a
                numeric source. Branching on `isNumeric` in `commitValue`, like
                the box's `type` does, would write a number into an `equals`
                condition, which does not parse.
              */}
              <input
                type={isNumeric ? 'number' : 'text'}
                value={value}
                placeholder="Vergleichswert"
                onChange={(event) => {
                  commitValue(event.target.value);
                }}
              />
            </label>
          )}

          {storable(operator, value) ? null : (
            <p className="props__note" role="status">
              Die Bedingung wird erst gespeichert, wenn hier ein Vergleichswert
              steht.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * An operator picked and a value typed, before either can be stored.
 *
 * Local to the panel on purpose: it is the *unfinished* half of an edit, and
 * the document may only ever hold conditions that parse.
 */
interface ConditionDraft {
  readonly operator: ConditionOperator;
  /** Raw text of the box — untrimmed; `conditionValueSchema` decides. */
  readonly value: string;
}

/** The stored comparison value as text — `''` for the two operators without one. */
function conditionValue(condition: QuestionCondition): string {
  switch (condition.operator) {
    case 'filled':
    case 'empty':
      return '';
    case 'greaterThan':
    case 'lessThan':
      return String(condition.value);
    case 'equals':
    case 'notEquals':
    case 'contains':
      return condition.value;
  }
}

/** Whether what is on screen is a comparison the schema would accept. */
function storable(operator: ConditionOperator, value: string): boolean {
  if (operator === 'filled' || operator === 'empty') {
    return true;
  }
  if (operator === 'greaterThan' || operator === 'lessThan') {
    return value.trim() !== '' && Number.isFinite(Number(value));
  }
  return value.trim() !== '';
}

/**
 * The condition a picked **operator** settles into — or `null` when there is
 * nothing to compare against yet.
 *
 * A value-carrying previous condition keeps its value across an operator
 * change among `equals`/`notEquals`/`contains` (switching from „ist gleich
 * Bahn" to „ist nicht" should not forget „Bahn"), and a source with a picklist
 * starts at its first entry — both are complete the instant they are chosen.
 *
 * `null` is the remaining case: the very first switch away from
 * `filled`/`empty` on a Freitextquelle, where the only honest value is the one
 * the editor has not typed yet. It used to be a single space — see
 * {@link ConditionFields} for what that condition actually meant, and why
 * `conditionValueSchema` now refuses it outright.
 */
function nextCondition(
  source: Question,
  operator: ConditionOperator,
  previous: QuestionCondition,
): QuestionCondition | null {
  if (operator === 'filled' || operator === 'empty') {
    return { questionId: source.id, operator };
  }
  if (operator === 'greaterThan' || operator === 'lessThan') {
    const carried =
      previous.operator === 'greaterThan' || previous.operator === 'lessThan'
        ? previous.value
        : 0;
    return { questionId: source.id, operator, value: carried };
  }
  const choices = sourceChoiceOptions(source);
  const carried =
    previous.operator === 'equals' ||
    previous.operator === 'notEquals' ||
    previous.operator === 'contains'
      ? previous.value
      : undefined;
  const value = carried ?? choices?.[0]?.value;
  return value === undefined
    ? null
    : { questionId: source.id, operator, value };
}

/**
 * A list of captioned entries an editor can rename, reorder and remove —
 * a Matrix's rows, its scale, and the option list of a Tabelle „Liste" column.
 *
 * One component for all three because they are the same list: `{ value, label
 * }` pairs whose **value stays put while the label is edited**. That is not a
 * detail — a stored answer refers to the value and so does the export column
 * key, so renaming „Sehr gut" must not orphan the answers already given
 * (`questionOptionSchema`).
 *
 * **Reordering happens with ↑/↓**, and Konzept no. 9's „▲/▼ entfallen
 * vollständig" does not reach into this panel: it names the
 * **page list** and the **question cards** — the two surfaces that have a drag
 * handle — and replaces those buttons with pointer-drag, whose keyboard path is
 * the handle itself (no. 11). Neither exists here: an entry in
 * a 300-px settings panel has no handle, so a gesture would be the one control
 * on this page a keyboard cannot reach, and the buttons *are* the keyboard path
 * rather than a second one beside it.
 */
function LabelledListEditor({
  caption,
  addLabel,
  newItemLabel,
  valuePrefix,
  items,
  onChange,
}: {
  readonly caption: string;
  /** Caption of the button that appends an entry. */
  readonly addLabel: string;
  /**
   * Caption a freshly added entry starts with.
   *
   * Stated rather than derived from {@link addLabel}: „+ Eintrag" would become
   * „Neue Eintrag" under any string surgery, and a German UI text that is
   * *computed* is a German UI text nobody proof-reads.
   */
  readonly newItemLabel: string;
  /** Stem of a generated value — `zeile`, `spalte`, `option`. */
  readonly valuePrefix: string;
  readonly items: readonly QuestionOption[];
  readonly onChange: (items: QuestionOption[]) => void;
}): ReactElement {
  const move = (index: number, direction: -1 | 1): void => {
    const next = moveEntry(items, index, direction);
    if (next !== null) {
      onChange(next);
    }
  };

  return (
    <div className="props__options">
      <span className="props__label">{caption}</span>

      <ul className="props__option-list">
        {items.map((item, index) => (
          <li key={item.value} className="props__option">
            <CaptionInput
              value={item.label}
              ariaLabel={`${caption} ${String(index + 1)}`}
              onCommit={(label) => {
                onChange(
                  items.map((candidate) =>
                    candidate.value === item.value
                      ? { ...candidate, label }
                      : candidate,
                  ),
                );
              }}
            />
            <MoveButtons
              caption={`${caption} ${String(index + 1)}`}
              index={index}
              count={items.length}
              onMove={(direction) => {
                move(index, direction);
              }}
            />
            <button
              type="button"
              aria-label={`${caption} ${String(index + 1)} entfernen`}
              // The last entry cannot go: an empty list does not parse, and a
              // Matrix without a single statement is not a question.
              disabled={items.length <= 1}
              onClick={() => {
                onChange(
                  items.filter((candidate) => candidate.value !== item.value),
                );
              }}
            >
              <span aria-hidden="true">×</span>
            </button>
          </li>
        ))}
      </ul>

      <button
        type="button"
        className="props__small"
        onClick={() => {
          onChange([
            ...items,
            { value: freshValue(items, valuePrefix), label: newItemLabel },
          ]);
        }}
      >
        {addLabel}
      </button>
    </div>
  );
}

/**
 * The Veranstaltungen of a question, with Termin and Obergrenze.
 *
 * Not folded into {@link LabelledListEditor}: that one edits `{ value, label }`
 * pairs, and every one of the four fields here would have to become an optional
 * prop with a branch around it. The two lists look alike and are not the same
 * list — this one carries a bound that decides whether somebody gets a seat.
 *
 * **The `key` stays put while the Bezeichnung is edited**, exactly as an
 * option's `value` does and for the reason stated at `eventEntrySchema`: the
 * stored answer, the export column *and* the `event_registration` rows are keyed
 * by it, so renaming „Sommerfest" must not orphan the registrations already
 * taken.
 *
 * **„Ohne Grenze" is a checkbox, not an empty number box.** Emptying a bound is
 * how „unbegrenzt" and „ich habe die Zahl noch nicht eingetragen" become one
 * state, and the difference matters: the first hands out seats without counting,
 * the second is a form the editor is not finished with. Ticking it clears the
 * number; unticking it puts a plausible one back rather than leaving the field
 * in a state the schema refuses.
 *
 * **Reordering happens with ↑/↓** ({@link MoveButtons}), exactly as
 * {@link LabelledListEditor} and {@link TableColumnsEditor} do it — the third
 * list in this panel built the same way, which is the justification rather than
 * an aside: the order of the entries is the order the fill-in view and the
 * export show them in, so it is an editable property, and this panel has one
 * answer to "how do you reorder here" instead of three.
 *
 * Konzept no. 9 („▲/▼-Buttons entfallen **vollständig**", 2026-07-27) does not
 * reach in here: it names the page list and the question cards, the two surfaces
 * that carry a drag handle, and no. 11 makes that handle's keyboard operation
 * the replacement path. An entry in a 300-px settings panel has neither — so a
 * pointer gesture would be the one control on this page with no keyboard path at
 * all, and these buttons *are* that path.
 *
 * **Renaming does not move anything**: the buttons swap entries, they do not
 * rewrite them, so the `key` — and with it every registration already taken —
 * travels with its entry.
 */
function EventListEditor({
  events,
  patch,
}: {
  readonly events: readonly EventEntry[];
  readonly patch: Patch;
}): ReactElement {
  const hintId = useId();

  const replace = (index: number, entry: EventEntry): void => {
    patch({
      events: events.map((candidate, position) =>
        position === index ? entry : candidate,
      ),
    });
  };

  const move = (index: number, direction: -1 | 1): void => {
    const next = moveEntry(events, index, direction);
    if (next !== null) {
      patch({ events: next });
    }
  };

  return (
    <div className="props__options">
      <span className="props__label">Veranstaltungen &amp; Limits</span>

      <ul className="props__option-list">
        {events.map((entry, index) => {
          const position = String(index + 1);

          return (
            <li key={entry.key} className="props__event">
              {/*
                The Kachel's head: the Bezeichnung, and the three buttons that
                act on the entry as a whole. They sit above the settings rather
                than after them so that „was tut das mit dieser Veranstaltung"
                is answered next to its name, not underneath six controls.
              */}
              <div className="props__event-head">
                <CaptionInput
                  className="props__event-label"
                  value={entry.label}
                  ariaLabel={`Veranstaltung ${position}`}
                  onCommit={(label) => {
                    replace(index, { ...entry, label });
                  }}
                />
                <MoveButtons
                  caption={`Veranstaltung ${position}`}
                  index={index}
                  count={events.length}
                  onMove={(direction) => {
                    move(index, direction);
                  }}
                />
                <button
                  type="button"
                  aria-label={`Veranstaltung ${position} entfernen`}
                  // The last one cannot go: an empty list does not parse, and a
                  // Veranstaltungsfrage without a Veranstaltung is not a
                  // question.
                  disabled={events.length <= 1}
                  onClick={() => {
                    patch({
                      events: events.filter(
                        (_, candidate) => candidate !== index,
                      ),
                    });
                  }}
                >
                  <span aria-hidden="true">×</span>
                </button>
              </div>

              <input
                value={entry.when ?? ''}
                placeholder="Termin, z. B. Fr, 19:00"
                aria-label={`Veranstaltung ${position}: Termin`}
                onChange={(event) => {
                  // `''` back to `null`, so „kein Termin" keeps one spelling —
                  // the rule `pageSchema.description` states for the same
                  // reason.
                  replace(index, {
                    ...entry,
                    when: event.target.value === '' ? null : event.target.value,
                  });
                }}
              />

              <div className="props__event-row">
                {/*
                  The captions carry the entry's number in their accessible
                  name, not only on screen: six Veranstaltungen mean six boxes
                  reading „ohne Grenze", and a screen reader announcing the
                  fourth of them says nothing about which Veranstaltung it
                  belongs to. The visible text stays the first half of the name
                  (WCAG „Label in Name").
                */}
                <label className="props__inline">
                  <input
                    type="checkbox"
                    checked={entry.capacity === null}
                    aria-label={`Veranstaltung ${position}: ohne Grenze`}
                    onChange={(event) => {
                      replace(index, {
                        ...entry,
                        // Back to the default of a fresh Veranstaltung
                        // (`createQuestion`), never to an empty box the schema
                        // refuses.
                        capacity: event.target.checked ? null : 50,
                      });
                    }}
                  />
                  <span>ohne Grenze</span>
                </label>
                {entry.capacity === null ? null : (
                  <input
                    type="number"
                    min={1}
                    max={EVENT_CAPACITY_MAX}
                    value={entry.capacity}
                    aria-label={`Veranstaltung ${position}: Obergrenze`}
                    onChange={(event) => {
                      const raw = Number(event.target.value);
                      if (!Number.isFinite(raw)) {
                        return;
                      }
                      // Clamped like every other numeric setting in this panel:
                      // the schema still guards the write, and a box that
                      // visibly refuses the number just typed reads as broken.
                      replace(index, {
                        ...entry,
                        capacity: Math.min(
                          EVENT_CAPACITY_MAX,
                          Math.max(1, Math.round(raw)),
                        ),
                      });
                    }}
                  />
                )}
              </div>

              {/*
                „Restplätze anzeigen" — the editor's
                decision, per Veranstaltung, and off by default: the number is a
                statement about an organisation's registration state and it leaves the house
                without a session. „Ausgebucht" shows either way, which is why
                there is no switch for that.

                The hint underneath says what the switch does *not* do, because
                an editor who leaves it off would otherwise reasonably read
                it as „the number is secret". It is not: anyone willing to spend
                refused submissions can bisect it, measured in
                `event-limit.spec.ts` and reasoned in `docs/kb/07-oeffentliche-pfade.md`.
                What the switch buys is that the figure does not travel to
                everyone who merely opens the page.
              */}
              <label className="props__inline">
                <input
                  type="checkbox"
                  checked={entry.showRemaining}
                  aria-describedby={`${hintId}-${position}`}
                  aria-label={`Veranstaltung ${position}: Restplätze anzeigen`}
                  onChange={(event) => {
                    replace(index, {
                      ...entry,
                      showRemaining: event.target.checked,
                    });
                  }}
                />
                <span>Restplätze anzeigen</span>
              </label>
              <p className="props__note" id={`${hintId}-${position}`}>
                Aus heißt: niemand sieht die Zahl beim Öffnen des Formulars —
                „Ausgebucht" bleibt sichtbar. Geheim ist sie damit nicht: wer
                Anmeldungen absendet und abgewiesen wird, kann sie eingrenzen.
              </p>
            </li>
          );
        })}
      </ul>

      <button
        type="button"
        className="props__small"
        onClick={() => {
          patch({
            events: [
              ...events,
              {
                key: freshValue(
                  events.map((entry) => ({ value: entry.key })),
                  'veranstaltung',
                ),
                label: 'Neue Veranstaltung',
                when: null,
                capacity: 50,
                showRemaining: false,
              },
            ],
          });
        }}
      >
        + Veranstaltung
      </button>
    </div>
  );
}

/**
 * A value nothing in `taken` claims — counted past the existing ones rather
 * than derived from the list length, the same trap the option editor
 * documents: remove entry 2 of three and `length + 1` produces a value that is
 * still there, the schema refuses the whole patch, and the button looks broken
 * for a reason nothing on screen explains.
 */
function freshValue(
  items: readonly { value: string }[],
  prefix: string,
): string {
  const taken = new Set(items.map((entry) => entry.value));
  let next = items.length + 1;
  while (taken.has(`${prefix}-${String(next)}`)) {
    next += 1;
  }
  return `${prefix}-${String(next)}`;
}

/**
 * `items` with the entry at `index` moved one place, or `null` when the move
 * would leave the list.
 *
 * Written once for all three lists in this panel — the Matrix/Liste entries, the
 * Veranstaltungen and the Spalten. They differ in what an entry *is* and in
 * nothing else: the entry is lifted out and put back one position over, which is
 * what keeps its identity (`value`, `key`) with it rather than rewriting the
 * captions of two neighbours. Renaming and moving stay separate operations, and
 * that is what stops a reorder from orphaning stored answers, export columns and
 * `event_registration` rows.
 *
 * `null` rather than an unchanged copy, so a caller cannot hand a no-op patch to
 * the document: an identical `events` array is still a *new* array, and the
 * editor would mark the form dirty for a button press that moved nothing. Not
 * reachable through the buttons — they are disabled at both ends — which is
 * precisely why it must not be a silent copy.
 */
function moveEntry<T>(
  items: readonly T[],
  index: number,
  direction: -1 | 1,
): T[] | null {
  const target = index + direction;
  if (target < 0 || target >= items.length) {
    return null;
  }
  const next = [...items];
  const [moved] = next.splice(index, 1);
  if (moved === undefined) {
    return null;
  }
  next.splice(target, 0, moved);
  return next;
}

/**
 * The ↑/↓ pair that reorders one entry of a list in this panel.
 *
 * `caption` is the entry's **whole** name including its number („Veranstaltung
 * 2", „Spalte 1", „Zeile 3"), because that is what the accessible name of the
 * button is built from: „nach oben" alone says nothing about what moves, and six
 * Veranstaltungen would otherwise give a screen reader twelve identical buttons.
 */
function MoveButtons({
  caption,
  index,
  count,
  onMove,
}: {
  readonly caption: string;
  readonly index: number;
  /** How many entries the list has — the last one cannot move down. */
  readonly count: number;
  readonly onMove: (direction: -1 | 1) => void;
}): ReactElement {
  return (
    <>
      <button
        type="button"
        aria-label={`${caption} nach oben`}
        disabled={index === 0}
        onClick={() => {
          onMove(-1);
        }}
      >
        <span aria-hidden="true">↑</span>
      </button>
      <button
        type="button"
        aria-label={`${caption} nach unten`}
        disabled={index === count - 1}
        onClick={() => {
          onMove(1);
        }}
      >
        <span aria-hidden="true">↓</span>
      </button>
    </>
  );
}

/** The German caption of each Zelltyp — the handoff's own four words. */
const TABLE_CELL_TYPE_LABELS: Readonly<Record<TableCellType, string>> = {
  text: 'Text',
  number: 'Zahl',
  select: 'Liste',
  checkbox: 'Haken',
};

/**
 * The columns of a table: caption, Zelltyp, and — for a „Liste" — the
 * options its cells choose from.
 *
 * The option list is part of the column rather than an afterthought because
 * the schema makes it so (`tableColumnSchema` is a discriminated union): a
 * Liste column cannot exist without options, which is exactly the defect the
 * handoff has, where a dropdown cell offers a single „—" and stores nothing.
 */
function TableColumnsEditor({
  question,
  patch,
}: {
  readonly question: Extract<Question, { type: 'table' }>;
  readonly patch: Patch;
}): ReactElement {
  const columns = question.columns;

  const replace = (index: number, column: TableColumn): void => {
    patch({
      columns: columns.map((candidate, position) =>
        position === index ? column : candidate,
      ),
    });
  };

  const move = (index: number, direction: -1 | 1): void => {
    const next = moveEntry(columns, index, direction);
    if (next !== null) {
      patch({ columns: next });
    }
  };

  return (
    <div className="props__options">
      <span className="props__label">Spalten</span>

      <ul className="props__option-list">
        {columns.map((column, index) => (
          <li key={column.key} className="props__table-column">
            <div className="props__option">
              <CaptionInput
                value={column.label}
                ariaLabel={`Spalte ${String(index + 1)}`}
                onCommit={(label) => {
                  replace(index, { ...column, label });
                }}
              />
              <select
                aria-label={`Spalte ${String(index + 1)}: Art`}
                value={column.type}
                onChange={(event) => {
                  const type = event.target.value as TableCellType;
                  if (type === column.type) {
                    return;
                  }
                  // Rebuilt from `key` and `label` rather than spread over the
                  // old column: a Liste carries an option list the other three
                  // types must not keep, and a spread would leave it in the
                  // document where nothing reads it — and where it would come
                  // back the moment somebody switched the type again.
                  replace(
                    index,
                    type === 'select'
                      ? {
                          key: column.key,
                          label: column.label,
                          type,
                          options: starterOptions(),
                        }
                      : { key: column.key, label: column.label, type },
                  );
                }}
              >
                {Object.entries(TABLE_CELL_TYPE_LABELS).map(
                  ([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ),
                )}
              </select>
              <MoveButtons
                caption={`Spalte ${String(index + 1)}`}
                index={index}
                count={columns.length}
                onMove={(direction) => {
                  move(index, direction);
                }}
              />
              <button
                type="button"
                aria-label={`Spalte ${String(index + 1)} entfernen`}
                disabled={columns.length <= 1}
                onClick={() => {
                  patch({
                    columns: columns.filter(
                      (_, position) => position !== index,
                    ),
                  });
                }}
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>

            {column.type === 'select' ? (
              <LabelledListEditor
                caption={`Spalte ${String(index + 1)}: Einträge`}
                addLabel="+ Eintrag"
                newItemLabel="Neuer Eintrag"
                valuePrefix="option"
                items={column.options}
                onChange={(options) => {
                  replace(index, { ...column, options });
                }}
              />
            ) : null}
          </li>
        ))}
      </ul>

      <button
        type="button"
        className="props__small"
        onClick={() => {
          patch({
            columns: [
              ...columns,
              {
                key: freshValue(
                  columns.map((entry) => ({ value: entry.key })),
                  'spalte',
                ),
                label: 'Neue Spalte',
                type: 'text',
              },
            ],
          });
        }}
      >
        + Spalte
      </button>
    </div>
  );
}

/**
 * „Zeilen ergänzbar" and its Obergrenze — the requirement, Konzept no. 76.
 *
 * **One switch and one number, because the schema has one field.** `addRows`
 * is an object rather than a boolean beside a number precisely so that
 * „ergänzbar ohne Grenze" and „Grenze, aber nicht ergänzbar" have no spelling
 * (`tableRowGrowthSchema`); this panel keeps that true by never rendering the
 * Obergrenze without the switch and never writing one without the other.
 *
 * **Turning the switch off removes the key**, which is why this is the one
 * place in the panel that writes a whole question ({@link Replace}). A
 * `patch({ addRows: undefined })` would leave the key present, and „nicht
 * ergänzbar" would have two spellings — one of which is never used.
 *
 * **The default of a fresh Obergrenze is {@link TABLE_ROWS_MAX}**, not
 * `rows`: an editor who ticks „ergänzbar" is asking for room, and a ceiling
 * that starts *at the floor* would be a switch that provably changes nothing
 * („+ Zeile" would never appear). It is the highest number the document may
 * carry anyway, so the tick alone can never produce a form the schema
 * refuses; lowering it is one edit.
 */
function TableRowGrowth({
  question,
  patch,
  replace,
  announce,
}: {
  readonly question: Extract<Question, { type: 'table' }>;
  readonly patch: Patch;
  readonly replace: Replace;
  /** The panel's live region — see {@link switchMessage}. */
  readonly announce: Announce;
}): ReactElement {
  const { addRows, rows } = question;

  return (
    <>
      <label className="props__check">
        <input
          type="checkbox"
          checked={addRows !== undefined}
          onChange={(event) => {
            if (event.target.checked) {
              patch({ addRows: { maxRows: TABLE_ROWS_MAX } });
              // The announcement names the Obergrenze the tick starts with —
              // not because it would be new here (the field below shows it),
              // but because „ergänzbar" without a number leaves open how far.
              announce(
                switchMessage(
                  'Zeilen ergänzbar',
                  true,
                  `Beim Ausfüllen gibt es „+ Zeile“, höchstens ${String(TABLE_ROWS_MAX)} Zeilen.`,
                ),
              );
              return;
            }
            const next = { ...question };
            delete next.addRows;
            replace(next);
            announce(
              switchMessage(
                'Zeilen ergänzbar',
                false,
                `Die Tabelle bleibt bei ${String(rows)} ${rows === 1 ? 'Zeile' : 'Zeilen'}.`,
              ),
            );
          }}
        />
        <span>Zeilen ergänzbar</span>
      </label>

      {addRows === undefined ? null : (
        <TableRowLimitField
          maxRows={addRows.maxRows}
          rows={rows}
          patch={patch}
        />
      )}
    </>
  );
}

/**
 * The Obergrenze of a growing table — **at least the Startzeilen, at most
 * {@link TABLE_ROWS_MAX}**, and it counts *all* rows rather than the added
 * ones (`tableRowGrowthSchema`, `tableRowLimit`).
 *
 * Staged in a local `draft` for the reason `RatingMaxField` above is: typing
 * „12" over a „3" passes through „1", and a box that clamped every keystroke
 * back into range would swallow the second digit. The `key={question.id}` on
 * `TypeSpecific` (`QuestionProperties`) remounts this field with the question,
 * so the draft cannot survive as leftover text from a different table —
 * **measured** on
 * two tables with the same Obergrenze in `table-row-growth.test.tsx`, which
 * is the only arrangement in which the `shown !== maxRows` adjustment below
 * does not cover the leak up.
 */
function TableRowLimitField({
  maxRows,
  rows,
  patch,
}: {
  readonly maxRows: number;
  /** The floor — a ceiling below the Startzeilen is a document the schema refuses. */
  readonly rows: number;
  readonly patch: Patch;
}): ReactElement {
  const [draft, setDraft] = useState(String(maxRows));
  const [shown, setShown] = useState(maxRows);
  if (shown !== maxRows) {
    // The Obergrenze moved **without this box being typed in**: raising the
    // Startzeilen past it carries it up (see the Startzeilen branch). React's
    // own answer to „a prop changed and derived state has to follow" is to
    // adjust during render; a `key` would remount the input and take the
    // caret with it mid-edit.
    setShown(maxRows);
    setDraft(String(maxRows));
  }
  const inRange = (value: number): boolean =>
    Number.isFinite(value) && value >= rows && value <= TABLE_ROWS_MAX;

  return (
    <Field
      label="Obergrenze"
      note={`Wie viele Zeilen eine Antwort höchstens haben darf, Startzeilen mitgezählt — mindestens ${String(rows)}, höchstens ${String(TABLE_ROWS_MAX)}. Der Server weist mehr ab, nicht nur die Ausfüllansicht.`}
    >
      {(field) => (
        <input
          {...field}
          type="number"
          min={rows}
          max={TABLE_ROWS_MAX}
          value={draft}
          onChange={(event) => {
            const raw = event.target.value;
            setDraft(raw);
            if (raw === '' || !inRange(Number(raw))) {
              // Incomplete, not yet wrong — nothing is committed until the
              // draft is a number this question may actually carry.
              return;
            }
            patch({ addRows: { maxRows: Math.round(Number(raw)) } });
          }}
          onBlur={() => {
            if (draft === '' || !inRange(Number(draft))) {
              setDraft(String(maxRows));
            }
          }}
        />
      )}
    </Field>
  );
}

/**
 * „Maximale Sterne" of a Bewertung — **2 to 10, never absent** (unlike
 * `NumberPair` below: `question.max` has no `null`, the schema requires an
 * integer in range).
 *
 * A review finding: the box used to be controlled straight off
 * `question.max`, converting on every keystroke with `Number(event.target.
 * value)`. Clearing the box made that call `Number('')`, which is `0` —
 * **finite** — so the very next line clamped it straight back to `2` before
 * a second digit could ever be typed; retyping „10" over an existing „5" was
 * not possible at all. Staged in local `draft` state instead: the input
 * shows whatever was typed, `patch` — and with it `question.max` — is only
 * called once the draft is a **complete, in-range** number, and leaving the
 * box in an unusable state resets the draft to the last valid value rather
 * than to a guess. The `key={question.id}` on `TypeSpecific`
 * (`QuestionProperties`) is what keeps this correct across a change of
 * *question* — the draft would otherwise survive a selection change as
 * leftover text from a different Bewertung.
 */
function RatingMaxField({
  max,
  patch,
}: {
  readonly max: number;
  readonly patch: Patch;
}): ReactElement {
  const [draft, setDraft] = useState(String(max));

  return (
    <Field label="Maximale Sterne" note="2 bis 10 Sterne, Vorgabe 5 (Handoff).">
      {(field) => (
        <input
          {...field}
          type="number"
          min={2}
          max={10}
          value={draft}
          onChange={(event) => {
            const raw = event.target.value;
            setDraft(raw);
            if (raw === '') {
              // Left empty on purpose, mid-edit — nothing to commit yet, and
              // nothing to clamp: the previous valid `max` stays the stored
              // value until either a real number lands or the field is left.
              return;
            }
            const parsed = Number(raw);
            // Out of range is not yet wrong, only incomplete — typing „10"
            // passes through „1" first, and clamping that to `2` on the way
            // would make „10" untypeable. Committed only once it already
            // fits, same as the handoff's own clamp but without a keystroke
            // that overwrites the next one.
            if (!Number.isFinite(parsed) || parsed < 2 || parsed > 10) {
              return;
            }
            patch({ max: Math.round(parsed) });
          }}
          onBlur={() => {
            // Leaving the field on an empty or out-of-range draft snaps back
            // to the last value that was actually committed — the box must
            // not stay stuck on text that was never a valid Bewertung.
            const parsed = Number(draft);
            if (
              draft === '' ||
              !Number.isFinite(parsed) ||
              parsed < 2 ||
              parsed > 10
            ) {
              setDraft(String(max));
            }
          }}
        />
      )}
    </Field>
  );
}

/**
 * A min/max pair over nullable numbers.
 *
 * Empty input means `null` ("no bound"), not `0` — a Mindestlänge of zero and
 * no Mindestlänge look identical in a form and mean the same thing, but only
 * `null` says so in the document, and only `null` lets the field be cleared
 * again.
 */
function NumberPair({
  min,
  max,
  patch,
  minKey,
  maxKey,
  minLabel,
  maxLabel,
}: {
  /** Current values, read by the caller — which knows the variant. */
  readonly min: number | null;
  readonly max: number | null;
  readonly patch: Patch;
  readonly minKey: string;
  readonly maxKey: string;
  readonly minLabel: string;
  readonly maxLabel: string;
}): ReactElement {
  const onChange = (key: string, raw: string): void => {
    if (raw === '') {
      patch({ [key]: null });
      return;
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      return;
    }
    patch({ [key]: value });
  };

  return (
    <div className="props__row">
      <label className="props__field">
        <span className="props__label">{minLabel}</span>
        <input
          type="number"
          value={min ?? ''}
          onChange={(event) => {
            onChange(minKey, event.target.value);
          }}
        />
      </label>
      <label className="props__field">
        <span className="props__label">{maxLabel}</span>
        <input
          type="number"
          value={max ?? ''}
          onChange={(event) => {
            onChange(maxKey, event.target.value);
          }}
        />
      </label>
    </div>
  );
}

/** Options of a choice question, plus the Massenimport of the handoff. */
function OptionsEditor({
  question,
  patch,
  announce,
}: {
  readonly question: Extract<
    Question,
    { type: 'select' | 'radio' | 'checkbox' }
  >;
  readonly patch: Patch;
  /** The panel's live region — see {@link switchMessage}. */
  readonly announce: Announce;
}): ReactElement {
  const [bulk, setBulk] = useState('');
  const [bulkOpen, setBulkOpen] = useState(false);

  const setOptions = (options: QuestionOption[]): void => {
    patch({ options });
  };

  return (
    <div className="props__options">
      <span className="props__label">Optionen</span>

      <ul className="props__option-list">
        {question.options.map((option, index) => (
          <li key={option.value} className="props__option">
            <CaptionInput
              value={option.label}
              ariaLabel={`Option ${String(index + 1)}`}
              onCommit={(label) => {
                setOptions(
                  question.options.map((candidate) =>
                    candidate.value === option.value
                      ? { ...candidate, label }
                      : candidate,
                  ),
                );
              }}
            />
            <button
              type="button"
              aria-label={`Option ${String(index + 1)} entfernen`}
              // The last option cannot go: an empty list does not parse, and a
              // dropdown with nothing in it is not a question.
              disabled={question.options.length <= 1}
              onClick={() => {
                setOptions(
                  question.options.filter(
                    (candidate) => candidate.value !== option.value,
                  ),
                );
              }}
            >
              <span aria-hidden="true">×</span>
            </button>
          </li>
        ))}
      </ul>

      <button
        type="button"
        className="props__small"
        onClick={() => {
          // Counted past the existing values, not from the list length: delete
          // option 2 of three and `length + 1` produces `option-3`, which is
          // still there — the schema then refuses the whole patch and the
          // button looks broken for a reason nothing on screen explains.
          const taken = new Set(question.options.map((entry) => entry.value));
          let next = question.options.length + 1;
          while (taken.has(`option-${String(next)}`)) {
            next += 1;
          }
          setOptions([
            ...question.options,
            {
              value: `option-${String(next)}`,
              label: `Option ${String(next)}`,
            },
          ]);
        }}
      >
        + Option
      </button>

      <button
        type="button"
        className="props__small"
        aria-expanded={bulkOpen}
        onClick={() => {
          setBulkOpen((open) => !open);
        }}
      >
        Massenimport
      </button>

      {bulkOpen ? (
        <div className="props__bulk">
          <Field label="Eine Option je Zeile">
            {(field) => (
              <textarea
                {...field}
                rows={5}
                value={bulk}
                placeholder={'Aktiv\nInaktiv\nwert = Beschriftung'}
                onChange={(event) => {
                  setBulk(event.target.value);
                }}
              />
            )}
          </Field>
          <button
            type="button"
            className="props__small"
            onClick={() => {
              const parsed = parseOptionBulkImport(bulk);
              if (parsed.length === 0) {
                return;
              }
              setOptions(parsed);
              setBulk('');
              setBulkOpen(false);
            }}
          >
            Übernehmen
          </button>
          <p className="props__note">
            Ersetzt die Liste. „wert = Beschriftung“ behält den Wert, auf den
            bestehende Antworten zeigen.
          </p>
        </div>
      ) : null}

      <label className="props__check">
        <input
          type="checkbox"
          checked={question.allowOther}
          onChange={(event) => {
            const on = event.target.checked;
            patch({
              allowOther: on,
              // The label only exists while the choice does — the schema ties
              // the two together, so they are set together.
              otherLabel: on ? 'Sonstiges' : null,
            });
            announce(
              switchMessage(
                '„Sonstiges“ mit Freitext anbieten',
                on,
                on
                  ? 'Die Auswahl bekommt einen zusätzlichen Eintrag mit Freitextfeld.'
                  : 'Die Auswahl zeigt nur die eingetragenen Optionen.',
              ),
            );
          }}
        />
        <span>„Sonstiges“ mit Freitext anbieten</span>
      </label>

      {question.allowOther ? (
        <label className="props__field">
          <span className="props__label">Beschriftung für „Sonstiges“</span>
          <input
            value={question.otherLabel ?? ''}
            placeholder="Sonstiges"
            onChange={(event) => {
              // `''` back to `null` — the same „kein Wert" as with the
              // Hinweistext above. The field is `nullable()`, so the empty box
              // is a real state and not an intermediate step: without a caption
              // of its own the form shows „Sonstiges" (`otherLabelOf`).
              // Without the mapping `min(1)` failed at the last character and
              // the box could not be emptied.
              patch({
                otherLabel:
                  event.target.value === '' ? null : event.target.value,
              });
            }}
          />
        </label>
      ) : null}
    </div>
  );
}
