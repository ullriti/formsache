import {
  MailTransport,
  type OutgoingMail,
  type SendingIdentity,
} from '../../src/mail/mail-transport';

/**
 * A programmable stand-in for the outside world.
 *
 * **Why a double and not a server for the queue's own retry behaviour.** That
 * behaviour is about *our*
 * queue — „scheitert zweimal, gelingt beim dritten Mal", „wird nicht endlos
 * wiederholt", „zwei Läufe greifen dieselbe Zeile nicht doppelt". Steering that
 * through the state of a real mail server would add moving parts and subtract
 * certainty. And for the requirement that „jede Verbindung wird verweigert" a double is the
 * *more honest* instrument than a switched-off server: it refuses
 * deterministically instead of after whatever TCP timeout the host happens to
 * have.
 *
 * What a real server is needed for is the requirement that „ein geänderter Wert kommt an" —
 * that is `smtp-inbox.ts`, and it is not replaceable by this.
 *
 * Nothing here opens a socket, so no test run can post to a real mailbox.
 */

/** What one scripted attempt does. */
export type ScriptedResult = 'ok' | 'fail';

/** A send held mid-flight, so two workers' runs overlap on purpose. */
export interface SmtpGate {
  /** Resolves as soon as a send has arrived and is waiting. */
  readonly arrived: Promise<void>;
  /** Lets that send finish. Safe to call more than once. */
  release: () => void;
}

export interface SmtpDoubleOptions {
  /**
   * Results for the first attempts, in order — `['fail', 'fail', 'ok']` is
   * literally the requirement's „zweimal scheitern, beim dritten gelingen".
   */
  readonly script?: readonly ScriptedResult[];
  /** What happens once the script is used up. Defaults to `'ok'`. */
  readonly then?: ScriptedResult;
  /** Message of the rejection, so a test can assert a readable reason. */
  readonly failureMessage?: string;
  /** `false` reproduces an installation without SMTP. */
  readonly configured?: boolean;
  /**
   * How long **every** send stalls before the script decides its outcome — the
   * mail server that accepts the connection and then goes quiet in the `DATA`
   * dialogue (a greylisting relay at the opening of a registration).
   *
   * The stall is what makes the worker's send deadline provable. Deliberately
   * *finite*: a send that never settles at all would only hang the run, whereas
   * the failure this reproduces is the one where the answer arrives **after**
   * the transaction that was supposed to record the attempt has already been
   * rolled back (`mail-timeouts.ts`). Set it above the transaction budget and
   * the pre-fix behaviour is visible; the deadline cuts it off long before.
   */
  readonly stallMs?: number;
}

const DEFAULT_FAILURE_MESSAGE = 'SMTP-Doppel: Zustellung abgelehnt';

export class SmtpDouble extends MailTransport {
  private readonly isConfigured: boolean;

  /** Every mail handed to this transport, in order — the attempt counter. */
  readonly attempts: OutgoingMail[] = [];

  /**
   * The identity under which each of these mails went out — in the same
   * order (ADR-0020).
   *
   * Up to here the double only recorded the message, and "over which
   * mail server did it go" was therefore **not** observable in the test — provable
   * it was only with two catching SMTP servers, that is, outside the application.
   * Exactly that was the hole through which a reset mail could go over the relay
   * of an organisation without a case turning red.
   */
  readonly identities: SendingIdentity[] = [];

  private readonly script: ScriptedResult[];
  private readonly fallback: ScriptedResult;
  private readonly failureMessage: string;
  private readonly stallMs: number;
  private gate:
    { readonly arrived: () => void; readonly wait: Promise<void> } | undefined;

  constructor(options: SmtpDoubleOptions = {}) {
    super();
    this.isConfigured = options.configured ?? true;
    this.script = [...(options.script ?? [])];
    this.fallback = options.then ?? 'ok';
    this.failureMessage = options.failureMessage ?? DEFAULT_FAILURE_MESSAGE;
    this.stallMs = options.stallMs ?? 0;
  }

  /**
   * Whether this stand-in can deliver.
   *
   * A **method returning a promise**, matching the seam: the real
   * transport answers this from `system_setting.smtp` now. The double still
   * answers from a constructor option — the point of a double is that it does
   * not need a row — but it has to have the same shape, or a suite would be
   * exercising a contract the application does not have.
   */
  configured(): Promise<boolean> {
    return Promise.resolve(this.isConfigured);
  }

  /** How often the queue has asked this transport to deliver something. */
  get attemptCount(): number {
    return this.attempts.length;
  }

  /** The addresses this transport was asked to deliver to, in order. */
  get recipients(): string[] {
    return this.attempts.map((mail) => mail.to);
  }

  /**
   * Holds the **next** send until {@link SmtpGate.release} is called.
   *
   * This is the barrier the requirement needs: while one worker is parked here it
   * still holds its row lock, so a second run genuinely overlaps with it
   * instead of following it. Only the next send is held — the second worker's
   * delivery has to be able to finish while the first one waits, because
   * „finished while the other was still working" is the observable difference
   * `SKIP LOCKED` makes.
   */
  hold(): SmtpGate {
    let arrive: () => void = () => undefined;
    let release: () => void = () => undefined;
    const arrived = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.gate = { arrived: arrive, wait };
    return { arrived, release };
  }

  /** The keys of the identities used, in order — `'system'` or an organisation identifier. */
  get identityKeys(): string[] {
    return this.identities.map((identity) => identity.key);
  }

  async send(mail: OutgoingMail, identity: SendingIdentity): Promise<void> {
    this.attempts.push(mail);
    this.identities.push(identity);

    const gate = this.gate;
    if (gate !== undefined) {
      // One-shot: cleared before waiting, so the next send is not held too.
      this.gate = undefined;
      gate.arrived();
      await gate.wait;
    }

    if (this.stallMs > 0) {
      await new Promise<void>((resolve) => {
        // Unreferenced: a stall the test has already stopped waiting for must
        // not keep the process alive at the end of the run.
        setTimeout(resolve, this.stallMs).unref();
      });
    }

    const result = this.script.shift() ?? this.fallback;
    if (result === 'fail') {
      throw new Error(this.failureMessage);
    }
  }
}
