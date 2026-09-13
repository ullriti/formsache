import request from 'supertest';
import { expect } from 'vitest';
import {
  DEFAULT_OIDC_EMAIL_CLAIM,
  DEFAULT_OIDC_EMAIL_VERIFIED_CLAIM,
  DEFAULT_OIDC_SCOPES,
} from '@formsache/shared';
import type {
  FakeIdentity,
  FakeIdp,
  TokenDeviation,
} from '@formsache/test-idp';

import { OIDC_COOKIE_NAME } from '../../src/auth/oidc/oidc-transaction';
import {
  SESSION_COOKIE_NAME,
  readSessionToken,
} from '../../src/auth/session-cookie';
import { OIDC_CALLBACK_PATH } from '../../src/common/public-url/public-url.service';
import { OidcSecretsService } from '../../src/tenant-admin/oidc-secrets.service';
import {
  TEST_PUBLIC_BASE_URL,
  apiPath,
  type TestApp,
} from '../support/create-test-app';
import { setCookies } from '../support/http';

/**
 * Driving a whole OIDC login over HTTP — the browser's part of it, by hand.
 *
 * Every step goes through the shipped routes: the start route mints the
 * transaction cookie and the authorization URL, the fake provider signs a real
 * ID token, and the callback route is called exactly as a browser would call it.
 * Nothing here reaches into the application to shorten a step, which is the only
 * way the assertions of the requirement mean anything.
 */

/**
 * The one `redirect_uri` a provider in this suite is registered for.
 *
 * Composed the way the server composes it — installation base address plus the
 * fixed callback path, no organisation in it — so „registriert" here means the address
 * `PublicUrlService.oidcCallbackUrl` really sends. A literal would be a second
 * spelling that stops matching the day the route is renamed.
 */
export const TEST_REDIRECT_URI = `${TEST_PUBLIC_BASE_URL}${OIDC_CALLBACK_PATH}`;

/** Configures an organisation's OIDC block — the state the route would leave. */
export async function configureOidc(
  app: TestApp,
  tenantId: string,
  idp: FakeIdp,
  options: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly enabled?: boolean;
    readonly buttonLabel?: string | null;
    /**
     * The two claim names. Absent means the shipped defaults —
     * so every existing caller configures exactly the organisation it configured
     * before, which is what makes „mit Vorgaben unverändert" measurable.
     */
    readonly emailClaim?: string;
    readonly emailVerifiedClaim?: string;
  },
): Promise<void> {
  // Sealed through the application's own key holder, so the row is byte-for-byte
  // the one `PUT /api/tenant/oidc` writes — a hand-made ciphertext would test
  // this suite's crypto rather than the server's.
  const secret = app.app
    .get(OidcSecretsService)
    .seal(options.clientSecret, tenantId);

  await app.prisma.tenant.update({
    where: { id: tenantId },
    data: {
      oidcEnabled: options.enabled ?? true,
      oidcIssuer: idp.issuer,
      oidcClientId: options.clientId,
      oidcClientSecret: secret,
      oidcScopes: [...DEFAULT_OIDC_SCOPES],
      oidcEmailClaim: options.emailClaim ?? DEFAULT_OIDC_EMAIL_CLAIM,
      oidcEmailVerifiedClaim:
        options.emailVerifiedClaim ?? DEFAULT_OIDC_EMAIL_VERIFIED_CLAIM,
      oidcButtonLabel: options.buttonLabel ?? null,
    },
  });
}

export interface StartedFlow {
  readonly authorizationUrl: string;
  /** The `Cookie` header a browser would present at the callback. */
  readonly cookie: string;
  /** The `state` that travelled in the address — a digest, never the secret. */
  readonly state: string;
  /** The address this flow spoke from — the callback has to use it too. */
  readonly caller: string;
}

/**
 * A fresh caller address per flow.
 *
 * The three routes of this package are rate-limited per address, and the limits
 * are set for a person clicking a button (ten starts a minute). A suite with two
 * dozen logins in it would measure the limiter instead of the login — the same
 * problem `openSession` solves for `POST /auth/login`, and it is solved the same
 * way here: the limits stay exactly as shipped, and the suite stops pretending
 * that two dozen people are one.
 *
 * It works because the test application is booted with `TRUST_PROXY_HOPS: 1`,
 * so `X-Forwarded-For` is believed — which is *also* worth having under test,
 * since the compose stack runs behind exactly one nginx hop. A suite
 * that ran without it would leave `clientAddress` untested on the only path
 * production uses. `oidc-rate-limit` asserts that the limit still fires.
 */
let callerCounter = 0;
export function nextCaller(): string {
  callerCounter += 1;
  const low = callerCounter % 251;
  const high = Math.floor(callerCounter / 251) % 251;
  return `10.0.${String(high)}.${String(low)}`;
}

/** `GET /api/auth/oidc/start/:tenantId`, as a browser follows it. */
export async function startFlow(
  app: TestApp,
  tenantId: string,
  caller: string = nextCaller(),
): Promise<StartedFlow> {
  const response = await request(app.server)
    .get(apiPath(`/auth/oidc/start/${tenantId}`))
    .set('X-Forwarded-For', caller);
  expect(response.status).toBe(302);

  const location = locationOf(response);
  const url = new URL(location);
  const cookie = transactionCookie(response);
  const state = url.searchParams.get('state');
  expect(state).not.toBeNull();

  return { authorizationUrl: location, cookie, state: state ?? '', caller };
}

/** The transaction cookie out of a start response, as a `Cookie` header. */
export function transactionCookie(response: request.Response): string {
  const header = setCookies(response).find((value) =>
    value.startsWith(`${OIDC_COOKIE_NAME}=`),
  );
  expect(header).toBeDefined();
  const [pair] = (header ?? '').split(';');
  return pair ?? '';
}

/** `GET /api/auth/oidc/callback`, as the provider redirects the browser to it. */
export function callback(
  app: TestApp,
  query: { readonly code?: string; readonly state?: string },
  cookie: string | undefined,
  caller: string = nextCaller(),
): request.Test {
  const parameters = new URLSearchParams();
  if (query.code !== undefined) {
    parameters.set('code', query.code);
  }
  if (query.state !== undefined) {
    parameters.set('state', query.state);
  }
  const call = request(app.server)
    .get(`${apiPath('/auth/oidc/callback')}?${parameters.toString()}`)
    .set('X-Forwarded-For', caller);
  return cookie === undefined ? call : call.set('Cookie', cookie);
}

/**
 * A complete login: start, authorize at the provider, come back.
 *
 * The `deviation` is how the tests make the provider misbehave — a missing
 * `nonce`, a foreign one, a foreign `iss`.
 */
export async function signInThrough(
  app: TestApp,
  idp: FakeIdp,
  tenantId: string,
  identity: FakeIdentity,
  deviation: TokenDeviation = {},
): Promise<request.Response> {
  const started = await startFlow(app, tenantId);
  const code = idp.authorize(started.authorizationUrl, identity, deviation);
  return callback(
    app,
    { code, state: started.state },
    started.cookie,
    started.caller,
  );
}

/**
 * The `Set-Cookie` that installs a session — `undefined` on every refusal.
 *
 * Not `setCookies(response)[0]`, which is what the local login's helper can
 * afford: a callback answers with up to four `Set-Cookie` headers (the two
 * cleared transaction names, the session, the CSRF companion), and the first of
 * them is a *clearing* one. Matching the name and rejecting the empty value is
 * what makes „keine Sitzung ausgestellt" a real assertion.
 */
export function sessionSetCookie(
  response: request.Response,
): string | undefined {
  const headers = response.headers['set-cookie'];
  const list = Array.isArray(headers) ? (headers as string[]) : [];
  return list.find(
    (value) =>
      value.startsWith(`${SESSION_COOKIE_NAME}=`) &&
      !value.startsWith(`${SESSION_COOKIE_NAME}=;`),
  );
}

/** The raw session token a successful callback installed. */
export function sessionTokenOf(response: request.Response): string {
  const header = sessionSetCookie(response);
  expect(header).toBeDefined();
  // `false`: the test app runs without TLS, so the bare cookie name applies.
  const token = readSessionToken(header, false);
  expect(token).toBeDefined();
  return token ?? '';
}

/**
 * The `Location` a redirect answered with — asserted rather than assumed.
 *
 * Every route of this package answers 302, so a missing header means the route
 * did something else entirely, and the suite should say so there rather than
 * three lines later inside `new URL(undefined)`.
 */
export function locationOf(response: request.Response): string {
  const location = response.headers.location;
  expect(location).toBeDefined();
  return location ?? '';
}

/** The `?sso=` code a callback redirected back to the login page with. */
export function outcomeOf(response: request.Response): string | null {
  const location = response.headers.location;
  if (location === undefined) {
    return null;
  }
  return new URL(location).searchParams.get('sso');
}
