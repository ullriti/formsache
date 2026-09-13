import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { MailModule } from '../mail/mail.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { SmtpConfigController } from './smtp-config.controller';
import { SmtpConfigService } from './smtp-config.service';

/**
 * The sending identity of one organisation.
 *
 * **`MailModule` rather than a second key holder.** The SMTP password is the
 * third database secret of this application, and the one thing that must never
 * drift is *which context it is sealed under* — so this module imports the
 * service that owns that answer instead of providing a sealing of its own.
 * `MailSecretsService` is exported there for exactly this caller
 * (`mail.module.ts`).
 *
 * No `PrismaModule`: nothing here reaches a row except through the
 * `TenantScope` the guard chain hands in, and `eslint.config.js` makes that a
 * build failure rather than a review finding.
 */
@Module({
  imports: [AuthModule, TenancyModule, MailModule],
  controllers: [SmtpConfigController],
  providers: [SmtpConfigService],
  exports: [SmtpConfigService],
})
export class SmtpConfigModule {}
