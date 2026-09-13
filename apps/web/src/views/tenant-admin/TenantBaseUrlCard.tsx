import type { ReactElement } from 'react';

import { SettingsSaveBar } from '../settings/SettingsSaveBar';
import { TenantBaseUrlFields } from './TenantAddressCards';
import { useTenantBaseUrlState } from './use-tenant-addresses';

import '../settings-view.css';
import './tenant-admin-view.css';

/**
 * *Basis-Adresse* — the organisation's own base address (ADR-0013 no. 3),
 * the *Mailversand*-Reiter's second, deliberately separate section.
 *
 * ## Its own section, its own route, its own draft — not a field of
 * `MailIdentityCard`
 *
 * ADR-0013 no. 3 draws that line explicitly: the address says *where this
 * Organisation is reachable*, not *who it is in the mail system*, so an organisation sets or
 * clears it independently of whether it sends over the system's mail server
 * or its own — that is the normal case, not a mixture. Folding this into the
 * SMTP card's draft would make the two look like one document again, which is
 * exactly the coupling the ADR rules out.
 *
 * ## What it is for, and what it deliberately is not for
 *
 * This address is used for the
 * links a form sends to **participants** — the Bearbeiten-Link in a
 * confirmation mail, chiefly. The sign-in return address and the OIDC
 * `redirect_uri` stay on the installation's own address regardless of what is
 * set here — were they to follow this organisation's address, a session cookie
 * issued for the system's host would not apply to it, and a successful login
 * would look like an immediate sign-out. The hint below the field says so in
 * one line: whoever fills the field in reads
 * where it applies and where it does not.
 *
 * ## Blank means: the system default applies
 *
 * A blank field writes `baseUrl: null`, which is not „kein Wert" but „die
 * Systemvorgabe gilt" (`PublicUrlService.resolveBaseUrl`'s own chain) — and
 * if the installation has not set one either, a Bearbeiten-Link resolves to
 * nothing rather than to a guess (`{{bearbeiten}}` stays unresolved, the rest
 * of the mail stands). Never a guessed address: the mechanics predate this
 * card and are not re-decided here.
 *
 * **Field and state have stood next door since ADR-0025** (`TenantAddressCards`,
 * `use-tenant-addresses.ts`): the same section stands in the third step of the
 * organisation wizard, there with one button that saves both addresses
 * together.
 */
export function TenantBaseUrlCard({
  tenantId,
}: {
  readonly tenantId: string;
}): ReactElement | null {
  const state = useTenantBaseUrlState(tenantId);

  if (state.kind === 'loading') {
    return (
      <p className="settings__state" role="status">
        Basis-Adresse wird geladen…
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
    <TenantBaseUrlFields
      field={state.field}
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
