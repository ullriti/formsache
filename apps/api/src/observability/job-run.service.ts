import { Injectable, Logger } from '@nestjs/common';
import { JobKind, JobOutcome } from '@prisma/client';

import { MailClock } from '../mail/mail-clock';
import { PrismaService } from '../prisma/prisma.service';

/**
 * **The bookkeeping over the five background runs** (* ADR-0016).
 *
 * A failed purge used to write a `logger.error` line into a
 * container stream that nobody keeps; a purge that **never starts**
 * wrote nothing at all. The second case is the more expensive one — it has
 * already been real once, when the purge armed only a 24-hour
 * interval at startup and a daily redeployed installation would therefore never
 * have deleted anything.
 *
 * This class turns both cases into one line.
 *
 * ⚠️ **It must never throw.** A run that fails at its own
 * bookkeeping would not have done the job it was meant to do — the
 * bookkeeping is the observation, not the purpose. A failure while
 * writing therefore goes into the log and nowhere else.
 */
@Injectable()
export class JobRunService {
  private readonly logger = new Logger(JobRunService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: MailClock,
  ) {}

  /**
   * Runs `work` and writes **exactly one** line — on success as on
   * failure.
   *
   * The return value of `work` is the number of items handled. A
   * thrown error is **passed on** after the line stands: the
   * existing callers already log it with their own
   * wording, and this class is not the place where it is decided
   * whether a failure aborts a run.
   */
  async record(job: JobKind, work: () => Promise<number>): Promise<number> {
    return this.recordRun<number>(job, async () => {
      const itemCount = await work();
      return { result: itemCount, itemCount };
    });
  }

  /**
   * The same for runs whose result is **more than a number**.
   *
   * The mail worker answers with `MailWorkerRun` (sent, deferred,
   * failed, held back), the trash run with five populations.
   * Both are to keep their result and nevertheless book **one** number — the
   * caller says here which one. Without this path every run would have to either
   * lose its return value or write its own line, and the
   * five writers would drift apart again.
   */
  async recordRun<T>(
    job: JobKind,
    work: () => Promise<{ result: T; itemCount: number }>,
  ): Promise<T> {
    const startedAt = this.clock.now();
    try {
      const { result, itemCount } = await work();
      await this.write({ job, startedAt, outcome: 'ok', itemCount });
      return result;
    } catch (error: unknown) {
      await this.write({
        job,
        startedAt,
        outcome: 'failed',
        itemCount: 0,
        errorClass: classOf(error),
      });
      throw error;
    }
  }

  private async write(row: {
    job: JobKind;
    startedAt: Date;
    outcome: JobOutcome;
    itemCount: number;
    errorClass?: string;
  }): Promise<void> {
    try {
      await this.prisma.jobRun.create({
        data: {
          job: row.job,
          startedAt: row.startedAt,
          finishedAt: this.clock.now(),
          outcome: row.outcome,
          itemCount: row.itemCount,
          errorClass: row.errorClass ?? null,
        },
      });
    } catch (error: unknown) {
      // See the class comment: the observation must not kill the
      // observed. The failure nevertheless stays visible — and if the
      // database is so broken that this `INSERT` fails, the
      // readiness route is already on 503 anyway.
      this.logger.error(
        `job_run row for ${row.job} could not be written: ${classOf(error)}`,
      );
    }
  }
}

function classOf(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}
