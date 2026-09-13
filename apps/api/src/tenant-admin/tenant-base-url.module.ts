import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { TenantBaseUrlController } from './tenant-base-url.controller';
import { TenantBaseUrlService } from './tenant-base-url.service';

/**
 * The organisation's own base address (ADR-0013 no. 3).
 *
 * **No `MailModule`, unlike `SmtpConfigModule`.** There is no secret here —
 * a base address is not sealed, so this module needs no key-holding service
 * and imports none.
 *
 * No `PrismaModule`: nothing here reaches a row except through the
 * `TenantScope` the guard chain hands in, and `eslint.config.js` makes a
 * direct `PrismaService` import outside the allow-list a build failure.
 */
@Module({
  imports: [AuthModule, TenancyModule],
  controllers: [TenantBaseUrlController],
  providers: [TenantBaseUrlService],
  exports: [TenantBaseUrlService],
})
export class TenantBaseUrlModule {}
