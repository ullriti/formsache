import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import {
  superadminPromoteSchema,
  type SuperadminAdded,
  type SuperadminList,
} from '@formsache/shared';

import { CurrentAuth } from '../auth/current-auth.decorator';
import type { AuthContext } from '../auth/request-context';
import { SessionGuard } from '../auth/session.guard';
import { SuperadminGuard } from '../auth/superadmin.guard';
import { parseRequest } from '../common/parse-request';
import { SuperadminsService } from './superadmins.service';

/**
 * How many calls per minute these routes take.
 *
 * The same number and the same reasoning as with the system settings next
 * door: sixty is far more than opening a tab costs, and far less than a loop
 * could do to a database that answers public fill-in requests on the side.
 *
 * With `@Throttle` at the controller and not through a second throttler: there
 * is exactly **one** `ThrottlerModule.forRoot` in this application
 * (`common/rate-limit.module.ts`), and a second one replaces it silently.
 */
const SUPERADMINS_RATE_LIMIT = { limit: 60, ttl: 60_000 } as const;

/**
 * **The system administration of this installation — who carries it**
 * (ADR-0029).
 *
 * Up to here an installation got its first superadministrator via
 * `POST /api/setup` or `scripts/create-superadmin.sh` and a **second** one via
 * nothing at all: both ways demand *zero* rows in `user` (ADR-0022 §3), and
 * `is_superadmin` was settable via no route. Whoever lost the one access got to
 * the administration only via the database.
 *
 * ## The guard is the one that protects the system administration anyway
 *
 * `SessionGuard` then `SuperadminGuard` — the same chain as
 * `AdminTenantsController` and `SystemSettingsController`, none of its own.
 * That is not thrift: a second guard for "may appoint" would be a second answer
 * to "who administers this system", and the wrong one of the two would only be
 * noticed once it had let somebody through.
 *
 * Every missing link is missing for the same reason as there:
 *
 * - **No `TenantScopeGuard`.** A superadministrator is a member of nothing when
 *   an installation is fresh — and precisely that one has to be able to appoint
 *   the second.
 * - **No `GroupPermissionGuard`.** `can_manage_users` is given out by an
 *   organisation to its own people. Letting it count here would mean: whoever
 *   administers *one* organisation appoints themselves access to **all** of
 *   them. The integration test for it turns away exactly this person —
 *   administrator of their organisation with all six group permissions, no
 *   superadmin, 403.
 *
 * ## "Nobody appoints themselves" — and the way that would get around it
 *
 * It follows from the guard: whoever arrives here is already a
 * superadministrator, and appointing one's own account is answered by the route
 * with „verwaltet das System bereits". A way past it was looked for
 * nevertheless, and there are three places where one could arise — all three
 * are shut:
 *
 * 1. **A field in the body.** `superadminPromoteSchema` is a `strictObject`
 *    with exactly one field; an `isSuperadmin` sent along is a 400.
 * 2. **A body at the withdrawal.** `DELETE` below takes none — the target
 *    stands in the path, and there is no document in which something could
 *    travel along.
 * 3. **The other write paths onto `user`.** They write field by field instead
 *    of by spread (`admin.repository.ts`, `tenancy/tenant-scope.ts`), and no
 *    schema in `packages/shared` has a field for it. The existing integration
 *    test that measures `isSuperadmin: true` in the body of an *other* route as
 *    without effect holds unchanged.
 *
 * ## No CSRF exception
 *
 * `POST` and `DELETE` stand behind the global `CsrfGuard` like every other
 * mutating administration route. This one here is the last one for which one
 * would want to make an exception.
 */
@Controller('admin/superadmins')
@UseGuards(SessionGuard, SuperadminGuard, ThrottlerGuard)
@Throttle({ default: SUPERADMINS_RATE_LIMIT })
export class SuperadminsController {
  constructor(private readonly superadmins: SuperadminsService) {}

  /**
   * Who carries the system administration.
   *
   * **The list is short and carries accounts, not members.** It is explicitly
   * *no* list of all the people of the installation: such a one does not exist
   * here and shall not exist — the superadmin interface reads nothing of an
   * organisation's domain data, and "who works in organisation X" is precisely
   * that. That is why the appointment below names an address and no id out of a
   * selection list.
   */
  @Get()
  list(): Promise<SuperadminList> {
    return this.superadmins.list();
  }

  /**
   * **Appoint an existing account as superadministrator.**
   *
   * `POST` onto the list and not `PUT` onto an account: what comes into being
   * is an entry in *this* list. A `PUT /admin/users/:id` with a permission
   * field in the body would be the build form in which `is_superadmin` becomes
   * a value that a document carries again.
   *
   * **Oder ein neues, wenn es die Adresse noch nicht gibt** (Review-Runde 3
   * Nr. 13). Bis dahin stand hier: „the route creates none", mit der
   * Begründung, ein Konto ohne Organisation nähme der Aufräumlauf mit. Das
   * stimmt für jedes Konto **außer** diesem: `deleteHomelessAccount` trägt
   * `isSuperadmin: false` wörtlich in seinem `where`, und ADR-0029 schreibt
   * dazu, „keine Organisation" sei der Normalzustand eines
   * Superadministrators. Der Grund gegen die fünfte Stelle war damit von
   * Anfang an keiner — der Wunsch, jemanden einzuladen, der in keiner
   * Organisation ist, ist der normale Fall der zweiten Systemverwaltung.
   *
   * Was daraus folgt, steht an `SuperadminsService.invite`: erst planen (ohne
   * Mailserver entsteht kein Konto), dann schreiben, dann verschicken — und
   * das Verschicken geht an der Warteschlange vorbei, weil deren Zeilen einer
   * Organisation gehören (`SuperadminInvitationService`).
   *
   * 201 with the new row: the interface names the person's name afterwards, and
   * it knows that name only from this response — what it sent was an address.
   */
  @Post()
  promote(
    @Body() body: unknown,
    @CurrentAuth() auth: AuthContext,
  ): Promise<SuperadminAdded> {
    return this.superadmins.promote(
      parseRequest(superadminPromoteSchema, body),
      auth.user.id,
    );
  }

  /**
   * **Withdraw the appointment.**
   *
   * `DELETE` onto the entry of the list, without a body and without a typed
   * confirmation: unlike with the deletion of an organisation nothing is lost
   * here that could not be fetched back — a second superadministrator appoints
   * the same person again in one click. The confirmation prompt stands in the
   * interface, where it can tell apart the two cases that concern it (oneself,
   * somebody else).
   *
   * **`@CurrentAuth()` is for the log, not for the decision.** The guard above
   * has long since decided whether this request may do anything; what the
   * session contributes is the one id that the log line names next to that of
   * the target — the only bookkeeping that exists about this action.
   *
   * 204: What the caller has withdrawn is what they were just looking at.
   */
  @Delete(':userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  demote(
    @Param('userId') userId: string,
    @CurrentAuth() auth: AuthContext,
  ): Promise<void> {
    return this.superadmins.demote(userId, auth.user.id);
  }
}
