import { Module } from '@nestjs/common';

import { PublicUrlModule } from '../../common/public-url/public-url.module';
import { RateLimitModule } from '../../common/rate-limit.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { OidcConfigModule } from '../../tenant-admin/oidc-config.module';
import { AuthModule } from '../auth.module';
import { OidcIdentityService } from './oidc-identity.service';
import { OidcLoginController } from './oidc-login.controller';
import { OidcLoginService } from './oidc-login.service';
import { OidcProviderService } from './oidc-provider.service';
import { OidcTenantsService } from './oidc-tenants.service';

/**
 * OIDC login — discovery, `state`/`nonce`/PKCE, callback, account binding to
 * **(issuer, subject)** (ADR-0005, ADR-0012).
 *
 * Two things this package inherits rather than decides: the account key is
 * `@@unique([oidcIssuer, oidcSubject])` on `user`, laid down, and
 * `openid-client` is a **runtime** import, so it belongs in `dependencies` —
 * `pnpm deploy --prod` throws `devDependencies` away while test, typecheck, lint
 * and build all stay green.
 *
 * **`PrismaModule` is imported here, and it is the one place in this milestone
 * where that is right rather than a smell.** Every *domain* module reaches rows
 * through the `TenantScope` the guard chain hands in, precisely so that no
 * unscoped client is within reach of a service that could forget a `tenant_id`.
 * A login has no session, therefore no scope, and therefore no such chain —
 * exactly as `AuthModule` has had `PrismaModule` for the same reason.
 * What keeps it honest is that the only reader is
 * {@link OidcTenantsService}, whose `select` names seven columns of `tenant` and
 * nothing else, and {@link OidcIdentityService}, whose one lookup is over the
 * composite key.
 *
 * `OidcConfigModule` brings the decision „bietet dieser Organisation SSO an?"
 * (`OidcConfigService.signIn`) and the key holder for the client secret
 * (`OidcSecretsService`). A second reader of those *columns* in this package
 * would be a second answer to the same question, and the fail-closed half of
 * the evidence would then hold in one of them and not the other.
 *
 * The one place that asks the question without `signIn` is
 * `OidcLoginService.offersSignIn`, and it is deliberate: the offer route is
 * reachable without a session and must not hold a client secret in clear
 * (review finding). It is not left to a comment — `oidc-login.service.spec.ts`
 * requires the two predicates to agree row by row.
 */
@Module({
  imports: [
    AuthModule,
    PrismaModule,
    OidcConfigModule,
    PublicUrlModule,
    RateLimitModule,
  ],
  controllers: [OidcLoginController],
  providers: [
    OidcLoginService,
    OidcIdentityService,
    OidcProviderService,
    OidcTenantsService,
  ],
})
export class OidcAuthModule {}
