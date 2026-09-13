import { SetMetadata } from '@nestjs/common';
import type { Permissions } from '@formsache/shared';

/**
 * Which of the five group permissions a route needs.
 *
 * The name is a key of the shared `Permissions` type, not a free string: a
 * typo — `canViewResponse` for `canViewResponses` — would otherwise be a route
 * guarded by a permission nobody holds, or worse, one that silently matches
 * nothing. The type makes it a compile error.
 */
export type PermissionName = keyof Permissions;

export const REQUIRED_PERMISSION = 'formsache:required-permission';

/**
 * What the guard has to check, and **how**.
 *
 * The mode is carried explicitly rather than inferred from the list length.
 * Before this it was implicit — a list meant "any of" — and a two-element list
 * therefore *weakened* the route without anything at the call site saying so.
 * That is the wrong default for an authorisation rule: the dangerous reading
 * has to be the one somebody typed out.
 */
export interface PermissionRequirement {
  readonly mode: 'any' | 'all';
  readonly permissions: readonly PermissionName[];
}

/**
 * Whether a permission set satisfies what a route asked for.
 *
 * One implementation, used by **both** links that ask the question: the third
 * (`GroupPermissionGuard`, against the membership) and the fourth
 * (`FormRestrictionGuard`, against the same permissions narrowed by a per-form
 * cap — the requirement). Two copies of an authorisation predicate is how „any"
 * and „all" end up meaning different things one route further along, and the
 * one that reads the *weaker* way is the one nobody notices.
 */
export function holdsRequirement(
  permissions: Permissions,
  required: PermissionRequirement,
): boolean {
  const held = (permission: PermissionName): boolean => permissions[permission];
  return required.mode === 'any'
    ? required.permissions.some(held)
    : required.permissions.every(held);
}

/**
 * Declares the permission a handler needs. Read by `GroupPermissionGuard`.
 *
 * Deliberately metadata plus a guard rather than a check inside the handler:
 * `CONTRIBUTING.md` puts authorisation in guards, and a check in a handler is one
 * a new handler can be written without.
 */
export const RequirePermission = (permission: PermissionName) =>
  SetMetadata<string, PermissionRequirement>(REQUIRED_PERMISSION, {
    mode: 'all',
    permissions: [permission],
  });

/**
 * Declares that **any one** of several permissions opens a route.
 *
 * Added for the form list, and the case is worth naming because it was
 * an open point noticed early: `GET /api/forms` required `can_build`, so a
 * member who may only *see answers* found no form at all — their role listed a
 * right they could not reach. The five permissions of the handoff distinguish
 * building from viewing answers, and the list of forms is the way into both.
 *
 * A separate decorator rather than widening `RequirePermission` to a rest
 * parameter: "any of" is a weaker rule than "this one", and a reader of a
 * route should see which is meant without counting arguments.
 */
export const RequireAnyPermission = (...permissions: PermissionName[]) =>
  SetMetadata<string, PermissionRequirement>(REQUIRED_PERMISSION, {
    mode: 'any',
    permissions,
  });

/**
 * Declares that **all** of several permissions are needed.
 *
 * The case that forced it: the CSV export. `can_export` alone used to open it,
 * so a group configured with export but *without* `can_view_responses` — which
 * is freely configurable — could download every answer of the organisation while
 * being unable to look at a single one in the application. A bulk download of
 * personal data is not a weaker right than reading one row on screen; it is
 * the stronger one, and it therefore needs both.
 */
export const RequireAllPermissions = (...permissions: PermissionName[]) =>
  SetMetadata<string, PermissionRequirement>(REQUIRED_PERMISSION, {
    mode: 'all',
    permissions,
  });
