import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';

/**
 * The one column of an organisation's row that {@link PublicUrlService} needs
 *  — `tenant.public_base_url`, as stored.
 *
 * A repository of its own rather than a call inlined into
 * `PublicUrlService`, because a direct `PrismaService` import is a decision
 * this codebase makes visible: the eighth entry of the allow-list in
 * `eslint.config.js` names exactly this file, and the reasoning belongs next
 * to what it is reasoning about.
 *
 * **Not normalised here.** `PublicUrlService.resolveBaseUrl` runs every value
 * through `normaliseBaseUrl` — this repository's own value and the system
 * default alike — so there is exactly one place that decides what „a base
 * address" is, the same split `SystemMailSettingsService.publicBaseUrl`
 * already makes between reading the column and validating it.
 */
@Injectable()
export class TenantBaseUrlRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The organisation's own address as the column holds it, or `null` for „dieser
   * Organisation hat keine eigene — die Systemvorgabe gilt".
   *
   * `tenantId` is never optional and never guessed: every caller in this
   * application has it already, either as the `tenant_id` of the form a
   * public request resolved by its slug, or as the `tenant_id` of the row a
   * worker holds by primary key. Neither is a request-supplied parameter this
   * query trusts on its own — see the allow-list entry.
   */
  async findOwn(tenantId: string): Promise<string | null> {
    const row = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { publicBaseUrl: true },
    });
    return row?.publicBaseUrl ?? null;
  }
}
