import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { HealthResponse, ReadinessResponse } from '@formsache/shared';

import { HealthService } from './health.service';
import { ReadinessService } from './readiness.service';

/**
 * How often **one** address may ask for readiness. See the route.
 */
const READINESS_RATE_LIMIT = { limit: 60, ttl: 60_000 } as const;

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthService,
    private readonly readiness: ReadinessService,
  ) {}

  /**
   * **Liveness** — unchanged: does the process live, which version does it
   * carry, for how long already.
   *
   * It does **not** touch the database, and that is no omission: a supervisor
   * that derives a restart from „unhealthy" would otherwise restart a healthy
   * process, because the *database* is missing (ADR-0016).
   */
  @Get()
  read(): HealthResponse {
    return this.health.snapshot();
  }

  /**
   * **Readiness** — may traffic come here?
   *
   * 200 or 503, without details. The Compose health check of the `api` asks this
   * route, and so does the outside observer from ADR-0016.
   *
   * The error case goes through {@link HttpException} and **not** through a
   * `@Res()` object: that would bring the Express type into a file that
   * otherwise does not need it, and with it the question whether the rest of the
   * response still comes from Nest. An `HttpException` with an object argument
   * delivers exactly this object as the body — so here `{ ready: false }`.
   */
  /**
   * ⚠️ **The only rate limit of this file, and it was missing** (review
   * finding).
   *
   * `/api/health/ready` is the only unauthenticated route that triggers a
   * database round trip and occupies a connection from the pool — and the
   * deadline breaks off the *waiting* of the caller, not the query. Whoever
   * hammers it in parallel fills the pool with abandoned `SELECT 1` and puts
   * real requests at the back. `07-oeffentliche-pfade.md` demands a limit per
   * address for every change to these paths; this route carried none.
   *
   * 60/min is generous: the outside observer asks once per minute
   * , the Compose health check every five seconds. So it slows nobody down who
   * uses it as intended.
   */
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: READINESS_RATE_LIMIT })
  @Get('ready')
  async ready(): Promise<ReadinessResponse> {
    const ready = await this.readiness.isReady();
    if (!ready) {
      const body: ReadinessResponse = { ready: false };
      throw new HttpException(body, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return { ready };
  }
}
