import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import {
  updateTenantAiSwitchRequestSchema,
  type TenantAiSwitch,
} from '@formsache/shared';

import { SessionGuard } from '../auth/session.guard';
import { parseRequest } from '../common/parse-request';
import { AiSettingsService } from '../system-settings/ai-settings.service';
import { CurrentTenantScope } from '../tenancy/current-tenant-scope.decorator';
import { GroupPermissionGuard } from '../tenancy/group-permission.guard';
import { RequirePermission } from '../tenancy/require-permission.decorator';
import type { TenantScope } from '../tenancy/tenant-scope';
import { TenantScopeGuard } from '../tenancy/tenant-scope.guard';

/**
 * **An organisation's own switch — „does this organisation want to?"** .
 *
 * ## Why a controller of its own and not two more routes on the other one
 *
 * `AiFormsController` carries `AiFeatureGuard` on the class, so that a route
 * added later inherits the chain instead of having to remember it. That is exactly
 * what makes it the wrong place for **these** two routes:
 *
 * > An organisation that has switched itself off would get a **404** on its own
 * > switch — and could never switch itself on again.
 *
 * That is not a hypothetical untidiness but a trapdoor that snaps shut exactly
 * once and then needs a database intervention. The separation is
 * therefore the statement: *using the feature* stands behind the availability,
 * *configuring the feature* does not.
 *
 * ## The chain
 *
 * `SessionGuard → TenantScopeGuard → GroupPermissionGuard`, and the right is
 * `canManageSettings` — it is a setting of the organisation, not a
 * building activity. Without a session 401, without an organisation 403, without the right 403.
 *
 * ⚠️ **The quota is explicitly not here.** *„Is this organisation allowed to?"*
 * determines an invoice of the operator's and lies with the superadmin
 * (`PUT /api/admin/tenants/:id/ai-quota`). An organisation admin who were allowed
 * to raise it would be a cost lever without a guardian — and the fact that this route
 * exists beside it changes nothing about that: it can only take away.
 */
@Controller('ai/tenant-settings')
@UseGuards(SessionGuard, TenantScopeGuard, GroupPermissionGuard)
export class AiTenantSettingsController {
  constructor(private readonly ai: AiSettingsService) {}

  @Get()
  @RequirePermission('canManageSettings')
  async read(
    @CurrentTenantScope() scope: TenantScope,
  ): Promise<TenantAiSwitch> {
    const row = await scope.tenant.aiEnabled();
    return {
      enabled: row?.aiEnabled ?? null,
      systemAvailable: await this.systemAvailable(),
    };
  }

  @Put()
  @RequirePermission('canManageSettings')
  async replace(
    @CurrentTenantScope() scope: TenantScope,
    @Body() body: unknown,
  ): Promise<TenantAiSwitch> {
    const request = parseRequest(updateTenantAiSwitchRequestSchema, body);
    await scope.tenant.setAiEnabled(request.enabled);
    return {
      enabled: request.enabled,
      systemAvailable: await this.systemAvailable(),
    };
  }

  /**
   * **What the installation can do — without this organisation's switch.**
   *
   * `available(null)` means „ask the layers of the installation and let the
   * third one inherit", i.e. exactly the question this organisation cannot
   * answer about itself. Passed through with its own switch, the answer
   * would be tautological: a switched-off organisation would read `false` and
   * would be shown the sentence „diese Installation hat keine KI" although it has
   * only switched itself off.
   *
   * It is a `boolean` and stays one: provider, model, region and
   * `apiKeySet` belong to the superadmin page, and `AiSettingsService` does not hand
   * them out here in the first place.
   */
  private systemAvailable(): Promise<boolean> {
    return this.ai.available(null);
  }
}
