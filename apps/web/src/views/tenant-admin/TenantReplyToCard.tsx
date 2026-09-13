import type { ReactElement } from 'react';

import { SettingsSaveBar } from '../settings/SettingsSaveBar';
import { TenantReplyToFields } from './TenantAddressCards';
import { useTenantReplyToState } from './use-tenant-addresses';

import '../settings-view.css';
import './tenant-admin-view.css';

/**
 * *Antwortadresse* — the `Reply-To` default of this organisation, the third, deliberately independent section of the
 * *Mailversand* tab.
 *
 * ## An own section, an own route, an own draft — no field of the
 * `MailIdentityCard`
 *
 * Exactly this question stood before the building, and the answer was "next to
 * it". The SMTP block is indivisible, *because it carries a secret*: whoever
 * does not type the password again cannot save it. A reply address is no
 * secret — if it lay in the block, nobody could change it without having the
 * SMTP password to hand, and an organisation that sends over the system would
 * have no block at all for it to fit into. The same separation that ADR-0013
 * no. 3 draws for the base address.
 *
 * ## Empty means: the system default applies
 *
 * An empty field writes `replyTo: null`, so not "no value" but "the system
 * default applies" — the chain notification → organisation → system stands in
 * `effectiveReplyTo`. If nothing is set system-wide either, the mail carries
 * **no** reply address; a mail client then answers to the sender address, as is
 * usual without a header line. The sending is never refused because of it.
 *
 * **Field and state have stood next door since ADR-0025** — see
 * `TenantBaseUrlCard`, the same division for the same reason.
 */
export function TenantReplyToCard({
  tenantId,
}: {
  readonly tenantId: string;
}): ReactElement | null {
  const state = useTenantReplyToState(tenantId);

  if (state.kind === 'loading') {
    return (
      <p className="settings__state" role="status">
        Antwortadresse wird geladen…
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
    <TenantReplyToFields
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
