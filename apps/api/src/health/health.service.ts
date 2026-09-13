import { Inject, Injectable } from '@nestjs/common';
import type { ApiEnv, HealthResponse } from '@formsache/shared';

import { API_ENV } from '../config/env';

@Injectable()
export class HealthService {
  // Monotonic clock: unlike Date.now() it cannot jump backwards when the host
  // clock is corrected, so the uptime can never turn negative.
  private readonly startedAt = performance.now();

  constructor(@Inject(API_ENV) private readonly env: ApiEnv) {}

  /**
   * The return type comes from the shared schema (`z.infer`), so a change to
   * the wire contract fails this file at compile time. Re-parsing data we just
   * produced ourselves would add nothing.
   */
  snapshot(): HealthResponse {
    return {
      status: 'ok',
      version: this.env.APP_VERSION,
      uptimeSeconds: (performance.now() - this.startedAt) / 1000,
    };
  }
}
