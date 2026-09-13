import { Module } from '@nestjs/common';
import type { ApiEnv } from '@formsache/shared';

import { ConfigModule } from '../config/config.module';
import { API_ENV } from '../config/env';
import { FileStorage } from './file-storage';
import { LocalFileStorage } from './local-file-storage';

/**
 * **One binding, one exported token** — and that shape is the decision, not
 * housekeeping (ADR-0014 no. 18 Punkt 4).
 *
 * The public fill-in path will import this module for the upload, and the
 * public path is the one place in this application where an
 * import has to be read as a *promise about the graph*. Here is why:
 * `PublicFormsModule` imported `MailModule` „für die Uhr" and received
 * `MailSecretsService`, `MailIdentityService` and `MailTransport` with it —
 * three services that can see a plaintext, injectable from a route strangers
 * reach without a session, and a comment claiming the opposite. `MailClockModule`
 * was the answer then and is the shape here: a module that provides exactly one
 * thing cannot hand out a second one by accident.
 *
 * So the adapter, the purge and the attachment download deliberately live
 * **outside** this module. Whoever adds a provider here is widening what the
 * public path can inject, and that is the sentence they have to write in the
 * review.
 *
 * The adapter is built by a factory rather than by `useClass`, because its
 * directory is configuration: `LocalFileStorage` takes the path in its
 * constructor instead of reading the environment itself, which is what lets a
 * test point it at a throwaway directory without an environment at all.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: FileStorage,
      inject: [API_ENV],
      useFactory: (env: ApiEnv): FileStorage =>
        new LocalFileStorage(env.FILE_STORAGE_DIR),
    },
  ],
  exports: [FileStorage],
})
export class FileStorageModule {}
