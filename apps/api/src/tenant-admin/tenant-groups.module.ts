import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { TenantGroupsController } from './groups.controller';
import { TenantGroupsService } from './groups.service';

/**
 * The group editor of one organisation — five permissions, colour, rank; `admin` is the
 * system group and is neither editable nor deletable (handoff).
 *
 * Filled through `TenantScope.groups`. The system-group
 * protection is already in the delegate's `where` (`isSystem: false`); what this
 * module owes is the readable reason, and the „Gruppe ist in Benutzung" answer
 * *before* the delete rather than a 500 out of a `NO ACTION` foreign key.
 */
@Module({
  imports: [AuthModule, TenancyModule],
  controllers: [TenantGroupsController],
  providers: [TenantGroupsService],
})
export class TenantGroupsModule {}
