import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { TenantNotificationTemplatesModule } from '../tenant-admin/tenant-notification-templates.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

/**
 * Notifications per form.
 *
 * Registered in `app.module.ts` ahead of time so that this package, which
 * fills it, changes files nobody else is holding — notifications was one of
 * four mail-related packages built in parallel.
 *
 * The CRUD of `notification`, guarded by `can_manage_form_settings` (the reasoning
 * sits at `NotificationsController`), reading and writing strictly through
 * `TenantScope.notifications`. The API accepts `submit` and `edit` — „Bei
 * Zwischenspeichern" is *absent, not disabled*, on the server as well as in the
 * editor (`notificationTriggerInputSchema` in `@formsache/shared`), **and stays so**:
 * An earlier package built the Zwischenspeichern without a mail, so there is no
 * message for that trigger to carry.
 *
 * No `PrismaModule` import, now or later: everything in here reaches *tenant*
 * rows through the `TenantScope` the guard chain hands in, and
 * `eslint.config.js` makes a shortcut a build failure rather than a review
 * finding. `SystemSettingsModule` is imported for the two **remaining**
 * installation-wide levels of the `Reply-To` chain (ADR-0011 no. 7) — it
 * hands out `SystemMailSettingsService`, one service with read methods over
 * the installation-wide row, and the repository behind it stays unexported.
 * `TenantNotificationTemplatesModule` is imported for the notification
 * templates themselves (ADR-0032): since that move they are the **calling**
 * organisation's own row, reached through the `TenantScope` like everything
 * else here — not an installation-wide read at all any more.
 *
 * `notification-questions.ts` carries no Nest at all and is therefore not a
 * provider: `FormsService` imports it directly for the publish lock of
 * the requirement. A pure function rather than an injected service, because the
 * alternative is `FormsModule` importing this module for one rule — and that
 * edge turns circular the day a notification route needs something of
 * `FormsModule`.
 */
@Module({
  imports: [
    AuthModule,
    TenancyModule,
    SystemSettingsModule,
    TenantNotificationTemplatesModule,
  ],
  controllers: [NotificationsController],
  providers: [NotificationsService],
})
export class NotificationsModule {}
