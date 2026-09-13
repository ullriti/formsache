import { Module } from '@nestjs/common';

import { PublicUrlModule } from '../common/public-url/public-url.module';
import { ConfigModule } from '../config/config.module';
import { MailClockModule } from '../mail/mail-clock.module';
import { MailModule } from '../mail/mail.module';
import { PrismaModule } from '../prisma/prisma.module';
import { JobRunModule } from './job-run.module';
import { OpsAlertService } from './ops-alert.service';
import { OpsStatusService } from './ops-status.service';

/**
 * The watchdog (ADR-0016).
 *
 * It shares {@link OpsStatusService} with the view — **the same** source, so
 * that traffic light and alert never mean different numbers. The service is
 * *provided* a second time here and not imported, because `OpsStatusModule`
 * would bring a controller along that a scheduler does not need; it is
 * stateless, so two instances are not two truths.
 */
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    MailClockModule,
    JobRunModule,
    // The sending path — **directly**, not over the queue: an alert about the
    // backlog of the queue that landed in it itself would stand behind the
    // backlog it reports.
    MailModule,
    // The base address of the installation for the footer of the message. Only
    // read; the chain over an organisation is not used by this service.
    PublicUrlModule,
  ],
  providers: [OpsStatusService, OpsAlertService],
  exports: [OpsAlertService],
})
export class OpsAlertModule {}
