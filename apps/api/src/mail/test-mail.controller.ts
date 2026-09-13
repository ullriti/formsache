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
import { parseRequest } from '../common/parse-request';
import { CurrentTenantScope } from '../tenancy/current-tenant-scope.decorator';
import { GroupPermissionGuard } from '../tenancy/group-permission.guard';
import { RequireAllPermissions } from '../tenancy/require-permission.decorator';
import type { TenantScope } from '../tenancy/tenant-scope';
import { TenantScopeGuard } from '../tenancy/tenant-scope.guard';
import { TestMailService } from './test-mail.service';

/**
 * How often **one client address** may press „Testmail senden" .
 *
 * Not one session and not one account: every limit of this application counts
 * the address `clientAddress` derives, an IPv6 caller reduced to its /64
 * (`common/rate-limit.module.ts`). Behind one NAT the admins of an organisation share
 * this budget — accepted, because the property being defended is „wie schnell
 * kann *eine Herkunft* Verbindungsversuche auslösen", and a per-session counter
 * would be one a caller can reset by logging in again (a review finding —
 * an earlier version of this line claimed the opposite).
 *
 * **These are the two routes in the application a caller can make dial an
 * arbitrary host on demand and get the outcome back in the same response**
 * (ADR-0013 „Consequences"; the second one is the superadmin variant in
 * `system-test-mail.controller.ts`, which uses the same number).
 * `MAIL_LOG_RETRY_RATE_LIMIT`
 * next door (`mail-log.controller.ts`) allows 30 a minute because a retry
 * re-sends a mail whose destination somebody else already chose; this route
 * lets the caller *choose* the destination (Konzept no. 38's own grant) and then
 * connects immediately, which is exactly the shape a port scan needs — so it
 * gets the tighter figure, close to the ten a minute `oidc-login.controller.ts`
 * allows for *starting* a login, a comparable „this dials out" action. Ten a
 * minute is generous for a person correcting a hostname or a port — several
 * attempts within the same minute while fixing a typo — and tight enough that
 * a script cannot turn the categorised answers of `mail-error-category.ts`
 * into a useful scan rate; the connect and greeting timeouts of
 * `mail-timeouts.ts` (15 s/10 s) already bound how fast even an *allowed*
 * attempt can return.
 *
 * Named with `@Throttle` on the route, not a second `ThrottlerModule.forRoot`
 * — there is exactly **one** in this application (`common/rate-limit.module.ts`).
 *
 * **Exported**, because the superadmin variant next door
 * (`system-test-mail.controller.ts`) defends the same property and
 * therefore has to use the same number instead of one of its own that drifts.
 */
export const TEST_MAIL_RATE_LIMIT = { limit: 10, ttl: 60_000 } as const;

/**
 * „Testmail senden" — the concept, the requirement.
 *
 * A route of its own next to `SmtpConfigController` (`tenant/smtp`) rather
 * than a method added there: the two answer different questions — one reads
 * and writes a configuration document, this one dials it — and giving the
 * dial its own throttle bucket ({@link TEST_MAIL_RATE_LIMIT}) means a burst of
 * saves on the *Mailversand*-Reiter cannot exhaust the budget a connection
 * attempt needs, or the other way round.
 *
 * **Same guard chain and the same permission pair as `SmtpConfigController`**,
 * mirrored rather than re-decided: no tenant in the path (the block under test
 * is always the session's *active* Organisation, resolved by `TenantScopeGuard`), and
 * `canManageSettings` **and** `canViewResponses` — whoever may point every
 * notification of this organisation at a mail server may read what those
 * notifications carry, which is the same reasoning `SmtpConfigController`
 * gives in full.
 *
 * **No form-related guard.** A Testmail is not about one form; it is about the
 * organisation's sending identity, exactly as `SmtpConfigController` is.
 *
 * ## The recipient may differ — the continuation of finding 29b
 *
 * Until 2026-08-15 it stood here that the recipient was fixed to the address from the
 * session, and the reasoning was: this route dials an arbitrary machine on
 * demand, a free recipient would turn it into a port scanner
 * or an open relay. The user has decided that a
 * differing address must be specifiable. The old reasoning is therefore
 * **carried forward and not wiped away** — what stands here is which part of it
 * holds and which never held:
 *
 * - **The port scanner is untouched.** It hung on the free *host*, not on the
 *   free recipient, and the host remains unreachable:
 *   `testMailRequestSchema` is a `strictObject` without a single
 *   transport field, the block comes from the column, and the reason for a
 *   failure is on this route **always** a category and never the
 *   wording of the far side (`TestMailService`, „The failure reason is a
 *   category"). None of that has moved.
 * - **It is not a relay, because the content is not selectable.** Subject and
 *   body are fixed text of this application (`TEST_MAIL_SUBJECT`,
 *   `testMailBody`); the request carries no field from which a single character of it
 *   could come. Whoever points this route at somebody else's address can send them a
 *   single, always identical sentence — and that sentence says that it means
 *   nothing. Nor does it become a distribution list: one request is exactly
 *   one address, and nothing on this path splits a string apart.
 * - **The permission covers it.** Whoever gets through here holds
 *   `canManageSettings` **and** `canViewResponses` in this organisation.
 *   That person can already create a form today, hang a notification
 *   with a fixed recipient address on it and submit it — then a mail
 *   goes out **with freely chosen content** to a freely chosen address,
 *   over the same block. So the route gives them no capability
 *   they do not long since have in a stronger form; it saves them four clicks.
 * - **The number stays and the trail stays.** {@link TEST_MAIL_RATE_LIMIT} —
 *   ten per minute and origin address — applies unchanged, every attempt
 *   writes a `mail_log` row, and **the chosen address stands in that row**.
 *   Abuse is thereby not impossible, but slow and
 *   attributable; that is the property that counts here.
 *
 * **What remains as a residue, spoken out instead of argued away:** somebody
 * authorised can use the route to find out whether a relay accepts a foreign address
 * („Der Mailserver hat die Nachricht nicht angenommen" against „gesendet")
 * — address probing at ten attempts per minute. Against their *own* block
 * they thereby answer a question about a server they run themselves —
 * and since ADR-0023 it is always their own: this route sees no other
 * block. They would get the same information via a notification as well. The
 * residue is named and borne, not closed.
 */
@Controller('tenant/smtp/test')
@UseGuards(SessionGuard, TenantScopeGuard, GroupPermissionGuard)
export class TestMailController {
  constructor(private readonly testMail: TestMailService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @RequireAllPermissions('canManageSettings', 'canViewResponses')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: TEST_MAIL_RATE_LIMIT })
  send(
    @CurrentTenantScope() scope: TenantScope,
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<TestMailResult> {
    // The only value the request may contribute is a checked
    // address; the `strictObject` lets nothing else in (see the
    // section „Der Empfänger darf abweichen" above). `null` means „an mich
    // selbst" — the schema's default, so that a caller who says nothing
    // gets exactly the old behaviour.
    const request = parseRequest(testMailRequestSchema, body);
    return this.testMail.send(
      scope,
      request.recipientEmail ?? auth.user.email,
      // This route checks the block of **this organisation** and only that one: if it
      // has none, it answers „kein Mailserver eingetragen" instead of sending
      // over the instance's (ADR-0023). Whoever wants to check the instance's
      // mail server takes the superadmin route.
      'tenant',
    );
  }
}
