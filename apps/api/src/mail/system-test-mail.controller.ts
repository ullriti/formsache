import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { testMailRequestSchema, type TestMailResult } from '@formsache/shared';

import { CurrentAuth } from '../auth/current-auth.decorator';
import type { AuthContext } from '../auth/request-context';
import { SessionGuard } from '../auth/session.guard';
import { SuperadminGuard } from '../auth/superadmin.guard';
import { parseRequest } from '../common/parse-request';
import { CurrentOptionalTenantScope } from '../tenancy/current-optional-tenant-scope.decorator';
import { OptionalTenantScopeGuard } from '../tenancy/optional-tenant-scope.guard';
import type { TenantScope } from '../tenancy/tenant-scope';
import { TEST_MAIL_RATE_LIMIT } from './test-mail.controller';
import { TestMailService } from './test-mail.service';

/**
 * „Testmail senden" **at system level** — the button that was missing up to
 * finding 29a.
 *
 * ## What was missing
 *
 * The tab *Systemeinstellungen → Mailserver & Basis-Adresse* could set up the
 * installation's mail server and not check it. The only
 * test mail of the application hangs on `TenantScopeGuard` and always goes over the
 * block of the **active Organisation** (`TestMailController`); a superadmin
 * who wanted to check the instance's mail server had no
 * way to do so at all — and since ADR-0023 there is no accidental one either, because no
 * Organisation ever uses the instance's block. That is the difference this route
 * closes: it demands `'system'` and does not read `tenant.smtp` in the first place
 * ({@link MailIdentitySource} gives the reason why this branch
 * ends before the column).
 *
 * ## Why a controller of its own — and why it lives here and not in the
 * `SystemSettingsModule`
 *
 * The **address** of the route belongs to the system administration
 * (`admin/system-settings/mail/test`, right next to `GET`/`PUT
 * .../mail`); its **implementation** belongs to the mail module, because the
 * identity resolution and the transport live there. Hanging it on
 * `SystemSettingsController` would not work: `TestMailModule` imports
 * `SystemSettingsModule` (the lowest level of the `Reply-To` chain stands in the
 * system row), and the way back would be a module cycle. A controller of its own in the
 * `TestMailModule` solves that without a second `TestMailService` and without a
 * second way to a socket.
 *
 * ## The guard chain, link by link
 *
 * `SessionGuard` → `SuperadminGuard` → `OptionalTenantScopeGuard`, and the
 * third link is the only point that needs an explanation.
 *
 * **`SuperadminGuard` decides who is allowed.** `can_manage_settings` of an
 * Organisation is expressly not enough here: the system block belongs to the
 * installation, and the reasoning of `SystemSettingsController` („Accepting
 * it here would let whoever administers one organisation set the default for
 * **all** of them") applies to checking just as much as to writing.
 *
 * **`OptionalTenantScopeGuard` decides only where the row is filed — und
 * lässt durch, wenn es keine gibt** (Review-Runde 3 Nr. 12).
 * `mail_log.tenant_id` is `NOT NULL` — every log row of this application
 * belongs to an Organisation, and the record a test mail leaves behind is
 * exactly such a row. The scope therefore does **not** say here which block
 * is chosen (that is said by the fixed value `'system'` below and by nothing else),
 * but in which mail log the attempt can be read up: that of the
 * superadmin's currently active Organisation.
 *
 * ⚠️ **Bis Review-Runde 3 stand hier `TenantScopeGuard`, und der Preis war zu
 * hoch.** Ein Superadministrator **ohne** Mitgliedschaft bekam
 * `NO_TENANT_SCOPE_MESSAGE` (403) statt einer Testmail — ausgerechnet in dem
 * Zustand, in dem man den Mailserver zum ersten Mal prüfen will: während der
 * Erstinbetriebnahme, bevor die erste Organisation existiert. Die
 * Berechtigung war nie die Frage (die entscheidet `SuperadminGuard`), nur die
 * Ablage der Zeile.
 *
 * Die Antwort ist die dritte, die damals nicht erwogen wurde: **senden,
 * nicht protokollieren.** Die Spalte bleibt `NOT NULL` — sie trägt die
 * Mandantentrennung des Versandprotokolls, und die für einen Knopf
 * aufzuweichen wäre der teuerste denkbare Tausch. Ohne Organisation entfällt
 * der Eintrag, und der Verlust wird benannt statt verschwiegen: der Versuch
 * ist hinterher nirgends nachlesbar (`TestMailService.sendWithoutTenant`),
 * und die Oberfläche schreibt genau das an den Knopf.
 *
 * ## The same number as next door, and for the same reason
 *
 * {@link TEST_MAIL_RATE_LIMIT} is **imported**, not copied out: it is
 * the same property — „wie schnell kann eine Herkunft Verbindungsversuche
 * auslösen" —, and two numbers for one property are the ones of which one
 * drifts. That a superadmin stands here changes nothing about it; the value
 * does not defend against them but against a script that has their session.
 */
@Controller('admin/system-settings/mail/test')
@UseGuards(
  SessionGuard,
  SuperadminGuard,
  OptionalTenantScopeGuard,
  ThrottlerGuard,
)
@Throttle({ default: TEST_MAIL_RATE_LIMIT })
export class SystemTestMailController {
  constructor(private readonly testMail: TestMailService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  send(
    @CurrentOptionalTenantScope() scope: TenantScope | null,
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<TestMailResult> {
    // The same schema as next door, and thus the same assurance: a
    // checked address or nothing, and no field in which a host, a port
    // or a password could travel. The weighing-up about the free recipient stands
    // in full at the docblock of `TestMailController`; it comes out rather
    // more easily here, because on this route only whoever may also write the
    // system block stands anyway.
    const request = parseRequest(testMailRequestSchema, body);
    const recipientEmail = request.recipientEmail ?? auth.user.email;
    // **Ohne Organisation: senden, nicht protokollieren.** Zwei Methoden und
    // kein `scope === null`-Zweig in einer: die eine schreibt eine
    // `mail_log`-Zeile und die andere nicht, und das ist der Unterschied, den
    // ein Leser dieser Route sehen soll.
    return scope === null
      ? this.testMail.sendWithoutTenant(recipientEmail)
      : this.testMail.send(
          scope,
          recipientEmail,
          // **Fixed, not derived.** This route exists precisely to check the
          // block of the installation — also (and especially) when the
          // active Organisation has stored one of its own.
          'system',
        );
  }
}
