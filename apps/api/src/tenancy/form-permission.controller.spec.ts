import 'reflect-metadata';

import { describe, expect, it } from 'vitest';

import { FormPermissionController } from './form-permission.controller';
import {
  FORM_MEMBERS_PERMISSIONS,
  FORM_MEMBERS_REQUIREMENT,
} from './form-permission.service';
import {
  REQUIRED_PERMISSION,
  type PermissionRequirement,
} from './require-permission.decorator';

/**
 * **What the permissions page opens stands in one place — and this case holds
 * it there.**
 *
 * Two readers need the same answer to „which rights open *Nutzerrechte je
 * Formular*?":
 *
 * 1. `GroupPermissionGuard`, via the metadata of the two route handlers;
 * 2. `FormPermissionService.save`, which checks whether a cap on oneself locks
 *    exactly this page (`SELF_CAP_LOCKOUT_MESSAGE`).
 *
 * The value for it is {@link FORM_MEMBERS_REQUIREMENT}, and the controller
 * spreads it via `@RequireAnyPermission(...FORM_MEMBERS_PERMISSIONS)`. Both
 * share the list; the **mode** („any") is written by the decorator itself.
 * That is exactly where the drifting apart would lie: turning
 * `RequireAnyPermission` into a `RequireAllPermissions` would change the guard
 * and leave the check in the service on the old reading — and the *more
 * permissive* of the two is the one nobody notices. This case therefore
 * compares what the controller really stored with the value the service reads.
 *
 * Counter-test (run, not claimed): swap `RequireAnyPermission` in
 * `form-permission.controller.ts` for `RequireAllPermissions` → this case goes
 * red for both routes.
 */
function requirementOf(handler: unknown): PermissionRequirement | undefined {
  return Reflect.getMetadata(REQUIRED_PERMISSION, handler as object) as
    PermissionRequirement | undefined;
}

describe('FormPermissionController — was die Seite öffnet', () => {
  // The handlers are **named** and fetched via their property descriptor: all
  // that is needed is the object `SetMetadata` wrote on, never a call.
  // `prototype.list` as a value would be an unbound method
  // (`@typescript-eslint/unbound-method`) — the descriptor says „the object,
  // not the method" and is thereby the more honest spelling for what this case
  // does.
  it.each(['list', 'save'] as const)(
    'trägt an %s genau FORM_MEMBERS_REQUIREMENT',
    (name) => {
      const requirement = requirementOf(
        Object.getOwnPropertyDescriptor(
          FormPermissionController.prototype,
          name,
        )?.value,
      );

      expect(requirement).toBeDefined();
      expect(requirement?.mode).toBe(FORM_MEMBERS_REQUIREMENT.mode);
      expect([...(requirement?.permissions ?? [])]).toStrictEqual([
        ...FORM_MEMBERS_REQUIREMENT.permissions,
      ]);
    },
  );

  /**
   * And the list itself, written out. Without this case the comparison above
   * would be conducted against itself: an accidentally emptied
   * `FORM_MEMBERS_PERMISSIONS` — a route that then turns **nobody** away any
   * more, because „any of nothing" is nowhere satisfied and the guard only
   * mirrors the metadata — would stay green.
   */
  it('nennt beide Rechte, und nur diese', () => {
    expect([...FORM_MEMBERS_PERMISSIONS]).toStrictEqual([
      'canManageFormSettings',
      'canManageUsers',
    ]);
  });
});
