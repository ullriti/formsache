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
  notificationCreateSchema,
  notificationUpdateSchema,
  type Notification,
  type NotificationListResponse,
} from '@formsache/shared';

import { SessionGuard } from '../auth/session.guard';
import { parseRequest } from '../common/parse-request';
import { CurrentTenantScope } from '../tenancy/current-tenant-scope.decorator';
import { FormIdInParam } from '../tenancy/form-id-source.decorator';
import { FormRestrictionGuard } from '../tenancy/form-permission.guard';
import { GroupPermissionGuard } from '../tenancy/group-permission.guard';
import { RequirePermission } from '../tenancy/require-permission.decorator';
import type { TenantScope } from '../tenancy/tenant-scope';
import { TenantScopeGuard } from '../tenancy/tenant-scope.guard';
import { NotificationsService } from './notifications.service';

/**
 * Notifications of one form.
 *
 * The full guard chain, declared at the controller so a route added later
 * inherits it: *tenant scope → group permissions → form restriction*
 * (`CONTRIBUTING.md`); the third link arrives later. Authorisation lives here
 * and in the guard, never as an `if` inside the service.
 *
 * **`can_manage_form_settings`, and one flag is enough — that is a decision,
 * not an omission.** A notification is form configuration: it sits beside *Nach
 * dem Absenden → Bestätigung an Teilnehmer senden*, which is the switch that
 * decides whether it goes out at all, and it is edited by
 * whoever configures the form. What it contains is a *template* — placeholders
 * naming questions, never an answer to one.
 *
 * **Per form, not organisation-wide** (ADR-0021): the permission here used to
 * be called `can_manage_settings` and thereby unlocked the same door as the
 * organisation-wide Formular-Standards, the Erscheinungsbild and SSO. Whoever
 * writes the notifications of *their* form needs none of that.
 *
 * The contrast with the mail log is the whole reason
 * this is worth writing down: **that** surface requires
 * `can_view_responses` **and** `can_manage_form_settings` together, because it
 * shows the addresses real participants typed into a public form — resolved
 * placeholders, that is, answers. Reading a template grants no such thing, so
 * asking for the answer right here would be a right demanded for data this
 * route does not carry, and rights that are asked for without reason are the
 * ones that get handed out.
 *
 * Two different numbers, as everywhere on a form surface: a member of *this*
 * Organisation without the right gets **403** — advice they can act on — while a member
 * of another organisation gets **404**, byte-identical to an unknown id, because 403
 * would confirm that the id exists somewhere on the platform.
 *
 * No `@Throttle` and no `ThrottlerModule`: these are session-guarded admin
 * routes, exactly like the settings ones. There is precisely **one**
 * `ThrottlerModule.forRoot` in this application, and a second one would
 * replace it silently.
 */
@Controller('forms/:formId/notifications')
// The fourth link: a person locked out of this form reaches its
// notifications no more than its answers. The form id stands under `:formId`,
// and since a review the guard is **told** so rather than guessing —
// see `form-id-source.decorator.ts`.
@UseGuards(
  SessionGuard,
  TenantScopeGuard,
  GroupPermissionGuard,
  FormRestrictionGuard,
)
@FormIdInParam('formId')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @RequirePermission('canManageFormSettings')
  list(
    @CurrentTenantScope() scope: TenantScope,
    @Param('formId') formId: string,
  ): Promise<NotificationListResponse> {
    return this.notifications.listOfForm(scope, formId);
  }

  /**
   * `notificationCreateSchema` accepts only the `submit` trigger, so „Bei
   * Zwischenspeichern" is refused **here**, by the server, with a 400 naming
   * the field — absent, not disabled.
   */
  @Post()
  @RequirePermission('canManageFormSettings')
  create(
    @CurrentTenantScope() scope: TenantScope,
    @Param('formId') formId: string,
    @Body() body: unknown,
  ): Promise<Notification> {
    return this.notifications.create(
      scope,
      formId,
      parseRequest(notificationCreateSchema, body),
    );
  }

  /** `PUT`: the notification is replaced as a whole, not patched field by field. */
  @Put(':notificationId')
  @RequirePermission('canManageFormSettings')
  replace(
    @CurrentTenantScope() scope: TenantScope,
    @Param('formId') formId: string,
    @Param('notificationId') notificationId: string,
    @Body() body: unknown,
  ): Promise<Notification> {
    return this.notifications.replace(
      scope,
      formId,
      notificationId,
      parseRequest(notificationUpdateSchema, body),
    );
  }

  @Delete(':notificationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('canManageFormSettings')
  remove(
    @CurrentTenantScope() scope: TenantScope,
    @Param('formId') formId: string,
    @Param('notificationId') notificationId: string,
  ): Promise<void> {
    return this.notifications.remove(scope, formId, notificationId);
  }
}
