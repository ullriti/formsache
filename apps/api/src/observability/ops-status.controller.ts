import { Controller, Get, UseGuards } from '@nestjs/common';
import type { OpsStatus } from '@formsache/shared';

import { SessionGuard } from '../auth/session.guard';
import { SuperadminGuard } from '../auth/superadmin.guard';
import { OpsStatusService } from './ops-status.service';

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
  constructor(private readonly ops: OpsStatusService) {}

  @Get()
  read(): Promise<OpsStatus> {
    return this.ops.read();
  }
}
