import { z } from 'zod';

/**
 * **The operations status** — the five groups of figures at which earlier
 * build-out stages could break silently (ADR-0016 §3).
 *
 * ⚠️ **Installation-wide, and therefore without names.** This payload comes about
 * across *all* organisations; it carries sums and no identifiers. An
 * operations status that incidentally revealed which organisation currently has 400 mails in the
 * queue would be information about other organisations that no operation
 * needs — and a superadmin who needs it has the tenant administration.
 */

/**
 * The background runs, in the same order as `JobKind`.
 *
 * ⚠️ **Two spellings of the same set**, and that is deliberate: the schema
 * here is the wire contract, `JobKind` the database. They are held together
 * by `apps/api/test/observability/job-kinds.spec.ts` — before that they were held
 * only by the type checker, and that one says „nicht zuweisbar" at a place that
 * has nothing to do with the forgotten line.
 *
 * `ops_alert` is among them although it cleans nothing up: **the guard can fail
 * too**, and an alert path whose own failure nobody sees is
 * the quietest of all gaps.
 */
export const jobKindSchema = z.enum([
  'mail_worker',
  'mail_log_purge',
  'file_purge',
  'retention_purge',
  'ai_prompt_purge',
  'session_purge',
  'ops_alert',
]);
export type OpsJobKind = z.infer<typeof jobKindSchema>;

export const jobOutcomeSchema = z.enum(['ok', 'failed']);
export type OpsJobOutcome = z.infer<typeof jobOutcomeSchema>;

/**
 * What is to be seen of **one** run.
 *
 * `lastSuccessAt` is nullable and then means "has never yet run successfully in
 * this installation" — with a fresh installation the normal case,
 * with an old one the alarm.
 */
export const jobStatusSchema = z.object({
  job: jobKindSchema,
  /** Start of the last **successful** run, ISO-8601 or `null`. */
  lastSuccessAt: z.iso.datetime().nullable(),
  /** Start of the last run at all — a failed one included. */
  lastRunAt: z.iso.datetime().nullable(),
  lastOutcome: jobOutcomeSchema.nullable(),
  /** Items handled by the last run. */
  lastItemCount: z.number().int().nonnegative().nullable(),
  /**
   * The **class** of the last failure, never its message.
   * `null` if the last run succeeded.
   */
  lastErrorClass: z.string().nullable(),
});
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const mailQueueStatusSchema = z.object({
  queued: z.number().int().nonnegative(),
  /** All finally failed rows — the number the view shows. */
  failed: z.number().int().nonnegative(),
  /**
   * The failed rows **in the running window** — and only they trigger the
   * alarm (a review finding, 2026-08-12).
   *
   * ⚠️ **The difference is the one between a report and permanent noise.**
   * `failed` is a sum over the lifetime of the table (90 days, until the
   * purge takes hold). Six mistyped participant addresses — according to ADR-0013
   * expressly the normal case — lifted it permanently over the threshold, and
   * the guard afterwards reported **every six hours**, for three months,
   * the same long-known state. Exactly the sort of alarm that nobody
   * reads any more, and the repeat suppression cannot catch it: it slows
   * the frequency, not the cause. The specification has always said so — „zu
   * viele `failed`-Zeilen **seit dem letzten Alarm**".
   *
   * ⚠️ **Counting starts at `mail_log.failed_at`.** This column did not exist
   * at first, and the first version therefore counted from `created_at` — with the
   * sentence that in practice the two coincide, „zwischen Einreihen und Aufgeben liegen
   * die Wiederholungen eines Tages". The review on the same day refuted that
   * sentence: the retries are **~15 minutes** (`MAIL_BACKOFF_BASE_MS`
   * 60 s, five attempts), and upwards the distance is *unbounded* — „↻
   * Erneut" puts an arbitrarily old row back into the queue, and
   * after a worker outage rows fail that were enqueued long outside any
   * window. Both cases would have counted **0** and stayed
   * silent. It is thus the model example of this project's third yardstick
   * sentence: a proof whose premise („die beiden
   * Zeitpunkte liegen dicht beieinander") nobody checked measures something
   * other than what it claims.
   */
  failedRecently: z.number().int().nonnegative(),
  /**
   * Start of the waiting time of the **oldest** still open row — the number from
   * which the 30-minute threshold draws its alarm.
   */
  oldestQueuedAt: z.iso.datetime().nullable(),
});
export type MailQueueStatus = z.infer<typeof mailQueueStatusSchema>;

export const storageStatusSchema = z.object({
  /**
   * Occupied bytes in the upload directory — **`null` if not collected**.
   *
   * The number comes from a recursive run over the whole store, one
   * `stat` per file. For the view that is fine: it is opened by a
   * human. The alarm guard, by contrast, read the same status **every
   * five minutes** and **never** used this number — it decides solely on the
   * share of the volume. On a full store this was the most expensive
   * loop of the application, and it paid into nothing.
   *
   * `null` therefore means "not collected", not "zero bytes". A `0` at
   * this place would be the sort of number one takes for measured.
   */
  usedBytes: z.number().int().nonnegative().nullable(),
  /** Number of files — `null` for the same reason as {@link usedBytes}. */
  files: z.number().int().nonnegative().nullable(),
  /**
   * Share of the volume on which the store lies — `null` if the
   * operating system does not give it up.
   *
   * **The share and not the remaining bytes**, because the threshold is worded
   * in per cent (85 %) and an operator would otherwise have to divide two numbers
   * in their head.
   */
  usedFraction: z.number().min(0).max(1).nullable(),
});
export type StorageStatus = z.infer<typeof storageStatusSchema>;

/**
 * **One row of the volume evaluation** — per model and resolved version.
 *
 * The point of the split: `model` is the identifier that was called with —
 * since the alias decision a **moving** name. `resolved` is the
 * dated version that stood behind it. Two rows with the same `model`
 * and different `resolved` are exactly what the column exists for: the
 * provider moved the alias on in the middle of the month.
 *
 * ⚠️ **Volumes, not costs** (expressly). Neither of the two
 * provider APIs delivers prices; a hand-maintained price table would age
 * silently. What stands here are calls and tokens — the bill comes from the
 * provider, and these numbers say how it came about.
 */
export const aiModelUsageSchema = z.object({
  /** The called identifier — under an alias therefore the alias. */
  model: z.string().min(1),
  /**
   * The dated version behind it, or `null`.
   *
   * `null` is a regular state and not a gap: Anthropic carries no
   * alias field, and a row from the time before this column has none.
   */
  resolved: z.string().min(1).nullable(),
  calls: z.number().int().nonnegative(),
  /**
   * Sum of the tokens, `null` if **no** row of this group carries a
   * number — not `0`. The difference is the one between "nothing consumed"
   * and "the provider said nothing" (assumption A8).
   */
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
});
export type AiModelUsage = z.infer<typeof aiModelUsageSchema>;

export const aiStatusSchema = z.object({
  /** Calls in the running calendar month, across all organisations. */
  calls: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  /** `null` if no call took place in the period — not `0`. */
  failureRate: z.number().min(0).max(1).nullable(),
  /**
   * The same calls, broken down by model and version — descending
   * by calls, and **uncapped**.
   *
   * Uncapped, because the quantity is bounded by human action: there
   * are as many rows as there were different models configured in this
   * month (today six to choose from). A silent upper bound would be
   * the worse thing here — it would look like completeness.
   */
  byModel: z.array(aiModelUsageSchema),
});
export type AiStatus = z.infer<typeof aiStatusSchema>;

export const opsStatusSchema = z.object({
  /** The version that **this process** carries. */
  version: z.string().min(1),
  mailQueue: mailQueueStatusSchema,
  jobs: z.array(jobStatusSchema),
  storage: storageStatusSchema,
  ai: aiStatusSchema,
  /** Time of collection — so that a displayed number has an age. */
  observedAt: z.iso.datetime(),
});
export type OpsStatus = z.infer<typeof opsStatusSchema>;

export function parseOpsStatus(source: unknown): OpsStatus {
  return opsStatusSchema.parse(source);
}

/**
 * **The thresholds from the concept** — shared, because alarm (server) and
 * view (client) have to mean the same limit.
 *
 * If the number lay in both places, the traffic light in the operations status would at some point be
 * green while the alarm had long since fired — and nobody would know which
 * of the two is right.
 */
export const OPS_THRESHOLDS = Object.freeze({
  /** Oldest `queued` row: 30 minutes. */
  mailQueueAgeMs: 30 * 60 * 1000,
  /**
   * Last **successful** run: 26 hours.
   *
   * The only number of this table that was not freely chosen: the runs go on a
   * 24-hour cycle, and 26 leaves a delayed run some room without swallowing
   * a failed one.
   */
  jobSuccessAgeMs: 26 * 60 * 60 * 1000,
  /** Fill level of the store: 85 %. */
  storageUsedFraction: 0.85,
  /** AI failure rate in the period: 25 %. */
  aiFailureRate: 0.25,
} as const);

/**
 * The window over which failed messages are counted for the alarm.
 *
 * Six hours, and the number is **the same** as the repeat suppression of the
 * guard — that is not a coincidence but the condition for the two
 * fitting together: what has been added since the last alarm is exactly what
 * a new alarm would report. Two different numbers here would produce
 * either gaps (window shorter than the suppression: failures in between fall
 * through the cracks) or duplicate reports (window longer).
 *
 * ⚠️ **A literal of its own nonetheless and not a derivation.** `ALERT_REPEAT_
 * SUPPRESSION_MS` applies to all five metrics, this number only to the
 * mail queue; building the one from the other would mean making the promise of
 * the one silently dependent on the other. That they are equal is checked by
 * a test case — the reasoning for it stands here, the proof there.
 */
export const MAIL_FAILURE_WINDOW_MS = 6 * 60 * 60 * 1000;

/** How a single metric currently stands. */
export type OpsSeverity = 'ok' | 'alert';

/**
 * Whether a number has **exceeded** its threshold.
 *
 * Deliberately a `>` and not a `>=`: the threshold itself is still the permitted
 * state. A run that is exactly 26 hours ago has kept the deadline.
 */
export function exceeds(value: number | null, threshold: number): boolean {
  return value !== null && value > threshold;
}
