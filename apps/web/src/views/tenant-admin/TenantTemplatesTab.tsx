import type { ReactElement } from 'react';

import { SettingsSaveBar } from '../settings/SettingsSaveBar';
import { NotificationTemplatesEditor } from './TenantNotificationTemplatesEditor';
import { useTenantTemplates } from './use-tenant-notification-templates';

import '../settings-view.css';

/**
 * *Vorlagen* — this organisation's notification templates as a tab of the
 * organisation administration (ADR-0032, moved here from the system
 * administration).
 *
 * Thin like the other settings tabs next to it: fields in the editor, loading
 * and saving in `use-tenant-notification-templates.ts`, here only the save
 * bar.
 */
export function TenantTemplatesTab({
  tenantId,
}: {
  readonly tenantId: string;
}): ReactElement {
  const state = useTenantTemplates(tenantId);

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
        **The state text hangs on `decided`, not on the comparison.** As long
        as the row decides nothing, „Nicht gespeichert" is formally correct
        and misleading all the same: nobody has typed anything that would be
        lost — there is simply nothing stored. The button is enabled in this
        state (`use-tenant-notification-templates.ts`), because this is
        exactly where an unreadable document gets repaired.
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
