import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { TenantLegalController } from './tenant-legal.controller';
import { TenantLegalService } from './tenant-legal.service';

/**
 * The legal pages of an organisation (ADR-0028).
 *
 * No `PrismaModule`: nothing here reaches a row except through the
 * `TenantScope` that the guard chain passes in, and `eslint.config.js` makes a
 * direct `PrismaService` import outside the allow list a build error.
 *
 * No secret, so no `SecretBoxModule` — the same justification that
 * `TenantBaseUrlModule` gives with respect to `SmtpConfigModule`. A legal page
 * is the opposite of a secret: it is published.
 */
@Module({
  imports: [AuthModule, TenancyModule],
  controllers: [TenantLegalController],
  providers: [TenantLegalService],
})
export class TenantLegalModule {}
