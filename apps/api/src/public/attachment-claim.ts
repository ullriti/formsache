import type { Prisma } from '@prisma/client';
import {
  MAX_FILES_PER_RESPONSE,
  MAX_RESPONSE_BYTES,
  UNCLAIMED_FILE_LIFETIME_MS,
  isFileRef,
} from '@formsache/shared';

/**
 * **Claiming the attachments of a submission — the five conditions of ADR-0014
 * no. 13** .
 *
 * A file is uploaded **before** the answer exists. The submission names the
 * references of its files, and in the **same transaction** that writes the
 * `response` row every one of them is claimed with an `UPDATE` whose `WHERE`
 * carries five conditions. None of them implies another, and the ADR lists them
 * one by one because the first draft claimed one of them and did not write it:
 *
 * 1. **`response_id IS NULL`, or already this answer's** — not owned by anybody
 *    else. If the `UPDATE` touches no row the submission is refused. That is the
 *    mechanism against a double claim, not a read beforehand: two submissions
 *    racing for the same file both read „frei" and only one `UPDATE` wins.
 *
 *    The second half of the disjunction is what lets the **edit** path
 *    run the same statement: a correction re-sends the whole answer, so it
 *    names the files it already owns, and re-claiming one of those has to be a
 *    no-op rather than „Anhang abgelaufen". It weakens nothing — a file owned
 *    by *another* answer is still refused, which is what this condition guards,
 *    and the reproduction for it uses exactly that case.
 * 2. **`tenant_id` = the organisation of the resolved form.** **This is the tenant
 *    boundary of the operation**, and it stands on its own because no other
 *    condition contains it. `file` has no composite foreign key on
 *    `(form_id, tenant_id)` — Prisma requires every scalar of an *optional*
 *    relation to be optional and `tenant_id` is required — so a row with
 *    `form_id` of Organisation A and `tenant_id` of Organisation B **is expressible** through a
 *    raw write, a migration or a future second writer. The retrieval of no. 11(b)
 *    reads through the `TenantScope` delegate, i.e. through `tenant_id`: such a
 *    file, claimed without this condition, would be readable by the editors of
 *    the **wrong** Organisation.
 * 3. **`form_id` = the form of this submission.** So a file uploaded against
 *    form A cannot be hung onto an answer of form B — not even inside the same
 *    Organisation, where condition 2 says nothing.
 * 4. **`kind = 'response_attachment'`** — a Logo does not become an
 *    attachment.
 * 5. **`created_at > now − 24 h`, for a file that is still free** — younger than
 *    the purge deadline of no. 15,
 *    read from the **same** constant. Without it, claiming races the purge: the
 *    purge selects „ohne Eigentümer **und** älter als 24 h", and between its
 *    selection and its `remove()` the same row could be claimed. The result
 *    would be the worst outcome this ADR knows — a submitted answer with an
 *    attachment that has **no bytes**, no error at submission time, visible only
 *    when an editor clicks the link weeks later. With the condition it is an
 *    ordering rather than a race: age grows monotonically, so a row the purge
 *    picked at `t₀` as „older than 24 h" can never satisfy „younger than 24 h"
 *    at any `t₁ > t₀`. The submission is refused — readably — instead of
 *    carrying a silent hole.
 *
 *    **The age is asked of a *free* file only**, and that pairing is the reason
 *    conditions 1 and 5 sit in one clause rather than two: an answer's own
 *    attachment is claimed, so the purge does not touch it and it may be a year
 *    old. Asking the age of it as well would refuse every correction to an
 *    answer older than a day — „Anhang abgelaufen" for a file that is sitting
 *    right there.
 *
 *    **And the same holds for the *draft* this
 *    submission comes out of.** A file that belongs to that draft is not free
 *    either: it has an owner, the purge does not touch it, and it may be thirty
 *    days old. Asking its age would rebuild the exact Zumutung the concept removed —
 *    a proof uploaded on Monday and submitted on Wednesday refused as
 *    „abgelaufen" while the participant is looking at it. So the clause reads
 *    „already mine, or this draft's, or free and young", and the `draftId` is
 *    the id of the draft **this transaction is consuming**, resolved from the
 *    token under this form of this organisation and never taken from the request.
 *
 *    The same `UPDATE` **clears** `draft_id` while it writes `response_id`:
 *    that is the handover this design makes, and it is one statement because the
 *    `CHECK` of `file_kind_shape` refuses a row with two owners. A version that
 *    wrote only the answer would be a constraint violation rather than a file
 *    the draft purge and the answer both believe they own.
 *
 * The second bolt is in the purge itself (no. 15): it selects with
 * `SELECT … FOR UPDATE` and deletes the rows before it commits, so a concurrent
 * claim waits for that lock and re-evaluates its `WHERE` against a row that is
 * gone. Two mechanisms for one finding, because one of them would be a
 * statement about clocks.
 *
 * ## The per-answer limits are enforced here, and only here
 *
 * Ten files and 25 MiB per answer (no. 6): **before the submission there is no
 * answer to measure them against.** That is the split rather than a gap — upload
 * time is bounded by the per-address counters of no. 7 and by the rate limit of
 * no. 8, submission time by these two.
 */

/** Why a submission's attachments were refused. */
export const CLAIM_REFUSAL = {
  /** A reference that names nothing claimable — expired, foreign, or taken. */
  unavailable: 'attachment_unavailable',
  /** More files or more bytes than one answer may carry. */
  tooMany: 'attachment_limit',
} as const;

export type ClaimRefusal = (typeof CLAIM_REFUSAL)[keyof typeof CLAIM_REFUSAL];

/**
 * A refusal **throws**, and that is load-bearing rather than a style choice.
 *
 * The claim runs inside the transaction that writes the `response` row, and the
 * only way to undo statements already issued there is to abort it. Returning a
 * verdict would commit whatever was claimed before the verdict was reached —
 * an answer that exists with some of its attachments, or attachments claimed
 * for an answer that was never stored. `throw` is what makes „refused" mean
 * *nothing was written*.
 */
export class ClaimRefusedError extends Error {
  constructor(readonly refusal: ClaimRefusal) {
    super(`attachments refused: ${refusal}`);
    this.name = 'ClaimRefusedError';
  }
}

/**
 * The subset of a transaction client this needs — `$executeRaw` and one model.
 *
 * Typed as the transaction client of Prisma so the caller cannot hand in the
 * *unscoped* client by accident: claiming outside the answer's transaction is
 * precisely the shape no. 13 rules out.
 */
export type ClaimTransaction = Prisma.TransactionClient;

export async function claimAttachments(
  tx: ClaimTransaction,
  input: {
    readonly files: readonly { readonly ref: string; readonly name: string }[];
    readonly formId: string;
    readonly tenantId: string;
    readonly responseId: string;
    /**
     * The draft this submission is consuming, or `undefined` when it comes out
     * of none.
     *
     * It is the id of the row this very transaction resolved from the
     * submission's draft token **and holds a lock on**, never a value from the
     * request: a caller-named draft would be a way to claim somebody else's
     * attachment by naming their draft instead of their file.
     *
     * `undefined` is not a weaker case, it is a narrower one — the clause below
     * then matches no draft at all, so a file owned by *some* draft cannot be
     * claimed by a submission that is not that draft's.
     */
    readonly draftId?: string | undefined;
    /** The one clock — the same instant the purge deadline is measured from. */
    readonly now: Date;
  },
): Promise<void> {
  if (input.files.length === 0) {
    return;
  }

  // A reference is caller-written. Bounded and spelled before the database sees
  // it, for the reason `isPublicSlug` carries: `%00` arrives decoded as a NUL
  // byte, PostgreSQL refuses U+0000 in `text`, and the query throws — a 500
  // where every unknown address answers the same refusal.
  const refs = [...new Set(input.files.map((file) => file.ref))];
  if (refs.length !== input.files.length || !refs.every(isFileRef)) {
    throw new ClaimRefusedError(CLAIM_REFUSAL.unavailable);
  }

  // No. 6, first half: the **count**, before anything is written. Checked on
  // what the submission names rather than on what it managed to claim, so a
  // submission naming fifty files is refused for naming them.
  if (refs.length > MAX_FILES_PER_RESPONSE) {
    throw new ClaimRefusedError(CLAIM_REFUSAL.tooMany);
  }

  const oldest = new Date(input.now.getTime() - UNCLAIMED_FILE_LIFETIME_MS);

  // One statement per reference rather than one for all of them, because the
  // answer that matters is „**this** file could not be claimed" — a single
  // `updateMany` returning „4 of 5" cannot say which, and a submission that
  // silently dropped one attachment is exactly the hole condition 5 exists
  // against.
  const claimed: { byteSize: number | null }[] = [];
  for (const file of input.files) {
    const rows = await tx.$queryRaw<
      { byte_size: number | null; file_name: string }[]
    >`
      UPDATE "file"
         SET "response_id" = ${input.responseId}::uuid,
             -- The handover this design makes, in the same statement as the
             -- claim: one owner at a time, and file_kind_shape says so.
             "draft_id"    = NULL
       WHERE "public_ref"  = ${file.ref}
         AND "tenant_id"   = ${input.tenantId}::uuid
         AND "form_id"     = ${input.formId}::uuid
         AND "kind"        = 'response_attachment'::"file_kind"
         AND ("response_id" = ${input.responseId}::uuid
              OR ("response_id" IS NULL
                  AND ("draft_id" = ${input.draftId ?? null}::uuid
                       OR ("draft_id" IS NULL AND "created_at" > ${oldest}))))
      RETURNING "byte_size", "file_name"`;

    const row = rows[0];
    if (row === undefined) {
      // Zero rows updated is the one refusal for all five conditions: expired,
      // already claimed, another organisation's, another form's, or a Logo. One
      // answer, because five would be five oracles about rows the caller may
      // not know exist.
      throw new ClaimRefusedError(CLAIM_REFUSAL.unavailable);
    }
    /*
     * **The name in the answer is a checked copy, not a trusted one**.
     *
     * A `FileAnswer` carries the file name beside the reference, because the
     * export and the responses table render from the stored answer alone and
     * have no row to join (ADR-0014 no. 17). That makes the answer a second
     * *place* the name is written — and this comparison is what keeps it from
     * being a second *truth*: the row's `file_name` stays the only source, and
     * a submission may repeat it or be refused. Without it a participant could
     * hand an organisation a link labelled „Vollmacht.pdf" over bytes whose download
     * arrives as something else entirely — `Content-Disposition` is built from
     * the row (no. 10), so the two would simply disagree.
     *
     * Both sides are NFC (`fileNameSchema` normalises on the way in here and on
     * the way in at the upload), so this is a plain comparison and not a
     * normalisation decision made twice.
     */
    if (row.file_name !== file.name) {
      throw new ClaimRefusedError(CLAIM_REFUSAL.unavailable);
    }
    claimed.push({ byteSize: row.byte_size });
  }

  // No. 6, second half: the **bytes**. A row whose size is unknown (`pending`,
  // i.e. the crash window of no. 4) contributes nothing to the sum and is
  // refused instead — „wir wissen es nicht" must not read as „nichts", or the
  // total could be walked around by aborting uploads.
  let total = 0;
  for (const file of claimed) {
    if (file.byteSize === null) {
      throw new ClaimRefusedError(CLAIM_REFUSAL.unavailable);
    }
    total += file.byteSize;
  }
  if (total > MAX_RESPONSE_BYTES) {
    throw new ClaimRefusedError(CLAIM_REFUSAL.tooMany);
  }
}

/**
 * **What a correction removed loses its owner** (ADR-0014
 * no. 13, last paragraph: „entfernte verlieren ihren Eigentümer und fallen dem
 * Aufräumen aus Nr. 15 zu").
 *
 * Until now the edit path only ever *claimed*. The consequence was
 * named in `public-forms.service.ts` as an open rest and handed here: a
 * participant who removed an attachment while correcting their registration
 * left it owned by that answer for ever — the answer no longer points at it,
 * the purge does not touch a file with an owner, and nothing else ever
 * looks at it. The bytes of somebody's certificate would simply stay, which
 * is the deletion promise the concept quietly did not keep.
 *
 * **After the claim, never before it**, and that ordering is the whole
 * correctness argument: `keep` is then exactly the set the corrected answer
 * names, so „everything else this answer owns" needs no diff against what it
 * owned before. Running it first would release a file the very next statement
 * re-claims — harmless but a window in which a concurrent purge could take it.
 *
 * **It releases, it does not delete.** The bytes go with the purge, on
 * its own clock and its own two-phase run; deleting here would mean a
 * `remove()` inside the transaction that writes the answer, and a storage that
 * is slow or down would then take a correction with it. It also leaves the
 * 24-hour window as the one place „wann ist eine Datei wirklich weg" is
 * decided, rather than adding a second answer to it. *(Whether the trash
 * wants a different rule for an attachment is still open, which the ADR
 * lists as such.)*
 *
 * **The tenant in the `WHERE` is defence in depth, not a load-bearing
 * condition**, and saying so is the point: `response_id` is already unique, so
 * no reproduction can make this predicate matter — dropping it leaves every
 * test green. It is here because every write in this file is scoped to an organisation
 * and an unscoped one among them would be the exception a later reader copies.
 * Condition 2 of the claim, which this used to point at, *is* load-bearing:
 * there the file is named by a stranger and the tenant is what stops it naming
 * somebody else's. *(Distinction drawn in a review.)*
 */
export async function releaseAttachments(
  tx: ClaimTransaction,
  input: {
    readonly responseId: string;
    readonly tenantId: string;
    /** The references the corrected answer still names — everything else is let go. */
    readonly keep: readonly string[];
  },
): Promise<void> {
  // Spelled before the database sees them, exactly as in the claim: these are
  // caller-written strings, and one that PostgreSQL refuses in `text` would
  // turn a correction into a 500. A reference that is not one cannot be kept
  // anyway — nothing was ever claimed under it.
  const keep = input.keep.filter((ref) => isFileRef(ref));

  await tx.$executeRaw`
    UPDATE "file"
       SET "response_id" = NULL,
           -- Both arms, so "entlassen" means "gehört niemandem". Today the
           -- second assignment can only ever be a no-op:
           -- the row is owned by an answer, and file_kind_shape forbids a
           -- second owner beside it. It is written all the same because the
           -- purge now asks about BOTH columns — a release that knew only the
           -- old one would hand the purge a row it skips for ever, i.e. the
           -- deletion promise the concept quietly unkept again.
           "draft_id"    = NULL
     WHERE "response_id" = ${input.responseId}::uuid
       AND "tenant_id"   = ${input.tenantId}::uuid
       AND "kind"        = 'response_attachment'::"file_kind"
       AND NOT ("public_ref" = ANY(${keep}::text[]))`;
}

/**
 * **A draft claims its attachments** (the requirement).
 *
 * The other half of the decision the claim above implements. An upload exists
 * before anything owns it and is taken after 24 hours; a draft lives up to
 * thirty days. Until this function the two deadlines just stood
 * beside each other and the shorter one won — a participant who resumed on the
 * second day was shown „nicht mehr da" and asked to upload again. Ownership by
 * the draft is what turns two promises into one.
 *
 * ## The conditions are the claim's, minus the answer
 *
 * Organisation, form, `kind`, and „frei und jung, oder schon meiner" — asked so that
 * this function answers exactly the question the submission will answer later:
 * *would the claim accept this reference now*. A weaker set would make a
 * draft own a file its own submission then refuses, which is the same dead
 * end with an owner attached to it.
 *
 * **The name is one of them**, for the same reason it is one of the claim's: a
 * `FileAnswer` carries the name beside the reference, the row's `file_name` is
 * the only truth about it, and a draft that owned a file under a name that does
 * not match would keep bytes alive for thirty days that no submission can ever
 * use.
 *
 * ## Tolerant, where the claim refuses
 *
 * A reference that cannot be taken is **left alone** and the save succeeds. The
 * draft path has never refused a saved answer over an attachment — it is a
 * half-filled form by definition — and turning it into a 409 would mean a
 * participant whose file expired can no longer save the rest of their work. The
 * read path is where the state becomes visible (`resolveDraftAttachments`:
 * `expiresAt: null`), and the submission is where it becomes a refusal.
 *
 * ## What it takes is bounded, and the bound is „Bytes gibt es"
 *
 * `byte_size IS NOT NULL` — a row still in the crash window of ADR-0014 no. 4
 * (`pending`: the row exists, `put()` never finished) is **not** claimable by a
 * draft. Without it such a row would get an owner and live thirty days instead
 * of the twenty-four hours its emptiness is entitled to, and the submission
 * would refuse it anyway: `claimAttachments` counts a `NULL` size as a refusal
 * rather than as zero. Ownership that no submission can use is only retention.
 * *(a security review)*
 *
 * ## What it no longer names, it lets go
 *
 * ⚠️ **This used to release nothing, and that was a named gap** — the concept
 * decides the *correction* case (24 hours, from `created_at`) and says in as
 * many words that it decides nothing about the third: an attachment somebody
 * removes from a *draft*. It has since been decided the other way (a security
 * review finding, and the requirement with it): **a draft
 * owns at most what it names.** {@link releaseDraftAttachments} runs in the
 * same transaction, right after this, and hands everything else back to the
 * 24-hour purge — the deadline the concept gives the removed attachment of an
 * answer, now for the removed attachment of a draft as well.
 *
 * The rechnung that decided it, because „owns forty files" was the small
 * version of it: the waiting room of ADR-0014 no. 7 refills every 48 hours
 * (25 MiB and 20 files per address ⊕ form), a draft lives thirty days, so
 * **fifteen** refills could be parked in one draft by saving it again and again
 * with new references — 375 MiB and 300 files per address and form, resident
 * and growing, over a route strangers reach without a session.
 */
export async function claimForDraft(
  tx: ClaimTransaction,
  input: {
    readonly files: readonly { readonly ref: string; readonly name: string }[];
    readonly formId: string;
    readonly tenantId: string;
    readonly draftId: string;
    /** The one clock, as in {@link claimAttachments}. */
    readonly now: Date;
  },
): Promise<void> {
  // Spelled before the database sees them, exactly as in the claim: a `%00`
  // arrives decoded as a NUL byte, PostgreSQL refuses U+0000 in `text`, and the
  // query would throw where a save answers 200.
  const files = input.files.filter((file) => isFileRef(file.ref));
  if (files.length === 0) {
    return;
  }

  const oldest = new Date(input.now.getTime() - UNCLAIMED_FILE_LIFETIME_MS);

  // **One statement for all of them**, unlike the claim next door: there is no
  // per-file verdict to report here, so the one thing that argued for a
  // statement per reference — „**this** file could not be claimed" — does not
  // apply. `unnest` pairs each reference with the name the answer gave it, so
  // the name is checked per row and not across the set.
  await tx.$executeRaw`
    UPDATE "file" AS f
       SET "draft_id" = ${input.draftId}::uuid
      FROM unnest(${files.map((file) => file.ref)}::text[],
                  ${files.map((file) => file.name)}::text[]) AS named(ref, name)
     WHERE f."public_ref" = named.ref
       AND f."file_name"  = named.name
       AND f."tenant_id"  = ${input.tenantId}::uuid
       AND f."form_id"    = ${input.formId}::uuid
       AND f."kind"       = 'response_attachment'::"file_kind"
       -- Bytes, not just a row: see „was es nimmt" above.
       AND f."byte_size"  IS NOT NULL
       AND (f."draft_id"  = ${input.draftId}::uuid
            OR (f."draft_id" IS NULL
                AND f."response_id" IS NULL
                AND f."created_at" > ${oldest}))`;
}

/**
 * **And what the draft no longer names no longer belongs to it**
 * (the requirement; a security review finding).
 *
 * The counterpart of {@link claimForDraft} and the same statement
 * {@link releaseAttachments} is for an answer, with the owner column swapped.
 * It closes what the concept left explicitly undecided — the third case, an
 * attachment somebody removes from a *draft* — and it closes it the way the
 * other two are decided: **the file loses its owner and falls to the 24-hour
 * purge of ADR-0014 no. 15**, measured from `created_at` and not from the
 * removal, exactly as the concept measures the correction's.
 *
 * ## Why at all, in numbers
 *
 * Without it a draft accumulated. The waiting room of ADR-0014 no. 7 bounds
 * what is *unclaimed* per address ⊕ form (25 MiB, 20 files) and forgets an
 * entry after the deadline plus one purge cadence — about 48 hours. A draft
 * lives up to thirty days. So fifteen refills could be parked in **one** draft
 * by saving it again with new references each time: 375 MiB and 300 files per
 * address and form, resident, over the one route that has no session in front
 * of it. `MAX_DRAFTS_PER_FORM` bounds the number of drafts, nothing bounded
 * what one of them held. It does now: what it holds is what it names, and what
 * it names is bounded by the published definition (`maxFiles` per Datei-Frage).
 *
 * **Not by widening the waiting room to thirty days**, which was the other
 * obvious lever and the wrong one: it would hit the organisation's office filing four
 * registrations with scans exactly as hard as a script — the same weighing
 * `upload-quota.ts` writes down for the release of a claimed file.
 *
 * ## After the claim, never before it
 *
 * Same ordering as on the answer path, same reason: `keep` is then exactly the
 * set this version of the draft names, so „everything else this draft owns"
 * needs no diff against what it owned before. Running it first would release a
 * file the next statement re-claims — a window in which a concurrent purge
 * could take it.
 *
 * **It releases, it does not delete.** The bytes go with the file purge, on its
 * own clock and its own two-phase run — the one place „wann ist eine Datei
 * wirklich weg" is decided.
 */
export async function releaseDraftAttachments(
  tx: ClaimTransaction,
  input: {
    readonly draftId: string;
    readonly tenantId: string;
    /** The references this version of the draft still names. */
    readonly keep: readonly string[];
  },
): Promise<void> {
  // Spelled before the database sees them, as everywhere else in this file:
  // these are caller-written strings, and one PostgreSQL refuses in `text`
  // would turn a save into a 500. A reference that is not one cannot be kept
  // anyway — nothing was ever claimed under it.
  const keep = input.keep.filter((ref) => isFileRef(ref));

  await tx.$executeRaw`
    UPDATE "file"
       SET "draft_id" = NULL
     WHERE "draft_id"  = ${input.draftId}::uuid
       AND "tenant_id" = ${input.tenantId}::uuid
       AND "kind"      = 'response_attachment'::"file_kind"
       AND NOT ("public_ref" = ANY(${keep}::text[]))`;
}
