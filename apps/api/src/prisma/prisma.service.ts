import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { ApiEnv } from '@formsache/shared';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { API_ENV } from '../config/env';

/**
 * How many database connections this process may hold at once.
 *
 * **Stated, not inherited.** It happens to be `pg.Pool`'s own default, and that
 * is exactly why it is written down: the mail worker sizes its parallelism
 * against this number (`MAIL_WORKER_TENANT_LANES`), and a limit that lives in a
 * library default is one a dependency bump can move under an application that
 * has silently agreed with it.
 *
 * The rule the two numbers keep is „**the worker may hold at most half**":
 * every one of its lanes holds an interactive transaction for up to
 * `claimTransactionMs` (two minutes) while an SMTP conversation runs, so the
 * lanes are the longest-lived borrowers there are. Ordinary HTTP requests need
 * the other half — including their own `$transaction`s, which take a second
 * connection while they run.
 */
export const DB_POOL_MAX = 10;

/**
 * How long a query waits for a free connection before it gives up.
 *
 * `pg.Pool`'s default is `0` — **wait for ever**. With the worker holding
 * several long transactions at once, an exhausted pool then means a request
 * that never answers and never errors: no timeout, no log line, nothing to see
 * in a stack. A bounded wait turns the same situation into a failed request
 * with a cause, which the mail worker records on the row and an HTTP route
 * turns into a 500.
 *
 * Comfortably above the slowest ordinary query and far below any client's
 * patience.
 */
export const DB_POOL_CONNECTION_TIMEOUT_MS = 10_000;

/**
 * The Prisma client as an injectable, tied to the Nest lifecycle.
 *
 * The connection string comes from the validated environment rather than from
 * `schema.prisma`: Prisma 7 no longer reads a `url` from the schema, and
 * routing it through `API_ENV` keeps one validated source for the whole
 * application.
 *
 * Extending `PrismaClient` rather than wrapping it is deliberate — a wrapper
 * would have to re-export every model delegate by hand and would drift the
 * moment a model is added.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(@Inject(API_ENV) env: ApiEnv) {
    super({
      adapter: new PrismaPg({
        connectionString: env.DATABASE_URL,
        max: DB_POOL_MAX,
        connectionTimeoutMillis: DB_POOL_CONNECTION_TIMEOUT_MS,
      }),
    });
  }

  /**
   * Connects eagerly instead of on first query, so a wrong `DATABASE_URL`
   * fails at startup rather than inside the first request a user makes.
   */
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
