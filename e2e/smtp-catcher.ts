import { once } from 'node:events';
import { createServer, type Server, type Socket } from 'node:net';

/**
 * A real SMTP receiver on the loopback interface, written against `node:net`.
 *
 * **Why not `apps/api/test/support/smtp-inbox.ts`.** That one is the same idea
 * one layer down and it is the right tool there — but it lives on the
 * `smtp-server` package, which is a dev dependency of `apps/api` and is not
 * resolvable from the root workspace that owns `e2e/`. Pulling the package into
 * the root `package.json` for the acceptance run would be a second copy of a
 * dependency for a test double (`CONTRIBUTING.md`), so the twelve verbs the
 * transport actually speaks are answered here instead.
 *
 * **Nothing leaves this machine.** The listener binds to `127.0.0.1` on an
 * ephemeral port, and every address the acceptance run posts to ends in
 * `.invalid` — a name that cannot resolve (RFC 2606).
 *
 * What it is for: the acceptance run of the requirement needs *delivered* mail, not a
 * queue that never moves. Step 5 asks for two sending identities — the
 * installation's own SMTP block and an organisation's — and „beide Wege im
 * Versandprotokoll sichtbar" is only a measurement if the two ways can be told
 * apart. Two catchers on two ports is what tells them apart: each one reports
 * what it, and only it, received.
 */

/** One message this server accepted, envelope and DATA payload. */
export interface CaughtMessage {
  readonly from: string;
  readonly to: readonly string[];
  /** The raw DATA payload, headers included. */
  readonly data: string;
}

export interface SmtpCatcher {
  readonly port: number;
  readonly messages: readonly CaughtMessage[];
  close: () => Promise<void>;
}

/** `MAIL FROM:<a@b>` / `RCPT TO:<a@b>` → `a@b`; anything else → ''. */
function addressOf(line: string): string {
  const match = /<([^>]*)>/u.exec(line);
  return match?.[1] ?? '';
}

/** What a catcher may do beyond collecting. */
export interface SmtpCatcherOptions {
  /**
   * Called for every accepted message, **before** the `250 Ok` goes out.
   *
   * The one caller is `global-setup.ts`: the catcher of the whole run lives in
   * the main process, and the workers never see its `messages` — so the
   * callback writes every line into the file they read from
   * (`instance-mail.ts`). A callback and no polling on a cadence, so that
   * between „angenommen" and „lesbar" there is no window in which a waiting
   * assertion looks into the void.
   *
   * A throw here would be without consequence for the sender — the connection
   * has nothing to do with it —, but it would swallow the line. The caller
   * therefore keeps it simple.
   */
  readonly onMessage?: (message: CaughtMessage) => void;
}

export async function startSmtpCatcher(
  name: string,
  options: SmtpCatcherOptions = {},
): Promise<SmtpCatcher> {
  const messages: CaughtMessage[] = [];
  /**
   * Every open connection, so {@link SmtpCatcher.close} can end them.
   *
   * `net.Server` has **no** `closeAllConnections()` — that member belongs to
   * `http.Server` — and `close()` alone only stops the listener while an idle
   * connection keeps the `'close'` event from ever firing. The transport keeps
   * no pool (`mail-transport.ts` sets none) but does hold a socket between two
   * mails, so without this the run would hang at teardown.
   */
  const open = new Set<Socket>();

  const server: Server = createServer((socket) => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    let buffer = '';
    let inData = false;
    let dataLines: string[] = [];
    let from = '';
    let to: string[] = [];
    /** The two `334` challenges of `AUTH LOGIN` are answered without reading. */
    let awaitingAuthLine: 'user' | 'password' | null = null;

    const say = (line: string): void => {
      socket.write(`${line}\r\n`);
    };

    const reset = (): void => {
      from = '';
      to = [];
      dataLines = [];
    };

    const handle = (line: string): void => {
      if (inData) {
        if (line === '.') {
          inData = false;
          const caught: CaughtMessage = {
            from,
            to: [...to],
            data: dataLines.join('\r\n'),
          };
          messages.push(caught);
          options.onMessage?.(caught);
          reset();
          say('250 2.0.0 Ok: queued');
          return;
        }
        // Transparency: a leading dot was doubled by the sender (RFC 5321 §4.5.2).
        dataLines.push(line.startsWith('..') ? line.slice(1) : line);
        return;
      }

      if (awaitingAuthLine === 'user') {
        awaitingAuthLine = 'password';
        say('334 UGFzc3dvcmQ6');
        return;
      }
      if (awaitingAuthLine === 'password') {
        awaitingAuthLine = null;
        say('235 2.7.0 Authentication successful');
        return;
      }

      const verb = line.split(' ')[0]?.toUpperCase() ?? '';
      const rest = line.slice(verb.length).trim();

      switch (verb) {
        case 'EHLO':
          // Multi-line greeting: STARTTLS is deliberately **not** advertised,
          // so nodemailer stays on the plaintext loopback connection instead
          // of asking for a certificate this receiver has no business owning.
          say(`250-${name}`);
          say('250-AUTH PLAIN LOGIN');
          say('250-8BITMIME');
          say('250 SMTPUTF8');
          return;
        case 'HELO':
          say(`250 ${name}`);
          return;
        case 'AUTH': {
          const mechanism = rest.split(' ')[0]?.toUpperCase() ?? '';
          const argument = rest.slice(mechanism.length).trim();
          if (mechanism === 'PLAIN' && argument !== '') {
            say('235 2.7.0 Authentication successful');
            return;
          }
          if (mechanism === 'PLAIN') {
            awaitingAuthLine = 'password';
            say('334 ');
            return;
          }
          if (argument !== '') {
            awaitingAuthLine = 'password';
            say('334 UGFzc3dvcmQ6');
            return;
          }
          awaitingAuthLine = 'user';
          say('334 VXNlcm5hbWU6');
          return;
        }
        case 'MAIL':
          from = addressOf(rest);
          say('250 2.1.0 Ok');
          return;
        case 'RCPT':
          to.push(addressOf(rest));
          say('250 2.1.5 Ok');
          return;
        case 'DATA':
          inData = true;
          dataLines = [];
          say('354 End data with <CR><LF>.<CR><LF>');
          return;
        case 'RSET':
          reset();
          say('250 2.0.0 Ok');
          return;
        case 'NOOP':
          say('250 2.0.0 Ok');
          return;
        case 'QUIT':
          say('221 2.0.0 Bye');
          socket.end();
          return;
        default:
          say('502 5.5.2 Command not implemented');
      }
    };

    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf('\r\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        handle(line);
        index = buffer.indexOf('\r\n');
      }
    });
    // A transport that drops the connection mid-dialogue is not this
    // receiver's problem; without a handler the error would take the run down.
    socket.on('error', () => undefined);

    say(`220 ${name} ESMTP`);
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error(`[e2e] SMTP catcher "${name}" did not bind to a TCP port`);
  }

  return {
    port: address.port,
    messages,
    close: async () => {
      for (const socket of open) {
        socket.destroy();
      }
      open.clear();
      server.close();
      await once(server, 'close');
    },
  };
}
