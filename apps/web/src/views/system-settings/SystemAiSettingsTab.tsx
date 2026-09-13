import type { ReactElement } from 'react';

import { SettingsSaveBar } from '../settings/SettingsSaveBar';
import { SystemAiCard } from './SystemAiCard';
import { useSystemAi } from './use-system-ai';

import '../settings-view.css';

/**
 * *KI* — the configuration that stood in the environment (ADR-0015 with the
 * addendum of 2026-08-11), as a tab of the system administration.
 *
 * Thin on purpose. The fields stand in {@link SystemAiCard} — they also stand
 * in step 6 of the setup assistant —, the loading and saving in
 * `use-system-ai.ts`, and what this tab adds is the save bar.
 *
 * ## What never stands here
 *
 * ⚠️ **The key.** The field is always empty; leaving it empty means „den
 * gespeicherten behalten". What the page knows is `apiKeySet` — *that* one
 * is stored. The same construction the SMTP password and the OIDC secret
 * already have.
 *
 * ## What is not decided here
 *
 * The **budget per organisation** belongs in the organisation administration: it
 * determines a bill and is set per organisation. And the **own
 * switch of an organisation** belongs to the organisation. This page
 * answers exactly one of the three questions: *can this installation do AI?*
 */
export function SystemAiSettingsTab(): ReactElement {
  const state = useSystemAi();

  if (state.kind === 'loading') {
    return (
      <p className="settings__state" role="status">
        KI-Einstellungen werden geladen…
      </p>
    );
  }
  if (state.kind === 'failed') {
    // The navigation entry is not there without the superadmin property anyway;
    // this is the boundary itself and no second guard (`CONTRIBUTING.md`).
    return (
      <p className="settings__state" role="alert">
        {state.message}
      </p>
    );
  }

  return (
    <>
      <SystemAiCard
        draft={state.draft}
        setDraft={state.setDraft}
        stored={state.stored}
        gap={state.gap}
      />

      <SettingsSaveBar
        isSaving={state.isSaving}
        dirty={state.dirty}
        onSave={() => {
          // No aftermath: the answer is the new basis, and that is
          // done by `useServerDraft` in `use-system-ai.ts`.
          state.save(() => undefined);
        }}
      />

      {state.errorMessage === null ? null : (
        <p className="settings__alert" role="alert">
          {state.errorMessage}
        </p>
      )}
    </>
  );
}
