import {
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { isUniqueViolation } from '../common/prisma-error';
import { PrismaService } from '../prisma/prisma.service';
import { invalidateOpenTokens } from './password-reset/password-reset-invalidation';
import { hashPassword, verifyPassword } from './password';
import { SessionFeaturesService } from './session-features.service';
import { SessionService } from './session.service';
import { membershipInclude, toSessionUser } from './session-user';
import type { SessionUser } from '@formsache/shared';

/**
 * What a successful password change owes the caller.
 *
 * Both are transport: the token belongs in a `Set-Cookie` and nowhere else (the
 * same rule as when signing in), and the number in the confirmation. There is
 * deliberately no response schema for it — what the browser needs stands in the
 * header, and the number is a sentence, not a document.
 */
export interface PasswordChangeResult {
  /** The **new** session of this device — raw, only for the cookie. */
  readonly token: string;
  /** How many sessions the change ended, one's own included. */
  readonly revoked: number;
}

/** What a wrong „aktuelles Passwort" is answered with — and nothing else. */
export const CURRENT_PASSWORD_WRONG_MESSAGE =
  'Das aktuelle Passwort ist falsch.';

/**
 * An account that cannot set its password itself, because it has none.
 *
 * No secret: whoever asks here is signed in and **is** this account. The
 * sentence therefore says what is actually the case, instead of hiding behind
 * „falsches Passwort" — the obfuscation belongs on the routes that answer
 * *strangers*.
 */
export const OIDC_ACCOUNT_HAS_NO_PASSWORD_MESSAGE =
  'Dieses Konto meldet sich über Single Sign-on an und hat kein Passwort in ' +
  'Formsache. Ihr Passwort ändern Sie beim Anmeldedienst Ihrer Organisation.';

/**
 * An SSO account does **not** change its address here (finding 8, ADR-0012).
 *
 * Two reasons, and both hold independently of each other:
 *
 * 1. **There is nothing with which the change could be paid for.** The address
 *    change is an account takeover and therefore demands the current password
 *    ({@link CURRENT_PASSWORD_WRONG_MESSAGE}) — an account without a local
 *    password cannot furnish that proof. Replacing it with „the session is open,
 *    after all" would mean opening for SSO accounts exactly the gap that the
 *    query closes for everyone else.
 * 2. **The address is not ours there.** With a bound account it is a reflection
 *    of what the login service reports, and with an invitation that has not yet
 *    been redeemed it is the condition under which it is redeemed (ADR-0012
 *    no. 3) — rewriting it would divert the invitation to a different person. At
 *    the next sign-in the provider's address would stand there again anyway.
 *
 * The organisation administration already draws the same line
 * (`users.service.ts`, `requireOwnAccount(…, 'email')`) — there with its own
 * wording, because it speaks about *somebody else*. An import across the layers
 * would have been the price for `auth` depending on `tenant-admin`; that is the
 * wrong direction for one sentence of text.
 */
export const OIDC_ACCOUNT_EMAIL_MESSAGE =
  'Dieses Konto meldet sich über Single Sign-on an. Die E-Mail-Adresse wird ' +
  'beim Anmeldedienst Ihrer Organisation gepflegt und kann hier nicht ' +
  'geändert werden.';

/**
 * The address already belongs to somebody — `user.email @unique`, answered
 * readably.
 *
 * 409 and not 500: the request is well-formed, it merely collides with a state
 * that the sender can change. Without this translation the raw `P2002` would
 * reach the caller as a 500 with an index name in it.
 *
 * ⚠️ **That is information about somebody else's row** — „this address already
 * exists here". The price is deliberately paid and the same one the member
 * administration pays: without it the refusal would not be explainable and the
 * action not repairable. The route stands behind a session and behind the
 * current password, and both together make it a very expensive way to query an
 * address directory.
 */
export const EMAIL_TAKEN_MESSAGE =
  'Diese E-Mail-Adresse gehört bereits zu einem anderen Konto.';

/**
 * The **own** profile: change name, change e-mail address, change password
 * (findings 8, 12 and 17).
 *
 * ## Why this is a class of its own and not `TenantUsersService`
 *
 * Because here nobody decides about somebody else. The member administration is
 * a permission (`can_manage_users`) that an organisation grants, and all its
 * care goes to the question whose account somebody touches. This class does not
 * have that question: the id comes from the session, never from a path or body,
 * and there is no parameter in which a foreign one could stand. That is the
 * reason why no organisation boundary is checked here — there is none to cross.
 *
 * ## What changing the password takes along: **everything** (a security finding)
 *
 * A password change ends **every** session of this person — on all three ways of
 * this application, and here it was not so at first.
 *
 * The first version left the other sessions standing, with the argument that the
 * frequent case is „ich wechsle turnusmäßig" and five signed-out devices would
 * be a surprise. The argument holds for the frequent case and is wrong for the
 * expensive one: **whoever notices a takeover changes their password first** — and
 * precisely then the most obvious reflex achieved nothing at all, because the
 * intruder's session token knows no password and keeps running for up to 720
 * hours (`SESSION_TTL_HOURS`). Three ways with two behaviours are moreover a
 * promise that one cannot write down.
 *
 * **One's own session falls with them — and is replaced.** The revocation also
 * hits the token the request came with; the response therefore carries a *fresh*
 * session cookie ({@link PasswordChangeResult}). Whoever changes their password
 * stays signed in on this device and is signed out everywhere else — exactly the
 * statement the action is supposed to make.
 *
 * Open reset links are invalidated in the same transaction: a link that survives
 * a password change is a second key next to the lock that has just been changed.
 *
 * ---------------------------------------------------------------------------
 * **`PrismaService` here is the exception list of `eslint.config.js` for
 * `apps/api/src/auth/**`, used the way it is meant:** there is no organisation
 * parameter and no organisation-bound row — `user` carries no `tenant_id`, and
 * the only id that occurs here is that of the signed-in person.
 * ---------------------------------------------------------------------------
 */
@Injectable()
export class ProfileService {
  private readonly logger = new Logger(ProfileService.name);

  constructor(
    private readonly prisma: PrismaService,
    /** Only for the flags of the session payload — as in `AuthService`. */
    private readonly features: SessionFeaturesService,
    /**
     * For the **replacement session** after a password change: the revocation
     * also hits one's own token, and whoever changes their password should stay
     * signed in on this device.
     */
    private readonly sessions: SessionService,
  ) {}

  /**
   * Changes one's own name and answers with the **whole** `SessionUser`.
   *
   * The whole user and not only the name, for the same reason as with the
   * organisation switch: the header, the member list and the flags hang on this
   * one document, and a client that patches up the cached state by hand invents
   * a state that the server never confirmed.
   */
  async updateName(
    userId: string,
    activeTenantId: string | null,
    name: string,
  ): Promise<SessionUser> {
    await this.prisma.user.update({ where: { id: userId }, data: { name } });
    return this.reload(userId, activeTenantId);
  }

  /**
   * Changes one's own **e-mail address** — with a check of the password
   * (finding 8).
   *
   * ## Why the password stands here and not with the name
   *
   * Because the address is the sign-in key. Whoever changes it diverts the
   * sign-in and every „Passwort vergessen" link of this account to a different
   * mailbox — that is a **takeover**, not master-data maintenance, and the
   * reflex it protects against is the same as with {@link changePassword}: an
   * unattended computer with an open session. Without the query the password
   * query there would also be circumventable — bend the address, press
   * „Passwort vergessen", read the mailbox.
   *
   * ## What goes along: the open reset links
   *
   * In the **same** transaction, and that is no accessory: an open link was sent
   * to the **old** address. If it survived the change, the old mailbox would
   * still have a second key to this account after the change — exactly the sort
   * of access an address change is supposed to end.
   *
   * ## What does **not** go along: the sessions
   *
   * Unlike with the password change. An address is not an access: it opens
   * nothing without the password that has just been shown. Signing out all
   * devices would be a side effect without a security gain here — and whoever
   * wants it has the button next to it.
   */
  async changeEmail(
    userId: string,
    activeTenantId: string | null,
    currentPassword: string,
    email: string,
  ): Promise<SessionUser> {
    const account = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, passwordHash: true, oidcIssuer: true },
    });
    if (account === null) {
      // As above: the session names a person who no longer exists.
      throw new UnauthorizedException(CURRENT_PASSWORD_WRONG_MESSAGE);
    }
    // **Before** the password check, because there is nothing to obfuscate
    // here: whoever asks is signed in and *is* this account. „Falsches Passwort"
    // for an account that has none at all would be a dead end without an
    // explanation.
    if (account.oidcIssuer !== null || account.passwordHash === null) {
      throw new UnprocessableEntityException(OIDC_ACCOUNT_EMAIL_MESSAGE);
    }
    if (!(await verifyPassword(account.passwordHash, currentPassword))) {
      throw new UnauthorizedException(CURRENT_PASSWORD_WRONG_MESSAGE);
    }

    if (account.email === email) {
      // The same address once more: nothing to write, nothing to invalidate —
      // and above all no reset link that dies for a change that was none at
      // all.
      return this.reload(userId, activeTenantId);
    }

    const now = new Date();
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: userId }, data: { email } });
        await invalidateOpenTokens(tx, userId, now);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(EMAIL_TAKEN_MESSAGE);
      }
      throw error;
    }

    // Without the addresses themselves — the id suffices, and a log that keeps
    // both addresses next to each other would be a change-of-address register.
    this.logger.log(`e-mail address changed by user ${userId}`);
    return this.reload(userId, activeTenantId);
  }

  /**
   * Changes one's own password — **with a check of the old one**.
   *
   * The check is the boundary and not a courtesy: without it an unattended
   * computer with an open session would be an account that the next person takes
   * over for good (an attacker sets a new password and ends all other sessions —
   * the rightful person would no longer get in).
   *
   * Order: read first, then verify, then write and invalidate in **one**
   * transaction.
   */
  async changePassword(
    userId: string,
    activeTenantId: string | null,
    currentPassword: string,
    newPassword: string,
  ): Promise<PasswordChangeResult> {
    const account = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    });
    if (account === null) {
      // The session names a person who no longer exists — that is not a
      // password question, but a session question.
      throw new UnauthorizedException(CURRENT_PASSWORD_WRONG_MESSAGE);
    }
    if (account.passwordHash === null) {
      // An SSO account. There is nothing to change here, and the person may
      // learn that — they are this account (see the constant).
      throw new UnprocessableEntityException(
        OIDC_ACCOUNT_HAS_NO_PASSWORD_MESSAGE,
      );
    }
    if (!(await verifyPassword(account.passwordHash, currentPassword))) {
      throw new UnauthorizedException(CURRENT_PASSWORD_WRONG_MESSAGE);
    }

    const passwordHash = await hashPassword(newPassword);
    const now = new Date();
    const revoked = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { passwordHash } });
      // In the **same** transaction, otherwise there is a window in which the
      // new password stands and an old reset link or an old session still
      // works.
      await invalidateOpenTokens(tx, userId, now);
      const ended = await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      });
      return ended.count;
    });

    // **Afterwards**, not inside the transaction: the session should follow the
    // revocation, not lie inside it. The short window in between concerns only
    // one's own request — and in it nobody is signed in, which is the safe
    // direction.
    const { token } = await this.sessions.issue(userId, activeTenantId);

    // Without an address and without a name — the id and a number suffice.
    this.logger.log(
      `password changed by user ${userId}; ${String(revoked)} session(s) revoked`,
    );
    return { token, revoked };
  }

  /** The freshly read `SessionUser`, the way `GET /auth/me` builds it. */
  private async reload(
    userId: string,
    activeTenantId: string | null,
  ): Promise<SessionUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: membershipInclude,
    });
    if (user === null) {
      throw new UnauthorizedException('Diese Sitzung gehört niemandem mehr.');
    }
    return toSessionUser(
      user,
      activeTenantId,
      await this.features.forTenant(activeTenantId),
    );
  }
}
