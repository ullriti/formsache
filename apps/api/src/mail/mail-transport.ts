import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { SmtpBlock } from '@formsache/shared';
import { createTransport, type Transporter } from 'nodemailer';

import { SystemMailSettingsService } from '../system-settings/system-mail-settings.service';
import { MailSecretsService } from './mail-secrets.service';
import { MAIL_TIMEOUTS, type MailTimeouts } from './mail-timeouts';

/**
 * One mail, as the queue hands it to the outside world.
 *
 * Deliberately flat and free of anything domain-shaped: no notification, no
 * response, no tenant. What a transport needs to know is an address, a subject
 * and a body — and keeping it at that is what lets the queue be
 * tested against a programmable double instead of against a mail server.
 */
export interface OutgoingMail {
  /** Exactly one recipient — one `mail_log` row per address. */
  readonly to: string;
  readonly subject: string;
  /** Always present: even an HTML mail carries a plain-text alternative. */
  readonly text: string;
  /** Present only for `format: 'html'` notifications. */
  readonly html?: string;
  /**
   * Display name in front of the configured sender address.
   *
   * The *address* is an installation property and comes from `SMTP_FROM`; the
   * name belongs to the organisation, so a mail is signed by whoever sent it without
   * any Organisation being able to send *as* another.
   */
  readonly fromName?: string;
  /**
   * Where a reply is to go — the **effective** value of the
   * chain notification → organisation → system, already resolved.
   *
   * Absent means: **no header line**. That is the explicit decision
   * for the case in which no level has set anything (`effectiveReplyTo` in
   * `@formsache/shared` gives the reason) — not „forgotten" and not „take the
   * sender address", for that is exactly what a mail client does without the header anyway.
   *
   * **Not part of {@link SendingIdentity}.** The identity is the
   * transport — connection, login, sender address, all of it under SPF/DKIM.
   * This here stands in the body of the message and therefore travels with the
   * message.
   */
  readonly replyTo?: string;
}

/**
 * Which sending identity one mail goes out under — the block, plus the name of
 * the connection it is cached against (ADR-0013 no. 7).
 *
 * **The key is not the block.** The installation's own mail — Betriebsalarme
 * und die Testmail der Systemverwaltung — shares one key
 * ({@link SYSTEM_IDENTITY_KEY}); an organisation gets its own, named by its
 * id. Keying by the block instead would open a second connection to the same
 * server whenever two holders happened to enter the same one, and keying by
 * the organisation alone would make „who is the system transport's counter"
 * unanswerable — which is precisely what the fail-closed proofs measure.
 */
export interface SendingIdentity {
  /** {@link SYSTEM_IDENTITY_KEY}, or the id of the organisation that owns the block. */
  readonly key: string;
  /** Ready to send with: the password is **open**. */
  readonly block: SmtpBlock;
}

/**
 * The one key the **installation's own** mail goes out under — see
 * {@link SendingIdentity}.
 *
 * Since ADR-0023 no organisation shares it: it names the operator's transport
 * and nothing else. It is deliberately not a valid tenant id, so a bug that
 * mixed the two cannot silently pick up the wrong cached transporter.
 */
export const SYSTEM_IDENTITY_KEY = 'system';

/**
 * The values that must not reach a column or a log for **this** block.
 *
 * A function of the block rather than state on the transport, and that is the
 * whole fix: with transports per organisation a field like „the credentials I last
 * resolved" redacts one organisation's error with another organisation's password — so Organisation A's
 * password stays legible in Organisation B's `mail_log.last_error`, which is the one
 * place the mail log shows it. The redaction list therefore travels
 * with the handover, exactly like the block does.
 */
export function mailCredentialsOf(block: SmtpBlock): readonly string[] {
  return block.auth === null ? [] : [block.auth.password, block.auth.user];
}

/**
 * The narrow seam between the mail queue and the outside world.
 *
 * An abstract class rather than an interface plus a symbol, because Nest can
 * use the class itself as the injection token — a test swaps in a double with
 * `overrideProvider(MailTransport)` and nothing else in the graph changes.
 *
 * Two members, and no more on purpose. Everything the queue is responsible for —
 * retry, backoff, attempt ceiling, log rows — is queue behaviour and belongs to
 * the worker; a transport that knew about any of it could not be
 * replaced by twelve lines of test double, and then a real-server test would be proving SMTP
 * rather than proving our queue.
 *
 * **It resolves nothing**. Which identity applies to a row is
 * `MailIdentityService`'s answer and the worker's decision (ADR-0013 no. 5);
 * this seam is handed the result. That split is what removed the two separate
 * resolutions a review found — `configured()` and `send()` used to ask
 * the database independently, so a block deleted between them made `send()`
 * throw „nicht eingerichtet" **inside** the claim transaction, and the row burnt
 * an attempt for a state in which nothing was ever attempted.
 */
export abstract class MailTransport {
  /**
   * Whether **this installation** can deliver its own mail at all.
   *
   * The one question left on this seam that is not about a single mail, and it
   * has exactly one caller left: the once-per-process startup notice. The
   * *queue* does not ask it any more — it resolves an identity per row, which is
   * the only reading that can tell „diese Organisation hat keinen Mailserver"
   * from „ihr gespeicherter Block ist kaputt" (ADR-0013 no. 5).
   *
   * `false` is a normal, supported state: the application starts, submissions
   * are accepted and their mail stays `queued` with a readable reason, so a mail
   * server configured later still sends it. It must never become `failed` —
   * nothing was refused, nothing was attempted. A **broken** stored block is a
   * third answer and leaves here as `MailConfigUnreadableError`; the startup
   * notice says so rather than swallowing it.
   */
  abstract configured(): Promise<boolean>;

  /**
   * Delivers one mail under one identity, or rejects.
   *
   * The identity is a **parameter**, not something this seam looks
   * up: the queue has already resolved it for the row, and a transport that
   * resolved it a second time would be the second answer to „welcher Organisation?" that
   * `CONTRIBUTING.md` warns about — one that a deleted block turns into a refusal
   * inside somebody else's transaction.
   */
  abstract send(mail: OutgoingMail, identity: SendingIdentity): Promise<void>;
}

/**
 * The reason a `mail_log` row carries while **this installation** has no mail
 * server of its own.
 *
 * Since ADR-0023 it is the narrower of two sentences and reaches only the rows
 * of the operator — the system testmail, and whatever else goes out under the
 * installation's identity. An organisation's row gets
 * {@link TENANT_MAIL_NOT_CONFIGURED_REASON}, because the person who reads it
 * is a different person with a different thing to do.
 *
 * One constant per sentence, because two halves depend on each: the worker
 * writes it into `last_error` and the mail log shows it. The
 * reproduction („den Grund weglassen") is only expressible against a
 * single source — with the text typed twice, deleting one of them leaves the
 * other one green.
 *
 * German, because it is shown to an editor.
 */
export const MAIL_NOT_CONFIGURED_REASON =
  'Kein Mailserver der Installation eingetragen — die Nachricht bleibt in der ' +
  'Warteschlange, bis in der Systemverwaltung einer eingerichtet ist.';

/**
 * The reason a `mail_log` row of an **organisation** carries while that
 * organisation has no mail server (ADR-0023).
 *
 * ⚠️ **It is not a `failed`, and that is the promise.** Nothing was attempted
 * and nothing refused: the row stays `queued`, uses up no attempt,
 * and as soon as somebody enters a mail server under *Mailversand* it goes
 * out. A `failed` would be the convenient simplification and would cost exactly the
 * property that makes a freshly created organisation able to work.
 *
 * A sentence **of its own** and not the installation's, although both mean „no
 * mail server": the reader of this row is a person **of this
 * organisation** who can and should enter something in their own tab
 * *Mailversand* — being referred to system administration, to which they have no
 * access, would be a dead end with readable text.
 */
export const TENANT_MAIL_NOT_CONFIGURED_REASON =
  'Diese Organisation hat keinen Mailserver eingetragen — die Nachricht ' +
  'bleibt in der Warteschlange, bis unter „Mailversand" einer hinterlegt ist.';

/**
 * The real transport: `nodemailer` over SMTP, configured from the **system
 * settings row** .
 *
 * ## Where the credentials come from, and where they no longer do
 *
 * `system_setting.smtp` — one indivisible block (host, port, secure, auth,
 * from), with `auth.password` sealed by {@link MailSecretsService} and opened
 * here for the duration of one send. **Not from `SMTP_*` of the environment any
 * more**: the concept lets an organisation send over its own mail server, and a
 * value that is overridable per organisation does not belong in a file that describes
 * the process. An earlier note that said the opposite („kein `SecretField`, SMTP ist
 * ein *Umgebungs*-Geheimnis") is withdrawn in ADR-0013 no. 6 rather than worked
 * around.
 *
 * ## They are never logged
 *
 * Nothing in this class writes `auth` anywhere, and the error path deliberately
 * re-raises rather than logging: what a failed delivery may leave behind is
 * bounded by the worker, which writes `mail_log.last_error`. The requirement is
 * proven by capturing `stdout`/`stderr` over a full cycle, so a convenience
 * `this.logger.debug(options)` here would be the one line that fails it.
 *
 * ## One transporter per sending identity, discarded when the block changes
 *
 * It used to be built once, from the environment, because an environment cannot
 * change while a process runs. A row can — an organisation saves a new mail server and
 * expects the next mail to use it. Transporters are therefore held in a map
 * keyed by {@link SendingIdentity.key} (one per organisation plus one for the
 * installation, kept across worker runs) and each entry additionally remembers the {@link fingerprint} of
 * the block it was built from. A changed fingerprint closes the old transporter
 * and builds a new one.
 *
 * Without that second half, ADR-0013 no. 7's „stillste Falle": the surface shows
 * the new server, the mail goes over the old one until the next restart, and
 * nobody sees it because **both work**.
 *
 * ## What the cache saves, and what it does **not**
 *
 * It saves the transporter *object* and the one place a changed block is
 * noticed. It does **not** save the connection: `buildTransporter` sets no
 * `pool`, so `nodemailer` opens and closes an SMTP connection per `sendMail`.
 * The sentence that used to stand here — „so not every row opens a connection" —
 * was simply untrue, and so is that half of ADR-0013 no. 7 (a review finding).
 *
 * Pooling was tried and **withdrawn**: with a session held open, the login is
 * authenticated once and not per mail, so a mail server that starts answering
 * `535` between two rows goes unnoticed until the socket drops — which is a
 * property `smtp-credentials.spec.ts` measures, and rewriting that proof to fit
 * the cache would be the wrong way round. A handshake per mail is also the safer
 * posture towards a host **an organisation's admin chose** : nothing stays
 * open to it between runs.
 *
 * What the connection costs is one handshake per row of one organisation per run — the
 * fan-out of a registration is twenty (`MAIL_RECIPIENT_LIMIT`), not thousands.
 * If that ever becomes the bottleneck, `pool: true` is one line plus a rewritten
 * proof of the `535` case, not a redesign.
 *
 * ## What is *not* here
 *
 * No worker, no scheduler, no purge, and no startup warning. „Sagt es beim Start
 * einmal deutlich im Log" is a **once per process** promise whose test counts
 * occurrences, so it has exactly one home, in the worker, and not two.
 */
@Injectable()
export class NodemailerTransport
  extends MailTransport
  implements OnModuleDestroy
{
  /**
   * One entry per sending identity — see the class doc.
   *
   * Bounded by the number of Organisationen that actually send with their own block,
   * plus one for the installation. Entries are replaced (and their socket
   * closed) when a block changes, never appended to.
   */
  private readonly cached = new Map<
    string,
    {
      readonly fingerprint: string;
      readonly transporter: Transporter;
      /** `Date.now()` of the last send — see {@link CACHED_TRANSPORT_IDLE_MS}. */
      usedAt: number;
    }
  >();

  constructor(
    private readonly systemSettings: SystemMailSettingsService,
    private readonly secrets: MailSecretsService,
    @Inject(MAIL_TIMEOUTS) private readonly timeouts: MailTimeouts,
  ) {
    super();
  }

  /**
   * Whether this **installation** can deliver at all.
   *
   * Only the startup notice asks — see {@link MailTransport.configured}. It
   * reads the system row and nothing else, and it deliberately lets a
   * `MailConfigUnreadableError` out: „nicht eingerichtet" and „unlesbar" are
   * different states with different answers (ADR-0013 no. 5), and collapsing
   * them here would make an installation with a broken block look like a fresh
   * one.
   */
  async configured(): Promise<boolean> {
    return (
      this.secrets.openSystemBlock(await this.systemSettings.storedSmtp()) !==
      null
    );
  }

  async send(mail: OutgoingMail, identity: SendingIdentity): Promise<void> {
    await this.transporterFor(identity).sendMail({
      from:
        mail.fromName === undefined
          ? identity.block.from
          : { name: mail.fromName, address: identity.block.from },
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      ...(mail.html === undefined ? {} : { html: mail.html }),
      // Left out rather than set empty when nothing applies — the same shape
      // `html` has one line above: „no reply address" is the
      // absence of the header and not a header without content.
      // That is checked at the sent header, not at this object
      // (`test/mail/reply-to.spec.ts`).
      ...(mail.replyTo === undefined ? {} : { replyTo: mail.replyTo }),
    });
  }

  /**
   * Closes every open connection; harmless when there is none.
   *
   * `OnModuleDestroy` and not `OnApplicationShutdown`, because the latter only
   * fires after `app.enableShutdownHooks()`, which this application does not
   * call — a hook that never runs would leave an open socket behind every test
   * that boots the app, and „the suite hangs at the end" is a symptom nobody
   * traces back to a mail transport. `PrismaService` closes on the same hook.
   */
  onModuleDestroy(): void {
    for (const entry of this.cached.values()) {
      entry.transporter.close();
    }
    this.cached.clear();
  }

  /**
   * The transporter for one identity, built on first use and **discarded when
   * its block changes** (ADR-0013 no. 7).
   *
   * Closing the superseded one is not tidiness: without it every saved change
   * leaks a pooled connection to a server nobody talks to any more, and the
   * count grows with every edit until the process restarts.
   */
  private transporterFor(identity: SendingIdentity): Transporter {
    const now = Date.now();
    this.dropIdle(now);

    const mark = fingerprint(identity.block);
    const held = this.cached.get(identity.key);
    if (held?.fingerprint === mark) {
      held.usedAt = now;
      return held.transporter;
    }
    held?.transporter.close();
    const transporter = buildTransporter(identity.block, this.timeouts);
    this.cached.set(identity.key, {
      fingerprint: mark,
      transporter,
      usedAt: now,
    });
    return transporter;
  }

  /**
   * Closes and forgets every entry nobody has sent over for a while.
   *
   * **The entry a changed fingerprint never reaches.** An organisation that
   * clears its mail server stops appearing under its key entirely — its rows
   * are withheld from then on (ADR-0023) — so the fingerprint check above is
   * never asked about it again and its entry stays until the process restarts
   * (a review finding). The
   * same goes for an organisation that is simply quiet for a week. Unbounded growth keyed
   * by tenant id, in a map that is only ever read by key: nothing fails, it just
   * never shrinks.
   *
   * `close()` on the way out even though an unpooled transporter holds no open
   * socket — the day `pool` is switched on, this is one of the two paths that
   * has to let go of a connection, and a cleanup that is correct only under the
   * current setting is the one that gets forgotten.
   *
   * `Date.now()` and not `MailClock`: this is housekeeping about sockets, not a
   * decision about mail, and a suite that moves the injected clock by a month to
   * reach a backoff must not thereby close connections it is measuring.
   */
  private dropIdle(now: number): void {
    for (const [key, entry] of this.cached) {
      if (now - entry.usedAt >= CACHED_TRANSPORT_IDLE_MS) {
        entry.transporter.close();
        this.cached.delete(key);
      }
    }
  }
}

/**
 * How long an unused entry is kept.
 *
 * Far longer than the fifteen seconds between two worker runs, so an ordinary
 * hour's sending keeps its transporters; short enough that „eine Organisation ist zum
 * System zurückgewechselt" resolves itself within one, rather than at the next
 * deployment.
 */
export const CACHED_TRANSPORT_IDLE_MS = 15 * 60 * 1000;

/**
 * What makes two blocks „the same transport".
 *
 * **Every field of the block, without exception** — the password because a
 * rotated one is a different connection, and `from` because it is part of the
 * indivisible block and a fingerprint that left it out would be
 * a list somebody has to remember to extend. The rule is „all of it", not „the
 * ones that reach `createTransport`", precisely so there is nothing to forget:
 * `mailIdentityFingerprint` in the spec of this file asserts that a change to
 * *any* field produces a different mark.
 *
 * JSON of a fixed field order rather than the object itself, so the comparison
 * is a string compare and cannot be defeated by key order. It is held in memory
 * only and never logged or stored.
 */
export function fingerprint(block: SmtpBlock): string {
  return JSON.stringify([
    block.host,
    block.port,
    block.secure,
    block.from,
    block.auth?.user ?? null,
    block.auth?.password ?? null,
  ]);
}

/**
 * Builds the `nodemailer` transporter for one block.
 *
 * **The three timeouts are stated, never inherited.** `nodemailer`'s defaults
 * (greeting 30 s, connection 120 s, socket 600 s) are all at or above the
 * worker's transaction budget, so a server that accepts the connection and then
 * goes quiet outlived the transaction that was supposed to record the attempt —
 * and the row came back unchanged, immediately due again, forever.
 * `mail-timeouts.ts` tells that story in full; here it is enough to know that
 * these values are not decoration.
 *
 * ## `requireTLS` is **not** set, and that is a named open point
 *
 * With `secure: false` — the value in every example — `nodemailer` upgrades to
 * STARTTLS when the server advertises it and stays in the clear when it does
 * not. Setting `requireTLS` would turn that into a refusal, which is the right
 * posture for a block that carries a password: that password comes
 * out of the database, and a relay without STARTTLS puts it on the wire.
 *
 * It is not set here for two reasons, both of which point at another package:
 *
 * 1. **There is no field to opt out of it.** A relay on a trusted network
 *    without STARTTLS is a supported operating mode today (`auth: null` is
 *    explicitly one), and the indivisible block of the requirement has no
 *    `requireTls` — it lives in `packages/shared`, which this package does not
 *    own. Turning it on unconditionally removes an operating mode with no way
 *    back.
 * 2. **It would make the real-server proofs unbuildable.** `smtp-inbox.ts`
 *    speaks plaintext on loopback (`disabledCommands: ['STARTTLS']`), and the
 *    proofs of the requirements hand it real credentials. Giving it TLS
 *    needs a certificate the transport would have to be told to trust —
 *    i.e. weakening certificate validation in shipped code to keep a test
 *    green, which is worse than the gap it closes.
 */
function buildTransporter(
  block: SmtpBlock,
  timeouts: MailTimeouts,
): Transporter {
  return createTransport({
    // **`pool` is deliberately not set** — see „Was der Zwischenspeicher spart"
    // in the class doc above. One connection per `sendMail`, and the login is
    // therefore re-checked per mail, which is what `smtp-credentials.spec.ts`
    // measures when a server starts answering `535` between two rows.
    host: block.host,
    port: block.port,
    // A stored block has no open fields: `secure` was decided when it was
    // saved, by a surface that shows the value, not guessed here from the port.
    secure: block.secure,
    connectionTimeout: timeouts.connectionMs,
    greetingTimeout: timeouts.greetingMs,
    socketTimeout: timeouts.socketMs,
    // Authentication only when the block carries a pair. `auth: null` is a
    // supported operating mode — a relay that wants no login gets none — and it
    // is a *decision* in the document rather than the absence of one, because
    // the pair cannot be half filled (`mail-config.ts`).
    ...(block.auth === null
      ? {}
      : { auth: { user: block.auth.user, pass: block.auth.password } }),
  });
}
