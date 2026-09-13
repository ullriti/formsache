import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import {
  tenantBaseUrlWriteSchema,
  type TenantBaseUrl,
} from '@formsache/shared';

import { SessionGuard } from '../auth/session.guard';
import { parseRequest } from '../common/parse-request';
import { CurrentTenantScope } from '../tenancy/current-tenant-scope.decorator';
import { GroupPermissionGuard } from '../tenancy/group-permission.guard';
import { RequireAllPermissions } from '../tenancy/require-permission.decorator';
import type { TenantScope } from '../tenancy/tenant-scope';
import { TenantScopeGuard } from '../tenancy/tenant-scope.guard';
import { TenantBaseUrlService } from './tenant-base-url.service';

/**
 * The organisation's own base address — the *Basis-Adresse*-Abschnitt of the
 * *Mailversand*-Reiter (ADR-0013 no. 3).
 *
 * **Its own route, not a field on `/tenant/smtp`.** ADR-0013 no. 3 draws the
 * line this controller mirrors in its path: the address is explicitly *not*
 * part of the indivisible SMTP block, so it is set and cleared through a
 * route of its own rather than smuggled into the one the whole-document rule
 * requires to stay whole.
 *
 * **No Organisation in the path**, for the identical reason `SmtpConfigController`
 * gives: the row addressed here is always the session's *active* tenant,
 * resolved by `TenantScopeGuard` from a membership the caller actually
 * holds. There is nothing to refuse a request for a foreign organisation's address,
 * because no request can name one.
 *
 * **No superadmin guard**, for the identical reason too — this belongs to
 * the organisation, not to the installation. The installation's own base address is
 * `system-settings`, superadmin-only; two rows, two owners.
 *
 * **The same two permissions `SmtpConfigController` requires, mirrored
 * rather than re-decided.** Both routes sit on the same tab and edit
 * properties of the same sending identity an organisation's notifications use; giving
 * the base address a looser gate than the block right next to it on screen
 * would be a second, weaker opinion about who may touch this tab, which is
 * exactly the kind of drift `CONTRIBUTING.md` warns against.
 */
@Controller('tenant/base-url')
@UseGuards(SessionGuard, TenantScopeGuard, GroupPermissionGuard)
export class TenantBaseUrlController {
  constructor(private readonly baseUrl: TenantBaseUrlService) {}

  @Get()
  @RequireAllPermissions('canManageSettings', 'canViewResponses')
  read(@CurrentTenantScope() scope: TenantScope): Promise<TenantBaseUrl> {
    return this.baseUrl.ofTenant(scope);
  }

  @Put()
  @RequireAllPermissions('canManageSettings', 'canViewResponses')
  replace(
    @CurrentTenantScope() scope: TenantScope,
    @Body() body: unknown,
  ): Promise<TenantBaseUrl> {
    return this.baseUrl.replaceOfTenant(
      scope,
      parseRequest(tenantBaseUrlWriteSchema, body),
    );
  }
}
