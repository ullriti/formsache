/**
 * @file Everything the application needs beyond its modules — in one place, so
 * that the server and the tests configure the *same* application.
 *
 * This exists because of a review finding: `main.ts` disabled the
 * `X-Powered-By` header and the integration tests built their own application
 * that did not, so nothing covered the line. Two bootstrap paths that drift is
 * the failure mode a test suite is supposed to catch, not demonstrate — and
 * the global prefix had already been copied into both by hand.
 *
 * Whatever is added here later (a validation pipe, an exception filter, a
 * shutdown hook) is therefore under test by construction.
 */

import type { NestApplicationOptions } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { ApiEnv } from '@formsache/shared';

import { GLOBAL_API_PREFIX } from './app.module';
import { noStore, referrerPolicy } from './common/no-store';
import { securityHeaders } from './common/security-headers';
import { requestId } from './observability/request-id';

/**
 * Largest request body the API reads, in bytes.
 *
 * 100 KiB — body-parser's own default, restated here because CONTRIBUTING.md asks
 * for an explicit payload limit on the endpoints anyone may call, and a limit
 * that lives in a library default is a limit nobody decided. The value is
 * generous for what authentication accepts (a login, a tenant id) and stays
 * workable for the form definitions, which are JSON documents rather than
 * uploads. File uploads will not travel through this parser at all; they get
 * their own route, their own limit and their own whitelist.
 *
 * Exported so the test that proves the limit uses the number the server uses,
 * instead of a second copy that could quietly disagree.
 */
export const JSON_BODY_LIMIT_BYTES = 100 * 1024;

/**
 * **The two legal-text writes read a larger body than everything else**
 * (ADR-0028 no. 7) — these two addresses and no others, the third route that
 * carries a legal document included (see "the three things this deliberately
 * leaves alone" below).
 *
 * One `PUT` carries the *whole* legal-text document of an organisation (two
 * pages) or of the installation (three). Whoever fills every placeholder up to
 * `LEGAL_FILL_MAX` and additionally exhausts every own text up to
 * `LEGAL_TEXT_MAX` writes a body that is arithmetically past
 * {@link JSON_BODY_LIMIT_BYTES} — and gets a 413 from the parser, which sits in
 * front of every controller and therefore answers without a sentence that names
 * a field. That is the wrong answer to a legal text somebody spent an afternoon
 * on. The field limits themselves stay as they are; they are justified where
 * they stand (`legal.ts`).
 *
 * ## The calculation
 *
 * Counted out of `legal-templates.ts`, not estimated — the placeholders and
 * conditions each template actually declares. ⚠️ **The counts move with the
 * templates**, and the prose here does not; `legal-body-limit.spec.ts`
 * recomputes both worst cases from the templates and is what keeps the *limit*
 * honest. State of 2026-09-07:
 *
 * | | Seiten | Platzhalter | Bedingungen |
 * |---|---|---|---|
 * | `/tenant/legal` | 2 (`imprint` + `privacy`) | 24 | 11 |
 * | `/admin/system-settings/legal` | 2 (`imprint` + `privacy`) | 53 | 14 |
 *
 * The text budget of one write, in **UTF-16 code units**, because that is what
 * `z.string().max()` counts — every placeholder at `LEGAL_FILL_MAX`, every own
 * text at `LEGAL_TEXT_MAX`, and since Review-Runde 5 every page additionally
 * with a `link` at `LEGAL_LINK_MAX`:
 *
 * - organisation: 24 × 2 000 + 2 × 20 000 + 2 × 2 000 = **92 000**
 * - installation: 53 × 2 000 + 2 × 20 000 + 2 × 2 000 = **150 000**
 *
 * The limiter, however, counts **bytes**. The most expensive character is the
 * three-byte one that occupies a *single* code unit — CJK, but just as much the
 * typographic dash and the German quotation marks that a legal text sets
 * densely. An emoji costs four bytes but spends two units, so it is cheaper per
 * unit than it looks; that asymmetry is the whole gap, and ADR-0028 no. 7 shows
 * it for the neighbouring route. The `link` is the one field that cannot be
 * expensive: it has to be an address the write schema accepts, so it is ASCII
 * and spends one byte per unit. Measured on the payload the interface can
 * actually produce:
 *
 * - organisation: **268 889 B** (262.6 KiB)
 * - installation: **443 746 B** (433.3 KiB)
 *
 * Rounded up with air: 320 KiB and 768 KiB. The air is not a feeling either —
 * one further placeholder in a template costs 2 000 units, i.e. about 6 KiB, so
 * the organisation's limit carries nine more of them and the installation's
 * fifty-six. A whole further **page** fits into neither, and it is not supposed
 * to.
 *
 * ## The three things this deliberately leaves alone
 *
 * 1. **The third route that carries a legal document stays at 100 KiB.**
 *    `PUT /api/forms/:id/settings` holds the form-specific privacy notice, the
 *    same `legalDocumentSchema` — and filled in the same widest characters it,
 *    too, gets past the general limit (ADR-0028 no. 7 has the table). What was
 *    built there is *the message*, not a limit: `api-messages.ts` answers its
 *    413 with advice to shorten, and the field limit stands at the field
 *    (`maxLength`), so the honest path no longer leads into it. Raising it here
 *    as well would overturn that decision in passing — which is the one thing
 *    this comment must not do.
 * 2. **`fills` is an open map** (`legal.ts` says why), so a caller may invent
 *    keys no template knows. The bound on that is this limit itself and
 *    nothing else.
 * 3. **A client that escapes every character** as `\uXXXX` spends six bytes per
 *    unit instead of three. That and the previous point are payloads the
 *    interface cannot produce; sizing the limit for them would mean carrying a
 *    megabyte-sized parser for two routes. They get a 413, and that is the
 *    correct answer to them.
 *
 * ⚠️ **The parser runs before every guard**, so an unauthenticated caller can
 * make the server read up to 768 KiB on the installation's path before the 401
 * — seven times what it read before. Accepted, and named rather than left to be
 * discovered: the public routes, which anybody may call by design, all keep the
 * 100 KiB, and the one address that already reads megabytes without a session
 * is the public upload (`MAX_UPLOAD_BYTES`, its own limit and its own
 * whitelist). Two known paths at 768 KiB do not move that ceiling.
 */
export const TENANT_LEGAL_BODY_LIMIT_BYTES = 320 * 1024;

/** The installation's three pages — see {@link TENANT_LEGAL_BODY_LIMIT_BYTES}. */
export const SYSTEM_LEGAL_BODY_LIMIT_BYTES = 768 * 1024;

/**
 * Which path reads how much — **these two and nothing else**, everything
 * further stays at {@link JSON_BODY_LIMIT_BYTES}. That is the decision, not the
 * number: a limit raised globally would buy the legal texts their comfort with
 * the payload bound of every public fill-in route.
 *
 * Exported so the test uses the paths and numbers the server uses instead of a
 * second copy that could quietly disagree.
 */
export const LEGAL_WRITE_BODY_LIMITS: ReadonlyMap<string, number> = new Map([
  [`/${GLOBAL_API_PREFIX}/tenant/legal`, TENANT_LEGAL_BODY_LIMIT_BYTES],
  [
    `/${GLOBAL_API_PREFIX}/admin/system-settings/legal`,
    SYSTEM_LEGAL_BODY_LIMIT_BYTES,
  ],
]);

/**
 * The media type of a request, without its parameters and lower-cased —
 * `application/json; charset=utf-8` becomes `application/json`.
 *
 * Restated here rather than taken from `req.is()`, because the body parser
 * hands its `type` predicate a bare `IncomingMessage`, and `express` is not a
 * dependency of this package. The comparison below is exact, i.e. **stricter**
 * than body-parser's default matcher — which is the safe direction: a
 * request this function fails to recognise falls through to the ordinary
 * parser, never past one.
 */
function mediaTypeOf(header: string | undefined): string {
  return (header ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

/**
 * The path of a request without its query, one trailing slash and its case.
 *
 * Every one of the three is measured against the running server and not
 * assumed (`legal-body-limit.spec.ts` pins them): `/api/tenant/legal?x=1`,
 * `/api/tenant/legal/` and `/API/TENANT/LEGAL` all reach the controller, so a
 * limit that did not recognise them would answer 413 to a request the
 * application happily accepts.
 *
 * **Exactly one** trailing slash, and that is the difference to the obvious
 * `/\/+$/`: `/api/tenant/legal//` is a **404** — Express does not route it —
 * and a normalisation that swallowed the second slash would hand 768 KiB to an
 * address that does not exist.
 */
function pathOf(url: string | undefined): string {
  const path = (url ?? '').split('?')[0] ?? '';
  return path.replace(/\/$/u, '').toLowerCase();
}

/**
 * Options that have to be given at *construction* time — `main.ts` to
 * `NestFactory.create`, the integration tests to `createNestApplication`.
 *
 * They belong next to `configureApp` for the same reason `configureApp` exists
 * at all: two bootstraps that configure the application by hand drift apart,
 * and the one that drifts is never the one under test.
 */
export const APP_OPTIONS: NestApplicationOptions = {
  /**
   * **No body parser from Nest** — `configureApp` registers a JSON one below,
   * and nothing else. This is the fix for a login-CSRF finding, and the
   * reasoning is worth spelling out because the code looks like a mere
   * tidying-up otherwise.
   *
   * `NestFactory.create` registers `express.json` **and** `express.urlencoded`
   * by default. With the urlencoded parser in place, an attacker's page could
   * carry a hidden `<form method="POST" action="https://app/api/auth/login">`
   * with *their own* credentials, and the browser would submit it cross-site.
   * The session cookie is `SameSite=Lax`, which stops the browser from
   * **sending** our cookie on such a POST — but not from **storing** the one
   * that comes back: the login succeeds, `Set-Cookie` is honoured, and the next
   * top-level navigation to the app arrives authenticated as the attacker. The
   * victim then works inside the attacker's account and the attacker's Organisation,
   * and every form, every answer and every upload they create there belongs to
   * the attacker. Measured against the running server before this change: 200
   * plus `Set-Cookie: formsache_session=…`.
   *
   * An HTML form can only ever send `application/x-www-form-urlencoded`,
   * `multipart/form-data` or `text/plain` — it cannot be made to send
   * `application/json`. Parsing none of the three makes the route
   * grammatically unreachable for a form while leaving it fully usable for the
   * web client, whose `fetch` is same-origin.
   *
   * **This rests on one invariant: no CORS.** A cross-origin `fetch` *can* set
   * `Content-Type: application/json`, but only after a preflight the server has
   * to allow. Nothing here calls `enableCors`, so the preflight goes
   * unanswered and the browser never sends the request — and
   * `auth.spec.ts` pins exactly that, because switching CORS on (the reflex as
   * soon as the web app lives on another origin) would reopen this hole while
   * every content-type test stayed green. Should CORS ever be needed, the
   * session cookie needs a CSRF token first (ADR-0005).
   *
   * This is a floor, not the whole story: the CSRF token for the mutating admin
   * routes still follows in a later wave. It is the floor that happens to cover
   * the one route which has no session to hang a token on.
   */
  bodyParser: false,
};

export function configureApp(app: NestExpressApplication, env: ApiEnv): void {
  // `X-Powered-By: Express` names the framework on every answer, which is free
  // reconnaissance for anyone matching a server against a CVE list, and buys a
  // client nothing. Express sets it unless told otherwise.
  app.disable('x-powered-by');

  /**
   * Who `req.ip` is — and therefore which bucket the login rate limit counts
   * in (`auth/login-rate-limit.ts`, which named this as an open point).
   *
   * `0` is the default and means the peer of the TCP connection: always true,
   * never forgeable. Behind the front door in production it is also useless,
   * because that peer is the proxy for every user and they would share one
   * bucket — ten attempts a minute for the whole association.
   *
   * A positive value counts trusted hops **from the right**, so a caller who
   * prepends addresses to `X-Forwarded-For` only pushes their own invention
   * further left, away from the entry that is read. That is what makes the
   * setting safe to turn on, and it is why the number has to match the real
   * chain: `TRUST_PROXY_HOPS` too large starts reading entries the proxy never
   * wrote.
   */
  app.set('trust proxy', env.TRUST_PROXY_HOPS);

  // **First**, ahead of the parser: a parser failure calls `next(err)`, and
  // Express then skips every ordinary middleware behind it — the 413 and the
  // 400 would go out uncached-marked. `no-store.ts` carries the measurement.
  app.use(noStore);

  // Right at the front as well, and for the same reason: a request that fails
  // at the parser should have its id already — otherwise it is missing from exactly
  // the lines an operator is looking for.
  app.use(requestId);

  // Beside it and for the same reason it sits this far forward: the two public
  // addresses of this application carry their authorisation in the path, and a
  // `Referer` would hand it to whoever a participant clicks on next. See
  // `REFERRER_POLICY` for why `no-referrer` and why it is also set on the pages.
  app.use(referrerPolicy);

  // Right beside it and this far forward for the same reason: `nosniff` and
  // `frame-ancestors 'none'` belong on **every** answer, including the
  // error answers that arise further down (a review finding).
  app.use(securityHeaders);

  /**
   * **Ahead of the general parser and only for the two legal-text writes**
   * (see {@link LEGAL_WRITE_BODY_LIMITS}).
   *
   * Registered *before* it, because body-parser marks a request it has read and
   * every parser behind it then steps aside — so the first one that feels
   * addressed decides the limit. A `type` predicate rather than a mounted path:
   * `app.use('/path', …)` matches by prefix and would hand the larger body to
   * anything that ever grows underneath these two addresses.
   *
   * The predicate repeats **both** halves of what the general parser checks —
   * the media type and now also the method and the path. Only
   * `application/json` on a `PUT` of exactly these two addresses is read
   * larger; everything else falls through, and the next parser answers it with
   * the ordinary 100 KiB. That the content type is checked here as well is not
   * decoration: a predicate that accepted `text/plain` would make these two
   * routes reachable for an HTML form and reopen exactly the hole that
   * `APP_OPTIONS.bodyParser` closes.
   *
   * It sits behind `noStore` and `requestId` for the same reason the general
   * parser does: its 413 is an answer produced by `next(err)`, and Express
   * skips every ordinary middleware behind the failing one.
   */
  for (const [path, limit] of LEGAL_WRITE_BODY_LIMITS) {
    app.useBodyParser('json', {
      limit,
      type: (request) =>
        request.method === 'PUT' &&
        pathOf(request.url) === path &&
        mediaTypeOf(request.headers['content-type']) === 'application/json',
    });
  }

  // The general body parser of this application — see `APP_OPTIONS.bodyParser`
  // for why there is no second one beside it and the loop above for the two
  // routes that read more. `type` is left at body-parser's default,
  // `application/json`, so a `text/plain` body carrying valid JSON is not
  // sniffed into acceptance either.
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT_BYTES });

  // Same-origin cookies: the web app proxies `/api` to this server, and the
  // reverse proxy in production maps the same path without a rewrite. The
  // constant's own comment carries the reasoning.
  app.setGlobalPrefix(GLOBAL_API_PREFIX);
}
