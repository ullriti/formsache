import type {
  EmailChange,
  LoginRequest,
  OidcProvider,
  PasswordChange,
  SessionRevocation,
  SessionUser,
  SwitchTenantRequest,
} from '@formsache/shared';
import {
  parseLoginResponse,
  parseOidcProviders,
  parseSessionRevocation,
  parseSessionUser,
} from '@formsache/shared';

import { API_BASE, ApiError, requestJson, requestVoid } from './http';

/**
 * The three authentication calls, each parsed through the
 * shared wire contract (`packages/shared/src/auth.ts`).
 *
 * Parsing rather than casting is not ceremony: a response that lost a field —
 * a refactor on the server, a proxy that answered with an error page, a stale
 * deployment — must fail *here*, at the boundary, instead of rendering a shell
 * with an empty tenant name and a header that lies about who is signed in.
 */

/**
 * Reads the current session.
 *
 * `null` means "no session" — the API says 401 for that, and 401 is a normal
 * answer to this question, not a failure. Every other error propagates.
 */
export async function fetchSessionUser(): Promise<SessionUser | null> {
  try {
    return parseSessionUser(await requestJson('/auth/me', { method: 'GET' }));
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return null;
    }
    throw error;
  }
}

/**
 * Signs in. The session itself arrives as a `Set-Cookie` header the browser
 * stores and JavaScript never sees; the body only carries the user.
 *
 * A wrong password answers 401 — the same 401 an unknown e-mail gets, which is
 * why the view has exactly one error message.
 */
export async function login(credentials: LoginRequest): Promise<SessionUser> {
  const payload = await requestJson('/auth/login', {
    method: 'POST',
    body: credentials,
  });

  return parseLoginResponse(payload).user;
}

/**
 * Which Organisationen offer an SSO button.
 *
 * The list is a **convenience**, never a protection: the start and callback
 * routes refuse an organisation that does not offer SSO no matter what this answered, so
 * a stale cache or a hand-built link buys nothing. Which is why an error here is
 * not fatal for the page — the local login form stands on its own.
 */
export async function fetchOidcProviders(): Promise<OidcProvider[]> {
  return parseOidcProviders(
    await requestJson('/auth/oidc/providers', { method: 'GET' }),
  );
}

/**
 * Where the browser goes to start an SSO login.
 *
 * A **full page navigation**, not `fetch`: the server answers with a redirect to
 * the identity provider and sets the transaction cookie on the way, and both of
 * those need the browser itself. Spelled here rather than in the view so that
 * the `/api` base has one source (`http.ts`), and `encodeURIComponent` is
 * applied although the id comes from our own API — a value that ends up in an
 * address is escaped where it is built, not where it happens to be trusted.
 */
export function oidcStartUrl(tenantId: string): string {
  return `${API_BASE}/auth/oidc/start/${encodeURIComponent(tenantId)}`;
}

/** Ends the session server-side. Answers 204, no body. */
export async function logout(): Promise<void> {
  await requestVoid('/auth/logout', { method: 'POST' });
}

/**
 * Ends all **other** sessions of this person (a review finding).
 *
 * One's own stays — otherwise the page would fall back to the sign-in, and
 * nobody would read the number that the answer carries.
 */
export async function revokeOtherSessions(): Promise<SessionRevocation> {
  return parseSessionRevocation(
    await requestJson('/auth/sessions/revoke-others', { method: 'POST' }),
  );
}

/**
 * Moves the session into another tenant.
 *
 * The server answers with the whole `SessionUser`, because the switch changes
 * more than one field: the active tenant decides the theme, the permissions
 * that apply and every tenant-bound query. Taking the fresh user from the
 * answer rather than patching the cached one is what keeps the client from
 * inventing a state the server never confirmed.
 *
 * A tenant the person is not a member of answers 404 — deliberately the same
 * answer an unknown id gets, so the endpoint is not an oracle for which
 * tenants exist.
 */
export async function switchTenant(tenantId: string): Promise<SessionUser> {
  return parseSessionUser(
    await requestJson('/session/tenant', {
      method: 'PUT',
      body: { tenantId } satisfies SwitchTenantRequest,
    }),
  );
}

/**
 * Changes one's own name (finding 12).
 *
 * Answers with the **whole** signed-in user, not with the changed
 * field — that is why this call parses `parseSessionUser` and the hook writes
 * the result into the session cache: the name stands in the
 * header, in the member list and in the profile, and a cache
 * patched by hand would be a state that the server never
 * confirmed.
 */
export async function updateProfile(name: string): Promise<SessionUser> {
  return parseSessionUser(
    await requestJson('/auth/profile', { method: 'PUT', body: { name } }),
  );
}

/**
 * Changes one's own e-mail address — with a password prompt (finding 8).
 *
 * Like the name change, it answers with the **whole** signed-in user: the
 * address stands in the header of the profile („Angemeldet als …") and in every
 * member list, so the answer belongs in the session cache and
 * not in a copy dragged along by hand.
 *
 * A wrong password answers 401, an SSO account 422, an address that is already
 * taken 409 — the view reads all three sentences from the server instead of
 * inventing them.
 */
export async function changeOwnEmail(
  change: EmailChange,
): Promise<SessionUser> {
  return parseSessionUser(
    await requestJson('/auth/email', { method: 'POST', body: change }),
  );
}

/**
 * Changes one's own password — with a prompt for the old one (finding 12).
 *
 * **The answer carries a number and a fresh cookie** (ADR-0020): the
 * change ends *every* session of this person, one's own included, and
 * the replacement session comes along in the `Set-Cookie`. The browser takes it
 * over by itself; visible here is only the number that the confirmation carries.
 *
 * A wrong current password answers 401, an SSO account 422 — the
 * view reads both sentences from the server (`api-messages.ts`) instead of
 * inventing them.
 */
export async function changeOwnPassword(
  change: PasswordChange,
): Promise<SessionRevocation> {
  return parseSessionRevocation(
    await requestJson('/auth/password', { method: 'POST', body: change }),
  );
}

/**
 * Requests a reset link (ADR-0020).
 *
 * **The answer is always the same** — 204, no body, whether the address exists
 * or not. That is why there is also nothing to parse here and nothing
 * to return: a value that the view *could* display would be exactly the
 * channel that the route closes. What the view shows is a fixed sentence.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  await requestVoid('/auth/password-reset/request', {
    method: 'POST',
    body: { email },
  });
}

/**
 * Redeems a reset link and sets the new password (ADR-0020).
 *
 * An unknown, expired or used-up token answers with **one**
 * refusal (400) — the view shows the sentence of the server, because any
 * distinction of its own would be information that the server deliberately does not give.
 */
export async function confirmPasswordReset(
  token: string,
  password: string,
): Promise<void> {
  await requestVoid('/auth/password-reset/confirm', {
    method: 'POST',
    body: { token, password },
  });
}
