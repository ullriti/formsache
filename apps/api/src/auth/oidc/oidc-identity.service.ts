import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { isUniqueViolation } from '../../common/prisma-error';
import { PrismaService } from '../../prisma/prisma.service';
import { membershipInclude, type UserWithMemberships } from '../session-user';
import { maskAddress } from './oidc-diagnostics';

/**
 * Turning a verified ID token into a `user` row — **the account key of this
 * application** (ADR-0012).
 *
 * ## The one rule
 *
 * An OIDC account is found and created over the **pair** *(issuer, subject)*.
 * There is no read path and no write path in this file that uses `sub` alone,
 * and no fallback to one when the pair finds nothing.
 *
 * A `sub` is unique *within* its issuer only (OpenID Connect Core). Across
 * issuers it is an arbitrary string, and in this application every organisation
 * configures **its own** identity provider — so a key on `sub` alone would mean:
 * whoever creates a user with a foreign Mitglied's `sub` in their own
 * Keycloak **becomes** that person, with their memberships, their organisations and
 * possibly their `is_superadmin`. Not a lock to pick; the normal operation of a
 * provider one is allowed to run.
 *
 * The database has carried `@@unique([oidcIssuer, oidcSubject])`. This
 * file is the application that uses it, and it uses it through
 * {@link Prisma.UserWhereUniqueInput}'s composite key rather than through a
 * `findFirst({ where: { … } })`: dropping the issuer from a composite leaves an
 * incomplete key, which is a **type error**, whereas dropping a key from a
 * `where` object still compiles and still returns a row. Same argument as
 * `ScopedGroupDelegate.findById`.
 *
 * ## The issuer is the configured one
 *
 * Every method here takes the issuer the *Organisation* is configured with, never the
 * `iss` a token brought along. The caller ({@link OidcLoginService}) compares
 * the two and refuses when they differ; without that comparison the pair would
 * again be an assertion of the sender, and rule one would buy nothing.
 *
 * ## The first login with an e-mail that already exists
 *
 * ADR-0012 no. 3 decides it, and {@link resolve} implements exactly those three
 * steps. The short version: an account is **never** attached to an e-mail on the
 * strength of the provider's word. Only an invitation — a row somebody with
 * `can_manage_users` created, stamped with the *inviting* organisation's issuer and
 * carrying no credential of its own — can be redeemed, and everything else is
 * refused with an answer that names no account.
 *
 * ## The organisation is part of the condition, not a consequence of the issuer
 *
 * ADR-0012 no. 3 argued that organisation B's provider cannot reach Organisation A's invitation
 * *because* the issuers differ per organisation. Nothing enforced that (`tenant.oidc_issuer`
 * carries no unique index), and the most natural way for an operator to run this
 * — **one Keycloak realm, one client per organisation** — makes every organisation share an
 * issuer, at which point the stamp separates nobody (review finding).
 * ADR-0012 no. 3a decides it: {@link resolve} takes the **Organisation signed in at**
 * and requires a membership in it. See there for the three alternatives and
 * their prices.
 */
@Injectable()
export class OidcIdentityService {
  private readonly logger = new Logger(OidcIdentityService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The person behind a verified ID token — or why there is none.
   *
   * @param issuer the **configured** discovery base of the organisation signed in at
   * @param subject the `sub` claim of the ID token
   * @param verifiedEmail the address claim of this organisation, lower-cased, **only**
   *   when the token also carried `true` in its verification claim — or when
   *   the organisation has deliberately emptied that field; `null`
   *   otherwise. Both claim names are configuration, defaulting to `email` and
   *   `email_verified`. Step 2 is the only step that consults it, and it is the
   *   step that hands out an identity.
   * @param tenantId the organisation whose button was clicked — resolved from the
   *   transaction cookie, never from a token. Step 2 only, for the same reason:
   *   step 1 finds an account that is already bound, and which Organisation somebody
   *   signs in *at* must not decide who they **are**.
   */
  async resolve(
    issuer: string,
    subject: string,
    verifiedEmail: string | null,
    tenantId: string,
  ): Promise<OidcIdentityResult> {
    // Step 1 — the pair. The e-mail is deliberately **not** consulted here: an
    // account that is already bound is found by what it is bound to, and a
    // provider that changed somebody's address must not thereby be able to
    // reach a different row.
    const bound = await this.findByPair(issuer, subject);
    if (bound !== null) {
      return { outcome: 'signed-in', user: bound };
    }

    if (verifiedEmail === null) {
      // No verified address means step 2 is not even expressible. Reported as
      // the same refusal as „keine Einladung": the caller must not learn
      // whether their provider's claim configuration or our records were the
      // problem, and an operator finds the difference in the log line.
      this.logger.warn(
        `OIDC login at issuer ${issuer} carried no verified e-mail claim; an invitation cannot be redeemed without one.`,
      );
      return { outcome: 'no-account' };
    }

    // Step 2 — redeem an invitation, and the `where` **is** the security check.
    //
    // Five conditions, each load-bearing:
    //   `oidcIssuer` — the invitation was stamped with the inviting organisation's
    //                      issuer, so a provider nobody configured cannot reach
    //                      an invitation at all.
    //   `memberships` — **the inviting organisation itself** (ADR-0012 no. 3a). An
    //                      invitation is written together with its membership
    //                      in one transaction (`ScopedMembershipDelegate.
    //                      createOidcInvitation`), so „welcher Organisation hat
    //                      eingeladen" is a row that already exists and needs
    //                      no column of its own. Without this condition the
    //                      separation between two organisations rests entirely on their
    //                      issuers differing — which nothing enforces, and which
    //                      a shared Keycloak realm with one client per organisation
    //                      makes false.
    //   `oidcSubject`    — `null`: an already-claimed invitation is not one.
    //   `passwordHash`   — `null`: **no provider ever reaches a local account.**
    //                      This is what stops any Organisation that may configure an
    //                      issuer from claiming the address of a superadmin who
    //                      signs in with a password.
    //   `email`          — the verified claim, stored lower-cased.
    //
    // `updateMany`, not read-then-write: the condition and the write are one
    // statement, so two callbacks racing each other cannot both see an
    // unclaimed row. The loser updates nothing and falls through to step 1
    // below, where it finds the row the winner bound.
    let claimed: Prisma.BatchPayload;
    try {
      claimed = await this.prisma.user.updateMany({
        where: {
          oidcIssuer: issuer,
          oidcSubject: null,
          passwordHash: null,
          email: verifiedEmail,
          memberships: { some: { tenantId } },
        },
        data: { oidcSubject: subject },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      // `@@unique([oidcIssuer, oidcSubject])` refused the write — another row
      // already holds this pair, which step 1 did not see a moment ago. That is
      // a race, and the index is what decided it, exactly as ADR-0012 no. 3
      // says it should. Re-read rather than guess.
      claimed = { count: 0 };
    }

    if (claimed.count === 0) {
      const raced = await this.findByPair(issuer, subject);
      if (raced !== null) {
        return { outcome: 'signed-in', user: raced };
      }
      // **The quietest refusal of the whole sign-in path** (a review finding).
      // The class comment above already promised "an operator finds the
      // difference in the log line" — for *this* branch the line did not exist.
      // A provider confirmed somebody, the condition found nothing, the browser
      // got `abgelehnt`, and nothing stood in the log. That is the case an
      // operator hits most often when setting things up.
      await this.reportUnredeemable(issuer, verifiedEmail, tenantId);
      return { outcome: 'no-account' };
    }

    const redeemed = await this.findByPair(issuer, subject);
    if (redeemed === null) {
      // The row was updated a statement ago; missing it now means somebody
      // deleted it in between. Refused, not repaired.
      this.logger.warn(
        `OIDC invitation at issuer ${issuer} was claimed and then vanished before it could be read back; refusing.`,
      );
      return { outcome: 'no-account' };
    }
    // No secret, no e-mail, no subject in the line — the ids are what makes it
    // actionable, and an operator needs to be able to see that an invitation
    // was taken up.
    this.logger.log(
      `Invitation redeemed: user ${redeemed.id} is now bound to issuer ${issuer}.`,
    );
    return { outcome: 'signed-in', user: redeemed };
  }

  /**
   * **Which of the five conditions the invitation missed** — into the log,
   * never into an answer.
   *
   * ## Why that is allowed although the answer must not say it
   *
   * ADR-0012 no. 3 step 3 demands that "there is no invitation" and "the
   * address belongs to a local account" look the same on the **outside** —
   * otherwise the sign-in page becomes the directory of the installation. That
   * rule applies to the answer to the browser, and it stays untouched: the
   * caller returns the same `abgelehnt` for every outcome of this method. The
   * server log is the other side of the same decision — there the difference
   * *has* to stand, or the indistinguishability on the outside is no longer a
   * hardening but only blindness in both eyes.
   *
   * ## The price, and why it is bearable
   *
   * Two additional queries, and only on the refusal path. Nobody gets here
   * without having first: presented the transaction cookie, passed the `state`
   * and **successfully signed in** at the provider of the organisation. Whoever
   * can do that can trigger these two queries — and nobody else. An amplifier
   * that is not.
   *
   * The password field is deliberately **not** selected but counted: the hash
   * has no business in any object of this module, and `count` answers the
   * question without loading it.
   */
  private async reportUnredeemable(
    issuer: string,
    address: string,
    tenantId: string,
  ): Promise<void> {
    const masked = maskAddress(address);
    const row = await this.prisma.user.findUnique({
      where: { email: address },
      select: {
        oidcIssuer: true,
        oidcSubject: true,
        memberships: {
          where: { tenantId },
          select: { tenantId: true },
          take: 1,
        },
      },
    });

    const reason = await this.unredeemableReason(row, address, issuer);
    this.logger.warn(
      `OIDC login at issuer ${issuer} for tenant ${tenantId} found no redeemable invitation for ${masked}: ${reason}.`,
    );
  }

  /** The code for {@link reportUnredeemable} — the conditions in their order. */
  private async unredeemableReason(
    row: {
      readonly oidcIssuer: string | null;
      readonly oidcSubject: string | null;
      readonly memberships: readonly unknown[];
    } | null,
    address: string,
    issuer: string,
  ): Promise<string> {
    if (row === null) {
      return 'no account carries this address';
    }
    // Counted instead of selected — see {@link reportUnredeemable}.
    const local = await this.prisma.user.count({
      where: { email: address, passwordHash: { not: null } },
    });
    if (local > 0) {
      // ADR-0012: **no provider ever reaches a local account.** The most
      // frequent case at the first setup — the operator tries SSO with their
      // own superadmin account, which has a password.
      return 'the address belongs to a local account with a password (no provider may claim one)';
    }
    if (row.oidcSubject !== null) {
      return 'the account is already bound to a subject of its issuer (a second provider cannot claim it)';
    }
    if (row.oidcIssuer !== issuer) {
      // The stamp of the inviting organisation. The *foreign* value does not
      // go in with it; which one it is stands in the tenant administration.
      return row.oidcIssuer === null
        ? 'the invitation carries no issuer stamp'
        : 'the invitation was stamped with a different issuer';
    }
    if (row.memberships.length === 0) {
      // ADR-0012 no. 3a: the invitation belongs to another organisation, even
      // when both use the same sign-in service.
      return 'the invitation belongs to another organisation (no membership in the one signed in at)';
    }
    return 'the conditions were met a moment ago; the row changed under the statement';
  }

  /**
   * The pair lookup, spelled once.
   *
   * `oidcIssuer_oidcSubject` is the composite Prisma generated from the
   * underlying index. There is no overload of this that takes a subject alone.
   */
  private findByPair(
    issuer: string,
    subject: string,
  ): Promise<UserWithMemberships | null> {
    return this.prisma.user.findUnique({
      where: {
        oidcIssuer_oidcSubject: { oidcIssuer: issuer, oidcSubject: subject },
      },
      include: membershipInclude,
    });
  }
}

/**
 * What {@link OidcIdentityService.resolve} decided.
 *
 * `no-account` is one outcome for two situations on purpose — there is no
 * invitation, or the address belongs to a local account. ADR-0012 no. 3 step 3:
 * the two must read identically, or a login page becomes a directory of who has
 * an account in this installation.
 */
export type OidcIdentityResult =
  | { readonly outcome: 'signed-in'; readonly user: UserWithMemberships }
  | { readonly outcome: 'no-account' };
