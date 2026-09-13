import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { AiSettingsService } from '../system-settings/ai-settings.service';
import { toSessionFeatures, type SessionFeatures } from './session-features';

/**
 * **The features of a session payload, answered in one place**
 * (by now with the third layer).
 *
 * Three places build a session payload — sign-in, session fetch and
 * Organisation switch —, and `toSessionUser` demands the features as a mandatory argument
 * so that none of them can forget them. The argument used to be a pure
 * expression over the environment that each of the three could form for itself.
 *
 * By now the answer costs two queries — the settings row and
 * the switch of the active Organisation —, and **three** copies of that would be three
 * chances to forget one of the two layers. Exactly one here.
 *
 * ⚠️ **The Organisation switch belongs to it, and that is no convenience.** Were
 * only the installation asked here, an Organisation that has switched itself
 * off would still see the menu entry „✦ KI-Formular" — and would get a 404 at
 * the route. „menu and route drift apart" is exactly the
 * failure shape this test guards against; it would have come back through the
 * new switch.
 */
@Injectable()
export class SessionFeaturesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiSettingsService,
  ) {}

  /**
   * For one Organisation — or for none, when the session currently has no active
   * one (then only what the installation can do counts).
   *
   * The narrow projection is deliberate: for „does this Organisation want it?" one
   * column is needed, not the row.
   */
  async forTenant(activeTenantId: string | null): Promise<SessionFeatures> {
    const tenant =
      activeTenantId === null
        ? null
        : await this.prisma.tenant.findUnique({
            where: { id: activeTenantId },
            select: { aiEnabled: true },
          });
    return toSessionFeatures(
      await this.ai.available(tenant?.aiEnabled ?? null),
    );
  }
}
