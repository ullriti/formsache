import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import {
  tenantReplyToWriteSchema,
  type TenantReplyTo,
} from '@formsache/shared';

import { SessionGuard } from '../auth/session.guard';
import { parseRequest } from '../common/parse-request';
import { CurrentTenantScope } from '../tenancy/current-tenant-scope.decorator';
import { GroupPermissionGuard } from '../tenancy/group-permission.guard';
import { RequireAllPermissions } from '../tenancy/require-permission.decorator';
import type { TenantScope } from '../tenancy/tenant-scope';
import { TenantScopeGuard } from '../tenancy/tenant-scope.guard';
import { TenantReplyToService } from './tenant-reply-to.service';

/**
 * An organization's reply-to address — the *Antwortadresse* section of the
 * *Mailversand* tab.
 *
 * **A route of its own, not a field on `/tenant/smtp`.** Exactly this question
 * put the decision before the build, and the answer was "next to it": the
 * block is indivisible because it carries a secret, a reply-to address is
 * none — were it inside, it would not be changeable without the SMTP password.
 * So the same standing that `TenantBaseUrlController` already has.
 *
 * **No organization in the path**, for the reason `SmtpConfigController` names: the
 * row addressed is always the session's *active* organization, which
 * `TenantScopeGuard` resolves from a membership actually held.
 *
 * **The same two permissions as the two neighbouring routes**, mirrored instead
 * of decided anew: all three edit properties of the same mail dispatch on
 * the same tab, and a weaker gate for the field next door would be a
 * second opinion about who may touch this tab.
 */
@Controller('tenant/reply-to')
@UseGuards(SessionGuard, TenantScopeGuard, GroupPermissionGuard)
export class TenantReplyToController {
  constructor(private readonly replyTo: TenantReplyToService) {}

  @Get()
  @RequireAllPermissions('canManageSettings', 'canViewResponses')
  read(@CurrentTenantScope() scope: TenantScope): Promise<TenantReplyTo> {
    return this.replyTo.ofTenant(scope);
  }

  @Put()
  @RequireAllPermissions('canManageSettings', 'canViewResponses')
  replace(
    @CurrentTenantScope() scope: TenantScope,
    @Body() body: unknown,
  ): Promise<TenantReplyTo> {
    return this.replyTo.replaceOfTenant(
      scope,
      parseRequest(tenantReplyToWriteSchema, body),
    );
  }
}
