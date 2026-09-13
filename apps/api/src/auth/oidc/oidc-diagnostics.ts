/**
 * **What an operator may learn about a failed SSO sign-in —
 * and in what form** (ADR-0005, ADR-0012, ADR-0016).
 *
 * The three routes of this package answer the browser with a **coarse**
 * {@link OidcOutcome} and nothing else: whoever may not sign in shall not be
 * able to derive from the answer whether an account exists, whether an
 * Organisation offers SSO, or what the cause was. This asymmetry is the whole
 * purpose of the package — and it is only bearable when the *other* side is
 * talkative. Without it the operator gets an `unauthorized` and sees nothing in
 * the log that tells them what to repair.
 *
 * This file is the one seam through which foreign data passes on its way into
 * the log. What it lets through is deliberately narrow:
 *
 * - **class names** of an exception (`ResponseBodyError`, `JWSSignatureVerificationFailed`) —
 *   ours or a library's, never a value.
 * - **error codes of the protocol** (`invalid_client`, `access_denied`), and only
 *   those from {@link OAUTH_ERROR_CODES}. Everything else becomes
 *   `non-standard-code` — the code comes out of an answer or out of a
 *   query string and is therefore foreign input, even though RFC 6749 lays
 *   it down.
 * - **transport codes of Node** (`ENOTFOUND`, `CERT_HAS_EXPIRED`) via
 *   `error.cause`, shape-checked. In practice that is the most common cause
 *   of a failing discovery and stands nowhere else.
 *
 * What it does **not** let through: `error.message`. With `openid-client` the
 * message quotes the provider's answer, with Prisma the values of the query —
 * `test/observability/log-hygiene.spec.ts` forbids it project-wide anyway,
 * and this module is the answer to the question of what stands there
 * instead.
 */

/**
 * The error codes that RFC 6749 §4.1.2.1/§5.2 and OpenID Connect Core §3.1.2.6
 * lay down — and the only ones that may go into the log verbatim.
 *
 * **An allow-list, although the codes stand in a standard.** The value comes
 * either from the JSON of the token endpoint or — on a redirect error — from
 * the query string of the callback, and that one the caller writes. An
 * unfiltered value would be a string chosen from outside in the
 * operator's log file; that is exactly what `requestId` already forbids for
 * `X-Request-Id` elsewhere.
 */
const OAUTH_ERROR_CODES: ReadonlySet<string> = new Set([
  // RFC 6749 §4.1.2.1 — authorisation endpoint
  'invalid_request',
  'unauthorized_client',
  'access_denied',
  'unsupported_response_type',
  'invalid_scope',
  'server_error',
  'temporarily_unavailable',
  // RFC 6749 §5.2 — token endpoint
  'invalid_client',
  'invalid_grant',
  'unsupported_grant_type',
  // OpenID Connect Core §3.1.2.6
  'interaction_required',
  'login_required',
  'account_selection_required',
  'consent_required',
  'invalid_request_uri',
  'invalid_request_object',
  'request_not_supported',
  'request_uri_not_supported',
  'registration_not_supported',
]);

/** What takes the place of a code that is not standardised. */
export const NON_STANDARD_CODE = 'non-standard-code';

/**
 * How deep {@link describeFailure} follows the `cause` chain.
 *
 * Node wraps a connection error as `TypeError: fetch failed` with the
 * actual reason in `cause` — and undici occasionally puts one more layer
 * on top. Three are enough for that; an unbounded loop would be one that a
 * self-referential `cause` never leaves.
 */
const CAUSE_DEPTH = 3;

/** Shape of a Node/OpenSSL error code: `ENOTFOUND`, `CERT_HAS_EXPIRED`. */
const TRANSPORT_CODE = /^[A-Z][A-Z0-9_]{1,39}$/;

/**
 * Why an ID token was refused — **our own refusal**, not that
 * of a library.
 *
 * Both cases were thrown as a bare `new Error(...)` up to this point and were
 * visible in the log as `Error`: indistinguishable from a timeout
 * and from every other error in the world. That is the finding this class
 * repairs — the *message* of the two exceptions is our own and would carry
 * nothing foreign, but `nameOf(error)` never read it.
 */
export type IdTokenRefusal =
  /** The token answer carried no ID token — the provider is no OIDC provider. */
  | 'no-id-token'
  /** The token's `iss` is not the issuer configured for this Organisation. */
  | 'issuer-mismatch';

export class OidcIdTokenRefusedError extends Error {
  constructor(readonly refusal: IdTokenRefusal) {
    super(`ID token refused: ${refusal}`);
    this.name = 'OidcIdTokenRefusedError';
  }
}

/**
 * An error as it may go into a log line.
 *
 * The class, plus — where present — the standardised protocol error code and the
 * transport code from the `cause` chain, joined with `/`:
 *
 * ```
 * ResponseBodyError/invalid_client
 * TypeError/ENOTFOUND
 * OidcIdTokenRefusedError/issuer-mismatch
 * ```
 *
 * That is the difference between „the sign-in failed" and „the
 * client secret in the Organisation does not match the one in the Keycloak".
 */
export function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'unknown failure';
  }
  const parts: string[] = [error.name];
  if (error instanceof OidcIdTokenRefusedError) {
    parts.push(error.refusal);
  }
  const code = protocolErrorCode(error);
  if (code !== undefined) {
    parts.push(code);
  }
  const transport = transportErrorCode(error);
  if (transport !== undefined) {
    parts.push(transport);
  }
  return parts.join('/');
}

/**
 * The error code of the protocol that `oauth4webapi` hangs on its
 * `ResponseBodyError`/`AuthorizationResponseError` as `error` — filtered.
 */
function protocolErrorCode(error: Error): string | undefined {
  const raw: unknown = (error as { readonly error?: unknown }).error;
  if (typeof raw !== 'string' || raw === '') {
    return undefined;
  }
  return OAUTH_ERROR_CODES.has(raw) ? raw : NON_STANDARD_CODE;
}

/** The transport code from `error.cause`, shape-checked — see {@link TRANSPORT_CODE}. */
function transportErrorCode(error: Error): string | undefined {
  let current: unknown = error.cause;
  for (let depth = 0; depth < CAUSE_DEPTH && current !== null; depth += 1) {
    if (typeof current !== 'object') {
      return undefined;
    }
    const code: unknown = (current as { readonly code?: unknown }).code;
    if (typeof code === 'string' && TRANSPORT_CODE.test(code)) {
      return code;
    }
    current = (current as { readonly cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * What passes as a domain from the `@` onwards — and how much of it.
 *
 * Forty characters are enough for every domain that occurs at an operator, and
 * they bound what a provider can write into a log line.
 */
const DOMAIN = /^[a-z0-9.-]{1,40}/i;

/**
 * An address as it may go into the log: **first letter and domain**.
 *
 * `max.mustermann@verein.example` becomes `m***@verein.example`.
 *
 * ## Why an address at all
 *
 * `docs/kb/10-datenschutz.md` says „Protokollierung ohne Personenbezug", and
 * the rule holds. This one place is the justified exception, and it is
 * narrow: when a provider confirms somebody for whom there is no invitation
 * here, the **domain** is the answer in nine out of ten cases — the provider
 * delivers `vorname.nachname@ad.verein.local` instead of `@verein.example`, or it
 * delivers the `upn` instead of the mail address. Without this part the log
 * says „keine Einladung gefunden" and the operator goes on searching in the fog.
 *
 * The initial letter is there to tell two sign-in attempts of the same
 * Organisation apart; it identifies nobody.
 *
 * ## Why it is cleaned in addition
 *
 * The value comes out of an ID token. `readVerifiedEmail` only checks that the
 * claim is a non-empty string — **not** that it is an address.
 * A provider that puts ten kilobytes of free text with line breaks in there
 * would otherwise write them into the operator's log file. The domain is
 * therefore reduced to the characters that occur in a domain, and
 * shortened.
 */
export function maskAddress(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) {
    // No address (or one without a local part): then there is nothing to
    // mask and nothing that would help diagnostically — so nothing at all.
    return '***';
  }
  const initial = address.slice(0, 1).replace(/[^a-z0-9]/i, '');
  // **Cut off, not filtered out.** A filter over the whole
  // string glued `verein.example` and `levelerror` from a
  // smuggled-in JSON line into a domain that never existed — an
  // operator would read a piece of information that is wrong. The domain is what
  // passes as a domain from the `@` onwards, and ends at the first character
  // that is not one.
  const domain = (DOMAIN.exec(address.slice(at + 1)) ?? [''])[0];
  return domain === '' ? '***' : `${initial}***@${domain}`;
}

/**
 * The scheme of a stored issuer — `https`, `http`, something else.
 *
 * The value itself does **not** go into the log: a column that
 * `acceptableIssuer` has rejected has by definition never gone through the
 * write gate, and is therefore foreign input (`OidcConfigService.toConfig`
 * makes the same decision, with the same reasoning). The scheme is the
 * one part that names the most common cause — „there is `http://` instead of
 * `https://`" — without passing the value on.
 */
export function issuerScheme(raw: string): string {
  const url = URL.parse(raw);
  if (url === null) {
    return 'not-a-url';
  }
  const scheme = url.protocol.replace(':', '');
  return /^[a-z][a-z0-9+.-]{0,15}$/.test(scheme) ? scheme : 'other';
}
