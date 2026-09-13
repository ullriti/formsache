import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { oidcConfigWriteSchema, type OidcConfig } from '@formsache/shared';

import { SessionGuard } from '../auth/session.guard';
import { parseRequest } from '../common/parse-request';
import { CurrentTenantScope } from '../tenancy/current-tenant-scope.decorator';
import { GroupPermissionGuard } from '../tenancy/group-permission.guard';
import { RequireAllPermissions } from '../tenancy/require-permission.decorator';
import type { TenantScope } from '../tenancy/tenant-scope';
import { TenantScopeGuard } from '../tenancy/tenant-scope.guard';
import { OidcConfigService } from './oidc-config.service';

/**
 * The organisation's identity provider — the lower half of the *Erscheinungsbild &
 * Login* tab (handoff).
 *
 * **There is no organisation in the path, and that is the security design, not a
 * shortcut.** Exactly the statement `TenantSettingsController` makes for the
 * form standards: the configuration addressed here is always the one of the
 * session's *active* tenant, resolved by `TenantScopeGuard` from a membership
 * the caller actually holds. A request has no way to *name* another organisation, so
 * „die OIDC-Konfiguration einer fremden Organisation ist weder les- noch schreibbar"
 * needs no refusal — there is nothing to refuse. Somebody who wants another
 * organisation's configuration has to switch into it first, which is the boundary the
 * tenant switcher already draws.
 *
 * **Both permissions, and the second one is the deliberate part.** Whoever sets
 * issuer, client id and client secret decides **which identity provider vouches
 * for the members of this organisation** — that is a statement about who may sign in,
 * not about how a form looks. Leaving it at `can_manage_settings` alone would
 * give a group that may set up the organisation a lever on its login, which
 * is the same shape as the two cases this project already answered this way:
 * the export needs `can_export` **and** `can_view_responses`, and the mail
 * log needs `can_manage_form_settings` **and** `can_view_responses`
 * . The branding half of the tab is a display question and
 * keeps its own, weaker requirement; a caller who may see the colours but not
 * this block gets a 403 here, and the tab shows the block **absent** rather than
 * disabled.
 *
 * No `@Throttle`: there is exactly one `ThrottlerModule.forRoot` in this
 * application and these routes sit behind a session, whose entrance already
 * carries the strict limit. A second registration would silently replace the
 * first one's configuration (`common/rate-limit.module.ts`).
 */
@Controller('tenant/oidc')
@UseGuards(SessionGuard, TenantScopeGuard, GroupPermissionGuard)
export class OidcConfigController {
  constructor(private readonly oidc: OidcConfigService) {}

  @Get()
  @RequireAllPermissions('canManageSettings', 'canManageUsers')
  read(@CurrentTenantScope() scope: TenantScope): Promise<OidcConfig> {
    return this.oidc.ofTenant(scope);
  }

  @Put()
  @RequireAllPermissions('canManageSettings', 'canManageUsers')
  replace(
    @CurrentTenantScope() scope: TenantScope,
    @Body() body: unknown,
  ): Promise<OidcConfig> {
    return this.oidc.replaceOfTenant(
      scope,
      parseRequest(oidcConfigWriteSchema, body),
    );
  }
}
