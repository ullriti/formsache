import {
  ForbiddenException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import type { MembershipSummary, SessionUser } from '@formsache/shared';
import { describe, expect, it } from 'vitest';

import type { AuthContext, AuthenticatedRequest } from './request-context';
import { SuperadminGuard } from './superadmin.guard';

/**
 * The two states the integration suite cannot reach, and one it can reach but
 * only expensively.
 *
 * The load-bearing proof is the pair of integration tests per route — a
 * `admin` of the active Organisation gets 403, a superadmin 200 — because only there is
 * the *real* guard chain assembled. What is added here is the property that
 * chain cannot show: this guard never looks at an organisation. An integration test can
 * only show that by having a superadmin without any membership at all, which it
 * does; the two cases below say the same thing about a request whose session
 * *claims* an active tenant, which is the shape a future second writer to the
 * session (OIDC, an admin tool) would hand in.
 */

const TENANT = '019ff700-0000-7000-8000-00000000000a';

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
      id: '019ff700-0000-7000-8000-0000000000a1',
      name: 'admin',
      color: '#7c0800',
      rank: 100,
      isSystem: true,
    },
    // All five, so nothing below can be mistaken for a missing group right —
    // the fixture trap named elsewhere, applied to a unit test.
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

function sessionUser(options: {
  readonly isSuperadmin: boolean;
  readonly activeTenantId: string | null;
}): SessionUser {
  return {
    id: '019ff700-0000-7000-8000-000000000001',
    email: 'admin@example.org',
    name: 'Administrator Beispiel',
    isSuperadmin: options.isSuperadmin,
    aiFormsAvailable: false,
    memberships: [membership()],
    activeTenantId: options.activeTenantId,
  };
}

function contextFor(auth: AuthContext | undefined): ExecutionContext {
  // `exactOptionalPropertyTypes` is on: an absent `auth` is an absent key,
  // which is the shape of a request before `SessionGuard` ran.
  const request: AuthenticatedRequest =
    auth === undefined ? { headers: {} } : { headers: {}, auth };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('SuperadminGuard', () => {
  it('lets a superadmin through whatever Organisation the session is in', () => {
    const guard = new SuperadminGuard();

    for (const activeTenantId of [TENANT, null]) {
      const context = contextFor({
        sessionId: 's',
        user: sessionUser({ isSuperadmin: true, activeTenantId }),
      });
      expect(guard.canActivate(context)).toBe(true);
    }
  });

  /**
   * The refused case with the **strongest possible** caller: `admin` in the
   * active Organisation, all five group permissions. A test whose refused user happens
   * to hold nothing would only show that some guard fires.
   */
  it('refuses an admin of the active Organisation, all five permissions and all', () => {
    const guard = new SuperadminGuard();
    const context = contextFor({
      sessionId: 's',
      user: sessionUser({ isSuperadmin: false, activeTenantId: TENANT }),
    });

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('refuses a request `SessionGuard` never touched', () => {
    const guard = new SuperadminGuard();

    expect(() => guard.canActivate(contextFor(undefined))).toThrow(
      UnauthorizedException,
    );
  });
});
