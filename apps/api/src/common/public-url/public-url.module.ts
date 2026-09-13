import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { SystemSettingsModule } from '../../system-settings/system-settings.module';
import { PublicUrlService } from './public-url.service';
import { TenantBaseUrlRepository } from './tenant-base-url.repository';

/**
 * Provides {@link PublicUrlService} — the server's own address.
 *
 * A module of its own rather than a provider inside `PublicFormsModule`,
 * because the mail module needs the same service and importing the whole
 * public fill-in module for one string builder would tie two unrelated things
 * together (`umsetzungsplan-m2-etappe-c.md`).
 *
 * Not `@Global()`, following `ConfigModule`, `PrismaModule` and
 * `SecretBoxModule`: an import that is written down is easier to follow than one
 * that happens invisibly.
 */
/*
 * `SystemSettingsModule` instead of `ConfigModule`: the address is
 * a row (`system_setting.public_base_url`) and no longer `PUBLIC_BASE_URL` of
 * the environment. The import direction is the one that stays acyclic —
 * `SystemSettingsModule` reaches `AuthModule`, `PrismaModule` and
 * `RateLimitModule`, none of which reach back here.
 *
 * `PrismaModule` joined afterward: `TenantBaseUrlRepository` reads
 * `tenant.public_base_url` directly, which is the eighth entry of the
 * allow-list in `eslint.config.js` — the reasoning lives there and at the
 * repository, not here.
 */
@Module({
  imports: [SystemSettingsModule, PrismaModule],
  providers: [PublicUrlService, TenantBaseUrlRepository],
  exports: [PublicUrlService],
})
export class PublicUrlModule {}
