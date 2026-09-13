import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  groupWriteSchema,
  type GroupDetail,
  type GroupList,
} from '@formsache/shared';

import { SessionGuard } from '../auth/session.guard';
import { parseRequest } from '../common/parse-request';
import { CurrentTenantScope } from '../tenancy/current-tenant-scope.decorator';
import { GroupPermissionGuard } from '../tenancy/group-permission.guard';
import { RequirePermission } from '../tenancy/require-permission.decorator';
import type { TenantScope } from '../tenancy/tenant-scope';
import { TenantScopeGuard } from '../tenancy/tenant-scope.guard';
import { TenantGroupsService } from './groups.service';

/**
 * The group editor of the active Organisation — *Gruppen & Rechte* (handoff).
 *
 * Guarded by `can_manage_users`, the same flag as `TenantUsersController`: the
 * handoff nests this editor directly under the *Nutzerrechte (Tenant-Ebene)*
 * tab as one surface, and a group is nothing but the shape a role takes —
 * splitting the two behind different flags would let somebody manage roles
 * without being able to see what a role grants, or the reverse.
 *
 * The full guard chain at the controller, as everywhere in this application:
 * *tenant scope → group permissions → form restriction* (`CONTRIBUTING.md`). No
 * tenant in any path — the organisation is always the caller's active one.
 */
@Controller('tenant/groups')
@UseGuards(SessionGuard, TenantScopeGuard, GroupPermissionGuard)
export class TenantGroupsController {
  constructor(private readonly groups: TenantGroupsService) {}

  @Get()
  @RequirePermission('canManageUsers')
  list(@CurrentTenantScope() scope: TenantScope): Promise<GroupList> {
    return this.groups.list(scope);
  }

  @Post()
  @RequirePermission('canManageUsers')
  create(
    @CurrentTenantScope() scope: TenantScope,
    @Body() body: unknown,
  ): Promise<GroupDetail> {
    return this.groups.create(scope, parseRequest(groupWriteSchema, body));
  }

  /**
   * Replaces one group. The `admin` system group refuses with a readable
   * reason — see `TenantGroupsService.update`.
   */
  @Put(':id')
  @RequirePermission('canManageUsers')
  update(
    @CurrentTenantScope() scope: TenantScope,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<GroupDetail> {
    return this.groups.update(scope, id, parseRequest(groupWriteSchema, body));
  }

  /**
   * Deletes a group — refused for the system group and for one still holding
   * members, both **before** the delete is attempted.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('canManageUsers')
  remove(
    @CurrentTenantScope() scope: TenantScope,
    @Param('id') id: string,
  ): Promise<void> {
    return this.groups.remove(scope, id);
  }
}
