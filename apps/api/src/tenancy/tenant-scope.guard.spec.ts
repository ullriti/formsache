import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { MembershipSummary, SessionUser } from '@formsache/shared';
import { describe, expect, it, vi } from 'vitest';

import type { AuthContext } from '../auth/request-context';
import type { TenantScopedRequest } from './request-context';
import { TenantScopeGuard } from './tenant-scope.guard';
import type { TenantScope, TenantScopeFactory } from './tenant-scope';

/**
 * Why this spec exists, in one sentence: the integration suite cannot see this
 * check fail on its own.
 *
 * `toSessionUser` already blanks an `activeTenantId` no membership backs, so
 * removing the guard's own check leaves every integration test green — the two
 * defences are redundant by design, and redundancy is exactly what hides a
 * regression. Measured: with the check deleted, `test/tenancy` stayed 20/20.
 *
 * So the guard is exercised here against an `AuthContext` built by hand, one
 * that a correct `toSessionUser` would never produce. That is not an artificial
 * input — it is what a second writer to the session (a future OIDC path, a
 * cached context, an admin tool) would hand in, and the rule says the guard is where
 * the scope is decided, not one of two places that happen to agree today.
 */

const TENANT_A = '019fa000-0000-7000-8000-00000000000a';
const TENANT_B = '019fa000-0000-7000-8000-00000000000b';

function membership(tenantId: string): MembershipSummary {
  return {
    tenant: {
      id: tenantId,
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
      id: '019fa000-0000-7000-8000-0000000000a1',
      name: 'admin',
      color: '#7c0800',
      rank: 100,
      isSystem: true,
    },
    permissions: {
      canBuild: true,
      canViewResponses: true,
      canExport: true,
      canManageSettings: true,
      canManageFormSettings: true,
      canManageUsers: true,
    },
  };
}

function sessionUser(
  memberships: MembershipSummary[],
  activeTenantId: string | null,
): SessionUser {
  return {
    id: '019fa000-0000-7000-8000-000000000001',
    email: 'admin@example.org',
    name: 'Administrator Beispiel',
    isSuperadmin: false,
    aiFormsAvailable: false,
    memberships,
    activeTenantId,
  };
}

/** A request carrying `auth`, as `SessionGuard` leaves it. */
function contextFor(auth: AuthContext | undefined): {
  context: ExecutionContext;
  request: TenantScopedRequest;
} {
  // `exactOptionalPropertyTypes` is on, so an absent `auth` has to be an
  // absent key — which is exactly the shape a request has before `SessionGuard`
  // ran, and therefore the shape worth testing.
  const request: TenantScopedRequest =
    auth === undefined ? { headers: {} } : { headers: {}, auth };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

function guardWith(): {
  guard: TenantScopeGuard;
  create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn(
    (tenantId: string) => ({ tenantId }) as unknown as TenantScope,
  );
  const factory = { create } as unknown as TenantScopeFactory;
  return { guard: new TenantScopeGuard(factory), create };
}

describe('TenantScopeGuard', () => {
  it('scopes the request to a tenant the person is a member of', () => {
    const { guard, create } = guardWith();
    const { context, request } = contextFor({
      sessionId: 's',
      user: sessionUser([membership(TENANT_A)], TENANT_A),
    });

    expect(guard.canActivate(context)).toBe(true);
    expect(create).toHaveBeenCalledWith(TENANT_A);
    expect(request.tenantScope).toBeDefined();
  });

  /**
   * The forbidden case, and the one the whole guarantee rests on: a context
   * that claims tenant B while the memberships only cover A. No scope is built
   * — not a scope for A, and least of all one for B.
   */
  it('refuses a tenant no membership backs, and builds no scope at all', () => {
    const { guard, create } = guardWith();
    const { context, request } = contextFor({
      sessionId: 's',
      user: sessionUser([membership(TENANT_A)], TENANT_B),
    });

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    expect(create).not.toHaveBeenCalled();
    expect(request.tenantScope).toBeUndefined();
  });

  it('refuses a person whose memberships are all gone', () => {
    const { guard, create } = guardWith();
    const { context } = contextFor({
      sessionId: 's',
      user: sessionUser([], TENANT_A),
    });

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses a session that has not chosen a tenant', () => {
    const { guard, create } = guardWith();
    const { context } = contextFor({
      sessionId: 's',
      user: sessionUser([membership(TENANT_A)], null),
    });

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses an unauthenticated request instead of deriving a scope', () => {
    const { guard, create } = guardWith();
    const { context } = contextFor(undefined);

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    expect(create).not.toHaveBeenCalled();
  });
});
