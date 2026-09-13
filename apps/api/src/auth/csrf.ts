import { createHash, timingSafeEqual } from 'node:crypto';

import { readCookie, serializeCookie, type CookieAttributes } from './cookie';

/**
 * CSRF protection for the mutating routes behind a session (* the open point of ADR-0005).
 *
 * The floor was laid: the API parses `application/json` and nothing
 * else, which makes every route unreachable for a cross-site HTML form, since
 * a form can only ever send urlencoded, multipart or text/plain. That defence
 * has one dependency — no CORS — and it stops covering the moment a route is
 * reachable by a cross-origin `fetch` the server itself allowed. It also says
 * nothing about the cases that do not involve a form at all. Now that the
 * builder brings the first mutating routes behind a session, the token is
 * due.
 *
 * **Signed double submit, derived from the session token.**
 *
 * The token is `SHA-256("formsache-csrf:v1" ‖ sessionToken)`, delivered in a
 * *readable* cookie and echoed by the client in `X-CSRF-Token`. The server
 * recomputes the expected value from the session cookie it just read and
 * compares.
 *
 * Two properties, and both matter:
 *
 * - **The comparison is against a derived value, not against the cookie
 *   pair.** Plain double submit ("header equals cookie") is defeated by cookie
 *   tossing: a subdomain writes both a session cookie and a matching CSRF
 *   cookie, and the two agree with each other while belonging to nobody. Here
 *   the expected token is a function of the *session* the request actually
 *   authenticates as, so an attacker who cannot read that session token cannot
 *   produce a header that matches it.
 * - **The direction is one-way.** The CSRF token is readable by same-origin
 *   JavaScript by design — it has to be, or the client could not send it — and
 *   SHA-256 keeps that readability from leaking the session token backwards.
 *
 * What this deliberately does *not* do is store a per-session secret. That
 * would be the textbook synchroniser-token pattern and would allow rotating
 * the CSRF token independently of the session; it also needs a column, a
 * migration and a second lifetime to keep in step with the first. The
 * derivation buys the same unforgeability without either. The cost is
 * honest: a leaked CSRF token stays valid for the life of its session, and
 * cannot be revoked without ending the session.
 */

/**
 * Domain separation. The session token is also hashed — with SHA-256 — to
 * produce the lookup key stored in `session.token_hash`. Without a distinct
 * prefix the two derivations would be the same function of the same input,
 * and the value handed to the browser here would *be* the database key.
 */
const CSRF_DERIVATION_PREFIX = 'formsache-csrf:v1:';

/** Readable by design — see the file comment. */
export const CSRF_COOKIE_NAME = 'formsache_csrf';

/**
 * Behind TLS the `__Host-` prefix applies for the same reason it does for the
 * session cookie: without it, any subdomain may write this cookie for the
 * parent domain. That would not by itself forge a valid token — the server
 * compares against the derived value, not against the cookie — but it would
 * let a subdomain overwrite the legitimate one and lock a user out of every
 * mutating route, which is a denial of service bought for nothing.
 */
export const SECURE_CSRF_COOKIE_NAME = `__Host-${CSRF_COOKIE_NAME}`;

/** Header the client echoes the token in. */
export const CSRF_HEADER_NAME = 'x-csrf-token';

export function csrfCookieName(secure: boolean): string {
  return secure ? SECURE_CSRF_COOKIE_NAME : CSRF_COOKIE_NAME;
}

/**
 * The token that belongs to one session token.
 *
 * Base64url, so the value is a valid `cookie-octet` sequence without escaping
 * — `cookie.ts` rejects anything outside that range, and a token that had to
 * be percent-encoded would be one the client and the server could disagree
 * about decoding.
 */
export function deriveCsrfToken(sessionToken: string): string {
  return createHash('sha256')
    .update(CSRF_DERIVATION_PREFIX + sessionToken)
    .digest('base64url');
}

/**
 * Constant-time comparison.
 *
 * `timingSafeEqual` throws on differing lengths, so the length is checked
 * first — and a length mismatch is not secret: it is visible from the token
 * format alone.
 */
export function csrfTokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

function attributes(secure: boolean, maxAgeSeconds: number): CookieAttributes {
  return {
    maxAgeSeconds,
    // **Not** HttpOnly, and this is the one cookie in the application for
    // which that is correct: the client has to read it to echo it back. It
    // carries no authority on its own — presenting it without the session
    // cookie authenticates nothing.
    httpOnly: false,
    sameSite: 'Lax',
    secure,
    path: '/',
  };
}

export function buildCsrfCookie(
  sessionToken: string,
  options: { readonly secure: boolean; readonly maxAgeSeconds: number },
): string {
  return serializeCookie(
    csrfCookieName(options.secure),
    deriveCsrfToken(sessionToken),
    attributes(options.secure, options.maxAgeSeconds),
  );
}

/**
 * Clearing headers for **both** names, mirroring `buildClearedSessionCookies`.
 *
 * Same reasoning: a cookie left under the other name rides along on every
 * request and turns live again if the deployment moves off TLS.
 */
export function buildClearedCsrfCookies(secure: boolean): string[] {
  const cleared = [
    serializeCookie(SECURE_CSRF_COOKIE_NAME, '', attributes(true, 0)),
    serializeCookie(CSRF_COOKIE_NAME, '', attributes(false, 0)),
  ];
  return secure ? cleared : cleared.reverse();
}

export function readCsrfCookie(
  cookieHeader: string | undefined,
  secure: boolean,
): string | undefined {
  return readCookie(cookieHeader, csrfCookieName(secure));
}
