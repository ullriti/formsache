import type { ApiEnv } from '@formsache/shared';

import { readCookie, serializeCookie, type CookieAttributes } from './cookie';

/**
 * The one cookie this application sets — and the attribute policy behind it
 * (ADR-0005).
 *
 * Separate from `cookie.ts` on purpose: that file knows the wire format, this
 * one knows what *our* session cookie must look like. The guard, the login and
 * the logout all go through here, so there is exactly one place where a
 * missing `HttpOnly` could ever happen.
 */

/**
 * Name over plain http — locally, and in an installation that deliberately
 * runs without TLS (`SESSION_COOKIE_SECURE=false`).
 *
 * `__Host-` cannot be used here: the prefix implies `Secure`, and a browser
 * drops such a cookie on an http origin without a word. Which is why the name
 * is not a constant but a function of `secure` below.
 */
export const SESSION_COOKIE_NAME = 'formsache_session';

/**
 * Name behind TLS, and the reason the name is tied to `secure` at all.
 *
 * `__Host-` makes the browser refuse the cookie unless it is `Secure`, has
 * `Path=/` and carries no `Domain` — which in turn means no other host can set
 * it. Without the prefix, any subdomain (a marketing page, a compromised
 * side service, anything under the eventual apex domain) may write a cookie
 * named `formsache_session` for the parent domain, and the browser then presents it
 * alongside ours with no way for the server to tell them apart. That is cookie
 * tossing: at best it logs people out, at worst it fixes a session token of
 * the attacker's choosing on someone else's browser.
 */
export const SECURE_SESSION_COOKIE_NAME = `__Host-${SESSION_COOKIE_NAME}`;

/**
 * `Lax`, not `Strict`: the admin UI is reached by following links from
 * elsewhere (a mail with a form link, a bookmark opened from a chat), and
 * `Strict` would show those visitors a logged-out application. `Lax` still
 * withholds the cookie from cross-site POSTs, which is the CSRF-relevant case;
 * the CSRF token for mutating admin routes follows in a later wave.
 */
const SAME_SITE = 'Lax';

/**
 * Site-wide, because the cookie has to reach every route under the `/api`
 * prefix as well as any future path the app is mounted at. Narrowing it to
 * `/api` would break the moment a route moves — and `__Host-` requires exactly
 * this value anyway.
 */
const PATH = '/';

export interface SessionCookieOptions {
  /** Mirrors the session row's lifetime, so cookie and row expire together. */
  readonly maxAgeSeconds: number;
  /**
   * Whether this deployment speaks TLS. Decided by {@link usesSecureCookies}
   * from the environment and handed in by the caller rather than read here, so
   * the decision sits in exactly one place.
   */
  readonly secure: boolean;
}

/** The name that goes with a given `secure`: the two are one decision. */
export function sessionCookieName(secure: boolean): string {
  return secure ? SECURE_SESSION_COOKIE_NAME : SESSION_COOKIE_NAME;
}

/**
 * Whether this environment speaks TLS — and therefore which cookie name it
 * both writes and accepts.
 *
 * One function rather than the expression repeated at each call site, because
 * the call sites are the *writers* (the login, the OIDC login, the logout) and
 * the *readers* (`SessionGuard`, `CsrfGuard`). If they ever disagreed — someone
 * widening the writer and forgetting the reader — the login would set
 * `__Host-formsache_session` while the guard kept looking for
 * `formsache_session`, and every request after a successful login would come
 * back 401. Nobody debugs that quickly. **This is also the reason the fallback
 * below lives here and not in `apiEnvSchema`:** the test application builds its
 * `ApiEnv` as a literal and never passes that schema, so a default resolved
 * there would hold for the server and not for the suites — two answers to one
 * question, which is precisely the split this function exists against.
 *
 * `SESSION_COOKIE_SECURE` is the explicit answer and wins whenever it is set;
 * `NODE_ENV` is the fallback, so the shipped behaviour is unchanged for every
 * installation that does not set the new variable. ⚠️ **`false` gives up the
 * `__Host-` prefix and with it the defence against cookie tossing** — see
 * {@link SECURE_SESSION_COOKIE_NAME} for what that means and `apiEnvSchema`
 * for when it is nevertheless the right choice (an installation without TLS
 * inside one's own network, and nothing else).
 */
export function usesSecureCookies(
  env: Pick<ApiEnv, 'NODE_ENV' | 'SESSION_COOKIE_SECURE'>,
): boolean {
  return env.SESSION_COOKIE_SECURE ?? env.NODE_ENV === 'production';
}

/**
 * The one line about session cookies an operator gets to read at startup.
 *
 * It exists because the alternative is inspecting cookies in a browser: the
 * shape is decided by two variables, one of which (`NODE_ENV`) means five other
 * things as well, and getting it wrong looks like „die Anmeldung geht nur mit
 * localhost" rather than like a misconfiguration. So the process says which
 * shape it runs in, names the cookie it will actually write, and — in the
 * weaker of the two shapes — says what that shape is good for.
 *
 * English, like every other line this process logs, and next to
 * {@link usesSecureCookies} rather than in `main.ts` so that the sentence and
 * the decision it describes cannot drift apart.
 */
export function describeSessionCookieMode(
  env: Pick<ApiEnv, 'NODE_ENV' | 'SESSION_COOKIE_SECURE'>,
): string {
  const secure = usesSecureCookies(env);
  const source =
    env.SESSION_COOKIE_SECURE === undefined
      ? `NODE_ENV=${env.NODE_ENV}`
      : `SESSION_COOKIE_SECURE=${String(env.SESSION_COOKIE_SECURE)}`;
  const name = sessionCookieName(secure);
  return secure
    ? `Session cookie: Secure, named ${name} (${source}) — TLS required in front of this process.`
    : `Session cookie: no Secure, named ${name} (${source}) — suitable only for operation without TLS in a private network; a publicly reachable installation must set SESSION_COOKIE_SECURE=true.`;
}

/**
 * Whether the shape this environment runs in is a **deliberate weakening** —
 * `production` without `Secure`, the one combination somebody had to ask for.
 *
 * It decides `Logger.warn` over `Logger.log` in `main.ts`, and the cut is where
 * it is for a reason: a development machine runs without `Secure` as a matter of
 * course, so warning there would put a WARN on every `pnpm dev` and teach people
 * to skip warnings — while an installation that gave up cookie integrity should
 * say so in the line an operator greps for. Both shapes are logged either way;
 * only the level differs.
 */
export function sessionCookieModeIsWeakened(
  env: Pick<ApiEnv, 'NODE_ENV' | 'SESSION_COOKIE_SECURE'>,
): boolean {
  return env.NODE_ENV === 'production' && !usesSecureCookies(env);
}

function attributes(options: SessionCookieOptions): CookieAttributes {
  return {
    maxAgeSeconds: options.maxAgeSeconds,
    // The two attributes explicitly. `HttpOnly` keeps the
    // token out of `document.cookie` and therefore out of reach of any XSS
    // that gets into the admin UI.
    httpOnly: true,
    sameSite: SAME_SITE,
    secure: options.secure,
    path: PATH,
  };
}

/** `Set-Cookie` value that installs a session token. */
export function buildSessionCookie(
  token: string,
  options: SessionCookieOptions,
): string {
  return serializeCookie(
    sessionCookieName(options.secure),
    token,
    attributes(options),
  );
}

/**
 * `Set-Cookie` value that removes the session cookie of one name.
 *
 * Same name, same attributes, empty value and `Max-Age=0` — a browser matches
 * the cookie to overwrite by name, path and domain, so a clearing cookie that
 * differed in `Path` would leave the original one in place.
 */
export function buildClearedSessionCookie(
  options: Pick<SessionCookieOptions, 'secure'>,
): string {
  return serializeCookie(
    sessionCookieName(options.secure),
    '',
    attributes({ maxAgeSeconds: 0, secure: options.secure }),
  );
}

/**
 * Every `Set-Cookie` a logout has to send: **both** names.
 *
 * Not because both are accepted — `readSessionToken` takes exactly the one
 * that belongs to the environment — but because a cookie under the other name
 * survives in the browser otherwise, is sent along with every request, and
 * turns live again if the deployment ever moves off TLS. Each is cleared with
 * the attributes its own name requires — a `__Host-` cookie without `Secure` is
 * one the browser refuses outright, so the clearing one has to carry it too.
 * Over plain http that second header is dropped by the browser, which is
 * exactly right: over plain http there is no `__Host-` cookie to clear.
 *
 * The name of the current environment comes first, so that a caller reading
 * only the first header still sees the one that matters here.
 */
export function buildClearedSessionCookies(secure: boolean): string[] {
  const cleared = [
    buildClearedSessionCookie({ secure: true }),
    buildClearedSessionCookie({ secure: false }),
  ];
  return secure ? cleared : cleared.reverse();
}

/**
 * Reads the presented session token, or `undefined` if there is none.
 *
 * **Behind TLS only the `__Host-` name is accepted.** That is the whole point
 * of the prefix and the reason `secure` is a required parameter rather than an
 * option with a default: a subdomain — a marketing page, a compromised side
 * service, anything under the eventual apex domain — can set a cookie named
 * `formsache_session` for the parent domain, but it can never set a `__Host-` one.
 * A reader that fell back to the bare name would hand that tossed cookie
 * straight to `SessionService.authenticate`, and a browser holding no
 * `__Host-` cookie yet (before the first login, or right after a logout) would
 * be authenticated into a session of the attacker's choosing. Accepting both
 * names gives back exactly what the prefix was added to buy.
 *
 * Over plain http the reverse holds: `__Host-` cookies cannot exist there,
 * because a browser refuses to store one without `Secure`. So each environment
 * accepts precisely the name it also writes — one name, one decision, taken by
 * {@link usesSecureCookies} for writers and readers alike.
 */
export function readSessionToken(
  cookieHeader: string | undefined,
  secure: boolean,
): string | undefined {
  return readCookie(cookieHeader, sessionCookieName(secure));
}
