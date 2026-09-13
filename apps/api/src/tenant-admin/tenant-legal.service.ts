import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  EMPTY_TENANT_LEGAL_PAGES,
  parseStoredTenantLegalPages,
  type TenantLegalPages,
  type UpdateTenantLegalRequest,
} from '@formsache/shared';
import type { Prisma } from '@prisma/client';

import type { TenantScope } from '../tenancy/tenant-scope';
import { TENANT_NOT_FOUND_MESSAGE } from './oidc-config.service';

/** The conflict — the same wording as on the instance's legal-text page. */
export const STALE_TENANT_LEGAL_MESSAGE =
  'Die Rechtstexte wurden zwischenzeitlich von jemand anderem geändert. ' +
  'Bitte lade die Seite neu und übernimm deine Änderung erneut.';

export interface TenantLegalDocument {
  readonly pages: TenantLegalPages;
  readonly lock: number;
}

/**
 * **The legal texts of an Organisation** (ADR-0028): its provider details and
 * its privacy notice.
 *
 * ## Why they belong to the Organisation and not to the operation
 *
 * Because the roles fall apart (`docs/legal/README.md` section 2): the
 * Organisation is the **controller** for the answers that come in over its
 * form — it decides about purpose, legal basis and retention period. The
 * operator's privacy policy cannot fulfil this duty to inform under
 * Art. 13 DSGVO; it knows the answers to none of the three
 * questions. Hence two sets of pages, hence two columns, hence this
 * service next to `SystemLegalService`.
 *
 * ## No `PrismaService` in the constructor
 *
 * Like every other domain service of this directory: the only way to the
 * row is the `TenantScope` the guard chain hands in, and that has
 * no possibility at all of naming a **foreign** Organisation. The
 * tenant boundary is therefore structural here and not checked — there is
 * nothing to refuse.
 *
 * ⚠️ **The public delivery goes a different way** and has to: a
 * participant has no session and therefore no scope. It lives in
 * `public/public-legal.service.ts`, is bound to `short_name` and reads
 * exclusively what is meant to be published anyway.
 */
@Injectable()
export class TenantLegalService {
  /** What the tab *Rechtstexte* of this Organisation reads. */
  async ofTenant(scope: TenantScope): Promise<TenantLegalDocument> {
    const row = await scope.tenant.legal();
    if (row === null) {
      throw new NotFoundException(TENANT_NOT_FOUND_MESSAGE);
    }
    return {
      pages:
        row.legalPages === null
          ? EMPTY_TENANT_LEGAL_PAGES
          : parseStoredTenantLegalPages(row.legalPages),
      lock: row.legalRevision,
    };
  }

  /**
   * Replaces both legal texts of this Organisation — in full, never
   * page by page.
   *
   * The lock is read **before** the write and then checked once more in the
   * `where` of the write, exactly as on the system side: the
   * first answers the stale request with a 409, the second closes
   * the narrow race in between.
   */
  async replaceOfTenant(
    scope: TenantScope,
    request: UpdateTenantLegalRequest,
  ): Promise<TenantLegalDocument> {
    const current = await scope.tenant.legal();
    if (current === null) {
      throw new NotFoundException(TENANT_NOT_FOUND_MESSAGE);
    }
    if (request.lock !== current.legalRevision) {
      throw new ConflictException(STALE_TENANT_LEGAL_MESSAGE);
    }

    const written = await scope.tenant.updateLegal(
      current.legalRevision,
      toJson(request.pages),
    );
    if (!written) {
      throw new ConflictException(STALE_TENANT_LEGAL_MESSAGE);
    }

    return this.ofTenant(scope);
  }
}

/** The same narrow cast as on the system side — a checked value, one function. */
function toJson(pages: TenantLegalPages): Prisma.InputJsonValue {
  return pages;
}
