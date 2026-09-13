import { Module } from '@nestjs/common';

import { SecretBoxModule } from '../common/secret-box/secret-box.module';
import { AccessWordService } from './access-word.service';
import { SettingsSecretsService } from './settings-secrets.service';

/**
 * The one door between the public fill-in routes and the encryption key.
 *
 * A module of its own rather than exporting the service from `SettingsModule`,
 * and the reason is what it does **not** drag along: `SettingsModule` imports
 * `AuthModule` and `TenancyModule` and mounts the two privileged settings
 * controllers (`can_manage_form_settings` for the form, `can_manage_settings`
 * for the organisation — ADR-0021). Importing it from `PublicFormsModule` would put the whole
 * privileged settings surface into the module graph of the routes strangers
 * call — for the sake of one predicate.
 *
 * What this exports is exactly that predicate. `SettingsSecretsService` is
 * provided here because `AccessWordService` is built on it, and it is
 * **deliberately not exported**: it is the service that hands out plaintext
 * words, and the public side has no business being able to inject it.
 */
@Module({
  imports: [SecretBoxModule],
  providers: [SettingsSecretsService, AccessWordService],
  exports: [AccessWordService],
})
export class AccessWordModule {}
