import { Module } from '@nestjs/common';

import { RateLimitModule } from '../common/rate-limit.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SetupController } from './setup.controller';
import { SetupService } from './setup.service';

/**
 * The first commissioning (ADR-0022).
 *
 * `PrismaModule` directly, because there is no Organisation here whose boundary
 * would have to be kept — the full reasoning stands in `setup.service.ts` and on
 * the allow-list in `eslint.config.js`.
 *
 * `RateLimitModule` named rather than inherited: `ThrottlerModule` is `@Global()`,
 * so the guard would resolve anyway — the import makes the dependency visible,
 * **without** registering a second `forRoot` (there is exactly one of those,
 * and a second one silently replaces the first).
 *
 * `SetupService` is deliberately **not** exported: there is exactly one way
 * here, and that is the controller above it.
 */
@Module({
  imports: [PrismaModule, RateLimitModule],
  controllers: [SetupController],
  providers: [SetupService],
})
export class SetupModule {}
