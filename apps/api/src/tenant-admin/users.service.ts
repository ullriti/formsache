import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  DEFAULT_OIDC_BUTTON_LABEL,
  collapseWhitespace,
  type SessionRevocation,
  type TenantMember,
  type TenantMemberCreate,
  type TenantMemberCreated,
  type TenantMemberList,
  type TenantMemberUpdate,
} from '@formsache/shared';

import { Prisma } from '@prisma/client';

import { toGroupSummary } from '../auth/session-user';
import { MailClock } from '../mail/mail-clock';
import { SystemMailSettingsService } from '../system-settings/system-mail-settings.service';
import { hashPassword } from '../auth/password';
import { SessionService } from '../auth/session.service';
import {
  AccountInvitationService,
  type InvitationSubject,
} from '../auth/invitation/account-invitation.service';
import {
  invitationRefusalMessage,
  type AccountInvitation,
} from '../auth/invitation/account-invitation';
import { translateConcurrency } from '../common/prisma-error';
import { deriveAccountKind } from '../tenancy/tenant-scope';
import { issuerStamp } from './oidc-issuer';
import { isUuid } from '../common/uuid';
import type {
  MembershipWithPerson,
  TenantScope,
} from '../tenancy/tenant-scope';

/**
 * The people of one organisation — list, add (local or OIDC), change role, remove
 * (the requirement, handoff *Nutzerrechte (Tenant-Ebene)*).
 *
 * **No `PrismaService` in the constructor**, like every other domain service
 * of this application: the only way to a row is the `TenantScope` the guard
 * chain hands in (`CONTRIBUTING.md`, `eslint.config.js`'s allow-list, which this
 * directory is deliberately not on).
 */

/** The one answer for a member the caller may not see — 404, not 403.
 *
 * The same string for „gibt es nicht" and „gehört einer anderen Organisation", for the
 * reason `FORM_NOT_FOUND_MESSAGE` and `GROUP_NOT_FOUND_MESSAGE` give it: a 403
 * would confirm the id exists somewhere on the platform, and ids travel — in
 * URLs, in exports.
 */
export const MEMBER_NOT_FOUND_MESSAGE = 'Mitglied nicht gefunden.';

/** A `groupId` on a create or an update that names no group of this organisation. */
export const MEMBER_GROUP_NOT_FOUND_MESSAGE = 'Gruppe nicht gefunden.';

/**
 * The OIDC option is refused **on the server**
 * when the organisation has SSO switched off — the surface greying the option out is
 * comfort, this refusal is the boundary.
 */
export const OIDC_DISABLED_MESSAGE =
  'SSO ist für diese Organisation nicht aktiviert.';

/**
 * SSO is on for this organisation but **no usable issuer** is stored — a
 * half-configured state `tenant-admin/oidc.service.ts` does not allow, checked
 * here anyway because an invitation is stamped with the issuer and a row without
 * one could never be redeemed by any login (ADR-0012).
 *
 * „Nicht brauchbar" statt „nicht vorhanden" seit Review-Runde 5 Nr. 3: gestempelt
 * wird mit {@link issuerStamp}, also mit dem Wert, gegen den die Anmeldung
 * vergleicht — und der ist auch dann `null`, wenn in der Spalte etwas steht, das
 * die Anmeldung selbst verweigern würde. Der Weg aus beiden Zuständen ist
 * derselbe, den dieser Satz nennt.
 */
export const OIDC_ISSUER_MISSING_MESSAGE =
  'Für diese Organisation ist kein SSO-Anbieter hinterlegt. Bitte zuerst unter ' +
  '„Organisation verwalten" einen Issuer eintragen.';

/** The e-mail already belongs to an account without the credential kind asked for. */
export const EMAIL_IS_LOCAL_MESSAGE =
  'Diese E-Mail-Adresse gehört bereits zu einem lokalen Konto.';
export const EMAIL_IS_OIDC_MESSAGE =
  'Diese E-Mail-Adresse gehört bereits zu einem SSO-Konto.';

export const ALREADY_MEMBER_MESSAGE =
  'Diese Person ist bereits Mitglied dieser Organisation.';

/**
 * The new address already belongs to an account (finding 12).
 *
 * `user.email` is unique installation-wide (ADR-0012), so the collision can
 * just as well be with an account of a completely different organisation. The
 * message therefore says exactly what the case is, and no id along with it —
 * that an address is taken is something a `can_manage_users` holder learns when
 * adding anyway (see the trade-off at the head of {@link create}).
 */
export const EMAIL_ALREADY_USED_MESSAGE =
  'Diese E-Mail-Adresse gehört bereits zu einem anderen Konto.';

/**
 * The account works **in another organisation as well** (finding 12,
 * ADR-0020).
 *
 * The same line `deleteHomelessAccount` draws: an organisation decides about an
 * account for as long as it is that organisation's alone. Address and password
 * are login keys — whoever can set them gets into **every** organisation this
 * account works in.
 *
 * ⚠️ The message is itself a cross-organisation disclosure: it says that the
 * person is a member elsewhere. That is the deliberately paid price — without
 * it the refusal would not be explicable and the action not repairable
 * („bitten Sie die Person, es im Profil selbst zu tun"). **Which** organisation
 * it is is not stated, and neither is the number.
 */
export const ACCOUNT_SHARED_MESSAGE =
  'Dieses Konto arbeitet auch in einer anderen Organisation. Adresse und ' +
  'Passwort kann dort nur die Person selbst ändern — über ihr Profil oder ' +
  'über „Passwort vergessen".';

/**
 * **The invitation, too, is an action on the account** (security finding 4).
 *
 * A sentence of its own and not {@link ACCOUNT_SHARED_MESSAGE}, because the way
 * out named there is only half right here: the profile helps nobody who cannot
 * get in yet. What remains is „Passwort vergessen" — and since ADR-0024 that
 * expressly carries an account **without** a password as well
 * (`PasswordResetService.tryIssue`), so it is the way for exactly this case.
 *
 * It says „keine der beiden" and not „nur die andere": as soon as an account
 * works in two organisations, **neither** of them sends an invitation for it
 * any more — the same symmetric refusal that address and password already
 * carry. A sentence naming the other organisation as a way out would be wrong
 * and one more cross-organisation disclosure.
 */
export const INVITATION_ACCOUNT_SHARED_MESSAGE =
  'Dieses Konto arbeitet auch in einer anderen Organisation. Eine Einladung ' +
  'verschickt dafür keine der beiden mehr — wer nicht hineinkommt, benutzt ' +
  '„Passwort vergessen".';

/** An account of the system administration is rewritten by no organisation. */
export const SUPERADMIN_ACCOUNT_MESSAGE =
  'Dieses Konto verwaltet das System und kann hier nicht geändert werden.';

/** An SSO account has no password in Formsache that anybody could set. */
export const OIDC_ACCOUNT_HAS_NO_PASSWORD_MESSAGE =
  'Dieses Konto meldet sich über Single Sign-on an und hat in Formsache kein ' +
  'Passwort.';

/**
 * The address of an SSO account is not a field of this application.
 *
 * For a **bound** account it is a reflection of what the provider reports (the
 * login runs over the pair *(issuer, subject)*, not over the address —
 * `oidc-identity.service.ts`); for an **open invitation** it is the condition
 * under which the invitation is redeemed (ADR-0012 no. 3), and rewriting it
 * would mean redirecting the invitation to a different person. Both are worth
 * the same sentence, because both deserve the same answer — and because the
 * distinction gives the reader nothing that the badge in the list does not say
 * already.
 */
export const OIDC_ACCOUNT_EMAIL_MESSAGE =
  'Die E-Mail-Adresse eines SSO-Kontos wird beim Anmeldedienst gepflegt und ' +
  'kann hier nicht geändert werden. Für eine offene Einladung: entfernen und ' +
  'mit der richtigen Adresse neu einladen.';

/**
 * The address already carries an **unclaimed** SSO invitation (ADR-0012).
 *
 * `user.email` is unique installation-wide, so an invitation issued by *any*
 * Organisation occupies the address until somebody logs in with it — including for a
 * Organisation with a completely different issuer, whose invitation could never be
 * redeemed against that row anyway (`oidc_issuer` is part of the login's
 * `where`). The refusal is readable and 409 rather than the `P2002` that the
 * unique index would otherwise raise, and it says what has to happen next.
 *
 * That an address can be occupied this way is a **named** price, not an
 * accident: ADR-0012 records „eine Adresse, eine Zeile, ein IdP" and puts
 * „E-Mail je Identität statt je Installation" in writing.
 */
export const EMAIL_INVITED_ELSEWHERE_MESSAGE =
  'Für diese E-Mail-Adresse liegt bereits eine offene SSO-Einladung vor. ' +
  'Sie kann erst wieder vergeben werden, wenn die Person sich einmal per ' +
  'Single Sign-on angemeldet hat.';

/**
 * Two „Person hinzufügen" requests for the **same** address at the same moment.
 *
 * One of them loses at `user.email @unique` with a `P2002`, which untranslated
 * is a 500 naming a PostgreSQL index. The row the loser wanted now exists, so
 * the honest instruction is to reload and attach instead of create.
 */
export const EMAIL_TAKEN_MESSAGE =
  'Diese E-Mail-Adresse wurde soeben vergeben. Bitte die Seite neu laden.';

/**
 * „Einladung erneut senden" for an account that has long been set up
 * (ADR-0024).
 *
 * The refusal names both ways out, because for the two kinds of account they
 * are two different ones — and because a „geht nicht" without a next step is
 * exactly the dead end out of which somebody otherwise removes the person and
 * creates them anew.
 */
export const INVITATION_ALREADY_SET_UP_MESSAGE =
  'Dieses Konto ist bereits eingerichtet — eine Einladung gibt es dafür ' +
  'nicht mehr. Wer nicht mehr hineinkommt, benutzt „Passwort vergessen"; ' +
  'im Notfall setzt die Verwaltung hier ein neues Passwort.';

/**
 * The last administrator of an organisation refuses to be
 * removed or downgraded, with a message that names the reason.
 */
export function lastAdminMessage(action: 'remove' | 'downgrade'): string {
  const verb = action === 'remove' ? 'entfernt' : 'herabgestuft';
  return (
    `Diese Person ist die letzte Administratorin oder der letzte ` +
    `Administrator dieser Organisation und kann nicht ${verb} werden.`
  );
}

@Injectable()
export class TenantUsersService {
  constructor(
    /**
     * The queue's clock — a notice is enqueued like every other mail, and
     * `mail_log.created_at` belongs on **one** calendar.
     */
    private readonly clock: MailClock,
    /** Only for the installation's reply-to address (ADR-0020). */
    private readonly systemSettings: SystemMailSettingsService,
    /**
     * The session service — the **only** dependency of this service, and it
     * does not hold the principle above to be broken: it does not hand a
     * `PrismaService` in here, but an action („beende die Sitzungen dieser
     * Person"), whose organisation boundary is decided beforehand in
     * {@link requireMember}.
     */
    private readonly sessions: SessionService,
    /**
     * The invitation every newly created person gets (ADR-0024) — the
     * **building**, not the writing: the row comes into being in the delegate,
     * in the same transaction as the account.
     */
    private readonly invitations: AccountInvitationService,
  ) {}

  async list(scope: TenantScope): Promise<TenantMemberList> {
    const members = await scope.memberships.findMany();
    return { members: members.map(toView) };
  }

  /**
   * One member, or the single 404 — used both for a genuinely unknown id and
   * for a member of another organisation. The comparison the
   * requirement asks for (byte-identical to the unknown case) holds because both
   * paths return through the same `requireMember`.
   */
  async byId(scope: TenantScope, userId: string): Promise<TenantMember> {
    return toView(await this.requireMember(scope, userId));
  }

  /**
   * „Person hinzufügen" (handoff). Attaches an existing
   * account when the e-mail already has one — the way a person ends up a
   * member of two organisations — and otherwise mints a fresh local account **and**
   * its membership together, through
   * `ScopedMembershipDelegate.createLocal` (coordinator review): two
   * separate statements here would risk an orphaned `user` row with no
   * membership at all, a row nothing tenant-bound could ever find again.
   *
   * **The `oidc` branch mints an invitation, and that is what makes SSO usable
   * at all** (ADR-0012). It used to refuse with 422
   * whenever no account existed — and since nothing else in this application
   * creates an SSO account either, *no* account could ever exist, so the branch
   * was unreachable by construction and the two were unusable together. What it
   * writes now is the unclaimed invitation of ADR-0012: issuer of **this**
   * Organisation, no subject, no password. `tenantMemberCreateSchema` still carries no
   * subject, and that is deliberate rather than a gap — a subject is minted by
   * the provider and first seen in an ID token, so the first login stamps it on
   * (the login route).
   *
   * ## What this route tells a caller about a stranger's account, and why
   *
   * A `can_manage_users` holder learns from the answers here whether an address
   * exists on this installation and whether it is local or SSO (201 against
   * 409), and an attached account's **stored** name is returned rather than the
   * one they typed. `AuthService.login` refuses exactly this distinction byte
   * for byte — and the difference is deliberate, not an oversight:
   *
   * - the login is reachable **by anybody**, this route only by somebody an organisation
   *   trusts with its whole membership list;
   * - the distinction is what the surface is *for*. `user.email` is unique
   *   installation-wide (ADR-0012), so „diese Adresse gehört schon jemandem"
   *   is the difference between „ich lege ein Konto an" and „ich hole eine
   *   Person dazu, die es schon gibt" — which is the documented way somebody
   *   ends up in two Organisationen. An opaque refusal would leave the
   *   admin with a working address, a rejection and no next step;
   * - the stored name travels because the person **is** a member of this organisation
   *   the moment the call succeeds, and every list of this organisation shows it. It is
   *   not a lookup: there is no route here that answers „who is
   *   x@example.org?" without also adding them.
   *
   * The residue is named rather than denied: somebody with `can_manage_users`
   * can probe the installation for addresses, one add at a time. Closing it
   * would mean either giving up „Person in zwei Organisationen" or answering it with a
   * riddle; the chosen price is the smaller one, and it is bounded by a right
   * only an organisation's own administration hands out.
   */
  async create(
    scope: TenantScope,
    request: TenantMemberCreate,
  ): Promise<TenantMemberCreated> {
    const group = await scope.groups.findById(request.groupId);
    if (group === null) {
      throw new UnprocessableEntityException(MEMBER_GROUP_NOT_FOUND_MESSAGE);
    }

    if (request.kind === 'local') {
      const existing = await scope.accounts.findByEmail(request.email);
      if (existing === null) {
        // **The invitation is built before anything at all is written**
        // (ADR-0024): if the installation can send none, no account comes into
        // being either. An account without a password whose invitation never
        // went out would be the worst of all variants — the person knows
        // nothing of it, the administration does not either, and the address is
        // taken installation-wide.
        const invitation = await this.requireInvitation({
          accountKind: 'local',
          personName: request.name,
          tenantName: tenantDisplayName(await scope.tenant.find()),
        });
        const membership = await mint(() =>
          scope.memberships.createLocal(request.groupId, {
            email: request.email,
            name: request.name,
            invitation,
          }),
        );
        return invited(
          toView(await this.requireMember(scope, membership.userId)),
        );
      }
      if (existing.kind !== 'local') {
        // **The kind decides, not the password** (ADR-0024). This used to read
        // `!existing.hasPassword`, and that was the same statement as long as
        // „lokal" meant „hat ein Passwort". Since a local account is invited,
        // it has none until it is redeemed — and the old condition would have
        // told a second organisation that this address belongs „bereits zu
        // einem SSO-Konto". Wrong, inexplicable and at exactly the place where
        // a person becomes a member of a second organisation.
        //
        // `'oidc'` and `'invited'` stay refused: an account a provider decides
        // about does not get a second, quiet password here.
        throw new ConflictException(EMAIL_IS_OIDC_MESSAGE);
      }
      return attached(
        await this.attachExisting(scope, existing.id, request.groupId),
      );
    }

    // `kind: 'oidc'` — refused unless this organisation has SSO switched on
    // . That refusal stays exactly where it was: an invitation is
    // stamped with the organisation's issuer, so an organisation without one has nothing to
    // stamp, and „SSO ist aus" must not be routed around by inviting somebody.
    const tenant = await scope.tenant.find();
    if (!tenant?.oidcEnabled) {
      throw new UnprocessableEntityException(OIDC_DISABLED_MESSAGE);
    }
    const existing = await scope.accounts.findByEmail(request.email);
    if (existing === null) {
      // **The inviting organisation's issuer, never a value from the request.**
      // `tenantMemberCreateSchema` has no field for it, and this is why: an
      // issuer a caller could name would let Organisation A mint an invitation
      // redeemable at the provider of Organisation B (ADR-0012). Read once,
      // here, with nothing between it and the write.
      //
      // Checked only on **this** branch: attaching an account that is already
      // bound to some provider needs no issuer of ours, and refusing it would
      // be a rule about a row this request does not write.
      //
      // ⚠️ **Durch `issuerStamp` und nicht roh aus der Spalte** (Review-Runde 5
      // Nr. 3): die Anmeldung vergleicht gegen `acceptableIssuer(spalte)`, und
      // der rohe Wert war nur deshalb derselbe, weil der Schreibweg des Reiters
      // normalisiert. Eine von Hand reparierte oder aus einem älteren Stand
      // stammende Zeile („…/realms/hv/") ergab einen Stempel, den kein Login je
      // trifft — und im Log stand die Absage über eine Einladung, die nie eine
      // Chance hatte.
      const issuer = issuerStamp(tenant.oidcIssuer);
      if (issuer === null) {
        // Belt and braces against a half-configured Organisation — `oidcEnabled` is
        // only switchable on with an issuer set (`tenant-admin/oidc.service.ts`).
        // An invitation without one would be a row no login could ever match:
        // unredeemable, and holding the unique e-mail hostage while it waits.
        // Seit `issuerStamp` deckt dieselbe Absage den zweiten Fall mit ab: ein
        // Wert, den auch die Anmeldung verweigern würde. Der genannte Weg —
        // einen Issuer eintragen — ist für beide der richtige.
        throw new UnprocessableEntityException(OIDC_ISSUER_MISSING_MESSAGE);
      }
      const invitation = await this.requireInvitation({
        accountKind: 'oidc',
        personName: request.name,
        tenantName: tenantDisplayName(tenant),
        buttonLabel: tenant.oidcButtonLabel ?? DEFAULT_OIDC_BUTTON_LABEL,
      });
      const membership = await mint(() =>
        scope.memberships.createOidcInvitation(request.groupId, {
          email: request.email,
          name: request.name,
          oidcIssuer: issuer,
          invitation,
        }),
      );
      return invited(
        toView(await this.requireMember(scope, membership.userId)),
      );
    }
    if (existing.kind === 'invited') {
      // An invitation nobody has redeemed yet — possibly of an organisation with a
      // different issuer, in which case attaching a membership would hand this
      // Organisation a person who can never sign in here. Refused readably rather than
      // left to the unique index (see {@link EMAIL_INVITED_ELSEWHERE_MESSAGE}).
      throw new ConflictException(EMAIL_INVITED_ELSEWHERE_MESSAGE);
    }
    if (existing.kind !== 'oidc') {
      throw new ConflictException(EMAIL_IS_LOCAL_MESSAGE);
    }
    return attached(
      await this.attachExisting(scope, existing.id, request.groupId),
    );
  }

  /**
   * Changes role, name and address of a member (finding 12).
   *
   * ## Three fields, three rules, and only what changed is checked
   *
   * `PUT` is a statement about the target state, not a list of changes — so the
   * caller sends all three fields, and every comparison here is „steht das
   * schon so?". That is the same rule the role has had since an earlier
   * finding („der letzte Administrator, auf die eigene Gruppe gespeichert,
   * bekam eine Absage für eine Änderung, die er nicht vornahm") — now it holds
   * for all three.
   *
   * ## Why the address has a boundary and the name does not
   *
   * Because the address is **a login key** and the name is a label. Whoever can
   * change an account's address can have a reset link sent to the new address
   * and take the account over — together with everything it may do in **other**
   * organisations. That is why changing the address (like setting the password)
   * stands under three conditions, which {@link requireOwnAccount} keeps in one
   * version:
   *
   * 1. **local account** — with SSO the address is not a key but a reflection
   *    of what the provider reports, and with an open invitation it is the
   *    condition under which it is redeemed (ADR-0012 no. 3): rewriting it
   *    would mean redirecting the invitation to a different person;
   * 2. **no second organisation** — the same line `deleteHomelessAccount`
   *    already draws („was niemandem mehr gehört, geht mit"): an organisation
   *    decides about an account for as long as it is that organisation's alone;
   * 3. **not the system administration** — otherwise every organisation in
   *    which a superadmin is a member would be a way to the installation.
   *
   * The name is subject to none of them: it grants nothing, and a typo in the
   * name of a person who works in two organisations could otherwise no longer
   * be corrected by anybody.
   */
  async updateMember(
    scope: TenantScope,
    userId: string,
    request: TenantMemberUpdate,
  ): Promise<TenantMember> {
    const member = await this.requireMember(scope, userId);
    const group = await scope.groups.findById(request.groupId);
    if (group === null) {
      throw new UnprocessableEntityException(MEMBER_GROUP_NOT_FOUND_MESSAGE);
    }

    const account = member.user;
    const emailChanges = account.email !== request.email;
    const nameChanges = account.name !== request.name;

    if (emailChanges) {
      // Only if it **really** changes: whoever sends the same address once
      // more gets no refusal for a change they are not making — and an SSO
      // member thus stays renameable and regroupable through this route.
      await this.requireOwnAccount(scope, userId, 'email');
    }

    if (nameChanges || emailChanges) {
      const written = await scope.memberships.updateAccount(userId, {
        name: request.name,
        email: request.email,
      });
      if (written === 'unknown') {
        throw new NotFoundException(MEMBER_NOT_FOUND_MESSAGE);
      }
      if (written === 'email-taken') {
        throw new ConflictException(EMAIL_ALREADY_USED_MESSAGE);
      }
    }

    if (member.groupId !== request.groupId) {
      const result = await concurrencySafe(() =>
        scope.memberships.updateGroup(userId, request.groupId),
      );
      if (result === 'unknown') {
        // Resolved a moment ago through `requireMember` — a miss here means
        // somebody else removed the row in between, the same 404 an outsider
        // would see (the requirement's rule, applied to a race instead of an organisation).
        throw new NotFoundException(MEMBER_NOT_FOUND_MESSAGE);
      }
      if (result === 'would-empty-group') {
        throw new ConflictException(lastAdminMessage('downgrade'));
      }
    }

    return toView(await this.requireMember(scope, userId));
  }

  /**
   * Sets a member's password — the administrative way (finding 12).
   *
   * ## What this action is and what it is not
   *
   * It is the way for „jemand kommt nicht mehr hinein und hat keine Mail" and
   * for „dieses Konto muss sofort ein anderes Passwort haben". It is **no**
   * replacement for „Passwort vergessen": there the person proves access to
   * their mailbox, here somebody else proves nothing at all — and for exactly
   * that reason it stands under the same three conditions as the address change
   * ({@link requireOwnAccount}) and ends **every** session of the person.
   *
   * Without the session revocation it would be ineffective after a break-in: a
   * running session token knows no password and would keep running for up to
   * 720 hours (`SESSION_TTL_HOURS`). It therefore happens in **the same**
   * transaction as the setting (`ScopedMembershipDelegate.setPassword`), not as
   * a second call that a later path could forget.
   *
   * ⚠️ Sessions are not organisation-bound — whoever ends them here also ends
   * this person's work elsewhere. With an account that belongs to this
   * organisation alone that has no consequences; that it belongs to *this
   * organisation alone* is condition 2.
   */
  async setPassword(
    scope: TenantScope,
    userId: string,
    password: string,
  ): Promise<SessionRevocation> {
    await this.requireMember(scope, userId);
    await this.requireOwnAccount(scope, userId, 'password');

    const tenant = await scope.tenant.find();
    const revoked = await scope.memberships.setPassword(
      userId,
      await hashPassword(password),
      {
        subject: PASSWORD_SET_NOTICE_SUBJECT,
        bodyText: passwordSetNoticeBody(tenant?.name ?? ''),
        /**
         * **The installation's reply-to address, not the organisation's**
         * (ADR-0020). `reply_to` is set by whoever has `can_manage_settings`; a
         * notice „Ihr Passwort wurde gesetzt — antworten Sie hier" pointing at
         * an address set from there would be an invitation to follow up with
         * somebody who could have triggered exactly this change.
         */
        replyTo: await this.systemSettings.replyTo(),
        stampedAt: this.clock.now(),
      },
    );
    if (revoked === 'unknown') {
      // Removed between the check and the write — or an account without a
      // password column that the check just took to be local. Both the same 404
      // as a member of another organisation.
      throw new NotFoundException(MEMBER_NOT_FOUND_MESSAGE);
    }
    return { revoked };
  }

  /**
   * Sends a member's invitation once more (ADR-0024).
   *
   * ## Why this route exists
   *
   * Because an invitation is a mail. It lands in spam, gets lost when a mailbox
   * is moved, and it expires after `ACCOUNT_INVITATION_TTL_DAYS`. Without this
   * way the only repair would be „entfernen und neu anlegen" — which takes the
   * person's role and form restrictions with it and, with an SSO invitation,
   * briefly releases the installation-wide unique address.
   *
   * ## What it is **not**
   *
   * No way to have a login link sent to somebody else's working account: an
   * account with a password and a bound SSO account get
   * {@link INVITATION_ALREADY_SET_UP_MESSAGE}, and the condition stands in the
   * same transaction as the enqueueing
   * (`ScopedMembershipDelegate.resendInvitation`), not in an `if` before it.
   *
   * The mail goes to the **stored** address — read in the same transaction —,
   * never to one from the request; there is no field for it. The system
   * administration is exempt, for the same reason as with
   * {@link requireOwnAccount}: no organisation issues a power of attorney over
   * an account that administers the installation.
   */
  async resendInvitation(scope: TenantScope, userId: string): Promise<void> {
    const facts = await scope.memberships.accountFacts(userId);
    if (facts === null) {
      throw new NotFoundException(MEMBER_NOT_FOUND_MESSAGE);
    }
    if (facts.isSuperadmin) {
      throw new ConflictException(SUPERADMIN_ACCOUNT_MESSAGE);
    }
    /*
     * **Neither of the two organisations invites a shared account**
     * (security finding 4).
     *
     * The same condition {@link requireOwnAccount} draws for address and
     * password, and here for the same reason: the action takes effect beyond
     * the boundary of one's own organisation. Organisation A creates a person
     * whose invitation is still open; organisation B attaches them and presses
     * „erneut senden" — then `invalidateOpenTokens` voids the link A sent, and
     * the new mail says „von der Organisation B". No takeover (the mail goes to
     * the person's mailbox), but an effect on an invitation that is none of B's
     * business.
     *
     * Costs nothing legitimate: „Passwort vergessen" is open to the person,
     * even without an existing password, and is exactly the way the refusal
     * names.
     *
     * It stands in the service and not in the transaction — the same narrow
     * window {@link requireOwnAccount} accepts for the same fact. What stands
     * in the transaction is the condition a *power of attorney* hangs on („noch
     * nicht eingerichtet"); this one here decides **who** may send, and it can
     * only change while somebody is simultaneously taking the same person into
     * a second organisation.
     */
    if (facts.belongsElsewhere) {
      throw new ConflictException(INVITATION_ACCOUNT_SHARED_MESSAGE);
    }
    // The readable advance refusal; the binding one stands below in the result
    // of the transaction, the only one that checks without a window.
    if (
      facts.kind === 'oidc' ||
      (facts.kind === 'local' && facts.hasPassword)
    ) {
      throw new UnprocessableEntityException(INVITATION_ALREADY_SET_UP_MESSAGE);
    }

    const tenant = await scope.tenant.find();
    const invitation = await this.requireInvitation(
      facts.kind === 'invited'
        ? {
            accountKind: 'oidc',
            personName: facts.name,
            tenantName: tenantDisplayName(tenant),
            buttonLabel: tenant?.oidcButtonLabel ?? DEFAULT_OIDC_BUTTON_LABEL,
          }
        : {
            accountKind: 'local',
            personName: facts.name,
            tenantName: tenantDisplayName(tenant),
          },
    );

    const result = await scope.memberships.resendInvitation(userId, invitation);
    if (result === 'unknown') {
      // Removed between the check and the write — the same 404 as a member of
      // another organisation.
      throw new NotFoundException(MEMBER_NOT_FOUND_MESSAGE);
    }
    if (result === 'already-set-up') {
      throw new UnprocessableEntityException(INVITATION_ALREADY_SET_UP_MESSAGE);
    }
  }

  /**
   * Builds the invitation — or says **beforehand** why none can go out
   * (ADR-0024).
   *
   * The two refusals are 422 and not 409: nothing is in conflict, a
   * precondition of the installation is missing. Both of them say where it is
   * to be fixed, and they live in `account-invitation.service.ts` so that the
   * system administration („+ Neue Organisation") uses the same sentence.
   */
  private async requireInvitation(
    subject: InvitationSubject,
  ): Promise<AccountInvitation> {
    const plan = await this.invitations.plan(subject);
    if (plan.kind !== 'ready') {
      throw new UnprocessableEntityException(invitationRefusalMessage(plan));
    }
    return plan.invitation;
  }

  /**
   * The three conditions under which an organisation may touch a member's
   * **account** — in one place, for both callers (finding 12).
   *
   * The reason for the single version is the usual one: two copies are two
   * answers to „wessen Konto ist das", and the one somebody forgets is the one
   * at the new route. The order runs from the weightiest statement downwards,
   * so that the message names the *most important* refusal when several
   * apply.
   */
  private async requireOwnAccount(
    scope: TenantScope,
    userId: string,
    action: 'email' | 'password',
  ): Promise<void> {
    const facts = await scope.memberships.accountFacts(userId);
    if (facts === null) {
      throw new NotFoundException(MEMBER_NOT_FOUND_MESSAGE);
    }
    if (facts.isSuperadmin) {
      throw new ConflictException(SUPERADMIN_ACCOUNT_MESSAGE);
    }
    if (facts.belongsElsewhere) {
      throw new ConflictException(ACCOUNT_SHARED_MESSAGE);
    }
    if (facts.kind !== 'local') {
      throw new UnprocessableEntityException(
        action === 'password'
          ? OIDC_ACCOUNT_HAS_NO_PASSWORD_MESSAGE
          : OIDC_ACCOUNT_EMAIL_MESSAGE,
      );
    }
  }

  /**
   * Removes somebody from this organisation — and **the account only if it
   * belongs to nobody any more** . Whoever is still in another organisation
   * keeps account and session there; whoever loses their last membership here
   * loses the account in the same transaction. Both stand in
   * `ScopedMembershipDelegate.remove` and in `deleteHomelessAccount`, where the
   * rule has its only version. The last-administrator protection takes effect
   * there unconditionally and before everything else.
   */
  async remove(scope: TenantScope, userId: string): Promise<void> {
    await this.requireMember(scope, userId);
    const result = await concurrencySafe(() =>
      scope.memberships.remove(userId),
    );
    if (result === 'unknown') {
      throw new NotFoundException(MEMBER_NOT_FOUND_MESSAGE);
    }
    if (result === 'would-empty-group') {
      throw new ConflictException(lastAdminMessage('remove'));
    }
  }

  /**
   * Ends **every** session of a member of this organisation (a review finding).
   *
   * The enforced way alongside the self-service in `AuthController`: for the
   * case that somebody has lost their device and can no longer reach any
   * session themselves, or that an account has to stand still immediately.
   *
   * **The organisation boundary stands before the revocation**, not beside it:
   * {@link requireMember} answers a member of another organisation with the
   * same 404 as an invented id — otherwise this route would be an oracle about
   * which ids exist on the installation.
   *
   * ⚠️ **Sessions are not organisation-bound.** Whoever ends them here also
   * ends this person's work in every other organisation they are a member of.
   * That is the point of a revocation and not a side effect — but it stands
   * here because the action sits in an organisation-local view.
   */
  async revokeSessions(
    scope: TenantScope,
    userId: string,
  ): Promise<SessionRevocation> {
    await this.requireMember(scope, userId);
    return { revoked: await this.sessions.revokeAllOf(userId) };
  }

  /**
   * Attaches an **existing** account to this organisation — the shared tail of both
   * branches of {@link create} once the account itself is resolved. Its
   * stored password (or OIDC identity) is never touched here; only the
   * membership is new.
   */
  private async attachExisting(
    scope: TenantScope,
    userId: string,
    groupId: string,
  ): Promise<TenantMember> {
    const alreadyMember = await scope.memberships.findByUserId(userId);
    if (alreadyMember !== null) {
      throw new ConflictException(ALREADY_MEMBER_MESSAGE);
    }
    await scope.memberships.create(userId, groupId);
    return toView(await this.requireMember(scope, userId));
  }

  /** One member of this organisation, or the single 404 . */
  private async requireMember(
    scope: TenantScope,
    userId: string,
  ): Promise<MembershipWithPerson> {
    if (!isUuid(userId)) {
      // An unparseable uuid literal makes PostgreSQL raise, and a 500 would
      // tell the sender their string got that far.
      throw new NotFoundException(MEMBER_NOT_FOUND_MESSAGE);
    }
    const member = await scope.memberships.findByUserId(userId);
    if (member === null) {
      throw new NotFoundException(MEMBER_NOT_FOUND_MESSAGE);
    }
    return member;
  }
}

/**
 * Runs a write that mints a **new `user` row** and turns the two database
 * refusals it can legitimately meet into answers a caller can act on.
 *
 * `P2002` is `user.email @unique` losing a race with a second „Person
 * hinzufügen" for the same address — `findByEmail` came back empty a moment
 * earlier, which is a *check*, not a lock (see the doc on
 * `ScopedMembershipDelegate.createLocal`). `P2034` is the serialization
 * failure translated once for the whole application. Anything else keeps its
 * 500, because anything else is a defect.
 */
async function mint<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new ConflictException(EMAIL_TAKEN_MESSAGE);
    }
    throw translateConcurrency(error);
  }
}

/**
 * Runs a membership write whose guard needs a `Serializable` transaction (the
 * last administrator).
 *
 * `Serializable` is the price of counting correctly, and PostgreSQL charges it
 * by aborting one of two concurrent transactions with `40001`. That reached the
 * caller as a **500** (review finding) — the server behaving exactly as
 * designed, reported as broken. Nothing was written, so the answer is the
 * readable „bitte noch einmal".
 */
async function concurrencySafe<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    throw translateConcurrency(error);
  }
}

/**
 * A row as the *Nutzerrechte (Tenant-Ebene)* tab reads it.
 *
 * **`deriveAccountKind` does not check `password_hash`** (a review
 * finding) — a row that carried both a password *and* an unclaimed
 * issuer would show „Eingeladen" while actually able to sign in locally
 * already. Left this way deliberately rather than reordered to check the
 * password first: `MEMBER_VIEW_SELECT` (`tenancy/tenant-scope.ts`)
 * deliberately does not carry `passwordHash` — the doc there calls that
 * omission the reason a later `...member.user` spread cannot leak the hash
 * into a payload, and checking it here would mean selecting it there too,
 * widening exactly the surface that omission exists to keep narrow.
 *
 * No write path in this application produces the shape that would matter:
 * `ScopedMembershipDelegate.createLocal` stamps a password and nothing OIDC,
 * `.createOidcInvitation` stamps an issuer and no password, and neither
 * `updateGroup` nor `remove` ever touches a `user` row's credential columns
 * afterwards. The `user_has_credentials` CHECK (migration
 * `20260730154134_relax_user_credential_checks_for_oidc_invitation`) does not
 * itself rule the combination out, though, so this is a documented
 * precondition, not an enforced one — a future write that ever does combine
 * them would show the wrong badge, silently, until this comment is revisited.
 */
/**
 * The two answers of „Person hinzufügen", so the page can say which one it got.
 *
 * Both branches that mint an account also enqueue an invitation, and both that
 * attach an existing one enqueue nothing — the person already has a way in.
 * Written as two named functions rather than a boolean argument so a new branch
 * has to say which of the two it is.
 */
function invited(member: TenantMember): TenantMemberCreated {
  return { ...member, invited: true };
}

function attached(member: TenantMember): TenantMemberCreated {
  return { ...member, invited: false };
}

function toView(member: MembershipWithPerson): TenantMember {
  const account = member.user;
  return {
    userId: member.userId,
    email: account.email,
    name: account.name,
    accountKind: deriveAccountKind(account),
    group: toGroupSummary(member.group),
  };
}

/**
 * The organisation's name as a mail writes it — or `null`.
 *
 * An organisation that no longer exists costs the name and not the mail — the
 * same direction `QueuedBodyRenderer.shellFor` takes for colour and name. What
 * the text then says is decided by the mail itself
 * (`account-invitation-mail.ts`): it leaves the half-sentence out instead of
 * putting an empty space in quotation marks.
 */
function tenantDisplayName(
  tenant: { readonly name: string } | null,
): string | null {
  return tenant === null || tenant.name === '' ? null : tenant.name;
}

/**
 * The subject of the notice about an administratively set password
 * (ADR-0020).
 *
 * Fixed and recognisable, like every other system mail — and expressly **no**
 * template an organisation can edit: what stands here is a statement of the
 * application about an account.
 */
export const PASSWORD_SET_NOTICE_SUBJECT =
  'Formsache: Dein Passwort wurde neu gesetzt';

/**
 * The body — **without a link and without the password**.
 *
 * Without the password, because it would then stand in `mail_log.body_text`,
 * that is, in the column the mail log displays; how the person learns it is the
 * business of the administration that set it, and not a channel this
 * application provides. Without a link, because there is nothing to click.
 *
 * What it achieves: **the person notices**. Without this mail an
 * administratively set password would look to them exactly like a takeover —
 * they suddenly cannot get in any more, and nobody says why.
 */
export function passwordSetNoticeBody(tenantName: string): string {
  // **Folded before it goes into the body** (ADR-0026): the organisation's
  // name is a foreign value — `tenantBrandingWriteSchema.name` and
  // `tenantCreateSchema.name` have required `isSingleLineText` since then, and
  // this here is the bolt for the rows that came into being before that. A
  // system mail of the installation must not carry a line somebody else
  // phrased.
  const folded = collapseWhitespace(tenantName);
  const organisation = folded === '' ? 'deiner Organisation' : `„${folded}"`;
  return (
    `Hallo,\n\n` +
    `die Verwaltung von ${organisation} hat für dein Formsache-Konto ein neues ` +
    `Passwort gesetzt. Alle offenen Anmeldungen dieses Kontos wurden dabei ` +
    `beendet — auch auf anderen Geräten.\n\n` +
    `Das neue Passwort erfährst du von der Person, die es gesetzt hat; es ` +
    `steht aus gutem Grund nicht in dieser Mail.\n\n` +
    `Hast du darum nicht gebeten, wende dich bitte an die Verwaltung ` +
    `deiner Organisation.\n`
  );
}
