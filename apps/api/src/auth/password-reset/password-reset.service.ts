import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  PASSWORD_RESET_INVALID_MESSAGE,
  PASSWORD_RESET_TTL_MINUTES,
  effectiveReplyTo,
} from '@formsache/shared';
import { SigningService } from '../../common/secret-box/signing.service';
import { MailClock } from '../../mail/mail-clock';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemMailSettingsService } from '../../system-settings/system-mail-settings.service';
import { hashPassword } from '../password';
import { invalidateOpenTokens } from './password-reset-invalidation';
import {
  PASSWORD_RESET_SUBJECT,
  passwordResetMailBody,
} from './password-reset-mail';
import { PasswordResetAddressLimiter } from './password-reset-rate-limit';
import {
  digestPasswordResetToken,
  mintPasswordResetToken,
} from './password-reset-token';

const MS_PER_MINUTE = 60_000;

/**
 * How long a request takes **at least**.
 *
 * The answer is the same for every address — same status code, no body
 * (see {@link PasswordResetService.request}). What would still be
 * distinguishable after that is the **time**: the hit writes two rows and reads
 * the sender identity of the organisation, the miss nothing. On a fast
 * connection those are measurable milliseconds, and a measuring device is a
 * disclosure.
 *
 * That is why **every** branch waits up to this floor. Not "up to a random
 * time" — noise can be averaged away, a floor cannot — and not longer than
 * necessary: 400 ms are amply above the spread of the database work
 * and lie below what someone perceives as hanging.
 *
 * ⚠️ **The floor protects only as long as it lies above the real work.** A
 * request that takes longer under load sticks out above it and becomes
 * measurable again. That is the named remainder of this measure; it could be
 * made smaller only by moving the mail entirely out of the request path — a
 * decision of its own with a price of its own (then every error disappears
 * silently).
 */
export const PASSWORD_RESET_FLOOR_MS = 400;

/**
 * „Passwort vergessen" — requesting and redeeming (ADR-0020).
 *
 * ## What holds this class together
 *
 * Five promises, and each of them stands below at exactly one place:
 *
 * 1. **No account enumeration.** {@link request} always answers the same: 204,
 *    no body, no difference between "exists", "does not exist", "signs
 *    in via SSO" and "belongs to no organisation". An *error* makes no
 *    difference either — it is logged and swallowed, because a
 *    500 could arise only on the hit branch and would therefore be the
 *    disclosure that everything else avoids. And the runtime is laid on a
 *    floor ({@link PASSWORD_RESET_FLOOR_MS}).
 * 2. **The token stands nowhere.** It arises from the id of the row and
 *    the installation key; the database knows only its SHA-256, and
 *    the body of the mail carries a marker instead of the address
 *    (`password-reset-token.ts`).
 * 3. **Once.** Redeeming is a condition in the `WHERE` of the same
 *    statement that sets `used_at` — two simultaneous redemptions are one
 *    success and one failure, never two successes.
 * 4. **Every password change devalues everything open.** Here on redeeming, and
 *    likewise on the two other paths (`ProfileService.changePassword`,
 *    `ScopedMembershipDelegate.setPassword`) — that is why
 *    `invalidateOpenTokens` stands in `password-reset-invalidation.ts` and not
 *    as a private method here. The docblock there names all four callers; it
 *    stood once in this file and promised "one version", while the fourth
 *    caller copied the statement (a review finding).
 * 5. **Only local accounts.** An SSO account has nothing to reset here; the
 *    condition stands in the `WHERE` of the write, not in an `if` in front of
 *    it. "Local" has meant `oidc_issuer IS NULL AND oidc_subject IS NULL`
 *    since ADR-0024 and no longer "has a password" — a freshly invited account
 *    does not have one yet and **shall** get in here; a provider account has
 *    no way in with this version either.
 *
 * ## Why `PrismaService` and not a `TenantScope`
 *
 * There is no caller with an organisation: whoever knocks here is not
 * signed in, and `user` carries no `tenant_id` anyway — the address is
 * unique installation-wide (ADR-0012). `apps/api/src/auth/**` stands for that
 * on the exception list of `eslint.config.js`, with the same reasoning as
 * signing in itself.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  /** The counter per address — see `password-reset-rate-limit.ts`. */
  private readonly addresses = new PasswordResetAddressLimiter();

  constructor(
    private readonly prisma: PrismaService,
    private readonly signing: SigningService,
    /**
     * The clock of the queue, not `new Date()`: `mail_log.created_at`
     * is set by it (the reasoning stands at `TestMailService.send`),
     * and two calendars on one column are the mistake that `mail-clock.ts`
     * calls by name.
     */
    private readonly clock: MailClock,
    /** Only for the lowest level of the `Reply-To` chain. */
    private readonly systemSettings: SystemMailSettingsService,
  ) {}

  /**
   * "I have forgotten my password."
   *
   * **Always** answers without disclosure — see the promises in the class
   * comment. The return value is `void` and deliberately does not even carry a
   * "sent: yes/no": a value that the caller *could* pass on is a channel
   * that someone eventually passes on.
   */
  async request(email: string): Promise<void> {
    const startedAt = Date.now();
    try {
      await this.tryIssue(email);
    } catch (error: unknown) {
      // **Error class, never the message, never the address** — the same rule
      // as in the cleanup runs. And swallowed instead of passed on: a 500
      // would arise only where the account exists.
      this.logger.error(
        `password reset request failed: ${
          error instanceof Error ? error.constructor.name : 'unknown error'
        }`,
      );
    } finally {
      await settleAt(startedAt + PASSWORD_RESET_FLOOR_MS);
    }
  }

  /**
   * "Here is my link, this is my new password."
   *
   * Throws the **one** refusal for every failure — unknown, expired,
   * already used, someone else's account, SSO account. Whoever presents a value
   * that they do not have learns nothing about which one they almost had.
   */
  async confirm(token: string, password: string): Promise<void> {
    if (!looksLikeResetToken(token)) {
      // **The shape check stands before Argon2id, and it is no timing channel**
      // (a security finding): it describes a property of the value that
      // the sender wrote themselves, and says nothing about an account.
      //
      // What it prevents is the amplification: without it every
      // knock attempt with "x" costs 19 MiB and two Argon2id runs on the
      // libuv pool that the whole process shares. A value that cannot be a
      // token *at all* need not pay for that — and a value that could be one
      // keeps paying the same amount on every path.
      throw new BadRequestException(PASSWORD_RESET_INVALID_MESSAGE);
    }

    // **Hashed before the lookup, and that is deliberate.** Argon2id is the
    // most expensive ingredient of this call; if it ran only on the success
    // path, an invalid token could be recognised by the response time. The
    // price is one hash computation for every knock attempt — the limit per
    // origin stands at the route and is there for exactly that.
    const passwordHash = await hashPassword(password);
    const tokenHash = digestPasswordResetToken(token);
    const now = new Date();

    let userId: string;
    try {
      userId = await this.prisma.$transaction(async (tx) => {
        // **The condition and the write are one statement.**
        // Read-then-write would let two simultaneous redemptions both see the
        // open row; this way one of the two loses at the counter.
        const claimed = await tx.passwordResetToken.updateMany({
          where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
          data: { usedAt: now },
        });
        if (claimed.count !== 1) {
          throw new PasswordResetRefused();
        }

        const row = await tx.passwordResetToken.findUnique({
          where: { tokenHash },
          select: { userId: true },
        });
        if (row === null) {
          // A row that this transaction has just written cannot be
          // missing here. Checked nonetheless instead of asserted — and with
          // the same refusal, not with a 500.
          throw new PasswordResetRefused();
        }

        // **Only a local account**, and the condition stands in the `WHERE`.
        //
        // Until ADR-0024 it read `password_hash IS NOT NULL AND
        // oidc_subject IS NULL`. The first half excluded the unclaimed
        // SSO invitation **indirectly** (it has no password) and, since the
        // invitation of local accounts, excludes too much: redeeming an
        // invitation is exactly the setting of the **first** password. What
        // keeps the provider away are the two OIDC columns, and they now say
        // it directly — `oidc_issuer IS NULL` catches the unclaimed
        // invitation, `oidc_subject IS NULL` the bound account. An `if`
        // in front of it would have checked the same and would be forgetful;
        // this way there is no statement that *could* hit such a row.
        //
        // The **kind** of the token deliberately does not stand in this
        // condition: there is no path that would be allowed for an invitation
        // and not for a reset. What distinguishes the two is the deadline, and
        // that stands in `expires_at` — one statement further up, in the
        // `WHERE` of the claiming.
        const updated = await tx.user.updateMany({
          where: {
            id: row.userId,
            oidcIssuer: null,
            oidcSubject: null,
          },
          data: { passwordHash },
        });
        if (updated.count !== 1) {
          // The account has meanwhile been bound to a provider (or
          // always was). The whole transaction rolls back — the link stays
          // formally open and is nonetheless not redeemable, which is the more
          // honest situation than "used up without anything happening".
          throw new PasswordResetRefused();
        }

        // **All sessions end.** A reset password that leaves a running
        // session of the intruder standing is no revocation,
        // but a second key next to the old one.
        await tx.session.updateMany({
          where: { userId: row.userId, revokedAt: null },
          data: { revokedAt: now },
        });
        await invalidateOpenTokens(tx, row.userId, now);
        return row.userId;
      });
    } catch (error: unknown) {
      if (error instanceof PasswordResetRefused) {
        throw new BadRequestException(PASSWORD_RESET_INVALID_MESSAGE);
      }
      throw error;
    }

    // No address, no name — the id suffices to find a case
    // again, and names nobody.
    this.logger.log(`password reset redeemed for user ${userId}`);
  }

  /**
   * The hit branch of {@link request} — or nothing at all.
   *
   * Every refusal is a `return` here, not an error: the route has the same
   * answer for all of them, and an exception would be a difference that someone
   * measures.
   */
  private async tryIssue(email: string): Promise<void> {
    if (!this.addresses.allow(email)) {
      // Quota of this address exhausted — silently, never as a 429 (see
      // `password-reset-rate-limit.ts`).
      return;
    }

    // Not organisation-bound, and that is no omission here: `user`
    // carries no `tenant_id` (schema.prisma), the address is
    // unique installation-wide, and there is no caller with an
    // organisation. The same query as when signing in.
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        name: true,
        email: true,
        oidcIssuer: true,
        oidcSubject: true,
        memberships: {
          // The **oldest living** membership decides under whose
          // sender the mail goes out: a row in `mail_log` needs an
          // organisation (`tenant_id` is NOT NULL), and picking any one
          // would be a coin toss. The oldest is the one in which the account
          // came into being — the same one whose administration created it.
          //
          // The deleted one stands **in the `where`** and not in a check
          // afterwards: otherwise someone whose first organisation lies in the
          // trash would get no mail any more, although they keep working in a
          // second one — the queue holds mail for a deleted
          // organisation back anyway (`NOT_IN_TRASH`).
          where: { tenant: { deletedAt: null } },
          orderBy: { createdAt: 'asc' },
          take: 1,
          select: {
            tenant: { select: { id: true, name: true, replyTo: true } },
          },
        },
      },
    });

    // No account, or an account that a provider decides about — bound
    // or with an open SSO invitation: there is nothing to reset, and the
    // answer does not say so.
    //
    // **`passwordHash` has not been part of the condition since ADR-0024.** It
    // stood there to exclude the unclaimed SSO invitation; that is now done
    // by `oidcIssuer` directly and more sharply. What is thereby **added**
    // is intended: a person whose invitation has expired can help themselves
    // via „Passwort vergessen" instead of depending on
    // someone sending them the invitation again. The proof is
    // the same as always — the access to their mailbox —, and what they
    // subsequently set is their **first** password instead of a new one.
    //
    // The optional chain handles "no account" along with it: `undefined !==
    // null` is true, so a miss takes the same exit as a provider account
    // — which is exactly the promise (one exit, one floor).
    if (user?.oidcIssuer !== null || user.oidcSubject !== null) {
      return;
    }

    // An account without a living organisation has no sender — and the
    // application would have nowhere to let it in afterwards either.
    const tenant = user.memberships[0]?.tenant;
    if (tenant === undefined) {
      return;
    }

    const minted = mintPasswordResetToken(this.signing);
    const expiresAt = new Date(
      Date.now() + PASSWORD_RESET_TTL_MINUTES * MS_PER_MINUTE,
    );
    /**
     * **The reply address of the installation, not that of the organisation**
     * (ADR-0020).
     *
     * `replyToDefaults` asks the organisation first and then the installation —
     * right for a form confirmation, wrong for this mail: `reply_to`
     * is set by whoever has `can_manage_settings`, and a security mail that
     * says "reply here" to an address set from there is an
     * invitation to follow up. The same line as with sender and
     * base address: at a system mail no organisation determines anything.
     */
    const replyTo = effectiveReplyTo([
      { origin: 'system', value: await this.systemSettings.replyTo() },
    ]).address;
    const stampedAt = this.clock.now();

    await this.prisma.$transaction(async (tx) => {
      // **The most recently requested link applies.** Older open rows of the
      // same person are devalued before the new one comes into being: three
      // links in three mailboxes are three windows, and whoever clicks twice
      // means the second one. The price is named — whoever opens the first mail
      // later gets the one refusal and requests anew.
      await invalidateOpenTokens(tx, user.id, stampedAt);

      const mail = await tx.mailLog.create({
        data: {
          tenantId: tenant.id,
          recipient: user.email,
          subject: PASSWORD_RESET_SUBJECT,
          // The body carries the **marker**, never the address — see
          // `password-reset-mail.ts`.
          bodyText: passwordResetMailBody(user.name, tenant.name),
          replyTo,
          status: 'queued',
          // **System mail, and that is a security condition** (ADR-0020):
          // on this value hangs that the row goes out under the identity of the
          // *installation* and builds its link from that one's base address —
          // both things that otherwise someone with `can_manage_settings`
          // could determine, so exactly the right that `requireOwnAccount`
          // keeps away from this account.
          trigger: 'system',
          // The clock of the queue, as on every other enqueue path.
          createdAt: stampedAt,
        },
        select: { id: true },
      });

      await tx.passwordResetToken.create({
        data: {
          // The id comes along — it **is** the signed message.
          id: minted.id,
          // Written out instead of leaving it to the column default (ADR-0024):
          // since there are two kinds, it shall stand at the writing place which
          // one arises here — and not in `schema.prisma`.
          kind: 'reset',
          userId: user.id,
          tokenHash: minted.tokenHash,
          expiresAt,
          mailLogId: mail.id,
        },
      });
    });
  }
}

/**
 * Does this value even have the shape of a reset token?
 *
 * base64url over 32 bytes without padding characters — 43 characters from
 * `[A-Za-z0-9_-]`, just as `SigningService.sign` produces them. The check is
 * exact and not generous: a generous one would let through exactly the values
 * it is there for.
 *
 * ⚠️ **It is no check of validity.** A well-formed token that does
 * not exist takes the same path as an expired one — through Argon2id and into
 * the same one refusal.
 */
function looksLikeResetToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/u.test(token);
}

/** The one refusal, thrown inside the transaction so that it rolls back. */
class PasswordResetRefused extends Error {}

/** Waits until the point in time is reached — or not at all, if it has passed. */
async function settleAt(deadline: number): Promise<void> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return;
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, remaining);
  });
}
