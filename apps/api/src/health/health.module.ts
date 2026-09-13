import { Module } from '@nestjs/common';

import { API_ENV, loadEnv } from '../config/env';
import { RateLimitModule } from '../common/rate-limit.module';
import { PrismaModule } from '../prisma/prisma.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { ReadinessService } from './readiness.service';

@Module({
  // By now with database access — for **one** statement (`SELECT 1`) and only
  // in `ReadinessService`. The entry on the `PrismaService` allow-list in
  // `eslint.config.js` gives the reason why this module takes it directly
  // instead of over a `TenantScope`: there is no organisation here whose
  // boundary would have to be kept — the question is whether the *process* can
  // work.
  // `RateLimitModule` named instead of inherited: `ThrottlerModule` is
  // `@Global()`, so the guard resolved anyway — the import makes the
  // dependency visible **without** registering a second `forRoot` (there is
  // exactly one of those, and a second one silently replaces the first).
  imports: [PrismaModule, RateLimitModule],
  controllers: [HealthController],
  providers: [
    HealthService,
    ReadinessService,
    { provide: API_ENV, useFactory: () => loadEnv() },
  ],
})
export class HealthModule {}
