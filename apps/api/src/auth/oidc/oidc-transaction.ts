import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import { readCookie, serializeCookie } from '../cookie';

/**
 * The one thing an OIDC login has to remember between two requests — and the
 * cookie it remembers it in (ADR-0012 no. 8).
 *
 * ## Why a cookie and not a table
 *
 * `state`, `nonce` and the PKCE `code_verifier` exist for the span of a single
 * login, which is two requests a few seconds apart. A database table would
 * survive restarts, but it would also need a migration, a purge job and a
 * unique index — and `apps/api/prisma/**` belongs to another package. An
 * in-memory map would need none of that and would break every login in flight
 * on a deploy, and it would be wrong the moment a second instance exists.
 *
 * The cookie is the standard shape for this, and it does the one thing that
 * matters more than storage: it **binds the flow to the browser that started
 * it**. That is what makes login-CSRF — an attacker finishing their own flow in
 * somebody else's browser so that the victim ends up signed in as the attacker
 * — fail: the victim's browser presents the victim's transaction (or none), and
 * the `state` in the callback does not match it.
 *
 * ## Why it is not encrypted
 *
 * It carries no secret of the server's. Every value in it is a value the same
 * caller could have obtained by simply starting a login: the tenant is public
 * (it is in the offer list), and `state`, `nonce` and `code_verifier` are freshly
 * minted **for that caller**. Forging the cookie therefore buys nothing a
 * legitimate start does not — in particular not a foreign organisation's tokens: the
 * code is redeemed at the token endpoint of the organisation named in the cookie, with
 * that organisation's client credentials, and the `iss` of the resulting ID token is
 * checked against that same organisation's configured issuer
 * ({@link../../tenant-admin/oidc-issuer.ts}). A cookie claiming Organisation B cannot
 * make Organisation A's provider vouch for anybody in B.
 *
 * What the cookie must never do is *leak*, and that is what `HttpOnly`,
 * `Secure`, `SameSite` and the `__Host-` prefix are for below.
 *
 * ## Why the `state` in the address is a hash
 *
 * The value that travels in the query string is
 * `base64url(sha256(stateSecret))`, never `stateSecret` itself. A `state`
 * reaches the provider's logs, the browser's history, a `Referer` header and
 * every proxy in between; the value that *authorises* the callback stays in the
 * cookie. Whoever reads a `state` out of a log therefore cannot rebuild the
 * transaction — and nothing this file writes down is a secret worth reading.
 */

/** Ten minutes — long enough for a password plus a second factor, no longer. */
export const OIDC_TRANSACTION_TTL_SECONDS = 600;

/** Name over plain http, where a `__Host-` cookie cannot exist. */
export const OIDC_COOKIE_NAME = 'formsache_oidc';

/**
 * Name behind TLS — the same argument `SECURE_SESSION_COOKIE_NAME` makes.
 *
 * A subdomain may write `formsache_oidc` for the parent domain; it can never write a
 * `__Host-` one. Without the prefix, whoever controls any subdomain could plant
 * a transaction of their own and turn the victim's next SSO click into a login
 * as the attacker — precisely the fixation the `state` check exists to stop.
 */
export const SECURE_OIDC_COOKIE_NAME = `__Host-${OIDC_COOKIE_NAME}`;

/** The name that goes with a given `secure`: the two are one decision. */
export function oidcCookieName(secure: boolean): string {
  return secure ? SECURE_OIDC_COOKIE_NAME : OIDC_COOKIE_NAME;
}

/**
 * What the start route remembers.
 *
 * Short keys because a cookie is a size-bounded header and this one carries
 * four random strings; the schema is the documentation.
 */
const transactionSchema = z.strictObject({
  /** The organisation the flow was started at — resolved again, never trusted as a right. */
  t: z.uuid(),
  /** Pre-image of the `state` that travelled in the address. */
  s: z.string().min(1).max(128),
  /** Expected `nonce` claim of the ID token. */
  n: z.string().min(1).max(128),
  /** PKCE `code_verifier` (RFC 7636). */
  v: z.string().min(1).max(128),
  /** Epoch seconds after which this transaction is dead. */
  x: z.number().int().positive(),
});

export interface OidcTransaction {
  readonly tenantId: string;
  readonly stateSecret: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly expiresAtEpochSeconds: number;
}

/** 256 bits — the pre-image of a `state` has to be unguessable, not short. */
const STATE_SECRET_BYTES = 32;
const NONCE_BYTES = 32;

const SECONDS_PER_MILLISECOND = 1000;

/** A fresh, unguessable value in the encoding cookies and URLs both accept. */
function randomToken(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Starts a transaction for one organisation.
 *
 * The `code_verifier` comes from `openid-client` rather than from here, so the
 * library's own length and alphabet rules (RFC 7636 §4.1) are the ones that
 * apply — this file would only be a second opinion about them.
 */
export function newOidcTransaction(
  tenantId: string,
  codeVerifier: string,
  now: Date = new Date(),
): OidcTransaction {
  return {
    tenantId,
    stateSecret: randomToken(STATE_SECRET_BYTES),
    nonce: randomToken(NONCE_BYTES),
    codeVerifier,
    expiresAtEpochSeconds:
      Math.floor(now.getTime() / SECONDS_PER_MILLISECOND) +
      OIDC_TRANSACTION_TTL_SECONDS,
  };
}

/**
 * The `state` parameter that belongs to a transaction — a hash, see the file
 * comment.
 *
 * Exported so that the callback derives it the same way the start route did.
 * Two spellings of this would be a login that never matches its own `state`.
 */
export function stateParameter(transaction: OidcTransaction): string {
  return createHash('sha256')
    .update(transaction.stateSecret)
    .digest('base64url');
}

/**
 * Whether the `state` a callback presented belongs to the transaction the
 * browser carries — **the single state check of this application**.
 *
 * Compared with {@link timingSafeEqual} even though a mismatching `state` is
 * refused outright and the value is single-use: the comparison is free, and
 * the habit is what keeps the *next* comparison from being a `===`.
 * `openid-client` is handed `skipStateCheck` because the decision has already
 * been made here — one rule, one place, and removing this function is what a
 * reproduction has to make red.
 */
export function stateMatches(
  transaction: OidcTransaction,
  presented: string,
): boolean {
  const expected = Buffer.from(stateParameter(transaction), 'utf8');
  const actual = Buffer.from(presented, 'utf8');
  if (expected.length !== actual.length) {
    return false;
  }
  return timingSafeEqual(expected, actual);
}

export interface OidcCookieOptions {
  /** True only behind TLS — derived from `NODE_ENV` by the caller. */
  readonly secure: boolean;
}

/** `Set-Cookie` value that installs a transaction. */
export function buildOidcTransactionCookie(
  transaction: OidcTransaction,
  options: OidcCookieOptions,
): string {
  const payload: z.infer<typeof transactionSchema> = {
    t: transaction.tenantId,
    s: transaction.stateSecret,
    n: transaction.nonce,
    v: transaction.codeVerifier,
    x: transaction.expiresAtEpochSeconds,
  };
  return serializeCookie(
    oidcCookieName(options.secure),
    Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url'),
    cookieAttributes(OIDC_TRANSACTION_TTL_SECONDS, options.secure),
  );
}

/**
 * Every `Set-Cookie` that removes a transaction: **both** names.
 *
 * Sent by the callback on every path, successful or not — a transaction is
 * single-use, and one left behind is one that can be replayed against a second
 * authorization code. The same two-name argument as
 * `buildClearedSessionCookies`: a cookie under the other name would otherwise
 * survive in the browser and be presented on every later request.
 */
export function buildClearedOidcCookies(secure: boolean): string[] {
  const cleared = [
    serializeCookie(SECURE_OIDC_COOKIE_NAME, '', cookieAttributes(0, true)),
    serializeCookie(OIDC_COOKIE_NAME, '', cookieAttributes(0, false)),
  ];
  return secure ? cleared : cleared.reverse();
}

/**
 * The transaction the browser presented, or `undefined`.
 *
 * `undefined` covers every failure alike — no cookie, a value that is not
 * base64url of our own JSON, a payload that does not parse, an expired one.
 * The caller answers with the same undifferentiated `fehlgeschlagen` in all of
 * them: a callback is reachable without a session, and telling a caller *which*
 * way their forged cookie was wrong is free help.
 */
export function readOidcTransaction(
  cookieHeader: string | undefined,
  secure: boolean,
  now: Date = new Date(),
): OidcTransaction | undefined {
  const raw = readCookie(cookieHeader, oidcCookieName(secure));
  if (raw === undefined) {
    return undefined;
  }

  let parsed: z.infer<typeof transactionSchema>;
  try {
    // `base64url` decoding is lenient, so the JSON parse and the schema are
    // what actually reject rubbish. Both are inside the `try`: a hand-written
    // cookie is foreign input and must not reach the caller as an exception.
    parsed = transactionSchema.parse(
      JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')),
    );
  } catch {
    return undefined;
  }

  if (parsed.x * SECONDS_PER_MILLISECOND <= now.getTime()) {
    return undefined;
  }

  return {
    tenantId: parsed.t,
    stateSecret: parsed.s,
    nonce: parsed.n,
    codeVerifier: parsed.v,
    expiresAtEpochSeconds: parsed.x,
  };
}

/**
 * `Path=/` rather than `/api/auth/oidc`, which is the narrower and therefore
 * tempting choice: the `__Host-` prefix **requires** `Path=/`, and the prefix
 * buys more than the narrowing does. A path-scoped cookie still reaches every
 * request to that path from any subdomain that planted it; the prefix is what
 * makes planting impossible in the first place.
 */
function cookieAttributes(
  maxAgeSeconds: number,
  secure: boolean,
): Parameters<typeof serializeCookie>[2] {
  return {
    maxAgeSeconds,
    httpOnly: true,
    // `Lax`, and it has to be: the provider sends the browser back with a
    // top-level `GET` navigation from *its* origin, and `Strict` would withhold
    // the cookie exactly there — every login would fail with a missing
    // transaction. `Lax` still withholds it from cross-site POSTs.
    sameSite: 'Lax',
    secure,
    path: '/',
  };
}
