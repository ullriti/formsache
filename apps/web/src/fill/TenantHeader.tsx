import type { ReactElement } from 'react';
import type { PublicTenant } from '@formsache/shared';

import { resolveTenantLogo } from '../shell/tenant-logo';

/**
 * Organisation, logo and stripe above every state of a public page.
 *
 * Typed on the *tenant* rather than on a form, because it is rendered above four
 * different payloads by now: the form itself, the locked stub of the requirement
 * (which carries the organisation and the title and nothing else), the availability
 * notice, and the edit view of the requirement.
 *
 * It resolves the logo itself. Passing one in was a leftover from when only one
 * caller existed, and it meant every new surface had to remember the same line —
 * the kind of duplication that ends with two pages showing different logos.
 */
export function TenantHeader({
  tenant,
}: {
  readonly tenant: PublicTenant;
}): ReactElement {
  const logo = resolveTenantLogo(tenant.logoRef);

  return (
    <header className="public__header">
      {logo === undefined ? null : (
        /*
          One fixed box for both logo formats, not a height keyed to
          `wideLogo` the way the compact header bar does it (`tenant-mark.css`).
          The header bar has to fit a fixed bar height, so a wide word mark
          needs a *shorter* height than a logo to avoid ballooning sideways.
          This card has no such ceiling: `object-fit: contain` inside a
          width-and-height box finds the best fit for either aspect on its
          own — a portrait logo is height-limited, a wide mark is
          width-limited — so one rule covers what used to need two, and the
          participant view can afford to show it larger than the header does.
        */
        <img
          className="public__logo"
          src={logo}
          alt={tenant.name}
          data-testid="public-tenant-logo"
        />
      )}
      <span className="public__tenant">{tenant.name}</span>
      <span className="public__stripe" aria-hidden="true" />
    </header>
  );
}
