import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { formMemberWriteSchema, type FormMemberList } from '@formsache/shared';

import { CurrentAuth } from '../auth/current-auth.decorator';
import type { AuthContext } from '../auth/request-context';
import { SessionGuard } from '../auth/session.guard';
import { parseRequest as parse } from '../common/parse-request';
import { CurrentTenantScope } from './current-tenant-scope.decorator';
import { FormIdInParam } from './form-id-source.decorator';
import { FormRestrictionGuard } from './form-permission.guard';
import {
  FORM_MEMBERS_PERMISSIONS,
  FormPermissionService,
} from './form-permission.service';
import { GroupPermissionGuard } from './group-permission.guard';
import { RequireAnyPermission } from './require-permission.decorator';
import type { TenantScope } from './tenant-scope';
import { TenantScopeGuard } from './tenant-scope.guard';

/**
 * *Nutzerrechte je Formular* — the editor behind
 * the **whole** chain, including the link it configures.
 *
 * That last part is deliberate: `FormRestrictionGuard` runs on these routes too,
 * so somebody whose own access to this form was revoked cannot open its rights
 * page — and gets the same 404 the form itself gives them. A management surface
 * exempt from the rule it manages is the shape in which a revocation becomes
 * undoable by the person it was aimed at.
 *
 * **Either of two permissions opens the page** ({@link
 * FORM_MEMBERS_PERMISSIONS}): `canManageUsers`, the permission of the
 * Tenant-Nutzerverwaltung — this page *is* that list, narrowed to one form —
 * **or** `canManageFormSettings`, the permission to configure a form
 * (ADR-0021). Whoever configures a form also decides who works on it; and
 * „any" instead of „all", so that an existing group with `canManageUsers`
 * does not lose the page it has today.
 *
 * That this is no upward extension of rights is not an assurance of this
 * file but its construction: `formMemberWriteSchema` has no field that grants
 * anything, `FormPermissionService.save` requires a cap group *below* the role
 * of the person concerned, and `capPermissions` forms an intersection. A
 * stored row can therefore only take away — even when it came into being past
 * every route.
 *
 * Mounted under `forms/:formId/…` rather than in a namespace of its own,
 * because the resource *is* a property of the form — and because the guard
 * finds the form id in the route without a second spelling.
 */
@Controller('forms/:formId/members')
@UseGuards(
  SessionGuard,
  TenantScopeGuard,
  GroupPermissionGuard,
  FormRestrictionGuard,
)
// `:userId` is the *other* id on these routes, which is precisely why the form
// parameter is named rather than guessed (review finding).
@FormIdInParam('formId')
export class FormPermissionController {
  constructor(private readonly members: FormPermissionService) {}

  @Get()
  @RequireAnyPermission(...FORM_MEMBERS_PERMISSIONS)
  list(
    @CurrentTenantScope() scope: TenantScope,
    @Param('formId') formId: string,
  ): Promise<FormMemberList> {
    return this.members.list(scope, formId);
  }

  /**
   * `PUT`, and one document per person: „keine Einschränkung" is
   * `{ accessRevoked: false, cappedGroupId: null }`, not a second route. The
   * state is the row's whole content, so a partial write would be a way to
   * change one half while believing the other unchanged.
   *
   * CSRF is covered by the global `CsrfGuard` — every mutating admin route is,
   * and a route that had to remember it would be a route that can forget it.
   *
   * The **acting** person travels in from the session and never from the body:
   * „darf ich mich selbst aussperren?" (review finding) is a question
   * about who is making the request, and a field on the wire saying who that is
   * would be a field a client could set.
   */
  @Put(':userId')
  @RequireAnyPermission(...FORM_MEMBERS_PERMISSIONS)
  save(
    @CurrentTenantScope() scope: TenantScope,
    @CurrentAuth() auth: AuthContext,
    @Param('formId') formId: string,
    @Param('userId') userId: string,
    @Body() body: unknown,
  ): Promise<FormMemberList> {
    return this.members.save(
      scope,
      formId,
      userId,
      parse(formMemberWriteSchema, body),
      auth.user.id,
    );
  }
}
