import { Module } from '@nestjs/common';

import { MailClockModule } from '../mail/mail-clock.module';
import { PrismaModule } from '../prisma/prisma.module';
import { JobRunService } from './job-run.service';

/**
 * The bookkeeping for the background runs.
 *
 * **One binding, one token** (ADR-0014): the module exports
 * {@link JobRunService} and nothing else. `MailClockModule` was built for
 * exactly this — it carries the clock without dragging in the rest of the mail
 * subsystem, and that same clock therefore dates the deadlines **and** their
 * bookkeeping.
 */
@Module({
  imports: [PrismaModule, MailClockModule],
  providers: [JobRunService],
  exports: [JobRunService],
})
export class JobRunModule {}
