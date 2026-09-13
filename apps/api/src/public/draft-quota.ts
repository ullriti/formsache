import type { Prisma } from '@prisma/client';
import { MAX_DRAFTS_PER_FORM } from '@formsache/shared';

/**
 * **How many drafts a form may carry at the same time, enforced in the
 * statement that writes the next one** (a review finding).
 *
 * ## What was unbounded without this file
 *
 * `POST /public/forms/:slug/drafts` is reachable by anyone with the address, is
 * bounded by a rate limit — thirty writes per minute per address — and by
 * nothing else. The rate limit bounds the *speed*; there was no bound on the
 * *number*. *Measured on 2026-08-05:* 30 drafts a minute from **one** address,
 * a textarea without `maxLength` → **101 462 bytes** of stored JSONB payload
 * per row, so about 3 MiB per minute and address, sessionless, visible to
 * nobody and with a lifetime of thirty days. Nothing in the
 * application shows an editor that these rows exist, so nothing would have
 * been noticed until the volume was.
 *
 * ## Why the bound sits *in* the `INSERT`
 *
 * A count read a moment earlier and compared in TypeScript is a check that is
 * true when it is made and false when it is used — the exact shape of the
 * Antwortlimit before it was put behind a lock. Here the bound sits in the
 * `WHERE` of the insert itself, so the row that would break it is simply not
 * written and the answer is „nichts eingefügt" rather than an exception.
 *
 * ⚠️ **It is a ceiling, not an exact quota.** Under `READ COMMITTED` two
 * inserts arriving at the same instant can both see a count of `N - 1` and both
 * land, so the table may hold a handful of rows more than
 * {@link MAX_DRAFTS_PER_FORM}. That is deliberate: the alternative is the form
 * lock, and serialising every draft save of a Jahrestagung registration to
 * protect a number chosen an order of magnitude above honest use would cost far
 * more than the overshoot. The participant limit takes the lock because being
 * three over means three people stand in front of a full hall; being three
 * drafts over means nothing.
 *
 * ## Why raw and not `prisma.responseDraft.create`
 *
 * There is no Prisma spelling for „insert if a count is below N" — the fluent
 * API has no `INSERT … SELECT … WHERE`. Raw SQL in `apps/api/src/public/**` is
 * the established shape for exactly this kind of statement (`lockForm`,
 * `takenSeats`, `claimAttachments`), and every value below travels as a bound
 * parameter.
 *
 * **`gen_random_uuid()` writes a v4 where Prisma would have written a v7.** The
 * difference is named rather than hidden: nothing reads an ordering off this
 * key — the purge pages by `(expires_at, id)`, where `id` is the tiebreaker
 * that makes the order total and not a sort criterion — and the alternative
 * would be a second uuid v7 implementation in this repository for one column.
 */
export async function insertDraftWithinLimit(
  db: DraftInsertClient,
  draft: {
    readonly tenantId: string;
    readonly formId: string;
    readonly formVersionId: string;
    readonly token: string;
    readonly answers: Record<string, Prisma.InputJsonValue>;
    readonly expiresAt: Date;
  },
): Promise<string | null> {
  const written = await db.$queryRaw<{ id: string }[]>`
    INSERT INTO "response_draft"
      ("id", "tenant_id", "form_id", "form_version_id",
       "token", "answers", "created_at", "updated_at", "expires_at")
    SELECT gen_random_uuid(),
           ${draft.tenantId}::uuid,
           ${draft.formId}::uuid,
           ${draft.formVersionId}::uuid,
           ${draft.token},
           ${JSON.stringify(draft.answers)}::jsonb,
           now(),
           now(),
           ${draft.expiresAt}::timestamptz
     WHERE (
             SELECT count(*)
               FROM "response_draft"
              WHERE "tenant_id" = ${draft.tenantId}::uuid
                AND "form_id"   = ${draft.formId}::uuid
           ) < ${MAX_DRAFTS_PER_FORM}
    RETURNING "id"`;
  return written[0]?.id ?? null;
}

/**
 * The one method this needs — the same narrowing `claimAttachments` takes, so
 * the caller may hand in a transaction client or the service itself.
 *
 * **`$queryRaw` rather than `$executeRaw`/0-C**, because the caller
 * needs the id back: an attachment of this draft is claimed *for* it in the
 * same transaction (`claimForDraft`), and the id is what says
 * which draft. Reading it afterwards with a second `SELECT` on the token would
 * be one more round trip for a value the `INSERT` already has.
 */
export interface DraftInsertClient {
  $queryRaw: <T>(
    query: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<T>;
}
