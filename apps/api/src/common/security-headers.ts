import type { HeaderResponse } from './http-transport';

/**
 * **The two headers every API response carries** (a review finding, 2026-08-12).
 *
 * ## `X-Content-Type-Options: nosniff`
 *
 * Without it a browser is allowed to *guess* the content type. This API answers
 * with JSON, and a JSON body that an old browser reads as HTML is exactly the
 * path along which an answer value turns into markup — answer values come in
 * here from outside and without an account (`apps/api/src/public/**`).
 *
 * ## `Content-Security-Policy: frame-ancestors 'none'`
 *
 * **Only this one directive**, and that is deliberate: the API serves no pages,
 * so `default-src` would have nothing to govern here. What it *must* govern is
 * that nobody hangs a response of this API into a foreign frame — the basis of
 * every clickjacking. The complete policy for the **page** lives where the page
 * is served (`apps/web/index.html` and
 * `apps/web/docker/default.conf.template`), for the same reason that
 * `Referrer-Policy` appears in three places: API, built page and development
 * are served independently of one another.
 *
 * ⚠️ **`Strict-Transport-Security` expressly does *not* belong here.** It is a
 * promise about the transport and may only come from the place that terminates
 * TLS — the front door. Set from the application it would be either ineffective
 * or harmful in every local `http://` installation: a browser that has seen the
 * header once locks itself out. It is therefore part of the go-live (issue
 * #22), not of this module.
 */
export const CONTENT_TYPE_OPTIONS = 'nosniff';

/** Nobody frames the API — that is all it governs, see above. */
export const API_CONTENT_SECURITY_POLICY = "frame-ancestors 'none'";

export function securityHeaders(
  _request: unknown,
  response: HeaderResponse,
  next: () => void,
): void {
  response.setHeader('X-Content-Type-Options', CONTENT_TYPE_OPTIONS);
  response.setHeader('Content-Security-Policy', API_CONTENT_SECURITY_POLICY);
  next();
}
