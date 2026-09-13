import type { AddressInfo } from 'node:net';

import { SMTPServer } from 'smtp-server';

/**
 * A real SMTP server, in this process, on the loopback interface.
 *
 * **Not replaceable by `SmtpDouble`.** the promise is that „ein
 * geänderter Wert in `.env` kommt nachweislich an". A test that inspects the
 * options object built from the environment proves the *mapping* and would stay
 * green if the transport ignored those options entirely. Only a receiver that
 * reports back what it was told closes that gap — which is what
 * {@link SmtpInbox.auths} is.
 *
 * `nodemailer`'s own `jsonTransport`/`streamTransport` are not an alternative:
 * they bypass exactly the SMTP path this file is about.
 *
 * **Nothing leaves this machine.** The listener binds to `127.0.0.1` on an
 * ephemeral port, and the suites address `…@example.invalid`, a name that
 * cannot resolve. There is no run in which a test posts to a real mailbox.
 */

/** One login the server was offered. */
export interface CapturedAuth {
  readonly user: string;
  readonly pass: string;
}

/** One message the server accepted. */
export interface CapturedMessage {
  readonly from: string;
  readonly to: readonly string[];
  /** The raw DATA payload, headers included. */
  readonly data: string;
}

export interface SmtpInbox {
  readonly port: number;
  readonly auths: readonly CapturedAuth[];
  readonly messages: readonly CapturedMessage[];
  /** Refuse every login from now on — the „Mailserver sagt nein" half of that verification. */
  refuseLogins: (refuse: boolean) => void;
  close: () => Promise<void>;
}

export async function startSmtpInbox(): Promise<SmtpInbox> {
  const auths: CapturedAuth[] = [];
  const messages: CapturedMessage[] = [];
  let refusing = false;

  const server = new SMTPServer({
    // `allowInsecureAuth`, because the connection is plaintext loopback: with
    // it off, `smtp-server` does not advertise AUTH at all and nodemailer never
    // sends the credentials — the test would then prove nothing and look green.
    allowInsecureAuth: true,
    authOptional: false,
    // No TLS upgrade to arrange a certificate for. The point of this server is
    // the credentials, not the cipher.
    disabledCommands: ['STARTTLS'],
    onAuth(auth, _session, callback) {
      auths.push({ user: auth.username ?? '', pass: auth.password ?? '' });
      if (refusing) {
        // Shaped like a real server's refusal, so the reason the worker stores
        // is a reason a real installation would see.
        callback(new Error('535 5.7.8 Authentication credentials invalid'));
        return;
      }
      callback(null, { user: auth.username ?? '' });
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        const envelope = session.envelope;
        messages.push({
          from: envelope.mailFrom === false ? '' : envelope.mailFrom.address,
          to: envelope.rcptTo.map((address) => address.address),
          data: Buffer.concat(chunks).toString('utf8'),
        });
        callback();
      });
    },
  });

  const listener = server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    listener.once('listening', resolve);
    listener.once('error', reject);
  });

  const address: AddressInfo | string | null = listener.address();
  if (address === null || typeof address === 'string') {
    server.close(() => undefined);
    throw new Error('SMTP inbox did not bind to a TCP port');
  }

  return {
    port: address.port,
    auths,
    messages,
    refuseLogins: (refuse: boolean) => {
      refusing = refuse;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}
