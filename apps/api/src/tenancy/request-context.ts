import type { AuthenticatedRequest } from '../auth/request-context';
import type { FormRestriction } from './form-restriction';
import type { TenantScope } from './tenant-scope';

/**
 * A request after `TenantScopeGuard` ran.
 *
 * Declared here and not next to `AuthenticatedRequest`, so the dependency runs
 * one way only: tenancy knows about authentication, authentication knows
 * nothing about tenancy. The auth module has to stay usable — and reviewable —
 * without the tenant scope, because `POST /api/auth/login` and
 * `PUT /api/session/tenant` are exactly the routes that exist *before* a scope
 * does.
 *
 * `tenantScope` is optional for the same reason `auth` is: the type also
 * describes the request before the guard, the guard is the only writer, and a
 * handler reads it through `@CurrentTenantScope()`, which fails closed.
 */
export interface TenantScopedRequest extends AuthenticatedRequest {
  tenantScope?: TenantScope;
  /**
   * What `FormRestrictionGuard` decided about this person's per-form rights
   *  — optional, and read through `@CurrentFormRestriction()`,
   * for the same reasons `tenantScope` is.
   *
   * The route parameters **and the query** are read here as well, because the
   * fourth link needs the form a request is about and Nest hands guards the raw
   * request. Which of the two carries it is declared per route
   * (`form-id-source.decorator.ts`), never guessed. Declared structurally
   * rather than by importing Express, in the style `auth/request-context.ts`
   * sets: this file's contact surface with the HTTP adapter stays two lines
   * long and therefore visible.
   *
   * `query` values are `unknown` and not `string`: a repeated parameter
   * (`?formId=a&formId=b`) arrives as an array, and typing that away would be a
   * lie the guard would then act on.
   */
  formRestriction?: FormRestriction;
  readonly params?: Readonly<Record<string, string | undefined>>;
  readonly query?: Readonly<Record<string, unknown>>;
}
