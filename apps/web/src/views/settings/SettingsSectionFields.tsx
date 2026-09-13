import type { ReactElement } from 'react';
import {
  MAIL_BUDGET_LIMIT_MAX,
  MAIL_BUDGET_WINDOW_MIN_MAX,
  toInstant,
  toLocalInput,
  zoneAbbreviation,
  type FormSettings,
  type PartialFormSettings,
  type SettingsSection,
  type TenantFormSettings,
} from '@formsache/shared';

import { ConfirmationPreview } from './ConfirmationPreview';
import { isWithheldPassword } from './settings-draft';
import {
  DeadlineSetting,
  NumberSetting,
  SettingDivider,
  TextSetting,
  ToggleSetting as ToggleRow,
  type SettingIssues,
} from './SettingsControls';

/**
 * The bodies of the four settings sections (handoff) — written **once** and
 * rendered by all three pages that show them: the settings of one form,
 * the organisation's standards and the system layer below them.
 *
 * The prototype does the same (`settingsSectionDefs(get, onEdit, …)`), and for
 * the same reason: the pages have to offer the same fields with the same
 * bounds, or „↳ Standardwert vom Tenant" points at a setting the standard
 * cannot express.
 *
 * ## One setting of the handoff is missing on purpose
 *
 * **„Nur eine Antwort pro Person" was dropped** by the client on 2026-07-27 and
 * does not exist anywhere: not in the schema, not here, not as a future
 * promise. Recorded in Konzept no. 12; the handoff still shows it,
 * and that gap is deliberate.
 *
 * **„Zwischenspeichern erlauben" (`allowSaveDraft`) is live** —
 * it used to be the other exception here, rendered nowhere while the schema
 * carried it invisibly. See the switch in `AccessFields` for what changed.
 */

/**
 * Which card is on screen — the four inherited sections **plus**
 * *Verfügbarkeit*, which is a card of the form's page and not a section of the
 * inheritance (ADR-0011, continuation 2026-08-14).
 *
 * The union rather than a fifth member of `SettingsSection`: a switch that
 * decides nothing would have to be stored, sent and explained on both pages,
 * and only one of the two pages has the card at all.
 */
export type SettingsCard = SettingsSection | 'avail';

export interface SectionDefinition {
  readonly key: SettingsCard;
  readonly heading: string;
  readonly hint: string;
}

/** *Verfügbarkeit* — only a form has it, and it has no inheritance switch. */
export const AVAILABILITY_DEFINITION: SectionDefinition = {
  key: 'avail',
  heading: 'Verfügbarkeit',
  hint: 'Wann und wie oft dieses Formular ausgefüllt werden kann.',
};

/**
 * The four cards **both** pages show, in the handoff's order.
 *
 * Typed to the narrower key, so a caller can hand `definition.key` straight to
 * the inheritance switch without asking whether this one has an inheritance.
 */
export const SECTION_DEFINITIONS: readonly (SectionDefinition & {
  readonly key: SettingsSection;
})[] = [
  {
    key: 'access',
    heading: 'Zugriff & Sicherheit',
    hint: 'Formulare sind öffentlich ausfüllbar – ohne Anmeldung. Optional zusätzlich per Passwort schützen.',
  },
  {
    key: 'confirm',
    heading: 'Nach dem Absenden',
    hint: 'Was Teilnehmer nach dem Absenden sehen.',
  },
  {
    key: 'display',
    heading: 'Darstellung',
    hint: 'Optische Hinweise während des Ausfüllens.',
  },
  {
    key: 'budget',
    heading: 'Versandbudget',
    hint: 'Deckelt, wie viele E-Mails dieses Formular in einer gleitenden Zeitspanne verschickt — Schutz vor Missbrauch, kein Ausfüll-Limit.',
  },
];

export interface SettingsSectionFieldsProps {
  readonly section: SettingsSection;
  /**
   * The values on screen — see `shownSettings()`.
   *
   * {@link TenantFormSettings} and not `FormSettings`: these four sections are
   * rendered on a form's page **and** on an organisation's, and only the first
   * of the two documents has *Verfügbarkeit*. A form's complete document is
   * assignable to it, so the narrower type costs the caller nothing and buys
   * the guarantee that no field below reaches for a key the other page has not
   * got.
   */
  readonly values: TenantFormSettings;
  readonly onChange: (patch: PartialFormSettings) => void;
  /** Server messages of the last failed save, keyed by settings key. */
  readonly issues: SettingIssues;
}

/**
 * What every section body needs.
 *
 * There used to be a second prop here, `carriesAccessWord`: the
 * installation-wide layer could not carry an access word, so its page rendered
 * the two controls not at all. That layer is gone (ADR-0011, continuation
 * 2026-08-14), both remaining pages carry a word, and a flag that is `true`
 * everywhere is a question nobody asks any more.
 */
type SectionFieldProps = Omit<SettingsSectionFieldsProps, 'section'>;

export function SettingsSectionFields({
  section,
  values,
  onChange,
  issues,
}: SettingsSectionFieldsProps): ReactElement {
  switch (section) {
    case 'access':
      return (
        <AccessFields values={values} onChange={onChange} issues={issues} />
      );
    case 'confirm':
      return (
        <ConfirmFields values={values} onChange={onChange} issues={issues} />
      );
    case 'display':
      return <DisplayFields values={values} onChange={onChange} />;
    case 'budget':
      return (
        <BudgetFields values={values} onChange={onChange} issues={issues} />
      );
  }
}

/**
 * *Verfügbarkeit* — **its own entry point**, and that is the shape of the
 * decision rather than a quirk of this file.
 *
 * The four inherited sections are rendered on two pages and read a
 * {@link TenantFormSettings}; these fields exist on a form's page alone and
 * read the seven keys an organisation's document does not have (ADR-0011,
 * continuation 2026-08-14). One component taking „either shape" would push
 * that difference into every field below as a `?`.
 */
export function AvailabilitySectionFields({
  values,
  onChange,
  issues,
}: {
  readonly values: FormSettings;
  readonly onChange: (patch: PartialFormSettings) => void;
  readonly issues: SettingIssues;
}): ReactElement {
  return (
    <>
      <ToggleRow
        title="Anmeldefrist festlegen"
        description="Legt ein Öffnungs- und Schließdatum fest. Außerhalb des Zeitraums ist das Formular nicht ausfüllbar."
        checked={values.openEnabled}
        onChange={(openEnabled) => {
          onChange({ openEnabled });
        }}
      >
        <div className="setting__grid">
          {/*
            An empty field borrows the zone of the other one: both deadlines of
            a form sit in the same season far more often than not, and „MEZ/MESZ"
            beside a filled sibling that already says „MESZ" reads as a doubt
            there is no reason for. With both fields empty it stays „MEZ/MESZ" —
            reading today's clock instead would make the label depend on the day
            it is looked at.
          */}
          <DeadlineSetting
            label="Öffnet am"
            value={toLocalInput(values.openAt)}
            zone={zoneAbbreviation(values.openAt ?? values.closeAt)}
            issue={issues.openAt}
            onChange={(local) => {
              onChange({ openAt: toInstant(local) });
            }}
          />
          <DeadlineSetting
            label="Schließt am"
            value={toLocalInput(values.closeAt)}
            zone={zoneAbbreviation(values.closeAt ?? values.openAt)}
            issue={issues.closeAt}
            onChange={(local) => {
              onChange({ closeAt: toInstant(local) });
            }}
          />
        </div>
      </ToggleRow>

      <SettingDivider />

      {/*
        The requirement — the reach of this setting stands next to the switch,
        not only in the documentation.

        The limit is enforced on the server with a signed start token, and a
        reload mints a new one: without saving a draft
        there is nothing a fill-in session could hang on. An editor who
        reads „nach Ablauf wird nicht mehr angenommen" and nothing else would
        take this for a barrier; it is a promise to the honest participant. The
        note is shown whether the switch is on or off, because it is what one
        needs before flipping it.
      */}
      <ToggleRow
        title="Zeitlimit pro Ausfüllung"
        description="Nach Ablauf wird eine begonnene Ausfüllung nicht mehr angenommen."
        note="Hinweis: Wer die Seite neu lädt, beginnt von vorn und erhält die volle Zeit erneut. Das Zeitlimit hilft beim zügigen Ausfüllen, es verhindert kein absichtliches Umgehen."
        checked={values.timeLimitEnabled}
        onChange={(timeLimitEnabled) => {
          onChange({ timeLimitEnabled });
        }}
      >
        <NumberSetting
          label="Zeitlimit"
          unit="Minuten"
          min={1}
          value={values.timeLimitMin}
          issue={issues.timeLimitMin}
          onChange={(timeLimitMin) => {
            onChange({ timeLimitMin });
          }}
        />
      </ToggleRow>

      <SettingDivider />

      <ToggleRow
        title="Antwortlimit gesamt"
        description="Sperrt das Formular, sobald die maximale Anzahl an Antworten erreicht ist."
        checked={values.maxResponsesEnabled}
        onChange={(maxResponsesEnabled) => {
          onChange({ maxResponsesEnabled });
        }}
      >
        <NumberSetting
          label="Antwortlimit"
          unit="Antworten"
          min={1}
          value={values.maxResponses}
          issue={issues.maxResponses}
          onChange={(maxResponses) => {
            onChange({ maxResponses });
          }}
        />
      </ToggleRow>
    </>
  );
}

/**
 * What stands in the field *Zugangspasswort* when no word may stand there.
 *
 * An `editor` (only `can_manage_form_settings`) is served the standard of the
 * organisation with the word redacted (ADR-0021). Until now
 * the placeholder landed raw in the input field — a character sequence with a NUL byte that looks
 * like a defect and like a word one accidentally leaves standing.
 *
 * The sentence says both things there are to say at this place: **where** the
 * protection comes from, and **what taking it over costs** — because the word is not
 * copied along in the process (`copyableTenantDefaults` on the server, `withSection` in the draft).
 * It stands as a `note` and thereby in the field's `aria-describedby`, not as a
 * `title` or as grey text alone: eye and screen reader are to get the same
 * sentence, and the field is locked in this state, so there is
 * no second way to get at the information.
 */
const WITHHELD_PASSWORD_NOTE =
  'Von der Organisation gesetzt und hier nicht sichtbar. Dieses Feld lässt ' +
  'sich nur bearbeiten, wenn der Abschnitt auf „Angepasst" steht – das Wort ' +
  'der Organisation wird dabei nicht übernommen, das Feld beginnt leer.';

/** …and what stands in the empty field itself as long as nothing is typed. */
const WITHHELD_PASSWORD_PLACEHOLDER = 'Von der Organisation gesetzt';

function AccessFields({
  values,
  onChange,
  issues,
}: SectionFieldProps): ReactElement {
  /**
   * The placeholder of the API stands **only** as long as the section is inherited:
   * on taking it over, `withSection` immediately puts an empty word into the draft,
   * and a section that has already been taken over carries this form's own word
   * anyway. That is why this state needs no second piece of information about
   * which side of the switch the card is on right now.
   */
  const withheld = isWithheldPassword(values.password);

  return (
    <>
      {/*
            The consequence stands **above** the save
            button, not in a release note. Setting the access word, or changing
            it, clears `response.edit_token` for this form: without that, a link
            handed out while the form was open would keep serving the whole field
            definition past the new gate, and the requirement would be false for
            exactly the case it exists for (the word is changed *because* the
            link leaked).

            Shown whether the switch is on or off, like the reload note at the
            time limit: it is what one needs to know *before* flipping it. It is
            not computed from the draft — a note that appears only once the
            switch is already moved is one an editor reads after deciding.
          */}
      <ToggleRow
        title="Passwortschutz"
        description="Zusätzliches gemeinsames Passwort, das vor dem Ausfüllen abgefragt wird."
        note="Achtung: Wird der Passwortschutz eingeschaltet oder das Zugangspasswort geändert, verlieren beim Speichern alle bereits abgesendeten Antworten ihren Bearbeiten-Link – bei den Tenant-Standards in jedem Formular, das diesen Abschnitt nicht angepasst hat. Das Ausschalten des Schutzes ändert daran nichts."
        checked={values.passwordEnabled}
        onChange={(passwordEnabled) => {
          onChange({ passwordEnabled });
        }}
      >
        {/*
              A visible text field, not a masked one: this is a shared access
              word an editor reads out and passes on, and the client decision of
              2026-07-27 keeps it readable for `can_manage_settings`. It is still a secret — it is never logged, never put into
              a URL and never sent to the public endpoint.
            */}
        <TextSetting
          label="Zugangspasswort"
          variant="mono"
          placeholder={
            withheld ? WITHHELD_PASSWORD_PLACEHOLDER : 'z. B. Jahrestagung2026'
          }
          // Empty instead of the raw placeholder: what stands there is said by
          // the sentence below it — and a field that shows a character sequence
          // with a NUL byte looks like an error and reads to a screen reader
          // like nothing at all.
          value={withheld ? '' : values.password}
          note={withheld ? WITHHELD_PASSWORD_NOTE : undefined}
          issue={issues.password}
          onChange={(password) => {
            onChange({ password });
          }}
        />
      </ToggleRow>

      <SettingDivider />

      {/*
        Concept no. 58 — the costs stand next to the switch, like the
        reload note at the time limit and the revocation note above it: what one
        has to know **before** flipping it, not afterwards.

        Two sentences, and each fends off a different wrong conclusion: "shown,
        not mailed" the assumption that every other confirmation on
        this page trains in, and "whoever has it can open the state" the one
        that there would be an account behind it. It was three times as long and said
        the same thing (review finding 16).
      */}
      <ToggleRow
        title="Zwischenspeichern erlauben"
        description="Erlaubt, eine angefangene Ausfüllung zu unterbrechen und später fortzusetzen."
        note="Der Link zum Fortsetzen wird angezeigt, nicht per E-Mail verschickt. Wer ihn hat, kann den Stand öffnen und weiter ausfüllen; ein Konto oder Passwort ist dafür nicht nötig."
        checked={values.allowSaveDraft}
        onChange={(allowSaveDraft) => {
          onChange({ allowSaveDraft });
        }}
      />

      <SettingDivider />

      <ToggleRow
        title="Bearbeiten nach Absenden"
        description="Absender können ihre Antwort bis zur Anmeldefrist nachträglich ändern."
        checked={values.allowEdit}
        onChange={(allowEdit) => {
          onChange({ allowEdit });
        }}
      />
    </>
  );
}

function ConfirmFields({
  values,
  onChange,
  issues,
}: SectionFieldProps): ReactElement {
  return (
    <>
      <TextSetting
        label="Titel der Bestätigungsseite"
        value={values.confirmTitle}
        issue={issues.confirmTitle}
        onChange={(confirmTitle) => {
          onChange({ confirmTitle });
        }}
      />
      <TextSetting
        label="Nachricht"
        multiline
        value={values.confirmMsg}
        issue={issues.confirmMsg}
        onChange={(confirmMsg) => {
          onChange({ confirmMsg });
        }}
      />

      <SettingDivider />

      {/*
        „Bestätigung an Teilnehmer senden" stood here and is gone (finding 24,
        2026-08-14). The switch was a second gate in front of the participant mail:
        a configured, active notification still did not go out,
        and this interface had to explain that in three places. Whoever sets up a
        notification to the person filling in has thereby
        decided that it is sent — and whoever does not want that switches
        it off where it stands.
      */}
      <ToggleRow
        title="Nach Absenden weiterleiten"
        description="Leitet nach kurzer Zeit auf eine externe Seite weiter."
        checked={values.redirectEnabled}
        onChange={(redirectEnabled) => {
          onChange({ redirectEnabled });
        }}
      >
        <div className="setting__grid setting__grid--url">
          {/*
            **The one output path for a redirect target that does not go
            through `effectiveRedirect()`** — and the only reason that is safe
            is the shape of this markup: the raw value is the `value` of an
            `<input>`, never an `href`, a `src` or anything a browser
            dereferences. An editor is looking at what they typed, including a
            `javascript:` they typed by mistake; blanking it would hide the
            thing they need to correct.
            That safety is a property of the element, not of the value. Whoever
            turns this into a link, a preview or a "Ziel öffnen" button has to
            put `effectiveRedirect()` (or `safeExternalUrl`) in front of it —
            the schema refuses such a target on save, but this box holds a
            draft that has not been saved yet.
          */}
          <TextSetting
            label="Ziel-URL"
            variant="mono"
            placeholder="https://…"
            value={values.redirectUrl ?? ''}
            issue={issues.redirectUrl}
            onChange={(url) => {
              // An empty box means „no target", not an empty string: the schema
              // stores `null` for that and would reject `''` as an invalid URL.
              onChange({ redirectUrl: url.trim() === '' ? null : url });
            }}
          />
          <NumberSetting
            label="Verzögerung"
            unit="Sek."
            min={0}
            value={values.redirectDelay}
            issue={issues.redirectDelay}
            onChange={(redirectDelay) => {
              onChange({ redirectDelay });
            }}
          />
        </div>
      </ToggleRow>

      <ConfirmationPreview
        title={values.confirmTitle}
        message={values.confirmMsg}
        redirectDelay={values.redirectEnabled ? values.redirectDelay : null}
      />
    </>
  );
}

/**
 * *Versandbudget* .
 *
 * **Neither field is behind a toggle**, unlike `maxResponses`/`timeLimitMin`
 * above: those two record a legitimate „kein Limit" business choice, and
 * Konzept no. 49 explicitly closes exactly that door for the mail budget — not
 * only as a shipped default, but as a state at all ("je Organisation und je Formular
 * anhebbar", never "abschaltbar"). A switch here would let an organisation or a form
 * reopen a door Konzept no. 49 closed; both fields are therefore always
 * shown, always required, and only ever raised.
 */
function BudgetFields({
  values,
  onChange,
  issues,
}: SectionFieldProps): ReactElement {
  return (
    <div className="setting__grid">
      <NumberSetting
        label="Mails je Fenster"
        unit="Mails"
        min={1}
        max={MAIL_BUDGET_LIMIT_MAX}
        hint={`Auf den Höchstwert (${MAIL_BUDGET_LIMIT_MAX.toLocaleString('de-DE')}) gesetzt heißt „praktisch unbegrenzt" — ein eigener Schalter dafür ist bewusst nicht vorgesehen.`}
        value={values.mailBudgetLimit}
        issue={issues.mailBudgetLimit}
        onChange={(mailBudgetLimit) => {
          onChange({ mailBudgetLimit });
        }}
      />
      <NumberSetting
        label="Fensterlänge"
        unit="Minuten"
        min={1}
        max={MAIL_BUDGET_WINDOW_MIN_MAX}
        hint={`Bis zu ${MAIL_BUDGET_WINDOW_MIN_MAX.toLocaleString('de-DE')} Minuten (ein Tag).`}
        value={values.mailBudgetWindowMin}
        issue={issues.mailBudgetWindowMin}
        onChange={(mailBudgetWindowMin) => {
          onChange({ mailBudgetWindowMin });
        }}
      />
    </div>
  );
}

function DisplayFields({
  values,
  onChange,
}: Omit<SectionFieldProps, 'issues'>): ReactElement {
  return (
    <>
      <ToggleRow
        title="Fortschrittsbalken anzeigen"
        checked={values.showProgress}
        onChange={(showProgress) => {
          onChange({ showProgress });
        }}
      />
      <SettingDivider />
      <ToggleRow
        title="Seitennummern anzeigen"
        checked={values.showPageNumbers}
        onChange={(showPageNumbers) => {
          onChange({ showPageNumbers });
        }}
      />
      <SettingDivider />
      <ToggleRow
        title="Hinweis auf Pflichtfelder"
        description={'Zeigt „* Pflichtfeld" oben im Formular.'}
        checked={values.showRequiredHint}
        onChange={(showRequiredHint) => {
          onChange({ showRequiredHint });
        }}
      />
    </>
  );
}
