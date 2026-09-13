import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { RateLimitModule } from '../common/rate-limit.module';
import { MailModule } from '../mail/mail.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { MailLogController } from './mail-log.controller';
import { MailLogService } from './mail-log.service';

/**
 * The mail log.
 *
 * Two things decide the shape of this module, and both are load-bearing:
 *
 * 1. **`RequireAllPermissions('canManageFormSettings', 'canViewResponses')`** on
 *    every route — both, not either. A subject line or a
 *    body with `{{antworten}}` carries the answer values, so reading the log
 *    *is* reading answers. The same hole was found at the export (export
 *    without read permission); it is not being opened a second time. The rule
 *    sits on the routes in `mail-log.controller.ts`, where a reader of a route
 *    sees it.
 * 2. **Every read goes through `TenantScope.mailLog`** — never through
 *    `PrismaService`, and never through the worker's repository in
 *    `src/mail/`. There is therefore **no `PrismaModule` import here**: this
 *    directory is deliberately not on the `PrismaService` allow-list of
 *    `eslint.config.js`, and that is the counter-check that makes the worker's
 *    entry there defensible. `mail_log` carries no composite foreign key on
 *    `(form_id, tenant_id)`, so `ScopedMailLogDelegate` is the **only** tenant
 *    boundary the table has.
 *
 * `AuthModule` and `TenancyModule` are the guard chain of `CONTRIBUTING.md`
 * (*tenant scope → group permissions*); `RateLimitModule` supplies the
 * `ThrottlerGuard` for „↻ Erneut". Importing the latter states the dependency
 * **without** registering a second `ThrottlerModule.forRoot` — there is exactly
 * one in this application, and a second one silently replaces it, which is how
 * the login's limit once disappeared without anything turning red.
 *
 * `MailModule` is imported for **two** exported providers now. `MailClock`:
 * „↻ Erneut" stamps `next_attempt_at`, and the worker decides what is due by
 * comparing that column with a `Date` it computes from the same clock — so the
 * two have to be the same clock, or a requeued line is claimed a moment too
 * early or not at all. `MailBodyRenderer`, since „Die gerenderte Mail ansehen"
 * : the detail route resolves `{{bearbeiten}}` with the exact renderer
 * the worker sends with, rather than a second reading of
 * `response`/`allowEdit` (`MailLogService.detail`). Neither provider hands
 * this module a database client of its own: `MailModule` exports neither its
 * repository nor `PrismaService`, and this directory stays off the allow-list
 * of `eslint.config.js` — `MailBodyRenderer` renders the row it is handed, it
 * does not fetch one.
 */
@Module({
  imports: [AuthModule, TenancyModule, RateLimitModule, MailModule],
  controllers: [MailLogController],
  providers: [MailLogService],
})
export class MailLogModule {}
