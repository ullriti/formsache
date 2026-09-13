import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
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
 * finding. `SystemSettingsModule` is imported for the delivered templates
 *  and is not an exception to that: it hands out one service
 * with one no-argument read method over the installation-wide row, and the
 * repository behind it stays unexported.
 *
 * `notification-questions.ts` carries no Nest at all and is therefore not a
 * provider: `FormsService` imports it directly for the publish lock of
 * the requirement. A pure function rather than an injected service, because the
 * alternative is `FormsModule` importing this module for one rule — and that
 * edge turns circular the day a notification route needs something of
 * `FormsModule`.
 */
@Module({
  imports: [AuthModule, TenancyModule, SystemSettingsModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
})
export class NotificationsModule {}
