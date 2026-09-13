import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { JobKind } from '@prisma/client';
import { MAIL_MAX_ATTEMPTS, type ApiEnv } from '@formsache/shared';

import { API_ENV } from '../config/env';
import { DB_POOL_MAX, PrismaService } from '../prisma/prisma.service';
import { MailBodyRenderer, type RenderedMailBody } from './mail-body-renderer';
import { MailClock } from './mail-clock';
import { JobRunService } from '../observability/job-run.service';
import { mailBackoffMs } from './mail-backoff';
import { deliverMail, queueReasonStyle } from './mail-delivery';
import { describeMailError } from './mail-error';
import {
  MailIdentityColumnMissingError,
  MailIdentityService,
  identitySourceOf,
  attemptedIdentity,
  type AttemptedIdentity,
  type MailIdentityResolution,
  type SendIdentity,
} from './mail-identity.service';
import {
  MailQueueRepository,
  type ClaimedMail,
  type DueTenant,
  type MailLaneKey,
} from './mail-queue.repository';
import { MailConfigUnreadableError } from './mail-secrets.service';
import {
  MailTransport,
  SYSTEM_IDENTITY_KEY,
  type SendingIdentity,
} from './mail-transport';
import { MAIL_TIMEOUTS, type MailTimeouts } from './mail-timeouts';

/**
 * The sentence the application says **once at startup** when it has no mail
 * server.
 *
 * Deliberately a different string from {@link MAIL_NOT_CONFIGURED_REASON},
 * which is what a queued row carries. The promise is „einmal deutlich",
 * and its test counts occurrences over startup plus several worker runs — a
 * count that could be reached by two different messages would not be counting
 * the promise. Only variable *names* appear in it; a warning that printed a
 * value would be the one line that fails the test.
 */
export const MAIL_NOT_CONFIGURED_STARTUP_WARNING =
  'Kein Mailserver der Installation eingerichtet (in den Systemeinstellungen ' +
  'ist kein SMTP-Block hinterlegt). Die Anwendung läuft normal weiter; ' +
  'Betriebsalarme und die Testmail der Systemverwaltung bleiben aus, bis ' +
  'einer eingerichtet ist. Organisationen sind davon nicht betroffen — sie ' +
  'senden über ihren eigenen Mailserver.';

/**
 * Most rows one `runOnce()` delivers before it returns.
 *
 * A run has to end: without a cap, a queue that refills as fast as it drains
 * would keep one scheduler tick alive forever and there would never be a moment
 * at which a shutdown is clean. Fifty is far above a Jahrestagung registration's
 * fan-out (`MAIL_RECIPIENT_LIMIT` is twenty) and far below „the whole table".
 */
export const MAIL_WORKER_BATCH_MAX = 50;

/**
 * How many Organisationen one run works **at the same time** .
 *
 * The number that decides whether an organisation with a dead mail server holds up the
 * others. One would be the old behaviour with extra steps; „all of them" would
 * open one SMTP connection per organisation at once, which is a way to look like a
 * sender under attack.
 *
 * ## The arithmetic, because a bare number is what went wrong here
 *
 * Every lane holds **one** interactive transaction — and therefore one database
 * connection — for as long as its SMTP conversation lasts, up to
 * `claimTransactionMs` (two minutes). It holds exactly one and not two: the
 * sending identity is resolved *before* the transaction opens, which is what
 * `DueTenant` carries the `smtp` column for. Before that it was two, because
 * `MailIdentityService.resolve` reads the system settings row on a connection of
 * its own while the claim already holds one.
 *
 * The pool has {@link DB_POOL_MAX} connections and it is not the worker's alone:
 * ordinary HTTP requests need it too, and a request in a `$transaction` borrows
 * one for its whole duration. So the worker takes **at most half**, and the
 * other half stays for the application:
 *
 * ```
 * lanes × 1 connection ≤ DB_POOL_MAX / 2   →   5 × 1 ≤ 10 / 2
 * ```
 *
 * Written as the division rather than as a `5`, so that raising the pool raises
 * the lanes and lowering it lowers them — the previous eight lanes were a number
 * chosen against nothing, and eight two-minute transactions plus two ordinary
 * requests exhausted a pool whose `connectionTimeoutMillis` was `0`: not a slow
 * application, a hanging one (a review finding).
 *
 * organisations beyond it are not dropped, they are the next tick's — `dueTenants`
 * orders by the oldest waiting mail, so being skipped only moves an organisation
 * forwards.
 *
 * ## The system lane counts too
 *
 * Since ADR-0020 one of a run's lanes may not be an organisation but the
 * **system lane** (`MailLaneKey`) — the system mails of all organisations, over
 * the installation's block. It counts against this number and is not laid on
 * top: the arithmetic above counts connections, and a lane is a connection. A
 * run with due system mail therefore fetches one organisation less — the one of
 * the next tick, which here never means more than „ein paar Sekunden später".
 */
export const MAIL_WORKER_TENANT_LANES = Math.floor(DB_POOL_MAX / 2);

/**
 * Most rows **one lane** delivers before it lets the run end.
 *
 * The shared {@link MAIL_WORKER_BATCH_MAX} alone is not a bound on a *lane*: a
 * single Organisation with a silent mail server could take all fifty rows and spend
 * `sendMs` on each of them, which is an hour in which `runOnce` does not return
 * — and `tick()` coalesces, so no new run starts for anybody, not even for the
 * Organisationen beyond the lane count. The rows come from **public** submissions, so
 * their number is not the organisation's to control either (a security finding).
 *
 * With a per-lane share, a stalled Organisation costs its own lane and its own share of
 * the run and nothing else. It is a ceiling, not a quota: a lane whose Organisation has
 * fewer rows simply ends earlier and leaves the rest of the shared budget to the
 * others.
 */
export const MAIL_WORKER_LANE_BATCH_MAX = Math.ceil(
  MAIL_WORKER_BATCH_MAX / MAIL_WORKER_TENANT_LANES,
);

/**
 * The startup line for a **broken** stored mail configuration (* ADR-0013 no. 5, third row).
 *
 * Deliberately a different sentence from {@link
 * MAIL_NOT_CONFIGURED_STARTUP_WARNING}: „noch keiner eingerichtet" is a
 * supported state an operator may be in on purpose, „der gespeicherte ist
 * unlesbar" is a fault, and an installation that hit the second one used to get
 * **no line at all** — the notice swallowed every exception, so the one case the
 * notice exists for was the one case it stayed silent about (a review
 * finding). Only variable names and the readable reason appear in it; never a value.
 */
export const MAIL_CONFIG_BROKEN_STARTUP_ERROR =
  'Der in den Systemeinstellungen gespeicherte SMTP-Block ist unlesbar. ' +
  'Betriebsalarme und die Testmail der Systemverwaltung gehen nicht hinaus.';

/**
 * The reason a row carries when **we** could not produce its text.
 *
 * A fixed sentence rather than the exception's message, and only for the
 * exceptions the renderer does not declare: an unexpected failure in there
 * (a Prisma error, a `TypeError`) carries a message written for a developer,
 * and this row is about somebody's answer — the one place a stray value would
 * be copied into a column an editor reads (a security finding).
 */
export const MAIL_RENDER_FAILED_REASON =
  'Die Nachricht konnte nicht erzeugt werden. Der Versuch wird später ' +
  'wiederholt.';

/**
 * What a render failure may say in `mail_log.last_error`.
 *
 * The renderer declares two refusals („kein Text gespeichert", „Einstellungen
 * nicht lesbar") and both are written *for* the mail log — plain
 * `Error`s with a complete German sentence and no value in them. Anything whose
 * `name` is not `Error` is a `TypeError`, a Prisma error or another defect: its
 * message was written for a developer, may quote a query, and does not belong in
 * a column. Narrow, and the narrowness is deliberate — the durable fix is a
 * declared error type in `queued-body-renderer.ts`, which belongs to another
 * package.
 *
 * **A failure of ours never reaches the categorisation of a remote's.** It used
 * to need a marker class for that (`MailRenderError`), because rendering and
 * sending shared one `try`: without it, a body that would not render was
 * recorded as „Der Mailserver hat die Nachricht nicht angenommen" — a mail
 * server that was never asked, named as the culprit, in the sentence the organisation's
 * admin acts on. Since the delivery step moved to `mail-delivery.ts` the two are
 * different statements in {@link MailWorkerService.attemptDelivery}, so the
 * marker has nothing left to mark.
 */
function renderFailureReason(error: unknown): string {
  return error instanceof Error && error.name === 'Error'
    ? describeMailError(error)
    : MAIL_RENDER_FAILED_REASON;
}

/**
 * What one queue attempt did — **and whether it ever chose an identity**
 * (the requirement).
 *
 * The second half is why this is not simply the `MailDeliveryOutcome` of
 * `mail-delivery.ts`. Both of the queue's failure kinds arrive as
 * `{ kind: 'failed' }` and are indistinguishable from outside: „der Mailserver
 * hat abgelehnt" and „der Rumpf ließ sich nicht rendern". Only the first of
 * them happened *under* an identity; the second never reached a transport, and
 * a row that named one would send SPF/DKIM triage after a host that never saw
 * the message. Reporting it from the attempt, rather than deriving it beside
 * the call, is what keeps the two apart — the same rule the `fail` arm of the
 * resolution already follows: no transport asked → no identity.
 */
type QueuedAttempt =
  | {
      readonly kind: 'sent';
      /** A mail that went out went out **under** something; never `null`. */
      readonly attempted: AttemptedIdentity;
    }
  | {
      readonly kind: 'failed';
      /** German, free of credentials, and safe for `mail_log.last_error`. */
      readonly reason: string;
      /** The attempt ended on our own send deadline — the remote went quiet. */
      readonly stalled: boolean;
      /** The identity the transport was asked with — `null` if none was. */
      readonly attempted: AttemptedIdentity | null;
    };

/**
 * Whether a claimed row arrived **without** its organisation's `smtp` column.
 *
 * Takes `unknown` and asks two questions, because there are two shapes: a
 * `delete` leaves the key out, and `{ ...row, tenantSmtp: undefined }` — the
 * spread somebody writes to clear a field, and the commoner of the two — leaves
 * the key in place with `undefined` in it. A check on the key alone waves the
 * second one through, and `undefined` resolves to „diese Organisation hat
 * keinen Mailserver" exactly like a genuine NULL — a queue that silently stops
 * rather than one that misdirects (ADR-0023).
 *
 * The declared type of {@link ClaimedMail} says the column is always read; this
 * is the check for the day that declaration turns out to have been a promise
 * rather than a proof, because a `$queryRaw` types its own result. The same
 * check now also guards `MailIdentityService.resolve` itself, so a *second*
 * caller of the resolution inherits it; this one stays because the claim is a
 * different projection with a different way of losing the column.
 */
function claimedSmtpMissing(claimed: unknown): boolean {
  if (
    typeof claimed !== 'object' ||
    claimed === null ||
    !('tenantSmtp' in claimed)
  ) {
    return true;
  }
  return claimed.tenantSmtp === undefined;
}

/**
 * A claimed row does not belong in the lane that claimed it.
 *
 * A defect and not a mail problem, exactly like {@link
 * MailIdentityColumnMissingError} — and a class of its own for the same reason:
 * both end the **run** instead of skipping a lane, because carrying on would
 * mean sending under the wrong identity. What would go wrong here is the
 * privilege escalation of ADR-0020: a reset mail over the mail server
 * `can_manage_settings` enters.
 *
 * It can only come about if the lane condition in the `WHERE` of the two claim
 * statements no longer holds (`MailLaneKey`) — a promise in the SQL, checked at
 * the result.
 */
export class MailLaneMismatchError extends Error {}

/**
 * Which exception ends the **run** instead of costing only one lane.
 *
 * One version for the two places that decide it. The list is short and is meant
 * to stay so: everything else — a transaction out of budget, an exhausted pool,
 * a database that is gone — is this lane's bad luck and must not take away from
 * the others the work they have already handed over (a review finding). What
 * stands here are the two defects for which carrying on would mean „unter der
 * falschen Identität senden".
 */
function endsTheRun(error: unknown): boolean {
  return (
    error instanceof MailIdentityColumnMissingError ||
    error instanceof MailLaneMismatchError
  );
}

/**
 * Whether the claim saw the same stored block the lane was resolved from.
 *
 * `JSON.stringify` of two `jsonb` values read by two statements of the same run:
 * Postgres normalises key order in `jsonb`, so the comparison is a string
 * compare and cannot be defeated by ordering. Both values are sealed ciphertext
 * — nothing is opened here and nothing is logged.
 */
function sameStoredSmtp(claimed: unknown, resolvedFrom: unknown): boolean {
  return JSON.stringify(claimed) === JSON.stringify(resolvedFrom);
}

/**
 * One lane: its rows, and the **one** identity they all go out under.
 *
 * ## „Eine Bahn = eine Identität" — restored (a review finding)
 *
 * For a while a lane carried two identities: the organisation's for everything
 * a form had triggered, and the installation's for a system mail. That was the
 * shortest way to ADR-0020, but it pulled the precondition out from under the
 * worker's withholding path — that one stamps its reason on the lane's
 * remaining rows and breaks it off, *because every one of them would get the
 * same answer*. With two identities in one lane the sentence no longer held,
 * and a single system mail permanently stopped the queue of an organisation
 * with a working mail server of its own. The reasoning at length stands at
 * {@link MailLaneKey}.
 *
 * The lane is therefore cut along the identity: one
 * {@link TenantLane} per organisation with due form mail, and **one**
 * {@link SystemLane} for the system mails of all organisations.
 *
 * The identity is resolved **before** the first transaction, for the same
 * reason as before: a resolution in the claim would take a second connection
 * while the first holds the whole SMTP conversation.
 */
type MailLane = TenantLane | SystemLane;

/** One organisation's lane: everything that is not `trigger = 'system'`. */
interface TenantLane extends DueTenant {
  readonly kind: 'tenant';
  /**
   * This organisation's mail server — or `withhold` if it has none. Since
   * ADR-0023 there is no third possibility „der der Installation" here.
   */
  readonly identity: MailIdentityResolution;
}

/**
 * The system lane: every due `trigger = 'system'` row, across organisations.
 *
 * A single one per run, because it is a single identity — the same reasoning
 * {@link SYSTEM_IDENTITY_KEY} keys the transport cache from. It carries no
 * `tenantSmtp`: the organisation's column is not even looked at on this path,
 * and that is the security boundary of ADR-0020, not an omission.
 *
 * ⚠️ **Its meaning has been narrower since ADR-0023**: it carries the mail of
 * the **installation**, no longer the mail of inheriting organisations. What an
 * organisation sends goes over its own mail server or not at all.
 */
interface SystemLane {
  readonly kind: 'system';
  readonly identity: MailIdentityResolution;
}

/** What the repository's statements recognise a lane by. */
function laneKey(lane: MailLane): MailLaneKey {
  return lane.kind === 'system'
    ? { kind: 'system' }
    : { kind: 'tenant', tenantId: lane.tenantId };
}

/** What one claimed row did — „withheld" is not an attempt (ADR-0013 no. 5). */
type RowOutcome =
  | {
      readonly kind: 'sent' | 'deferred' | 'failed';
      /** The attempt ended on the worker's own send deadline (S1). */
      readonly stalled?: boolean;
    }
  /** Nothing was attempted; the claimed row learnt why, the others follow. */
  | {
      readonly kind: 'withheld';
      readonly count: number;
      readonly claimedId: string;
      readonly reason: string;
    };

/** How many rows one run may still take, shared by all its lanes. */
interface RunBudget {
  remaining: number;
}

/** The counters one run fills in; every lane writes into the same object. */
type RunTotals = {
  -readonly [K in keyof MailWorkerRun]: MailWorkerRun[K];
};

/** What one `runOnce()` did. Counted, never guessed — the tests read this. */
export interface MailWorkerRun {
  /**
   * Rows claimed and decided. The measure of „did this worker do work".
   *
   * Rows the run **withheld** are deliberately not in here: nothing was
   * attempted and nothing refused, which is the whole of ADR-0013 no. 5's first
   * row. A row refused for a broken stored block *is*, because the run reached a
   * verdict on it and wrote it down.
   */
  readonly attempted: number;
  readonly sent: number;
  /** Attempts that failed with attempts to spare; the row stays `queued`. */
  readonly deferred: number;
  /** Rows that used up `MAIL_MAX_ATTEMPTS` and are now `failed`. */
  readonly failed: number;
  /**
   * Rows newly stamped with the „kein Mailserver" reason because the identity
   * they go out under has no mail server.
   *
   * **Per lane**, and that is why it is not simply „the whole table": one
   * organisation can be waiting for a mail server while the one next to it sends
   * over its own in the same run — and since ADR-0020 the same holds *within* an
   * organisation, between its own mail and the system mail that goes over the
   * installation. A reason that is stamped beyond the lane stands on rows for
   * which it is demonstrably false (a review finding).
   */
  readonly withheld: number;
  /**
   * Lanes that ended on something that was not a row's outcome — a transaction
   * that timed out, a pool that was exhausted, a database that went away.
   *
   * Counted rather than thrown, and that is the fix: a rejected lane used to
   * take the whole `runOnce` with it **after** the other lanes had committed, so
   * a run in which seven lanes delivered forty mails reported „failed" and zero
   * sent — the totals were discarded together with the exception (a review
   * finding). The one thing that still ends a run is a defect: a claim that lost the
   * `smtp` column, where carrying on would mean sending under the wrong
   * identity.
   */
  readonly laneFailures: number;
}

/**
 * The mail queue worker (ADR-0004).
 *
 * Claims one row at a time with `FOR UPDATE SKIP LOCKED`, delivers it, and
 * records the outcome inside the same transaction. Retries with a growing
 * backoff up to `MAIL_MAX_ATTEMPTS`, then gives up with a readable reason.
 *
 * **One lane per organisation since the requirement**, run in parallel and serial
 * within: the worker has several remotes now (ADR-0013), and a run that walked
 * the table in one loop let an organisation whose mail server accepts the connection and
 * then goes quiet occupy the whole installation's run. The timeouts of
 * `mail-timeouts.ts` bound one *attempt*; they say nothing about how much of a
 * run one organisation may have.
 *
 * **And which identity a row goes out under is resolved per row**, not per
 * process — the three arms of ADR-0013 no. 5 each act on the row they were
 * resolved for, and **none of them ends the run**. That is the shape a
 * review asked for: an unreadable stored block used to throw before a single row
 * was claimed, for every organisation at once, leaving nothing behind but a log line.
 *
 * **At-least-once, on purpose** (ADR-0004): the transport is asked *before* the
 * status is written, so a crash in between re-delivers on the next run. What it
 * must never do is produce a second log line — and it cannot, because the row
 * is the queue entry, not a record appended after the fact.
 *
 * **The scheduler starts only when `MAIL_WORKER_INTERVAL_MS` is greater than
 * zero**, and the test application sets zero. A
 * worker that starts on its own drains queues another suite is in the middle of
 * counting; the failure looks like flakiness rather than like a setting. Suites
 * call {@link runOnce} instead, which is also the only reason the backoff
 * is expressible at all.
 */
@Injectable()
export class MailWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MailWorkerService.name);
  private timer: NodeJS.Timeout | undefined;
  /**
   * The tick in flight, if any.
   *
   * Both a re-entrancy guard and what shutdown waits for: a run that outlived
   * `close()` would keep querying a database the caller has already torn down,
   * and the error it logs on the way out reads like a defect rather than like
   * a race with shutdown.
   */
  private ticking: Promise<void> | undefined;

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly prisma: PrismaService,
    private readonly repository: MailQueueRepository,
    private readonly transport: MailTransport,
    /**
     * „Welche Identität gilt für diese Zeile?" (ADR-0013 no. 5).
     *
     * A collaborator rather than a method here: the three arms are decided
     * without a queue and tested without one, and what this class owns is what
     * each arm does to a row.
     */
    private readonly identities: MailIdentityService,
    private readonly renderer: MailBodyRenderer,
    private readonly clock: MailClock,
    /**
     * The bookkeeping about this run (ADR-0016) — one
     * row per run, on success **and** on failure.
     */
    private readonly jobRuns: JobRunService,
    @Inject(MAIL_TIMEOUTS) private readonly timeouts: MailTimeouts,
  ) {}

  /**
   * **Asynchronous**, because „is there a mail server?" is a row
   * now and no longer a constructor argument. Nest awaits it, and that is the
   * point: the notice of the requirement is counted by its test, and a
   * fire-and-forget version would make that count a race — green on a fast
   * machine, absent on a slow one, and nobody would suspect the assertion.
   *
   * Waiting costs one query at boot, after `PrismaService` has connected in its
   * own `onModuleInit`. A database that is not up fails there, loudly, rather
   * than here.
   */
  async onModuleInit(): Promise<void> {
    // Exactly here and nowhere else. Saying it again per send would still
    // satisfy a `toContain`, and would bury the one line an operator needs
    // under one line per mail.
    await this.warnIfUnconfigured();

    const interval = this.env.MAIL_WORKER_INTERVAL_MS;
    if (interval <= 0) {
      return;
    }
    this.timer = setInterval(() => void this.tick(), interval);
    // An interval must not be the reason a process refuses to exit — a CLI
    // task or a test harness that forgot one `close()` would hang forever.
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.ticking;
  }

  /**
   * Whether the periodic run is armed.
   *
   * Exported as state rather than derived from the environment by the caller,
   * because that is the promise worth checking: „the interval is 0" is the
   * mechanism, „nothing is scheduled" is what the suites depend on.
   */
  get schedulerRunning(): boolean {
    return this.timer !== undefined;
  }

  /**
   * Works the queue until it is empty (or the batch cap is reached) and reports
   * what happened.
   *
   * Public and side-effect-complete on purpose: it is what the scheduler calls,
   * what a future „send now" button would call, and what every test in this
   * file drives.
   */
  async runOnce(): Promise<MailWorkerRun> {
    const totals: RunTotals = {
      attempted: 0,
      sent: 0,
      deferred: 0,
      failed: 0,
      withheld: 0,
      laneFailures: 0,
    };

    // **Nothing is asked about the installation before a row is claimed.** It
    // used to be: `transport.configured()` stood here, outside every `try`, and
    // an unreadable stored block made it throw — so `runOnce` rejected, `tick`
    // swallowed, and **not one row of any Organisation** was claimed, without a
    // `last_error`, without a `failed`, visible only in the server log. One
    // broken block stopped the queue of the whole installation (a review
    // finding). „Ist etwas eingerichtet?" is a question per row now, and every one
    // of its three answers is an answer *about that row*.
    //
    // The `try` around it is the same lesson one statement further down: this
    // line stood outside every one of them, so a database hiccup here stalled
    // the whole run in exactly the shape that was just fixed.
    let tenants: DueTenant[];
    let systemDue: boolean;
    try {
      // **The system lane first, because it costs one of this run's lanes.**
      // The arithmetic at `MAIL_WORKER_TENANT_LANES` counts connections, not
      // organisations: a lane is a connection, and the system lane is a lane.
      // Laying it on top would mean overdrawing the pool by one connection per
      // run — exactly the fault this arithmetic once cleared up. An organisation
      // that no longer fits into the run because of it is the one of the next
      // tick: `dueTenants` orders by the oldest waiting mail, being skipped only
      // makes older.
      systemDue = await this.repository.systemMailDue(this.clock.now());
      tenants = await this.repository.dueTenants(
        this.clock.now(),
        MAIL_WORKER_TENANT_LANES - (systemDue ? 1 : 0),
      );
    } catch (error: unknown) {
      totals.laneFailures += 1;
      this.logger.error(
        `mail queue: no due Organisationen read — ${describeMailError(error)}`,
      );
      return totals;
    }

    const lanes = await this.resolveLanes(tenants, systemDue, totals);
    const budget: RunBudget = { remaining: MAIL_WORKER_BATCH_MAX };

    // One lane per organisation, in parallel — the requirement. `allSettled` and not
    // `all`: a lane that fails must not abandon the others mid-transaction, and
    // an organisation whose mail server is dead must not decide how much of this run the
    // rest of the installation gets.
    const settled = await Promise.allSettled(
      lanes.map((lane) => this.drainTenant(lane, budget, totals)),
    );

    const broken = settled.find((lane) => lane.status === 'rejected');
    if (broken !== undefined) {
      // Only a *defect* reaches here now — everything else was counted in
      // `laneFailures` and left the other lanes' work intact. It is re-raised
      // after they have finished and committed.
      throw broken.reason instanceof Error
        ? broken.reason
        : new Error(String(broken.reason));
    }
    return totals;
  }

  /**
   * Which identity each due Organisation sends under — **resolved before the first
   * transaction opens**, once per organisation per run.
   *
   * Why it is here rather than inside `deliverOne`: **the pool.** A resolution
   * inside the claim transaction takes a *second* connection while the first is
   * held for the whole SMTP conversation. See {@link MAIL_WORKER_TENANT_LANES}
   * for the arithmetic that broke.
   *
   * An organisation whose resolution *throws* loses its lane and nothing else. The one
   * exception is the missing-column defect, which must end the run rather than
   * skip an organisation: carrying on would mean sending under the wrong identity.
   *
   * **The system lane is resolved here just the same** and goes the same way
   * through `try`: an installation whose stored block is unreadable loses its
   * system lane and nothing else — the organisations go on sending in the same
   * run.
   *
   * ⚠️ **Since ADR-0023 no organisation shares the installation's
   * resolution.** Before, an organisation with an empty `smtp` column got
   * exactly the system lane's result handed back — that was the inheritance,
   * and it is abolished: an empty column now resolves to `withhold`, per
   * organisation, and the system block is not even read for it.
   */
  private async resolveLanes(
    tenants: readonly DueTenant[],
    systemDue: boolean,
    totals: RunTotals,
  ): Promise<MailLane[]> {
    const lanes: MailLane[] = [];

    if (systemDue) {
      try {
        lanes.push({
          kind: 'system',
          identity: await this.identities.resolve(
            // Neither field is read by the system arm — it ends before it
            // looks at the column. Something telling is passed anyway instead
            // of a borrowed organisation id: the system lane belongs to
            // none.
            { id: SYSTEM_IDENTITY_KEY, smtp: null },
            'system',
          ),
        });
      } catch (error: unknown) {
        if (endsTheRun(error)) {
          throw error;
        }
        totals.laneFailures += 1;
        this.logger.error(
          `mail queue: the installation's sending identity could not be resolved — ${describeMailError(error)}`,
        );
      }
    }

    for (const tenant of tenants) {
      try {
        lanes.push({
          ...tenant,
          kind: 'tenant',
          // Always over this organisation's column, even when it is empty
          // (ADR-0023). The earlier short circuit „leer ⟹ Systemblock" was the
          // inheritance; without it an empty column costs a resolution without
          // a query — `openTenantBlock(null, …)` reads nothing.
          identity: await this.identities.resolve(
            { id: tenant.tenantId, smtp: tenant.tenantSmtp },
            'tenant',
          ),
        });
      } catch (error: unknown) {
        if (endsTheRun(error)) {
          throw error;
        }
        totals.laneFailures += 1;
        this.logger.error(
          `mail queue: an organisation's sending identity could not be resolved — ${describeMailError(error)}`,
        );
      }
    }
    return lanes;
  }

  /**
   * Works one lane's queue until it is empty, a budget is used up, or the lane's
   * identity turns out to have no mail server at all.
   *
   * Serial **within** a lane on purpose: that is one SMTP conversation at a
   * time over one cached connection, which is what a mail server expects from
   * one sender. The parallelism that what is required is is between lanes,
   * not inside one.
   *
   * **It refuses only on a defect.** Everything else — a transaction that ran
   * out of budget, an exhausted pool, a database that went away — is this
   * lane's bad luck for this run: it is logged, counted and left behind, and
   * the other lanes keep the work they have already committed.
   */
  private async drainTenant(
    lane: MailLane,
    budget: RunBudget,
    totals: RunTotals,
  ): Promise<void> {
    try {
      await this.drainLane(lane, budget, totals);
    } catch (error: unknown) {
      if (endsTheRun(error)) {
        throw error;
      }
      totals.laneFailures += 1;
      // Counts and a reason, no address and no tenant. What a
      // *remote* said is on its own row; what can arrive here is ours.
      this.logger.error(
        `mail queue: a lane ended early — ${describeMailError(error)}`,
      );
    }
  }

  private async drainLane(
    lane: MailLane,
    budget: RunBudget,
    totals: RunTotals,
  ): Promise<void> {
    // The shared budget is checked without a lock, so a run may overshoot
    // `MAIL_WORKER_BATCH_MAX` by at most one row per lane. That is deliberate:
    // its job is to make a run *end*, not to be an exact quota, and a lock
    // around it would serialise the very thing the requirement wants parallel. The
    // per-lane share is what keeps one organisation from spending all of it.
    let mine = MAIL_WORKER_LANE_BATCH_MAX;
    while (budget.remaining > 0 && mine > 0) {
      const outcome = await this.deliverOne(lane);
      if (outcome === null) {
        return;
      }
      budget.remaining -= 1;
      mine -= 1;

      if (outcome.kind === 'withheld') {
        // The claimed row was stamped inside its transaction; the lane's other
        // waiting rows are stamped **now that it has committed**. Doing both in
        // there is what made two worker instances deadlock (`withholdOthers`).
        const others = await this.repository.withholdOthers(
          laneKey(lane),
          outcome.claimedId,
          outcome.reason,
        );
        totals.withheld += outcome.count + others;
        // Every other row **of this lane** would get the same answer, and it has
        // just been written on all of them. Carrying on would claim them one by
        // one to say so again.
        //
        // „Dieser Bahn" and not „dieser Organisation", and the difference has
        // been a production fault: as long as a lane carried two identities, a
        // single reset mail held back the registration confirmations of an
        // organisation with a working mail server of its own for ever — and
        // wrote a reason on them that was demonstrably false. See
        // `MailLaneKey`.
        return;
      }

      totals.attempted += 1;
      totals[outcome.kind] += 1;

      if (outcome.stalled === true) {
        // The remote accepted the connection and then went quiet for the whole
        // send budget. The next row would buy the same silence at the same
        // price, and ten of them is the better part of an hour in which this
        // run does not end and no new one starts (a security finding).
        return;
      }
    }
  }

  /**
   * Claims one row of one lane, acts on it under **that lane's** identity, and
   * records the outcome — all inside one transaction, so the lock outlives the
   * send.
   *
   * `null` means this lane had nothing due. It is not an error and not a
   * failure: that is the ordinary answer on a quiet installation, and it is
   * also the answer a second worker gets when the first one holds the only due
   * row.
   */
  private async deliverOne(lane: MailLane): Promise<RowOutcome | null> {
    return this.prisma.$transaction(
      async (tx) => {
        const claimed =
          lane.kind === 'system'
            ? await this.repository.claimSystem(tx, this.clock.now())
            : await this.repository.claim(tx, this.clock.now(), lane.tenantId);
        if (claimed === null) {
          return null;
        }

        /**
         * **The lane decides, and the row has to match it** (ADR-0020, a review
         * finding).
         *
         * Before, a choice between two resolved answers stood here, because the
         * lane carried two. The mapping „`trigger = system` ⟹
         * Systemidentität" now lies in the `WHERE` of the two claim statements
         * (`MailLaneKey`), that is *before* the claim instead of after it —
         * that is what gives the withholding path its precondition back.
         *
         * What remains here is the guard for it, for the same reason as
         * {@link claimedSmtpMissing} one line further down: `$queryRaw` types
         * its own result, the lane condition is a promise in the SQL and no
         * proof. A row in the wrong lane would go out under the wrong identity
         * — exactly the privilege escalation ADR-0020 stands against — and
         * **nothing would turn red**, because the mail goes out. That is why it
         * is asked via `identitySourceOf` and not via a comparison of its own:
         * the mapping keeps one version.
         */
        const rowIsSystem = identitySourceOf(claimed.trigger) === 'system';
        if (rowIsSystem !== (lane.kind === 'system')) {
          throw new MailLaneMismatchError(
            'claimed mail row does not belong to the lane that claimed it — refusing to send',
          );
        }
        const identity = lane.identity;

        if (claimedSmtpMissing(claimed)) {
          // A defect, deliberately loud, and deliberately *not* a mail problem.
          // `null` is „diese Organisation hat keinen Mailserver"; a missing
          // value is „die Spalte wurde nicht gelesen", and both resolve to
          // `withhold`. So a projection that lost `t."smtp"` would hold the
          // whole queue of that organisation for ever, with a reason that is
          // false, and **every test would stay green** — because `withhold` is
          // a supported state and nothing turns red. The type says it cannot
          // happen; this says it out loud when a raw query's typing turns out
          // to have been a promise.
          throw new MailIdentityColumnMissingError(
            'claimed mail row carries no tenant smtp column — refusing to send',
          );
        }

        // Only in an organisation's lane, because only there is it a question:
        // the system lane resolves its identity from the system settings and
        // never looks at the organisation's column (ADR-0020), so there is
        // nothing that could have changed between resolution and claim — and
        // its rows come from several organisations anyway, against whose
        // columns a comparison would make no sense at all.
        if (
          lane.kind === 'tenant' &&
          !sameStoredSmtp(claimed.tenantSmtp, lane.tenantSmtp)
        ) {
          // The organisation saved a different mail server between the moment this run
          // resolved its identity and the moment this row was claimed. Nothing
          // is sent under the old one and nothing is guessed about the new one:
          // the row stays exactly as it was found and the next run — seconds
          // away — resolves again.
          this.logger.log(
            'mail queue: a sending identity changed mid-run; the remaining ' +
              'mail of that organisation waits for the next run',
          );
          return null;
        }

        if (identity.kind === 'withhold') {
          // Not `failed`, and **no attempt counted** — nothing was refused and
          // nothing was tried (ADR-0013 no. 5, first row). This is the state a
          // freshly set-up installation is in, and it has to resolve itself the
          // moment somebody enters a mail server.
          //
          // Only *this* row, inside this transaction; the lane's others are
          // stamped by the caller once it has committed (`withholdOthers`).
          const count = await this.repository.withholdClaimed(
            tx,
            claimed.id,
            identity.reason,
          );
          return {
            kind: 'withheld',
            count,
            claimedId: claimed.id,
            reason: identity.reason,
          };
        }

        if (identity.kind === 'fail') {
          // A stored block that is mixed, half-filled or will not open. Straight
          // to `failed` with `attempts` untouched: no transport was asked, so
          // counting an attempt would claim one happened — and retrying would
          // ask the same broken column again on a schedule.
          await this.repository.markFailed(
            tx,
            claimed.id,
            claimed.attempts,
            identity.reason,
            // No identity was resolved, so none is recorded — see
            // `MailQueueRepository.markFailed`. „Der gespeicherte Block ist
            // kaputt" is not „es scheiterte unter Block X".
            null,
            this.clock.now(),
          );
          return { kind: 'failed' };
        }

        const sending: SendingIdentity = {
          key:
            identity.source === 'system'
              ? SYSTEM_IDENTITY_KEY
              : claimed.tenantId,
          block: identity.block,
        };
        const attempts = claimed.attempts + 1;
        /**
         * What every outcome below records (the requirement) — reported **by
         * the attempt**, not computed beside it.
         *
         * `attempted` used to be derived here, before the attempt, and was
         * then written by every arm below. That was wrong for the one arm that
         * asks no transport: a body that will not render fails without a mail
         * server ever hearing of the row, and the line still read „Eigener
         * Mailserver dieser Organisation (post@…)" — which is precisely the SPF/DKIM
         * triage this column exists for, pointed at an innocent host. The
         * attempt now says whether an identity was **chosen**, so the render
         * failure records `null` for the same reason the `fail` arm above does:
         * no transport asked → no identity.
         */
        const attempt = await this.attemptDelivery(claimed, sending, identity);
        if (attempt.kind === 'failed') {
          const { reason, stalled, attempted } = attempt;
          if (attempts >= MAIL_MAX_ATTEMPTS) {
            await this.repository.markFailed(
              tx,
              claimed.id,
              attempts,
              reason,
              attempted,
              this.clock.now(),
            );
            return { kind: 'failed', stalled };
          }
          const nextAttemptAt = new Date(
            this.clock.now().getTime() + mailBackoffMs(attempts),
          );
          await this.repository.markRetry(
            tx,
            claimed.id,
            attempts,
            reason,
            nextAttemptAt,
            attempted,
          );
          return { kind: 'deferred', stalled };
        }

        // Deliberately *after* the send: the mail is out either way, and a row
        // that rolls back here is re-delivered rather than lost (at-least-once,
        // ADR-0004). What it must not do is write a second row — and it cannot,
        // because this is an update of the queue entry itself.
        await this.repository.markSent(
          tx,
          claimed.id,
          attempts,
          this.clock.now(),
          attempt.attempted,
        );
        return { kind: 'sent' };
      },
      {
        maxWait: this.timeouts.claimMaxWaitMs,
        timeout: this.timeouts.claimTransactionMs,
      },
    );
  }

  /**
   * Renders one claimed row and hands it to the **shared** delivery step
   * (`mail-delivery.ts`) — the same step „Testmail senden" of the requirement goes
   * through, which is what makes that button's promise („sie geht den echten
   * Weg") true by construction rather than by two files agreeing (a review finding).
   *
   * Rendering stays here, and it stays a **separate statement**: a body that
   * would not render is a failure of *ours* and must never be categorised as
   * the remote's refusal — see {@link renderFailureReason}. What is shared is
   * the send, its deadline and the reason it produces; what stays with the
   * queue is what that outcome means for the row.
   */
  private async attemptDelivery(
    claimed: ClaimedMail,
    sending: SendingIdentity,
    identity: SendIdentity,
  ): Promise<QueuedAttempt> {
    let body: RenderedMailBody;
    try {
      body = await this.renderer.render(claimed);
    } catch (error: unknown) {
      // Nothing was sent, so nothing stalled — the deadline was never armed —
      // and **no identity was chosen**: the row failed before a transport was
      // asked, so recording one would name a mail server that never saw it
      // (the requirement, see {@link QueuedAttempt.attempted}).
      return {
        kind: 'failed',
        reason: renderFailureReason(error),
        stalled: false,
        attempted: null,
      };
    }

    const outcome = await deliverMail({
      transport: this.transport,
      timeouts: this.timeouts,
      mail: {
        to: claimed.recipient,
        subject: claimed.subject,
        text: body.text,
        ...(body.html === undefined ? {} : { html: body.html }),
        // The display name is the organisation's; the *address* comes from the block
        // and is therefore the organisation's own only when the block is (// ADR-0013 no. 3).
        fromName: claimed.tenantName,
        // The row's value frozen at enqueue time, passed on unchanged — never
        // resolved anew here. `null` in the
        // column means „keine Kopfzeile" and becomes „Feld abwesend";
        // `TestMailService` makes the same transcription for its own row.
        ...(claimed.replyTo === null ? {} : { replyTo: claimed.replyTo }),
      },
      identity: sending,
      // The queue may quote the installation's own mail server — the superadmin
      // chose that host, and its operator needs the sentence. See
      // `queueReasonStyle`; the Testmail route makes the other choice.
      reasonStyle: queueReasonStyle(identity.source),
    });

    /**
     * The transport was asked, so the row may name what it was asked with —
     * read off the **resolved** identity, never off `claimed.tenantSmtp`. The
     * column says what the organisation *stores*, this says what the attempt
     * *used* — and for the Systembahn those are not the same thing at all:
     * that lane never looks at the column.
     */
    const attempted = attemptedIdentity(identity);
    return outcome.kind === 'sent'
      ? { kind: 'sent', attempted }
      : { ...outcome, attempted };
  }

  /**
   * One scheduled run. Never rejects — an unhandled rejection from a timer
   * takes the process down, and „the mail server was unreachable" must not be
   * able to stop the application.
   *
   * The log line carries counts and nothing else: no address, no subject, no
   * tenant (CONTRIBUTING.md — keine personenbezogenen Daten in Logs).
   */
  /**
   * The once-per-process notice of the requirement, now that answering „is
   * there a mail server?" means asking the database.
   *
   * **It used to swallow every exception**, and that made it silent in the one
   * case it exists for: an installation whose stored block is unreadable got no
   * line at all, because `configured()` throws there rather than answering
   * `false` (a review finding). Now the two are told apart — a broken block is
   * said out loud, and only a genuine connection fault stays quiet.
   *
   * A database that is unreachable at boot is a fault that announces itself
   * through every route, and turning it into a second, differently-worded
   * startup error would say nothing new. What this must not do either way is
   * take the process down — an unhandled rejection out of a fire-and-forget call
   * would do exactly that.
   */
  private async warnIfUnconfigured(): Promise<void> {
    try {
      if (!(await this.transport.configured())) {
        this.logger.warn(MAIL_NOT_CONFIGURED_STARTUP_WARNING);
      }
    } catch (error: unknown) {
      if (error instanceof MailConfigUnreadableError) {
        // The message is one of two fixed German sentences and carries no value
        // — `MailSecretsService` guarantees that, because it is the sentence the
        // mail log shows.
        this.logger.error(
          `${MAIL_CONFIG_BROKEN_STARTUP_ERROR} ${error.message}`,
        );
        return;
      }
      // Deliberately silent — see above.
    }
  }

  private tick(): Promise<void> {
    this.ticking ??= this.runTick().finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }

  private async runTick(): Promise<void> {
    try {
      // The bookkeeping lies **inside**, around `runOnce()`, not around the
      // whole `try`: it is meant to describe the run, not the logging
      // afterwards.
      const run = await this.jobRuns.recordRun(
        JobKind.mail_worker,
        async () => {
          const result = await this.runOnce();
          return { result, itemCount: result.attempted };
        },
      );
      if (run.attempted > 0 || run.withheld > 0 || run.laneFailures > 0) {
        this.logger.log(
          `mail queue: ${String(run.sent)} sent, ${String(run.deferred)} deferred, ` +
            `${String(run.failed)} failed, ${String(run.withheld)} withheld, ` +
            `${String(run.laneFailures)} lanes ended early`,
        );
      }
    } catch (error: unknown) {
      // No redaction list, and none is needed: everything a *remote* said is
      // recorded on its own row inside `deliverOne`, under that row's block.
      // What can still arrive here is a defect of ours — and a defect that
      // carried an organisation's password would be a defect in this file, not something
      // a filter should be papering over.
      this.logger.error(`mail queue run failed: ${describeMailError(error)}`);
    }
  }
}
