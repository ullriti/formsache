import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { TenantReplyToController } from './tenant-reply-to.controller';
import { TenantReplyToService } from './tenant-reply-to.service';

/**
 * The reply-to address of one organisation.
 *
 * **No `MailModule`, as with `TenantBaseUrlModule` and for the same
 * reason:** no secret lies here, so this module needs no
 * key-holding service and imports none. That is at the same time the
 * reasoning for this route standing separately from the SMTP block at all.
 *
 * No `PrismaModule`: nothing here reaches a row other than through the
 * `TenantScope` the guard chain hands in.
 */
@Module({
  imports: [AuthModule, TenancyModule],
  controllers: [TenantReplyToController],
  providers: [TenantReplyToService],
  exports: [TenantReplyToService],
})
export class TenantReplyToModule {}
