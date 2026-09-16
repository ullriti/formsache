import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ConfigModule } from '../config/config.module';
import { MailClockModule } from '../mail/mail-clock.module';
import { PrismaModule } from '../prisma/prisma.module';
import { OpsAcknowledgementService } from './ops-acknowledgement.service';
import { OpsStatusController } from './ops-status.controller';
import { OpsStatusService } from './ops-status.service';

/**
 * The operations status.
 *
 * Separate from {@link JobRunModule}: the one **writes** out of five
 * background runs, the other **reads** behind a superadmin guard. A
 * shared module would mean that every purge has the controller in its graph.
 */
@Module({
  imports: [ConfigModule, PrismaModule, MailClockModule, AuthModule],
  controllers: [OpsStatusController],
  providers: [OpsStatusService, OpsAcknowledgementService],
})
export class OpsStatusModule {}
