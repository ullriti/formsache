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
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import {
  tenantMemberCreateSchema,
  tenantMemberPasswordSchema,
  tenantMemberUpdateSchema,
  type SessionRevocation,
  type TenantMember,
  type TenantMemberCreated,
  type TenantMemberList,
} from '@formsache/shared';

import { SessionGuard } from '../auth/session.guard';
import { parseRequest } from '../common/parse-request';
import { TEST_MAIL_RATE_LIMIT } from '../mail/test-mail.controller';
import { CurrentTenantScope } from '../tenancy/current-tenant-scope.decorator';
import { GroupPermissionGuard } from '../tenancy/group-permission.guard';
import { RequirePermission } from '../tenancy/require-permission.decorator';
import type { TenantScope } from '../tenancy/tenant-scope';
import { TenantScopeGuard } from '../tenancy/tenant-scope.guard';
import { TenantUsersService } from './users.service';

/**
 * How often **one origin address** may let this installation send an account
 * mail (security finding 2).
 *
 * ## Why the number is needed at all
 *
 * `POST /tenant/users/:id/invitation` and `POST /tenant/users` are the two
 * routes of this tab that send a **real mail over the installation's mail
 * server** — the first one arbitrarily often to the same mailbox, since
 * ADR-0024 the second one on every creation. Both stood there without any
 * limit: there is no global `APP_GUARD` throttler in this application
 * (`common/rate-limit.module.ts` explains why every route names its own
 * number), and `@Throttle` alone does nothing without
 * `@UseGuards(ThrottlerGuard)` beside it. A holder of `can_manage_users` could
 * thereby make the mailbox of a pending member overflow — and the reputation
 * of this installation's sender domain along with it, because the mails go
 * over the **system identity** and not over the mail server of their
 * organisation (ADR-0023).
 *
 * ## Why **the same** number as „Testmail senden"
 *
 * Because it is the same action: a click that lets the installation send a
 * mail. {@link TEST_MAIL_RATE_LIMIT} is therefore imported and not copied — a
 * second number at a second route would be the duplication in which one half
 * is relaxed later and nobody looks at the other (the same reasoning
 * `system-test-mail.controller.ts` gives for its import, and the same one that
 * makes `USER_PASSWORD_MIN` in `tenant-admin.ts` an alias instead of a
 * number).
 *
 * ## What the number is **not**
 *
 * No overall quota: `ThrottlerGuard` counts per handler, so each of the two
 * routes has its own ten per minute. That is intended — a batch of newly
 * created people is not meant to use up the budget a re-send needs — and it is
 * said out loud so that nobody takes the number for „zehn Mails je Minute".
 */
export const INVITATION_MAIL_RATE_LIMIT = TEST_MAIL_RATE_LIMIT;

/**
 * The people of the active Organisation — the *Nutzerrechte (Tenant-Ebene)* tab
 * (handoff).
 *
 * The full guard chain, declared at the controller so a route added later
 * inherits it: *tenant scope → group permissions → form restriction*
 * (`CONTRIBUTING.md`). `can_manage_users` is the one flag every route here
 * checks — it was declared in the model but stayed unevaluated until
 * this package, because there was no surface behind it.
 *
 * No route takes a tenant in its path: the organisation is always the caller's active
 * one, resolved by `TenantScopeGuard` from a membership they actually hold —
 * the same design `TenantSettingsController` already carries for the organisation's
 * form standards.
 */
@Controller('tenant/users')
@UseGuards(SessionGuard, TenantScopeGuard, GroupPermissionGuard)
export class TenantUsersController {
  constructor(private readonly users: TenantUsersService) {}

  @Get()
  @RequirePermission('canManageUsers')
  list(@CurrentTenantScope() scope: TenantScope): Promise<TenantMemberList> {
    return this.users.list(scope);
  }

  /**
   * One member. A member of another organisation answers exactly like an unknown id
   *  — see `MEMBER_NOT_FOUND_MESSAGE`.
   */
  @Get(':userId')
  @RequirePermission('canManageUsers')
  byId(
    @CurrentTenantScope() scope: TenantScope,
    @Param('userId') userId: string,
  ): Promise<TenantMember> {
    return this.users.byId(scope, userId);
  }

  /**
   * Creates a person — and **sends a mail while doing so** (ADR-0024), which
   * is why this route has been limited since security finding 2
   * ({@link INVITATION_MAIL_RATE_LIMIT}).
   *
   * The recipient stands in the request body, the sending hangs on a single
   * call, and the way out is the installation's system identity. That every
   * call also writes a row does not limit it: an address that already has an
   * account is merely linked and can be repeated arbitrarily often.
   */
  @Post()
  @RequirePermission('canManageUsers')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: INVITATION_MAIL_RATE_LIMIT })
  create(
    @CurrentTenantScope() scope: TenantScope,
    @Body() body: unknown,
  ): Promise<TenantMemberCreated> {
    return this.users.create(
      scope,
      parseRequest(tenantMemberCreateSchema, body),
    );
  }

  /**
   * Role, name and address of a member (finding 12).
   *
   * Was once called `updateGroup` and carried only the group. What came in
   * addition are **fields**, not a new route: it is the same `PUT` on the same
   * resource, and which of the three changes is allowed is decided by the
   * service — the address stands under three conditions, the name under none
   * (`users.service.ts`).
   */
  @Put(':userId')
  @RequirePermission('canManageUsers')
  updateMember(
    @CurrentTenantScope() scope: TenantScope,
    @Param('userId') userId: string,
    @Body() body: unknown,
  ): Promise<TenantMember> {
    return this.users.updateMember(
      scope,
      userId,
      parseRequest(tenantMemberUpdateSchema, body),
    );
  }

  /**
   * Sets a member's password (finding 12).
   *
   * `POST` and no resource of its own: nothing is created that would get an
   * address — a password is a column, not a document, and a `PUT` on
   * `…/password` would promise a field one could also **read**.
   *
   * The answer carries the number of ended sessions, like
   * `…/revoke-sessions`: that the setting ends every session is not a side
   * effect but the point — and the number is the confirmation that it took
   * effect.
   */
  @Post(':userId/password')
  @RequirePermission('canManageUsers')
  setPassword(
    @CurrentTenantScope() scope: TenantScope,
    @Param('userId') userId: string,
    @Body() body: unknown,
  ): Promise<SessionRevocation> {
    const { password } = parseRequest(tenantMemberPasswordSchema, body);
    return this.users.setPassword(scope, userId, password);
  }

  /**
   * Sends a member's invitation once more (ADR-0024).
   *
   * `POST` on a sub-resource and **204 without a body**: nothing comes into
   * being that would get an address, and there is nothing to give back — the
   * mail stands in the mail log afterwards, where every other one stands too. A
   * number as with the session revocation would be nothing to count here.
   *
   * No field for a recipient: the address is the **stored** one, and it is read
   * in the same transaction that enqueues the row. A route one could send an
   * address to would be a way to send a power of attorney over somebody else's
   * account into a self-chosen mailbox.
   *
   * **Limited** ({@link INVITATION_MAIL_RATE_LIMIT}, security finding 2): this
   * here is the route that on demand sends the same real mail arbitrarily often
   * to the same foreign mailbox. Without the number „Einladung erneut senden"
   * is a mail bomb with the installation's sender domain in front of it.
   */
  @Post(':userId/invitation')
  @RequirePermission('canManageUsers')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: INVITATION_MAIL_RATE_LIMIT })
  @HttpCode(HttpStatus.NO_CONTENT)
  resendInvitation(
    @CurrentTenantScope() scope: TenantScope,
    @Param('userId') userId: string,
  ): Promise<void> {
    return this.users.resendInvitation(scope, userId);
  }

  /**
   * Ends all sessions of a member (a review finding).
   *
   * `POST` and not `DELETE`: nothing is deleted — the rows are revoked and live
   * on until the clean-up run. And the answer carries a number that a `204`
   * would not have.
   */
  @Post(':userId/revoke-sessions')
  @RequirePermission('canManageUsers')
  revokeSessions(
    @CurrentTenantScope() scope: TenantScope,
    @Param('userId') userId: string,
  ): Promise<SessionRevocation> {
    return this.users.revokeSessions(scope, userId);
  }

  @Delete(':userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('canManageUsers')
  remove(
    @CurrentTenantScope() scope: TenantScope,
    @Param('userId') userId: string,
  ): Promise<void> {
    return this.users.remove(scope, userId);
  }
}
