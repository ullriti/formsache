/**
 * How long any part of one delivery attempt may take — **in one place, because
 * the numbers only mean something in relation to each other** (* ADR-0004).
 *
 * ## What went wrong while these lived in two files and one library
 *
 * The worker claims a row with `FOR UPDATE SKIP LOCKED` and holds that lock
 * across the SMTP conversation; the status is written inside the **same**
 * transaction, which is what makes „attempts wurde erhöht" and „die Mail wurde
 * versucht" the same event. Nothing enforced that the conversation ends before
 * the transaction budget does. `nodemailer`'s own defaults are a greeting
 * timeout of 30 s, a connection timeout of 120 s and a socket timeout of
 * **600 s** — the last one five times the transaction budget below.
 *
 * A mail server that accepts the connection and then stops answering (a
 * greylisting relay at the opening of a Jahrestagung registration is enough) got
 * this: Prisma tore the interactive transaction down after 120 s and released
 * the row lock, `sendMail` came back afterwards, and `markRetry` ran into a
 * closed transaction and threw. The row was left exactly as it was found —
 * `queued`, `attempts = 0`, no `next_attempt_at` — so it was due again
 * immediately and the next tick sent it again. Fifteen seconds later. Forever:
 * `MAIL_MAX_ATTEMPTS` was never reached because no attempt was ever recorded.
 *
 * That is not the at-least-once duplicate ADR-0004 accepts (a crash between
 * send and status write). It is an unbounded loop aimed at the installation's
 * own sender domain, i.e. the most expensive deliverability failure there is.
 *
 * ## The invariant
 *
 * `sendMs` **must** stay clearly below `claimTransactionMs`, and the transport
 * timeouts below `sendMs`. Then the status write always happens inside a
 * transaction that is still open, and the attempt is always recorded. The
 * ordering is asserted in `mail-timeouts.spec.ts` rather than only stated here.
 *
 * `sendMs` is a backstop and not the primary mechanism: the transport timeouts
 * do the work, and this one exists so the promise „der Statusschreibvorgang
 * passiert innerhalb der Transaktion" does not hang on a library default that a
 * dependency bump could change.
 */
export interface MailTimeouts {
  /** TCP connect. */
  readonly connectionMs: number;
  /** Waiting for the server's `220` greeting. */
  readonly greetingMs: number;
  /** Silence on an established connection — the `DATA` stall. */
  readonly socketMs: number;
  /** The worker's own deadline around one `transport.send()`. */
  readonly sendMs: number;
  /** Budget of the claim-plus-delivery transaction. */
  readonly claimTransactionMs: number;
  /** How long a run waits for a free connection before giving up. */
  readonly claimMaxWaitMs: number;
}

/**
 * Injection token for {@link MailTimeouts}.
 *
 * A token rather than four module-level constants, because the mail worker's tests have
 * to be able to compress the whole scale into seconds: the case „der Mailserver
 * antwortet nach `DATA` nie mehr" is only expressible if a suite can put the
 * send deadline *and* the transaction budget within a test's patience, and both
 * at their real relative order.
 */
export const MAIL_TIMEOUTS = Symbol('MAIL_TIMEOUTS');

export const DEFAULT_MAIL_TIMEOUTS: MailTimeouts = {
  connectionMs: 15_000,
  greetingMs: 10_000,
  socketMs: 60_000,
  sendMs: 90_000,
  /**
   * Generous on purpose. The row lock is held across the SMTP conversation —
   * that is what makes `SKIP LOCKED` mean anything — so this has to outlast a
   * slow handshake. Prisma's default of five seconds would tear the transaction
   * down *under* a working send and record a database timeout as the reason a
   * mail did not go out, which is the most misleading possible entry in the
   * mail log.
   */
  claimTransactionMs: 120_000,
  claimMaxWaitMs: 20_000,
};

/**
 * German, because it lands in `mail_log.last_error` and is read by an editor
 *  — hence seconds rather than milliseconds, and hence the
 * singular: a compressed test scale would otherwise put „1 Sekunden" in front
 * of somebody.
 */
export function mailSendTimeoutReason(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  const unit = seconds === 1 ? 'Sekunde' : 'Sekunden';
  return (
    `Der Mailserver hat nicht innerhalb von ${String(seconds)} ${unit} ` +
    'geantwortet. Der Versuch wurde abgebrochen und wird später wiederholt.'
  );
}

/**
 * Runs `work` with a deadline, and rejects with {@link mailSendTimeoutReason}
 * when it is missed.
 *
 * The abandoned promise keeps running — nothing here can cancel a socket — so
 * it gets a no-op `catch` attached first. Without it, a send that rejects after
 * its deadline becomes an unhandled rejection, and an unhandled rejection takes
 * the process down: the worker would trade an unbounded retry loop for an
 * unbounded restart loop.
 */
export async function withSendDeadline<T>(
  work: Promise<T>,
  ms: number,
): Promise<T> {
  work.catch(() => undefined);

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(mailSendTimeoutReason(ms)));
    }, ms);
    // A pending deadline must never be the reason a process refuses to exit.
    timer.unref();
  });

  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
