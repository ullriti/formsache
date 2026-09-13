import { Controller, Delete, Get, UseGuards } from '@nestjs/common';
import type { TrashPurgeResult, TrashView } from '@formsache/shared';

import { SessionGuard } from '../auth/session.guard';
import {
  RequireAllPermissions,
  RequirePermission,
} from '../tenancy/require-permission.decorator';
import { CurrentTenantScope } from '../tenancy/current-tenant-scope.decorator';
import { NoFormIdInRequest } from '../tenancy/form-id-source.decorator';
import { FormRestrictionGuard } from '../tenancy/form-permission.guard';
import {
  CurrentFormRestriction,
  type FormRestriction,
} from '../tenancy/form-restriction';
import { GroupPermissionGuard } from '../tenancy/group-permission.guard';
import type { TenantScope } from '../tenancy/tenant-scope';
import { TenantScopeGuard } from '../tenancy/tenant-scope.guard';
import { TrashService } from './trash.service';

/**
 * The trash of the **active** Organisation — behind the whole
 * guard chain (`CONTRIBUTING.md`): *tenant scope → group permissions →
 * form restriction*.
 *
 * There is no route here that names another organisation's trash, and that is the
 * shape of the design rather than an omission: „der Papierkorb eines fremden
 * Organisation" is not an address this API has. What a caller can try is a *form* or
 * an *answer* of another organisation, on the restore routes of `FormsController`, and
 * those answer 404 through the same door every other form route uses.
 */
@Controller('trash')
@UseGuards(
  SessionGuard,
  TenantScopeGuard,
  GroupPermissionGuard,
  FormRestrictionGuard,
)
export class TrashController {
  constructor(private readonly trash: TrashService) {}

  /**
   * The two sections the trash view renders (handoff).
   *
   * **`canBuild` opens it, and only `canBuild`** — the requirement read as a page
   * rather than as a row. It is the weaker of the two delete rights this
   * feature defines (a form needs `canBuild`, an answer needs `canBuild`
   * **and** `canViewResponses`, see `FormsController`), so it is what „darf
   * hier überhaupt etwas" means. Somebody who may only *see* answers may delete
   * nothing at all and gets the 403 this route is built to give.
   *
   * Requiring **both** here would have been the wrong door for the right
   * reason: it would shut the trash — and with it the only way back for a
   * form they themselves deleted — for every editor without
   * `can_view_responses`.
   *
   * The **contents** are narrowed inside, by the same `FormRestriction` the
   * guard chain decides with: a permission opens the page, a revocation still
   * keeps a form out of it, and a cap keeps that form's answers out.
   */
  @Get()
  @RequirePermission('canBuild')
  @NoFormIdInRequest(
    'the Papierkorb names no single form — the restriction travels as a query ' +
      'fragment into TrashService.view instead ',
  )
  view(
    @CurrentTenantScope() scope: TenantScope,
    @CurrentFormRestriction() restriction: FormRestriction,
  ): Promise<TrashView> {
    return this.trash.view(scope, restriction);
  }

  /**
   * **🗑 Papierkorb leeren** — physically, everything at once (handoff).
   *
   * **Both permissions**, unlike {@link view}: `can_view_responses` **and**
   * `can_build` (a decision, 2026-08-03, out of a security
   * review). Opening the trash is `can_build` alone because an
   * editor has to be able to undo a form they deleted themselves; this
   * button is where reversibility ends. Without the pair, the very editor
   * who gets 403 on *reading* one single Anmeldung (`GET :id/responses`) would
   * destroy forty of them here, physically, with nothing to restore from.
   *
   * `DELETE` on the collection and not `POST /trash/empty`: the resource is the
   * trash, and emptying it is removing its contents. It is idempotent in
   * the sense that matters — a second call on an empty trash answers
   * `{forms: 0, responses: 0, failed: 0}` rather than failing.
   *
   * **A body and not 204**, because the caller cannot know what it removed: the
   * page listed a state, the server walked the current one. See
   * `trashPurgeResultSchema` for why `failed` is its own number.
   */
  @Delete()
  @RequireAllPermissions('canViewResponses', 'canBuild')
  @NoFormIdInRequest(
    'emptying the Papierkorb names no single form — the restriction travels ' +
      'as a query fragment into the two listings, exactly as it does for the view',
  )
  empty(
    @CurrentTenantScope() scope: TenantScope,
    @CurrentFormRestriction() restriction: FormRestriction,
  ): Promise<TrashPurgeResult> {
    return this.trash.emptyTrash(scope, restriction);
  }
}
