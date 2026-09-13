import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { MAIL_LOG_RETENTION_DAYS, type ApiEnv } from '@formsache/shared';
import { JobKind } from '@prisma/client';

import { API_ENV } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { MailClock } from './mail-clock';
import { JobRunService } from '../observability/job-run.service';

const MS_PER_DAY = 86_400_000;

/**
 * The instant a `mail_log` row must be older than to be deleted.
 *
 * A pure function of the injected clock, and counted from **`created_at`**, not
 * `sent_at`: a row that never went out would
 * otherwise never expire — and that is precisely the row still carrying an
 * address nobody reached.
 *
 * The number of days comes from `@formsache/shared`, the same constant the
 * mail log writes its „90 Tage" hint from (the requirement). Two
 * spellings would be the drift `pickDefaultColumns` was shared against:
 * one half would keep telling the old story, and the half an organisation reads is not
 * the half that deletes.
 */
export function mailLogPurgeCutoff(now: Date): Date {
  return new Date(now.getTime() - MAIL_LOG_RETENTION_DAYS * MS_PER_DAY);
}

/**
 * Deletes `mail_log` rows once they are older than the retention period.
 *
 * ## Physically, not by a flag
 *
 * `deleteMany` — the row leaves the table, so this really is a
 * physical deletion, and a `deleted_at` column would keep a
 * recipient address readable to anyone with SQL access while the application
 * claimed it was gone. The proof of that is a raw `count(*)` **without any
 * filter**: a test that asked the repository would only be proving that the
 * repository filters.
 *
 * ## `queued` rows go too
 *
 * The retention is a deletion promise, not a delivery guarantee
 * . A mail that has waited ninety days for a mail
 * server that never came is not going to be sent, and keeping its recipient
 * address on the off chance would be exactly the personal datum the promise is
 * about.
 *
 * ## Across tenants by design
 *
 * Like the worker: no request, no caller, no tenant parameter — the row
 * selection is `created_at` and nothing else. That is what
 * `apps/api/src/mail/**` is on the `PrismaService` allow-list of
 * `eslint.config.js` for.
 */
@Injectable()
export class MailLogPurgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MailLogPurgeService.name);
  private timer: NodeJS.Timeout | undefined;
  /** The run in flight — re-entrancy guard and what shutdown waits for. */
  private purging: Promise<void> | undefined;

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly prisma: PrismaService,
    private readonly clock: MailClock,
    /**
     * The bookkeeping about this run (ADR-0016) — one
     * row per run, on success **and** on failure. Without it a run that does
     * not even start leaves nothing behind.
     */
    private readonly jobRuns: JobRunService,
  ) {}

  onModuleInit(): void {
    const interval = this.env.MAIL_PURGE_INTERVAL_MS;
    if (interval <= 0) {
      return;
    }
    // Arming it here — on module init, per process — is what „läuft nach einem
    // Neustart wieder an" means. Nothing outside remembers that
    // a purge is due; the application does, every time it comes up.
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref();

    // **And once immediately, not only one interval later.** The shipped
    // interval is a day (`MAIL_PURGE_INTERVAL_MS`), so „armed" alone would mean
    // the first deletion happens twenty-four hours after the process started —
    // and an installation that is redeployed daily, or one in a crash loop, or
    // one on a host that reboots each night, would never delete a single row
    // while the application went on promising ninety days. Through the same `purging` guard as every scheduled run, so a
    // long first pass and the first tick cannot overlap.
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
   * Deletes what is over the retention period and answers **how many rows**.
   *
   * The count is the return value and not a log line, because idempotency is
   * only checkable through it: a second run answering `0` is what tells „there
   * was nothing left" apart from „it fell over before it got there" (the requirement).
   */
  async runOnce(): Promise<number> {
    const cutoff = mailLogPurgeCutoff(this.clock.now());
    const { count } = await this.prisma.mailLog.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    if (count > 0) {
      // Counts only — a purge line naming a recipient would defeat the purpose
      // of the purge.
      this.logger.log(
        `mail log purge: ${String(count)} row(s) older than ` +
          `${String(MAIL_LOG_RETENTION_DAYS)} days deleted`,
      );
    }
    return count;
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
      // the requirement: one row per run, on success **and** on
      // failure. The bookkeeping lies inside around `runOnce()`, so that it
      // measures the run and not the logging afterwards.
      await this.jobRuns.record(JobKind.mail_log_purge, () => this.runOnce());
    } catch (error: unknown) {
      // **Error class, never the message** (a review finding): a message
      // from the driver regularly quotes the query along with its values, and a
      // clean-up run has exactly the rows in hand that it is meant to delete.
      this.logger.error(
        `mail log purge failed: ${
          error instanceof Error ? error.constructor.name : 'unknown error'
        }`,
      );
    }
  }
}
