/**
 * A password hash that matches nothing — the counterweight against a timing
 * oracle in the login.
 *
 * Without it, the login is measurably faster for an unknown e-mail than for a
 * known one: Argon2id runs in the one case and is skipped in the other, and
 * with 19 MiB and two passes that difference is not subtle — it is tens of
 * milliseconds, visible across the network. An attacker would not need the
 * password to enumerate who has an account. The same applies to a user who
 * authenticates through OIDC and therefore has no `password_hash` at all.
 *
 * So the service verifies against *this* string whenever there is no stored
 * hash to verify against, and only then decides. The work is real, not
 * simulated — that is the point.
 *
 * This is not a secret. It is the Argon2id hash of 32 random bytes that were
 * discarded at the moment it was generated: nobody knows a pre-image, and
 * `verifyPassword` against it therefore returns false for every input. What
 * *does* matter is that its cost parameters stay identical to the ones
 * `hashPassword` produces — a cheaper dummy would put the timing difference
 * straight back. `dummy-password-hash.spec.ts` measures exactly that.
 */
export const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$L+utjGpF1iWFeN/gKfTRKg$O+nm5k5vQWhPFE80kYWfQPNuJMgPxx+mapx1HUuPoq4';
