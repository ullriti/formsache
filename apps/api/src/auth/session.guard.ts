import {
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { ApiEnv } from '@formsache/shared';

import { API_ENV } from '../config/env';

import type { AuthenticatedRequest } from './request-context';
import { readSessionToken, usesSecureCookies } from './session-cookie';
import { SessionService } from './session.service';

/**
 * Answer to every unauthenticated request. One message for "no cookie",
 * "unknown token", "revoked" and "expired" alike — the client learns that it
 * has to log in, and nothing else.
 */
export const NOT_AUTHENTICATED_MESSAGE = 'Nicht angemeldet.';

/**
 * First link of the guard chain: is there a valid session?
 *
 * A guard, not a piece of controller code, because this is where the chain
 * `Tenant-Scope → Gruppenrechte → Formular-Restriktion` starts.
 * `TenantScopeGuard` runs after it and reads what this one attaches; keeping
 * the two apart means the tenant scope can never be derived from an
 * unauthenticated request.
 *
 * It refuses rather than degrades. A guard that let the request through with
 * an empty user would turn every downstream `where: { tenantId }` into a query
 * over `undefined` — 200 with empty data instead of 401, which is exactly what
 * this guard exists to prevent.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionService,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    // The cookie *name* is part of the security boundary, not a detail: behind
    // TLS only the `__Host-` one is accepted, so a cookie tossed in by a
    // subdomain under the bare name never reaches `authenticate`. The same
    // function decides which name the login *writes*, so reader and writer
    // cannot drift apart.
    const token = readSessionToken(
      request.headers.cookie,
      usesSecureCookies(this.env),
    );
    if (token === undefined) {
      throw new UnauthorizedException(NOT_AUTHENTICATED_MESSAGE);
    }

    // `authenticate` collapses "unknown", "revoked" and "expired" into null,
    // so no branch here can accidentally accept one of them.
    const auth = await this.sessions.authenticate(token);
    if (auth === null) {
      throw new UnauthorizedException(NOT_AUTHENTICATED_MESSAGE);
    }

    request.auth = auth;
    return true;
  }
}
