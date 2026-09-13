import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PublicUrlModule } from '../common/public-url/public-url.module';
import { SecretBoxModule } from '../common/secret-box/secret-box.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { OidcConfigController } from './oidc-config.controller';
import { OidcConfigService } from './oidc-config.service';
import { OidcSecretsService } from './oidc-secrets.service';

/**
 * The OIDC configuration of one organisation and its client secret — the second
 * database secret of this application (handoff).
 *
 * **Both services are exported, and the public login is the reason.** The login has
 * no session and therefore no `TenantScope`; it resolves the organisation itself and
 * hands the row to `OidcConfigService.signIn`, which answers „so meldet man
 * sich hier an" or `null`. Exporting these two rather than letting the login flow build a
 * second reader is what keeps „ist SSO für diese Organisation benutzbar?" one
 * decision — and it keeps the key holder in one module, where the fact that
 * `open()` has exactly one caller class stays reviewable.
 *
 * No `PrismaModule`: nothing here reaches a row except through the
 * `TenantScope` the guard chain hands in, and `eslint.config.js` makes that a
 * build failure rather than a review finding.
 */
@Module({
  imports: [AuthModule, TenancyModule, SecretBoxModule, PublicUrlModule],
  controllers: [OidcConfigController],
  providers: [OidcConfigService, OidcSecretsService],
  exports: [OidcConfigService, OidcSecretsService],
})
export class OidcConfigModule {}
