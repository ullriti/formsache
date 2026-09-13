import type { ReactElement } from 'react';

import { SettingsSaveBar } from '../settings/SettingsSaveBar';
import { TenantAiFields } from './TenantAiFields';
import { useTenantAiState } from './use-tenant-ai';

import '../settings-view.css';
import './tenant-admin-view.css';

/**
 * *KI* — the fifth tab of the organisation administration (ADR-0025 no. 6).
 *
 * It is the place at which the setting stays **findable**: the assistant
 * leads through it once, and afterwards nobody ever sees it again if
 * it stands only there. A tab of its own beside *Erscheinungsbild*,
 * *Formular-Standards*, *Nutzerrechte* and *Mailversand* is the same build shape
 * the system administration has for its AI settings — a tab is a
 * place, not a mode.
 *
 * **Absent, not greyed out, on 403.** The route demands
 * `canManageSettings`; whoever does not hold it gets the sentence why here — not
 * a locked field that promises a save nobody may perform.
 */
export function TenantAiTab({
  tenantId,
}: {
  readonly tenantId: string;
}): ReactElement {
  const state = useTenantAiState(tenantId);

  if (state.kind === 'loading') {
    return (
      <p className="settings__state" role="status">
        KI-Einstellung wird geladen…
      </p>
    );
  }

  if (state.kind === 'absent') {
    return (
      <p className="settings__state" role="alert">
        Diese Rolle darf die KI-Einstellung dieser Organisation nicht sehen.
      </p>
    );
  }

  if (state.kind === 'failed') {
    return (
      <p className="settings__state" role="alert">
        {state.message}
      </p>
    );
  }

  return (
    <div className="tenant-admin__tab">
      <TenantAiFields
        choice={state.choice}
        setChoice={state.setChoice}
        systemAvailable={state.systemAvailable}
        footer={
          <>
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
          </>
        }
      />
    </div>
  );
}
