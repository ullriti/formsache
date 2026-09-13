import { readdir, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { JobKind } from '@prisma/client';
import { berlinMonthStart, MAIL_FAILURE_WINDOW_MS } from '@formsache/shared';
import type { ApiEnv, JobStatus, OpsStatus } from '@formsache/shared';

import { API_ENV } from '../config/env';
import { MailClock } from '../mail/mail-clock';
import { PrismaService } from '../prisma/prisma.service';

/**
 * **The operational status** (ADR-0016).
 *
 * Five groups of figures over the **whole installation** — queue, runs,
 * storage, AI, version. Each of them could previously break silently:
 *
 * - a queue nobody collects looks like an empty one;
 * - a clean-up run that never starts leaves nothing behind (hence `job_run`);
 * - a full storage answers 500 to uploads while every other page
 *   works.
 *
 * ⚠️ **Sums, no names.** The queries count over all organisations and give out
 * **no** identifier. An operational status that revealed which organisation
 * is currently backing up 400 mails would be information about other
 * organisations that operations does not need.
 */
@Injectable()
export class OpsStatusService {
  private readonly logger = new Logger(OpsStatusService.name);

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly prisma: PrismaService,
    private readonly clock: MailClock,
  ) {}

  /**
   * The operational status.
   *
   * `inventory` decides about the **one** expensive figure in it (a
   * review finding): occupied bytes and file count come out of a recursive run
   * over the whole storage. The view wants them — a human looks there.
   * The alarm guard that reads every five minutes does not want them and has
   * never used them; it gets `null` and saves the run.
   */
  async read({
    inventory = true,
  }: { inventory?: boolean } = {}): Promise<OpsStatus> {
    const observedAt = this.clock.now();
    const [mailQueue, jobs, storage, ai] = await Promise.all([
      this.mailQueue(observedAt),
      this.jobs(),
      this.storage(inventory),
      this.ai(observedAt),
    ]);
    return {
      version: this.env.APP_VERSION,
      mailQueue,
      jobs,
      storage,
      ai,
      observedAt: observedAt.toISOString(),
    };
  }

  /**
   * ⚠️ **`failed` and `failedRecently` are two questions, not one figure in
   * two resolutions** (a review finding, 2026-08-12).
   *
   * `failed` is the stock since the beginning of the retention — the figure
   * that stands on the status page. It is **not** fit as a basis for an alarm:
   * it only falls once the 90-day deletion period clears the rows away, and six
   * mistyped participant addresses kept it above every threshold for a quarter
   * of a year.
   *
   * `failedRecently` counts the same rows in the window `MAIL_FAILURE_WINDOW_MS`
   * and is thereby the figure that **can** go back to 0 again.
   *
   * ⚠️ **The count runs over `failed_at`, and the first version of this line did
   * not do that** (review rework of the same day). It counted over
   * `created_at` — the point in time of the *queueing* — with the justification
   * that the distance between queueing and giving up is at most the retries
   * of one day. That justification was wrong twice over: the distance is
   * regularly **~15 minutes** (`MAIL_BACKOFF_BASE_MS` 60 s, `MAIL_MAX_ATTEMPTS`
   * 5), but **unbounded** upwards — „↻ Erneut" pushes a three-day-old
   * row anew, and an eight-hour worker outage makes two hundred
   * rows with an old `created_at` fail all at once. In both cases
   * `failedRecently` would have been **0** and the alarm would have stayed
   * away — precisely in the situation it exists for. The timestamp has stood
   * in the table since the migration
   * `20260812090000_mail_log_failed_at`; the detailed
   * justification is there.
   */
  private async mailQueue(observedAt: Date): Promise<OpsStatus['mailQueue']> {
    const windowStart = new Date(observedAt.getTime() - MAIL_FAILURE_WINDOW_MS);
    const [queued, failed, failedRecently, oldest] = await Promise.all([
      this.prisma.mailLog.count({ where: { status: 'queued' } }),
      this.prisma.mailLog.count({ where: { status: 'failed' } }),
      this.prisma.mailLog.count({
        where: { status: 'failed', failedAt: { gte: windowStart } },
      }),
      this.prisma.mailLog.findFirst({
        where: { status: 'queued' },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
    ]);
    return {
      queued,
      failed,
      failedRecently,
      oldestQueuedAt: oldest?.createdAt.toISOString() ?? null,
    };
  }

  /**
   * Per kind of run **two** rows: the last run at all and the last
   * successful one.
   *
   * Both, because they answer different questions. „When did it last run"
   * says whether the scheduler is still armed; „when did it last run
   * **successfully**" says whether the deadline is being kept — and a run that
   * has been failing every night for three days looks healthy in the first
   * figure.
   */
  private async jobs(): Promise<JobStatus[]> {
    const kinds = Object.values(JobKind);
    return Promise.all(
      kinds.map(async (job): Promise<JobStatus> => {
        const [last, lastOk] = await Promise.all([
          this.prisma.jobRun.findFirst({
            where: { job },
            orderBy: { startedAt: 'desc' },
          }),
          this.prisma.jobRun.findFirst({
            where: { job, outcome: 'ok' },
            orderBy: { startedAt: 'desc' },
            select: { startedAt: true },
          }),
        ]);
        return {
          job,
          lastSuccessAt: lastOk?.startedAt.toISOString() ?? null,
          lastRunAt: last?.startedAt.toISOString() ?? null,
          lastOutcome: last?.outcome ?? null,
          lastItemCount: last?.itemCount ?? null,
          lastErrorClass: last?.errorClass ?? null,
        };
      }),
    );
  }

  /**
   * The fill level of the storage — occupied bytes, number of files and the
   * fraction of the volume.
   *
   * ⚠️ **The fraction comes from `statfs`, not from the sum of the files.** The
   * uploads share the volume with the database and the
   * container layers; „our files occupy 2 GB" says nothing about whether
   * the next upload still has room. That is exactly the question from which the
   * 85-per-cent threshold draws its alarm.
   */
  private async storage(inventory: boolean): Promise<OpsStatus['storage']> {
    const dir = this.env.FILE_STORAGE_DIR;
    let usedBytes: number | null = null;
    let files: number | null = null;
    try {
      // **Only when somebody is looking** (a review finding): one `stat` per
      // file over the whole storage, serially. The alarm guard needs none of
      // that — it decides on the fraction of the volume that `statfs` below
      // delivers in one call.
      if (inventory) {
        usedBytes = 0;
        files = 0;
        for (const entry of await readdir(dir, { recursive: true })) {
          const info = await stat(join(dir, entry));
          if (!info.isFile()) continue;
          files += 1;
          usedBytes += info.size;
        }
      }
    } catch (error: unknown) {
      // A missing directory is normal on a fresh installation
      // (it comes into being on the first upload) and must not kill the whole
      // status.
      this.logger.warn(`storage status incomplete: ${classOf(error)}`);
    }

    let usedFraction: number | null = null;
    try {
      const fs = await statfs(dir);
      const total = fs.blocks * fs.bsize;
      if (total > 0) usedFraction = 1 - (fs.bavail * fs.bsize) / total;
    } catch {
      // `statfs` is missing on some file systems; the fraction then stays
      // `null` instead of an invented figure.
    }

    return { usedBytes, files, usedFraction };
  }

  /**
   * AI calls of the running **calendar month** — the same period the
   * quota per organisation runs over, so that the failure rate and the
   * budget mean the same period.
   */
  private async ai(now: Date): Promise<OpsStatus['ai']> {
    // ⚠️ **`berlinMonthStart`, not the UTC start of the month** — a review
    // showed that the comment above it („the same period the
    // quota runs over") simply did not hold with `Date.UTC(...)`: the
    // quota computes over `berlinMonthStart`, and in summer the two
    // boundaries lie **two hours** apart. Calls in that window counted
    // in one month's budget and in another month's operational status.
    const from = berlinMonthStart(now);
    const [calls, failed, byModel] = await Promise.all([
      this.prisma.aiUsage.count({ where: { createdAt: { gte: from } } }),
      this.prisma.aiUsage.count({
        // Expressly `notIn` instead of `not`: `outcome` is nullable (a row
        // whose outcome was never entered), and `NULL != 'ok'` is in SQL
        // neither true nor false. Without this precision the failure rate
        // would depend on how Prisma translates NULL.
        where: {
          createdAt: { gte: from },
          outcome: { notIn: ['ok'], not: null },
        },
      }),
      /**
       * **The same calls, by model and version** .
       *
       * Grouped over *both* columns, not only over `model`: since the
       * selection list stands on aliases, `model` is a wandering name, and
       * two rows with the same alias and a different version are exactly
       * the information the second column exists for — the provider moved the
       * alias on in the middle of the month.
       *
       * `_sum` over the tokens delivers `null` of its own accord when no row of
       * the group carries a figure. That stays that way: „nothing consumed" and
       * „the provider said nothing" are two statements (assumption A8), and a
       * 0 at this place would be the wrong one.
       */
      this.prisma.aiUsage.groupBy({
        by: ['model', 'modelResolved'],
        where: { createdAt: { gte: from } },
        _count: { _all: true },
        _sum: { inputTokens: true, outputTokens: true },
      }),
    ]);
    return {
      calls,
      failed,
      // `null` and not `0`: without a single call there is no rate,
      // and a reported 0 % would look like a provably healthy provider.
      failureRate: calls === 0 ? null : failed / calls,
      byModel: byModel
        .map((row) => ({
          model: row.model,
          resolved: row.modelResolved,
          calls: row._count._all,
          inputTokens: row._sum.inputTokens,
          outputTokens: row._sum.outputTokens,
        }))
        // Descending by calls, on a tie by identifier — so that two
        // reads of the same situation show the same order. `groupBy` grants
        // none; without a tiebreaker an operator would see the table jump.
        .sort(
          (a, b) =>
            b.calls - a.calls ||
            a.model.localeCompare(b.model) ||
            (a.resolved ?? '').localeCompare(b.resolved ?? ''),
        ),
    };
  }
}

function classOf(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}
