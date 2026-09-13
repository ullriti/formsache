import type { ReactElement, ReactNode } from 'react';
import { useId } from 'react';

/**
 * The handful of controls the four settings sections are built from
 * (handoff).
 *
 * Three rules shape them, and all three come from the section being *lockable*:
 *
 * 1. **Every control is a real form control.** The lock is a
 *    `<fieldset disabled>` around the section body, and `disabled` only reaches
 *    real controls — the prototype's `pointer-events: none` on a `<div>` looks
 *    the same and stops nothing a keyboard or a script does.
 * 2. **Every control has a label element.** Not a placeholder, not an adjacent
 *    `<div>`: a disabled control still has to announce what it is.
 * 3. **A validation message belongs to its field**, addressed through
 *    `aria-describedby`, so „„Schließt am" muss nach „Öffnet am" liegen" is
 *    read out where it applies rather than as a sentence at the top of a page
 *    with twenty settings on it.
 */

/** A field-level message from a 400, keyed by settings key. */
export type SettingIssues = Readonly<Record<string, string>>;

export interface ToggleSettingProps {
  readonly title: string;
  readonly description?: string | undefined;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  /**
   * A limitation of the setting itself, shown **whether the switch is on or
   * off** .
   *
   * Distinct from `description`, which says what the setting does, and from
   * `children`, which appear only once it is on. What belongs here is the
   * sentence an editor has to read *before* deciding — „das Zeitlimit lässt
   * sich durch Neuladen zurücksetzen" is not a detail of the configured value,
   * it is the reach of the promise. Putting it in `children` would hide it from
   * exactly the person about to switch the thing on.
   */
  readonly note?: string | undefined;
  /** Revealed underneath while the switch is on — the prototype's `extra`. */
  readonly children?: ReactNode;
}

/**
 * A switch with its title and explanation — the row the handoff repeats
 * throughout.
 *
 * `role="switch"` on a checkbox rather than a styled `<button>`: it is a
 * two-state control that belongs to a label, and the checkbox is the element
 * the browser already knows how to disable, focus and announce.
 */
export function ToggleSetting({
  title,
  description,
  checked,
  onChange,
  note,
  children,
}: ToggleSettingProps): ReactElement {
  const id = useId();
  const descriptionId = `${id}-description`;
  const noteId = `${id}-note`;
  // Both are read out with the control; the note is not decoration.
  const describedBy =
    [
      description === undefined ? '' : descriptionId,
      note === undefined ? '' : noteId,
    ]
      .filter((part) => part !== '')
      .join(' ') || undefined;

  return (
    <div className="setting">
      <div className="setting__head">
        <div className="setting__text">
          <label className="setting__title" htmlFor={id}>
            {title}
          </label>
          {description === undefined ? null : (
            <p className="setting__description" id={descriptionId}>
              {description}
            </p>
          )}
        </div>

        <span className="switch">
          <input
            className="switch__input"
            id={id}
            type="checkbox"
            role="switch"
            checked={checked}
            aria-describedby={describedBy}
            onChange={(event) => {
              onChange(event.target.checked);
            }}
          />
          <span className="switch__track" aria-hidden="true">
            <span className="switch__knob" />
          </span>
        </span>
      </div>

      {note === undefined ? null : (
        <p className="setting__note" id={noteId}>
          {note}
        </p>
      )}

      {/*
        The detail fields appear only while the switch is on, exactly as in the
        prototype. Absent rather than disabled: a deadline field next to a
        deadline that is switched off invites the reading that it still counts.
      */}
      {checked && children !== undefined ? (
        <div className="setting__extra">{children}</div>
      ) : null}
    </div>
  );
}

export interface TextSettingProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly issue?: string | undefined;
  readonly placeholder?: string | undefined;
  /** `text` for ordinary input, `url` and `password-word` style monospace. */
  readonly variant?: 'text' | 'mono';
  readonly multiline?: boolean;
  /**
   * The kind of the field — default `text`.
   *
   * `password` is the kind that was missing here for a long time: the fields
   * for the SMTP password, the KI key and the password of the initial setup
   * were therefore each a handwritten `<input>` next to this building block —
   * three times the same labelling, `aria-describedby` and locking work, and
   * three times the opportunity to forget one of them. All three carry the
   * same promise: the field is **always empty**, the stored value never stands
   * in it, and what stands next to it is the placeholder „hinterlegt" or
   * „nicht hinterlegt".
   *
   * `email` is not a check but a keyboard: on a telephone it decides whether an
   * `@` is reachable without switching. The address is checked by the schema,
   * here as everywhere.
   */
  readonly type?: 'text' | 'email' | 'password';
  /**
   * What the password manager of the browser may offer.
   *
   * Without a value given: `off` for a `password` field and nothing for the
   * others. A field that carries a secret of the **installation** wants no
   * suggestion — nothing that belongs to this person is stored here. The
   * password of the initial setup is the counter-case and therefore names
   * `new-password` explicitly: there an access is set that the manager is
   * supposed to remember.
   */
  readonly autoComplete?: string;
  /**
   * The upper bound the server enforces anyway — **here, where the typing
   * happens**.
   *
   * The same reasoning as {@link NumberSettingProps.max}: the server stays the
   * truth, and this is not a second check but the same one at the place where
   * it can still change something. Without it only the *saving* fails — and a
   * `PUT` that carries a whole document then takes everything else along into
   * the 400 (ADR-0028 no. 7).
   *
   * ⚠️ `maxLength` counts **UTF-16 units**, exactly like Zod's `.max()`, so
   * both count the same. The body limiter counts bytes on the other hand; this
   * value therefore keeps the field bound and replaces no statement about the
   * size of the payload.
   */
  readonly maxLength?: number;
  /**
   * A sentence that belongs **to the field**, not beside it.
   *
   * Rendered as a paragraph and referenced from `aria-describedby`, the same
   * shape {@link ToggleSetting}'s `note` has — so a screen reader reads it when
   * the field takes focus. A `title` would reach the mouse and nothing else,
   * which is not good enough for a sentence that says what a setting gives up.
   */
  readonly note?: string | undefined;
  /** Marks the note as a warning, for a setting that gives a guarantee up. */
  readonly noteTone?: 'plain' | 'warning';
}

export function TextSetting({
  label,
  value,
  onChange,
  issue,
  placeholder,
  variant = 'text',
  multiline = false,
  type = 'text',
  autoComplete,
  maxLength,
  note,
  noteTone = 'plain',
}: TextSettingProps): ReactElement {
  const id = useId();
  const issueId = `${id}-issue`;
  const noteId = `${id}-note`;
  // Both, in reading order: what the field means before what is wrong with it.
  const describedBy =
    [
      note === undefined ? undefined : noteId,
      issue === undefined ? undefined : issueId,
    ]
      .filter((value_) => value_ !== undefined)
      .join(' ') || undefined;
  const className =
    variant === 'mono'
      ? 'setting__control setting__control--mono'
      : 'setting__control';

  return (
    <div className="setting__field">
      <label className="setting__label" htmlFor={id}>
        {label}
      </label>
      {multiline ? (
        <textarea
          className={`${className} setting__control--multiline`}
          id={id}
          value={value}
          placeholder={placeholder}
          maxLength={maxLength}
          aria-describedby={describedBy}
          aria-invalid={issue === undefined ? undefined : true}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      ) : (
        <input
          className={className}
          id={id}
          type={type}
          // „off" as the default for a secret, so that a password manager
          // does not offer what is never stored here — overridable for the one
          // case in which an access really is set.
          autoComplete={
            autoComplete ?? (type === 'password' ? 'off' : undefined)
          }
          value={value}
          placeholder={placeholder}
          maxLength={maxLength}
          aria-describedby={describedBy}
          aria-invalid={issue === undefined ? undefined : true}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      )}
      {note === undefined ? null : (
        <p
          className={
            noteTone === 'warning'
              ? 'setting__note setting__note--warning'
              : 'setting__note'
          }
          id={noteId}
        >
          {note}
        </p>
      )}
      <FieldIssue id={issueId} message={issue} />
    </div>
  );
}

export interface NumberSettingProps {
  readonly label: string;
  readonly value: number;
  readonly unit: string;
  readonly min: number;
  /**
   * The upper bound the server enforces, shown as the field's `max` — absent
   * for fields with no ceiling of their own (an editor guessing at one is
   * `min` without `max`, not the reverse).
   */
  readonly max?: number | undefined;
  readonly onChange: (value: number) => void;
  readonly issue?: string | undefined;
  /**
   * A limitation of the field itself, shown regardless of its current value —
   * the same role `note` plays on `ToggleSetting`. What belongs here is the
   * sentence an editor needs *before* typing a number, such as what the upper
   * bound itself means (the requirement: „auf den Höchstwert setzen" is how
   * *Versandbudget* spells „kein Limit", not a separate switch).
   */
  readonly hint?: string | undefined;
}

/**
 * A bounded number with its unit beside it.
 *
 * The value is passed through as typed, including a zero or an empty box: the
 * schema in `@formsache/shared` owns the bounds, and clamping here would make the
 * field silently disagree with the number that gets stored. What an out-of-range
 * value produces is a 400 naming this field, and that message lands right here.
 */
export function NumberSetting({
  label,
  value,
  unit,
  min,
  max,
  onChange,
  issue,
  hint,
}: NumberSettingProps): ReactElement {
  const id = useId();
  const issueId = `${id}-issue`;
  const hintId = `${id}-hint`;
  const describedBy =
    [issue === undefined ? '' : issueId, hint === undefined ? '' : hintId]
      .filter((part) => part !== '')
      .join(' ') || undefined;

  return (
    <div className="setting__field">
      <label className="setting__label" htmlFor={id}>
        {label}
      </label>
      <span className="setting__number">
        <input
          className="setting__control setting__control--number"
          id={id}
          type="number"
          min={min}
          max={max}
          value={String(value)}
          aria-describedby={describedBy}
          aria-invalid={issue === undefined ? undefined : true}
          onChange={(event) => {
            onChange(Number(event.target.value));
          }}
        />
        <span className="setting__unit">{unit}</span>
      </span>
      {hint === undefined ? null : (
        <p className="setting__note" id={hintId}>
          {hint}
        </p>
      )}
      <FieldIssue id={issueId} message={issue} />
    </div>
  );
}

export interface DeadlineSettingProps {
  readonly label: string;
  /** `YYYY-MM-DDTHH:mm` in `Europe/Berlin` — see `berlin-time.ts`. */
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly issue?: string | undefined;
  /** „MEZ" or „MESZ", shown so nobody has to guess the zone. */
  readonly zone: string;
}

export function DeadlineSetting({
  label,
  value,
  onChange,
  issue,
  zone,
}: DeadlineSettingProps): ReactElement {
  const id = useId();
  const issueId = `${id}-issue`;
  const zoneId = `${id}-zone`;

  return (
    <div className="setting__field">
      <label className="setting__label" htmlFor={id}>
        {label}
      </label>
      <input
        className="setting__control"
        id={id}
        type="datetime-local"
        value={value}
        aria-describedby={issue === undefined ? zoneId : `${zoneId} ${issueId}`}
        aria-invalid={issue === undefined ? undefined : true}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      {/*
        The zone next to the value, not only in a heading: a deadline whose zone
        one has to guess becomes contested between two organisations, and the changeover
        falls into the middle of the semester.
      */}
      <p className="setting__zone" id={zoneId}>
        Zeitzone {zone} (Deutschland)
      </p>
      <FieldIssue id={issueId} message={issue} />
    </div>
  );
}

export interface SelectSettingOption {
  readonly value: string;
  readonly label: string;
}

export interface SelectSettingProps {
  readonly label: string;
  readonly value: string;
  readonly options: readonly SelectSettingOption[];
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
  readonly issue?: string | undefined;
  /** A sentence that belongs **to the field** — as with {@link TextSetting}. */
  readonly note?: string | undefined;
}

/**
 * A choice out of a fixed list.
 *
 * The building block that this set of controls did not have so far, and that is
 * why the KI tab built three of them itself — with its own classes, its own
 * labelling pattern and without the property the whole family hangs on: being a
 * real form control that a `<fieldset disabled>` really locks.
 *
 * **The options carry their labels short.** A `select` measures itself by its
 * longest option and not by its box — the long explanation therefore belongs in
 * {@link SelectSettingProps.note}, not in an `<option>`. That is literally the
 * finding `system-ai-settings.css` records.
 */
export function SelectSetting({
  label,
  value,
  options,
  onChange,
  disabled = false,
  issue,
  note,
}: SelectSettingProps): ReactElement {
  const id = useId();
  const issueId = `${id}-issue`;
  const noteId = `${id}-note`;
  const describedBy =
    [note === undefined ? '' : noteId, issue === undefined ? '' : issueId]
      .filter((part) => part !== '')
      .join(' ') || undefined;

  return (
    <div className="setting__field">
      <label className="setting__label" htmlFor={id}>
        {label}
      </label>
      <select
        className="setting__control setting__control--select"
        id={id}
        value={value}
        disabled={disabled}
        aria-describedby={describedBy}
        aria-invalid={issue === undefined ? undefined : true}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {note === undefined ? null : (
        <p className="setting__note" id={noteId}>
          {note}
        </p>
      )}
      <FieldIssue id={issueId} message={issue} />
    </div>
  );
}

function FieldIssue({
  id,
  message,
}: {
  readonly id: string;
  readonly message: string | undefined;
}): ReactElement | null {
  if (message === undefined) {
    return null;
  }
  return (
    <p className="setting__issue" id={id}>
      {message}
    </p>
  );
}

/** The hairline the prototype puts between two rows of a section. */
export function SettingDivider(): ReactElement {
  return <div className="setting__divider" role="presentation" />;
}
