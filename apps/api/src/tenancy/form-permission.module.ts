import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { FormPermissionController } from './form-permission.controller';
import { FormPermissionService } from './form-permission.service';
import { TenancyModule } from './tenancy.module';

/**
 * Per-form user rights — the fourth link of the guard chain *tenant scope →
 * group permissions → form restriction*.
 *
 * It lives under `src/tenancy/` and not under `src/tenant-admin/` because it is
 * part of the chain, not part of the tenant administration: the guard it brings
 * (`FormRestrictionGuard`) runs on the forms, responses, export, settings and
 * notification routes of other modules. The restriction belongs **in** those
 * queries where a list is read (`ScopedFormQuery` takes the relation filter
 * `FormRestriction.formFilter()` produces) — applying it after the load is
 * the requirement's first reproduction.
 *
 * What this module carries is only the **editor** half. The evaluation needs
 * no module at all, and that is the point of `FormRestrictionGuard` injecting
 * nothing but `Reflector`: any controller can apply the fourth link without
 * importing anything that could reach the database on its own.
 *
 * No `PrismaModule` import — everything here reaches a row through the
 * `TenantScope` the chain hands in.
 */
@Module({
  imports: [AuthModule, TenancyModule],
  controllers: [FormPermissionController],
  providers: [FormPermissionService],
})
export class FormPermissionModule {}
