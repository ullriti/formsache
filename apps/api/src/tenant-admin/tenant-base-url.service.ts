import { Injectable, NotFoundException } from '@nestjs/common';
import {
  parseTenantBaseUrl,
  type TenantBaseUrl,
  type TenantBaseUrlWrite,
} from '@formsache/shared';

import type { TenantScope } from '../tenancy/tenant-scope';
import { TENANT_NOT_FOUND_MESSAGE } from './oidc-config.service';

/**
 * The organisation's own base address — the write path for it did not exist until now (ADR-0013 no. 3).
 *
 * **Not part of `SmtpConfigService`, and that is the point.** `tenant.smtp`
 * and `tenant.public_base_url` are two columns for a reason ADR-0013 spells
 * out by name: the address says *where this organisation is reachable*, not *who it
 * is in the mail system*, so it is set and cleared independently of whether
 * the organisation sends over the system's mail server or its own. Folding this into
 * the SMTP block would resurrect exactly the field-by-field write the
 * whole-document rule forbids — only for the field ADR-0013 explicitly carves back out of the block.
 *
 * **No `PrismaService` in the constructor**, like every other domain service
 * in this directory: the only way to the row is the `TenantScope` the guard
 * chain hands in, which has no way to name a *different* Organisation at all.
 *
 * **Read and write are last-write-wins, like `updateSmtp`/`updateOidc`.**
 * There is no revision on the wire and none in the column: the document is
 * one string, and the reasoning `ScopedTenantDelegate.updateOidc` gives for
 * skipping a lock applies unchanged here.
 */
@Injectable()
export class TenantBaseUrlService {
  /** The organisation's own base address as the *Mailversand*-Reiter reads it. */
  async ofTenant(scope: TenantScope): Promise<TenantBaseUrl> {
    const row = await scope.tenant.publicBaseUrl();
    if (row === null) {
      throw new NotFoundException(TENANT_NOT_FOUND_MESSAGE);
    }
    // `row.publicBaseUrl` was normalised on the way in
    // (`tenantBaseUrlWriteSchema`), so there is nothing left to validate on
    // the way out — unlike the SMTP block, a lone `text` column that fails
    // to parse is not a state this application can reach through its own
    // write, only through a raw edit, and showing it back verbatim is more
    // honest than a 500 for one string nobody has to keep secret.
    return parseTenantBaseUrl({ baseUrl: row.publicBaseUrl });
  }

  /** Replaces the organisation's own base address, or clears it (`baseUrl: null`). */
  async replaceOfTenant(
    scope: TenantScope,
    request: TenantBaseUrlWrite,
  ): Promise<TenantBaseUrl> {
    const written = await scope.tenant.updatePublicBaseUrl(request.baseUrl);
    if (!written) {
      throw new NotFoundException(TENANT_NOT_FOUND_MESSAGE);
    }
    return parseTenantBaseUrl({ baseUrl: request.baseUrl });
  }
}
