import { Module } from '@nestjs/common';

import { ConfigModule } from '../../config/config.module';
import { MailClockModule } from '../../mail/mail-clock.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { TenancyModule } from '../../tenancy/tenancy.module';
import { TrashModule } from '../trash.module';
import { RetentionPurgeService } from './retention-purge.service';
import { JobRunModule } from '../../observability/job-run.module';

/**
 * The 30-day purge of the trash — **its own module in
 * its own directory**, the same cut `files/purge/` makes and for the same two
 * reasons.
 *
 * *Its own directory*, because this is the second place in the application that
 * holds `PrismaService` without a `TenantScope` around it, and the allow-list in
 * `eslint.config.js` names `apps/api/src/trash/purge/**` rather than `trash/**`
 * for exactly that reason. `TrashModule` next door — the routes an editor
 * reaches — stays fenced, and that counter-check is what makes the entry
 * defensible: a trash route that started reaching for Prisma would still be
 * a build error.
 *
 * *Its own module*, because `TrashModule` is imported by `FormsModule` for the
 * six write routes that live on `FormsController`. A provider added there is a
 * provider those routes can inject; a provider added here is not — and this one
 * can delete every organisation of the installation.
 *
 * It imports `TrashModule` rather than re-providing anything: {@link
 * PermanentDeletionService} is the session-free half of it, built to be called
 * with a scope its caller minted, and „eine zweite Löschbahn" is precisely what
 * it was told not to build. `TenancyModule` supplies the `TenantScopeFactory`
 * that mints those scopes, and `MailClockModule` the one injected calendar —
 * one binding, one exported token, so importing it brings nothing else along
 * (a lesson learned before).
 */
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    MailClockModule,
    TenancyModule,
    TrashModule, // the requirement: this run keeps a record.
    JobRunModule,
  ],
  providers: [RetentionPurgeService],
})
export class RetentionPurgeModule {}
