import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { MembershipSummary, SessionUser } from '@formsache/shared';
import { describe, expect, it, vi } from 'vitest';

import type { AuthContext } from '../auth/request-context';
import { FORM_ID_SOURCE, type FormIdSource } from './form-id-source.decorator';
import {
  FORM_ID_UNDECLARED_MESSAGE,
  FormRestrictionGuard,
} from './form-permission.guard';
import type { TenantScopedRequest } from './request-context';
import {
  REQUIRED_PERMISSION,
  type PermissionRequirement,
} from './require-permission.decorator';
import type { TenantScope } from './tenant-scope';

/**
 * Why this spec exists: **the wiring mistakes it covers cannot be produced by
 * any route this application currently has** (review finding).
 *
 * The fourth link refuses a route that declares no {@link FormIdSource} — and
 * it used to *pass* one whose declaration named a parameter the route does not
 * carry. Both are one decorator away in a controller nobody has written yet:
 * a class-wide `@FormIdInParam('id')` on `FormsController` plus a later
 * `@Get('archived')`, and that route is silently outside the chain — the
 * restriction is not evaluated, and every integration test stays green,
 * because no request in the suite hits the route that does not exist.
 *
 * So the two shapes are built here by hand, against an `ExecutionContext` and
 * a `TenantScope` stub. They are not artificial inputs: they are precisely
 * what the next controller in this codebase will hand the guard.
 */

const TENANT = '019fa000-0000-7000-8000-00000000000a';
const USER = '019fa000-0000-7000-8000-000000000001';
const GROUP = '019fa000-0000-7000-8000-0000000000a1';
const FORM = '019fd000-0000-7000-8000-0000000000f1';

/**
 * Stands in for the controller class `context.getClass()` names. The reflector
 * is a stub here, so nothing is read off it — what matters is that the guard
 * gets the *same* two handles Nest would give it.
 */
class RouteHost {
  readonly declaredIn = 'form-permission.guard.spec';
}

/** A restrictable role: everything but the `admin` system group. */
function membership(): MembershipSummary {
  return {
    tenant: {
      id: TENANT,
      shortName: 'X',
      name: 'Organisation X',
      logoRef: null,
      branding: {
        accent: '#cea967',
        headerBg: '#212226',
        canvasBg: '#e9e6df',
        stripe: ['#212226'],
        wideLogo: false,
      },
    },
    group: {
      id: GROUP,
      name: 'editor',
      color: '#5b6b52',
      rank: 60,
      isSystem: false,
    },
    permissions: {
      canBuild: true,
      canViewResponses: true,
      canExport: true,
      canManageSettings: true,
      canManageFormSettings: true,
      canManageUsers: false,
    },
  };
}

function sessionUser(): SessionUser {
  return {
    id: USER,
    email: 'editor@example.org',
    name: 'Editorin',
    isSuperadmin: false,
    aiFormsAvailable: false,
    memberships: [membership()],
    activeTenantId: TENANT,
  };
}

/**
 * The guard, with everything the three earlier links leave behind already in
 * place — so the only thing under test is what this one does with the route's
 * declaration.
 */
function guardWith(options: {
  readonly source: FormIdSource | undefined;
  readonly params?: Record<string, string | undefined>;
  readonly query?: Record<string, unknown>;
}): {
  guard: FormRestrictionGuard;
  context: ExecutionContext;
  findFor: ReturnType<typeof vi.fn>;
} {
  const findFor = vi.fn(() => Promise.resolve(null));
  const scope = {
    tenantId: TENANT,
    formPermissions: { findFor },
    groups: { findById: () => Promise.resolve(null) },
  } as unknown as TenantScope;

  const auth: AuthContext = { sessionId: 's', user: sessionUser() };
  const request: TenantScopedRequest = {
    headers: {},
    auth,
    tenantScope: scope,
    params: options.params ?? {},
    query: options.query ?? {},
  };

  const required: PermissionRequirement = {
    mode: 'all',
    permissions: ['canBuild'],
  };
  const reflector = {
    getAllAndOverride: (key: string) =>
      key === FORM_ID_SOURCE
        ? options.source
        : key === REQUIRED_PERMISSION
          ? required
          : undefined,
  } as unknown as Reflector;

  return {
    guard: new FormRestrictionGuard(reflector),
    context: {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => () => undefined,
      getClass: () => RouteHost,
    } as unknown as ExecutionContext,
    findFor,
  };
}

describe('FormRestrictionGuard: the route declares where its form stands', () => {
  /**
   * **The finding.** The declaration says „`:id` in the path", the route has
   * no `:id`, and `params['id']` is therefore `undefined`. Read as „no form
   * here, nothing to check" the request went straight through — the same
   * fail-open the decorator was introduced to remove, one line further in.
   */
  it('refuses a declared path parameter the route does not carry', async () => {
    const { guard, context, findFor } = guardWith({
      source: { in: 'param', name: 'id' },
      params: {},
    });

    await expect(guard.canActivate(context)).rejects.toThrow(
      ForbiddenException,
    );
    await expect(guard.canActivate(context)).rejects.toThrow(
      FORM_ID_UNDECLARED_MESSAGE,
    );
    // …and it refused *before* asking the database anything: a wiring mistake
    // is not a restriction that happened not to be there.
    expect(findFor).not.toHaveBeenCalled();
  });

  /**
   * The control, and it is what makes the case above about the missing
   * parameter rather than about the declaration: the very same declaration on
   * a route that does carry the parameter is evaluated normally.
   */
  it('evaluates the same declaration when the parameter is there', async () => {
    const { guard, context, findFor } = guardWith({
      source: { in: 'param', name: 'id' },
      params: { id: FORM },
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(findFor).toHaveBeenCalledWith(FORM, USER);
  });

  /**
   * A **query** parameter is optional by nature and stays so:
   * `GET /api/mail-log` without a prefilter is the ordinary request, and the
   * list narrows itself in the `where` (`ScopedMailLogDelegate`). Refusing it
   * here would make the mail log unreachable.
   */
  it('passes an absent query parameter, which is a legitimate shape', async () => {
    const { guard, context, findFor } = guardWith({
      source: { in: 'query', name: 'formId' },
      query: {},
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(findFor).not.toHaveBeenCalled();
  });

  /** The shape that was already closed — kept, because it is the same door. */
  it('refuses a route that declares nothing at all', async () => {
    const { guard, context, findFor } = guardWith({
      source: undefined,
      params: { id: FORM },
    });

    await expect(guard.canActivate(context)).rejects.toThrow(
      ForbiddenException,
    );
    expect(findFor).not.toHaveBeenCalled();
  });

  /** …and a route that says „kein Formular hier", with its reason. */
  it('passes a route that declares no form, with a reason', async () => {
    const { guard, context, findFor } = guardWith({
      source: { in: 'nothing', because: 'the service checks the row it loads' },
      params: {},
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(findFor).not.toHaveBeenCalled();
  });
});
