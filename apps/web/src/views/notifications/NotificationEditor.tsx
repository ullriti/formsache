import type { ReactElement } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import {
  NOTIFICATION_NAME_MAX,
  PLACEHOLDER_PLACE_LABELS,
  acceptsTemplate,
  effectiveReplyTo,
  toDisplayForm,
  toStorageForm,
  type EffectiveReplyTo,
  type MailFormat,
  type MailTemplateContext,
  type NotificationTemplate,
  type NotificationTriggerInput,
  type PlaceholderPlace,
  type Question,
  type ReplyToLevel,
} from '@formsache/shared';

import { insertToken } from './insert-token';
import { NotificationPreview } from './NotificationPreview';
import { PlaceholderChips } from './PlaceholderChips';
import {
  applyTemplate,
  draftRecipients,
  reachesSubmitter,
  type NotificationDraft,
} from './notification-draft';

/**
 * The editor on the right of the Benachrichtigungen view (Handoff).
 *
 * Five things in here are decisions rather than markup, and all five are
 * written down where somebody would otherwise "fix" them:
 *
 * 1. **„Bei Zwischenspeichern" is absent, not disabled.** Two boxes are
 *    offered — „Bei Absendung" and „Bei Bearbeitung" — because a review
 *    added the second trigger; a third box, greyed out, for the trigger it
 *    does not have would promise a function this application does not have — the
 *    same mistake the requirement already paid for. Both boxes together are
 *    never allowed empty (`draftProblems`, `notification-draft.ts`): a
 *    control that refused to uncheck its last box would not say *why*, so
 *    the refusal is a save-blocking message instead.
 * 1a. **Choosing a question recipient defaults „Bei Bearbeitung" on** — see
 *    the chip's own `onClick` below. The edit link is an
 *    **owner capability**: once a participant has it, a mail on every
 *    subsequent change is the only way they learn the link has leaked, so
 *    picking a question recipient is exactly the moment that risk starts to
 *    exist. It stays a **default**, not a lock — the box unchecks like any
 *    other, because a purely internal notification („nur bei Neuanmeldung
 *    ans Büro") is a legitimate choice too. It is applied **once, as a
 *    reaction to the click that adds the recipient** — never recomputed from
 *    `questionRecipients` on every render, which would snap the box back on
 *    the instant somebody unticks it and make „lässt sich abwählen" a lie.
 * 2. **There is no second gate any more** (finding 24, 2026-08-14). Until then
 *    a switch *Nach dem Absenden →
 *    Bestätigung an Teilnehmer senden* stood in the form settings, and this file had to explain
 *    in three places that a set-up, active notification nevertheless does not
 *    go out. Exactly that was the symptom: whoever sets up a notification to the
 *    filling-in person here has decided that it is sent.
 *    Whoever does not want it switches it off here (`active`) or deletes it.
 *    **There is no separate „An die ausfüllende Person senden" box any more**:
 *    it never created a recipient, only marked one, and a
 *    ticked box without a chosen chip was never anything but a warning that
 *    could not fire and a mail that could not go out. Choosing a question chip
 *    *is* the whole statement now (`reachesSubmitter`) — see the warning below.
 * 3. **Subject and body are shown in the *display* form, edited as display
 *    form, and converted back exactly at the two seams — never in between**
 *    . `draft.subject`/`draft.body` are the **storage**
 *    form the whole rest of the application agrees on (`{{frage:<id>}}` —
 *    see `notification-draft.ts`); this component is the only place that ever
 *    shows `{{frage:<caption>}}` instead. `displaySubject`/`displayBody` below
 *    hold exactly what is in the two fields, set directly from what was typed
 *    or from a chip — **never rewritten** by a round trip through
 *    `toDisplayForm`/`toStorageForm` while the user is mid-edit, because doing
 *    that on every keystroke is precisely the risk a caption with a space or
 *    an umlaut runs into (see the caveat in `mail-placeholder-display.ts`) and
 *    because it would fight the caret. The conversion instead runs at the two
 *    moments the field's own text is not the source of truth: **loading**
 *    a stored (storage-form) draft into local state, and **feeding** anything
 *    that needs storage form — the parent's `draft` (so `toWriteRequest` never
 *    has to convert) and `NotificationPreview` (which cannot resolve a
 *    caption). An overlay drawn over the textarea, or `contenteditable` with
 *    token chips, were both considered and rejected: an overlay cannot track
 *    the caret once the text reflows to a different width, and
 *    `contenteditable` reopens paste, undo, IME composition and mobile
 *    selection as this component's own problem instead of the browser's.
 * 4. **The templates come from the server, and the row is shown only while the
 *    text is empty** (`acceptsTemplate`, `@formsache/shared`). They used to be a
 *    constant this file imported; they are an installation-wide
 *    setting the superadmin edits, so what is offered here is
 *    what the notification list route delivered. A button that replaces what somebody
 *    has typed is a data-loss button, and „ich wollte nur sehen, was da
 *    drinsteht" is exactly how it would be pressed. Asked about the **draft**
 *    body rather than the stored one, so unsaved text counts too — that is the
 *    text nobody could get back. Applying one is a copy and nothing else: no
 *    link to the template is kept, and the result is ordinary, editable text
 *    (`applyTemplate`, `notification-draft.ts`). **The row's visibility gates
 *    only the body**, so `applyTemplate` itself checks every field it would
 *    write against its `emptyDraft()` value and leaves anything already typed
 *    alone (a review finding of the 2026-07-28 review) — the field order above (Name →
 *    Auslöser → Format → Empfänger → Betreff → Text) means a name and a
 *    subject are routinely typed before the row ever appears.
 */

/**
 * Which of the two template fields a chip would write into.
 *
 * The two the editor can type in, out of the three places a placeholder may
 * sit — so the wording comes from `PLACEHOLDER_PLACE_LABELS` rather than from a
 * third copy of „Betreff / Text".
 */
type TemplateField = Extract<PlaceholderPlace, 'subject' | 'body'>;

/** The two boxes offered — `'save'` is absent, not disabled (module note 1). */
const TRIGGER_OPTIONS = [
  ['submit', 'Bei Absendung'],
  ['edit', 'Bei Bearbeitung'],
] as const satisfies readonly (readonly [NotificationTriggerInput, string])[];

export interface NotificationEditorProps {
  readonly draft: NotificationDraft;
  readonly onChange: (patch: Partial<NotificationDraft>) => void;
  /** Every question of the draft definition — the chips. */
  readonly questions: readonly Question[];
  /** The subset that can supply an address; only these may be recipients. */
  readonly addressQuestions: readonly Question[];
  /**
   * What the installation offers to start from.
   *
   * Empty while the list is still loading **and** when the installation decided
   * to offer nothing — the two look the same here on purpose: in both cases
   * there is nothing to press, and a spinner over a picker somebody may not
   * even want would be noise. Applying one copies its text and ends the
   * relationship (`applyTemplate`).
   */
  readonly templates: readonly NotificationTemplate[];
  readonly context: MailTemplateContext;
  readonly problems: readonly string[];
  /** The server's sentence behind the last failed save, or null. */
  readonly saveError: string | null;
  readonly isSaving: boolean;
  readonly isDeleting: boolean;
  readonly isDirty: boolean;
  /** Absent for a notification that has not been created yet. */
  readonly onDelete: (() => void) | null;
  readonly onSave: () => void;
  /**
   * The two **inherited** levels of the reply address — organisation, then system —,
   * raw and in the order in which they apply (the requirement).
   *
   * **Not the finished result of the server**, and that is the change from
   * the review of package 0-A. The server computes `effectiveReplyTo` for the
   * **saved** row; below the field, however, stands a question about the
   * *draft* — „was gilt, wenn ich das so speichere?" —, and for a
   * notification not created yet there was previously no answer at all, although
   * there is one: the inherited levels are after all fixed.
   *
   * The topmost level is therefore put in front of them by {@link NotificationEditor}
   * itself, calling `effectiveReplyTo` from `@formsache/shared` — **the same** function,
   * the same precedence, the same gate at which a set but unusable
   * value falls through. No second chain comes into being; nor is anything
   * recomputed that the server would already have answered.
   */
  readonly inheritedReplyTo: readonly ReplyToLevel[];
}

/** Where the effective value comes from, in the language of the surface. */
const REPLY_TO_ORIGIN_LABELS = {
  notification: 'in dieser Benachrichtigung gesetzt',
  tenant: 'Vorgabe der Organisation',
  system: 'Vorgabe des Systems',
} as const satisfies Record<NonNullable<EffectiveReplyTo['origin']>, string>;

/**
 * What stands below the field: **the address itself and why it applies.**
 *
 * The origin is part of the promise, not decoration (the requirement): an
 * address without it does not answer „warum diese?" — and exactly this question
 * produced the item. The fourth case is no failure but a statement:
 * if nothing is set on any level, the mail goes out without that header, and
 * an answer lands at the sender address (`effectiveReplyTo` in
 * `@formsache/shared` gives the reason why that does not become a guessed address).
 *
 * **Exactly one check, not two.** Until the review of package 0-A there stood here
 * `address === null || origin === null` — and the second part would have
 * *concealed* a real address without an origin („keine"), instead of letting it
 * stand out. The combination has not existed since: `effectiveReplyToSchema`
 * is a pair of alternatives, and the type narrows at `address === null`.
 */
function effectiveReplyToText(effective: EffectiveReplyTo): string {
  if (effective.address === null) {
    return 'keine – eine Antwort geht an die Absenderadresse.';
  }
  return `${effective.address} (${REPLY_TO_ORIGIN_LABELS[effective.origin]}).`;
}

export function NotificationEditor({
  draft,
  onChange,
  questions,
  addressQuestions,
  templates,
  context,
  problems,
  saveError,
  isSaving,
  isDeleting,
  isDirty,
  onDelete,
  onSave,
  inheritedReplyTo,
}: NotificationEditorProps): ReactElement {
  const fieldId = useId();
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  /**
   * What the two fields actually show — **display form**, see the module
   * comment (point 3). Lazily initialised from the incoming (storage-form)
   * draft, because the very first render is a „load" like any other.
   */
  const [displaySubject, setDisplaySubject] = useState(() =>
    toDisplayForm(draft.subject, questions),
  );
  const [displayBody, setDisplayBody] = useState(() =>
    toDisplayForm(draft.body, questions),
  );

  /**
   * The storage-form text this component itself last pushed to `onChange` —
   * how a genuine reload (a different notification selected, or the draft
   * that comes back after a save) is told apart from the echo of our own
   * edit. `onChange` writes into the parent's state and the new `draft` prop
   * comes back down on the next render; without this comparison that render
   * would look exactly like somebody else changing the draft under us, and
   * `displaySubject`/`displayBody` would be recomputed — and the caret lost —
   * on every keystroke, which is the one thing point 3 above rules out.
   *
   * **`useState`, not a ref.** React documents „adjust state while
   * rendering" for exactly this shape (compare-then-`setState`, each branch
   * running at most once per genuine reload), and it documents it with
   * state on purpose: a render React discards — a second render forced by
   * another state update before this one commits — throws away the queued
   * `setDisplaySubject` along with it, but a plain `useRef` mutation is not
   * undone the same way. The two would then disagree about which
   * notification is loaded, and the field would go on showing the
   * *previous* selection's text while `draft` already held the new one.
   */
  const [pushedSubject, setPushedSubject] = useState(draft.subject);
  const [pushedBody, setPushedBody] = useState(draft.body);

  if (draft.subject !== pushedSubject) {
    setPushedSubject(draft.subject);
    const reloaded = toDisplayForm(draft.subject, questions);
    if (reloaded !== displaySubject) {
      setDisplaySubject(reloaded);
    }
  }
  if (draft.body !== pushedBody) {
    setPushedBody(draft.body);
    const reloaded = toDisplayForm(draft.body, questions);
    if (reloaded !== displayBody) {
      setDisplayBody(reloaded);
    }
  }

  /**
   * Local display text out, storage form pushed to the parent — the one
   * function both the field's own `onChange` and `onInsert` go through, so
   * the two never disagree about which direction each holds.
   */
  const setField = (field: TemplateField, text: string): void => {
    const stored = toStorageForm(text, questions);
    if (field === 'subject') {
      setDisplaySubject(text);
      setPushedSubject(stored);
      onChange({ subject: stored });
    } else {
      setDisplayBody(text);
      setPushedBody(stored);
      onChange({ body: stored });
    }
  };

  /**
   * Which field a chip writes into — the one last focused, subject to start.
   *
   * Tracked rather than guessed: a chip row that always wrote into the body
   * would make the subject placeholders unreachable, and the subject is where
   * `{{formular}}` belongs.
   */
  const [target, setTarget] = useState<TemplateField>('subject');

  /**
   * The caret position to restore after the insertion has been rendered.
   *
   * React owns the value of both fields, so the DOM node is rewritten between
   * the click and the next paint and any `setSelectionRange` called during the
   * handler is undone. Applying it in an effect is the one ordering that
   * survives that — and it is deliberately *not* what `insert-token.test.ts`
   * proves: the arithmetic is tested on strings, this is the plumbing around
   * it.
   */
  const [caret, setCaret] = useState<{
    readonly field: TemplateField;
    readonly position: number;
  } | null>(null);

  useEffect(() => {
    if (caret === null) {
      return;
    }
    const element =
      caret.field === 'subject' ? subjectRef.current : bodyRef.current;
    element?.focus();
    element?.setSelectionRange(caret.position, caret.position);
    setCaret(null);
  }, [caret]);

  const onInsert = (rawToken: string): void => {
    const element = target === 'subject' ? subjectRef.current : bodyRef.current;
    const text = target === 'subject' ? displaySubject : displayBody;
    // A field that was never focused has no selection to read; „ans Ende" is
    // what the browser would do with the caret anyway.
    const selection = {
      start: element?.selectionStart ?? text.length,
      end: element?.selectionEnd ?? text.length,
    };

    // The chip hands over the storage-form token (`{{frage:<id>}}`, from
    // `PlaceholderChips`/`questionPlaceholderToken`); converted to display
    // form here, once, before it ever touches the field — a system
    // placeholder like `{{formularorganisation}}` passes through unchanged, since
    // nothing about it matches the question grammar.
    const token = toDisplayForm(rawToken, questions);
    const result = insertToken(text, selection, token);
    setField(target, result.text);
    setCaret({ field: target, position: result.cursor });
  };

  /**
   * Pours a delivered template into the draft (module note 4).
   *
   * The recipient is the one thing a template cannot carry — it names a
   * question of *this* form — so a participant template suggests one, and only
   * where the suggestion cannot be wrong: exactly one address question exists
   * and nothing has been chosen yet. With two of them, guessing would be the
   * `„erste E-Mail-Frage"` rule Konzept no. 30 threw out.
   */
  const applyTemplateToDraft = (template: NotificationTemplate): void => {
    const suggestion = addressQuestions[0];
    const suggested =
      template.toSubmitter &&
      addressQuestions.length === 1 &&
      suggestion !== undefined &&
      draft.questionRecipients.length === 0;

    const applied = applyTemplate(draft, template);
    // Same recipient set the patch below ends up with: the suggestion if this
    // click adds one, the draft's own otherwise — `applyTemplate` never
    // touches `questionRecipients` (module comment on it, `notification-draft.ts`).
    const questionRecipientCount = suggested
      ? 1
      : draft.questionRecipients.length;

    // Security default, module note 1a — pulled onto this path too (a review finding
    // of the 2026-07-28 review): `applyTemplate` overwrites `triggers` from
    // the template's own set, which would otherwise silently drop an „edit"
    // a prior chip click had defaulted on, and would leave the one template
    // that always reaches a participant (`toSubmitter`) without it. Still a
    // default, not a lock — `onToggleTrigger` unchecks it exactly as before.
    const triggers: readonly NotificationTriggerInput[] =
      questionRecipientCount > 0 && !applied.triggers.includes('edit')
        ? [...applied.triggers, 'edit']
        : applied.triggers;

    // The whole draft as the patch, rather than the five fields listed again:
    // everything `applyTemplate` did not touch is the value that is already
    // there, and a hand-copied list would fall one behind the day a template
    // carries a sixth field.
    onChange({
      ...applied,
      triggers,
      ...(suggested ? { questionRecipients: [suggestion.id] } : {}),
    });
  };

  /** Flips one box — an ordinary, symmetric toggle (module note 1). */
  const onToggleTrigger = (trigger: NotificationTriggerInput): void => {
    onChange({
      triggers: draft.triggers.includes(trigger)
        ? draft.triggers.filter((value) => value !== trigger)
        : [...draft.triggers, trigger],
    });
  };

  const recipients = draftRecipients(draft).recipients;
  const hasAddressQuestion = addressQuestions.length > 0;
  /**
   * Whether this notification would reach the participant — the chips are the
   * only route, and this is what the warning below asks.
   */
  const toParticipant = reachesSubmitter(draft);
  /**
   * **What applies if this draft is saved like this** (the requirement).
   *
   * The topmost level is the value *in the field*, not the saved one: the
   * label says „Wirksam", so it has to mean the present. Previously
   * the result of the server stood here, and whoever typed in a different address
   * went on reading the old one below it — the line claimed the present and showed
   * the past.
   *
   * A half-typed value (`buero@`) falls through the same check as an
   * unusably saved one and the line names the inherited address — which
   * is right: it cannot be saved anyway, `draftProblems` rejects
   * it and calls it by its name.
   */
  const effective = effectiveReplyTo([
    { origin: 'notification', value: draft.replyTo },
    ...inheritedReplyTo,
  ]);

  return (
    <section className="notifications__editor" aria-label="Benachrichtigung">
      {acceptsTemplate(draft.body) && templates.length > 0 ? (
        <div
          className="notifications__templates"
          role="group"
          aria-label="Vorlagen"
          data-testid="templates"
        >
          <p className="notifications__chips-hint">
            Mit einer Vorlage beginnen – Text und Auslöser lassen sich danach
            frei ändern.
          </p>
          <div className="notifications__chip-row">
            {templates.map((template) => (
              <button
                key={template.id}
                type="button"
                className="notifications__chip"
                data-testid={`template-${template.id}`}
                /*
                  The name is what the chip shows; when it is the right choice
                  is what the sentence adds — on the tooltip for a mouse and in
                  the accessible name for everyone else, the same split the
                  question chips use.
                */
                title={template.description}
                aria-label={`${template.name} – ${template.description}`}
                onClick={() => {
                  applyTemplateToDraft(template);
                }}
              >
                {template.name}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="notifications__field">
        <label className="notifications__label" htmlFor={`${fieldId}-name`}>
          Name
        </label>
        <input
          id={`${fieldId}-name`}
          className="notifications__input"
          value={draft.name}
          maxLength={NOTIFICATION_NAME_MAX}
          onChange={(event) => {
            onChange({ name: event.target.value });
          }}
        />
      </div>

      <div className="notifications__row">
        {/*
          Two checkboxes, not a select or a segmented control: both may be
          set at once, and „Bei Zwischenspeichern" stays absent rather than a
          disabled third option (module note 1).
        */}
        <fieldset
          className="notifications__field notifications__field--fieldset"
          data-testid="trigger"
        >
          <legend className="notifications__label">Auslöser</legend>
          <div className="notifications__radios">
            {TRIGGER_OPTIONS.map(([value, label]) => (
              <label key={value} className="notifications__radio">
                <input
                  type="checkbox"
                  data-testid={`trigger-${value}`}
                  checked={draft.triggers.includes(value)}
                  onChange={() => {
                    onToggleTrigger(value);
                  }}
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="notifications__field notifications__field--fieldset">
          <legend className="notifications__label">Format</legend>
          <div className="notifications__radios">
            {(
              [
                ['html', 'HTML'],
                ['text', 'Nur Text'],
              ] as const satisfies readonly (readonly [MailFormat, string])[]
            ).map(([value, label]) => (
              <label key={value} className="notifications__radio">
                <input
                  type="radio"
                  name={`${fieldId}-format`}
                  value={value}
                  checked={draft.format === value}
                  onChange={() => {
                    onChange({ format: value });
                  }}
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      <label className="notifications__switch">
        <input
          type="checkbox"
          checked={draft.active}
          onChange={(event) => {
            onChange({ active: event.target.checked });
          }}
        />
        Aktiv – nur aktive Benachrichtigungen werden versendet.
      </label>

      {/* --- recipients ------------------------------------------------- */}

      <fieldset className="notifications__field notifications__field--fieldset">
        <legend className="notifications__label">Empfänger</legend>

        {hasAddressQuestion ? null : (
          // No box to disable any more — without a chip to
          // choose, this hint is the whole story of why nothing here reaches
          // the participant.
          <p className="notifications__hint" data-testid="no-address-question">
            Nicht möglich: Dieses Formular hat keine E-Mail-Frage, aus der eine
            Adresse gelesen werden könnte. Zuerst im Builder eine Frage vom Typ
            „E-Mail" hinzufügen.
          </p>
        )}

        {hasAddressQuestion ? (
          <div className="notifications__field">
            <span className="notifications__sublabel">
              An die Antwort auf diese Frage
            </span>
            <div
              className="notifications__chip-row"
              role="group"
              aria-label="Fragen als Empfänger"
            >
              {addressQuestions.map((question) => {
                const chosen = draft.questionRecipients.includes(question.id);
                return (
                  <button
                    key={question.id}
                    type="button"
                    className={
                      chosen
                        ? 'notifications__chip notifications__chip--on'
                        : 'notifications__chip'
                    }
                    aria-pressed={chosen}
                    data-testid={`recipient-question-${question.id}`}
                    onClick={() => {
                      if (chosen) {
                        onChange({
                          questionRecipients: draft.questionRecipients.filter(
                            (id) => id !== question.id,
                          ),
                        });
                        return;
                      }
                      onChange({
                        questionRecipients: [
                          ...draft.questionRecipients,
                          question.id,
                        ],
                        // Security default, module note 1a: adding a question
                        // recipient defaults „Bei Bearbeitung" on, applied
                        // once as a reaction to *this* click — never derived
                        // from `questionRecipients` on every render, or the
                        // box could not be unticked afterwards.
                        triggers: draft.triggers.includes('edit')
                          ? draft.triggers
                          : [...draft.triggers, 'edit'],
                      });
                    }}
                  >
                    {question.label}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        <div className="notifications__field">
          <label
            className="notifications__sublabel"
            htmlFor={`${fieldId}-addresses`}
          >
            Weitere Adressen (mit Komma getrennt)
          </label>
          <input
            id={`${fieldId}-addresses`}
            className="notifications__input"
            value={draft.literalRecipients}
            placeholder="buero@example.de, vorsitz@example.de"
            onChange={(event) => {
              onChange({ literalRecipients: event.target.value });
            }}
          />
        </div>
      </fieldset>

      {/* --- Antwortadresse  ---------------------------------- */}

      <div className="notifications__field">
        <label className="notifications__label" htmlFor={`${fieldId}-reply-to`}>
          Antwortadresse
        </label>
        <input
          id={`${fieldId}-reply-to`}
          className="notifications__input"
          type="email"
          value={draft.replyTo}
          placeholder="Leer: Vorgabe der Organisation bzw. des Systems"
          // Both paragraphs below describe this field: the rule and —
          ///0.1 — the effective value. Whoever reaches the field with a
          // screen-reader view otherwise hears only the rule and does not learn the
          // address that answers exactly this question.
          aria-describedby={`${fieldId}-reply-to-hint ${fieldId}-reply-to-effective`}
          onChange={(event) => {
            onChange({ replyTo: event.target.value });
          }}
        />
        <p className="notifications__hint" id={`${fieldId}-reply-to-hint`}>
          Wohin eine Antwort auf diese Mail gehen soll. Leer lassen, damit die
          Vorgabe der Organisation gilt – und fehlt auch die, die des Systems.
          Ist nirgends eine gesetzt, trägt die Mail keine Antwortadresse und
          eine Antwort geht an die Absenderadresse.
        </p>
        {/*
          **The address itself, not the hint at it** (the requirement).
          The paragraph above explains the chain; it does not answer *which*
          address applies in the end — the two lower levels stand in rows that
          this view never sees. Earlier a test mail was the only way
          there.

          **Always there, also for „Neu".** Previously this paragraph hung on the
          read document of the saved row, and the *first* notification
          of a form had none — exactly there the effective address was
          still only to be learnt through a test mail, so exactly the state
          this requirement ends. The inherited levels are fixed, however,
          whether or not the row already exists.

          **And always the present.** The topmost level is the draft value,
          not the saved one (see `effective` above); „Nach dem Speichern
          neu bestimmt" therefore no longer stands here — it would be the
          excuse for the line lagging behind.
        */}
        <p
          className="notifications__hint"
          id={`${fieldId}-reply-to-effective`}
          data-testid="effective-reply-to"
        >
          Wirksam: {effectiveReplyToText(effective)}
        </p>
      </div>

      {/* --- template ---------------------------------------------------- */}

      <div className="notifications__field">
        <label className="notifications__label" htmlFor={`${fieldId}-subject`}>
          Betreff
        </label>
        <input
          id={`${fieldId}-subject`}
          ref={subjectRef}
          className="notifications__input"
          // Display form — see the module comment, point 3. What is typed
          // here is what stays on screen; the storage form is what
          // `setField` derives from it for everybody else.
          //
          // **No `maxLength` here on purpose.** `MAIL_SUBJECT_MAX` bounds the
          // *stored* subject, and a placeholder's stored form
          // (`{{frage:<uuid>}}`) is longer than its displayed caption — a
          // `maxLength` on this field would cap the wrong quantity, letting
          // a subject that looks short here already be too long once saved
          // . `draftProblems` checks the real, stored length and
          // blocks the save instead; see `notification-draft.ts`.
          value={displaySubject}
          onFocus={() => {
            setTarget('subject');
          }}
          onChange={(event) => {
            setField('subject', event.target.value);
          }}
        />
      </div>

      <div className="notifications__field">
        <label className="notifications__label" htmlFor={`${fieldId}-body`}>
          Text
        </label>
        <textarea
          id={`${fieldId}-body`}
          ref={bodyRef}
          className="notifications__textarea"
          rows={10}
          // No `maxLength` here either — same reasoning as the subject
          // field above, against `MAIL_BODY_MAX`.
          value={displayBody}
          onFocus={() => {
            setTarget('body');
          }}
          onChange={(event) => {
            setField('body', event.target.value);
          }}
        />
      </div>

      <PlaceholderChips
        questions={questions}
        onInsert={onInsert}
        targetLabel={PLACEHOLDER_PLACE_LABELS[target]}
      />

      <NotificationPreview
        // Storage form, converted back here — a preview cannot resolve
        // `{{frage:<caption>}}`, only `{{frage:<id>}}` (module comment,
        // point 3).
        subject={toStorageForm(displaySubject, questions)}
        body={toStorageForm(displayBody, questions)}
        format={draft.format}
        recipients={recipients}
        context={context}
        // The same question the warning asks, so the two cannot describe the
        // same notification differently.
        toSubmitter={toParticipant}
      />

      {problems.length > 0 ? (
        <ul className="notifications__problems" role="status">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : null}

      {saveError === null ? null : (
        <p className="notifications__alert" role="alert">
          {saveError}
        </p>
      )}

      <div className="notifications__actions">
        {onDelete === null ? null : (
          <button
            type="button"
            className="notifications__delete"
            disabled={isDeleting || isSaving}
            onClick={onDelete}
          >
            {isDeleting ? 'Wird gelöscht…' : '🗑 Löschen'}
          </button>
        )}
        <span className="notifications__save-state" role="status">
          {isSaving
            ? 'Wird gespeichert…'
            : isDirty
              ? 'Nicht gespeichert'
              : 'Gespeichert'}
        </span>
        <button
          type="button"
          className="notifications__save"
          disabled={isSaving || problems.length > 0 || !isDirty}
          onClick={onSave}
        >
          Speichern
        </button>
      </div>
    </section>
  );
}
