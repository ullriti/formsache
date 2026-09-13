import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { LoginRequest, SessionUser } from '@formsache/shared';

import { PrismaService } from '../prisma/prisma.service';
import { DUMMY_PASSWORD_HASH } from './dummy-password-hash';
import { verifyPassword } from './password';
import { SessionFeaturesService } from './session-features.service';
import { SessionService } from './session.service';
import { membershipInclude, toSessionUser } from './session-user';

/**
 * The single answer to every failed login.
 *
 * One message, one status, for a wrong password *and* for an e-mail that does
 * not exist *and* for an account that only authenticates through OIDC. The
 * requirement asks for no hint about whether the address exists — which
 * means the reply has to be identical byte for byte, not merely similar.
 */
export const INVALID_CREDENTIALS_MESSAGE = 'E-Mail oder Passwort ist falsch.';

/** What a successful login hands the controller. */
export interface LoginResult {
  readonly user: SessionUser;
  /** Raw session token — belongs into the cookie and nowhere else. */
  readonly token: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    /** The features of the session payload — one place, three callers. */
    private readonly features: SessionFeaturesService,
  ) {}

  /**
   * Verifies credentials and opens a session.
   *
   * The shape of this method is dictated by timing, not by readability: the
   * Argon2id verification runs on *every* path, including the one where no
   * user was found. An early `return` for the unknown e-mail would answer in a
   * millisecond where a known one takes tens of them, and that difference is
   * an account-enumeration oracle across the network — the exact leak the
   * requirement forbids, just measured with a clock instead of read from the body.
   */
  async login(credentials: LoginRequest): Promise<LoginResult> {
    // Not tenant-scoped by design: `user` has no `tenant_id`, because the same
    // person serves several Organisationen (schema.prisma). The tenant boundary comes
    // from the memberships loaded here, never from the user row itself.
    // The e-mail is already trimmed and lower-cased by `loginRequestSchema`,
    // and stored lower-cased — so the unique index *is* the case-insensitive
    // comparison.
    const user = await this.prisma.user.findUnique({
      where: { email: credentials.email },
      include: membershipInclude,
    });

    // `??` covers both misses that must not be distinguishable: no such user,
    // and a user who authenticates through OIDC and has no password at all.
    const storedHash = user?.passwordHash ?? DUMMY_PASSWORD_HASH;
    const passwordMatches = await verifyPassword(
      storedHash,
      credentials.password,
    );

    if (user === null || !passwordMatches) {
      // The `user === null` half is redundant — nothing verifies against the
      // dummy hash — and stays in anyway: it makes the invariant explicit
      // instead of resting on the strength of a constant.
      throw new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE);
    }

    const activeTenantId = deriveActiveTenant(user.memberships);
    const { token } = await this.sessions.issue(user.id, activeTenantId);

    return {
      user: toSessionUser(
        user,
        activeTenantId,
        await this.features.forTenant(activeTenantId),
      ),
      token,
    };
  }
}

/**
 * Which tenant a fresh session works in.
 *
 * Exactly one membership means there is nothing to choose, so choosing it is a
 * convenience rather than a decision. Anything else — none, or several — stays
 * `null`, which means *no tenant scope*, never "all tenants". Picking one for
 * a person with several would silently prefer an organisation; picking one for a
 * superadmin without a membership would be the very cross-tenant access the
 * rule forbids. The switcher of the next wave sets the value explicitly, and has to
 * verify the membership when it does.
 *
 * **Exported, and that is the point of it.** The OIDC login needs
 * the same answer and had written it out a second time
 * (`oidc/oidc-login.service.ts`, review finding). Two copies of a *session
 * scope* rule drift exactly where a wrong answer reads „alle Organisationen", so there is
 * one, and the SSO path wraps it instead of restating it.
 */
export function deriveActiveTenant(
  memberships: readonly { tenantId: string }[],
): string | null {
  const [only] = memberships;
  return memberships.length === 1 && only !== undefined ? only.tenantId : null;
}
