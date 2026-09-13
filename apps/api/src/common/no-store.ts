import type { HeaderResponse } from './http-transport';

/**
 * The one freshness statement every answer of this API needs.
 *
 * `no-store` rather than `no-cache`: the latter still allows a cache to keep
 * the answer and merely revalidate it. Nothing here may be kept at all.
 */
export const NO_STORE = 'no-store';

/**
 * Marks every answer of the API as uncacheable.
 *
 * The reasoning starts with the authentication routes but does not stop there.
 * `GET /api/auth/me` reports one person's e-mail, name, organisation memberships and
 * permission flags, and Express attaches an `ETag` to it — and `GET /api/groups`
 * is the same kind of answer one route over: 200, an `ETag`, tenant-bound rows,
 * authenticated by a cookie. Without an explicit freshness statement a shared
 * cache may store such an answer heuristically (RFC 9111 §4.2.2), and RFC 9111
 * §3.5 does **not** cover us: it forbids a shared cache to reuse a response only
 * when the *request* carried an `Authorization` header. Cookie authentication is
 * not that. The reverse proxy is already on the roadmap, and a cache
 * hit across two organisations would hand Organisation B the group list of Organisation A without any
 * request ever reaching a guard — the requirement defeated outside the application,
 * with the isolation tests still green.
 *
 * **Registered first of all, in `configureApp`** — before the body parser, and
 * as a plain handler rather than as a Nest middleware bound to a route. Both
 * halves of that were bought with a measurement:
 *
 * - Per controller it covered `AuthController` alone, so `GET /api/groups` and
 *   `PUT /api/session/tenant` went out with an `ETag` and no freshness
 *   statement at all. That was the finding.
 * - Registering it globally through `AppModule` fixed those but not the
 *   answers the *parser* produces. A body-parser failure calls `next(err)`, and
 *   Express then skips every ordinary middleware behind it — measured against
 *   the installed express@5: `413` for an oversized body and `400` for broken
 *   JSON both came back with `cache-control = null`. Those are the two answers
 *   an unauthenticated caller reaches most easily. Nest also scopes module
 *   middleware to the global prefix, so a 404 outside `/api` was uncovered too.
 *
 * Sitting in front of the parser, this handler runs before anything can fail,
 * and the header it sets survives into whatever the exception layer answers.
 *
 * `GET /api/health` is included rather than carved out. It is the one route
 * whose answer is not tenant-bound and would be harmless to cache — but its
 * body carries the running `APP_VERSION`, and a cached copy of that makes a
 * finished deployment look unfinished; it is answered from memory, so caching
 * buys nothing measurable; and an exception list is precisely the place where
 * the *next* route gets added by mistake. A blanket rule that is occasionally
 * too strict beats a list that is occasionally too loose.
 */
export function noStore(
  _request: unknown,
  response: HeaderResponse,
  next: () => void,
): void {
  response.setHeader('Cache-Control', NO_STORE);
  next();
}

/**
 * **No `Referer` leaves this application** (a review finding).
 *
 * Two of this application's addresses carry their authorisation **in the path**
 * — the Bearbeiten-Link and the Entwurfs-Adresse — and that
 * is a deliberate trade (`public-drafts.controller.ts` argues it: the address is
 * copied by hand, so it holds one identifier and nothing else). What the trade
 * assumes is that the path stays between the participant and this server. A
 * `Referer` header breaks that assumption without anybody doing anything wrong:
 * one external image, one link a participant follows out of the confirmation
 * page, and somebody else's log holds a working capability.
 *
 * *Measured on 2026-08-05:* `grep` over `apps/api/src`, `apps/web` and
 * `apps/web/docker/default.conf.template` found **not a single** hit for
 * `Referrer-Policy` — the gap was not new, it hit the Bearbeiten-Link just the
 * same from the very beginning.
 *
 * `no-referrer` rather than `strict-origin-when-cross-origin` (the modern
 * browser default): the default still sends the **origin** cross-site, and while
 * that leaks no token it announces every installation that an organisation reaches out
 * from. Nothing in this application needs a `Referer` — there is no analytics,
 * no OAuth handoff that reads one, and the CSRF protection is a token
 * (`csrf.guard.ts`), never the header.
 *
 * **It is set here for the API and, independently, for the pages** — the SPA's
 * own document carries `<meta name="referrer">` and the container's front door
 * sends the header (`apps/web/index.html`,
 * `apps/web/docker/default.conf.template`). Three places rather than one
 * because they cover three different things that can be served without the
 * others: the API behind any proxy, the built page behind any web server, and
 * the page in development. `referrer-policy.test.ts` in `@formsache/shared` holds the
 * two static ones to it.
 */
export const REFERRER_POLICY = 'no-referrer';

export function referrerPolicy(
  _request: unknown,
  response: HeaderResponse,
  next: () => void,
): void {
  response.setHeader('Referrer-Policy', REFERRER_POLICY);
  next();
}
