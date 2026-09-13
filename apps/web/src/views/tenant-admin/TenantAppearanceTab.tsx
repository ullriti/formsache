import type { ReactElement } from 'react';

import { SettingsSaveBar } from '../settings/SettingsSaveBar';
import { TenantAppearanceCards } from './TenantAppearanceCards';
import { TenantOidcSection } from './TenantOidcSection';
import { useTenantBrandingState } from './use-tenant-branding';

/**
 * Erscheinungsbild & Login — colour half (handoff).
 *
 * The colour fields and the OIDC block are **two documents on one tab**, each
 * with its own load, its own save and its own permission
 * (`TenantOidcSection`) — exactly what the two controllers on the server say
 * (`TenantBrandingController` needs `canManageSettings`,
 * `OidcConfigController` needs both flags). Merging them into one form would
 * either hide the OIDC fields behind a permission the colours do not need, or
 * grant a colour-only editor a lever on the organisation's login.
 *
 * **The fields themselves have stood next door since ADR-0025**
 * (`TenantAppearanceCards`), the state in `use-tenant-branding.ts`. What
 * remains here is the composition of this tab: two documents, one save bar for
 * the first — because the wizard of a newly created organisation shows the same
 * cards with a different button underneath, and two transcripts of the fields
 * would be two places where a contrast hint is missing.
 */
export function TenantAppearanceTab({
  tenantId,
}: {
  readonly tenantId: string;
}): ReactElement {
  const state = useTenantBrandingState(tenantId);

  if (state.kind === 'loading') {
    return (
      <p className="settings__state" role="status">
        Erscheinungsbild wird geladen…
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

      <TenantAppearanceCards
        tenantId={tenantId}
        document={state.document}
        draft={state.draft}
        setDraft={state.setDraft}
        issues={state.issues}
      />

      <TenantOidcSection tenantId={tenantId} />

      <p className="settings__footnote">
        Änderungen werden sofort übernommen, sobald du speicherst.
      </p>
    </div>
  );
}
