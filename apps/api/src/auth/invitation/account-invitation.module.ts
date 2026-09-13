import { Module } from '@nestjs/common';

import { SecretBoxModule } from '../../common/secret-box/secret-box.module';
import { MailClockModule } from '../../mail/mail-clock.module';
import { SystemSettingsModule } from '../../system-settings/system-settings.module';
import { AccountInvitationService } from './account-invitation.service';

/**
 * The invitation of a freshly created account (ADR-0024) — **built here,
 * written elsewhere**.
 *
 * A module of its own, because there are two callers that have nothing to do
 * with each other: the member administration of an organisation
 * (`TenantUsersModule`) and the system administration, which creates a new
 * organisation along with its first administrator (`AdminModule`). Providing
 * the service twice would be twice the same period, the same reply address and
 * the same refusal — and next time only almost.
 *
 * `SecretBoxModule` contributes the signing key (and **only** that: the cipher
 * is a provider of its own with a key of its own, see there), `MailClockModule`
 * the clock of the queue, `SystemSettingsModule` the mail server of the
 * instance, the base address and the reply address.
 */
@Module({
  imports: [SecretBoxModule, MailClockModule, SystemSettingsModule],
  providers: [AccountInvitationService],
  exports: [AccountInvitationService],
})
export class AccountInvitationModule {}
