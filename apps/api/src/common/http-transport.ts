/**
 * The transport shapes that are not any one domain's business.
 *
 * Structural interfaces rather than `@types/express`: nothing outside the HTTP
 * adapter needs Express, and naming the members that are actually touched makes
 * the seam visible — anything beyond them would be a new dependency on the
 * adapter. `auth/request-context.ts` states the same reasoning for the request
 * side and derives its `CookieResponse` from the type below, so there is one
 * definition rather than three near-identical ones.
 */

/** A response, seen by everything whose whole job is to set one header. */
export interface HeaderResponse {
  setHeader: (name: string, value: string) => unknown;
}
