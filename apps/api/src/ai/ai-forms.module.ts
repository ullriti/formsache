import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { RateLimitModule } from '../common/rate-limit.module';
import { ConfigModule } from '../config/config.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { AiFeatureGuard } from './ai-feature.guard';
import { AiFormsController } from './ai-forms.controller';
import { AiTenantSettingsController } from './ai-tenant-settings.controller';
import { AiFormsService } from './ai-forms.service';
import { AiModule } from './ai.module';
import { AiSettingsModule } from '../system-settings/ai-settings.module';

/**
 * **The route of the KI-Formularerstellung** (the requirements).
 *
 * A module of its own next to `AiModule` rather than a controller added there,
 * for the reason that module states about itself: it provides **the seam and
 * the counter and nothing else**, and „whoever adds a provider here widens what
 * an importer can inject". The route is a consumer of that seam, so it lives on
 * this side of the import and `AiModule` keeps its shape.
 *
 * That split is also what makes the evidence measurable: the public
 * fill-in path may import neither of these two modules, and
 * `test/ai/module-shape.spec.ts` asks the *assembled graph* rather than the
 * import strings — ESLint sees the latter and never the transitive DI chain
 * (one import „nur für die Uhr" defeated a list whose own comment
 * claimed the opposite). The lint entry for `apps/api/src/public/**` is added
 * **as well**, because it stops the one-keystroke version.
 *
 * **No `PrismaModule`.** Everything this module reaches goes through the
 * `TenantScope` the guard chain hands in — `ScopedAiUsageDelegate` for both the
 * reservation and the read — which is why `apps/api/src/ai/**` (without
 * `purge/`) stays off the allow-list in `eslint.config.js`.
 *
 * **`RateLimitModule`, stated rather than inherited.** `ThrottlerModule` is
 * `@Global()`, so `ThrottlerGuard` would resolve here anyway; naming the import
 * is what keeps the dependency visible **without** registering a second
 * `ThrottlerModule.forRoot` — there is exactly one in this application, and a
 * second replaces the first silently (`common/rate-limit.module.ts`).
 *
 * `ConfigModule` stays, although `AiFormsService` no longer reads any
 * `API_ENV` — the timeout now sits in the resolution that
 * `AiSettingsService` assembles. `AuthModule` re-exports it anyway, and the
 * stated import is this repository's build form: a dependency is named, not
 * inherited.
 *
 * ## Two controllers, and the second does **not** sit behind availability
 *
 * `AiTenantSettingsController` carries the organisation's own switch. It must
 * not inherit `AiFeatureGuard`: an organisation that has switched itself off
 * would otherwise get a 404 on its own switch and never come out again. *Using the feature* sits behind availability, *configuring
 * the feature* does not — which is why the guard stands at
 * `AiFormsController` and not at this module.
 */
@Module({
  imports: [
    AiModule,
    AiSettingsModule,
    AuthModule,
    TenancyModule,
    RateLimitModule,
    ConfigModule,
  ],
  controllers: [AiFormsController, AiTenantSettingsController],
  providers: [AiFormsService, AiFeatureGuard],
})
export class AiFormsModule {}
