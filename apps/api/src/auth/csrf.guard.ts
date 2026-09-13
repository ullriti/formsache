import {
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ApiEnv } from '@formsache/shared';

import { API_ENV } from '../config/env';
import { CSRF_HEADER_NAME, csrfTokenMatches, deriveCsrfToken } from './csrf';
import type { CookieRequest } from './request-context';
import { readSessionToken, usesSecureCookies } from './session-cookie';

export const CSRF_FAILED_MESSAGE = 'Anfrage konnte nicht verifiziert werden.';

export const CSRF_EXEMPT = 'formsache:csrf-exempt';

/**
 * Marks a route as unreachable for CSRF *by construction*, not as one that may
 * skip the check.
 *
 * There are exactly two legitimate reasons, and both are about the absence of
 * a session to ride on:
 *
 * - **The login.** There is no session yet, so there is nothing to forge with.
 *   It is protected instead by accepting `application/json` only, which is
 *   what puts it out of reach of a cross-site form (`app-setup.ts`).
 * - **The public fill-in endpoints.** They authenticate nobody. A
 *   forged submission from another site is a submission the participant could
 *   equally have made by visiting the form — there is no privilege to abuse.
 *
 * Every use of this decorator is an assertion that one of those holds, and the
 * route-coverage test names them explicitly rather than counting them.
 */
export const CsrfExempt = () => SetMetadata(CSRF_EXEMPT, true);

/**
 * The transport surface this guard touches — the method and one header, in the
 * structural style the auth module uses throughout (`request-context.ts`): no
 * Express types, so the seam stays visible.
 *
 * The header key is a **mapped type over the constant**, not a second spelling
 * of `'x-csrf-token'`. A literal here would be a copy that compiles happily
 * after the constant is renamed, and the guard would then read a header nobody
 * sends — failing closed, but for a reason no test would explain.
 */
type CsrfHeaders = CookieRequest['headers'] &
  Partial<Readonly<Record<typeof CSRF_HEADER_NAME, string | string[]>>>;

interface CsrfRequest extends CookieRequest {
  readonly method?: string;
  readonly headers: CsrfHeaders;
}

/**
 * Rejects state-changing requests that cannot prove they came from our own
 * application.
 *
 * Registered **globally** (`AppModule`), and that is the point: a route added
 * next year is covered because it exists, not because someone remembered a
 * decorator. The exemptions run the other way round — they have to be written
 * down, and writing one down is a visible decision in a diff.
 *
 * Safe methods pass. `GET`, `HEAD` and `OPTIONS` are required to be free of
 * side effects (RFC 9110 §9.2.1), and a handler that breaks that rule has a
 * problem this guard is the wrong place to fix.
 *
 * A request without a session also passes: there is nothing to protect, and
 * refusing here would answer 403 where the honest answer is the 401 that
 * `SessionGuard` gives a moment later. Turning "not logged in" into "CSRF
 * failed" would send everyone debugging in the wrong direction.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  private static readonly SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

  constructor(
    private readonly reflector: Reflector,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') {
      return true;
    }

    const request = context.switchToHttp().getRequest<CsrfRequest>();
    const method = (request.method ?? 'GET').toUpperCase();
    if (CsrfGuard.SAFE_METHODS.has(method)) {
      return true;
    }

    const exempt = this.reflector.getAllAndOverride<boolean | undefined>(
      CSRF_EXEMPT,
      [context.getHandler(), context.getClass()],
    );
    if (exempt === true) {
      return true;
    }

    const sessionToken = readSessionToken(
      request.headers.cookie,
      usesSecureCookies(this.env),
    );
    if (sessionToken === undefined) {
      // No session to ride on — see the class comment. `SessionGuard` answers.
      return true;
    }

    const presented = request.headers[CSRF_HEADER_NAME];
    if (typeof presented !== 'string') {
      throw new ForbiddenException(CSRF_FAILED_MESSAGE);
    }

    // The expected value is derived from the session cookie of *this* request,
    // never read from the CSRF cookie. Comparing the two cookies against each
    // other would be plain double submit, which cookie tossing defeats.
    if (!csrfTokenMatches(presented, deriveCsrfToken(sessionToken))) {
      throw new ForbiddenException(CSRF_FAILED_MESSAGE);
    }

    return true;
  }
}
