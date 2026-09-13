import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import type { GroupSummary } from '@formsache/shared';

import { CurrentTenantScope } from '../tenancy/current-tenant-scope.decorator';
import { SessionGuard } from '../auth/session.guard';
import { TenantScopeGuard } from '../tenancy/tenant-scope.guard';
import type { TenantScope } from '../tenancy/tenant-scope';
import { GroupsService } from './groups.service';

/**
 * Groups of the active Organisation — the first domain resource behind the full guard
 * chain, and the surface the requirements are proven on.
 *
 * The guards are declared at the controller, not per route: a route added
 * later inherits the chain instead of having to remember it. Order is the
 * chain's order — `SessionGuard` establishes who is asking, `TenantScopeGuard`
 * what they may see.
 *
 * Neither handler takes an id, a tenant or a Prisma client of its own. All
 * they can pass on is the scope, which is why "the endpoint forgot the tenant"
 * has no spelling here.
 */
@Controller('groups')
@UseGuards(SessionGuard, TenantScopeGuard)
export class GroupsController {
  constructor(private readonly groups: GroupsService) {}

  @Get()
  list(@CurrentTenantScope() scope: TenantScope): Promise<GroupSummary[]> {
    return this.groups.list(scope);
  }

  /**
   * A group of another organisation answers 404 here, with the same body a nonexistent
   * id gets — see `GROUP_NOT_FOUND_MESSAGE`.
   */
  @Get(':id')
  byId(
    @CurrentTenantScope() scope: TenantScope,
    @Param('id') id: string,
  ): Promise<GroupSummary> {
    return this.groups.byId(scope, id);
  }
}
