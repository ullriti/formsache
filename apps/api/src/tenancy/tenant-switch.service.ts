import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { SessionUser } from '@formsache/shared';

import type { AuthContext } from '../auth/request-context';
import { NOT_AUTHENTICATED_MESSAGE } from '../auth/session.guard';
import { SessionFeaturesService } from '../auth/session-features.service';
import { SessionService } from '../auth/session.service';
import { membershipInclude, toSessionUser } from '../auth/session-user';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The one answer to a tenant the caller may not switch into.
 *
 * Identical for a tenant that does not exist and for one that exists but the
 * caller holds no membership in — 403 would confirm existence, and the list of
 * Organisationen on this platform is not public information. The wording names no
 * tenant either, so the reply is the same byte for byte in both cases.
 */
export const TENANT_NOT_FOUND_MESSAGE = 'Organisation nicht gefunden.';

/**
 * Writes `session.active_tenant_id` — after checking the membership.
 *
 * Order matters and is the whole point: check, then write. The reverse, or a
 * write without a check, would make this endpoint the cross-tenant access
 * the requirement forbids, no matter how careful every reader downstream is.
 */
@Injectable()
export class TenantSwitchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    /** Only for the features of the payload. */
    private readonly features: SessionFeaturesService,
  ) {}

  async switchTo(auth: AuthContext, tenantId: string): Promise<SessionUser> {
    // Against the database, not against `auth.user.memberships`. The request
    // context is fresh, so both would agree today — but this is the statement
    // that must stay true when a future caller hands in a context built some
    // other way, and it is tenant-bound in the query rather than filtered
    // afterwards: the unique key `(tenant_id, user_id)` either matches or the
    // row does not exist.
    //
    // **Filter 2 of the six of the requirement — `tenant.deleted_at`.** The
    // write side of the Tenant-Wechsler: `PUT /api/session/tenant` answers 404
    // for a deleted Organisation, and it is the *same* 404 a stranger's id gets and the
    // same one an organisation that never existed gets — one message, one status, three
    // states, so the reply is no oracle about which of them it was.
    //
    // Its own condition rather than a second reading of `auth.user.memberships`
    // (which filter 1 has already narrowed): this method checks against the
    // database on purpose — see the note above — and a check against the
    // database that then trusted a filter applied elsewhere would be neither.
    //
    // `findFirst` and not `findUnique`, because the condition is no longer the
    // composite key alone. The row is still addressed by it; the organisation's state
    // is the second predicate of the same statement rather than an `if` behind
    // it, which is the shape the requirement settled on for the public address.
    const membership = await this.prisma.membership.findFirst({
      where: {
        tenantId,
        userId: auth.user.id,
        tenant: { deletedAt: null },
      },
      select: { id: true },
    });
    if (membership === null) {
      throw new NotFoundException(TENANT_NOT_FOUND_MESSAGE);
    }

    await this.sessions.setActiveTenant(auth.sessionId, tenantId);

    // Re-read rather than patching the context in memory: the answer states
    // what the *stored* session now is, which is what the next request will be
    // judged by. A response assembled from the old context could claim a
    // switch that the write did not actually make — for instance because the
    // session was revoked in between, where `setActiveTenant` deliberately
    // updates nothing.
    const user = await this.prisma.user.findUnique({
      where: { id: auth.user.id },
      include: membershipInclude,
    });
    if (user === null) {
      // The account disappeared mid-request. The session is worthless now, and
      // saying so is more honest than answering with the stale context.
      throw new UnauthorizedException(NOT_AUTHENTICATED_MESSAGE);
    }

    const session = await this.prisma.session.findUnique({
      where: { id: auth.sessionId },
      select: { activeTenantId: true },
    });

    // `toSessionUser` applies the membership check a second time. Cheap, and
    // it means the reply cannot report a scope the guard would then refuse.
    const activeTenantId = session?.activeTenantId ?? null;
    return toSessionUser(
      user,
      activeTenantId,
      // Asked **after** the switch, not before: the menu switch applies to
      // the organisation the caller now stands in.
      await this.features.forTenant(activeTenantId),
    );
  }
}
