import request from 'supertest';
import { expect } from 'vitest';
import { z } from 'zod';

import { CSRF_HEADER_NAME, deriveCsrfToken } from '../../src/auth/csrf';
import {
  SESSION_COOKIE_NAME,
  readSessionToken,
} from '../../src/auth/session-cookie';
import { SessionService } from '../../src/auth/session.service';
import { apiPath, type TestApp } from './create-test-app';

/**
 * The few HTTP shapes an integration suite repeats.
 *
 * The session token lives in an httpOnly cookie, so every authenticated
 * request in a test has to log in first and carry the header by hand. Doing
 * that inline is how a suite ends up asserting against a cookie it parsed
 * slightly differently in each file.
 */

/** supertest types headers loosely; `set-cookie` is foreign data like any other. */
const setCookieSchema = z.array(z.string()).default([]);

export function setCookies(response: request.Response): string[] {
  return setCookieSchema.parse(response.headers['set-cookie']);
}

/** The raw session token out of a login response. */
export function sessionCookie(response: request.Response): string {
  const [header] = setCookies(response);
  expect(header).toBeDefined();
  // `false`: the test app runs without TLS, so the cookie carries the bare
  // name rather than the `__Host-` one.
  const token = readSessionToken(header, false);
  expect(token).toBeDefined();
  // The assertion above is what makes this safe, not the operator.
  return token ?? '';
}

export function cookieHeader(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}`;
}

/** Logs in over HTTP and returns the session token. */
export async function login(
  app: TestApp,
  email: string,
  password: string,
): Promise<string> {
  const response = await request(app.server)
    .post(apiPath('/auth/login'))
    .send({ email, password });
  expect(response.status).toBe(200);
  return sessionCookie(response);
}

/**
 * Opens a session without going through `POST /api/auth/login`.
 *
 * Through the application's own `SessionService`, so the row is the same one a
 * login produces — the token, the digest, the expiry and the active tenant all
 * come from the production code path (`AuthService.login` calls exactly this
 * method after verifying the password).
 *
 * Two reasons to prefer it over a login in a suite that is not about logging
 * in. It states the starting scope outright instead of leaving it to be
 * inferred from a fixture's membership count, which is what a reader of an
 * isolation test needs to see. And the login route is rate-limited to ten
 * attempts a minute per address (`login-rate-limit.ts`) — a limit set for a
 * password prompt, which a suite with two dozen sessions in it would otherwise
 * be measuring instead of the guard chain.
 */
export async function openSession(
  app: TestApp,
  userId: string,
  activeTenantId: string | null,
): Promise<string> {
  const { token } = await app.app
    .get(SessionService)
    .issue(userId, activeTenantId);
  return token;
}

/**
 * The CSRF token that belongs to a session token.
 *
 * Derived with the application's own function rather than restated here: a
 * second implementation in the test suite would keep passing after the
 * derivation changed, which is the one thing a test of a token must not do.
 */
export function csrfHeader(sessionToken: string): Record<string, string> {
  return { [CSRF_HEADER_NAME]: deriveCsrfToken(sessionToken) };
}

/**
 * Cookie **and** CSRF header — what an authenticated mutating request looks
 * like from now on.
 *
 * A helper rather than two calls at each site, because forgetting the second
 * one produces a 403 that reads like an authorisation bug and is not.
 */
export function authedMutation(sessionToken: string): Record<string, string> {
  return { Cookie: cookieHeader(sessionToken), ...csrfHeader(sessionToken) };
}
