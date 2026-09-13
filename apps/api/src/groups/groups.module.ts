import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { GroupsController } from './groups.controller';
import { GroupsService } from './groups.service';

/**
 * Groups as a read-only resource. Managing them, and evaluating their
 * five permission flags, belongs elsewhere — this module exists so the tenant
 * boundary has something to be proven on.
 *
 * No `PrismaModule` import: nothing in here talks to the database except
 * through the `TenantScope` the guard hands in.
 */
@Module({
  imports: [AuthModule, TenancyModule],
  controllers: [GroupsController],
  providers: [GroupsService],
})
export class GroupsModule {}
