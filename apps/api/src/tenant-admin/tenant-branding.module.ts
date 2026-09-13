import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { FileStorageModule } from '../files/file-storage.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { TenantBrandingController } from './tenant-branding.controller';
import { TenantBrandingService } from './tenant-branding.service';
import { TenantLogoService } from './tenant-logo.service';

/**
 * Branding of one organisation — name, colours, stripe order, logo (the requirements, handoff *Erscheinungsbild & Login*).
 *
 * Registered in `app.module.ts` up front so that this module
 * adds its providers to a file of its own instead of editing the application
 * module, which concurrent work on other modules would
 * otherwise do at the same time.
 *
 * No `PrismaModule` import, exactly as `SettingsModule` has none: nothing here
 * reaches a row except through the `TenantScope` the guard chain hands in, and
 * `eslint.config.js` makes that a build failure rather than a review finding.
 */
@Module({
  // `FileStorageModule` provides exactly one binding and exports exactly one
  // token (ADR-0014 no. 18 point 4, guarded by `test/files/module-shape.spec.ts`),
  // so importing it here widens what this module can inject by the storage seam
  // and by nothing else — the adapter, the purge and the attachment download
  // stay outside it.
  imports: [AuthModule, TenancyModule, FileStorageModule],
  controllers: [TenantBrandingController],
  providers: [TenantBrandingService, TenantLogoService],
})
export class TenantBrandingModule {}
