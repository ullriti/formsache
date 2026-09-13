import { Module } from '@nestjs/common';

import { ConfigModule } from '../../config/config.module';
import { MailClockModule } from '../../mail/mail-clock.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { FileStorageModule } from '../file-storage.module';
import { FilePurgeService } from './file-purge.service';
import { JobRunModule } from '../../observability/job-run.module';

/**
 * The purge of orphaned attachments (ADR-0014 no. 15) — **its
 * own module in its own directory**, and both halves of that are the decision.
 *
 * *Its own module*, because `FileStorageModule` provides exactly one binding
 * and exports exactly one token: the public fill-in path imports it, and
 * a review is the reason that shape is guarded rather than merely intended
 * (`PublicFormsModule` imported `MailModule` „für die Uhr" and received three
 * services that can see a plaintext). A provider added there widens what a
 * route strangers reach without a session can inject; a provider added here
 * does not.
 *
 * *Its own directory*, because this is the one place in the application that
 * holds `PrismaService` without a `TenantScope` around it, and the allow-list
 * in `eslint.config.js` names `apps/api/src/files/purge/**` rather than
 * `files/**` for exactly that reason — the same cut the eighth entry
 * (`common/public-url/**`) makes. The attachment retrieval next door stays
 * fenced, and that counter-check is what makes the entry defensible.
 *
 * `MailClockModule` is the one injected calendar of this application
 * (`file-purge.service.ts` says why the mail-shaped name is worth the single
 * instance); it provides one binding and exports one token, so importing it
 * here brings nothing else along.
 */
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    MailClockModule,
    FileStorageModule, // the requirement: this run keeps a record.
    JobRunModule,
  ],
  providers: [FilePurgeService],
})
export class FilePurgeModule {}
