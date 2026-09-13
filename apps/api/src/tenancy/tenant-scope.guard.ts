import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';

import { NOT_AUTHENTICATED_MESSAGE } from '../auth/session.guard';
import { resolveActiveTenantId } from '../auth/session-user';
import type { TenantScopedRequest } from './request-context';
import { TenantScopeFactory } from './tenant-scope';

/**
 * Answer when a signed-in person has no usable tenant scope.
 *
 * Says what is missing and nothing about what exists: it never names a tenant,
 * so it cannot become a probe for whether one does.
 */
export const NO_TENANT_SCOPE_MESSAGE =
  'Für diese Anfrage ist keine Organisation ausgewählt.';

/**
 * Second link of the chain `SessionGuard → TenantScopeGuard`.
 *
 * It derives the tenant scope, and it derives it from **memberships**, never
 * from `session.active_tenant_id` on its own. That column is written by the
 * tenant switcher, and a scope taken from it unchecked would make the write
 * itself the kind of cross-tenant access this guard exists to forbid: a read
 * across the tenant boundary must reveal nothing about the tenant it touches —
 * a stale, hand-edited or leftover row would hand out another organisation's
 * data with a straight face. The composite
 * foreign key `(group_id, tenant_id)` puts a floor under the database; it is
 * not a substitute for this check, because it says nothing about *which* rows
 * a given request may read.
 *
 * **401 vs. 403.** No session at all is 401 and belongs to `SessionGuard`; the
 * case here is a request that is authenticated and still has no scope — no
 * Organisation chosen yet, or the membership behind the chosen one is gone. 403 is the
 * honest answer: the person is known, this request is not permitted as it
 * stands. Answering 401 would tell the browser the session died and send a
 * perfectly valid user back to the login screen, where logging in again
 * changes nothing. Neither status distinguishes "no tenant chosen" from
 * "membership revoked", and neither names a tenant.
 */
@Injectable()
export class TenantScopeGuard implements CanActivate {
  constructor(private readonly scopes: TenantScopeFactory) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<TenantScopedRequest>();

    const auth = request.auth;
    if (auth === undefined) {
      // Only reachable on a route that applied this guard without
      // `SessionGuard`. A wiring mistake, answered the closed way rather than
      // by deriving a scope from an unauthenticated request.
      throw new UnauthorizedException(NOT_AUTHENTICATED_MESSAGE);
    }

    // The memberships come from the session lookup of this very request, so
    // the check is against the current state of the database, not against
    // whatever was true when the session was opened.
    const tenantId = resolveActiveTenantId(
      auth.user.memberships.map((membership) => membership.tenant.id),
      auth.user.activeTenantId,
    );
    if (tenantId === null) {
      throw new ForbiddenException(NO_TENANT_SCOPE_MESSAGE);
    }

    request.tenantScope = this.scopes.create(tenantId);
    return true;
  }
}
