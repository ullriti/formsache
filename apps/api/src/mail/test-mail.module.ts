import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PublicUrlModule } from '../common/public-url/public-url.module';
import { RateLimitModule } from '../common/rate-limit.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { MailModule } from './mail.module';
import { SystemTestMailController } from './system-test-mail.controller';
import { TestMailController } from './test-mail.controller';
import { TestMailService } from './test-mail.service';

/**
 * „Testmail senden".
 *
 * **`MailModule`, not a second answer to „welche Identität, welcher
 * Transport?".** `TestMailService` asks the very `MailIdentityService` and
 * sends through the very `MailTransport` the worker uses — imported here
 * rather than re-provided, the same rule `SmtpConfigModule` already states for
 * `MailSecretsService`.
 *
 * **`PrismaModule`, unlike `SmtpConfigModule`.** That module's service never
 * reaches a row outside the `TenantScope` the guard hands in; this one writes
 * a genuine `mail_log` row for a genuine send attempt, which `TenantScope` has no delegate for — the reading side of
 * the mail log deliberately stays behind `ScopedMailLogDelegate`
 * (`mail.module.ts`), and a testmail is a write with no existing row to scope
 * to. `apps/api/src/mail/**` carries the write-access allowance in
 * `eslint.config.js` for exactly this shape of exception, and every query this
 * service makes is bound to `scope.tenant.find()`'s own id — never a caller's
 * parameter.
 *
 * **`RateLimitModule`, stated rather than inherited.** `ThrottlerModule` is
 * `@Global()`, so `ThrottlerGuard` resolves here either way — which is exactly
 * why the import belongs in the list: `mail-log.module.ts` writes the rule down
 * („importing it states the dependency **without** registering a second
 * `ThrottlerModule.forRoot`"), and a second `forRoot` silently replaces the
 * first, which is how the login's limit once disappeared with nothing turning
 * red. A route whose throttle is its named SSRF defence (* `TEST_MAIL_RATE_LIMIT`) is the last one that should depend on an invisible
 * global (a review finding of the test-mail review).
 */
@Module({
  imports: [
    AuthModule,
    TenancyModule,
    RateLimitModule,
    MailModule,
    PrismaModule, // Konzept no. 67: the lowest level of the `Reply-To` chain stands in the
    // system row. Only read — this module does not write it.
    SystemSettingsModule,
    // The base address for the footer. Only read — which of the two
    // levels applies is decided by `TestMailService.shellFor` on `source`.
    PublicUrlModule,
  ],
  // Two controllers, **one** service: the organisation variant behind
  // `GroupPermissionGuard` and the system variant behind `SuperadminGuard`
  // (finding 29a). They differ in the guard chain and in the one
  // fixed value `'tenant'`/`'system'`; everything below that — identity
  // resolution, transport, log row — is the same place. A second service would
  // be a second way to a socket, and of those there is deliberately exactly
  // one here.
  //
  // The system controller lies **here** and not in the `SystemSettingsModule`,
  // although its address belongs there: this module already imports
  // `SystemSettingsModule`, and the way back would be a cycle. Its own
  // docblock writes that out.
  controllers: [TestMailController, SystemTestMailController],
  providers: [TestMailService],
})
export class TestMailModule {}
