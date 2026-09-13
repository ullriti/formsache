/**
 * Rate limit of `POST /api/auth/login` — the one endpoint of this module that
 * anyone on the internet may call.
 *
 * The limit is not primarily about guessing passwords, although it bounds that
 * too. It is about what a single request costs: the login verifies an Argon2id
 * hash with 19 MiB and two passes on *every* path, including the one where the
 * address does not exist at all — that is what `DUMMY_PASSWORD_HASH` is for
 * . `@node-rs/argon2` does that work on the libuv thread pool,
 * four threads by default and shared with file, DNS and crypto work of the
 * whole process. Without a limit, the measure that closes the enumeration
 * oracle becomes an amplifier: one HTTP request with an invented address buys
 * an attacker tens of milliseconds of a thread pool the rest of the server
 * needs. Ten a minute per caller keeps that bounded.
 *
 * **Ten per minute, per IP.** Someone mistyping their password needs two or
 * three attempts, and a shared office connection may carry a handful of people
 * logging in at once — ten leaves room for both without a support call. It
 * caps an anonymous caller at roughly half a second of Argon2id work per
 * minute, and online guessing at 14 400 attempts a day from one address, which
 * is slow enough that guessing stops being the cheap way in.
 *
 * The eleventh attempt does not merely fail: `blockDuration` defaults to `ttl`,
 * so it locks the caller out for a further minute from that moment. The block
 * does not extend itself while it lasts — attempts during it are refused
 * without adding to the count — so a caller who stops trying is let back in
 * after a minute rather than being locked out for as long as they keep
 * knocking. "Ten a minute" is therefore the sustained rate; the burst that
 * trips it costs sixty seconds.
 *
 * Which address is counted, and one open point:
 *
 * 1. **Behind a reverse proxy the peer is the proxy — so the hop is
 *    configured, not guessed.** `TRUST_PROXY_HOPS` (0 by default) says how
 *    many proxies in front of the API may report the caller in
 *    `X-Forwarded-For`; `configureApp` hands it to Express, and `req.ip` — the
 *    address this limiter counts — follows. Zero ignores the header
 *    completely, which is the only safe posture for an API that is reachable
 *    directly: the header is caller-controlled, and a limiter that believed it
 *    would hand every attacker a fresh bucket per request. The compose stack
 *    in production sets `1` for its nginx front door, which **replaces** the
 *    header instead of appending to it; without that setting every user of the
 *    installation would share the proxy's single bucket, and ten failed
 *    attempts would lock out the whole organisation. Both directions are covered by
 *    `test/auth/auth.spec.ts`.
 * 2. **A shared NAT shares a bucket.** An organisation's office or a mobile carrier's
 *    CGNAT presents one address for many people. Ten a minute is picked with
 *    that in mind; a stricter limit would need a second dimension (the
 *    submitted address, hashed) to stay usable.
 *
 * The counter lives in memory, per process: a second instance would double the
 * effective limit. That is acceptable while the deployment is a single
 * container; a shared store is a question for horizontal scaling, not yet.
 */

/**
 * Ten attempts per minute — `ttl` is in milliseconds.
 *
 * These numbers are the application's **registered default**
 * (`common/rate-limit.module.ts`), so the login route carries
 * `@UseGuards(ThrottlerGuard)` and no `@Throttle(...)`: a decorator there would
 * only repeat them, and a repeated constant is one that can disagree with
 * itself. Routes that need a different limit — the public fill-in route —
 * say so on the route.
 */
export const LOGIN_RATE_LIMIT = {
  limit: 10,
  ttl: 60_000,
} as const;
