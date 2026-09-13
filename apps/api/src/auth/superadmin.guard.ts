import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';

import type { AuthenticatedRequest } from './request-context';
import { NOT_AUTHENTICATED_MESSAGE } from './session.guard';

/**
 * The one answer for „du bist angemeldet, aber das hier verwaltet die
 * Installation".
 *
 * **403 and not 404**, like `GroupPermissionGuard` next door and unlike a
 * foreign form: the caller is signed in and the route is no secret — it is
 * documented, it is in the OpenAPI surface, and every installation has it. A
 * 404 here would be a riddle instead of an answer, and it would hide nothing
 * that is not already public. What *is* worth hiding — whether a given id
 * exists in another organisation — is a different boundary, drawn earlier by
 * `TenantScopeGuard`.
 */
export const NOT_SUPERADMIN_MESSAGE =
  'Diese Aktion ist der Systemverwaltung vorbehalten.';

/**
 * Superadmin-only routes.
 *
 * `user.is_superadmin` has existed in the model and in
 * `session-user.ts` and was **evaluated nowhere**; this guard is the first
 * place it decides anything.
 *
 * ## It is a fourth way in, not a master key
 *
 * The guard chain of `CONTRIBUTING.md` stays exactly what it was — *tenant scope →
 * group permissions → form restriction* — and this guard is **not** a link in
 * it. It sits **beside** it, on the administration routes of the installation,
 * and it is deliberately the *only* thing those routes ask for.
 *
 * Two consequences, and both are proved rather than asserted
 * (`test/system-settings/permissions.spec.ts`):
 *
 * 1. **Superadmin opens no domain route.** Nothing in `forms/`, `settings/`,
 *    `responses/` or `mail-log/` mentions this guard, so a superadmin without a
 *    membership in an organisation reaches that organisation's data exactly as far as anybody
 *    else does: not at all. Widening `TenantScopeGuard` „weil Superadmin ja
 *    alles darf" would have been the master key — and it would have been the
 *    kind that opens every door quietly, because a scope built from a claim
 *    instead of a membership leaves no trace in a query.
 * 2. **Nor does `can_manage_settings` open these.** Whoever administers their
 *    own Organisation does not set the default for *all* Organisationen. That is why the
 *    metadata of `RequirePermission` is not consulted here at all: a guard that
 *    accepted „superadmin **or** the right flag" would make the flag a way in,
 *    and the flag is handed out by every organisation to itself.
 *
 * ## The property hangs on the user, not on the active Organisation
 *
 * It is read off `auth.user`, which `SessionGuard` loaded from the `user` row
 * in this very request — not off the membership, not off the session's active
 * tenant. Switching Organisation therefore changes nothing about it, and neither does
 * having no active Organisation at all: an installation's first superadmin may well be
 * a member of nothing, and a route that required a tenant scope would lock them
 * out of the settings they are supposed to seed.
 *
 * That is also why this guard is applied **without** `TenantScopeGuard`. The
 * two would not merely be redundant; together they would make the
 * administration of the installation depend on a membership, which is precisely
 * the coupling out.
 */
@Injectable()
export class SuperadminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const auth = request.auth;
    if (auth === undefined) {
      // The chain was assembled wrongly — `SessionGuard` did not run. Refuse
      // rather than read a flag off an absent user: the alternative to
      // checking is assuming, and the assumption would grant.
      throw new UnauthorizedException(NOT_AUTHENTICATED_MESSAGE);
    }

    if (!auth.user.isSuperadmin) {
      throw new ForbiddenException(NOT_SUPERADMIN_MESSAGE);
    }

    return true;
  }
}
