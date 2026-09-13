import type { ReactElement } from 'react';

import { SettingsSaveBar } from '../settings/SettingsSaveBar';
import { NotificationTemplatesEditor } from './NotificationTemplatesEditor';
import { useSystemTemplates } from './use-system-templates';

import '../settings-view.css';

/**
 * *Vorlagen* — the installation's notification templates as a tab of the system
 * administration (ADR-0022, continuation 2026-08-18).
 *
 * ## Why this tab exists and not just the wizard step
 *
 * The setup wizard leads through the templates once. Were they reachable
 * **only** there, there would be a write path that one can use exactly once in
 * the life of an installation and never again — the obvious question “we want
 * to change the confirmation text” would then once more have no answer other
 * than `psql`. The wizard shows the same editor
 * (`NotificationTemplatesEditor`); this here is the address at which it stands
 * permanently.
 *
 * Thin like the AI tab next to it: fields in the editor, loading and saving in
 * `use-system-templates.ts`, here only the save bar.
 */
export function SystemNotificationTemplatesTab(): ReactElement {
  const state = useSystemTemplates();

  if (state.kind === 'loading') {
    return (
      <p className="settings__state" role="status">
        Vorlagen werden geladen…
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
    <>
      <NotificationTemplatesEditor
        templates={state.templates}
        decided={state.decided}
        issues={state.issues}
        onChange={state.setTemplates}
      />

      {/*
        **The state text hangs on `decided`, not on the comparison.** As long as
        the row decides nothing, „Nicht gespeichert" is formally correct and
        misleading all the same: nobody has typed anything that would be lost —
        there is simply nothing stored. The button is enabled in this state
        (`use-system-templates.ts`), because this is exactly where an unreadable
        document gets repaired.
      */}
      <SettingsSaveBar
        isSaving={state.isSaving}
        dirty={state.dirty}
        dirtyLabel={
          state.decided
            ? undefined
            : 'Nicht hinterlegt — es gelten die ausgelieferten Vorlagen'
        }
        onSave={() => {
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
