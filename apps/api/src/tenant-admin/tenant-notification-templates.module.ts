import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { TenantNotificationTemplatesController } from './tenant-notification-templates.controller';
import { TenantNotificationTemplatesService } from './tenant-notification-templates.service';

/**
 * The notification templates of an organisation (ADR-0032).
 *
 * No `PrismaModule`: nothing here reaches a row except through the
 * `TenantScope` the guard chain passes in, and `eslint.config.js` makes a
 * direct `PrismaService` import outside the allow list a build error.
 *
 * Exports the service: `NotificationsModule` needs it too, to hand a form's
 * notification editor the templates of the **calling** organisation instead
 * of the installation-wide set the old `NotificationTemplatesService` read.
 */
@Module({
  imports: [AuthModule, TenancyModule],
  controllers: [TenantNotificationTemplatesController],
  providers: [TenantNotificationTemplatesService],
  exports: [TenantNotificationTemplatesService],
})
export class TenantNotificationTemplatesModule {}
