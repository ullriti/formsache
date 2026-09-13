import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AccountInvitationModule } from '../auth/invitation/account-invitation.module';
import { RateLimitModule } from '../common/rate-limit.module';
import { MailClockModule } from '../mail/mail-clock.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { TenantUsersController } from './users.controller';
import { TenantUsersService } from './users.service';

/**
 * The people of one organisation — list, add (local or OIDC account), change role,
 * remove (the requirement, handoff *Nutzerrechte (Tenant-Ebene)*).
 *
 * Filled strictly through `TenantScope.memberships` and
 * `TenantScope.accounts`: there is no `PrismaModule` import here and this
 * directory is deliberately not on the `PrismaService` allow-list of
 * `eslint.config.js`. „Die Nutzer einer Organisation" is a query over `membership`,
 * never over `user` directly.
 */
@Module({
  imports: [
    AuthModule,
    TenancyModule,
    /**
     * **Spoken out instead of inherited** — the same rule that
     * `test-mail.module.ts` and `mail-log.module.ts` write down:
     * `ThrottlerModule` is `@Global()`, so `ThrottlerGuard` would resolve
     * here anyway. The entry names the dependency without registering a second
     * `ThrottlerModule.forRoot` — and two routes of this
     * module send real mails of the installation
     * (`INVITATION_MAIL_RATE_LIMIT`), so they hang on a limit that
     * must not be invisible.
     */
    RateLimitModule,
    /**
     * The clock of the queue and the reply address of the installation — for
     * the notification that accompanies an administratively set password
     * (ADR-0020). Both are **questions**, no ways to the row: the log row is
     * written in the delegate, inside the transaction that also
     * sets the password.
     */
    MailClockModule,
    SystemSettingsModule,
    /**
     * The invitation every newly created person gets (ADR-0024) — a
     * **question** like the two above: it delivers the finished value, and
     * it is written in the delegate, in the same transaction as the account.
     */
    AccountInvitationModule,
  ],
  controllers: [TenantUsersController],
  providers: [TenantUsersService],
})
export class TenantUsersModule {}
