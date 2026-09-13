import {
  ForbiddenException,
  createParamDecorator,
  type ExecutionContext,
} from '@nestjs/common';

import type { TenantScopedRequest } from './request-context';
import { NO_TENANT_SCOPE_MESSAGE } from './tenant-scope.guard';
import type { TenantScope } from './tenant-scope';

/**
 * Hands a handler the scope `TenantScopeGuard` established.
 *
 * The counterpart to `@CurrentAuth()`, and the only supported way into a
 * tenant-bound query: a handler that wants data has to name this parameter,
 * and naming it is what makes the missing guard visible — as a 403 on the
 * first call, not as a query without a `where`.
 */
export const CurrentTenantScope = createParamDecorator(
  (_data: unknown, context: ExecutionContext): TenantScope => {
    const request = context.switchToHttp().getRequest<TenantScopedRequest>();
    const scope = request.tenantScope;
    if (scope === undefined) {
      // The route forgot `@UseGuards(SessionGuard, TenantScopeGuard)`. Refuse,
      // rather than hand the handler an `undefined` TypeScript was told is a
      // `TenantScope` — that value would reach Prisma as `tenantId: undefined`,
      // which PostgreSQL reads as "no condition at all".
      throw new ForbiddenException(NO_TENANT_SCOPE_MESSAGE);
    }
    return scope;
  },
);
