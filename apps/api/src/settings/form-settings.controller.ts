import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';

import { SessionGuard } from '../auth/session.guard';
import { parseRequest } from '../common/parse-request';
import { CurrentTenantScope } from '../tenancy/current-tenant-scope.decorator';
import { FormIdInParam } from '../tenancy/form-id-source.decorator';
import { FormRestrictionGuard } from '../tenancy/form-permission.guard';
import {
  CurrentFormRestriction,
  type FormRestriction,
} from '../tenancy/form-restriction';
import { GroupPermissionGuard } from '../tenancy/group-permission.guard';
import { RequirePermission } from '../tenancy/require-permission.decorator';
import type { TenantScope } from '../tenancy/tenant-scope';
import { TenantScopeGuard } from '../tenancy/tenant-scope.guard';
import {
  FormSettingsService,
  type SettingsCaller,
} from './form-settings.service';
import {
  updateFormSettingsRequestSchema,
  type FormSettingsResponse,
} from './settings-wire';

/**
 * The settings of one form.
 *
 * The full guard chain, declared at the controller so a route added later
 * inherits it: *tenant scope → group permissions → form restriction*
 * (`CONTRIBUTING.md`). The last link arrived later and is here for the same
 * reason it is on the responses: a person locked out of *this* form has no
 * business reading its access word either, and "the criteria name only
 * responses and export" would be the argument that left the export open.
 *
 * **`can_manage_form_settings` guards reading as well as writing** , and the
 * reading half is the one worth stating: the document carries the access word
 * in clear for whoever may configure it, so "read only" is not the harmless
 * half of this surface. It is the half that hands out a password.
 *
 * **The permission per form, not that of the organisation** (ADR-0021). Until then
 * `can_manage_settings` stood here — the same permission that unlocks the
 * *organisation-wide* form standards, the appearance, the
 * sending identity and SSO. "Whoever builds a form also configures
 * it" would, via that permission, have unlocked the standards of all forms of the
 * organisation along with it, and that is why it has become a second, narrower one. The
 * standard group `editor` holds exactly this one and not that one.
 *
 * The two answers are deliberately different numbers. A member of *this* Organisation
 * without the right gets **403** — they may know the form exists, they are
 * looking at their own Organisation, and "your role is too narrow" is the only answer
 * they can act on. A member of another organisation gets **404**, byte-identical to an
 * unknown id, because 403 there would confirm that the id exists somewhere on
 * the platform.
 */
@Controller('forms/:id/settings')
@UseGuards(
  SessionGuard,
  TenantScopeGuard,
  GroupPermissionGuard,
  FormRestrictionGuard,
)
// The form stands under `:id` — named, not guessed (review finding).
@FormIdInParam('id')
export class FormSettingsController {
  constructor(private readonly settings: FormSettingsService) {}

  @Get()
  @RequirePermission('canManageFormSettings')
  read(
    @CurrentTenantScope() scope: TenantScope,
    @Param('id') id: string,
    @CurrentFormRestriction() restriction: FormRestriction,
  ): Promise<FormSettingsResponse> {
    return this.settings.ofForm(scope, id, callerOf(restriction));
  }

  /**
   * `PUT`, not `PATCH`: the four section switches are replaced as a set, which
   * is what makes „zurück auf Tenant-Standard" expressible. The reasoning and
   * the exception for `values` sit at `updateFormSettingsRequestSchema`.
   */
  @Put()
  @RequirePermission('canManageFormSettings')
  replace(
    @CurrentTenantScope() scope: TenantScope,
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentFormRestriction() restriction: FormRestriction,
  ): Promise<FormSettingsResponse> {
    return this.settings.replaceOfForm(
      scope,
      id,
      parseRequest(updateFormSettingsRequestSchema, body),
      callerOf(restriction),
    );
  }
}

/**
 * What the service learns about the caller — **one** permission, from the
 * membership.
 *
 * `heldPermissions` and not the ones capped to this form: what is asked for
 * is `can_manage_settings`, the *organisation-wide* permission under which
 * `GET /api/tenant/form-defaults` hands out the same document in clear. On
 * this route no form is in play on which a cap could take
 * hold, so the capped version would be an answer to a different
 * question here. The reasoning at length stands at `SettingsCaller`.
 */
function callerOf(restriction: FormRestriction): SettingsCaller {
  return {
    canManageSettings: restriction.heldPermissions.canManageSettings,
  };
}
