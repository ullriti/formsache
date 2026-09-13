import type { ReactElement, ReactNode } from 'react';

import type { SectionDefinition } from './SettingsSectionFields';

/**
 * How the switch names its two sides, and what the card says as long as
 * the inherited one is chosen.
 *
 * **One labelling, no longer two.** There was a parameter here, because
 * two pages had the switch and inherited from different levels: a
 * form from its organisation, an organisation from the default of the
 * application. The second one no longer has one (review finding 10) — under an
 * organisation lies no administration, but the shipped values, and
 * a switch for that decided nothing, but locked fields.
 */
const FORM_INHERITANCE_LABELS = {
  inherited: 'Tenant-Standard',
  hint:
    'Standardwert vom Tenant – gilt für alle Formulare. „Angepasst" wählen, ' +
    'um nur dieses Formular zu ändern.',
};

export interface SettingsSectionCardProps {
  readonly definition: SectionDefinition;
  /**
   * The switch „Tenant-Standard ⇄ Angepasst", or `undefined` on a
   * page under which nothing lies that it could inherit from — the
   * form defaults of an organisation (review finding 10).
   */
  readonly inheritance?:
    | {
        readonly overridden: boolean;
        readonly onChange: (overridden: boolean) => void;
      }
    | undefined;
  /**
   * Consequences of this section that the fields themselves do not show — one
   * paragraph each.
   *
   * Rendered whichever side of the switch the section is on, because the
   * consequence they exist for — see the access word in `SettingsView` — is
   * invisible both before and after it happens.
   *
   * A **list**, not one string: the system layer's *Zugriff & Sicherheit* owes
   * two unrelated sentences (how far a change reaches, and why there is no
   * access word here), and glueing them into one ⓘ paragraph invites reading
   * them as one thought.
   */
  readonly notices?: readonly string[] | undefined;
  readonly children: ReactNode;
}

/**
 * One settings section as a card (handoff): heading and hint on a tinted
 * header, the segmented switch „Tenant-Standard ↔ Angepasst" on the right, the
 * inherited hint underneath, the fields below.
 *
 * **The lock is a `<fieldset disabled>`, not an opacity.** That is the
 * difference to be proven by more than a screenshot: a
 * disabled fieldset takes every control inside it out of the tab order, out of
 * reach of a click and out of the form data, and it does so in the browser
 * rather than in a style rule that a `pointer-events: auto` in devtools
 * undoes. The visual dimming rides along on `:disabled`, so the two can never
 * disagree — the prototype's `pointer-events: none` on a `<div>` had them as
 * two independent decisions.
 *
 * The client additionally drops the values of a locked section before saving
 * (`writableValues`), and the server ignores them a third time. Three layers
 * for one rule is right here: only the innermost one is a boundary, and the
 * outer two are what keep the boundary from ever being tested by accident.
 */
export function SettingsSectionCard({
  definition,
  inheritance,
  notices,
  children,
}: SettingsSectionCardProps): ReactElement {
  const inherited = inheritance !== undefined && !inheritance.overridden;

  return (
    <section
      className="settings-card"
      aria-labelledby={`settings-card-${definition.key}`}
    >
      <header className="settings-card__head">
        <div className="settings-card__text">
          <h2
            className="settings-card__heading"
            id={`settings-card-${definition.key}`}
          >
            {definition.heading}
          </h2>
          <p className="settings-card__hint">{definition.hint}</p>
        </div>

        {inheritance === undefined ? null : (
          /*
            A radio group, not two buttons: the two options are the two states
            of one setting, and a screen reader should hear „2 von 2" rather
            than two unrelated controls. It looks like the handoff's segmented
            control all the same.
          */
          <div
            className="segmented"
            role="radiogroup"
            aria-label={`Vererbung: ${definition.heading}`}
          >
            <InheritanceOption
              section={definition.key}
              label={FORM_INHERITANCE_LABELS.inherited}
              selected={!inheritance.overridden}
              onSelect={() => {
                inheritance.onChange(false);
              }}
            />
            <InheritanceOption
              section={definition.key}
              label="Angepasst"
              selected={inheritance.overridden}
              onSelect={() => {
                inheritance.onChange(true);
              }}
            />
          </div>
        )}
      </header>

      {inherited ? (
        <p className="settings-card__inherited">
          <span aria-hidden="true">↳ </span>
          {FORM_INHERITANCE_LABELS.hint}
        </p>
      ) : null}

      {(notices ?? []).map((notice) => (
        <p className="settings-card__notice" key={notice}>
          <span aria-hidden="true">ⓘ </span>
          {notice}
        </p>
      ))}

      <fieldset className="settings-card__body" disabled={inherited}>
        {/*
          A `<legend>` is required for the fieldset to have an accessible name;
          it repeats the heading and is hidden visually, because the card
          already shows it.
        */}
        <legend className="visually-hidden">
          {inherited
            ? `${definition.heading} – ${FORM_INHERITANCE_LABELS.inherited}, gesperrt`
            : definition.heading}
        </legend>
        {children}
      </fieldset>
    </section>
  );
}

function InheritanceOption({
  section,
  label,
  selected,
  onSelect,
}: {
  readonly section: string;
  readonly label: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
}): ReactElement {
  return (
    <label
      className={
        selected
          ? 'segmented__option segmented__option--on'
          : 'segmented__option'
      }
    >
      <input
        className="segmented__input"
        type="radio"
        name={`inheritance-${section}`}
        checked={selected}
        onChange={onSelect}
      />
      {label}
    </label>
  );
}
