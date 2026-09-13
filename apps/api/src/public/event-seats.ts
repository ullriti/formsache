import type { Prisma } from '@prisma/client';
import {
  seatKey,
  type SeatPosition,
  type SeatRequest,
} from '@formsache/shared';

/**
 * **The seats already taken, and the verdict over them** — the database half of
 * the participant limit.
 *
 * The arithmetic lives in `@formsache/shared` (`event-seats.ts`,
 * `exhaustedPosition`); what is here is the one query it needs and the rule
 * about *when* that query may be trusted. Both belong together in one small file
 * rather than inside the 2000 lines of `public-forms.service.ts`, because the
 * whole claim of the requirement rests on three lines of SQL and on the sentence
 * above them.
 */

/** The transaction handle — the same shape `claimAttachments` takes. */
type Tx = Prisma.TransactionClient;

/**
 * **Locks the form row** — the same `SELECT … FOR UPDATE` the Antwortlimit
 * takes, on the same row, for the same reason.
 *
 * This is the hard build and not the soft one of the Versandbudget, and
 * the difference is what it costs to be wrong: a mail budget overrun by a few
 * messages is harmless, an Obergrenze overrun by three people means three of
 * them stand in front of a full hall. Without the lock, twenty submissions
 * arriving at once each read a sum none of the others had committed yet and each
 * concludes there is room — measured as 15 rows against a limit of 10,
 * and measured again for this claim (see `event-limit.spec.ts`).
 *
 * The form row is the right thing to lock even though the seats are counted from
 * `event_registration`: it is **one** row per form, so every submission to one
 * form serialises against the same object and no two can interleave, and it is
 * the row the Antwortlimit already locks — two different lock objects on one
 * write path would be two lock orders and therefore a deadlock waiting for the
 * first form that has both a limit and a Veranstaltung.
 *
 * ⚠️ **A sequential run passes without this call.** That is why the proof is a
 * pair (the evidence and 2) and why removing the lock has to be *measured*
 * rather than reasoned about.
 *
 * **`tenant_id` is in the `WHERE`** (a finding of the query-conditions review), for the reason
 * {@link takenSeats} spells out one function further down: every caller already
 * holds the value, the composite foreign keys make a cross-tenant form
 * inexpressible anyway — and this statement now lives behind
 * `ScopedFormDelegate`, whose whole invariant is „`tenant_id` **in** der
 * Abfrage". The one statement without it was the one a later reader would have
 * copied.
 */
export async function lockForm(
  tx: Tx,
  formId: string,
  tenantId: string,
): Promise<void> {
  await tx.$queryRaw<unknown[]>`
    SELECT 1
      FROM "form"
     WHERE "id" = ${formId}::uuid
       AND "tenant_id" = ${tenantId}::uuid
       FOR UPDATE`;
}

/**
 * How many seats each position of one form already holds — **excluding the
 * trash** .
 *
 * `deleted_at IS NULL` on the joined answer is the whole of that rule: an
 * answer in the trash frees its seats immediately, which is what „ich habe
 * die Absage eingetragen, jetzt ist wieder Platz" means. It is a join rather than
 * a column on `event_registration` for the reason the model states — one state,
 * one place.
 *
 * One query for every position of the form rather than one per position: the
 * caller holds the lock while this runs, and a round trip per Veranstaltung on a
 * form with six of them would hold it six times as long for the same answer.
 *
 * **Not tenant-scoped in the `WHERE`, and that is deliberate**: `form_id` is a
 * form, a form belongs to exactly one organisation by its composite foreign key, and the
 * id comes from the row the public slug resolved to — never from the request.
 * Adding `tenant_id` would read as a boundary this query does not enforce and
 * would not enforce it any better.
 *
 * **The tenant is in the `WHERE` all the same** (the query-conditions review). The composite
 * foreign keys already make a cross-tenant row inexpressible, so this predicate
 * cannot change the answer — but every other query in this application spells
 * the tenant out (`CONTRIBUTING.md`), and an exception that only a comment
 * distinguishes from an oversight is the exception a later reader copies.

 *
 * The sum is returned as a `Map` keyed by {@link seatKey}, i.e. in exactly the
 * shape `exhaustedPosition` reads.
 */
export async function takenSeats(
  tx: Tx,
  formId: string,
  tenantId: string,
): Promise<Map<string, number>> {
  const rows = await tx.$queryRaw<
    { question_id: string; event_key: string; taken: bigint }[]
  >`
    SELECT er."question_id", er."event_key", SUM(er."seats")::bigint AS taken
      FROM "event_registration" er
      JOIN "response" r ON r."id" = er."response_id"
     WHERE er."form_id"   = ${formId}::uuid
       AND er."tenant_id" = ${tenantId}::uuid
       AND r."tenant_id"  = ${tenantId}::uuid
       AND r."deleted_at" IS NULL
     GROUP BY er."question_id", er."event_key"
  `;

  return new Map(
    rows.map((row) => [
      seatKey({ questionId: row.question_id, eventKey: row.event_key }),
      // `SUM` over an INTEGER column is `bigint` in PostgreSQL and arrives as a
      // JavaScript `bigint`; converted once, here. It cannot overflow `Number`:
      // one row is at most `EVENT_SEATS_MAX` and a form is bounded by its own
      // answer limit long before 2^53 people register for anything.
      Number(row.taken),
    ]),
  );
}

/**
 * How many seats **this one answer** already holds, per position.
 *
 * The counterpart of {@link takenSeats} and read from the same table on purpose:
 * the Bearbeiten difference is only sound while „was diese Antwort hält" is the
 * exact share of the sum that belongs to it. Reading the previous *answer
 * document* instead would be a second description of the same fact — and the
 * two can only agree by luck, because the sum is built from the rows.
 *
 * **There are no answers with seats but without rows**, and that is worth
 * writing down because the capacity-lock review asked for a backfill migration on the
 * strength of one it had built by hand. The `event` question type and this
 * table arrived in the *same* commit (`b9fffbe`), which wrote a row for every
 * seat from its first line: a form could not carry an `event` question before
 * it, so no answer written before it can name a seat. The state is not
 * migrated away from — it never existed.
 *
 * **Not filtered by `deleted_at`, unlike the sum**, and the asymmetry is the
 * safe direction: an answer being edited is by definition not in the trash
 * (`loadForEdit` refuses it), so in every reachable case these rows *are* part
 * of {@link takenSeats}. Should one be moved there between the read and this
 * transaction, the difference comes out too **small** — never too large — so the
 * worst outcome is an edit that passes the Obergrenze and is then refused a few
 * lines later by the `deleted_at IS NULL` of its own `UPDATE`, with nothing
 * written either way.
 *
 * ⚠️ **That argument holds only as long as nothing *restores* an answer**, and
 * a review was right to say so. A restore between {@link takenSeats}
 * and the commit lowers the sum this transaction read, and then the edit can
 * overbook — its own `UPDATE` has nothing to object to.
 *
 * **There is such a route now, and it takes this lock**:
 * `ScopedFormDelegate.restoreResponse` (`tenancy/tenant-scope.ts`) calls
 * {@link lockForm} — this very function, on this very row — before it counts
 * anything and before it clears `deleted_at`. That is what keeps the paragraph
 * above true instead of merely unreached: a restore can no longer land inside
 * another transaction's window, because it waits for that transaction's lock.
 * The line was „heute unerreichbar" until then, which is the weaker of the two
 * guarantees and the one that quietly expires.
 */
export async function heldSeats(
  tx: Tx,
  where: { responseId: string; tenantId: string },
): Promise<Map<string, number>> {
  const rows = await registeredSeats(tx, where);

  return new Map(rows.map((row) => [seatKey(row), row.seats]));
}

/**
 * The same rows as {@link heldSeats}, **as positions rather than as a map** —
 * what the trash needs.
 *
 * The restore of an answer asks a question the map cannot answer: not „wie viel
 * hält diese Antwort an dieser Stelle" but „welche Stellen kommen zurück, und
 * mit wie vielen Plätzen". It needs the pair back, because it has to look each
 * position's Obergrenze up in the live form (`withLiveCapacity`) before
 * `exhaustedPosition` can judge it.
 *
 * **These rows, and not a second reading of the answer document.** Restoring an
 * answer puts exactly these rows back into `takenSeats` — they were never
 * deleted, only excluded by the `deleted_at IS NULL` of that join — so they
 * *are* what the sum will grow by. Re-deriving the seats from `answers` would
 * be a second description of the same fact, and the two can then disagree: a
 * snapshot that no longer parses would silently yield „keine Anmeldung" and
 * restore a registration for twelve people past a full hall, with the rows
 * arriving all the same.
 *
 * `capacity` is deliberately absent from the result. It is not a property of
 * the registration; it comes from the form as it stands today, and the one
 * place that decides it is `withLiveCapacity`.
 *
 * **Ordered, so that „unsortiert" is not mistaken for „in der Reihenfolge der
 * Definition"** (a finding of the query-conditions review). This ordering is not that one and
 * cannot be — the table knows nothing about pages, questions or the editor's
 * arrangement — it only makes the result *the same* from one run to the next.
 * The definition's order is put on afterwards, by `inDefinitionOrder` in
 * `@formsache/shared`, and this is what keeps the positions that definition does not
 * name (a Veranstaltung the organisation has since removed) from shuffling under a
 * stable sort.
 */
export async function registeredSeats(
  tx: Tx,
  where: { responseId: string; tenantId: string },
): Promise<(SeatPosition & { seats: number })[]> {
  const rows = await tx.eventRegistration.findMany({
    where: { responseId: where.responseId, tenantId: where.tenantId },
    select: { questionId: true, eventKey: true, seats: true },
    orderBy: [{ questionId: 'asc' }, { eventKey: 'asc' }],
  });

  return rows.map((row) => ({
    questionId: row.questionId,
    eventKey: row.eventKey,
    seats: row.seats,
  }));
}

/**
 * **The difference for**: what a correction wants *on top of*
 * what it already holds.
 *
 * Handed to `exhaustedPosition` as its `delta`, which is the whole reason that
 * parameter exists. Both mistakes worth naming are one line apart here:
 * checking `request.seats` (the new value) would refuse a rise from 3 to 4 on a
 * limit of 10 with 8 seats taken, because the answer's own 3 are inside those 8
 * and would be counted a second time; checking the *old* value would let any
 * rise through untested. A reduction comes out negative and
 * `exhaustedPosition` never refuses it — „wer von 5 auf 3 geht, gibt zwei
 * Plätze frei, sofort".
 */
export function seatsBeyond(
  held: ReadonlyMap<string, number>,
): (request: SeatRequest) => number {
  return (request) => request.seats - (held.get(seatKey(request)) ?? 0);
}

/**
 * Writes the seats of one answer.
 *
 * Only from {@link SeatRequest}s, i.e. only from the shared reader of the same
 * answer document the JSONB column receives — the one thing that keeps the
 * normalised rows and the answer from becoming two different facts. Nothing is
 * written for an event nobody registered for: „keine Anmeldung" is the absence
 * of a row (the `CHECK (seats >= 1)` in the migration says so too).
 */
export async function writeSeats(
  tx: Tx,
  where: { formId: string; tenantId: string; responseId: string },
  requests: readonly SeatRequest[],
): Promise<void> {
  if (requests.length === 0) {
    return;
  }
  await tx.eventRegistration.createMany({
    data: requests.map((request) => ({
      tenantId: where.tenantId,
      formId: where.formId,
      responseId: where.responseId,
      questionId: request.questionId,
      eventKey: request.eventKey,
      seats: request.seats,
    })),
  });
}
