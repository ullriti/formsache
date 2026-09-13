import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { NOT_AUTHENTICATED_MESSAGE } from '../auth/session.guard';
import type { TenantScopedRequest } from './request-context';
import {
  REQUIRED_PERMISSION,
  holdsRequirement,
  type PermissionRequirement,
} from './require-permission.decorator';

/**
 * The one answer for "you are in this organisation, but not with this right".
 *
 * 403 and not 404 here, unlike a foreign form: the caller is allowed to know
 * the resource exists — they are looking at their own Organisation — and telling them
 * their role is too narrow is the only answer they can act on. The
 * indistinguishability that matters here is about *other* tenants, and
 * that boundary is drawn earlier, by `TenantScopeGuard`.
 */
export const MISSING_PERMISSION_MESSAGE =
  'Diese Aktion ist für Ihre Rolle nicht freigegeben.';

/**
 * Third link of the guard chain: *tenant scope →
 * **group permissions** → form restriction* (`CONTRIBUTING.md`).
 *
 * Runs after `TenantScopeGuard`, and depends on it: the permissions that count
 * are the ones of the membership in the **active** tenant, not the widest set
 * the person holds anywhere. Someone who is admin in their own Organisation and viewer
 * in the association must not build forms for the association because of the
 * former — reading the permissions off the active membership is what prevents
 * that, and it is why this guard resolves the membership itself instead of
 * trusting a flattened value on the session.
 *
 * A route without `@RequirePermission()` passes: the guard states the
 * permission a handler needs, and a handler that needs none says so by not
 * asking. Fail-closed lives one level up — a route with no guards at all is
 * unreachable for a different reason (no scope, no data).
 */
@Injectable()
export class GroupPermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<
      PermissionRequirement | undefined
    >(REQUIRED_PERMISSION, [context.getHandler(), context.getClass()]);

    if (required === undefined || required.permissions.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<TenantScopedRequest>();
    const auth = request.auth;
    if (auth === undefined) {
      // The chain was assembled wrongly — `SessionGuard` did not run. Refuse
      // rather than read permissions off an absent user.
      throw new UnauthorizedException(NOT_AUTHENTICATED_MESSAGE);
    }

    const scope = request.tenantScope;
    if (scope === undefined) {
      throw new ForbiddenException(MISSING_PERMISSION_MESSAGE);
    }

    const membership = auth.user.memberships.find(
      (candidate) => candidate.tenant.id === scope.tenantId,
    );
    if (membership === undefined) {
      // `TenantScopeGuard` only builds a scope from a membership, so this is
      // unreachable through the normal chain. It is still checked, because the
      // alternative to checking is assuming — and the assumption would grant.
      throw new ForbiddenException(MISSING_PERMISSION_MESSAGE);
    }

    // The route says which reading it means (`RequirePermission`,
    // `RequireAnyPermission`, `RequireAllPermissions`) — the guard does not
    // guess it from how many were listed. Judged by the same function the
    // fourth link uses, so a cap cannot be measured against a different rule.
    if (!holdsRequirement(membership.permissions, required)) {
      throw new ForbiddenException(MISSING_PERMISSION_MESSAGE);
    }

    return true;
  }
}
