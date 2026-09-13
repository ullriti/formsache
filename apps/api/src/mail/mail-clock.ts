import { Injectable } from '@nestjs/common';

/**
 * The one clock the mail queue reads — worker **and** purge.
 *
 * Injected rather than called, and that is a testing requirement rather than a
 * matter of taste. Two behaviours are about *time*: the backoff
 * has to show growing gaps between consecutive failures, and the purge
 * has to be proven at 89 and 91 days. Neither is expressible against
 * `Date.now()` without waiting — and a test that waits is a test that either
 * sleeps for a minute or, in the purge's case, for three months.
 *
 * **One clock, not two.** The purge computes its cut-off from this clock and
 * hands the database an explicit timestamp; the fixtures write explicit
 * `created_at` values derived from the same instant. Anchoring the rows on the
 * database clock (`now()`) while computing the boundary in Node is harmless at
 * 89 and 91 days and immediately wrong at the next tightened case — the two
 * clocks are different machines' opinions, and nothing forces them to agree.
 */
export abstract class MailClock {
  abstract now(): Date;
}

/** The clock the application runs on. */
@Injectable()
export class SystemMailClock extends MailClock {
  now(): Date {
    return new Date();
  }
}
