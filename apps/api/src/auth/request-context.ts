import type { SessionUser } from '@formsache/shared';

import type { HeaderResponse } from '../common/http-transport';

/**
 * The transport shapes the auth module touches — deliberately minimal.
 *
 * Nest hands the guard and the controllers the underlying Express objects, but
 * nothing here needs Express: reading one header and setting one header is the
 * entire contact surface. Structural interfaces keep `@types/express` out of
 * the dependency list and, more usefully, make the seam obvious — anything
 * beyond these two members would be a new dependency on the HTTP adapter.
 */

export interface CookieRequest {
  readonly headers: { readonly cookie?: string | undefined };
}

/**
 * The response side is not specific to cookies at all — it is "something one
 * header can be put on", which `src/common/http-transport.ts` already names.
 * Kept as an alias rather than a second declaration of the same shape: three
 * structurally identical interfaces (this one, the middleware's, the
 * controller's multi-value variant) is how they later stop being identical.
 */
export type CookieResponse = HeaderResponse;

/**
 * What a valid session puts on the request.
 *
 * Kept small on purpose: `TenantScopeGuard` (next wave) reads exactly this to
 * derive the tenant scope, and every field added here becomes something that
 * guard has to trust. `user.memberships` is the authoritative list of tenants
 * the request may touch; `user.activeTenantId` says which one it is scoped to
 * and is only meaningful together with a membership check.
 */
export interface AuthContext {
  readonly sessionId: string;
  readonly user: SessionUser;
}

/**
 * A request after `SessionGuard` ran. `auth` is optional because the type also
 * describes the request *before* the guard — the guard is the only writer, and
 * a handler that reads it goes through `@CurrentAuth()`, which fails closed
 * when the guard was not applied.
 */
export interface AuthenticatedRequest extends CookieRequest {
  auth?: AuthContext;
}
