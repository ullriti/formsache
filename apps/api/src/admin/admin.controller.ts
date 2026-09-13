import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  aiQuotaWriteSchema,
  tenantCreateSchema,
  tenantDeleteSchema,
  type DeletedTenantList,
  type TenantOverview,
  type TenantOverviewRow,
} from '@formsache/shared';

import { CurrentAuth } from '../auth/current-auth.decorator';
import type { AuthContext } from '../auth/request-context';
import { SessionGuard } from '../auth/session.guard';
import { SuperadminGuard } from '../auth/superadmin.guard';
import { parseRequest } from '../common/parse-request';
import { AdminService } from './admin.service';

/**
 * The superadmin overview of every organisation — KPI tiles, the table, „+ Neuer
 * Tenant" (the requirements, the design handoff).
 *
 * ## Why these routes exist at all instead of a parameter on the old ones
 *
 * It holds it down in as many words: `GET`/`PUT /api/tenant/form-defaults` carry
 * **no** tenant in their path, and *that absence is* their tenant boundary —
 * „eine Grenze, die man gar nicht adressieren kann, ist stärker als eine, die
 * man adressiert und abgewiesen bekommt". The superadmin surface has to address
 * a foreign Organisation, so it gets its own prefix rather than a `:tenantId` bolted
 * onto the organisation-facing routes. Both properties then hold at once, and neither
 * depends on a guard being remembered.
 *
 * `test/admin/admin-routes.spec.ts` keeps the first half honest: it walks the
 * routes Nest **actually registered** and refuses any path segment under
 * `/api/tenant/` or `/api/forms/` that names a tenant. A maintained list of
 * paths would not be a guard but a second piece of documentation — it would
 * stay green for the path nobody added it to.
 *
 * ## The guard chain is short, and every missing link is missing on purpose
 *
 * `SessionGuard` then `SuperadminGuard`, exactly as
 * `SystemSettingsController` — see the long form there:
 *
 * - **No `TenantScopeGuard`.** This surface belongs to no organisation. Requiring a
 *   scope would tie the administration of the installation to a membership, and
 *   the first superadmin of a fresh installation is a member of nothing —
 *   which is precisely the person who has to create the first organisation.
 * - **No `GroupPermissionGuard`.** `can_manage_users` is granted by an organisation to
 *   its own people; accepting it here would let whoever administers one organisation
 *   create organisations and read every other organisation's counters.
 *
 * The refusal is **403 and not 404** : the caller is
 * signed in and the route is no secret — it is in the OpenAPI surface and every
 * installation has it. A 404 would be a riddle instead of an answer, and it
 * would hide nothing that is not already public.
 *
 * ## No CSRF exemption
 *
 * The `POST` sits behind the global `CsrfGuard` like every other mutating admin
 * route.
 */
@Controller('admin/tenants')
@UseGuards(SessionGuard, SuperadminGuard)
export class AdminTenantsController {
  constructor(private readonly admin: AdminService) {}

  /**
   * Every organisation with its counters, plus the four KPI totals.
   *
   * The one cross-tenant listing this application has, and its payload is
   * deliberately thin: identity, branding and four numbers per organisation. No form
   * title, no user name, no stored value — see `AdminRepository`.
   */
  @Get()
  list(): Promise<TenantOverview> {
    return this.admin.overview();
  }

  /**
   * „+ Neue Organisation" .
   *
   * The organisation, its three standard groups and its first administrator, in one
   * transaction. What the payload deliberately cannot carry is the organisation's form
   * standards: `tenantCreateSchema` has no field for them, so `form_defaults`
   * keeps its `{}` and the system row goes on reaching this organisation.
   *
   * An address that already has an account makes that person the first
   * administrator **without touching their account** — the same rule „Person
   * hinzufügen" follows one level down. The typed password is
   * then unused; see `AdminRepository.createTenant`.
   *
   * **`admin: null` means "myself"** (review finding 7), and *who* that is
   * is decided by this line: the id comes from `@CurrentAuth()`, that is from
   * the session that `SessionGuard` resolved and `SuperadminGuard` confirmed as
   * a superadministrator. Unlike with the deletion further down, it is
   * here **not only for the log**: it is the value that gets written. A
   * field in the body naming an account would give every caller of this route
   * a foreign person as administrator — the schema has none, and the
   * integration test "a non-superadmin does not get through here" holds the
   * other half.
   */
  @Post()
  create(
    @Body() body: unknown,
    @CurrentAuth() auth: AuthContext,
  ): Promise<TenantOverviewRow> {
    return this.admin.create(
      parseRequest(tenantCreateSchema, body),
      auth.user.id,
    );
  }

  /**
   * **„Gelöschte Organisationen"** — the section of this same overview a deleted Organisation
   * comes back from.
   *
   * **Declared before {@link find}, and that is load-bearing.** Nest matches in
   * declaration order, so `deleted` has to be registered before `:tenantId` or
   * the literal segment would be read as an id. `AdminService.find` refuses a
   * non-uuid with the ordinary 404 as the floor under that (`requireTenantId`),
   * and `tenant-trash.spec.ts` measures this route answering a list — which is
   * what turns a later reordering into a red test rather than into a 404 in an
   * installation.
   *
   * A section of the overview and **not a second, systemwide trash**
   * : the payload carries identity and `deletedAt` and nothing of
   * what is inside the organisation. The organisation itself stays unbetretbar — opening it for
   * superadmins so its own tenant-bound trash became reachable would have
   * turned the six `tenant.deleted_at` filters into six filters *with an
   * exception*, which is the shape in which a forgotten special case lets
   * somebody go on working inside a deleted Organisation.
   */
  @Get('deleted')
  listDeleted(): Promise<DeletedTenantList> {
    return this.admin.listDeleted();
  }

  /**
   * One organisation — what „Verwalten" opens with.
   *
   * **The one route of this application whose path names an organisation**, and the
   * route guard above is what keeps it the only one.
   */
  @Get(':tenantId')
  find(@Param('tenantId') tenantId: string): Promise<TenantOverviewRow> {
    return this.admin.find(tenantId);
  }

  /**
   * **Deleting an organisation — into the trash, 30 days** .
   *
   * **The body is the confirmation**: `{ confirmName }` has to equal the organisation's
   * `name`, checked on the server (`tenantDeleteSchema`). A confirmation that
   * only lives in the dialog is a confirmation the next client does not have,
   * and this is the one verb of this application that takes a whole organisation out of
   * service in a single request — every one of its people loses their scope on
   * their next request, its public addresses answer 404, its queued mail stops.
   *
   * A body on a `DELETE` and not `POST :tenantId/delete`: the resource is the
   * Organisation and the verb is removing it, exactly as `DELETE /api/forms/:id` reads.
   * The payload is not a variant of the action — there is no flag here that
   * turns a reversible verb into an irreversible one (which is why physical
   * deletion is its own route in `FormsController`) — it is the proof that
   * somebody read the name off the row.
   *
   * **No membership, no `TenantScopeGuard`** : it is Verwaltung,
   * and requiring a membership would make a superadmin join an organisation to close it.
   * The restriction on the superadmin's cross-tenant reach is untouched — nothing fachlich of the organisation is read or returned.
   *
   * 204: what the caller deleted is what they were looking at.
   *
   * **`@CurrentAuth()` is here for the protocol, not for the decision**
   * (a security review finding): the guard chain above has already
   * settled whether this request may delete an organisation, and nothing in
   * `AdminService` re-asks. What the session supplies is *who* — the one id the
   * log line names beside the organisation's (`AdminService.logger`).
   */
  @Delete(':tenantId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
    @CurrentAuth() auth: AuthContext,
  ): Promise<void> {
    return this.admin.remove(
      tenantId,
      parseRequest(tenantDeleteSchema, body),
      auth.user.id,
    );
  }

  /**
   * **Bringing a deleted organisation back** .
   *
   * `POST` and not `DELETE`/`PUT`, and no confirmation to type: it is an action
   * that undoes, and a hurdle in front of the way back turns a mistake into a
   * permanent one — the same reading `POST /api/forms/:id/restore` takes.
   *
   * It is the one route here that deliberately addresses a **deleted** Organisation;
   * every other one answers 404 for exactly that state.
   */
  @Post(':tenantId/restore')
  @HttpCode(HttpStatus.NO_CONTENT)
  restore(
    @Param('tenantId') tenantId: string,
    @CurrentAuth() auth: AuthContext,
  ): Promise<void> {
    return this.admin.restore(tenantId, auth.user.id);
  }

  /**
   * **Setting the AI quota of an organisation** .
   *
   * `PUT` and not `PATCH`: the body carries the **whole** value, not a
   * change to it, and sending the same thing twice has the same result as
   * once — which, with a cost switch, is the property one wants to
   * have.
   *
   * **Why this route lies here and not in the organisation administration**: it
   * sets a number that determines a *bill* of the operator. An
   * organisation admin who were allowed to raise it would be a cost lever without a guard
   * . What an organisation may **read** about itself stands in
   * `GET /api/ai/quota` and lies behind `can_build` — two questions, two
   * guards, two routes.
   *
   * 204: the caller has just said themselves which number applies now; sending
   * it back to them would be an echo. The overview carries it at the next
   * `GET` (`tenantOverviewRowSchema.aiMonthlyCallLimit`).
   *
   * 404 for an unknown **and** for a deleted organisation, like every
   * other route of this controller except `restore`.
   */
  @Put(':tenantId/ai-quota')
  @HttpCode(HttpStatus.NO_CONTENT)
  setAiQuota(
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
    @CurrentAuth() auth: AuthContext,
  ): Promise<void> {
    return this.admin.setAiQuota(
      tenantId,
      parseRequest(aiQuotaWriteSchema, body),
      auth.user.id,
    );
  }
}
