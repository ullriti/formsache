import type { ReactElement } from 'react';

import { DASHBOARD_PATH } from '../router/routes';
import { navigate } from '../router/use-route';
import { SettingsSaveBar } from './settings/SettingsSaveBar';
import { TenantFormDefaultsCards } from './tenant-admin/TenantFormDefaultsCards';
import { useTenantFormDefaultsState } from './tenant-admin/use-tenant-form-defaults';

import './settings-view.css';

/**
 * Tenant administration · **Formular-Standards**.
 *
 * **Four section cards, and no switch above them** (review finding 10). Until
 * 2026-08-17 the page had a „Vorgabe ⇄ Angepasst" toggle per section, plus four
 * hint lines that explained what „Vorgabe" means, and a locked `<fieldset>` in
 * exactly the state in which somebody wanted to change something. That is right
 * at the *form* — below it lies the organisation, and „erben" against „selbst
 * entscheiden" is a real choice there, with consequences. Here what lies below
 * is no second administration but the values this application is shipped with.
 * That an application has default values is the normal case and does not have
 * to be explained.
 *
 * The fields therefore simply stand there, prefilled with the default values,
 * and the organisation changes them. What it does **not** save is left to the
 * default — that is decided by the reading of the column
 * (`fillTenantSettings`), no longer by a switch.
 *
 * **There are still not five cards**: *Verfügbarkeit* stands only at the form
 * (ADR-0011, continuation 2026-08-14). An opening period, a deadline and a
 * participant limit belong to *one* form; prescribed organisation-wide they
 * would close registrations nobody has looked at.
 *
 * **Which organisation?** Always the active one. The endpoint names none in its
 * path, and neither does this page — an organisation selector here would
 * promise a choice the server does not offer.
 *
 * **Cards and state have stood next door since ADR-0025**
 * (`tenant-admin/TenantFormDefaultsCards.tsx`,
 * `tenant-admin/use-tenant-form-defaults.ts`): the same set of cards is the
 * sixth step of the organisation assistant.
 */
export function TenantFormDefaultsView({
  tenantId,
  tenantName,
}: {
  /** Id of the active Organisation, or `undefined` when none is scoped. */
  readonly tenantId?: string | undefined;
  /** Name of the active Organisation, or `undefined` when none is scoped. */
  readonly tenantName?: string | undefined;
}): ReactElement {
  const hasTenant = tenantId !== undefined && tenantName !== undefined;
  const state = useTenantFormDefaultsState(hasTenant ? tenantId : undefined);

  if (!hasTenant) {
    return (
      <div className="settings">
        <p className="settings__state" role="status">
          Bitte zuerst eine Organisation auswählen.
        </p>
      </div>
    );
  }

  if (state.kind === 'loading') {
    return (
      <div className="settings">
        <p className="settings__state" role="status">
          Formular-Standards werden geladen…
        </p>
      </div>
    );
  }

  if (state.kind === 'failed') {
    return (
      <div className="settings">
        <p className="settings__state" role="alert">
          {state.message}{' '}
          <button
            type="button"
            className="settings__link"
            onClick={() => {
              navigate(DASHBOARD_PATH);
            }}
          >
            Zurück zum Dashboard
          </button>
        </p>
      </div>
    );
  }

  return (
    <div className="settings">
      <div className="settings__head">
        <div className="settings__title-block">
          <h1 className="settings__title">Formular-Standards</h1>
          <p className="settings__subtitle">{tenantName}</p>
        </div>
      </div>

      <p className="settings__notice">
        Diese Werte sind die{' '}
        <strong>Standardeinstellungen für alle Formulare</strong> dieser
        Organisation. In jedem Formular können einzelne Abschnitte davon
        abweichen. Wann ein Formular geöffnet und geschlossen ist, entscheidet
        es selbst.
      </p>

      <SettingsSaveBar
        isSaving={state.isSaving}
        dirty={state.dirty}
        onSave={() => {
          state.save();
        }}
      />

      {state.errorMessage === null ? null : (
        <p className="settings__alert" role="alert">
          {state.errorMessage}
        </p>
      )}

      <TenantFormDefaultsCards
        values={state.values}
        issues={state.issues}
        onChange={state.change}
      />
    </div>
  );
}
