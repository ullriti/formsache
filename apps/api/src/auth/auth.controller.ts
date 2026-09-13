import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import {
  emailChangeSchema,
  loginRequestSchema,
  passwordChangeSchema,
  profileUpdateSchema,
  type ApiEnv,
  type LoginRequest,
  type LoginResponse,
  type SessionRevocation,
  type SessionUser,
} from '@formsache/shared';

import { parseRequest } from '../common/parse-request';
import { API_ENV } from '../config/env';
import { AuthService, INVALID_CREDENTIALS_MESSAGE } from './auth.service';
import { buildClearedCsrfCookies, buildCsrfCookie } from './csrf';
import { CsrfExempt } from './csrf.guard';
import { CurrentAuth } from './current-auth.decorator';
import { ProfileService } from './profile.service';
import type {
  AuthContext,
  CookieRequest,
  CookieResponse,
} from './request-context';
import {
  buildClearedSessionCookies,
  buildSessionCookie,
  readSessionToken,
  usesSecureCookies,
} from './session-cookie';
import { SessionGuard } from './session.guard';
import { SessionService } from './session.service';

/**
 * `Set-Cookie` is the one header that legitimately appears more than once, and
 * Node takes a list for it. `CookieResponse` describes the single-value case
 * every other route needs; widening it here keeps that shape untouched.
 */
interface MultiValueCookieResponse extends CookieResponse {
  setHeader: (name: string, value: string | readonly string[]) => unknown;
}

/**
 * Transport for the three authentication endpoints (the requirements).
 *
 * Thin by rule: parse the request, call a service, set one
 * header. The one piece of logic that lives here is the cookie, because the
 * cookie *is* transport — everything about the session itself sits in
 * `SessionService`.
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    /** One's own profile — name and password of the signed-in person. */
    private readonly profile: ProfileService,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  /**
   * `Secure` behind TLS only. Locally the API is served over plain http, where
   * a `Secure` cookie is dropped by the browser without any error — the login
   * would appear to succeed and every following request would be anonymous.
   */
  private get secureCookies(): boolean {
    return usesSecureCookies(this.env);
  }

  /**
   * Rate-limited, because this is the one route here that anyone may call and
   * every call costs a full Argon2id verification — see `login-rate-limit.ts`
   * for the numbers, the reasoning and the two open points (reverse proxy,
   * shared NAT). The guard sits on the route rather than on `APP_GUARD`, so
   * that neither the tenant switcher nor the feature routes of the next wave
   * get throttled at a limit chosen for a password prompt.
   *
   * No `@Throttle()` next to it: the named throttler in `AuthModule` already
   * carries these numbers, and a route override that restates the same
   * constant changes nothing the guard does. Two spellings of one limit is how
   * the two later disagree.
   */
  @Post('login')
  // 200, not the 201 Nest gives a POST by default: nothing is created at a URL
  // the client could go to.
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  // No session exists yet, so there is nothing to forge with; the route is
  // protected instead by accepting `application/json` only (`app-setup.ts`).
  @CsrfExempt()
  async login(
    @Body() body: unknown,
    @Res({ passthrough: true }) response: MultiValueCookieResponse,
  ): Promise<LoginResponse> {
    const credentials = parseCredentials(body);
    const { user, token } = await this.auth.login(credentials);

    const maxAgeSeconds = this.sessions.ttlSeconds;
    response.setHeader('Set-Cookie', [
      buildSessionCookie(token, {
        maxAgeSeconds,
        secure: this.secureCookies,
      }),
      // The readable half of the pair. Its value is derived
      // from the session token, so the two live and die together — and a
      // client that has one always has the other.
      buildCsrfCookie(token, { maxAgeSeconds, secure: this.secureCookies }),
    ]);

    // The token is *not* in this body, and the contract has no field for it.
    return { user };
  }

  /**
   * Ends the session server-side and clears the cookie — **both** names of it.
   *
   * 204 whether or not a session was actually revoked. A logout that answered
   * differently for a valid and an invalid cookie would tell an attacker which
   * stolen token is still live.
   *
   * Both names are cleared even though this environment only ever *accepts*
   * one of them. A cookie a subdomain tossed in under the bare name is refused
   * behind TLS, but it stays in the browser and is presented on every request
   * until something removes it — and it becomes live again the moment the
   * deployment is moved back off TLS. Logging out is the natural place to get
   * rid of it, and clearing a name that is not there costs a header.
   */
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Req() request: CookieRequest,
    @Res({ passthrough: true }) response: MultiValueCookieResponse,
  ): Promise<void> {
    const token = readSessionToken(request.headers.cookie, this.secureCookies);
    if (token !== undefined) {
      await this.sessions.revoke(token);
    }
    // Cleared unconditionally: a cookie that survives a logout is a cookie the
    // browser will keep presenting.
    response.setHeader('Set-Cookie', [
      ...buildClearedSessionCookies(this.secureCookies),
      // The CSRF cookie is worthless without its session, but leaving it in
      // the browser would still present it on every later request — and it
      // would be *wrong* after the next login, which is a confusing failure to
      // debug for something a header can prevent.
      ...buildClearedCsrfCookies(this.secureCookies),
    ]);
  }

  /**
   * Who is signed in — and the first route behind `SessionGuard`.
   * Without a valid session this never reaches the handler: the guard answers
   * 401 rather than an empty user.
   *
   * Answers the `SessionUser` itself, not a `{ user }` envelope: the shared
   * contract describes `sessionUserSchema` as "the signed-in person, as
   * `GET /auth/me` reports them", and the web client parses the body with
   * `parseSessionUser`. The login wraps its answer because it is a different
   * kind of statement — "this attempt succeeded, and here is who it was".
   */
  @Get('me')
  @UseGuards(SessionGuard)
  me(@CurrentAuth() auth: AuthContext): SessionUser {
    return auth.user;
  }

  /**
   * Ends all **other** sessions of the signed-in person.
   *
   * The answer names the number, and that is the purpose: „3 Sitzungen beendet"
   * is the confirmation one reads while one stays signed in oneself.
   * At `0` the statement is just as important — then there was no second one,
   * and whoever suspects a break-in knows it now.
   *
   * No exception from the CSRF protection: this is a mutation of a signed-in
   * person, so exactly the case the global guard is there for. Somebody else's
   * page call could otherwise throw one out of one's own sessions —
   * annoying rather than dangerous, but without any reason to allow it.
   */
  @Post('sessions/revoke-others')
  @UseGuards(SessionGuard)
  async revokeOtherSessions(
    @CurrentAuth() auth: AuthContext,
  ): Promise<SessionRevocation> {
    const revoked = await this.sessions.revokeOthers(
      auth.user.id,
      auth.sessionId,
    );
    return { revoked };
  }

  /**
   * One's own name (finding 12).
   *
   * **The id comes from the session, never from the body.** That is the whole
   * difference between this route and `PUT /api/tenant/users/:userId`: there
   * somebody decides about another and the guard chain checks whether they may;
   * here there is nobody else — `profileUpdateSchema` has no field for
   * an id, and `@CurrentAuth` is the only source.
   *
   * Answers with the whole `SessionUser`, like the organisation switch: the
   * name stands in the header line, in the member list and in the profile, and a
   * client that patches up its cache by hand invents a
   * state that the server never confirmed.
   */
  @Put('profile')
  @UseGuards(SessionGuard)
  updateProfile(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<SessionUser> {
    const { name } = parseRequest(profileUpdateSchema, body);
    return this.profile.updateName(
      auth.user.id,
      auth.user.activeTenantId,
      name,
    );
  }

  /**
   * Changing one's own **e-mail address** — with a query for the password
   * (finding 8).
   *
   * A route of its own next to `PUT /profile` and not a second field in it:
   * the two actions have two prices. A name changes nothing that
   * lets somebody in; an address is the sign-in key and redirects
   * every „Passwort vergessen" link along with it. If both lay in one body,
   * either the name would have to pay for the password query as well or the
   * address would have to do without it — both wrong. The reasoning in full
   * length stands at `emailChangeSchema` and at `ProfileService.changeEmail`.
   *
   * Answers with the whole `SessionUser`, like the name change: the address
   * stands in the header line („Angemeldet als …") and in every member list.
   *
   * `POST` and not `PUT`, because this call carries a secret and triggers a
   * check — the same choice and the same reason as at
   * `POST /auth/password`, with whose throttling it also shares the occasion:
   * every call costs one Argon2id run.
   */
  @Post('email')
  // 200 instead of the default 201: no resource comes into being under
  // a new address.
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionGuard, ThrottlerGuard)
  changeEmail(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<SessionUser> {
    const change = parseRequest(emailChangeSchema, body);
    return this.profile.changeEmail(
      auth.user.id,
      auth.user.activeTenantId,
      change.currentPassword,
      change.email,
    );
  }

  /**
   * Changing one's own password — with a query for the old one (finding 12).
   *
   * 204, because there is nothing to report: the password is changed, one's
   * own session lives on (see `ProfileService`), and whoever additionally wants
   * to end the others presses the button next to it — that is the route
   * above, with its own number.
   *
   * Limited per origin, although a valid session stands in front of it: every
   * call costs **two** Argon2id runs (checking and setting), and a
   * repetition run on this route would be a way to occupy the thread pool of
   * the whole process — the same consideration as when signing in, only that
   * here an account has to stand behind it.
   */
  @Post('password')
  // 200, not the default 201: no resource comes into being here under
  // a new address. The same choice as when signing in, which for the same
  // reason carries a body and a 200.
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionGuard, ThrottlerGuard)
  async changePassword(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: MultiValueCookieResponse,
  ): Promise<SessionRevocation> {
    const change = parseRequest(passwordChangeSchema, body);
    const { token, revoked } = await this.profile.changePassword(
      auth.user.id,
      auth.user.activeTenantId,
      change.currentPassword,
      change.newPassword,
    );

    // **The fresh cookie is the reason why this route answers anything.**
    // The change ends every session of this person, one's own included;
    // without the replacement session the browser would fall back to the
    // sign-in and nobody would read the confirmation. The same two names as
    // when signing in, for the same reason — the readable half is derived from
    // the token and has to change with it, otherwise the next mutation fails
    // with a 403 that looks like a permission error.
    const maxAgeSeconds = this.sessions.ttlSeconds;
    response.setHeader('Set-Cookie', [
      buildSessionCookie(token, {
        maxAgeSeconds,
        secure: this.secureCookies,
      }),
      buildCsrfCookie(token, { maxAgeSeconds, secure: this.secureCookies }),
    ]);

    // The number **includes one's own, just replaced session** — it is
    // "this many sign-ins were ended", not "this many foreign devices".
    // The surface says so accordingly.
    return { revoked };
  }
}

/**
 * Parses the login body — parse, never cast.
 *
 * A validation failure answers 400 with a message that says nothing about the
 * account: "no such e-mail" and "password too long" have to look the same from
 * outside, so the text is the same one a failed login gets. Letting the
 * `ZodError` escape would do the opposite — Nest would turn it into a 500 with
 * the full issue list, including the submitted e-mail.
 */
function parseCredentials(body: unknown): LoginRequest {
  const parsed = loginRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestException(INVALID_CREDENTIALS_MESSAGE);
  }
  return parsed.data;
}
