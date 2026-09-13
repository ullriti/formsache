/**
 * The limits of the two setup routes (ADR-0022 no. 5).
 *
 * Both are reachable **without a session**, so the same rule applies to them as
 * to the login and the public fill-in routes: a route everybody may
 * call gets a counter. That the writing one of the two succeeds exactly
 * **once** in the life of an installation changes nothing about that
 * — it is not gone afterwards, it only answers 404, and a counter
 * protects precisely the time in which it is still open.
 *
 * Counting goes over {@link clientAddress} as everywhere in this application —
 * IPv4 unchanged, an IPv6 caller reduced to its /64 —, and which
 * address that is follows `TRUST_PROXY_HOPS` (`auth/login-rate-limit.ts` carries
 * this reasoning in full).
 */

/**
 * **Ten per minute and address** for `POST /api/setup` — the same number as the
 * login, and for the same reason.
 *
 * One call costs **a complete Argon2id computation** (19 MiB, two
 * passes) on *every* way, including the one that ends in 404: hashing happens before
 * the transaction opens, because a transaction should not hold CPU work —
 * and the check „gibt es schon einen Nutzer" belongs expressly **inside** this
 * transaction and not before it (ADR-0022 no. 3). A set-up installation
 * therefore pays as much for a stranger's call as for an invented
 * login attempt, and that is why the limit is the same.
 *
 * The alternative would have been a cheap pre-check before the hashing. It is
 * deliberately not built: it would have put a second check beside the one binding
 * check that looks just the same and guarantees nothing — and the place
 * at which somebody later leaves the *wrong* one of the two standing is exactly the
 * place at which two superadministrators come into being.
 *
 * Ten, not three: whoever mistypes during the setup (a short name with a
 * space, a password that is too short) gets a 400 and tries
 * again, and the office from which an installation is set up is
 * regularly **one** address.
 */
export const SETUP_RATE_LIMIT = {
  limit: 10,
  ttl: 60_000,
} as const;

/**
 * **A hundred and twenty per minute and address** for `GET /api/setup` — the
 * generous number, and it is the more important decision of this file.
 *
 * This route is queried exactly once by **every logged-out page call**,
 * for a lifetime: `App.tsx` asks it as soon as the session check
 * says „keine Sitzung", because the setup is the third state before the
 * login. It is thereby no route for the one setup day
 * but part of the normal way to the login page.
 *
 * Exactly for that reason the registered default (ten) would be wrong here: a
 * branch office or a mobile CGNAT is one address for many
 * people, and a counter that real usage tears is a counter that is raised in the
 * one hour in which it counts. 120 is the same number that
 * `PUBLIC_READ_RATE_LIMIT` carries from the same argument, and it stands far
 * above every legitimate usage: a human does not load the login page
 * twice per second.
 *
 * What a call costs makes the number bearable: **one `SELECT 1 FROM "user"
 * LIMIT 1`** — an index access that reads nothing that could get into an
 * answer, and whose cost does not grow with the data stock. The answer is
 * a boolean.
 */
export const SETUP_STATE_RATE_LIMIT = {
  limit: 120,
  ttl: 60_000,
} as const;
