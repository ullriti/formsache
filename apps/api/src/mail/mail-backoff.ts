/**
 * How long the queue waits before asking the mail server again.
 *
 * Deliberately a pure function of the attempt count and nothing else: it is the
 * one half of the retry story that can be proven without a database, and a test
 * that compares two *consecutive* gaps needs to be able to ask for both without
 * driving a worker twice („Falle 1").
 */

/** Wait after the first failed attempt. */
export const MAIL_BACKOFF_BASE_MS = 60_000;

/** Each further failure multiplies the wait by this. */
export const MAIL_BACKOFF_FACTOR = 2;

/**
 * Ceiling on one wait.
 *
 * With {@link MAIL_BACKOFF_BASE_MS}, the factor above and the five attempts of
 * `MAIL_MAX_ATTEMPTS` the cap is never reached — it exists so that raising
 * either constant cannot silently turn „retry later" into „retry next week".
 */
export const MAIL_BACKOFF_MAX_MS = 3_600_000;

/**
 * The wait after `failedAttempts` failures, in milliseconds.
 *
 * `failedAttempts` counts from 1: the value passed is the attempt that just
 * failed, so the first failure waits {@link MAIL_BACKOFF_BASE_MS}. Growing, not
 * constant — a queue that asks a dead mail server every fifteen seconds is a
 * queue that turns one outage into a reputation problem with the receiving
 * server.
 *
 * No jitter. It would be the right thing against a thundering herd of *many*
 * senders; here there is exactly one worker per installation, and a random
 * component would make the „die Abstände wachsen" proof here probabilistic
 * for no gain.
 */
export function mailBackoffMs(failedAttempts: number): number {
  const steps = Math.max(0, failedAttempts - 1);
  const delay = MAIL_BACKOFF_BASE_MS * MAIL_BACKOFF_FACTOR ** steps;
  return Math.min(delay, MAIL_BACKOFF_MAX_MS);
}
