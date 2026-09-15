import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import {
  updateTenantNotificationTemplatesRequestSchema,
  type TenantNotificationTemplatesResponse,
} from '@formsache/shared';

import { SessionGuard } from '../auth/session.guard';
import { parseRequest } from '../common/parse-request';
import { CurrentTenantScope } from '../tenancy/current-tenant-scope.decorator';
import { GroupPermissionGuard } from '../tenancy/group-permission.guard';
import { RequirePermission } from '../tenancy/require-permission.decorator';
import type { TenantScope } from '../tenancy/tenant-scope';
import { TenantScopeGuard } from '../tenancy/tenant-scope.guard';
import { TenantNotificationTemplatesService } from './tenant-notification-templates.service';

/**
 * The notification templates of this organisation — the tab *Vorlagen*
 * (ADR-0032, reversing ADR-0011's system-wide design for this one facet).
 *
 * **No organisation in the path**, for the same reason `TenantLegalController`
 * and `TenantBaseUrlController` give: the row is always that of the *active*
 * organisation, resolved by `TenantScopeGuard` from a membership the caller
 * actually holds. A request cannot even **name** a foreign organisation — the
 * boundary is structural and not checked.
 *
 * **`can_manage_settings`, and only that** — the same single permission
 * `TenantLegalController` demands and for the same reason: a template carries
 * no answer data, only text and placeholders that render one later. It is not
 * the sending identity (which additionally demands `can_view_responses`,
 * because naming the mail server names the machine every answer travels
 * through) — a template is closer to a legal page, a statement this
 * organisation publishes about itself, not a channel into its participants'
 * data.
 *
 * The old superadmin route this replaces,
 * `GET`/`PUT /admin/system-settings/notification-templates`, is gone along
 * with its controller, service and counter — this is a full move, not an
 * added layer (ADR-0032).
 */
@Controller('tenant/notification-templates')
@UseGuards(SessionGuard, TenantScopeGuard, GroupPermissionGuard)
export class TenantNotificationTemplatesController {
  constructor(private readonly templates: TenantNotificationTemplatesService) {}

  @Get()
  @RequirePermission('canManageSettings')
  read(
    @CurrentTenantScope() scope: TenantScope,
  ): Promise<TenantNotificationTemplatesResponse> {
    return this.templates.ofTenant(scope);
  }

  @Put()
  @RequirePermission('canManageSettings')
  replace(
    @CurrentTenantScope() scope: TenantScope,
    @Body() body: unknown,
  ): Promise<TenantNotificationTemplatesResponse> {
    return this.templates.replaceOfTenant(
      scope,
      parseRequest(updateTenantNotificationTemplatesRequestSchema, body),
    );
  }
}
