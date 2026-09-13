import { z } from 'zod';

/**
 * **The quota and the retention of an AI request** (ADR-0015 no. 7 and
 * no. 8, the requirements).
 *
 * Two promises live here and both are made by the interface as well as kept by
 * the server, which is the whole reason they are in `packages/shared` rather
 * than in `apps/api`:
 *
 * - **how many calls an organisation has in the calendar month** — the number the
 *   dialogue shows as „Verbrauch und Rest" and the number the counter refuses
 *   against;
 * - **how long the typed free text stays put** — the sentence the
 *   dialogue prints under the input field and the deadline the purge measures.
 *
 * Two spellings would be exactly the drift here against which `pickDefaultColumns`
 * was shared: the half that an organisation reads would not be the half
 * that deletes.
 */

/**
 * **How long the free text of an AI request stays put** .
 *
 * The same deadline as the wastebasket, and it is a **constant, not an
 * environment variable** — the same reasoning as with `TRASH_RETENTION_DAYS` and
 * `UNCLAIMED_FILE_LIFETIME_MS` (ADR-0015 no. 8): an environment variable would put
 * a deletion promise, which the interface makes continuously, into the hand of an
 * operator. Configurable is only the **timing** of the job
 * (`AI_USAGE_PURGE_INTERVAL_MS`), never the deadline.
 *
 * Read from exactly two places: the purge, which sets the text to `NULL`, and
 * the notice that the interface makes about the retention.
 */
export const AI_PROMPT_RETENTION_DAYS = 30;

/**
 * **How long the usage row keeps its person**  — in days.
 *
 * `AI_PROMPT_RETENTION_DAYS` above decides the **free text**, and concept
 * no. 81 explicitly decided only that one. The row stayed put afterwards
 * and went on carrying organisation, **person**, time, model and consumption — without
 * any deadline, in a project with wastebasket 30, prompts 30 and `mail_log`
 * 90. That was the outlier, and this constant closes it.
 *
 * ## Why anonymise and not delete
 *
 * The question these rows are there for in the first place — "what has the AI
 * cost us" — needs organisation, month, model and tokens. It does **not** need
 * *who* pressed the button. Deleting the whole row would mean throwing away the
 * cost history in order to get rid of one datum that can be got rid of
 * separately.
 *
 * `user_id` is already nullable — the field already becomes `NULL` when an account
 * is removed (`schema.prisma`). So it is **the same build, not a
 * second one**, and it needs no migration.
 *
 * ## And why the counter lives on afterwards without a deadline
 *
 * Without a personal reference it is no longer personal data. A deadline on
 * an anonymous monthly total would be a promise without an object.
 *
 * **Twelve months**, because the smallest question that these numbers are
 * meant to answer is a year-on-year comparison ("more than last year?"). Shorter, and the
 * counter can no longer fulfil its own purpose; longer, and the
 * personal reference lives on without reason.
 */
export const AI_USAGE_PERSON_RETENTION_DAYS = 365;

/**
 * **The quota an organisation starts with** — calls per calendar month
 * (ADR-0015 no. 7).
 *
 * The column default of `tenant.ai_monthly_call_limit` and at the same time the
 * number that the interface suggests in the input field.
 *
 * **Why not 0.** A quota of 0 is the off switch per organisation
 * (ADR-0015 no. 9), and as a *default* it would be the quiet variant of the error
 * that this limit is meant to prevent: the feature would be set up, the menu entry there, the
 * route reachable — and every call would run into 429, without anything
 * about the configuration looking wrong. Whoever sets `AI_PROVIDER` **and** a
 * key has said "I want this feature and I bear the
 * bill"; the installation-wide shutdown is the missing key,
 * not a zero in fifty organisation rows.
 *
 * **Why 50 of all numbers** — and this is an **assumption**, not a measurement: one
 * generated form costs one call, an editor needs, from experience,
 * two to three attempts, and the organisations that use this application do not create fifty
 * forms a month. The number is thereby far above the expected consumption
 * and far below what makes a bill painful. The first measurement comes
 * with real operation (ADR-0015, assumption A8 neighbourhood); afterwards it is to be
 * corrected, and because it is a default, a correction changes **no**
 * value that an organisation has already set.
 */
export const DEFAULT_AI_MONTHLY_CALL_LIMIT = 50;

/**
 * **Consumption and remainder of an organisation in the running calendar month** .
 *
 * What the interface shows and what the 429 response carries along — the same shape for
 * both, so that "you have no calls left" and "you still have three" are not two
 * wire contracts.
 *
 * `used` counts **calls**, not successes: a failure of the provider counts
 * once (ADR-0015 no. 7), and a display that calculated that differently from the
 * counter would be the second truth about the same budget.
 */
export const aiQuotaSchema = z
  .object({
    /** Calls in this calendar month (Europe/Berlin), failures included. */
    used: z.number().int().nonnegative(),
    /** The organisation's quota. `0` means: switched off for this organisation. */
    limit: z.number().int().nonnegative(),
  })
  .readonly();
export type AiQuota = z.infer<typeof aiQuotaSchema>;

/**
 * How many calls are still left — never negative.
 *
 * A function instead of a third field in the schema: `remaining` would be a value
 * that two sides calculate independently and that can get out of step
 * as soon as `used` exceeds the limit (which it may — a lowered quota
 * does not undo calls already consumed).
 */
export function aiQuotaRemaining(quota: AiQuota): number {
  return Math.max(0, quota.limit - quota.used);
}

/**
 * **The upper limit that a superadmin may set for an organisation** (* ADR-0015 no. 7).
 *
 * It is a limit for the **input field**, not for the counter: the counter
 * knows no upper limit at all, it compares `used` against `limit`. It stands
 * here because a typo in a number field is otherwise a bill —
 * `50000` instead of `50` is three zeros and, at the providers' prices, a
 * four-digit sum.
 *
 * `10000` is deliberately far above every conceivable need of a single organisation (the
 * default is 50) and nevertheless an order of magnitude below "unlimited". Whoever needs
 * more has a decision to take, not a number to type in.
 */
export const AI_MONTHLY_CALL_LIMIT_MAX = 10_000;

/**
 * **What the superadmin sends when they set the quota of an organisation**
 * („das Nutzungslimit ist in der UI setzbar").
 *
 * `0` is valid and means **switched off for this organisation** (ADR-0015
 * no. 9) — not "unlimited", which would be the obvious and expensive misreading.
 * Hence `nonnegative()` and not `positive()`, and hence the statement stands
 * here and not only in the interface.
 *
 * **The organisation does not set its own number** : an organisation admin who
 * could raise their budget would be a cost lever that no guard
 * watches, and the operator bears the bill. The route therefore lies
 * under `admin/tenants/:tenantId`, behind `SuperadminGuard`, and `GET
 * /api/ai/quota` — what an organisation may **read** about itself — is a
 * different route with a different guard.
 */
export const aiQuotaWriteSchema = z.strictObject({
  monthlyCallLimit: z
    .number()
    .int()
    .nonnegative()
    .max(AI_MONTHLY_CALL_LIMIT_MAX),
});
export type AiQuotaWrite = z.infer<typeof aiQuotaWriteSchema>;

/** Parses the response of the set route — the value that now stands in the column. */
export function parseAiQuotaWrite(source: unknown): AiQuotaWrite {
  return aiQuotaWriteSchema.parse(source);
}
