import {
  Controller,
  Get,
  HttpStatus,
  Inject,
  Logger,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import {
  OIDC_OUTCOME_PARAM,
  type ApiEnv,
  type OidcOutcome,
  type OidcProvider,
} from '@formsache/shared';

import { PublicUrlService } from '../../common/public-url/public-url.service';
import { API_ENV } from '../../config/env';
import type { CookieRequest, CookieResponse } from '../request-context';
import { buildSessionCookie, usesSecureCookies } from '../session-cookie';
import { buildCsrfCookie } from '../csrf';
import { SessionService } from '../session.service';
import { OidcLoginService } from './oidc-login.service';
import {
  buildClearedOidcCookies,
  buildOidcTransactionCookie,
  oidcCookieName,
  readOidcTransaction,
} from './oidc-transaction';

/**
 * The three routes of the OIDC login.
 *
 * **All three are reachable without a session** — that is what a login is — so
 * all three carry their own rate limit and none of them answers a question about
 * an organisation that a stranger has no business asking, with one exception
 * named at {@link providers}. `GET` throughout, which is not
 * a style choice: the provider sends the browser back with a top-level
 * navigation, and a top-level navigation is a `GET`. The global `CsrfGuard`
 * therefore lets them pass on the safe-method rule and **no `@CsrfExempt` is
 * needed**; the exemption list stays exactly as long as it was, and the
 * cross-site protection of the flow is the transaction cookie plus `state`, not
 * a header (see `oidc-transaction.ts`).
 *
 * Thin by rule: parse, call one service, set one header. The
 * cookies live here because a cookie *is* transport.
 */
@Controller('auth/oidc')
@UseGuards(ThrottlerGuard)
export class OidcLoginController {
  /**
   * **The one decision this controller takes entirely on its own** is
   * also the one it has to log: whether a transaction cookie was
   * present at all. A cookie *is* transport, so it lives here
   * — and therefore the log line about it lives here too. Everything else stays with the
   * service.
   */
  private readonly logger = new Logger(OidcLoginController.name);

  constructor(
    private readonly login: OidcLoginService,
    private readonly sessions: SessionService,
    private readonly publicUrl: PublicUrlService,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  private get secureCookies(): boolean {
    return usesSecureCookies(this.env);
  }

  /**
   * Which organisations offer SSO — the „bietet den Weg an"-half of the SSO login requirement.
   *
   * Thirty a minute per address: a login page may reload, and the answer is a
   * short list of names that are public anyway (the Dachorganisation's Mitgliedsbünde). What
   * it deliberately does **not** carry is the issuer, the client id or the
   * redirect URI of any Organisation.
   *
   * The numbers are stated on the route with `@Throttle` rather than by a second
   * `ThrottlerModule.forRoot`: there is exactly **one** `forRoot` in this
   * application (`common/rate-limit.module.ts`), and a second one replaces it
   * silently — the regression that removed the login's rate limit.
   *
   * **Reads `request.host`** to set `OidcProvider.atThisAddress`, so a chooser
   * can pre-select the organisation the browser's address belongs to — the one
   * exception to "answers no question a stranger has no business asking"
   * above. Safe because the value only moves a pre-selection the person
   * signing in sees and may change: forging it reaches nothing more than
   * opening the chooser and picking that entry would. It is `request.host`,
   * not a raw header, so `TRUST_PROXY_HOPS` still governs how far a forwarded
   * value counts (see {@link HostRequest}). Nothing derived from it may decide
   * a redirect, a session or access — that stays {@link callback}'s rule.
   */
  @Get('providers')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  providers(@Req() request: HostRequest): Promise<OidcProvider[]> {
    return this.login.offers(request.host ?? null);
  }

  /**
   * Starts a login at one organisation and redirects to its provider.
   *
   * An organisation that does not offer SSO — unknown, switched off, half configured, or
   * with a secret that does not open — gets the **same** answer as any other: a
   * redirect back to the login page with `fehlgeschlagen`. That is the SSO login
   * requirement's „abwesend *und* verschlossen": the button being absent is the offer list's
   * doing, and this route refuses the direct call regardless of what any surface
   * showed.
   *
   * Ten a minute, the login's own number: each call may cost a discovery request
   * to somebody else's provider.
   */
  @Get('start/:tenantId')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async start(
    @Param('tenantId') tenantId: string,
    @Res({ passthrough: true }) response: RedirectingResponse,
  ): Promise<void> {
    const started = await this.login.start(tenantId);
    if (started === null) {
      this.redirect(response, await this.outcomeUrl('fehlgeschlagen'), []);
      return;
    }

    this.redirect(response, started.authorizationUrl.href, [
      buildOidcTransactionCookie(started.transaction, {
        secure: this.secureCookies,
      }),
    ]);
  }

  /**
   * Where the provider sends the browser back — `OIDC_CALLBACK_PATH`, spelled in
   * `public-url.service.ts` and mounted here from the two segments it is made
   * of, so the route and the URI shown in the tenant administration cannot drift.
   *
   * **No Organisation in the path and no `redirect_uri` in the query.** Which Organisation a
   * callback belongs to travels in the transaction cookie, whose `state` this
   * route checks anyway; where the provider redirects to is decided by the
   * server from `PUBLIC_BASE_URL`. Both are the SSO login requirement's third reproduction, and the
   * reason there is no parameter here to take either from.
   *
   * Twenty a minute: a person who mistypes a password at their provider comes
   * back here more than once, and every call costs a token request.
   */
  @Get('callback')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async callback(
    @Query('state') state: string | undefined,
    @Req() request: CallbackRequest,
    @Res({ passthrough: true }) response: RedirectingResponse,
  ): Promise<void> {
    // Cleared on **every** path below, successful or not: a transaction is
    // single-use, and one left in the browser is one that can be replayed
    // against a second authorization code.
    const cleared = buildClearedOidcCookies(this.secureCookies);

    const transaction = readOidcTransaction(
      request.headers.cookie,
      this.secureCookies,
    );
    if (transaction === undefined) {
      // **The branch an operator is most likely to hit while setting things up
      // and sees worst** (a review finding). `readOidcTransaction`
      // answers four different situations with the same `undefined` — no
      // cookie, a cookie under the *other* name, one that does not parse,
      // an expired one —, and the caller turned that into a
      // `fehlgeschlagen` without writing a line.
      //
      // The line names the **expected name**. That is a function of
      // `secure` (`__Host-` only behind TLS), and it is exactly what an
      // installation fails on that is delivered with `NODE_ENV=production` over
      // plain http: the browser does not accept a `Secure` cookie there in the
      // first place, every login ends here, and nothing says so. The *content*
      // of a presented cookie does not go into it — it is foreign input,
      // and which of the four situations it was is nothing the caller is meant
      // to learn (`oidc-transaction.ts`).
      //
      // `debug`, not `warn`: the normal case is a callback that came too late
      // or twice — the route is reachable without a session, and a stranger
      // must not be able to force lines an operator has to read.
      this.logger.debug(
        `OIDC callback without a usable transaction cookie (expected ${oidcCookieName(this.secureCookies)}; absent, malformed or expired).`,
      );
      this.redirect(response, await this.outcomeUrl('fehlgeschlagen'), cleared);
      return;
    }

    const finished = await this.login.finish(
      transaction,
      typeof state === 'string' ? state : undefined,
      // Rebuilt from the **configured** callback address plus this request's own
      // query string. Nothing a caller wrote decides where the exchange believes
      // it happened, and `Host`/`X-Forwarded-Host` — which a caller does
      // write — never enter into it.
      await this.callbackUrl(request),
    );

    if (finished.outcome !== 'angemeldet') {
      this.redirect(response, await this.outcomeUrl(finished.outcome), cleared);
      return;
    }

    const maxAgeSeconds = this.sessions.ttlSeconds;
    this.redirect(response, await this.publicUrl.appUrl('/'), [
      ...cleared,
      buildSessionCookie(finished.sessionToken, {
        maxAgeSeconds,
        secure: this.secureCookies,
      }),
      // The readable half of the pair, exactly as the local login sets it
      // : a client that holds a session always holds the CSRF
      // cookie derived from it, or every mutating request afterwards is a 403.
      buildCsrfCookie(finished.sessionToken, {
        maxAgeSeconds,
        secure: this.secureCookies,
      }),
    ]);
  }

  /** The login page, with the closed-set code that says what happened. */
  private outcomeUrl(outcome: OidcOutcome): Promise<string> {
    return this.publicUrl.appUrl(
      `/?${OIDC_OUTCOME_PARAM}=${encodeURIComponent(outcome)}`,
    );
  }

  /**
   * The address of *this* request as the token exchange must see it.
   *
   * Built from the configured callback URI and the raw query string, never from
   * the request's own `Host`: that header is written by the caller, and letting
   * it decide would put a caller-chosen origin into the one comparison the
   * exchange makes about where the code came back to.
   */
  private async callbackUrl(request: CallbackRequest): Promise<URL> {
    const url = new URL(await this.publicUrl.oidcCallbackUrl());
    const raw = request.url ?? '';
    const separator = raw.indexOf('?');
    if (separator !== -1) {
      url.search = raw.slice(separator + 1);
    }
    return url;
  }

  /**
   * 302 with a `Location` — written out rather than taken from `@Redirect()`,
   * because the cookies have to go on the *same* response and the decorator
   * fixes the target at decoration time.
   */
  private redirect(
    response: RedirectingResponse,
    location: string,
    cookies: readonly string[],
  ): void {
    if (cookies.length > 0) {
      response.setHeader('Set-Cookie', [...cookies]);
    }
    response.setHeader('Location', location);
    response.status(HttpStatus.FOUND);
  }
}

/**
 * The transport surface this controller touches, in the structural style the
 * auth module uses throughout (`request-context.ts`): no Express types, so the
 * seam stays visible. `Set-Cookie` legitimately appears more than once, so the
 * header setter takes a list as well.
 */
interface RedirectingResponse extends CookieResponse {
  setHeader: (name: string, value: string | readonly string[]) => unknown;
  status: (code: number) => unknown;
}

/**
 * `host`, not a raw header: Express builds it applying `trust proxy`
 * (`app-setup.ts`, from `TRUST_PROXY_HOPS`), so a caller-written
 * `X-Forwarded-Host` counts only as far as the operator declared a proxy
 * chain — the same question `client-address.ts` already settles, not a
 * second one asked here.
 */
interface HostRequest {
  readonly host?: string | undefined;
}

/**
 * The callback additionally needs the **query string of this request**, and
 * nothing else of it.
 *
 * `url` on a Node request is the path with its query — origin-relative by
 * definition, so it cannot carry a host. That is exactly the property wanted
 * here: {@link OidcLoginController.callbackUrl} puts the query onto the
 * *configured* callback address, and there is no member on this interface
 * through which a caller-written `Host` could reach it.
 */
interface CallbackRequest extends CookieRequest {
  readonly url?: string | undefined;
}
