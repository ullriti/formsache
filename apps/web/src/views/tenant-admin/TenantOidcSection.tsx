import type { ReactElement } from 'react';

import { SettingsSaveBar } from '../settings/SettingsSaveBar';
import { TenantOidcFields } from './TenantOidcFields';
import { useTenantOidcState } from './use-tenant-oidc';

/**
 * Anmeldung (OIDC / SSO) — the lower half of *Erscheinungsbild & Login*
 * (handoff).
 *
 * **Absent, not disabled, on a 403.** `OidcConfigController` requires both
 * `canManageSettings` **and** `canManageUsers` (the requirement's shape, repeated here) — a caller who may only see the colours gets 403 on this
 * route, and this component renders nothing rather than a greyed-out block
 * that promises a save nobody may make. The branding half
 * of the tab keeps working regardless: the two are separate documents on
 * separate permissions, on purpose.
 *
 * **Fields and state have lived next door since ADR-0025** (`TenantOidcFields`,
 * `use-tenant-oidc.ts`) — the same block is the seventh step of the
 * organisation wizard, there with the frame's button instead of a save
 * bar. The distinction „abwesend gegen Störung" sits in the hook, so that the
 * two hosts do not make it separately.
 */
export function TenantOidcSection({
  tenantId,
}: {
  readonly tenantId: string;
}): ReactElement | null {
  const state = useTenantOidcState(tenantId);

  if (state.kind === 'loading' || state.kind === 'absent') {
    return null;
  }

  if (state.kind === 'failed') {
    return (
      <section className="settings-card tenant-admin__oidc">
        <p className="settings__alert" role="alert">
          {state.message}
        </p>
      </section>
    );
  }

  return (
    <TenantOidcFields
      config={state.config}
      draft={state.draft}
      setDraft={state.setDraft}
      issues={state.issues}
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
  );
}
