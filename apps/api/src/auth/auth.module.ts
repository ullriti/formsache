import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { SecretBoxModule } from '../common/secret-box/secret-box.module';
import { MailClockModule } from '../mail/mail-clock.module';
import { SystemMailSettingsService } from '../system-settings/system-mail-settings.service';
import { SystemSettingsRepository } from '../system-settings/system-settings.repository';
import { PasswordResetController } from './password-reset/password-reset.controller';
import { PasswordResetService } from './password-reset/password-reset.service';
import { ProfileService } from './profile.service';
import { PrismaModule } from '../prisma/prisma.module';
import { SessionFeaturesService } from './session-features.service';
import { AiSettingsModule } from '../system-settings/ai-settings.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { RateLimitModule } from '../common/rate-limit.module';
import { SessionGuard } from './session.guard';
import { SessionService } from './session.service';
import { SuperadminGuard } from './superadmin.guard';

/**
 * Authentication: local login, logout, and the session behind the cookie.
 *
 * `SessionService` and `SessionGuard` are exported because the feature modules
 * of the next wave protect their routes with the same guard — a second guard
 * with its own session lookup is how two subtly different notions of "logged
 * in" come about.
 *
 * OIDC (ADR-0005) is not here yet; it plugs in as a second way to reach
 * `SessionService.issue` and changes nothing about the session itself.
 */
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    RateLimitModule,
    AiSettingsModule,
    /**
     * For the subkey from which a reset token arises (ADR-0020).
     * What comes in here is the **signer**, not the cipher — the
     * two are separate providers with separate keys
     * (`secret-box.module.ts`).
     */
    SecretBoxModule,
    /**
     * The queue's clock. The reset mail is enqueued like every
     * other mail, and `mail_log.created_at` belongs on **one** calendar.
     */
    MailClockModule,
  ],
  controllers: [AuthController, PasswordResetController],
  providers: [
    AuthService,
    SessionService,
    SessionFeaturesService,
    SessionGuard,
    SuperadminGuard,
    ProfileService,
    PasswordResetService,
    /**
     * The lowest level of the `Reply-To` chain, **provided here rather than
     * imported** — and the reasoning is the same one `SystemSettingsModule`
     * gives for `MailSecretsService`: that module already imports
     * `AuthModule`, so an import back would be a module cycle (Nest fails
     * on it at start-up, not only at the call).
     *
     * The price is a second instance of the same class with its own
     * logging memory (`reported`) — cosmetic, as described over there —
     * and **no** second version of the resolution: it is the same file.
     * `SystemSettingsRepository` stands beside it because its constructor
     * demands it and it needs nothing more than `PrismaModule`.
     */
    SystemSettingsRepository,
    SystemMailSettingsService,
  ],
  /**
   * `ConfigModule` is re-exported, and that is not tidiness — it is what makes
   * `SessionGuard` usable outside this module.
   *
   * Nest resolves a guard's constructor in the module that *applies* it, so
   * every consumer of `SessionGuard` has to be able to see the guard's
   * dependencies. The guard reads `API_ENV` to learn which cookie name counts
   * behind TLS; without this line `GroupsModule` fails to start with
   * "can't resolve dependencies of the SessionGuard (SessionService, ?)".
   *
   * Re-exporting the environment is safe in a way that re-exporting
   * `PrismaModule` would not be (see `TenancyModule`): a validated,
   * read-only configuration object grants no access to anything.
   *
   * `SuperadminGuard` travels with `SessionGuard`, because it
   * is only ever applied behind it: it reads what that guard attached and
   * refuses a request that has none. It lives here rather than in the module
   * that applies it, so „wer darf die Installation verwalten?" has one answer
   * and one file — the argument that keeps `SessionGuard` from being written
   * twice.
   */
  exports: [
    SessionService,
    SessionFeaturesService,
    SessionGuard,
    SuperadminGuard,
    ConfigModule,
  ],
})
export class AuthModule {}
