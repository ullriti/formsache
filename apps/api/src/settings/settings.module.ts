import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { SecretBoxModule } from '../common/secret-box/secret-box.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { FormSettingsController } from './form-settings.controller';
import { FormSettingsService } from './form-settings.service';
import { SettingsSecretsService } from './settings-secrets.service';
import { TenantSettingsController } from './tenant-settings.controller';

/**
 * Form settings and tenant standards.
 *
 * A module of its own rather than two more routes on `FormsModule`, because
 * the two answer different questions and are guarded by different rights:
 * `FormsModule` is `can_build` / `can_view_responses` territory, everything
 * here is one of the two settings rights — `can_manage_form_settings` for a
 * form, `can_manage_settings` for the organisation's standards (ADR-0021), and
 * the split runs right through this module. Keeping them apart from
 * `FormsModule` means the settings surface can be reviewed as one thing —
 * including the fact that its *read* is as privileged as its write.
 *
 * No `PrismaModule` import: nothing in here reaches a row except through the
 * `TenantScope` the guard chain hands in, and `eslint.config.js` makes that a
 * build failure rather than a review finding.
 */
@Module({
  imports: [AuthModule, TenancyModule, SecretBoxModule],
  controllers: [FormSettingsController, TenantSettingsController],
  providers: [FormSettingsService, SettingsSecretsService],
})
export class SettingsModule {}
