import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { RateLimitModule } from '../common/rate-limit.module';
import { SecretBoxModule } from '../common/secret-box/secret-box.module';
import { MailSecretsService } from '../mail/mail-secrets.service';
import { NotificationTemplatesService } from './notification-templates.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AiSettingsModule } from './ai-settings.module';
import { SystemAiAdminService } from './system-ai-admin.service';
import { SystemMailAdminService } from './system-mail-admin.service';
import { SystemLegalService } from './system-legal.service';
import { SystemMailSettingsService } from './system-mail-settings.service';
import { SystemNotificationTemplatesAdminService } from './system-notification-templates-admin.service';
import { SystemSettingsController } from './system-settings.controller';
import { SystemSettingsRepository } from './system-settings.repository';

/**
 * What the installation as a whole decides: its mail server, its own address,
 * its KI — and the notification templates a new form starts from.
 *
 * **No settings layer any more** (ADR-0011, continuation 2026-08-14; review
 * finding 9). This module used to hold a third layer of form settings below
 * every organisation, and four other modules imported it only to resolve that
 * layer on every request. They no longer do: what a form inherits comes from
 * its organisation and, failing that, from the shipped constant in
 * `@formsache/shared` — a constant needs no module.
 *
 * Not `@Global()`, for the reason `PrismaModule` gives: a module that states
 * where its dependencies come from is easier to follow, and easier to replace
 * in a test, than one that receives them invisibly.
 *
 * It exports the **services**, never the repository. The repository is the one
 * file in the application allowed to reach `PrismaService` for a table that
 * belongs to no organisation, and keeping it unexported means „nur ein Zugriffsweg"
 * is a fact about this module rather than a rule somebody has to keep.
 *
 * `NotificationTemplatesService` is one reader of the row, imported by
 * `NotificationsModule`; its own service rather than a method on a shared one,
 * because „welche Vorlagen liegen bereit?" and „wie verschickt diese
 * Installation Post?" are different questions about one table.
 *
 * `SystemMailSettingsService` is the second reader of the same
 * row and the reason `PublicUrlModule` imports this module: `SMTP_*` and
 * `PUBLIC_BASE_URL` left the `.env`, so „wo antwortet diese Installation?"
 * is a query and no longer a constructor argument. It hands the mail block out
 * **sealed** — the key stays in `MailSecretsService`, next to the queue.
 *
 * The superadmin surface is mounted here: one controller behind
 * `SuperadminGuard` with two pairs of routes —
 * `GET`/`PUT /admin/system-settings/mail` and `.../ai`. The row repository is
 * provided and deliberately **not** exported; nothing outside this module can
 * reach it.
 *
 * The mail pair is the one write in this module that touches a secret,
 * which is why `SecretBoxModule` is imported and `MailSecretsService` is
 * provided directly rather than through `MailModule` — see the provider's own
 * comment for why (a cycle: `MailModule` already imports this module).
 *
 * `AuthModule` supplies `SessionGuard` and `SuperadminGuard` (and, through its
 * re-exported `ConfigModule`, the environment the first of them resolves);
 * `RateLimitModule` supplies `ThrottlerGuard` **without** registering a second
 * `ThrottlerModule.forRoot` — there is exactly one in this application and a
 * second replaces it silently.
 *
 * **`TenancyModule` is deliberately absent**, and that is the shape of
 * the requirement rather than an omission: these routes take no tenant scope and
 * no group permission, because the layer they edit belongs to no organisation. Adding
 * it later would be the moment „Systemeinstellungen" started depending on a
 * membership.
 *
 * **The write path for `notification_templates` is there** (ADR-0022,
 * continuation 2026-08-18), and with it the condition that stood here: the
 * counter `notification_templates_revision` came in the same change as the
 * route (`20260818100000_notification_templates_revision`). An optimistic
 * lock on a document nobody writes would have been surface passing itself off
 * as a promise; a route without a lock on a row three
 * pages maintain would be the silent overwriter.
 *
 * `SystemNotificationTemplatesAdminService` is therefore a service of its
 * **own** next to `NotificationTemplatesService` and not a third method on it:
 * that one answers „which templates are ready for this editor?" tolerantly
 * and without a lock, this one „what is stored, and replace it" — the same
 * separation `SystemMailSettingsService` and `SystemMailAdminService` already
 * have. It is **not** exported: the write path belongs to the route behind
 * the guard and to nobody else.
 */
@Module({
  imports: [
    PrismaModule,
    AuthModule,
    RateLimitModule,
    SecretBoxModule,
    AiSettingsModule,
  ],
  controllers: [SystemSettingsController],
  providers: [
    SystemSettingsRepository,
    NotificationTemplatesService,
    SystemMailSettingsService,
    // The write half of the superadmin mail-settings feature. `MailSecretsService` is provided here
    // rather than imported from `MailModule` — that module already imports
    // *this* one (it reads the system mail block and the base address), so
    // importing it back would be a module cycle. Providing the class directly
    // needs only `SecretBoxModule`, since `MailSecretsService`'s own
    // constructor asks for nothing else; it does mean a second instance of
    // that class lives in the container, with its own per-process log-dedup
    // set (`reported`), which is a cosmetic cost (a broken block could log
    // its "cannot be opened" line once per instance instead of once overall)
    // and not a second implementation of the sealing itself — the imported
    // class is the same file `apps/api/src/mail/mail-secrets.service.ts`
    // owns, unmodified.
    MailSecretsService,
    SystemMailAdminService,
    SystemAiAdminService,
    SystemNotificationTemplatesAdminService,
    // The legal-text service **is** exported, unlike the three
    // admin services next to it: the public path reads the installation's
    // legal texts and its operator name, and it may do that because both
    // are public by definition. The write path nevertheless stays at the
    // route behind `SuperadminGuard` — the service does carry it, but
    // `PublicFormsModule` calls `read()` and `operatorName()` only.
    SystemLegalService,
  ],
  exports: [
    NotificationTemplatesService,
    SystemMailSettingsService,
    SystemLegalService,
  ],
})
export class SystemSettingsModule {}
