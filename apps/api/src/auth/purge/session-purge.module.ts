import { Module } from '@nestjs/common';

import { ConfigModule } from '../../config/config.module';
import { JobRunModule } from '../../observability/job-run.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { SessionPurgeService } from './session-purge.service';

/**
 * The cleanup run over dead session rows (a review finding) — **its own
 * module in its own directory**, for the same two reasons as
 * `FilePurgeModule`.
 *
 * *Its own module*, because `AuthModule` carries sign-in: a timer running
 * along there would run along in every test that needs a sign-in.
 *
 * *Its own directory*, because this run holds `PrismaService` without a
 * `TenantScope`. `apps/api/src/auth/**` is on the exception list in
 * `eslint.config.js` for that anyway — the session is the layer **before**
 * the organisation scope, and a purge over it knows none.
 */
@Module({
  imports: [
    ConfigModule,
    PrismaModule, // the requirement: this run keeps a record.
    JobRunModule,
  ],
  providers: [SessionPurgeService],
})
export class SessionPurgeModule {}
