import {
  Body,
  Controller,
  NotFoundException,
  Put,
  UseGuards,
} from '@nestjs/common';
import { switchTenantRequestSchema, type SessionUser } from '@formsache/shared';

import { CurrentAuth } from '../auth/current-auth.decorator';
import type { AuthContext } from '../auth/request-context';
import { SessionGuard } from '../auth/session.guard';
import {
  TENANT_NOT_FOUND_MESSAGE,
  TenantSwitchService,
} from './tenant-switch.service';

/**
 * The tenant switcher (the requirement).
 *
 * Behind `SessionGuard` **only**, deliberately without `TenantScopeGuard`:
 * this is the route that establishes a scope, so requiring one would lock out
 * exactly the people who need it — someone with two memberships starts with no
 * active tenant at all (`AuthService.deriveActiveTenant`).
 */
@Controller('session')
@UseGuards(SessionGuard)
export class SessionTenantController {
  constructor(private readonly switcher: TenantSwitchService) {}

  /**
   * `PUT`, not `POST`: the request states what the active tenant *is*, and
   * sending it twice leaves the same state behind.
   *
   * A malformed body answers 404 with the same wording an unknown tenant gets.
   * 400 would be the tidier status, but it would also split the answers into
   * "that is not a tenant id" and "that tenant is not yours" — and the second
   * of those is the enumeration oracle this endpoint exists to avoid.
   */
  @Put('tenant')
  switchTenant(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<SessionUser> {
    const parsed = switchTenantRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new NotFoundException(TENANT_NOT_FOUND_MESSAGE);
    }
    return this.switcher.switchTo(auth, parsed.data.tenantId);
  }
}
