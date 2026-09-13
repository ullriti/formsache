import {
  UnauthorizedException,
  createParamDecorator,
  type ExecutionContext,
} from '@nestjs/common';

import type { AuthContext, AuthenticatedRequest } from './request-context';
import { NOT_AUTHENTICATED_MESSAGE } from './session.guard';

/**
 * Hands a handler the session `SessionGuard` established.
 *
 * The typed alternative to reaching into `request.auth` in every controller —
 * which would spread `undefined` checks across the code and tempt someone into
 * a non-null assertion.
 */
export const CurrentAuth = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthContext => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const auth = request.auth;
    if (auth === undefined) {
      // Only reachable when the decorator is used on a route that forgot
      // `@UseGuards(SessionGuard)`. That is a wiring mistake, and the answer
      // to it is the closed one: refuse, rather than hand the handler an
      // `undefined` that TypeScript was told is an `AuthContext`.
      throw new UnauthorizedException(NOT_AUTHENTICATED_MESSAGE);
    }
    return auth;
  },
);
