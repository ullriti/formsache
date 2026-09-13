import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { updateTenantLegalRequestSchema } from '@formsache/shared';

import { SessionGuard } from '../auth/session.guard';
import { parseRequest } from '../common/parse-request';
import { CurrentTenantScope } from '../tenancy/current-tenant-scope.decorator';
import { GroupPermissionGuard } from '../tenancy/group-permission.guard';
import { RequirePermission } from '../tenancy/require-permission.decorator';
import type { TenantScope } from '../tenancy/tenant-scope';
import { TenantScopeGuard } from '../tenancy/tenant-scope.guard';
import {
  TenantLegalService,
  type TenantLegalDocument,
} from './tenant-legal.service';

/**
 * The legal pages of this organisation — the tab *Rechtstexte* (ADR-0028).
 *
 * **No organisation in the path**, for the same reason that
 * `TenantBaseUrlController` and `TenantSettingsController` spell out: the row is
 * always that of the *active* organisation, resolved by `TenantScopeGuard` from
 * a membership that the caller actually holds. A request cannot even **name** a
 * foreign organisation — the boundary is structural and not checked.
 *
 * **`can_manage_settings`, and only that** — not additionally
 * `can_view_responses`, which `SmtpConfigController` and
 * `TenantBaseUrlController` demand. The difference is intended and has a reason:
 * those two edit the **sending identity**, and whoever may enter a mail server
 * can divert post that carries answer contents — hence the second permission
 * there. A legal page carries no answer data; it is a statement about the
 * organisation itself, which is published anyway. To put it behind
 * `can_view_responses` would mean demanding access to all answers for entering a
 * postal address — the opposite of data minimisation.
 *
 * It is the same permission that `TenantSettingsController` demands for the form
 * defaults, and out of the same consideration: a setting of the organisation
 * that makes no personal data visible.
 */
@Controller('tenant/legal')
@UseGuards(SessionGuard, TenantScopeGuard, GroupPermissionGuard)
export class TenantLegalController {
  constructor(private readonly legal: TenantLegalService) {}

  @Get()
  @RequirePermission('canManageSettings')
  read(@CurrentTenantScope() scope: TenantScope): Promise<TenantLegalDocument> {
    return this.legal.ofTenant(scope);
  }

  @Put()
  @RequirePermission('canManageSettings')
  replace(
    @CurrentTenantScope() scope: TenantScope,
    @Body() body: unknown,
  ): Promise<TenantLegalDocument> {
    return this.legal.replaceOfTenant(
      scope,
      parseRequest(updateTenantLegalRequestSchema, body),
    );
  }
}
