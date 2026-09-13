import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { UNCLAIMED_FILE_LIFETIME_MS, type ApiEnv } from '@formsache/shared';

import { JobKind } from '@prisma/client';

import { API_ENV } from '../../config/env';
import { FileStorage } from '../file-storage';
import { MailClock } from '../../mail/mail-clock';
import { PrismaService } from '../../prisma/prisma.service';
import { JobRunService } from '../../observability/job-run.service';

/**
 * How many rows one transaction takes at a time (ADR-0014 no. 15: „in Stapeln,
 * damit die Sperre kurz bleibt").
 *
 * The batch is not a performance knob, it is the length of a **lock**: every
 * row selected here is held with `FOR UPDATE` until the transaction commits,
 * and a concurrent submission naming one of them waits for exactly that long.
 * Fifty keeps that wait in the range of a handful of `remove()` calls while
 * still finishing a day's worth of abandoned uploads in a few passes.
 */
const PURGE_BATCH_SIZE = 50;

/** Spelled out, like `MS_PER_DAY` next door in `mail-log-purge.service.ts`. */
const MS_PER_HOUR = 3_600_000;

/**
 * The instant a `file` row must be older than to be purged.
 *
 * A pure function of the injected clock, counted from **`created_at`** — the
 * column, not an access timestamp. The number comes from `@formsache/shared`, and it
 * is the **same** constant condition 5 of the claim reads
 * (`public/attachment-claim.ts`): two spellings would be two opinions about
 * when a file expires, and the gap between them is a submitted answer with an
 * attachment that has no bytes (ADR-0014 no. 15).
 */
export function filePurgeCutoff(now: Date): Date {
  return new Date(now.getTime() - UNCLAIMED_FILE_LIFETIME_MS);
}

/**
 * Deletes attachments nobody ever claimed (ADR-0014 no. 15).
 *
 * An upload happens **before** the answer exists — the participant uploads,
 * then submits — so an abandoned fill-in session leaves files with no answer.
 * Nothing else in this application ever looks at such a row again, and the
 * bytes behind it are somebody's certificate sitting on a volume for good.
 *
 * ## The predicate has four parts and every one of them is needed
 *
 * - **`kind = 'response_attachment'`** — the purge does not touch a Logo, see
 *   „Kein Logo-Arm" below;
 * - **`response_id IS NULL`** — not owned by an answer. Alone it would take a
 *   file the participant is about to submit;
 * - **`draft_id IS NULL`** — and not owned by a *draft* either (the requirement). This arm is the whole of that requirement on this side: an
 *   attachment of a half-filled form lives as long as the form it hangs on —
 *   thirty days, capped by the deadline — and without this condition it would be
 *   taken a day after the upload while the draft went on naming it. That is
 *   the „Falle" ADR-0014 no. 15 wrote down when `response_draft` was planned,
 *   and it is the reason a draft's attachment now has an owner rather than a
 *   longer deadline: „ohne Eigentümer" stays one question;
 * - **`created_at < now − 24 h`** — alone it would take one that *has* been
 *   submitted.
 *
 * **The 24 hours therefore did not become 30 days**, they became the deadline
 * of a file with **neither** owner: the protection against uploading into
 * nothing, and — deliberately — the deadline of an attachment a correction
 * removed from a submitted answer, measured from `created_at` and not from the
 * removal. What ends a draft's attachment is the end of the draft: `draft_id`
 * is `ON DELETE SET NULL`, so a submitted, revoked, deleted or expired draft
 * drops its files into exactly this predicate, and the next run takes their
 * bytes. **Or the draft simply stops naming it** (a security review finding): a save releases what the new version of the answers no longer
 * names (`releaseDraftAttachments`), and that row lands in the same predicate
 * with the same deadline — measured from `created_at`, exactly as the concept
 * measures the one a correction removed from an answer.
 *
 * ## Two phases, because of one race — and **one file per transaction**
 *
 * A run lists candidates, then takes each one in a transaction of its own:
 * `SELECT … FOR UPDATE`, `remove()`, `DELETE`, commit. A concurrent claim waits
 * on that lock and re-evaluates its own `WHERE` against a row that is gone —
 * nought rows updated, submission refused, readably. Without the lock the
 * selection and the `remove()` would lie apart, and in that gap the file is
 * claimable **while its bytes disappear**: an answer that names an attachment
 * with no bytes, no error at submission time, visible only when an editor
 * clicks the link weeks later.
 *
 * The claim carries the first bolt against the same race (condition 5: younger
 * than this deadline), and it is an argument about **clocks** — it holds
 * because age grows monotonically, provided the claim and the purge measure age
 * the same way. This lock is what covers the case where they do not.
 *
 * **Per file rather than per batch**, and that is a correction to ADR-0014
 * no. 16 rather than an implementation detail: a batch transaction rolls the
 * rows back and cannot roll the bytes back, so an abort in the middle left the
 * earlier files byte-less with their rows alive and unlocked. `purgeOne` says
 * what that cost and how it was measured.
 *
 * ## Bytes first, row second — ADR-0014 no. 16
 *
 * Inside each transaction the order is `remove()` and only then `DELETE`. If
 * `remove()` fails the transaction aborts, **the row stays**, and a later run
 * picks it up again. The other order would leave bytes with no index behind —
 * personal data this application has declared deleted and can no longer find,
 * because the storage seam deliberately has no `list()`.
 *
 * ## Kein Logo-Arm
 *
 * „Ein `tenant_logo`, auf das keine Organisation mehr zeigt" has no expression: the
 * reference lives in `tenant.logo_ref` as a union (no. 12), so the purge would
 * have to read backwards over every organisation of the installation and parse each
 * value. A parse error, a new union arm or an organisation whose row is being written
 * would then delete a **live** Logo, physically. The life cycle of a Logo
 * is handled elsewhere.
 *
 * ## Installation-wide by design, and this is the only place of its kind here
 *
 * No request, no caller, no tenant parameter — the row selection is `kind`, the
 * two owner columns and `created_at`, and nothing from outside contributes.
 * That is the same category as the mail worker and the `mail_log` purge, and it
 * is what `apps/api/src/files/purge/**` is on the `PrismaService` allow-list of
 * `eslint.config.js` for. **The counter-check is the boundary:**
 * `apps/api/src/files/` next door — the attachment retrieval of no. 11(b) — is
 * *not* on that list and reads strictly through the `TenantScope` delegate the
 * guard chain hands in. A purge that started reading payload (`file_name`,
 * `answers`) or that took a row selected by a request would need a new
 * decision, not a wider query.
 */
@Injectable()
export class FilePurgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FilePurgeService.name);
  private timer: NodeJS.Timeout | undefined;
  /** The run in flight — re-entrancy guard and what shutdown waits for. */
  private purging: Promise<void> | undefined;

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly prisma: PrismaService,
    /**
     * **The application's one injected calendar**, and the mail-shaped name is
     * the price of keeping it one (ADR-0014 no. 15: „**eine** injizierte Uhr").
     *
     * A `FileClock` beside it would be a second *instance* — two calendars over
     * one comparison, which is exactly the fault `mail-clock.ts` was written to
     * rule out. It would also split the test seam: `create-test-app.ts` already
     * takes a `clock` override, and with two abstractions a suite that moved it
     * would move half the application's notion of „now".
     */
    private readonly clock: MailClock,
    private readonly storage: FileStorage,
    /**
     * The bookkeeping about this run (ADR-0016) — one
     * row per run, on success **and** on failure.
     */
    private readonly jobRuns: JobRunService,
  ) {}

  onModuleInit(): void {
    const interval = this.env.FILE_PURGE_INTERVAL_MS;
    if (interval <= 0) {
      return;
    }
    // Armed here, per process: nothing outside remembers that a purge is due.
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref();

    // **And once immediately, not only one interval later.** The shipped interval is a day, so „armed" alone would put the
    // first deletion twenty-four hours after the process came up — and an
    // installation that is redeployed daily, one in a crash loop, or one on a
    // host that reboots each night would never delete a single file while the
    // application went on promising the opposite. That is an operational fault
    // seen before, and it is the same answer here. Through the same `purging` guard
    // as every scheduled run, so a long first pass and the first tick cannot
    // overlap.
    void this.tick();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    // A purge that outlived `close()` would delete against a database the
    // caller has already released, and log the failure as if it were a defect.
    await this.purging;
  }

  get schedulerRunning(): boolean {
    return this.timer !== undefined;
  }

  /**
   * Purges everything past the deadline and answers **how many files**.
   *
   * The count is the return value rather than a log line, for the reason the
   * `mail_log` purge gives: idempotency is only checkable through it — a second
   * run answering `0` is what tells „there was nothing left" apart from „it fell
   * over before it got there".
   *
   * The cut-off is computed **once** for the whole run, not per batch: with one
   * instant, „older than the deadline" is a fixed set that the batches walk
   * through, and a run cannot take a row that became eligible while it was
   * working.
   */
  async runOnce(): Promise<number> {
    const cutoff = filePurgeCutoff(this.clock.now());
    let removed = 0;
    /**
     * Rows this run could not delete, excluded from the next listing.
     *
     * Without it a file the storage refuses would be selected again by every
     * batch — `ORDER BY created_at` puts the oldest first, and the oldest is
     * exactly the one that has been failing longest — and the run would make no
     * progress at all. See {@link purgeOne} for why one such row must not stop
     * the others.
     */
    const stuck: string[] = [];

    for (;;) {
      const batch = await this.candidates(cutoff, stuck);
      if (batch.length === 0) {
        break;
      }
      for (const id of batch) {
        try {
          if (await this.purgeOne(id, cutoff)) {
            removed += 1;
          }
        } catch (error: unknown) {
          stuck.push(id);
          // **The class, never the message.** A failing `rm` reports the path
          // it tried — that is the volume layout *and* the id of the very
          // attachment whose existence this job exists to end, written into a
          // log that outlives it. Measured in a security
          // review.
          this.logger.warn(
            `file purge: could not delete one attachment (${
              error instanceof Error ? error.constructor.name : 'unknown error'
            }); leaving the row in place for the next run`,
          );
        }
      }
      // A short batch means the listing found no more candidates; a full one
      // may have left some behind.
      if (batch.length < PURGE_BATCH_SIZE) {
        break;
      }
    }

    if (removed > 0 || stuck.length > 0) {
      // Counts only. A purge line naming a file would put a participant's file
      // name into a log the purge exists to make unnecessary.
      this.logger.log(
        `file purge: ${String(removed)} unclaimed attachment(s) older than ` +
          `${String(UNCLAIMED_FILE_LIFETIME_MS / MS_PER_HOUR)} hours deleted` +
          (stuck.length > 0 ? `, ${String(stuck.length)} left for later` : ''),
      );
    }
    return removed;
  }

  /**
   * The next candidates, **without** a lock — the lock belongs to
   * {@link purgeOne}, one row at a time.
   *
   * Only the key leaves this query. Not `file_name`, not `public_ref`, not a
   * byte count: a job that runs across every organisation of the installation should not
   * be able to hand out an organisation's data even by accident, and the `id` is what the
   * storage is addressed by (no. 4).
   *
   * `$queryRaw` rather than Prisma's own API for the same reason the row lock
   * below is raw: there is no session behind this job, so no `TenantScope`
   * delegate to read through.
   */
  private async candidates(
    cutoff: Date,
    stuck: readonly string[],
  ): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT "id"
        FROM "file"
       WHERE "kind"        = 'response_attachment'::"file_kind"
         AND "response_id" IS NULL
         AND "draft_id"    IS NULL
         AND "created_at"  < ${cutoff}
         AND NOT ("id" = ANY(${stuck}::uuid[]))
       ORDER BY "created_at"
       LIMIT ${PURGE_BATCH_SIZE}`;
    return rows.map((row) => row.id);
  }

  /**
   * One file: lock it, remove the bytes, delete the row, commit — **per row**.
   *
   * ## Why one transaction per file rather than one per batch
   *
   * The batch version of this was the shape ADR-0014 no. 16 describes, and it
   * was wrong in a way the ADR's own reasoning hides: „a `remove()` that threw
   * never gets here, the transaction aborts, nothing is committed" is true of
   * the *rows* and false of the *bytes*, because `remove()` is not transactional
   * and cannot be rolled back. Measured in a security review — three
   * expired files, the middle one unremovable: all three rows survived while the
   * first one's bytes were already gone, the rollback dropped the lock, and a
   * submission then claimed that row successfully. **An answer naming an
   * attachment with no bytes, with no error at submission time** — the precise
   * outcome the two-phase design exists to prevent. It needed no broken file: a
   * container restart or the transaction timeout mid-batch does the same.
   *
   * Per row, the window shrinks to a single file and to the one step that can
   * still fail between the two systems: `remove()` succeeded and the `DELETE`
   * did not. Inside a transaction that already holds this row's lock that is a
   * lost connection and nothing else, and it costs one row rather than up to
   * fifty.
   *
   * ## Why a failure must not stop the run
   *
   * `ORDER BY created_at` puts the longest-failing row in *every* first batch,
   * so one file the storage refuses — a volume remounted read-only, `EACCES`, a
   * full disk, all of them failure modes the ADR already names — used to freeze
   * the purge for the whole installation, silently, while the application went
   * on promising deletion. Measured: three runs, nothing deleted, the healthy
   * third file never reached. The caller sees the count; the run goes on.
   *
   * ## The predicate is re-checked here, under the lock
   *
   * The listing is unlocked, so a submission may claim a row between listing and
   * lock. Re-evaluating it inside the lock is what keeps that from costing the
   * bytes of a file somebody just submitted: no row, no `remove()`.
   */
  private async purgeOne(id: string, cutoff: Date): Promise<boolean> {
    return this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id"
            FROM "file"
           WHERE "id"          = ${id}::uuid
             AND "kind"        = 'response_attachment'::"file_kind"
             AND "response_id" IS NULL
             AND "draft_id"    IS NULL
             AND "created_at"  < ${cutoff}
             FOR UPDATE`;
        if (rows.length === 0) {
          return false;
        }

        // **Bytes first** (no. 16). The reverse order is the one that ends as
        // bytes with no index: personal data this application has declared
        // deleted and, with no `list()` on the seam, can never find again.
        await this.storage.remove(id);
        await tx.$executeRaw`DELETE FROM "file" WHERE "id" = ${id}::uuid`;
        return true;
      },
      {
        // **Both bounds named, because both decide what a slow volume costs.**
        // `timeout` is the default five seconds otherwise, and this transaction
        // waits on a filesystem; `maxWait` is two, and under pool pressure a
        // run that loses it fails with P2028 and is a whole interval — a day —
        // away from its next attempt.
        maxWait: 10_000,
        timeout: 30_000,
      },
    );
  }

  /** One scheduled run; never rejects, for the reason the worker's tick gives. */
  private tick(): Promise<void> {
    this.purging ??= this.runTick().finally(() => {
      this.purging = undefined;
    });
    return this.purging;
  }

  private async runTick(): Promise<void> {
    try {
      // the requirement — see `JobRunService`.
      await this.jobRuns.record(JobKind.file_purge, () => this.runOnce());
    } catch (error: unknown) {
      // **The error class, never the message** (a review finding): a message
      // from the driver regularly quotes the query along with its values, and a
      // clean-up run holds in its hands exactly the rows it is meant to delete.
      this.logger.error(
        `file purge failed: ${
          error instanceof Error ? error.constructor.name : 'unknown error'
        }`,
      );
    }
  }
}
