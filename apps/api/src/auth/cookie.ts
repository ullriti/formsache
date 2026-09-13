/**
 * Cookie serialisation and parsing — by hand, without `cookie-parser`.
 *
 * Two reasons for not taking the dependency. The application sets and reads
 * exactly one cookie, so a general-purpose parser would be more surface than
 * feature ("prefer the standard library"). And the attributes
 * that make the session cookie safe — `HttpOnly`, `SameSite`, `Secure` — are
 * precisely the ones a middleware default could quietly get wrong; written out
 * here they are visible, and the unit tests next door assert them literally.
 *
 * The parsing side follows RFC 6265 §4.1.1: pairs separated by `;`, name and
 * value separated by the **first** `=`, surrounding whitespace ignored.
 */

/**
 * `SameSite` values.
 *
 * `None` has no use in this application, and narrowing the union to
 * `'Lax' | 'Strict'` would make the invalid combination below *impossible*
 * rather than merely loud — which is normally the better trade. It is not
 * taken here for the same reason `Path` and the name prefixes are validated at
 * runtime: this file is written as a general RFC 6265 serialiser, tested as
 * one, and is the place a future caller will reach for when a cross-site
 * embed or an OIDC form-post response genuinely needs `None`. A type that
 * forbids it would be edited away in that moment, and the `Secure` condition
 * would go with it. The check below is what survives that edit.
 */
export type SameSite = 'Lax' | 'Strict' | 'None';

export interface CookieAttributes {
  /**
   * Browsers treat a cookie without `Max-Age`/`Expires` as a session cookie
   * that dies with the browser process. That is not what a login session is,
   * so the value is required rather than optional — 0 deletes the cookie.
   */
  readonly maxAgeSeconds: number;
  readonly httpOnly: boolean;
  readonly sameSite: SameSite;
  /**
   * Only ever true behind TLS. Set locally, over plain http, the browser drops
   * the cookie silently and the login looks broken for no visible reason.
   */
  readonly secure: boolean;
  readonly path: string;
}

/** Cookie names are HTTP tokens (RFC 7230 §3.2.6). */
const VALID_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * The bounds of `cookie-octet` (RFC 6265 §4.1.1): `!` up to `~`, with four
 * printable characters carved out below.
 *
 * The upper bound is the half that is easy to forget. A check that only looks
 * for control characters and the four punctuation marks lets everything above
 * DEL through, so a value with an umlaut passes validation and goes on the
 * wire as UTF-8 bytes the grammar does not allow there.
 */
const LOWEST_COOKIE_OCTET = 0x21;
const HIGHEST_COOKIE_OCTET = 0x7e;
const SPACE = 0x20;
const QUOTE = 0x22;
const COMMA = 0x2c;
const SEMICOLON = 0x3b;
const BACKSLASH = 0x5c;

/**
 * Whether a value carries a character RFC 6265 forbids inside `cookie-octet`.
 *
 * Callers get an error rather than a percent-encoded value. Encoding would be
 * the friendlier answer for arbitrary payloads, but this cookie only ever
 * carries base64url output — an offending character means something upstream
 * is wrong, and quietly repairing it would hide that. A `;` in particular
 * would let a caller append attributes of their own.
 *
 * Read as UTF-16 code units, not as code points: a character outside the BMP
 * arrives as a surrogate half well above `~` and is refused on the first one,
 * which is the answer we want anyway.
 */
function hasForbiddenValueChar(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < LOWEST_COOKIE_OCTET || code > HIGHEST_COOKIE_OCTET) {
      return true;
    }
    if (
      code === QUOTE ||
      code === COMMA ||
      code === SEMICOLON ||
      code === BACKSLASH
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a `Path` carries a character that has no business in the header.
 *
 * `path-value` (RFC 6265 §4.1.1) is `%x20-3A / %x3C-7E` — everything printable
 * except `;`. That `;` is the reason this check exists at all: a path carrying
 * one would end the attribute and let the remainder be read as attributes of
 * its own, which is exactly the injection the value check prevents. Today the
 * only caller passes a constant, but the function is exported and tested as a
 * general serialiser, and "the only caller behaves" is not a property that
 * survives the second caller.
 */
function hasForbiddenPathChar(path: string): boolean {
  for (let index = 0; index < path.length; index += 1) {
    const code = path.charCodeAt(index);
    if (code < SPACE || code > HIGHEST_COOKIE_OCTET || code === SEMICOLON) {
      return true;
    }
  }
  return false;
}

/**
 * The two cookie name prefixes browsers attach a meaning to (RFC 6265bis §4.1.3).
 *
 * `__Secure-` requires `Secure`; `__Host-` requires `Secure`, `Path=/` and no
 * `Domain`. A browser silently discards a cookie whose name promises one of
 * these and whose attributes do not deliver — silently is the operative word:
 * the login would look successful and every following request would be
 * anonymous, with nothing anywhere saying why.
 *
 * Checked here rather than left to the one caller that gets it right today,
 * for the same reason the `Path` is checked: this function is exported and
 * used as a general serialiser, and "the only caller behaves" stops being true
 * at the second caller. `Domain` needs no check — this serialiser never emits
 * one.
 */
function assertNamePrefixConditions(
  name: string,
  attributes: CookieAttributes,
): void {
  const hostPrefixed = name.startsWith('__Host-');
  if ((hostPrefixed || name.startsWith('__Secure-')) && !attributes.secure) {
    throw new Error(`cookie ${name} requires the Secure attribute`);
  }
  if (hostPrefixed && attributes.path !== '/') {
    throw new Error(`cookie ${name} requires Path=/`);
  }
}

/**
 * `SameSite=None` is only a valid combination together with `Secure`.
 *
 * Same failure class as the name prefixes above, and checked for the same
 * reason: a browser drops a `SameSite=None` cookie that is not `Secure`
 * **silently** (RFC 6265bis, and every current engine implements it).
 * Nothing would appear in a log, the request would look successful, and every
 * following request would arrive without a session — the bug that costs an
 * afternoon precisely because there is nothing to read.
 *
 * `Lax` and `Strict` are unaffected: they carry no such requirement.
 */
function assertSameSiteConditions(
  name: string,
  attributes: CookieAttributes,
): void {
  if (attributes.sameSite === 'None' && !attributes.secure) {
    throw new Error(`cookie ${name} with SameSite=None requires Secure`);
  }
}

/**
 * Builds one `Set-Cookie` header value.
 *
 * Every attribute is stated by the caller; there are no defaults to forget.
 */
export function serializeCookie(
  name: string,
  value: string,
  attributes: CookieAttributes,
): string {
  if (!VALID_NAME.test(name)) {
    throw new Error(`invalid cookie name: ${JSON.stringify(name)}`);
  }
  if (hasForbiddenValueChar(value)) {
    // The value is never echoed into the message — it may be a session token.
    throw new Error('cookie value contains a character RFC 6265 forbids');
  }
  if (
    !attributes.path.startsWith('/') ||
    hasForbiddenPathChar(attributes.path)
  ) {
    throw new Error(`invalid cookie Path: ${JSON.stringify(attributes.path)}`);
  }
  if (
    !Number.isInteger(attributes.maxAgeSeconds) ||
    attributes.maxAgeSeconds < 0
  ) {
    throw new Error('cookie Max-Age must be a non-negative integer');
  }
  assertNamePrefixConditions(name, attributes);
  assertSameSiteConditions(name, attributes);

  const parts = [
    `${name}=${value}`,
    `Path=${attributes.path}`,
    `Max-Age=${String(attributes.maxAgeSeconds)}`,
    `SameSite=${attributes.sameSite}`,
  ];
  if (attributes.httpOnly) {
    parts.push('HttpOnly');
  }
  if (attributes.secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

/**
 * Reads one cookie out of a `Cookie` request header.
 *
 * Returns `undefined` for a missing header, a missing cookie or an empty
 * value — the caller cannot tell those apart, and does not need to: all three
 * mean "no session was presented".
 */
export function readCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  if (header === undefined) {
    return undefined;
  }

  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator === -1) {
      // A bare flag without `=` is not a cookie; skipping it keeps a malformed
      // header from hiding the cookies that follow it.
      continue;
    }
    // Compared after trimming, and in full: a prefix match would let a cookie
    // named `formsache_session_theme` answer for `formsache_session`.
    if (pair.slice(0, separator).trim() !== name) {
      continue;
    }
    // Only the *first* `=` separates; everything after it belongs to the
    // value, which may legitimately contain one (base64 padding, for example).
    const value = pair.slice(separator + 1).trim();
    if (value === '') {
      // An empty value counts as absent — it is what a cleared cookie leaves
      // behind — and the search goes on rather than stopping here. Returning
      // at this point would let `formsache_session=; formsache_session=<real>` hide the
      // real one, and that header is not hypothetical: any subdomain may set
      // a cookie for the parent domain, so an attacker who controls one could
      // log every visitor out at will. Failing closed made it a nuisance
      // rather than a hole, but a nuisance is still a denial of service for
      // one HTTP response.
      continue;
    }
    // First occurrence wins among the non-empty ones, as browsers do.
    return value;
  }
  return undefined;
}
