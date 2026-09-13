import type { ReactElement, ReactNode } from 'react';

import { SelectSetting } from '../settings/SettingsControls';
import type { TenantAiChoice } from './use-tenant-ai';

import '../settings-view.css';
import './tenant-admin-view.css';

/**
 * **The AI card of an organisation** — pure display above a foreign state
 * (`use-tenant-ai.ts`), ADR-0025 no. 6.
 *
 * Two hosts: the tab *KI* of the organisation administration and the eighth step
 * of the wizard. The tab is no accessory in this — without it the setting would
 * be reachable only in the wizard, and a switch that one sees exactly once in
 * the life of an organisation is no switch (the same justification that the tab
 * *Vorlagen* of the system administration carries).
 *
 * ## A select field and not a switch
 *
 * Because there are **three** answers and not two: inherit, on, off. A toggle
 * would have made a fixed decision out of the inheriting in the moment of the
 * first click — and the organisation would afterwards hang on a value that was
 * right once (`tenantAiSwitchSchema`).
 *
 * ## What the card says when the installation has no AI
 *
 * Then every position is without consequence, and exactly that stands there. Not
 * as a locked field without a reason: the setting stays saveable, because an
 * organisation may give its answer **in advance** and the installation can get
 * the feature later.
 */
export function TenantAiFields({
  choice,
  setChoice,
  systemAvailable,
  footer,
}: {
  readonly choice: TenantAiChoice;
  readonly setChoice: (next: TenantAiChoice) => void;
  readonly systemAvailable: boolean;
  /** What stands under the field in the card — the save bar, or nothing. */
  readonly footer?: ReactNode;
}): ReactElement {
  return (
    <section className="settings-card" aria-labelledby="tenant-admin-ai">
      <header className="settings-card__head">
        <div className="settings-card__text">
          <h2 className="settings-card__heading" id="tenant-admin-ai">
            KI-Formularerstellung
          </h2>
          <p className="settings-card__hint">
            Ob Bearbeiter dieser Organisation ein Formular aus einer
            Beschreibung erzeugen lassen dürfen. Was dabei zum Anbieter geht,
            ist der eingetippte Text — sonst nichts: keine Antworten, keine
            Namen, keine Adressen.
          </p>
        </div>
      </header>

      <div className="settings-card__body">
        {/*
          The sentence stands **before** the field and not as a hint below it: it
          decides whether the choice below currently has an effect.
          `role="status"` and not `alert` — an installation without AI is a valid
          state, not a fault.
        */}
        {systemAvailable ? null : (
          <p className="settings__alert" role="status">
            Diese Installation hat keine KI eingerichtet. Solange das so ist,
            bleibt die Funktion für alle Organisationen abwesend — auch für
            diese, und unabhängig davon, was hier steht. Wer das ändern will,
            wendet sich an den Betrieb dieser Installation.
          </p>
        )}

        <SelectSetting
          label="KI-Formularerstellung in dieser Organisation"
          value={choice}
          options={[
            { value: 'inherit', label: 'Wie die Installation' },
            { value: 'on', label: 'Eingeschaltet' },
            { value: 'off', label: 'Ausgeschaltet' },
          ]}
          note={
            '„Wie die Installation" heißt: was der Betrieb vorgibt, gilt auch hier — ' +
            'und gilt weiter, wenn er es ändert. „Eingeschaltet" gibt dieser ' +
            'Organisation nichts, was die Installation nicht hat; „Ausgeschaltet" ' +
            'nimmt die Funktion weg, auch wenn die Installation sie anbietet.'
          }
          onChange={(value) => {
            setChoice(value as TenantAiChoice);
          }}
        />

        <p className="tenant-admin__readonly">
          Das Kontingent — wie viele Aufrufe diese Organisation im Monat hat —
          gehört nicht hierher: es bestimmt die Rechnung des Betreibers und wird
          in der Systemverwaltung gesetzt. Dieser Schalter kann nur wegnehmen.
        </p>
      </div>

      {footer}
    </section>
  );
}
