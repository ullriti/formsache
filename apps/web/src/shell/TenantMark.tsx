import type { ReactElement } from 'react';
import type { TenantSummary } from '@formsache/shared';

import { resolveTenantLogo } from './tenant-logo';

import './tenant-mark.css';

export interface TenantMarkProps {
  readonly tenant: TenantSummary;
  /** Extra class of the caller, for the size variants of the handoff. */
  readonly className?: string | undefined;
}

/**
 * The white plate carrying a tenant's logo or word mark (handoff §Header).
 *
 * Renders **nothing** when the logo reference cannot be resolved — no
 * initials, no placeholder box. The tenant name in PT Serif is right next to
 * it in every place this is used, so an invented mark would only add noise,
 * and early on, an unresolvable reference is the expected case for every
 * tenant except the Dachorganisation one (see `tenant-logo.ts`).
 */
export function TenantMark({
  tenant,
  className,
}: TenantMarkProps): ReactElement | null {
  const source = resolveTenantLogo(tenant.logoRef);

  if (source === undefined) {
    return null;
  }

  return (
    <span
      className={
        className === undefined ? 'tenant-mark' : `tenant-mark ${className}`
      }
    >
      {/* The name is carried by the adjacent text, so the image is decorative
          here — an empty alt keeps screen readers from reading it twice. */}
      <img
        className="tenant-mark__image"
        data-testid="tenant-logo"
        src={source}
        alt=""
      />
    </span>
  );
}
