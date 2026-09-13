import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SessionTenantController } from './session-tenant.controller';
import { TenantScopeFactory } from './tenant-scope';
import { OptionalTenantScopeGuard } from './optional-tenant-scope.guard';
import { TenantScopeGuard } from './tenant-scope.guard';
import { TenantSwitchService } from './tenant-switch.service';

/**
 * The tenant boundary: the guard that derives it and the switcher that moves a
 * session across it.
 *
 * A module of its own rather than a corner of `AuthModule`, because the two
 * answer different questions — *who is this* and *what may this request see* —
 * and every domain module will import this one while only a few touch
 * authentication directly.
 *
 * `TenantScopeGuard` and `TenantScopeFactory` are both exported, and the
 * factory has to be: Nest resolves a guard's constructor in the module that
 * applies it, so without the export every consumer would need `PrismaModule`
 * — and would have an unscoped client in reach again. `PrismaModule` itself is
 * deliberately **not** re-exported here.
 */
@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [SessionTenantController],
  providers: [
    TenantScopeGuard,
    OptionalTenantScopeGuard,
    TenantScopeFactory,
    TenantSwitchService,
  ],
  exports: [TenantScopeGuard, OptionalTenantScopeGuard, TenantScopeFactory],
})
export class TenancyModule {}
