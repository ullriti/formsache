import { Inject, Injectable } from '@nestjs/common';
import type { ApiEnv } from '@formsache/shared';

import { API_ENV } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthContext } from './request-context';
import { SessionFeaturesService } from './session-features.service';
import { digestSessionToken, mintSessionToken } from './session-token';
import { membershipInclude, toSessionUser } from './session-user';

const SECONDS_PER_HOUR = 3600;
const MILLISECONDS_PER_SECOND = 1000;

/**
 * How stale `last_seen_at` may get before a request refreshes it.
 *
 * Without a threshold every authenticated request would write a row — an
 * `UPDATE` per `GET`, which is the kind of write amplification that only shows
 * up under load. A minute is precise enough for "when was this session last
 * used" and turns the write into a rarity.
 */
const LAST_SEEN_REFRESH_MS = 60_000;

/** A freshly issued session: the raw token exists only here and in the reply. */
export interface IssuedSession {
  readonly token: string;
  readonly expiresAt: Date;
}

/**
 * Server-side session lifecycle: issue, authenticate, revoke.
 *
 * Split out from `AuthService` because `SessionGuard` needs exactly this and
 * nothing of the login — and the guard chain of the next wave builds on the
 * guard.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(API_ENV) private readonly env: ApiEnv,
    /** Only for the features of the payload. */
    private readonly features: SessionFeaturesService,
  ) {}

  /** Session lifetime in seconds — the cookie's `Max-Age` is this same value. */
  get ttlSeconds(): number {
    return this.env.SESSION_TTL_HOURS * SECONDS_PER_HOUR;
  }

  /**
   * Creates a session row and returns the token that unlocks it.
   *
   * The caller decides `activeTenantId`; it must never be a tenant the user
   * holds no membership in.
   */
  async issue(
    userId: string,
    activeTenantId: string | null,
    now: Date = new Date(),
  ): Promise<IssuedSession> {
    const token = mintSessionToken();
    const expiresAt = new Date(
      now.getTime() + this.ttlSeconds * MILLISECONDS_PER_SECOND,
    );

    await this.prisma.session.create({
      data: {
        // Only the digest is persisted — never `token`.
        tokenHash: digestSessionToken(token),
        userId,
        activeTenantId,
        expiresAt,
      },
    });

    return { token, expiresAt };
  }

  /**
   * Resolves a presented token into the signed-in person, or `null`.
   *
   * `null` covers every failure alike: no such session, revoked, expired.
   * The caller answers 401 in all three cases and never says which it was.
   */
  async authenticate(
    token: string,
    now: Date = new Date(),
  ): Promise<AuthContext | null> {
    // Not tenant-scoped, and it must not be: this is the query that *derives*
    // the tenant scope. `session` and `user` carry no `tenant_id` by design
    // (schema.prisma) — the boundary is drawn from the membership list loaded
    // here, by the guard chain that runs after this one.
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: digestSessionToken(token) },
      include: { user: { include: membershipInclude } },
    });

    if (session === null) {
      return null;
    }
    // Logout is a server-side state change, not a hint to the client: a
    // replayed cookie hits this row and is refused.
    if (session.revokedAt !== null) {
      return null;
    }
    if (session.expiresAt.getTime() <= now.getTime()) {
      return null;
    }

    await this.touch(session.id, session.lastSeenAt, now);

    return {
      sessionId: session.id,
      // `session.activeTenantId` goes in as a *claim*: `toSessionUser` keeps it
      // only while the membership list loaded above still covers it, and drops
      // it to null otherwise. A membership revoked while this
      // session lives therefore takes the scope with it on the next request.
      user: toSessionUser(
        session.user,
        session.activeTenantId,
        await this.features.forTenant(session.activeTenantId),
      ),
    };
  }

  /**
   * Moves a session into a tenant — the write behind the tenant switcher.
   *
   * **The caller must have verified the membership first.** This method does
   * not, and cannot honestly: it is handed a session id, not a request, and a
   * check bolted on here would be a second opinion next to the one the switcher
   * already has to form. `TenantSwitchService` is the only caller and does the
   * check against the database.
   *
   * Nothing rests on that promise alone, though. Writing a tenant here does not
   * *grant* anything: `TenantScopeGuard` re-derives the scope from the
   * memberships of every following request, so a value written past the check
   * — by a bug, or straight into the table — buys no access.
   *
   * Constrained to an unrevoked session for the same reason `touch` is: a
   * logout racing this update must not leave a revoked row looking freshly
   * used.
   */
  async setActiveTenant(
    sessionId: string,
    activeTenantId: string | null,
  ): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { activeTenantId },
    });
  }

  /**
   * Marks a session as revoked. Idempotent, and silent about whether the token
   * matched anything — logout must not become an oracle for valid tokens.
   */
  async revoke(token: string, now: Date = new Date()): Promise<void> {
    // `updateMany`, not `update`: a token that matches no row is not an error
    // here, and `update` would throw for it.
    await this.prisma.session.updateMany({
      where: { tokenHash: digestSessionToken(token), revokedAt: null },
      data: { revokedAt: now },
    });
  }

  /**
   * Ends **all other** sessions of this person and answers how many there were
   * (a review finding).
   *
   * ## Why this route exists
   *
   * Before, a leaked password was not revocable with the means of the
   * application: changing the password did not help, because an existing
   * session carries its own token and keeps running. All that remained was
   * waiting until it expires — up to 720 hours (`SESSION_TTL_HOURS`).
   *
   * ## Why "other" and not "all"
   *
   * Whoever signs themselves out along with the rest does not know afterwards
   * whether it took effect: the page falls back to the sign-in, and the foreign
   * session would be gone just as much as one's own, but nobody would see it.
   * Leaving one's own session out turns the act into a **confirmation** („3
   * Sitzungen beendet") that one reads while staying signed in.
   *
   * ## Revoke, not delete
   *
   * `revoked_at` instead of `deleteMany` — the same construction as the signing
   * out. The clean-up run over dead rows takes them along seven days later
   * (`SESSION_RETENTION_DAYS`, a review finding); until then "this session was
   * ended" is still an answerable question.
   */
  async revokeOthers(
    userId: string,
    keepSessionId: string,
    now: Date = new Date(),
  ): Promise<number> {
    const { count } = await this.prisma.session.updateMany({
      where: { userId, id: { not: keepSessionId }, revokedAt: null },
      data: { revokedAt: now },
    });
    return count;
  }

  /**
   * Ends **every** session of a person — the enforced way.
   *
   * For the case the self-service above does not cover: somebody has lost their
   * device and can no longer get at any session, or an account has to stand
   * still immediately. Who may do that is decided by the route
   * (`canManageUsers` in one's own Organisation), not by this method.
   *
   * ⚠️ **Sessions are not organisation-bound.** Whoever ends them ends the work
   * of this person in every *other* Organisation they are a member of as well.
   * That is no side effect but the point of a revocation — but it stands here
   * so that nobody takes it for an organisation-local act.
   */
  async revokeAllOf(userId: string, now: Date = new Date()): Promise<number> {
    const { count } = await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    });
    return count;
  }

  private async touch(
    sessionId: string,
    lastSeenAt: Date,
    now: Date,
  ): Promise<void> {
    if (now.getTime() - lastSeenAt.getTime() < LAST_SEEN_REFRESH_MS) {
      return;
    }
    // Still constrained to an unrevoked session: a logout racing this update
    // must not resurrect the row's `last_seen_at` as if it were in use.
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { lastSeenAt: now },
    });
  }
}
