import { Module } from '@nestjs/common';

import { ConfigModule } from '../config/config.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SecretBoxModule } from '../common/secret-box/secret-box.module';
import { AiSettingsService } from './ai-settings.service';
import { SystemSettingsRepository } from './system-settings.repository';

/**
 * **The one reader of the AI row, in a module that pulls nobody back**.
 *
 * ## Why this does not simply lie in `SystemSettingsModule`
 *
 * Three places need the answer: `AiModule` (guard and generation),
 * `AuthModule` (the menu switch of the session payload) and `TenancyModule`
 * (the same switch after an organisation change). `SystemSettingsModule`
 * **imports** `AuthModule`, however — it needs `SessionGuard` and
 * `SuperadminGuard` for its superadmin routes. If the service lay there, the
 * import back out of `AuthModule` would be a module cycle.
 *
 * This directory has already solved the same problem once, and in the
 * other direction: `MailSecretsService` is provided directly in `SystemSettingsModule`
 * instead of being imported from `MailModule`, because `MailModule` for its part
 * imports `SystemSettingsModule`. Here the clean cut is the
 * reverse one — a **small module of its own** that imports nothing that
 * could ever import back, and that `SystemSettingsModule`
 * for its part includes.
 *
 * ## What that means for `SystemSettingsRepository`
 *
 * It is provided here a second time, and thereby a second instance
 * lives in the container. That is the same price `MailSecretsService` pays,
 * and bearable for the same reason: it is **the same class from the same
 * file**, without state that two instances could drive apart. The
 * promise at issue — *„eine Klasse ist die einzige, die `PrismaService`
 * für eine Tabelle ohne Organisation anfasst"* —, is a statement about the file and
 * stays true.
 *
 * ⚠️ The repository is **not** exported, as little here as there. Outwards
 * only {@link AiSettingsService} goes, and that one hands out the plain-text key
 * only to the adapter.
 */
@Module({
  imports: [PrismaModule, SecretBoxModule, ConfigModule],
  providers: [SystemSettingsRepository, AiSettingsService],
  exports: [AiSettingsService],
})
export class AiSettingsModule {}
