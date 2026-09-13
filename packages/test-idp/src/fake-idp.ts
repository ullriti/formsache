import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

/**
 * A real OpenID provider, small enough to lie on demand — the outside world
 * the OIDC integration talks to.
 *
 * **A server rather than a mock of `openid-client`.** The whole point is what
 * the application does with what a provider says, and a stubbed library answers
 * the question „does this code call the stub the way I wrote the stub" instead.
 * Discovery, JWKS, the token endpoint, the RS256 signature and the PKCE check
 * are all really performed here, so the ID token that reaches the login has been
 * verified by the shipped code path. PKCE is **required**, not merely checked
 * when offered: a provider that shrugs at a missing `code_challenge` makes the
 * application's PKCE deletable without a red test.
 *
 * **It listens on `127.0.0.1`, and that is why `tenant-admin/oidc-issuer.ts`
 * tolerates plain `http` on loopback at all** — the alternative would be a test
 * suite that needs TLS certificates, or a relaxation of the stored-issuer rule
 * that would then be available to a routable host too.
 *
 * Signed with `node:crypto` rather than with `jose`: RS256 over a JWT is a
 * SHA-256 signature over two base64url segments, and Node exports a public key
 * as a JWK on its own. A dependency for that would be a dependency added for a
 * test double („prefer the platform").
 *
 * ## Two user surfaces, **one** protocol
 *
 * There are two ways through the authorization endpoint, and they share
 * {@link issueCode} — the same registration check (`client_id` and
 * `redirect_uri`), the same PKCE requirement, the same store, the same
 * single-use code:
 *
 * 1. **Programmatically**, {@link FakeIdp.authorize}: the supertest suite of
 *    `apps/api` plays the browser itself and gets the code back.
 * 2. **Via the browser**, `GET`/`POST /authorize`: a real Chromium is
 *    redirected here by the application, finds a sign-in form, and after
 *    submitting is redirected back with `code` **and** `state` to the
 *    **registered** `redirect_uri` ({@link FakeIdpOptions.redirectUri}) — to no
 *    other. Only with that can the SSO sign-in flow be run through the user
 *    interface.
 *
 * The form is deliberately *a form* and not an automatism: a real provider
 * asks who is sitting at the device, and the E2E run is meant to make exactly
 * that click. Whoever leaves it out would have to set the identity from the
 * outside — and would thereby have a second way into the same endpoint.
 */

/** What the provider should say about somebody, when asked. */
export interface FakeIdentity {
  readonly sub: string;
  readonly email?: string;
  readonly emailVerified?: boolean;
  /**
   * Which claim carries {@link email} — `email` when absent.
   *
   * There are providers that put the address somewhere else (`upn`, and the
   * URI-shaped legacy names of Entra), and an Organisation can say so.
   * A suite that could only ever mint `email` would leave that configuration
   * untested against a real signed token.
   */
  readonly emailClaim?: string;
  /**
   * Which claim carries {@link emailVerified} — `email_verified` when absent,
   * and **`null` to leave it out of the token entirely**.
   *
   * `null` is what a provider looks like that vouches for nothing, which is the
   * case the empty verification claim is about. It is a separate
   * value from `emailVerified: false`: absent and false are the same refusal
   * today, and a test that only sends `false` would stay green against a
   * `!== false` check.
   */
  readonly emailVerifiedClaim?: string | null;
}

/** How the next ID token should deviate from a correct one. */
export interface TokenDeviation {
  /** Leave the `nonce` claim out entirely. */
  readonly omitNonce?: boolean;
  /** Put this value in `nonce` instead of the one that was requested. */
  readonly nonce?: string;
  /** Put this value in `iss` instead of this provider's own issuer. */
  readonly issuer?: string;
}

interface PendingAuthorization {
  readonly nonce: string | undefined;
  /**
   * **Not optional.** A provider configured to require PKCE has no state in
   * which it holds an authorization without a challenge, and the type is what
   * keeps the token endpoint's check from being written as „falls vorhanden"
   * again — see {@link FakeIdp.authorize}.
   */
  readonly codeChallenge: string;
  readonly redirectUri: string;
  readonly clientId: string;
  readonly identity: FakeIdentity;
  readonly deviation: TokenDeviation;
}

/** How the provider names itself — and what it was registered with. */
export interface FakeIdpOptions {
  /**
   * **The registered `redirect_uri`** — the only one this provider ever
   * redirects back to.
   *
   * A required field, and that is the statement (a review finding). Until then
   * the provider knew no registration: `issueCode` took over every
   * `redirect_uri` out of the request, and `respondToSignIn` redirected the
   * browser to every address handed to it. For as long as there was only the
   * programmatic way, that had no consequences — there was no redirect back at
   * all. With the browser way it is the one point at which this provider would
   * be **more permissive** than a real one: Keycloak refuses an unregistered
   * `redirect_uri`, and a test provider that does not do so would let the third
   * reproduction of the open redirector disappear into a green run. A test
   * double that demands less than reality makes the application look better in
   * the test than it is.
   *
   * There is exactly **one**, because the application has exactly one: the
   * point of return hangs on the base address of the installation and carries
   * no organisation (`PublicUrlService.oidcCallbackUrl`).
   */
  readonly redirectUri: string;
  /**
   * Announce the issuer **with a trailing slash** — the shape of a provider
   * whose issuer is a bare origin (Auth0, Okta, Entra: `https://x.auth0.com/`).
   *
   * It is not cosmetic. `acceptableIssuer` strips trailing slashes from the
   * stored value so that `<issuer>/.well-known/…` is plain concatenation, while
   * the ID token carries the identifier **verbatim** — so for such a provider
   * the configured value and `claims.iss` differ by exactly one character, and a
   * `!==` between them refuses every login of an organisation whose discovery just
   * succeeded (review finding). Discovery itself is unaffected:
   * `openid-client` compares `new URL(as.issuer).href` with `server.href`, which
   * is the normal form this deviation is here to make the application use too.
   */
  readonly trailingSlash?: boolean;
}

export interface FakeIdp {
  /** Discovery base — what goes into `tenant.oidc_issuer`. */
  readonly issuer: string;
  /**
   * Origin **without** the trailing slash {@link FakeIdpOptions.trailingSlash}
   * may add — where the browser really lands.
   *
   * Separate from {@link issuer} because the E2E run asserts on it: „das
   * Chromium steht beim Provider" is a statement about the address bar, and
   * `issuer` is the *name* the provider goes by, which those options make
   * deliberately different by one character.
   */
  readonly origin: string;
  /**
   * Plays the part of the browser at the authorization endpoint: takes the
   * `Location` the start route answered with and hands back an authorization
   * code, as the provider would after the person signed in.
   *
   * **Throws when the request carries no `code_challenge` with
   * `code_challenge_method=S256`** — this provider *requires* PKCE, exactly as
   * a client registered with „PKCE required" does. It used to accept the
   * omission and merely skip the verifier check at the token endpoint, which
   * meant PKCE could be deleted from `OidcProviderService.authorizationRequest`
   * without a single test noticing (review finding). It is a throw and
   * not an error response because a missing challenge is a defect on **our**
   * side of the flow: the suite should say so at the line that caused it.
   *
   * **Throws likewise for a foreign `client_id` or an unregistered
   * `redirect_uri`** — see {@link FakeIdpOptions.redirectUri}.
   */
  authorize(
    authorizationUrl: string,
    identity: FakeIdentity,
    deviation?: TokenDeviation,
  ): string;
  /** How many times the token endpoint was actually called. */
  readonly tokenRequests: () => number;
  close(): Promise<void>;
}

const JWT_LIFETIME_SECONDS = 300;
const MILLISECONDS_PER_SECOND = 1000;

export async function startFakeIdp(
  clientId: string,
  clientSecret: string,
  options: FakeIdpOptions,
): Promise<FakeIdp> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const kid = randomBytes(8).toString('hex');
  const pending = new Map<string, PendingAuthorization>();
  let tokenRequests = 0;
  /** Origin without a trailing slash — every endpoint is built from it. */
  let base = '';
  /** How the provider *names* itself; may differ from {@link base} by a slash. */
  let issuer = '';

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      response.statusCode = 500;
      response.end('{}');
    });
  });

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? '/', base);

    if (url.pathname === '/.well-known/openid-configuration') {
      json(response, {
        // The value the application compares against what it configured — a
        // discovery document whose `issuer` disagrees with the URL it came from
        // is refused by `openid-client`, which is the transport-level half of
        // ADR-0012 no. 2.
        issuer,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        jwks_uri: `${base}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: [
          'client_secret_post',
          'client_secret_basic',
        ],
        scopes_supported: ['openid', 'profile', 'email'],
      });
      return;
    }

    if (url.pathname === '/jwks') {
      const jwk = publicKey.export({ format: 'jwk' });
      json(response, { keys: [{ ...jwk, kid, use: 'sig', alg: 'RS256' }] });
      return;
    }

    if (url.pathname === '/token' && request.method === 'POST') {
      tokenRequests += 1;
      await respondToTokenRequest(request, response);
      return;
    }

    // The browser path: show, then accept.
    if (url.pathname === '/authorize' && request.method === 'GET') {
      html(response, 200, signInPage(url.search.replace(/^\?/u, '')));
      return;
    }
    if (url.pathname === '/authorize' && request.method === 'POST') {
      respondToSignIn(new URLSearchParams(await readBody(request)), response);
      return;
    }

    response.statusCode = 404;
    response.end('{}');
  }

  /**
   * „Who is sitting at the device" — the provider's sign-in form.
   *
   * The original authorization request travels along as a hidden field, so
   * that `POST /authorize` can restore it unchanged: `state`, `nonce` and
   * `code_challenge` belong to the application, and a provider that lost them
   * across the sign-in step would invent an assurance here that the
   * application would never get at all.
   *
   * `<label for>` is mandatory, not cosmetics: the suite grabs fields via their
   * caption (selectors from the user's point of view).
   */
  function signInPage(rawQuery: string): string {
    return [
      '<!doctype html><html lang="de"><head><meta charset="utf-8">',
      '<title>Test-Identitätsanbieter</title></head><body>',
      '<h1>Anmeldung beim Test-Identitätsanbieter</h1>',
      '<form method="post" action="/authorize">',
      `<input type="hidden" name="request" value="${escapeHtml(rawQuery)}">`,
      '<p><label for="sub">Kennung (sub)</label>',
      '<input id="sub" name="sub" type="text"></p>',
      '<p><label for="email">E-Mail-Adresse</label>',
      '<input id="email" name="email" type="email"></p>',
      '<p><button type="submit">Anmelden</button></p>',
      '</form></body></html>',
    ].join('');
  }

  /**
   * The submitted form: issue a code and redirect back to the `redirect_uri` —
   * with `state`, the way a provider redirects back.
   *
   * Errors of this path are **displayed**, not thrown: a throw would land in
   * the server's `catch` as an empty 500 and would be a white page in the
   * Playwright trace. The text names the defect, so that the red run names it.
   */
  function respondToSignIn(
    body: URLSearchParams,
    response: ServerResponse,
  ): void {
    const url = new URL(`/authorize?${body.get('request') ?? ''}`, base);
    const email = body.get('email') ?? '';
    let code: string;
    try {
      code = issueCode(url, {
        sub: body.get('sub') ?? '',
        ...(email === '' ? {} : { email, emailVerified: true }),
      });
    } catch (cause) {
      html(
        response,
        400,
        `<h1>Autorisierung abgelehnt</h1><p>${escapeHtml(String(cause))}</p>`,
      );
      return;
    }

    // The **registered** address, never the requested one. `issueCode` has
    // already refused every other, so this is not a second check but the
    // shape that makes a foreign address unreachable from here at all.
    const back = new URL(options.redirectUri);
    back.searchParams.set('code', code);
    const state = url.searchParams.get('state');
    if (state !== null) {
      back.searchParams.set('state', state);
    }
    response.statusCode = 302;
    response.setHeader('Location', back.href);
    response.end();
  }

  /**
   * The authorization code — **the one** place at which one comes into being.
   *
   * Both ways into this provider (programmatically out of `apps/api`'s suite,
   * via the browser out of `e2e/`) go through here, so that the registration
   * check and the PKCE requirement are not written twice and the browser path
   * does not accidentally loosen them. **The strictness of both surfaces comes
   * out of the same lines** — that is the reason this function exists.
   *
   * The order of the checks is not arbitrary: first the client, then its
   * `redirect_uri`, then PKCE. A real provider has to have checked the address
   * **before** anything comes into being that would go to it — otherwise the
   * refusal itself would already be the open redirector.
   */
  function issueCode(
    url: URL,
    identity: FakeIdentity,
    deviation: TokenDeviation = {},
  ): string {
    const requestedClientId = url.searchParams.get('client_id');
    if (requestedClientId !== clientId) {
      throw new Error(
        `unknown client: this provider is registered for ${clientId}, the authorization request carried client_id=${String(requestedClientId)}`,
      );
    }
    const requestedRedirectUri = url.searchParams.get('redirect_uri');
    if (requestedRedirectUri !== options.redirectUri) {
      // See {@link FakeIdpOptions.redirectUri}: a provider that redirects
      // wherever it is told is more permissive than the real one, and would
      // hide the open-redirector reproduction behind a green run.
      throw new Error(
        `unregistered redirect_uri: this client is registered for ${options.redirectUri}, the authorization request carried redirect_uri=${String(requestedRedirectUri)}`,
      );
    }
    const codeChallenge = url.searchParams.get('code_challenge');
    const method = url.searchParams.get('code_challenge_method');
    if (codeChallenge === null || method !== 'S256') {
      // See {@link FakeIdp.authorize}: this provider requires PKCE, and a
      // start route that stops sending the challenge has to be a failure
      // somewhere rather than a suite that goes on being green.
      throw new Error(
        `this provider requires PKCE: the authorization request carried code_challenge=${String(codeChallenge)} and code_challenge_method=${String(method)}`,
      );
    }
    const code = randomBytes(16).toString('base64url');
    pending.set(code, {
      nonce: url.searchParams.get('nonce') ?? undefined,
      codeChallenge,
      // The **registered** values, not the requested ones — they are equal by
      // the two checks above, and taking them from the registration is what
      // keeps them equal if somebody ever loosens a check.
      redirectUri: options.redirectUri,
      clientId,
      identity,
      deviation,
    });
    return code;
  }

  async function respondToTokenRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = new URLSearchParams(await readBody(request));
    const authorization = pending.get(body.get('code') ?? '');
    if (authorization === undefined) {
      error(response, 'invalid_grant');
      return;
    }
    // Single use, as a real provider treats an authorization code.
    pending.delete(body.get('code') ?? '');

    // Client authentication. `client_secret_post` is what the application
    // registers, so the secret arrives in the body — and a wrong one has to
    // fail, or the case (a foreign secret in an organisation's column)
    // could not be observed at all.
    if (
      body.get('client_id') !== clientId ||
      body.get('client_secret') !== clientSecret
    ) {
      error(response, 'invalid_client');
      return;
    }
    if (body.get('redirect_uri') !== authorization.redirectUri) {
      error(response, 'invalid_grant');
      return;
    }
    // PKCE, really checked and **unconditionally**: the challenge was required
    // at the authorization endpoint, so there is no „falls vorhanden" left here
    // — an absent `code_verifier` hashes to something that is not the stored
    // challenge and the grant is refused, which is what RFC 7636 §4.6 asks for.
    const verifier = body.get('code_verifier') ?? '';
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    if (challenge !== authorization.codeChallenge) {
      error(response, 'invalid_grant');
      return;
    }

    json(response, {
      access_token: randomBytes(24).toString('base64url'),
      token_type: 'Bearer',
      expires_in: JWT_LIFETIME_SECONDS,
      id_token: signIdToken(authorization),
    });
  }

  function signIdToken(authorization: PendingAuthorization): string {
    const now = Math.floor(Date.now() / MILLISECONDS_PER_SECOND);
    const claims: Record<string, unknown> = {
      iss: authorization.deviation.issuer ?? issuer,
      sub: authorization.identity.sub,
      aud: authorization.clientId,
      iat: now,
      exp: now + JWT_LIFETIME_SECONDS,
    };
    if (!(authorization.deviation.omitNonce ?? false)) {
      claims.nonce = authorization.deviation.nonce ?? authorization.nonce;
    }
    const identity = authorization.identity;
    if (identity.email !== undefined) {
      claims[identity.emailClaim ?? 'email'] = identity.email;
      // `undefined` means „nichts gesagt" and falls back to the standard name;
      // `null` means „diesen Claim gibt es in diesem Token nicht".
      const verifiedClaim =
        identity.emailVerifiedClaim === undefined
          ? 'email_verified'
          : identity.emailVerifiedClaim;
      if (verifiedClaim !== null) {
        claims[verifiedClaim] = identity.emailVerified ?? true;
      }
    }
    return jwt(claims, kid, privateKey);
  }

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${String(address.port)}`;
  issuer = (options.trailingSlash ?? false) ? `${base}/` : base;

  return {
    get issuer() {
      return issuer;
    },
    get origin() {
      return base;
    },
    authorize(authorizationUrl, identity, deviation = {}) {
      return issueCode(new URL(authorizationUrl), identity, deviation);
    },
    tokenRequests: () => tokenRequests,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
  };
}

function jwt(
  claims: Record<string, unknown>,
  kid: string,
  privateKey: KeyObject,
): string {
  const header = base64url({ alg: 'RS256', typ: 'JWT', kid });
  const payload = base64url(claims);
  const signature = createSign('RSA-SHA256')
    .update(`${header}.${payload}`)
    .sign(privateKey)
    .toString('base64url');
  return `${header}.${payload}.${signature}`;
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function json(response: ServerResponse, body: unknown): void {
  response.statusCode = 200;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(body));
}

function error(response: ServerResponse, code: string): void {
  response.statusCode = 400;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ error: code }));
}

function html(response: ServerResponse, status: number, body: string): void {
  response.statusCode = status;
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(body);
}

/**
 * Enough escaping for an attribute in double quotes.
 *
 * The one value that passes through here is the application's authorization
 * request — it contains `&` in any case and (with a `redirect_uri` carrying a
 * query) characters capable of `"` too. Without escaping the hidden field
 * breaks open and `state` would come back mangled: a failure that would look
 * like a finding about the application and would be none.
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
