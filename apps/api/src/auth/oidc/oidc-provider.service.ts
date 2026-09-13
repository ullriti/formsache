import { Injectable, Logger } from '@nestjs/common';
import {
  ClientSecretPost,
  Configuration,
  allowInsecureRequests,
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  discovery,
  randomPKCECodeVerifier,
  skipStateCheck,
  type ServerMetadata,
} from 'openid-client';

import type { OidcSignIn } from '../../tenant-admin/oidc-config.service';
import { OidcIdTokenRefusedError } from './oidc-diagnostics';
import type { OidcTransaction } from './oidc-transaction';

/**
 * Everything this application says to an identity provider — discovery, the
 * authorization request, the code exchange (ADR-0005).
 *
 * ## Why `openid-client` and not thirty lines of `fetch`
 *
 * The two hard parts of an OIDC login are not the redirects: they are verifying
 * an ID token's signature against a rotating JWKS, and getting every one of the
 * `iss`/`aud`/`exp`/`iat`/`nonce`/`at_hash` checks right at the same time. A
 * hand-written version of that is exactly the kind of code a security review
 * would refuse, and it is a **runtime** dependency — `openid-client` sits in
 * `dependencies` of `apps/api/package.json`, not in `devDependencies`, because
 * `pnpm deploy --prod` throws the latter away while `test`, `typecheck`, `lint`
 * and `build` all stay green (the trap `nodemailer`
 * nearly fell into).
 *
 * ## What this file keeps for itself
 *
 * The `state` check. It is made in {@link oidc-transaction.stateMatches} against
 * the transaction cookie, so `skipStateCheck` is handed to the library on
 * purpose: two implementations of one rule mean neither of them is *the* rule,
 * and the requirement's second reproduction asks for a check that goes red when it
 * is removed. The `nonce` is the other way round — it is a claim inside a signed
 * token, so the library validates it, and this file only supplies the expected
 * value.
 */
@Injectable()
export class OidcProviderService {
  private readonly logger = new Logger(OidcProviderService.name);

  /**
   * Discovered metadata per issuer, and **only** the metadata.
   *
   * The client secret is deliberately *not* in here. A cached
   * {@link Configuration} would be the obvious shape and would keep every
   * organisation's secret in a long-lived object; caching the public discovery document
   * instead and building a fresh `Configuration` per request costs one object
   * allocation and keeps the plaintext's lifetime bound to the request that
   * opened it.
   *
   * What the cache actually buys is not speed: without it, ten calls a minute to
   * the start route are ten requests to somebody else's identity provider, from
   * an address the caller chose. Bounded by the number of configured issuers.
   */
  private readonly discovered = new Map<string, CachedMetadata>();

  /**
   * Five minutes. Long enough that a login storm is one discovery request,
   * short enough that a provider rotating its endpoints is picked up without a
   * restart. The JWKS itself is **not** cached here — `openid-client` fetches
   * and re-fetches it per configuration, which is what makes a key rollover at
   * the provider work.
   */
  private static readonly METADATA_TTL_MS = 300_000;

  /**
   * Ten seconds for every request to a provider.
   *
   * A provider that hangs must not hang a request of ours: the callback holds a
   * connection open and the start route is reachable without a session, so an
   * unbounded wait is a way to occupy the server from outside.
   */
  private static readonly TIMEOUT_SECONDS = 10;

  /** Where the browser is sent to authenticate, plus the PKCE verifier. */
  async authorizationRequest(
    signIn: OidcSignIn,
    transaction: Pick<OidcTransaction, 'nonce'>,
    state: string,
    codeVerifier: string,
  ): Promise<URL> {
    const config = await this.configure(signIn);
    return buildAuthorizationUrl(config, {
      // Server-decided, from `PUBLIC_BASE_URL` — never from the request
      // (ADR-0012 no. 8). There is no parameter in any route of this package in
      // which a caller could send one, which is the third reproduction of the SSO login requirement.
      redirect_uri: signIn.redirectUri,
      scope: signIn.scopes.join(' '),
      response_type: 'code',
      state,
      nonce: transaction.nonce,
      code_challenge: await calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
    });
  }

  /** A fresh PKCE verifier, minted by the library that defines its grammar. */
  newCodeVerifier(): string {
    return randomPKCECodeVerifier();
  }

  /**
   * Redeems the authorization code and returns the **verified** ID token claims.
   *
   * `expectedNonce` is what makes a missing or wrong `nonce` a failure: with it
   * set, `openid-client` requires an ID token and requires the claim to match
   * exactly. `expectedState` is `skipStateCheck` because
   * {@link oidc-transaction.stateMatches} has already decided that question —
   * see the class comment.
   *
   * The URL handed in is rebuilt from the callback's own query string against
   * the **configured** redirect URI, so nothing a caller wrote decides where the
   * exchange believes it happened.
   */
  async exchange(
    signIn: OidcSignIn,
    transaction: OidcTransaction,
    callbackUrl: URL,
  ): Promise<VerifiedIdToken> {
    const config = await this.configure(signIn);
    const tokens = await authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: transaction.codeVerifier,
      expectedNonce: transaction.nonce,
      /*
       * The deprecation on `skipStateCheck` exists to make it stand out until
       * the implications are assessed, and they are: the `state` is checked in
       * `oidc-transaction.stateMatches` against the transaction cookie, before
       * this call and before any code is spent. Two checks of one rule would
       * leave neither of them *the* rule (see the class comment).
       */
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- assessed above
      expectedState: skipStateCheck,
    });

    const claims = tokens.claims();
    if (claims === undefined) {
      // **Named instead of blank** (a review finding). Until here this was a
      // `new Error(...)`, and the caller logs the *class* of an
      // error — so `Error`, indistinguishable from a timeout.
      // The operator saw „OIDC code exchange failed: Error" and thereby had
      // exactly as much in hand as without the line.
      throw new OidcIdTokenRefusedError('no-id-token');
    }

    // **The check ADR-0012 no. 2 makes load-bearing**, stated here rather than
    // left implicit in the library. `openid-client` already validates `iss`
    // against the metadata it discovered, and that metadata came from this
    // issuer — so this is the second of two independent reasons rather than the
    // only one. It is written out because the account key is built from
    // `signIn.issuer` a moment later, and „der Wert, aus dem der Schlüssel
    // entsteht, ist geprüft" must be readable in this file, not inferred from
    // another package's changelog.
    if (!sameIssuer(claims.iss, signIn.issuer)) {
      // Named, for the same reason as above — and here it weighs more heavily:
      // this is the refusal on which the account key of ADR-0012 no. 2
      // rests. It has to be readable in the log as what it is. The
      // *reported* issuer does not go into it: it is foreign input, and the
      // configured one stands in the caller's line anyway.
      throw new OidcIdTokenRefusedError('issuer-mismatch');
    }

    // Normal operation, on `debug`: whoever is closing in on a failing login
    // must be able to see *how far* it got — a token
    // that arrives here is signature-checked, and the cause then lies behind
    // the provider, not with it. No subject, no token, no address.
    this.logger.debug(
      `OIDC code exchange with issuer ${signIn.issuer} succeeded; ID token verified.`,
    );
    return {
      issuer: signIn.issuer,
      subject: claims.sub,
      verifiedEmail: this.verifiedEmailOf(claims, signIn),
    };
  }

  /**
   * The verified address of an ID token, or `null` — **and the log line that
   * says which of the two claims was the problem** .
   *
   * The caller collapses every refusal into „kein Konto" (ADR-0012 no. 3
   * step 3), so nothing below is observable from outside. But an operator who
   * has just entered `upn` into the field has to be able to tell „der Claim
   * heißt anders" from „der Anbieter sagt nicht, dass die Adresse geprüft ist",
   * and the two are indistinguishable in the browser on purpose. Only the
   * **configured claim names** go into the line — they are configuration, not
   * personal data; the address never does.
   */
  private verifiedEmailOf(
    claims: Record<string, unknown>,
    signIn: OidcSignIn,
  ): string | null {
    const outcome = readVerifiedEmail(
      claims,
      signIn.emailClaim,
      signIn.emailVerifiedClaim,
    );
    switch (outcome.kind) {
      case 'verified':
        return outcome.email;
      case 'no-address':
        this.logger.warn(
          `ID token of issuer ${signIn.issuer} carries no usable address in claim "${signIn.emailClaim}".`,
        );
        return null;
      case 'unverified':
        this.logger.warn(
          `ID token of issuer ${signIn.issuer} was refused: claim "${signIn.emailVerifiedClaim}" is not true.`,
        );
        return null;
    }
  }

  /**
   * Discovery plus client credentials — the `Configuration` one request uses.
   *
   * `discovery()` fails when the document's own `issuer` differs from the URL it
   * was fetched from; that is the check that makes „der Issuer ist der
   * konfigurierte" true at the transport level, and it is the reason the
   * metadata may be cached under the configured issuer at all.
   */
  private async configure(signIn: OidcSignIn): Promise<Configuration> {
    const metadata = await this.serverMetadata(signIn.issuer);
    const config = new Configuration(
      metadata,
      signIn.clientId,
      // The secret travels in the POST body (`client_secret_post`), which is
      // what the vast majority of providers register by default. It never
      // appears in a URL, and therefore never in a log line of anything in
      // between.
      { client_secret: signIn.clientSecret },
      ClientSecretPost(signIn.clientSecret),
    );
    config.timeout = OidcProviderService.TIMEOUT_SECONDS;
    if (isLoopbackHttp(signIn.issuer)) {
      /*
       * Only for a `http://localhost` issuer, which
       * `tenant-admin/oidc-issuer.ts` is the sole gate for — a routable host
       * can never reach this line. Without it a local test IdP is unusable, and
       * the pressure to relax the *stored* issuer rule would land somewhere
       * worse. That bound is the assessment the deprecation asks for.
       */
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- assessed above
      allowInsecureRequests(config);
    }
    return config;
  }

  /**
   * How many issuers the cache may hold.
   *
   * „Bounded by the number of configured issuers" is true of *current* ones, and
   * an issuer that is edited leaves its predecessor behind — so over a long
   * uptime the map is bounded by the number of edits rather than by the number
   * of Organisationen. Nobody outside can drive that (the field is behind
   * `can_manage_settings` **and** `can_manage_users`, ADR-0012 no. 6), which is
   * why this is a housekeeping cap rather than a defence; expired entries are
   * dropped first, and only then the oldest.
   */
  private static readonly METADATA_CACHE_MAX = 256;

  private async serverMetadata(issuer: string): Promise<ServerMetadata> {
    const cached = this.discovered.get(issuer);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return cached.metadata;
    }
    this.evictStaleMetadata();

    const options = isLoopbackHttp(issuer)
      ? {
          /*
           * See `configure`: bounded to a loopback issuer, which is the one
           * case `oidc-issuer.ts` tolerates plain http for. Needed a second
           * time because the discovery request itself happens before a
           * `Configuration` exists to relax.
           */
          // eslint-disable-next-line @typescript-eslint/no-deprecated -- assessed above
          execute: [allowInsecureRequests],
          timeout: OidcProviderService.TIMEOUT_SECONDS,
        }
      : { timeout: OidcProviderService.TIMEOUT_SECONDS };
    // A throwaway client id: `discovery` wants one, and nothing about the
    // *document* depends on it. The real client id and secret go into the
    // `Configuration` built above, per request.
    const config = await discovery(
      new URL(issuer),
      'discovery',
      undefined,
      undefined,
      options,
    );
    const metadata = config.serverMetadata();

    this.discovered.set(issuer, {
      metadata,
      expiresAt: Date.now() + OidcProviderService.METADATA_TTL_MS,
    });
    this.logger.log(`Discovered OIDC metadata of issuer ${issuer}.`);
    return metadata;
  }

  /** Drops what has expired, and — only if that was not enough — the oldest. */
  private evictStaleMetadata(): void {
    if (this.discovered.size < OidcProviderService.METADATA_CACHE_MAX) {
      return;
    }
    const now = Date.now();
    for (const [issuer, entry] of this.discovered) {
      if (entry.expiresAt <= now) {
        this.discovered.delete(issuer);
      }
    }
    // `Map` iterates in insertion order, so the first key is the oldest.
    while (this.discovered.size >= OidcProviderService.METADATA_CACHE_MAX) {
      const [oldest] = this.discovered.keys();
      if (oldest === undefined) {
        return;
      }
      this.discovered.delete(oldest);
    }
  }
}

/** What a successful exchange establishes — nothing that is not verified. */
export interface VerifiedIdToken {
  /** The **configured** issuer, after the token's `iss` was checked against it. */
  readonly issuer: string;
  readonly subject: string;
  /**
   * The address claim of this organisation, lower-cased — and `null` unless the same
   * token also said `true` in this organisation's verification claim.
   *
   * **Both names come from the organisation's configuration** , with `email`
   * and `email_verified` as the shipped defaults. Only ADR-0012 no. 3 step 2
   * reads this, and that step hands out an identity, so an address the provider
   * has not vouched for must not reach it: a provider that omits the
   * verification claim is treated as not having verified anything — absence is
   * not consent.
   *
   * **Unless the organisation emptied that field.** Then there is no counter-check and
   * this value is the provider's word alone; {@link readVerifiedEmail} states
   * what that costs and what still bounds it.
   */
  readonly verifiedEmail: string | null;
}

interface CachedMetadata {
  readonly metadata: ServerMetadata;
  readonly expiresAt: number;
}

/** Why an ID token did or did not yield a usable address — see below. */
type EmailClaimOutcome =
  | { readonly kind: 'verified'; readonly email: string }
  | { readonly kind: 'no-address' }
  | { readonly kind: 'unverified' };

/**
 * The verified address of an ID token, under the **claim names this organisation
 * configured** .
 *
 * Read out of the **signed** token only. A `userinfo` round trip would find the
 * claim at more providers, and it was left out deliberately: the redemption of
 * an invitation is the one step of this flow that turns a stranger into a member
 * of an organisation, and basing it on a single signed artefact rather than on a second
 * HTTP response keeps the trust chain to one thing. Configurable claim **names**
 * change nothing about that: the names decide which keys of the same signed
 * object are read, never where the object comes from.
 *
 * ## The empty verification claim
 *
 * `verifiedClaim === ''` is an organisation that has switched the counter-check off. The
 * address then counts on the provider's word alone — „Abwesenheit ist keine
 * Zustimmung" no longer holds for it, and whoever runs that organisation's
 * Anmeldedienst can pull an invitation **of that organisation** onto a foreign address.
 * It is bounded by the conditions `OidcIdentityService.resolve` keeps in its
 * `where` (the issuer stamp, a membership of the inviting Organisation, `oidcSubject IS
 * NULL`, `passwordHash IS NULL`), and by nothing else. The field that offers the
 * choice says so.
 *
 * ## `true`, and not „truthy"
 *
 * The verification claim has to be the boolean `true` — exactly as it was when
 * the name was hard-coded. A provider that sends the string `"true"` is *not*
 * accepted, and widening that here would change the behaviour of every organisation on
 * the defaults rather than only of the one that configured something unusual.
 * Such an organisation empties the field, which is the visible, decided form of the same
 * thing.
 *
 * ## Own properties only
 *
 * `Object.hasOwn` before the read, because the claim name comes out of a column:
 * `constructor`, `toString` and `__proto__` are keys every object answers to,
 * and none of them is a claim. They would fail the `typeof === 'string'` test
 * below anyway — this is the check that does not depend on that coincidence.
 */
function readVerifiedEmail(
  claims: Record<string, unknown>,
  emailClaim: string,
  verifiedClaim: string,
): EmailClaimOutcome {
  const email = ownClaim(claims, emailClaim);
  if (typeof email !== 'string') {
    return { kind: 'no-address' };
  }
  const normalised = email.trim().toLowerCase();
  if (normalised === '') {
    return { kind: 'no-address' };
  }
  if (verifiedClaim !== '' && ownClaim(claims, verifiedClaim) !== true) {
    return { kind: 'unverified' };
  }
  return { kind: 'verified', email: normalised };
}

/** One top-level claim of the token, or `undefined` — never an inherited key. */
function ownClaim(claims: Record<string, unknown>, name: string): unknown {
  return Object.hasOwn(claims, name) ? claims[name] : undefined;
}

/** Whether an already-validated issuer is the local-http exception. */
function isLoopbackHttp(issuer: string): boolean {
  return new URL(issuer).protocol === 'http:';
}

/**
 * Whether an ID token's `iss` and an organisation's configured issuer name the same
 * provider — **both sides normalised, and unequal whenever that is in doubt.**
 *
 * The two values come from different places and are not spelled the same way.
 * `claims.iss` is the literal document identifier the provider mints;
 * `signIn.issuer` went through `acceptableIssuer`, which **strips trailing
 * slashes** so that `<issuer>/.well-known/…` is plain concatenation. For a
 * provider with a path issuer (`https://kc.example.org/realms/demo`) the two
 * agree by accident. For one whose issuer is a bare **origin** — Auth0, Okta,
 * Entra, and anything else that answers `https://tenant.eu.auth0.com/` — they
 * never do: the token says `https://tenant.eu.auth0.com/`, the column says
 * `https://tenant.eu.auth0.com`, and a `!==` refuses **every** login of an organisation
 * whose discovery just succeeded. Fail closed, and therefore silent — but the
 * pressure to repair it lands on the one comparison the whole account key of
 * ADR-0012 no. 2 rests on, and that is the wrong place to be under pressure.
 *
 * `new URL(x).href` is the normal form: it appends the empty path of an origin
 * and leaves everything else alone. Deliberately **not** `acceptableIssuer` on
 * the token side — that one *removes* a trailing slash, so it would equate
 * `…/demo` with `…/demo/` in the other direction as well, and a token claim is
 * foreign input that should be brought to a normal form, not repaired.
 *
 * A claim that is not a string, or not a URL at all, is **not equal**: the
 * refusal is the answer, never an exception carried out of the exchange.
 */
function sameIssuer(claimed: unknown, configured: string): boolean {
  if (typeof claimed !== 'string') {
    return false;
  }
  const left = URL.parse(claimed);
  const right = URL.parse(configured);
  return left !== null && right !== null && left.href === right.href;
}
