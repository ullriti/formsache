import { Injectable } from '@nestjs/common';
import {
  ACCOUNT_INVITATION_TTL_DAYS,
  effectiveReplyTo,
} from '@formsache/shared';

import { SigningService } from '../../common/secret-box/signing.service';
import { MailClock } from '../../mail/mail-clock';
import { SystemMailSettingsService } from '../../system-settings/system-mail-settings.service';
import { mintPasswordResetToken } from '../password-reset/password-reset-token';
import {
  ACCOUNT_INVITATION_SUBJECT,
  localInvitationBody,
  oidcInvitationBody,
} from './account-invitation-mail';
import type { InvitationPlan } from './account-invitation';

const MS_PER_DAY = 86_400_000;

/** Whom this invitation concerns and how the person signs in later. */
export type InvitationSubject =
  | {
      readonly accountKind: 'local';
      readonly personName: string;
      /** `null` if the organisation is not (any longer) readable. */
      readonly tenantName: string | null;
    }
  | {
      readonly accountKind: 'oidc';
      readonly personName: string;
      /** `null` if the organisation is not (any longer) readable. */
      readonly tenantName: string | null;
      /** The lettering of the sign-in button of this organisation. */
      readonly buttonLabel: string;
    };

/**
 * Builds an invitation before it is written (ADR-0024).
 *
 * ## What this class does **not** do
 *
 * It writes nothing. Neither the `mail_log` row nor the invitation row nor the
 * account — all of that belongs in **one** transaction together with the account
 * itself, and that lies in `ScopedMembershipDelegate.createLocal` or
 * `AdminRepository.createTenant` respectively. This class delivers the finished
 * value for it and is thereby the same division that `PasswordNotice` already
 * has: „here the German language and the key, there the organisation binding and
 * the transaction".
 *
 * From that follows the second property: **a plan that is not used leaves
 * nothing behind.** The minting of a token is an HMAC over a fresh UUID; if the
 * transaction is not carried out or rolls back, there is no row the value
 * belonged to, and it is unusable.
 *
 * ## Why the check lies here and not at the sending
 *
 * Without the mail server of the instance nobody can be invited — and that is
 * exactly the sort of error one says **beforehand**. If only the queue learned
 * of it, an account without a password would come into being whose invitation
 * never went out and about which nobody knows anything until the person gets in
 * touch. The caller therefore gets a named refusal here and does not write in
 * the first place.
 *
 * ## The reply address is that of the installation
 *
 * `effectiveReplyTo` gets **only** the system level, never that of the
 * organisation — the same justification that `PasswordResetService.tryIssue`
 * gives for it: `tenant.reply_to` is set by whoever holds `can_manage_settings`,
 * and an account mail that says „antworten Sie hier" to an address set from
 * there is an invitation to follow up.
 */
@Injectable()
export class AccountInvitationService {
  constructor(
    private readonly signing: SigningService,
    /**
     * The clock of the queue, not `new Date()`: `mail_log.created_at` belongs
     * on **one** calendar (`mail-clock.ts`).
     */
    private readonly clock: MailClock,
    private readonly systemSettings: SystemMailSettingsService,
  ) {}

  async plan(subject: InvitationSubject): Promise<InvitationPlan> {
    /*
     * **Only „is one entered?", not „can it be opened?".** Unsealing the block
     * would remain without use here: a stored but unreadable block is an
     * installation-wide outage that becomes visible on every mail and is not to
     * be diagnosed on this route — and to touch a key per create request for
     * that would be the plaintext handling that ADR-0012 no. 7 is currently
     * pushing back. What this check answers is the question the human in front
     * of it asks: „Hat diese Installation überhaupt einen Mailserver?"
     */
    if ((await this.systemSettings.storedSmtp()) === null) {
      return { kind: 'no-mail-server' };
    }
    /*
     * The base address of the **installation**, never that of the organisation:
     * an organisation's own address is set by whoever holds
     * `can_manage_settings`, and an invitation link on it would be a real,
     * correctly worded mail to the victim whose only link points at the attacker
     * (ADR-0020 §5, `PublicUrlService.installationBaseUrl`). It is therefore
     * read here from the same source that the sending step uses later.
     */
    const appUrl = await this.systemSettings.publicBaseUrl();
    if (appUrl === null) {
      return { kind: 'no-base-url' };
    }

    const replyTo = effectiveReplyTo([
      { origin: 'system', value: await this.systemSettings.replyTo() },
    ]).address;
    const stampedAt = this.clock.now();

    if (subject.accountKind === 'oidc') {
      const body = oidcInvitationBody({
        personName: subject.personName,
        tenantName: subject.tenantName,
        appUrl,
        buttonLabel: subject.buttonLabel,
      });
      return {
        kind: 'ready',
        invitation: {
          subject: ACCOUNT_INVITATION_SUBJECT,
          bodyText: body.text,
          bodyHtml: body.html,
          replyTo,
          stampedAt,
          // No token: an SSO account gets no password, so there is nothing to
          // set and nothing to send (ADR-0012).
          token: null,
        },
      };
    }

    const body = localInvitationBody({
      personName: subject.personName,
      tenantName: subject.tenantName,
      appUrl,
    });
    const minted = mintPasswordResetToken(this.signing);
    return {
      kind: 'ready',
      invitation: {
        subject: ACCOUNT_INVITATION_SUBJECT,
        bodyText: body.text,
        bodyHtml: body.html,
        replyTo,
        stampedAt,
        token: {
          id: minted.id,
          tokenHash: minted.tokenHash,
          // From the same clock as the log row: two calendars on one operation
          // are the mistake that `mail-clock.ts` calls by name.
          expiresAt: new Date(
            stampedAt.getTime() + ACCOUNT_INVITATION_TTL_DAYS * MS_PER_DAY,
          ),
        },
      },
    };
  }
}
