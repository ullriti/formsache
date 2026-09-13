import {
  MailTransport,
  type OutgoingMail,
  type SendingIdentity,
} from '../../src/mail/mail-transport';

/**
 * A transport double that answers **differently per sending identity**
 * (the requirements).
 *
 * `SmtpDouble` is one remote with one script, which is all a single mail
 * server ever needed: there was one mail server. Since ADR-0013 there are
 * several, and every question here is about telling them apart — „did the
 * *system* transport get asked?" (fail-closed, ADR-0013 no. 4), „did
 * Organisation B's mail go out while Organisation A's server was hanging?"
 * (concurrency isolation). Neither is expressible against a double that
 * cannot say which remote it was.
 *
 * It keeps one counter per {@link SendingIdentity.key}, which is exactly the
 * measurement the requirement names: „der Zähler des System-Transports steht auf
 * 0". And it is deliberately **in working order** by default — a double that
 * refused everything would keep „die Mail ging nicht raus" green with the
 * fallback broken too, which is the trap ADR-0013 no. 4 spells out.
 *
 * Nothing here opens a socket.
 */

/** A send held mid-flight, so one organisation's lane parks while the others run. */
export interface IdentityGate {
  /** Resolves as soon as a send for that identity has arrived and is waiting. */
  readonly arrived: Promise<void>;
  /** Lets it finish. Safe to call more than once. */
  release: () => void;
}

export class IdentityRoutingDouble extends MailTransport {
  /** Every mail handed over, per identity key — the counters the fail-closed check reads. */
  private readonly delivered = new Map<string, OutgoingMail[]>();
  /** The `from` address each handover carried, per key: whose block was used. */
  private readonly senders = new Map<string, string[]>();
  private readonly refusing = new Set<string>();
  private readonly gates = new Map<
    string,
    { readonly arrive: () => void; readonly wait: Promise<void> }
  >();

  configured(): Promise<boolean> {
    return Promise.resolve(true);
  }

  /** What this identity was asked to deliver, in order. */
  attemptsFor(key: string): readonly OutgoingMail[] {
    return this.delivered.get(key) ?? [];
  }

  /** The sender addresses this identity sent under — the block, observed. */
  sendersFor(key: string): readonly string[] {
    return this.senders.get(key) ?? [];
  }

  /** From now on, every connection under this identity is refused. */
  refuse(key: string): void {
    this.refusing.add(key);
  }

  /**
   * Holds the **next** send under one identity until it is released.
   *
   * The barrier the requirement needs: while one organisation's lane is parked here it
   * still holds its row lock and its place in the run, so „die Mails des anderen
   * gehen im selben Lauf hinaus" is a statement about an overlap rather than
   * about an order. Without it the two lanes simply follow each other and the
   * case proves nothing — the same shape `SKIP LOCKED` needed.
   */
  hold(key: string): IdentityGate {
    let arrive: () => void = () => undefined;
    let release: () => void = () => undefined;
    const arrived = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.gates.set(key, { arrive, wait });
    return { arrived, release };
  }

  async send(mail: OutgoingMail, identity: SendingIdentity): Promise<void> {
    push(this.delivered, identity.key, mail);
    push(this.senders, identity.key, identity.block.from);

    const gate = this.gates.get(identity.key);
    if (gate !== undefined) {
      // One-shot: cleared before waiting, so the next send is not held too.
      this.gates.delete(identity.key);
      gate.arrive();
      await gate.wait;
    }

    if (this.refusing.has(identity.key)) {
      // Shaped like the thing a dead mail server really produces, `code` and
      // all — the worker categorises by that code, and a bare `Error` would
      // leave the categorisation untested.
      const error: Error & { code?: string } = new Error(
        `connect ECONNREFUSED ${identity.block.host}:${String(identity.block.port)}`,
      );
      error.code = 'ECONNREFUSED';
      throw error;
    }
  }
}

function push<T>(store: Map<string, T[]>, key: string, value: T): void {
  const held = store.get(key) ?? [];
  held.push(value);
  store.set(key, held);
}
