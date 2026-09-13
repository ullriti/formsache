import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  AI_PROMPT_RETENTION_DAYS,
  AI_USAGE_PERSON_RETENTION_DAYS,
  type ApiEnv,
} from '@formsache/shared';

import { JobKind } from '@prisma/client';

import { API_ENV } from '../../config/env';
import { MailClock } from '../../mail/mail-clock';
import { PrismaService } from '../../prisma/prisma.service';
import { JobRunService } from '../../observability/job-run.service';

const MS_PER_DAY = 86_400_000;

/**
 * The point in time before which the free text of an AI request has to
 * disappear.
 *
 * A pure function of the injected clock, counted from `created_at` — the column
 * there is only one of here: an AI request has no second point in time at which
 * it would be „fertig" (the `mail_log` purge has to make this choice and gives
 * its reasons in the same place).
 *
 * The number comes from `@formsache/shared` and is **the same** constant the
 * surface writes its sentence about retention from (ADR-0015 no. 8). Two
 * spellings would be two promises, and the half an editor reads would not be
 * the half that deletes.
 */
export function aiPromptPurgeCutoff(now: Date): Date {
  return new Date(now.getTime() - AI_PROMPT_RETENTION_DAYS * MS_PER_DAY);
}

/**
 * The point in time before which a usage row has to lose its **person**.
 *
 * The same pure function of the same injected clock as
 * {@link aiPromptPurgeCutoff}, only with the other deadline. Two deadlines on
 * one table, and they deliberately measure from **the same** column
 * (`created_at`): an AI request has no second point in time at which it would
 * be „fertig".
 */
export function aiUsagePersonCutoff(now: Date): Date {
  return new Date(now.getTime() - AI_USAGE_PERSON_RETENTION_DAYS * MS_PER_DAY);
}

/**
 * **Deletes the free text of an AI request after 30 days — physically, and
 * without taking the counter with it** (ADR-0015 no. 8).
 *
 * ## An `UPDATE`, not a `DELETE`, and that is the whole point
 *
 * `ai_usage` carries two things with two lifetimes: the **consumption**, which
 * carries the monthly quota, and the **text**, which is the occasion of a cost
 * complaint. Deleting the row is the obvious and wrong construction — it would
 * reset the limit after thirty days, an organisation would tacitly get a second
 * quota, and the fault would strike nobody, because both lie in the same table.
 * So: `prompt = NULL`, `prompt_erased_at = now`,
 * row stays.
 *
 * **„Physisch" here means what it means everywhere in this system:** the value
 * is gone from the living row, no flag covers it. That is checked with a
 * **raw** `SELECT prompt` plus a `count(*)` **without a filter** — a test that
 * asked the repository would only prove that the repository filters.
 *
 * ## Start run **and** interval
 *
 * Both, and the start run is the more important one: the shipped interval is
 * one day, so „armiert" alone would mean that an installation which is rolled
 * out anew every day, hangs in a crash loop or runs on a host that restarts at
 * night **never** deletes a row — while the surface goes on promising thirty
 * days. That is the operating fault, found at the `mail_log` purge, and here
 * stands the same answer.
 *
 * ## It runs even when the AI is switched off
 *
 * Deliberately without any check on `aiAvailable`: an installation that removes
 * the key has thereby revoked no deletion promise, but only stopped producing
 * new texts. A purge that switches itself off with the feature would leave
 * exactly those texts lying for ever that nobody needs any more.
 *
 * ## What this job logs, and what not
 *
 * **Numbers and kinds of error — never a free text, never a key.** The guard
 * once forbade every log line under `src/ai`, and precisely here that did the
 * damage that was to be expected: a purge that cannot say „ich scheitere seit
 * vier Wochen" makes a deletion promise unobservable. By now the guard is
 * narrowed to `src/ai/*.ts` — seam and adapter, where the key lies — and
 * `key-confinement.spec.ts` checks the narrowing as an equality **and** as an
 * exclusion of exactly this file.
 *
 * This class takes the permission up, and that is a **review finding**
 * (security review, 2026-08-10): the narrowing was built, the silence here had
 * remained, and three comments went on claiming it was enforced. The number
 * additionally remains the **return value** of {@link runOnce}, because
 * idempotence is only checkable on it.
 *
 * ## Across organisations, deliberately
 *
 * No request, no caller, no tenant parameter — selection runs by `created_at`
 * and by whether there is any text there at all. That is why
 * `apps/api/src/ai/purge/**` stands on the `PrismaService` allow-list in
 * `eslint.config.js`, and the counter-check is the boundary: `apps/api/src/ai/**`
 * without `purge` does **not** stand on it and goes through the `TenantScope` delegate.
 */
@Injectable()
export class AiPromptPurgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AiPromptPurgeService.name);
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
    const interval = this.env.AI_USAGE_PURGE_INTERVAL_MS;
    if (interval <= 0) {
      return;
    }
    // Armed here, per process: nothing outside remembers that a purge is due —
    // the application does, every time it comes up.
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref();

    // **And once immediately, not only one interval later.**
    // See the class comment: without this line an installation rolled out anew
    // every day never deletes. Through the same `purging` guard as every
    // scheduled run, so that a long first pass and the first tick do not
    // overlap.
    void this.tick();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    // A purge that survives `close()` would write against a database the
    // caller has already released, and would log the failure as a
    // defect.
    await this.purging;
  }

  get schedulerRunning(): boolean {
    return this.timer !== undefined;
  }

  /**
   * Empties what lies beyond the deadline, and answers with **the number of
   * rows**.
   *
   * The number is the return value and not a log line, because idempotence is
   * only checkable on it: a second run answering `0` distinguishes „da war
   * nichts mehr" from „er ist vorher umgefallen".
   *
   * `prompt IS NOT NULL` is the second half of that **and** the condition that
   * keeps `prompt_erased_at` honest: otherwise a second run over the same row
   * would rewrite the stamp to the later run, and the point in time of the
   * deletion would wander further forward with every day.
   */
  async runOnce(): Promise<number> {
    const now = this.clock.now();
    const cutoff = aiPromptPurgeCutoff(now);
    const count = await this.prisma.$executeRaw`
      UPDATE "ai_usage"
         SET "prompt"           = NULL,
             "prompt_erased_at" = ${now}
       WHERE "created_at" < ${cutoff}
         AND "prompt"     IS NOT NULL`;
    return count;
  }

  /**
   * **Takes the row's person away, and leaves the counter standing** .
   *
   * Two deadlines on one table, and they are deliberately two statements and
   * not one with two conditions: they take effect at different times (30
   * against 365 days) and do different things. A common statement would have to
   * carry `CASE` branches and would have to be read anew on every change to
   * either of the two deadlines.
   *
   * `user_id IS NOT NULL` is the same idempotence condition `runOnce` lays over
   * `prompt`: a second run over the same row changes nothing, and the returned
   * number therefore distinguishes „da war nichts mehr" from „er ist vorher
   * umgefallen".
   *
   * ⚠️ **No stamp like `prompt_erased_at`, and that is no oversight.** A
   * deletion time beside an emptied person reference would itself again be a
   * statement about *this* person („hier war jemand, am 3. Mai"). What the
   * counter carries after this statement is organisation, month, model and
   * consumption — and nothing else.
   */
  async erasePersons(): Promise<number> {
    const cutoff = aiUsagePersonCutoff(this.clock.now());
    return this.prisma.$executeRaw`
      UPDATE "ai_usage"
         SET "user_id" = NULL
       WHERE "created_at" < ${cutoff}
         AND "user_id"    IS NOT NULL`;
  }

  /** One scheduled run; never rejects, for the reason the worker's tick gives. */
  private tick(): Promise<void> {
    this.purging ??= this.runTick().finally(() => {
      this.purging = undefined;
    });
    return this.purging;
  }

  /**
   * A scheduled run that **never** rejects: a rejected promise out of a
   * `setInterval` terminates the process (`unhandledRejection`), and a purge is
   * no reason to terminate the application.
   *
   * It does, however, **report** what happened to it. An empty `catch` here was
   * the finding: the due rows stay lying, the next run takes them — and a
   * permanently failing purge would only be visible on the rows themselves,
   * which nobody looks at, while the surface promises 30 days.
   *
   * What gets logged is the **kind** of the error, not its content: `message`
   * of an `Error` instance and otherwise the constructor name. No `stack`, no
   * `cause`, no value out of the row — a Prisma error can carry parameters
   * along, and the parameter of this job is the free text it is about to
   * delete.
   */
  private async runTick(): Promise<void> {
    try {
      /*
       * the requirement — **both deadlines in *one* booking.**
       *
       * `erasePersons()` stood behind `record(...)` until 2026-08-12, and the
       * comment beside it claimed the second deadline „zähle mit". It did
       * not: the `job_run` row had long been written with `outcome = 'ok'`
       * when the anonymisation failed. A permanently failing
       * `erasePersons()` — the 12-month promise out of the concept — thus
       * left a green row behind every night, and the operations watch read
       * exactly that row.
       *
       * Both on one beat stays right (a second scheduler for the same table
       * would be a second place at which „läuft das noch?" has to be asked);
       * what is booked now is the whole beat. `itemCount` remains the number
       * of deleted free texts — that is the number the view shows.
       */
      const { count, anonymised } = await this.jobRuns.recordRun(
        JobKind.ai_prompt_purge,
        async () => {
          const erased = await this.runOnce();
          const persons = await this.erasePersons();
          return {
            result: { count: erased, anonymised: persons },
            itemCount: erased,
          };
        },
      );
      if (anonymised > 0) {
        this.logger.log(
          `ai usage purge: ${String(anonymised)} row(s) older than ` +
            `${String(AI_USAGE_PERSON_RETENTION_DAYS)} days lost their person`,
        );
      }
      if (count > 0) {
        // Only the number. One line per deleted prompt would be the log that
        // survives the purge (`CONTRIBUTING.md`).
        this.logger.log(
          `ai prompt purge: ${String(count)} prompt(s) older than ` +
            `${String(AI_PROMPT_RETENTION_DAYS)} days erased`,
        );
      }
    } catch (error: unknown) {
      this.logger.error(
        `ai prompt purge failed: ${describePurgeFailure(error)}`,
      );
    }
  }
}

/**
 * The **kind** of error, in one line, without the content.
 *
 * ⚠️ **Since a review finding the class, not the message.** The earlier version
 * handed out `error.message`, on the grounds that a Prisma message was
 * „brauchbar und harmlos". That is true for the normal case and not for the one
 * that matters: on a constraint error Prisma quotes the **values** of the
 * query, and what this class has in hand is the free text it is supposed to
 * delete. A log that quotes the free text breaks the deletion promise at
 * exactly the moment it is needed.
 *
 * The same rule holds in all four clean-up runs; the purge of the wastebasket
 * has kept to it from the start.
 */
function describePurgeFailure(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}
