import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { AttachmentController } from './attachment.controller';
import { AttachmentService } from './attachment.service';
import { FileStorageModule } from './file-storage.module';

/**
 * The attachment retrieval — **deliberately not part of
 * `FileStorageModule`**.
 *
 * That module's own doc states the rule and this module is the first thing to
 * obey it: „der Adapter, der Purge und der Attachment-Download leben außerhalb
 * dieses Moduls". `FileStorageModule` provides exactly one token, so the public
 * fill-in path can import it without receiving anything else — the property
 * a review proved is worth having, when `PublicFormsModule` imported `MailModule`
 * „für die Uhr" and got three services that can see a plaintext.
 *
 * **No `PrismaModule`.** Everything this module reads goes through the
 * `TenantScope` the guard chain hands in, and `eslint.config.js` makes a direct
 * `PrismaService` import here a build error rather than a review finding —
 * `apps/api/src/files/**` is not on that allow-list. The one further entry
 * ADR-0014 foresaw exists and is `apps/api/src/files/purge/**`, a
 * directory of its own precisely so that *this* file stays fenced: the purge
 * being the counter-check's other half is what makes that entry defensible.
 */
@Module({
  imports: [AuthModule, TenancyModule, FileStorageModule],
  controllers: [AttachmentController],
  providers: [AttachmentService],
})
export class AttachmentModule {}
