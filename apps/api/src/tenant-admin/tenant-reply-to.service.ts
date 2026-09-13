import { Injectable, NotFoundException } from '@nestjs/common';
import {
  parseTenantReplyTo,
  type TenantReplyTo,
  type TenantReplyToWrite,
} from '@formsache/shared';

import type { TenantScope } from '../tenancy/tenant-scope';
import { TENANT_NOT_FOUND_MESSAGE } from './oidc-config.service';

/**
 * The reply address of an organisation.
 *
 * **Not part of `SmtpConfigService`, and that is where the whole
 * decision lies.** The SMTP block is indivisible *because it carries a
 * secret*: whoever does not type the password again cannot save it. A
 * reply address is no secret — were it in the block, nobody could
 * change it without having the SMTP password to hand, and an organisation that
 * sends over the system would have no block at all for it to fit into.
 *
 * It therefore stands exactly where the base address stands (ADR-0013 no. 3,
 * `TenantBaseUrlService`): its own column, its own route, its own section —
 * and with the same inheritance, organisation before system.
 *
 * **No `PrismaService` in the constructor**, as in every other domain service
 * of this directory: the only way to the row is the `TenantScope` that
 * the guard chain hands in, and it cannot name a *different* organisation at
 * all.
 *
 * **Reading and writing are last-write-wins**, like `updateSmtp`/`updateOidc`
 * and the base address: the document is a string, and the
 * justification `ScopedTenantDelegate.updateOidc` gives for leaving out a
 * counter applies here unchanged.
 */
@Injectable()
export class TenantReplyToService {
  /** The organisation's own reply address, as the *Mailversand* tab reads it. */
  async ofTenant(scope: TenantScope): Promise<TenantReplyTo> {
    const row = await scope.tenant.replyTo();
    if (row === null) {
      throw new NotFoundException(TENANT_NOT_FOUND_MESSAGE);
    }
    // Returned unchanged, like the base address: a value that reached the
    // column past the API is on this page the one thing
    // that is meant to be repaired — and when sending it falls through anyway
    // (`effectiveReplyTo`), instead of going out as a header.
    return parseTenantReplyTo({ replyTo: row.replyTo });
  }

  /** Replaces the organisation's reply address, or deletes it (`replyTo: null`). */
  async replaceOfTenant(
    scope: TenantScope,
    request: TenantReplyToWrite,
  ): Promise<TenantReplyTo> {
    const written = await scope.tenant.updateReplyTo(request.replyTo);
    if (!written) {
      throw new NotFoundException(TENANT_NOT_FOUND_MESSAGE);
    }
    return parseTenantReplyTo({ replyTo: request.replyTo });
  }
}
