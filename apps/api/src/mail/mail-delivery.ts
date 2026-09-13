import { describeMailError } from './mail-error';
import { categoriseMailError } from './mail-error-category';
import {
  mailCredentialsOf,
  type MailTransport,
  type OutgoingMail,
  type SendingIdentity,
} from './mail-transport';
import {
  mailSendTimeoutReason,
  withSendDeadline,
  type MailTimeouts,
} from './mail-timeouts';

/**
 * **The one way a mail leaves this application** — „unter dieser Identität, mit
 * dieser Frist, und das hier ist der Grund, falls es nichts wurde".
 *
 * Extracted from `MailWorkerService.deliverOne` in an earlier review. Until
 * then the „Testmail senden"-Route of the requirement carried a
 * word-for-word copy of the deadline, the failure categorisation and the status
 * mapping — which quietly undid the very promise that route exists for: the requirement says
 * a Testmail „geht den echten Weg", and two copies drift apart at the first fix
 * that only reaches one of them. What stays with the queue is queue behaviour
 * (claim, `SKIP LOCKED`, attempt counting, backoff); what is shared is the one
 * step both callers really do have in common.
 *
 * It touches no database and holds no state: everything it needs arrives as an
 * argument, so the caller decides what the outcome means for its row.
 */

/**
 * Whose words the failure reason may carry.
 *
 * - `'verbatim'` — the remote's own message, with the credentials of **this**
 *   block redacted. Only defensible when the reader did not choose the host:
 *   the installation's own mail server, chosen by the superadmin, where a `535`
 *   or a refused connection is exactly the sentence its operator needs.
 * - `'category'` — one of the sentences of `mail-error-category.ts`. Required
 *   wherever the reader also picks the target: since the requirement an organisation's
 *   admin names host and port and the server dials them, and „connection
 *   refused" against „timed out" tells an open port from a closed one
 *   (ADR-0013 „Consequences").
 *
 * A parameter rather than something derived from `SendingIdentity.source` in
 * here, because the two callers genuinely differ: the queue records a reason on
 * a row and may quote the installation's own server, while the Testmail route
 * *answers the caller in the same response* and therefore categorises
 * unconditionally (a review finding, from that same review). Deriving it here would hide
 * that difference in a place neither call site is looking at.
 */
export type MailReasonStyle = 'verbatim' | 'category';

/** What one delivery attempt did — `sent`, or `failed` with a reason. */
export type MailDeliveryOutcome =
  | { readonly kind: 'sent' }
  | {
      readonly kind: 'failed';
      /** German, free of credentials, and safe for `mail_log.last_error`. */
      readonly reason: string;
      /** The attempt ended on our own send deadline — the remote went quiet. */
      readonly stalled: boolean;
    };

export interface MailDelivery {
  readonly transport: MailTransport;
  readonly timeouts: MailTimeouts;
  readonly mail: OutgoingMail;
  readonly identity: SendingIdentity;
  readonly reasonStyle: MailReasonStyle;
}

/**
 * Sends one mail **under the application's own deadline** and says what
 * happened.
 *
 * The deadline is not belt-and-braces around the transport's three timeouts: it
 * is what makes „der Status wird geschrieben, solange die Transaktion noch
 * offen ist" a property of this code rather than of a library default.
 * `mail-timeouts.ts` records what happens when a send outlives its transaction
 * — the row is left `queued` with `attempts = 0`, is due again at once, and the
 * same mail goes out every fifteen seconds without ever reaching
 * `MAIL_MAX_ATTEMPTS`.
 *
 * It never throws for a delivery that failed; a rejection out of here would be
 * a defect of ours.
 */
export async function deliverMail(
  delivery: MailDelivery,
): Promise<MailDeliveryOutcome> {
  const { transport, timeouts, mail, identity, reasonStyle } = delivery;
  try {
    await withSendDeadline(transport.send(mail, identity), timeouts.sendMs);
  } catch (error: unknown) {
    return {
      kind: 'failed',
      reason: failureReason(error, reasonStyle, identity, timeouts),
      stalled: stalledOut(error, timeouts),
    };
  }
  return { kind: 'sent' };
}

/**
 * The style the **queue** records a reason in — see {@link MailReasonStyle}.
 *
 * A function rather than a ternary at the call site, so „welche Stimme darf
 * welche Zeile führen?" is answered once and is greppable. The Testmail route
 * deliberately does *not* use it: it always categorises.
 */
export function queueReasonStyle(source: 'system' | 'own'): MailReasonStyle {
  return source === 'own' ? 'category' : 'verbatim';
}

/**
 * What may be said about a failed attempt.
 *
 * The redaction list of the verbatim style comes from **this** identity's
 * block, not from the transport: with one transport per organisation, a „credentials I
 * last used" field would redact Organisation B's error with Organisation A's password and leave
 * A's password legible in B's mail log (a review finding).
 */
function failureReason(
  error: unknown,
  style: MailReasonStyle,
  identity: SendingIdentity,
  timeouts: MailTimeouts,
): string {
  if (style === 'category') {
    return categoriseMailError(error, mailSendTimeoutReason(timeouts.sendMs));
  }
  return describeMailError(error, mailCredentialsOf(identity.block));
}

/**
 * Whether an attempt ended because the remote went quiet for the **whole** send
 * budget.
 *
 * The one failure that costs a caller real time rather than milliseconds: a
 * refused connection comes back at once, a stall costs `sendMs` and the next
 * row of that organisation would cost the same again (a security finding). The
 * deadline's sentence is this application's own — `withSendDeadline` produced
 * it — so recognising it here is reading our own message, not the remote's.
 */
function stalledOut(error: unknown, timeouts: MailTimeouts): boolean {
  return (
    error instanceof Error &&
    error.message === mailSendTimeoutReason(timeouts.sendMs)
  );
}
