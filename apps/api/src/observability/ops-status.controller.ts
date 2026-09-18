import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import {
  acknowledgeAlertRequestSchema,
  opsMetricSchema,
  type OpsStatus,
} from '@formsache/shared';

import { CurrentAuth } from '../auth/current-auth.decorator';
import type { AuthContext } from '../auth/request-context';
import { SessionGuard } from '../auth/session.guard';
import { SuperadminGuard } from '../auth/superadmin.guard';
import { parseRequest } from '../common/parse-request';
import { OpsAcknowledgementService } from './ops-acknowledgement.service';
import { OpsStatusService } from './ops-status.service';

/**
 * How many calls a minute the **writing** routes take — the same number as on
 * the system settings next door, far above what a person clicking a button
 * produces and far below what a loop would.
 *
 * ⚠️ **On the methods, not on the controller.** `ThrottlerGuard` is not global
 * in this application, so a controller-wide guard would newly limit the `GET`
 * as well — a view that polls once a minute per open tab, which nobody asked
 * to have capped.
 */
const OPS_WRITE_RATE_LIMIT = { limit: 60, ttl: 60_000 } as const;

/**
 * **The operations status of the installation** (ADR-0016).
 *
 * ## Why this surface belongs to the superadmin
 *
 * It counts across **all** organisations. An organisation admin who read it
 * would learn how much post the installation is backing up and how full its
 * storage is — numbers that are none of their business and from which the activity
 * of foreign organisations could be read off. The guard chain is therefore the
 * same as with `AdminTenantsController`: `SessionGuard`, then `SuperadminGuard`.
 *
 * **No `TenantScopeGuard`** — this surface belongs to no organisation, and a
 * scope would have nothing it referred to. **No `GroupPermissionGuard`** —
 * `can_manage_users` is granted by an organisation to its own people; here it
 * would be the permission to look into foreign organisations.
 *
 * The refusal is **403 and not 404**, as next door: the caller is signed in, and
 * the route is no secret.
 */
@Controller('admin/ops')
@UseGuards(SessionGuard, SuperadminGuard)
export class OpsStatusController {
  constructor(
    private readonly ops: OpsStatusService,
    private readonly acknowledgements: OpsAcknowledgementService,
  ) {}

  @Get()
  read(): Promise<OpsStatus> {
    return this.ops.read();
  }

  /**
   * **Quittieren** — this metric stays silent for the chosen span
   * (ADR-0016, continuation 2026-09-16).
   *
   * The metric arrives in the path and is parsed like any foreign value: an
   * unknown name is a 400, not a row that silently comes into being.
   *
   * ⚠️ **It silences the metric, not the job.** `job_stale` covers all six
   * background runs; acknowledging it while `retention_purge` is broken also
   * keeps a later failure of `file_purge` quiet until the span runs out. That
   * is the price of one metric per kind of trouble, and it is why the spans
   * are offered at all rather than a single unlimited switch.
   */
  @Post('alerts/:metric/acknowledgement')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: OPS_WRITE_RATE_LIMIT })
  acknowledge(
    @Param('metric') metric: string,
    @Body() body: unknown,
    @CurrentAuth() auth: AuthContext,
  ): Promise<OpsStatus> {
    return this.acknowledgements.acknowledge(
      parseRequest(opsMetricSchema, metric),
      parseRequest(acknowledgeAlertRequestSchema, body),
      auth.user.id,
    );
  }

  /** Takes the acknowledgement back — the metric reports again. */
  @Delete('alerts/:metric/acknowledgement')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: OPS_WRITE_RATE_LIMIT })
  release(@Param('metric') metric: string): Promise<OpsStatus> {
    return this.acknowledgements.release(parseRequest(opsMetricSchema, metric));
  }
}
