import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

/**
 * How long the readiness check waits for the database at most.
 *
 * ⚠️ **Without this deadline a health check does more harm than good.** A
 * connection that *hangs* instead of failing is the more frequent outage — and a
 * `SELECT 1` without an upper bound would hang with it. The prober would then
 * get no 503, but no answer at all: Compose counts that as a failure after
 * `timeout: 5s`, the outside observer after its own, and neither learns *that*
 * the database is the problem.
 *
 * Two seconds, because the deadline has to lie below the `timeout` of the
 * Compose health check (5 s): otherwise its clock would go before ours and the
 * abort would come as a timeout of the prober instead of as a 503 of this
 * application — the same ordering as with `TENANT_PURGE_STATEMENT_TIMEOUT_MS`,
 * only the other way round.
 */
export const READINESS_TIMEOUT_MS = 2_000;

/**
 * **Readiness: may traffic come here?** (ADR-0016.)
 *
 * Separate from {@link HealthService}, because the two questions have different
 * answers: *does the process live* (liveness, no database contact) against *can
 * it work* (readiness, one contact). Formerly there was only the first route,
 * and the Compose health check asked it — an installation with a dead database
 * reported `healthy`, and the front door started in front of it.
 */
@Injectable()
export class ReadinessService {
  private readonly logger = new Logger(ReadinessService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * **One** cheap contact, no count over tables.
   *
   * An outside observer asks every 60 seconds; that is 1,440 calls a day, and
   * every count in it would be a query that nobody ordered. `SELECT 1` proves
   * exactly what the route promises: the connection stands and the server
   * answers.
   */
  async isReady(): Promise<boolean> {
    try {
      await this.withDeadline(this.prisma.$queryRaw`SELECT 1`);
      return true;
    } catch (error) {
      // The error class, never the message — and only here, never in the
      // response: what the operator needs stands in the operations status behind
      // the superadmin guard.
      this.logger.warn(`readiness probe failed: ${classOf(error)}`);
      return false;
    }
  }

  /**
   * The deadline as a race, not as an abort of the statement.
   *
   * Prisma cannot abort a running query from the outside; what is bounded here
   * is the **waiting time of the caller**. The statement runs out in the
   * background — with `SELECT 1` that is without consequence, and exactly for
   * that reason the check is a `SELECT 1` and not a count.
   */
  private async withDeadline<T>(work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error('readiness deadline exceeded'));
      }, READINESS_TIMEOUT_MS);
    });
    try {
      return await Promise.race([work, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
      // Without this `catch` the lost query would end the process as an
      // unhandled rejection — the outage of the database would then tear the
      // application down with it, instead of letting it say 503.
      void work.catch(() => undefined);
    }
  }
}

function classOf(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}
