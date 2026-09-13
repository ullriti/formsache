import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import {
  mailIdentityWriteSchema,
  type MailIdentityConfig,
} from '@formsache/shared';

import { SessionGuard } from '../auth/session.guard';
import { parseRequest } from '../common/parse-request';
import { CurrentTenantScope } from '../tenancy/current-tenant-scope.decorator';
import { GroupPermissionGuard } from '../tenancy/group-permission.guard';
import { RequireAllPermissions } from '../tenancy/require-permission.decorator';
import type { TenantScope } from '../tenancy/tenant-scope';
import { TenantScopeGuard } from '../tenancy/tenant-scope.guard';
import { SmtpConfigService } from './smtp-config.service';

/**
 * The organisation's own mail server — the *Mailversand*-Reiter (the requirements).
 *
 * **There is no organisation in the path, and that is the security design, not a
 * shortcut.** Exactly the statement `OidcConfigController` makes: the block
 * addressed here is always the one of the session's *active* tenant, resolved
 * by `TenantScopeGuard` from a membership the caller actually holds. A request
 * has no way to *name* another organisation, so „der Mailserver einer fremden Organisation
 * ist weder les- noch schreibbar" needs no refusal — there is nothing to refuse.
 *
 * **No superadmin guard.** This block belongs to the organisation, not to the
 * installation: Konzept no. 38 grants an organisation its own mail server, and a route only a
 * superadmin could reach would make that grant depend on somebody else's
 * availability. The installation's *own* block is the other route
 * (`system-settings`) and that one is superadmin-only — two blocks,
 * two owners, and the difference is the whole of ADR-0013.
 *
 * **Both permissions, and the second one is the deliberate part.** Whoever names
 * the mail server names **the machine every notification of this organisation travels
 * through** — bodies included, and those carry answers. That is a statement
 * about who may read submissions, not about how a form looks; leaving it at
 * `can_manage_settings` alone would give a group that may set up the
 * organisation a way to read every response by routing the mail past itself. It
 * is the same shape the project already answered this way twice: the export
 * needs `can_export` **and** `can_view_responses`, and the mail log
 * needs `can_manage_form_settings` **and** `can_view_responses` — which is the closer of
 * the two analogies, because the log shows recipient and subject while this
 * route decides who receives the whole mail.
 *
 * A caller who may see the settings but not this block gets a 403 here, and the
 * tab shows the card **absent** rather than disabled.
 *
 * No `@Throttle`: there is exactly one `ThrottlerModule.forRoot` in this
 * application and these routes sit behind a session, whose entrance already
 * carries the strict limit (`common/rate-limit.module.ts`).
 */
@Controller('tenant/smtp')
@UseGuards(SessionGuard, TenantScopeGuard, GroupPermissionGuard)
export class SmtpConfigController {
  constructor(private readonly smtp: SmtpConfigService) {}

  @Get()
  @RequireAllPermissions('canManageSettings', 'canViewResponses')
  read(@CurrentTenantScope() scope: TenantScope): Promise<MailIdentityConfig> {
    return this.smtp.ofTenant(scope);
  }

  @Put()
  @RequireAllPermissions('canManageSettings', 'canViewResponses')
  replace(
    @CurrentTenantScope() scope: TenantScope,
    @Body() body: unknown,
  ): Promise<MailIdentityConfig> {
    return this.smtp.replaceOfTenant(
      scope,
      parseRequest(mailIdentityWriteSchema, body),
    );
  }
}
