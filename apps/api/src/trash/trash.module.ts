import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { FileStorageModule } from '../files/file-storage.module';
import { MailClockModule } from '../mail/mail-clock.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { PermanentDeletionService } from './permanent-deletion.service';
import { TrashController } from './trash.controller';
import { TrashService } from './trash.service';

/**
 * The trash.
 *
 * No `PrismaModule` import — every statement goes through the `TenantScope`
 * the guard chain hands in, and the lint rule in `eslint.config.js` makes that
 * a build failure rather than a review finding.
 *
 * `MailClockModule` — **not** `MailModule` — for the timestamp `deleted_at`
 * carries: the 30 days of the purge are counted from it, so it comes from the one
 * injected clock of this application and not from `new Date()`. The narrow
 * module is the point (see its own note): a trash module that imported
 * `MailModule` would make `MailSecretsService` injectable from here, and „nur
 * die Uhr" would again be a statement about intent rather than about the graph.
 *
 * `FileStorageModule` since the requirement: physical deletion has to remove an
 * answer's attachments from the storage, bytes before rows (ADR-0014 no. 16).
 * It is the module that provides exactly one thing, for the reason its own note
 * gives — this import widens what the trash can inject by `FileStorage`
 * and by nothing else.
 *
 * `TrashService` is **exported**: the six write routes of the trash live
 * on `FormsController`, because the objects they address are a form and an
 * answer of a form, and both belong under `/api/forms/:id` — where the class's
 * `@FormIdInParam('id')` already points the fourth link of the guard chain at
 * the right row. A second controller with its own `forms` prefix would have
 * been a second place to keep that declaration correct.
 *
 * `PermanentDeletionService` is exported **as well as** provided, and not
 * because anything imports it today: it is the session-free half of the
 * 30-day purge, which is meant to call it with a scope it minted itself rather
 * than to grow a second spelling of „physisch löschen".
 */
@Module({
  imports: [AuthModule, TenancyModule, MailClockModule, FileStorageModule],
  controllers: [TrashController],
  providers: [TrashService, PermanentDeletionService],
  exports: [TrashService, PermanentDeletionService],
})
export class TrashModule {}
