import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';

import { SessionGuard } from '../auth/session.guard';
import { parseRequest } from '../common/parse-request';
import { CurrentTenantScope } from '../tenancy/current-tenant-scope.decorator';
import { GroupPermissionGuard } from '../tenancy/group-permission.guard';
import { RequirePermission } from '../tenancy/require-permission.decorator';
import type { TenantScope } from '../tenancy/tenant-scope';
import { TenantScopeGuard } from '../tenancy/tenant-scope.guard';
import { FormSettingsService } from './form-settings.service';
import {
  updateTenantFormDefaultsRequestSchema,
  type TenantFormDefaultsResponse,
} from './settings-wire';

/**
 * The organisation's form standards — the *Formular-Standards* tab.
 *
 * **There is no tenant id in the path, and that is the security design, not a
 * shortcut.** The standards addressed here are always the ones of the session's
 * *active* tenant, resolved by `TenantScopeGuard` from a membership the caller
 * actually holds. A request therefore has no way to *name* another organisation, so
 * „der Standard eines fremden Tenants ist weder les- noch schreibbar"
 *  is structural rather than checked — there is nothing to
 * refuse. Someone who wants another organisation's standards has to switch into it
 * first, which is exactly the boundary the tenant switcher already draws.
 *
 * Superadmin reach across organisations belongs elsewhere and will need its own way in,
 * reviewed on its own terms rather than inherited from here.
 */
@Controller('tenant/form-defaults')
@UseGuards(SessionGuard, TenantScopeGuard, GroupPermissionGuard)
export class TenantSettingsController {
  constructor(private readonly settings: FormSettingsService) {}

  @Get()
  @RequirePermission('canManageSettings')
  read(
    @CurrentTenantScope() scope: TenantScope,
  ): Promise<TenantFormDefaultsResponse> {
    return this.settings.ofTenant(scope);
  }

  @Put()
  @RequirePermission('canManageSettings')
  replace(
    @CurrentTenantScope() scope: TenantScope,
    @Body() body: unknown,
  ): Promise<TenantFormDefaultsResponse> {
    return this.settings.replaceOfTenant(
      scope,
      parseRequest(updateTenantFormDefaultsRequestSchema, body),
    );
  }
}
