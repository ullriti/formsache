import { Module } from '@nestjs/common';
import type { ApiEnv } from '@formsache/shared';

import { API_ENV } from '../../config/env';
import { ConfigModule } from '../../config/config.module';
import { SECRET_BOX_KEY, decodeSecretBoxKey } from './secret-box-key';
import { SecretBoxService } from './secret-box.service';
import { SigningService } from './signing.service';

/**
 * Provides the two things that need the key: `SecretBoxService`, which
 * encrypts a value into a column, and `SigningService`, which signs a
 * short-lived server-issued string.
 *
 * **`SECRET_BOX_KEY` is provided but not exported.** The two services are the
 * whole public surface of this folder; the raw key stays inside it. That is not
 * tidiness — a token that other modules can inject is a token that ends up in
 * a constructor somewhere, and from there in a log line.
 *
 * **Exporting the signer does not export the cipher.** They are separate
 * providers with separate keys (`signing.service.ts` derives its own subkeys
 * and drops the raw one), so a module that imports this for the signer — the
 * public fill-in module does — cannot decrypt an access word with what it got.
 * The claim of `settings-document.ts`, that the redacting parsers hold no key
 * material, is untouched: they are pure functions in another folder.
 *
 * Not `@Global()`, following `ConfigModule` and `PrismaModule`: an import that
 * is written down is easier to follow than one that happens invisibly.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: SECRET_BOX_KEY,
      inject: [API_ENV],
      useFactory: (env: ApiEnv): Buffer =>
        decodeSecretBoxKey(env.SECRET_BOX_KEY),
    },
    SecretBoxService,
    SigningService,
  ],
  exports: [SecretBoxService, SigningService],
})
export class SecretBoxModule {}
