import { Injectable } from '@nestjs/common';
import { Prisma, type NotificationTrigger } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import {
  mailIdentityColumns,
  type AttemptedIdentity,
} from './mail-identity.service';

/**
 * Every database statement the mail queue makes, in one place.
 *
 * Split out of the worker so the orchestration (claim → send → record) can be
 * read without SQL in the way — and so the „at-least-once" promise of ADR-0004
 * is *testable*: the promise says a crash between a successful send and the
 * status write may deliver twice but must not produce a second log line, and
 * the only honest way to stage that is to make the status write itself fail.
 * With the write behind a named method a test replaces exactly that one step;
 * with it inlined in the worker there is nothing to aim at.
 *
 * ---------------------------------------------------------------------------
 * **This file uses `PrismaService` directly, and `apps/api/src/mail/**` is on
 * the allow-list of `eslint.config.js` for it.** The queue is an installation
 * resource, not an organisation's datum: there is no request behind the worker, no
 * caller and no tenant parameter, and the row selection below is `status` and
 * `next_attempt_at` — never an input from outside. The *reading* side of the
 * mail log is the counter-check and goes strictly through
 * `ScopedMailLogDelegate` in `src/mail-log/`, which is deliberately **not** on
 * that list. Whoever is tempted to reuse this repository from a request-facing
 * service should read the block in `mail.module.ts` first.
 * ---------------------------------------------------------------------------
 */

/** One row the worker has taken out of the queue and now owns for this run. */
export interface ClaimedMail {
  readonly id: string;
  readonly tenantId: string;
  readonly formId: string | null;
  /**
   * The submission this row was queued for, or null once that answer is
   * gone.
   *
   * **Not for the body any more** : the text is
   * frozen in the two columns below. What it is still read for is the one thing
   * that must not be frozen — whether the participant's edit link still leads
   * anywhere. Null means it does not, and the mail
   * goes out without it.
   *
   * `notification_id` is deliberately **not** claimed. The worker had it only to
   * fetch the template back; nothing in the send path reads a notification now,
   * and a field nobody reads invites the query that would reintroduce the drift.
   * The column itself stays — the mail log shows the notification's
   * name.
   */
  readonly responseId: string | null;
  /**
   * **`string` and not `string | null`, although the column is nullable since
   * the requirement** — because `NOT_ERASED` is in the `WHERE` of the only two
   * statements that produce this type. A blanked row is not claimable, so a
   * claimed row has an address; take that condition out and this declaration
   * becomes a promise the database does not keep.
   */
  readonly recipient: string;
  /**
   * Why this row goes out — and since ADR-0020 **a security condition and not
   * a caption**.
   *
   * `system` means: no form triggered it, the application did. For such a row
   * the worker resolves the **system identity** instead of the organisation
   * identity of this lane, and the body renderer builds its link only from the
   * base address of the installation. Without this column in the `SELECT`
   * there would be no condition for both to hang on — and a password reset
   * would run over a mail server that `can_manage_settings` enters.
   */
  readonly trigger: NotificationTrigger;
  /** Likewise — see {@link ClaimedMail.recipient}; the four columns are blanked together. */
  readonly subject: string;
  /**
   * The body as it was rendered when the answer arrived, `{{bearbeiten}}` still
   * open (`EDIT_LINK_MARK`).
   *
   * Null on a row written before the body was frozen. That is not „empty mail":
   * there is nothing to send and the delivery fails with a readable reason.
   */
  readonly bodyText: string | null;
  /** The HTML half, or null for a plain-text notification. */
  readonly bodyHtml: string | null;
  /**
   * The effective `Reply-To` value of this row, or `null` for "no header
   * line" .
   *
   * **From the column, never from the notification.** The value was fixed when
   * it was queued — like recipient, subject and body —, and the worker does
   * not touch the notification at all any more: `notification_id` is
   * `SetNull`, so a value resolved here would silently disappear as soon as
   * somebody deletes the notification. The reasoning is written out at
   * `MailLog.replyTo` in `schema.prisma`.
   */
  readonly replyTo: string | null;
  /** Attempts **before** this one. Zero on a row that was never tried. */
  readonly attempts: number;
  /**
   * Display name of the organisation, for the `From` header.
   *
   * Read here in the claim rather than by `QueuedBodyRenderer`, because the
   * *address* is an installation property (`SMTP_FROM`) and the *name* belongs
   * to the tenant of this very row — joining it where the row is claimed means
   * there is exactly one answer to „which Organisation is this from" and it is the same
   * `tenant_id` the row carries.
   */
  readonly tenantName: string;
  /**
   * The organisation's stored sending identity, **sealed and unparsed** — the column,
   * verbatim.
   *
   * ## Why it is not optional, and why that is a security property
   *
   * `null` is the SQL NULL and means „diese Organisation hat keinen
   * Mailserver" (ADR-0023). `undefined` would mean „the column was not read",
   * and `parseStoredSmtpBlock(undefined)` answers `null` — the *same* answer.
   * So a projection that quietly dropped this field would hold the whole queue
   * of an organisation **with its own block**: every row `queued` for ever,
   * with a reason that is false, and **nothing turns red**, because `withhold`
   * is a supported state and nothing failed.
   *
   * Hence `Prisma.JsonValue | null` and not `unknown`: leaving the column out of
   * the `SELECT` has to be a compile error, and the worker additionally refuses
   * a row whose value is `undefined` at run time — a raw query's typing is a
   * promise, not a proof.
   *
   * It leaves here **unopened**. `MailSecretsService` holds the key; a
   * repository that decrypted would be a second place that does.
   */
  readonly tenantSmtp: Prisma.JsonValue | null;
}

/** The transaction a claimed row is owned inside. */
export type MailTx = Prisma.TransactionClient;

/**
 * Which rows belong to **one** lane — and thereby: under which identity they
 * go out (ADR-0020, a review finding).
 *
 * ## Why the lane is cut along that and not along the organisation
 *
 * Until ADR-0020 "one lane = one organisation = **one** identity" held, and
 * the worker's whole withholding path hangs on the second half of that
 * equation: whoever withholds a row stamps the same reason onto the remaining
 * rows of the same lane and breaks it off, because every one of them would get
 * the same answer.
 *
 * Since ADR-0020 that is no longer true: a `trigger = 'system'` row goes over
 * the installation, everything else over the organisation. An organisation
 * with its own block in an installation **without** a system block thereby had
 * two answers in one lane — and the system row, claimed first as the oldest,
 * withheld itself, stamped „Kein Mailserver konfiguriert" onto every
 * registration confirmation of the same organisation and broke the lane off.
 * On the next run it was the oldest again. The organisation's own, working
 * mail server was never asked.
 *
 * The lane is therefore cut along the **identity** and not along the
 * organisation: `{ kind: 'system' }` gathers the system rows of **all**
 * organisations into one lane (one identity, one connection — the same
 * consideration from which `SYSTEM_IDENTITY_KEY` keys the transport cache),
 * `{ kind: 'tenant' }` is the rest of exactly one organisation.
 * With that, "one lane = one identity" holds again, and the break-off is right
 * again.
 */
export type MailLaneKey =
  | { readonly kind: 'tenant'; readonly tenantId: string }
  | { readonly kind: 'system' };

/**
 * The rows of the lane of one organisation: everything that is **not**
 * `system`.
 *
 * As a shared fragment and not written out three times, because `dueTenants`,
 * {@link MailQueueRepository.claim} and {@link
 * MailQueueRepository.withholdOthers} have to draw exactly the same boundary —
 * a lane that sees a row which another statement does not see is exactly the
 * finding {@link MailLaneKey} stands against.
 */
const TENANT_LANE_ROWS = Prisma.sql`AND m."trigger" <> 'system'`;

/** The counter-check to it — the rows of the system lane. */
const SYSTEM_LANE_ROWS = Prisma.sql`AND m."trigger" = 'system'`;

/** Which of the two conditions leads a lane. */
function laneRows(lane: MailLaneKey): Prisma.Sql {
  return lane.kind === 'system' ? SYSTEM_LANE_ROWS : TENANT_LANE_ROWS;
}

/**
 * An organisation with something due, and the column its sending identity is resolved
 * from.
 *
 * **The column travels with the lane list**, so the resolution can happen
 * *before* the claim transaction opens. It used to happen inside it, and that
 * cost a second database connection per row while the first one was already
 * held: `MailIdentityService.resolve` reads the system settings row when an organisation
 * inherits, and with one long transaction per lane the pool ran out with no
 * timeout to end the wait (a review finding).
 *
 * It is read here rather than in a query of its own because `dueTenants`
 * already touches `tenant` — one statement per run instead of one per lane.
 */
export interface DueTenant {
  readonly tenantId: string;
  /** See {@link ClaimedMail.tenantSmtp} — same column, same reason. */
  readonly tenantSmtp: Prisma.JsonValue | null;
}

/**
 * **The trash withholds mail** — the condition both queue statements
 * carry, in one place so they cannot drift (a decision,
 * 2026-08-03).
 *
 * ## What it is for
 *
 * The body of a queued mail is frozen in `mail_log.body_text/body_html` when
 * the answer arrives; the renderer only blanks the `{{bearbeiten}}` placeholder
 * at send time. So deleting a form or an answer did **not** reach the one path
 * that actively carries data out of the house — and the recipient of a
 * notification can come out of the answer itself, i.e. be an address the
 * submitter typed. Deleting is the only handle the interface gives an editor
 * against a misused form, and until now it did not stop the mail.
 *
 * ## Why it is a withholding and not a failure
 *
 * `status`, `attempts` and `next_attempt_at` are untouched: the row simply is
 * not *claimable* while what it is about is in the trash, and it goes out
 * on the next tick after a restore. Marking it `failed` would make deleting
 * irreversible for the mail even though it is reversible for everything else —
 * a restore would give back the answer and never the confirmation that belonged
 * to it. It is the same reading ADR-0013 no. 5's first row already takes for an
 * installation without a mail server: nothing was refused, so nothing is
 * refused.
 *
 * `NOT EXISTS` rather than a join, because both columns are nullable: a system
 * mail carries neither id, and a row whose id names a live form or answer must
 * stay claimable. „Kein Bezug" is not „im Papierkorb".
 *
 * ## The deleted **organisation** lies in the same condition
 *
 * `t."deleted_at" IS NULL` is **filter 6 of the six of the requirement**, and
 * it is deliberately this fragment rather than a second one of its own —
 * the concept says so in as many words: „Damit gilt für das gelöschte Formular
 * dieselbe Regel, die für die gelöschte Organisation ohnehin gilt." Same
 * reading, same shape: `status`, `attempts` and `next_attempt_at` stay where
 * they are, and the row goes out on the next tick after the organisation is restored
 * . Marking it `failed` would make deleting an organisation irreversible for
 * its post while it is reversible for everything else.
 *
 * A direct condition on the joined row and not a `NOT EXISTS`, unlike the two
 * above: `mail_log.tenant_id` is NOT NULL, so every line belongs to an organisation and
 * there is no „kein Bezug" case to keep claimable.
 */
const NOT_IN_TRASH = Prisma.sql`
  AND NOT EXISTS (
        SELECT 1 FROM "response" r
         WHERE r."id" = m."response_id"
           AND r."deleted_at" IS NOT NULL)
  AND NOT EXISTS (
        SELECT 1 FROM "form" f
         WHERE f."id" = m."form_id"
           AND f."deleted_at" IS NOT NULL)
  AND t."deleted_at" IS NULL`;

/**
 * **A blanked row is not deliverable** .
 *
 * Physical deletion blanks `recipient`, `subject`, `body_text` and
 * `body_html` and leaves the row (`mail-log/mail-log-erasure.ts`). NULL in
 * `recipient` means exactly that and nothing else — a line that never had an
 * address carries the sentinel `(kein Empfänger)`.
 *
 * The erasure already marks a still-`queued` row `failed`, so this condition is
 * the **second** mechanism rather than the only one, in the shape the file-name
 * defence of ADR-0014 no. 10 uses: the first is a statement somebody could
 * forget to run, the second is in the `WHERE` of the only query that can hand a
 * row to a transport. Without it, `ClaimedMail.recipient` would be a `string`
 * the column no longer promises — and the row it typed would be a confirmation
 * carrying a physically deleted submission's frozen answers.
 */
const NOT_ERASED = Prisma.sql`AND m."recipient" IS NOT NULL`;

/**
 * The projection that yields a {@link ClaimedMail} — **one version for both
 * lanes**.
 *
 * Two claim statements ({@link MailQueueRepository.claim} and {@link
 * MailQueueRepository.claimSystem}) differ in their `WHERE` and in nothing
 * else. Written out separately they would be two column lists that can drift
 * apart — and the one that gets lost in the process is always `t."smtp"`: the
 * column whose absence lets a mail go out under the wrong identity without
 * anything turning red (ADR-0013 no. 2, see {@link
 * ClaimedMail.tenantSmtp}).
 */
const CLAIM_COLUMNS = Prisma.sql`
  SELECT m."id"              AS "id",
         m."tenant_id"       AS "tenantId",
         m."form_id"         AS "formId",
         m."response_id"     AS "responseId",
         m."recipient"       AS "recipient",
         m."trigger"         AS "trigger",
         m."subject"         AS "subject",
         m."body_text"       AS "bodyText",
         m."body_html"       AS "bodyHtml",
         m."reply_to"        AS "replyTo",
         m."attempts"        AS "attempts",
         t."name"            AS "tenantName",
         t."smtp"            AS "tenantSmtp"
    FROM "mail_log" m
    JOIN "tenant" t ON t."id" = m."tenant_id"`;

@Injectable()
export class MailQueueRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The organisations that have something due, oldest waiting mail first.
   *
   * **The queue is worked one lane per organisation since the requirement**, and this is
   * what the lanes are cut along. A single sequential loop over the whole table
   * meant that one organisation whose mail server accepts the connection and then goes
   * quiet occupied the run for everybody: the timeouts of `mail-timeouts.ts`
   * bound one *attempt*, they do not bound how much of a run one organisation may have.
   *
   * `LIMIT` rather than „all of them", because each lane holds an SMTP
   * connection: a run opens at most this many, and the organisations that do not fit are
   * simply the next tick's. Ordering by the oldest waiting row is what keeps
   * that from starving anybody — an organisation that was skipped only gets older.
   *
   * Not locked and not part of any transaction: it is a hint about where to
   * look, and every row it leads to is claimed properly.
   *
   * It carries {@link NOT_IN_TRASH} for the same reason {@link claim} does, and
   * the boundary is *there*, not here: this statement only decides which Organisationen
   * get a lane. Without the condition an organisation whose whole queue is withheld would
   * be handed one every run, claim nothing and end — one of the five lanes spent
   * on an organisation with nothing to do, ahead of organisations that have.
   *
   * **{@link TENANT_LANE_ROWS} for the same reason**: an organisation whose
   * only due row is a system mail gets no lane here — the row belongs in the
   * system lane ({@link systemMailDue}). Without the condition it would get a
   * lane in which it can claim nothing, and, worse, its identity would be
   * resolved for a row that is none of its business.
   */
  async dueTenants(now: Date, limit: number): Promise<DueTenant[]> {
    return this.prisma.$queryRaw<DueTenant[]>`
      SELECT m."tenant_id" AS "tenantId",
             t."smtp"      AS "tenantSmtp"
        FROM "mail_log" m
        JOIN "tenant" t ON t."id" = m."tenant_id"
       WHERE m."status" = 'queued'
         AND (m."next_attempt_at" IS NULL OR m."next_attempt_at" <= ${now})
         ${TENANT_LANE_ROWS}
         ${NOT_IN_TRASH}
         ${NOT_ERASED}
       GROUP BY m."tenant_id", t."smtp"
       ORDER BY MIN(m."created_at") ASC
       LIMIT ${limit}`;
  }

  /**
   * Whether this run needs a **system lane** at all.
   *
   * The counterpart to {@link dueTenants} for the other identity, and
   * deliberately only a yes/no: the system lane is exactly one, it has no
   * column to resolve (the installation has a block or it has none), and what
   * it would be cut along does not exist — it gathers the system rows of
   * **all** organisations.
   *
   * It is asked nevertheless, instead of always opening the lane: a lane costs
   * one of this run's lanes (see `MAIL_WORKER_TENANT_LANES`), and on an
   * installation that sees no reset mail for months that would be a lane
   * permanently given away to an empty queue.
   *
   * The same six filters as {@link claim}, for the same reason as with
   * {@link dueTenants}: "due" has to mean the same here as there, otherwise
   * the run opens a lane that finds nothing.
   */
  async systemMailDue(now: Date): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ readonly one: number }[]>`
      SELECT 1 AS "one"
        FROM "mail_log" m
        JOIN "tenant" t ON t."id" = m."tenant_id"
       WHERE m."status" = 'queued'
         AND (m."next_attempt_at" IS NULL OR m."next_attempt_at" <= ${now})
         ${SYSTEM_LANE_ROWS}
         ${NOT_IN_TRASH}
         ${NOT_ERASED}
       LIMIT 1`;
    return rows.length > 0;
  }

  /**
   * Takes the next due row **of one organisation** out of the queue, or answers `null`.
   *
   * ## The statement, and why every part of it is there
   *
   * ```sql
   * SELECT …, m."response_id", m."body_text", m."body_html", t."smtp"
   *   FROM "mail_log" m JOIN "tenant" t ON t."id" = m."tenant_id"
   *  WHERE m."tenant_id" = $2
   *    AND m."status" = 'queued'
   *    AND (m."next_attempt_at" IS NULL OR m."next_attempt_at" <= $1)
   *  ORDER BY m."created_at" ASC
   *  LIMIT 1
   *  FOR UPDATE OF m SKIP LOCKED
   * ```
   *
   * - **`FOR UPDATE OF m`** holds the row for as long as this transaction runs
   *   — which is to say, for the whole delivery attempt. That is what makes a
   *   second worker's overlap visible at all.
   * - **`SKIP LOCKED`** is what turns „two workers" into „twice the throughput"
   *   instead of „one worker and one queue". Without it the second one blocks
   *   until the first commits and then finds nothing due — it does not deliver
   *   twice, it simply does nothing, which is why the obvious „keine
   *   Doppelzustellung" test cannot prove this clause.
   * - **`OF m`**, so the `tenant` row is read but not locked. A worker has no
   *   business blocking an organisation's settings page.
   * - **`next_attempt_at` in the predicate** is what makes the backoff real. A
   *   claim that ignored it would compute a delay, store it, and pick the row
   *   up again on the next tick anyway — the backoff would be decoration
   *   (the well-known trap).
   * - **`LIMIT 1`**: one row per transaction, so a slow mail server holds one
   *   lock and not a batch, and a crash loses at most one attempt.
   * - **`m."tenant_id" = $2`** is the requirement: the lanes of one run must not
   *   compete for each other's rows, or an organisation with a dead mail server would
   *   still be able to occupy every lane there is.
   * - **`t."smtp"`**, always and never conditionally — see
   *   {@link ClaimedMail.tenantSmtp} for what a lost column would send.
   * - **{@link NOT_IN_TRASH}** is the boundary of the decision of
   *   2026-08-03: a row about a deleted form or a deleted answer is not
   *   claimable, so no transport is ever asked with it. In the `WHERE`, never
   *   as a check after the claim — a claimed row that is then put back is a
   *   row that was read, rendered and one `if` away from being sent.
   * - **{@link TENANT_LANE_ROWS}** is the boundary of ADR-0020: a system mail
   *   does not belong in the lane of its organisation but in the system lane
   *   ({@link claimSystem}). Without the condition this lane claims a row with
   *   a *different* identity than the one it was resolved for — see
   *   {@link MailLaneKey} for what came of that.
   *
   * The `now` is the injected clock's, not the database's — see `MailClock`.
   */
  async claim(
    tx: MailTx,
    now: Date,
    tenantId: string,
  ): Promise<ClaimedMail | null> {
    const rows = await tx.$queryRaw<ClaimedMail[]>`
      ${CLAIM_COLUMNS}
       WHERE m."tenant_id" = ${tenantId}::uuid
         AND m."status" = 'queued'
         AND (m."next_attempt_at" IS NULL OR m."next_attempt_at" <= ${now})
         ${TENANT_LANE_ROWS}
         ${NOT_IN_TRASH}
         ${NOT_ERASED}
       ORDER BY m."created_at" ASC
       LIMIT 1
       FOR UPDATE OF m SKIP LOCKED`;
    return rows[0] ?? null;
  }

  /**
   * The same for the **system lane**: the next due `trigger = 'system'` row,
   * across all organisations.
   *
   * Every clause stands there for the same reason as in {@link claim}; the two
   * differences are both the point:
   *
   * - **No `tenant_id` in the `WHERE`.** The system lane is cut along the
   *   identity and not along the organisation — all of these rows go over the
   *   block of the installation, that is, over *one* connection. A filter per
   *   organisation would be a lane per organisation and thereby a connection
   *   per organisation to the same mail server.
   * - **{@link SYSTEM_LANE_ROWS} instead of {@link TENANT_LANE_ROWS}.** The two
   *   conditions are complementary, and that is the promise everything hangs
   *   on: no due row falls between the lanes, and none lies in both.
   *
   * `t."smtp"` is read here too, although the identity of this lane does not
   * look at the column: the projection is the same as in {@link claim}
   * (`CLAIM_COLUMNS`), and the guard against a lost column in the worker is
   * meant to hold for both lanes — a projection that is checked on only one of
   * the two paths is half a guard.
   */
  async claimSystem(tx: MailTx, now: Date): Promise<ClaimedMail | null> {
    const rows = await tx.$queryRaw<ClaimedMail[]>`
      ${CLAIM_COLUMNS}
       WHERE m."status" = 'queued'
         AND (m."next_attempt_at" IS NULL OR m."next_attempt_at" <= ${now})
         ${SYSTEM_LANE_ROWS}
         ${NOT_IN_TRASH}
         ${NOT_ERASED}
       ORDER BY m."created_at" ASC
       LIMIT 1
       FOR UPDATE OF m SKIP LOCKED`;
    return rows[0] ?? null;
  }

  /**
   * The delivery worked. `last_error` is cleared — it described a past try.
   *
   * `identity` is what it went out under and is recorded here, in the same
   * statement as the status: the requirement asks the mail log to name
   * the block, and „gesendet" and „unter welcher Identität" are one fact.
   */
  async markSent(
    tx: MailTx,
    id: string,
    attempts: number,
    sentAt: Date,
    identity: AttemptedIdentity,
  ): Promise<void> {
    await tx.mailLog.update({
      where: { id },
      data: {
        status: 'sent',
        attempts,
        sentAt,
        nextAttemptAt: null,
        lastError: null,
        ...mailIdentityColumns(identity),
      },
    });
  }

  /**
   * The delivery failed and there are attempts left; try again after
   * `nextAttemptAt`.
   *
   * The identity is recorded although the row goes back to `queued`: it
   * describes the attempt that just happened, not a promise about the next one
   * (the next run resolves again). A line waiting after a refusal can therefore
   * say which block refused it, which is the same question the evidence asks of
   * the terminal `failed`.
   *
   * **`null` for the same reason `markFailed` takes it**: an attempt that never
   * reached a transport — a body that would not render — is deferred without an
   * identity, because there is none it was deferred *under*. Recording one
   * would point the SPF/DKIM triage this column exists for at a mail server
   * that never saw the row.
   */
  async markRetry(
    tx: MailTx,
    id: string,
    attempts: number,
    reason: string,
    nextAttemptAt: Date,
    identity: AttemptedIdentity | null,
  ): Promise<void> {
    await tx.mailLog.update({
      where: { id },
      data: {
        status: 'queued',
        attempts,
        lastError: reason,
        nextAttemptAt,
        ...mailIdentityColumns(identity),
      },
    });
  }

  /**
   * Attempts are used up. `next_attempt_at` goes back to null — nothing is due.
   *
   * **`identity` is `null` on every path that never asked a transport**: a
   * stored block that is mixed, half-filled or will not open fails the row
   * before an identity is resolved at all, and a body that will not render
   * fails it after one was resolved but before anything dialled. Neither has an
   * identity it failed *under*, and writing one would invent it. What we
   * call a „`failed`-Zeile mit Identität" is the row a mail server
   * actually refused — and only that row passes one.
   */
  async markFailed(
    tx: MailTx,
    id: string,
    attempts: number,
    reason: string,
    identity: AttemptedIdentity | null,
    /**
     * When it was given up — from the caller's {@link MailClock}, not from the
     * database's `now()`.
     *
     * The same consideration as with `createdAt` on the public path: the
     * operations alarm computes its window in Node, and a row that stands on
     * the database clock while the boundary arises on the Node clock, is the
     * two-calendar mistake `mail-clock.ts` calls by its name. In production it
     * is the same wall clock; everywhere the clock is deliberately moved —
     * that is, in every test meant to prove the window —, it is wrong
     * immediately.
     */
    failedAt: Date,
  ): Promise<void> {
    await tx.mailLog.update({
      where: { id },
      data: {
        status: 'failed',
        attempts,
        lastError: reason,
        nextAttemptAt: null,
        failedAt,
        ...mailIdentityColumns(identity),
      },
    });
  }

  /**
   * Writes the „no mail server here" reason onto the **claimed row itself**,
   * inside the transaction that owns it (ADR-0013 no. 5, first
   * row).
   *
   * `status`, `attempts` and `next_attempt_at` are deliberately untouched, and
   * all three omissions are the decision rather than an optimisation: nothing
   * was attempted, so the attempt counter must not move; nothing was refused, so
   * the row stays `queued` and a worker configured next week still sends it.
   * Only the *reason* changes, because the requirement asks for one that is readable in the
   * mail log.
   *
   * A row that already carries the reason is left alone, so a queue that waits
   * for a fortnight is not rewritten every fifteen seconds — and so the return
   * value stays meaningful („did this run newly mark it").
   *
   * ---------------------------------------------------------------------------
   * **One row, and that is the whole point of the split** (a review finding).
   * The organisation's *other* waiting rows are stamped by {@link withholdOthers} after
   * this transaction has committed. Doing both here meant one statement that
   * takes row locks across the whole organisation from inside a transaction that already
   * holds one — and ADR-0011 expects two worker instances, which is also what
   * `SKIP LOCKED` in {@link claim} is for. Instance A held row 1 and asked for
   * row 2, instance B held row 2 and asked for row 1; Postgres ends that with
   * `40P01`, the losing lane threw, and the run reported nothing.
   * ---------------------------------------------------------------------------
   */
  async withholdClaimed(
    tx: MailTx,
    id: string,
    reason: string,
  ): Promise<number> {
    const { count } = await tx.mailLog.updateMany({
      where: {
        id,
        OR: [{ lastError: null }, { lastError: { not: reason } }],
      },
      data: { lastError: reason },
    });
    return count;
  }

  /**
   * The same reason on the **remaining** waiting rows *of this lane* — after the
   * claim transaction has committed, and never inside it.
   *
   * **"This lane", not "this organisation"** (a review finding). The reason
   * this statement writes is the answer of **one** identity; stamped onto a
   * row with a different identity it is demonstrably false. Exactly that
   * happened: a reset mail in an organisation with its own, working mail
   * server wrote „Kein Mailserver konfiguriert" onto every registration
   * confirmation of that organisation. That is why this method takes a
   * {@link MailLaneKey} and not an organisation id — the same boundary that
   * {@link claim} draws, drawn by the same condition.
   *
   * Written as raw SQL for the two clauses Prisma's `updateMany` cannot express,
   * and both of them are why this method exists at all:
   *
   * - **`ORDER BY m."id"`** — every writer takes the rows in the same order, so
   *   two worker instances stamping the same organisation at the same moment queue up
   *   behind each other instead of forming a cycle. An `updateMany` leaves the
   *   order to the plan, and two plans that differ are a deadlock.
   * - **`FOR UPDATE SKIP LOCKED`** — a row another instance is in the middle of
   *   delivering is skipped rather than waited for. This is bookkeeping; it must
   *   never park behind somebody else's SMTP conversation. A skipped row is
   *   stamped by the next run, which is exactly what happens to a row that
   *   arrives a second later anyway.
   *
   * `exceptId` is the row the caller just claimed and stamped itself; excluding
   * it keeps the two counts free of overlap.
   *
   * ## The same six filters as {@link claim} — the last two as well
   *
   * {@link NOT_IN_TRASH} and {@link NOT_ERASED} were missing here, and without
   * consequence as long as the lane of an organisation was the only one: a row
   * in the trash got a reason stamped onto it that it never needed, and
   * nothing further — `last_error` is display, it does not become deliverable
   * from it. With the system lane (ADR-0020) the stamping reaches across
   * **all** organisations (`scope` is empty there), and thereby into deleted
   * ones as well: an organisation that lies in the trash would get an error
   * message of today written onto its old post, although nothing at all is
   * being attempted on it just now. The reason of a lane belongs on the rows
   * that this lane would also look at — the same boundary, the same condition.
   *
   * The `JOIN` on `tenant` comes with {@link NOT_IN_TRASH} (the condition
   * reads `t."deleted_at"`), and the lock therefore stays `FOR UPDATE OF m` as
   * in {@link claim}: a bookkeeping step has no business locking the row of
   * the organisation.
   */
  async withholdOthers(
    lane: MailLaneKey,
    exceptId: string,
    reason: string,
  ): Promise<number> {
    // The lane of the organisation is additionally restricted to its id;
    // the system lane deliberately is not — across all organisations it is a
    // single one, and its answer applies to every one of its rows.
    const scope =
      lane.kind === 'system'
        ? Prisma.empty
        : Prisma.sql`AND m."tenant_id" = ${lane.tenantId}::uuid`;
    return this.prisma.$executeRaw`
      UPDATE "mail_log"
         SET "last_error" = ${reason}
       WHERE "id" IN (
         SELECT m."id"
           FROM "mail_log" m
           JOIN "tenant" t ON t."id" = m."tenant_id"
          WHERE m."id" <> ${exceptId}::uuid
            AND m."status" = 'queued'
            ${scope}
            ${laneRows(lane)}
            ${NOT_IN_TRASH}
            ${NOT_ERASED}
            AND (m."last_error" IS NULL OR m."last_error" <> ${reason})
          ORDER BY m."id"
            FOR UPDATE OF m SKIP LOCKED
       )`;
  }
}
