import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  PASSWORD_RESET_RETENTION_DAYS,
  SESSION_RETENTION_DAYS,
  type ApiEnv,
} from '@formsache/shared';
import { JobKind } from '@prisma/client';

import { API_ENV } from '../../config/env';
import { JobRunService } from '../../observability/job-run.service';
import { PrismaService } from '../../prisma/prisma.service';

const MS_PER_DAY = 86_400_000;

/**
 * The point in time before which a dead session row is deleted.
 *
 * A pure function of the clock handed in, so that the test can set it without
 * lying to the process — the same construction as `mailLogPurgeCutoff`.
 */
export function sessionPurgeCutoff(now: Date): Date {
  return new Date(now.getTime() - SESSION_RETENTION_DAYS * MS_PER_DAY);
}

/**
 * The point in time before which a dead reset row is deleted (ADR-0020).
 *
 * A function of its own beside {@link sessionPurgeCutoff}, although both read
 * the same number today: the retention periods are two promises about two
 * populations (`docs/kb/10-datenschutz.md`), and a shared computation would be
 * the place where one quietly follows the other as soon as somebody changes
 * one of them.
 *
 * **Not exported** (a review finding). It was, without a single caller outside
 * this file — and without one that should ever have been added:
 * `session-purge.spec.ts` measures the boundary against
 * `PASSWORD_RESET_RETENTION_DAYS`, that is, against the **promise**, one day
 * to the left and to the right of it. A test that called this function instead
 * would hold the computation against itself and stay green if both are wrong
 * together. The export promised a testability that nothing wanted.
 */
function passwordResetPurgeCutoff(now: Date): Date {
  return new Date(now.getTime() - PASSWORD_RESET_RETENTION_DAYS * MS_PER_DAY);
}

/**
 * Deletes session rows that are dead **and** past the retention period (a
 * review finding).
 *
 * ## What the finding was
 *
 * `session` rows never disappeared. Signing out sets `revoked_at`, expiring
 * sets nothing at all; `schema.prisma` promised a purge job at
 * `@@index([expiresAt])` that `JobKind` did not know. The table grew
 * monotonically — and it carries `user_id`, points in time and the
 * last-chosen Organisation, that is, exactly the kind of datum for which the
 * deletion concept names a retention period.
 *
 * ## Dead means two things, and both count
 *
 * A row is dead when it is **expired** (`expires_at` past) or **revoked**
 * (`revoked_at` set). Clearing out by `expires_at` alone would be the obvious
 * half and the wrong one: whoever signs out produces a revoked row whose
 * `expires_at` still lies hours in the future — and with a session duration of
 * up to 720 hours (`SESSION_TTL_HOURS`) that would be weeks.
 *
 * Counted from the death, not from the creation: the point from which the row
 * is of no use to anybody is the point from which the period runs.
 *
 * ## Physically, not via a flag
 *
 * `deleteMany` — the row leaves the table (deleting for good is physical
 * deletion). The evidence for it is a `count(*)` **without a filter**; a test
 * that asks the repository would only prove that the repository filters.
 *
 * ## Two populations, one run
 *
 * Since ADR-0020 the same run also clears out the dead rows of
 * `password_reset` — expired **or** redeemed. Deliberately not a second
 * `JobKind`: a reset link is a login artefact like a session, it comes into
 * being on the same path and expires after the same period, and a second tile
 * in the Betriebsstatus would answer no question the existing one does not
 * answer already („räumt die Anmeldung auf, und wann zuletzt?"). The price is
 * named: whoever reads „Tote Sitzungen" in the Betriebsstatus has to know
 * this comment in order to know that the reset rows go along with it. The
 * number {@link runOnce} returns is the **sum** of both populations.
 *
 * ## Across all organisations, like every purge
 *
 * No request, no caller, no organisation parameters — the row selection is the
 * clock and nothing else. `apps/api/src/auth/**` is on the `PrismaService`
 * exception list of `eslint.config.js` for that.
 */
@Injectable()
export class SessionPurgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SessionPurgeService.name);
  private timer: NodeJS.Timeout | undefined;
  /** The run currently in flight — re-entry lock and reason for shutting down. */
  private purging: Promise<void> | undefined;

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly prisma: PrismaService,
    /**
     * The bookkeeping about this run (ADR-0016) — one
     * row per run, on success **and** on failure.
     */
    private readonly jobRuns: JobRunService,
  ) {}

  onModuleInit(): void {
    const interval = this.env.SESSION_PURGE_INTERVAL_MS;
    if (interval <= 0) {
      return;
    }
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref();

    // And once immediately, not only one interval later — the same reasoning
    // as for the `mail_log` purge: at a daily cadence an installation that
    // restarts every evening would otherwise never clear anything out.
    void this.tick();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.purging;
  }

  get schedulerRunning(): boolean {
    return this.timer !== undefined;
  }

  /**
   * Deletes what is dead and past the retention period, and answers **how
   * many**.
   *
   * The number is the return value and not a log line, because idempotence is
   * only testable against it: a second run with `0` distinguishes „there was
   * nothing left" from „it fell over beforehand".
   */
  async runOnce(now: Date = new Date()): Promise<number> {
    const cutoff = sessionPurgeCutoff(now);
    const { count } = await this.prisma.session.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: cutoff } },
          { revokedAt: { not: null, lt: cutoff } },
        ],
      },
    });
    if (count > 0) {
      // Numbers only: a purge line that names a person cancels the purpose of
      // the purge.
      this.logger.log(
        `session purge: ${String(count)} dead row(s) older than ` +
          `${String(SESSION_RETENTION_DAYS)} days deleted`,
      );
    }

    // The same reading as above, applied to the second population: dead means
    // **expired or redeemed**, and counting starts from the death. Clearing
    // out by `expires_at` alone would leave a redeemed row standing up to an
    // hour longer — the difference is small and the symmetry with the sessions
    // is not.
    const resetCutoff = passwordResetPurgeCutoff(now);
    const dead = await this.prisma.passwordResetToken.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: resetCutoff } },
          { usedAt: { not: null, lt: resetCutoff } },
        ],
      },
    });
    if (dead.count > 0) {
      this.logger.log(
        `password reset purge: ${String(dead.count)} dead row(s) older than ` +
          `${String(PASSWORD_RESET_RETENTION_DAYS)} days deleted`,
      );
    }

    return count + dead.count;
  }

  /** A scheduled run; never fails outwards. */
  private tick(): Promise<void> {
    this.purging ??= this.runTick().finally(() => {
      this.purging = undefined;
    });
    return this.purging;
  }

  private async runTick(): Promise<void> {
    try {
      await this.jobRuns.record(JobKind.session_purge, () => this.runOnce());
    } catch (error: unknown) {
      // **Class of error, never the message** (a review finding): a message
      // from the driver regularly quotes the query along with its values.
      this.logger.error(
        `session purge failed: ${
          error instanceof Error ? error.constructor.name : 'unknown error'
        }`,
      );
    }
  }
}
