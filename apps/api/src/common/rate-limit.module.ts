import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';

import { LOGIN_RATE_LIMIT } from '../auth/login-rate-limit';
import { clientAddress } from './client-address';

/**
 * The **one** place `ThrottlerModule.forRoot` is called.
 *
 * That is not a stylistic preference, it is the fix for a regression this
 * project actually produced: `ThrottlerModule` is `@Global()`, and a second
 * `forRoot` elsewhere **replaces** the first one's configuration. When the
 * public fill-in routes registered a throttler of their own, the
 * login's limit silently stopped existing — the module started fine, every
 * test about forms passed, and only the login's own rate-limit tests went red.
 * A limit that disappears without an error is exactly the failure a security
 * control must not have, so there is one registration and every route states
 * its numbers with `@Throttle`.
 *
 * **The registered default is the strict one** (the login's ten per minute).
 * A route that applies `ThrottlerGuard` without saying anything therefore
 * inherits the tighter limit and not the looser one — the safe direction for a
 * value somebody forgot to write down.
 *
 * `setHeaders: false` and what it costs: no `X-RateLimit-*` on the 401s, which
 * keeps two failed logins identical byte for byte without teaching the
 * comparison to ignore a header — but also **no
 * `Retry-After` on the 429**, because the library gates both on the same flag.
 * RFC 9110 recommends one there; if it is wanted it belongs on the 429 alone,
 * via a small guard of our own, not by switching the headers back on.
 */
@Module({
  imports: [
    ThrottlerModule.forRoot({
      throttlers: [{ ...LOGIN_RATE_LIMIT, setHeaders: false }],
      /**
       * **Which address every limit of this application counts** — the login,
       * the public read, the submission and, through its own tracker, the
       * password gate (`public/access-attempt-tracker.ts`).
       *
       * Stated here rather than left to the library's default, which keys on the
       * address verbatim. That is right for IPv4 and close to meaningless for
       * IPv6: a single residential line, VPS or mobile subscriber is routinely
       * handed a whole /64, so „ten a minute per address" becomes ten a minute
       * per *attempt* and the ceiling is throughput. {@link clientAddress}
       * reduces an IPv6 caller to that /64 and leaves IPv4 untouched.
       *
       * It narrows *who* is counted and changes nothing about the counters
       * themselves: still per address, never per form and never installation-wide
       * (bullet 5 — a cap a stranger's traffic can reach is a
       * cap a stranger can use).
       */
      getTracker: (req: Record<string, unknown>) => clientAddress(req),
      /**
       * One message for every throttled route, because `errorMessage` is a
       * root option and there is now more than one kind of caller behind it.
       *
       * Neutral wording on purpose: a participant who submits a Jahrestagung
       * registration too quickly must not be told they tried to *log in* too
       * often. It still says what happened and nothing about any account — a
       * 429 is per address, so it is no enumeration oracle either way.
       */
      errorMessage:
        'Zu viele Anfragen. Bitte in einer Minute erneut versuchen.',
    }),
  ],
  exports: [ThrottlerModule],
})
export class RateLimitModule {}
