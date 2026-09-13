import { Injectable, Logger } from '@nestjs/common';
import {
  TRASH_PURGE_BATCH_SIZE,
  type TrashPurgeResult,
} from '@formsache/shared';

import { FileStorage } from '../files/file-storage';
import type { FormRestriction } from '../tenancy/form-restriction';
import type { AttachmentOwner, TenantScope } from '../tenancy/tenant-scope';

/**
 * **Deleting for good is physical deletion** (ADR-0014
 * no. 16).
 *
 * ## What this class is, and what it deliberately is not
 *
 * It takes a {@link TenantScope} and nothing else from the outside — **no
 * request, no session, no user**. That is the requirement the 30-day
 * purge puts on this package: the same deletion has to be callable by a
 * background job, and a job has no session. `TenantScopeFactory.create` mints a
 * scope from a tenant id, so the job's only extra work is deciding *which* rows
 * are due; nothing about the removal itself changes.
 *
 * Conversely there is no HTTP in here: no 403, no 404, no exception a
 * controller would map. The route-facing service ({@link TrashService}) resolves
 * „gibt es das, darf diese Person das" and this one answers what happened.
 *
 * ## Bytes first, and one file per transaction
 *
 * Deleting a row is reversible until the transaction commits; deleting bytes is
 * not, ever. So the two are ordered so that an abort leaves the **visible**
 * half: `remove()` first, `DELETE` second, and each file in a transaction of
 * its own (`ScopedFileDelegate.purgeAttachment`). A crash between two files
 * leaves the answer standing with fewer attachments — repairable by pressing
 * again — where the other order would leave bytes with no index, which the
 * storage seam has no `list()` to ever find.
 *
 * **A file the storage refuses stops this item and not the run.** That is the
 * shape the trash purge arrived at after measuring the alternative, and here it has
 * a second, harder floor: `file.form_id` is `ON DELETE NO ACTION`, so a form
 * whose attachments are not all gone cannot be deleted at all. „Teilweise
 * gelöscht" is therefore not a state this can produce for a form; for an answer
 * it stops before the row and the item stays in the trash.
 */
@Injectable()
export class PermanentDeletionService {
  private readonly logger = new Logger(PermanentDeletionService.name);

  constructor(private readonly storage: FileStorage) {}

  /**
   * Physically deletes one answer that is in the trash.
   *
   * @returns `'deleted'`, `'not-found'` (already gone, another organisation's, another
   * form's, or not in the trash) or `'files-stuck'` — the storage would not
   * release a file's bytes, so **the answer stays**. Attachments removed before
   * the one that stuck are gone for good; see {@link removeAll}.
   */
  async deleteResponse(
    scope: TenantScope,
    where: { formId: string; responseId: string },
  ): Promise<PermanentDeletionOutcome> {
    // **The form travels with the answer** (a review finding). Without it the
    // enumeration matched any answer of this organisation with that id — so naming
    // form A with an answer of form B destroyed B's attachment bytes before
    // `purgeResponse` refused the request with a 404, i.e. reported „nothing
    // happened" about something irreversible.
    const owner: AttachmentOwner = {
      kind: 'response',
      responseId: where.responseId,
      formId: where.formId,
    };
    const attachments = await scope.files.attachmentIdsOfResponse(
      where.responseId,
      where.formId,
    );
    if (!(await this.removeAll(scope, attachments, owner))) {
      return 'files-stuck';
    }

    const removed = await scope.forms.purgeResponse({
      id: where.responseId,
      formId: where.formId,
    });
    return removed ? 'deleted' : 'not-found';
  }

  /**
   * Physically deletes one form that is in the trash, with its versions,
   * answers, registrations, notifications and permissions.
   *
   * The children and how each of them goes are written out at
   * `ScopedFormDelegate.purgeForm`; the only one this class handles itself is
   * `file`, because it is the only one with bytes behind it.
   */
  async deleteForm(
    scope: TenantScope,
    formId: string,
  ): Promise<PermanentDeletionOutcome> {
    const attachments = await scope.files.attachmentIdsOfForm(formId);
    if (!(await this.removeAll(scope, attachments, { kind: 'form', formId }))) {
      return 'files-stuck';
    }

    const removed = await scope.forms.purgeForm(formId);
    return removed ? 'deleted' : 'not-found';
  }

  /**
   * **Physically deletes a whole organisation once its 30 days are up**.
   *
   * ## Session-free, and this is what that was built for
   *
   * It takes a {@link TenantScope} and a cut-off, nothing else — no request, no
   * user. `TenantScopeFactory.create` mints a scope from a tenant id, so the
   * 30-day purge job supplies the cut-off from the injected clock
   * (`trashCutoff(clock.now())`) and calls this. **This class is the seam; the
   * schedule is not built here** — arming a run at start-up and on an interval
   * is the requirement and belongs to the 30-day purge, together with the cross-tenant listing
   * of which organisations are due.
   *
   * ## The order, and why the due-check is asked at every step
   *
   * The bytes go before the rows and cannot be rolled back (ADR-0014 no. 16),
   * so „ist diese Organisation überhaupt fällig" must be answered **before** a single
   * file is touched — the mistake a regression test caught one level down, where a
   * live answer lost its attachments and then got a 404. It is answered again
   * as a condition of the `DELETE` itself
   * ({@link ScopedTenantDelegate.purgeIfDeletedBefore}), because a restore
   * landing in between must make the deletion match nothing rather than race
   * it.
   *
   * **And it is answered once per file** (a security review, finding 2).
   * Asking it only before the loop is what made a restore *during* the loop the
   * worst of both: the closing `DELETE` correctly matched nothing, the organisation came
   * back — and every file the loop had already reached was gone, so answers
   * named attachments that answer 404 and nothing said which. The question is
   * now the `where` of the enumeration and of each single-file transaction
   * (`ScopedFileDelegate.dueFileIds`, `.purgeFile`), i.e. a **condition** rather
   * than a second check somebody has to remember to repeat.
   *
   * What that still does **not** close, said plainly: a restore committing
   * inside one file's transaction, between its due-check and its `remove()`,
   * costs that file — and every file removed before the restore stays removed,
   * bytes and row. The window is one statement per file instead of the length of
   * the whole run; closing it entirely would mean holding a lock on the organisation
   * across filesystem calls, the long transaction the security review of the
   * trash purge took apart.
   *
   * @returns `'deleted'`, `'not-found'` (unknown, not in the trash, or not
   * yet 30 days old) or `'files-stuck'` — the storage would not release a file,
   * so **the organisation stays**. Files removed before the one that stuck are gone,
   * rows and bytes, and the next run finds fewer of them.
   */
  async deleteTenant(
    scope: TenantScope,
    cutoff: Date,
  ): Promise<PermanentDeletionOutcome> {
    // Asked before anything irreversible happens. The same question is the
    // `where` of every statement below; this one exists so a whole run — the
    // enumeration and N transactions — is not started for an organisation that was
    // never due.
    const tenant = await scope.tenant.find();
    if (
      tenant?.deletedAt == null ||
      tenant.deletedAt.getTime() > cutoff.getTime()
    ) {
      return 'not-found';
    }

    // **Every file of the organisation, not only its answers' attachments**: the Logo
    // has bytes too, and `file.form_id` is `ON DELETE NO ACTION`, so one row
    // left standing makes the cascade below fail rather than leave bytes behind
    // — the floor this order rests on.
    //
    // `cutoff` travels into both statements, and that is the whole of finding 2:
    // a restore landing mid-loop makes the remaining files match nothing, so
    // they stay with the organisation that came back.
    for (const id of await scope.files.dueFileIds(cutoff)) {
      try {
        await scope.files.purgeFile(id, cutoff, (key) =>
          this.storage.remove(key),
        );
      } catch (error: unknown) {
        // The class, never the message — a failing `rm` reports the path it
        // tried into a log that outlives it (`CONTRIBUTING.md`).
        this.logger.warn(
          `tenant purge: could not remove one file (${
            error instanceof Error ? error.constructor.name : 'unknown error'
          }); the organisation was not deleted`,
        );
        return 'files-stuck';
      }
    }

    const removed = await scope.tenant.purgeIfDeletedBefore(cutoff);
    return removed ? 'deleted' : 'not-found';
  }

  /**
   * **Papierkorb leeren** — every deleted form and every separately deleted
   * answer this caller may reach, up to {@link TRASH_PURGE_BATCH_SIZE} of them.
   *
   * ## What „may reach" means, and why `formFilter()` was not enough
   *
   * Both listings carry the caller's restriction **twice over**, and the second
   * half was missing (a review finding):
   *
   * - `FormRestriction.formFilter()` keeps a form somebody is *revoked* from
   *   out of the statement, so such a row never leaves PostgreSQL;
   * - {@link FormRestriction.hiddenFormIdsIn} additionally keeps out every form
   *   this route's own requirement does not open — i.e. a **cap**.
   *
   * `formFilter()` cannot do the second one and never could: a cap is only
   * decidable *against a requirement*, and a query fragment has none. What that
   * cost was exact — somebody capped on form X to a role without `can_build`
   * got a 403 from `DELETE /forms/X/permanent` and a 204 from here, with X, its
   * answers, its attachment bytes and its mail log physically gone. The
   * answers were the sharper half: `TrashService.view` already narrows the
   * *answers* section by the same effective permissions, so what this route
   * destroyed included rows it deliberately never showed the caller.
   *
   * ## The order, the batch, and what one item's failure does
   *
   * Forms first: destroying a form takes its answers with it, so an answer
   * listed under both would otherwise be counted twice —
   * {@link ScopedFormDelegate.deletedResponseKeys} excludes answers of deleted
   * forms for that reason, and the order keeps the exclusion true while the run
   * is in progress.
   *
   * **At most one batch per call** (a review finding). One click used to mean
   * one transaction per item — thousands of them, serially, inside a single
   * HTTP request against a pool of ten connections, with no way to resume and
   * no report if the connection dropped. `remaining` is counted afterwards, so
   * pressing again continues and „0" is an observation rather than arithmetic.
   *
   * **One item's failure never ends the run** — and now that is true rather
   * than intended (a review finding). Only the storage exception was caught;
   * any database error (a `P2028` on a form with thousands of answers, a lock
   * timeout) tore the whole call down as a 500, leaving the caller without the
   * numbers for what had already been committed.
   */
  async emptyTrash(
    scope: TenantScope,
    restriction: FormRestriction,
  ): Promise<TrashPurgeResult> {
    const result = { forms: 0, responses: 0, failed: 0, remaining: 0 };

    // The cap half of the restriction, as a **condition**: the ids go into the
    // `where` of both listings, so a form this caller may not empty does not
    // leave the database to be skipped afterwards.
    const hidden = await restriction.hiddenFormIdsIn(scope);
    const reachable: Parameters<typeof scope.forms.deletedFormIds>[0] = {
      ...restriction.formFilter(),
      ...(hidden.length === 0 ? {} : { id: { notIn: hidden } }),
    };

    const formIds = await scope.forms.deletedFormIds(
      reachable,
      TRASH_PURGE_BATCH_SIZE,
    );
    for (const formId of formIds) {
      await this.attempt(result, 'forms', () => this.deleteForm(scope, formId));
    }

    const left = TRASH_PURGE_BATCH_SIZE - formIds.length;
    const keys =
      left > 0 ? await scope.forms.deletedResponseKeys(reachable, left) : [];
    for (const key of keys) {
      await this.attempt(result, 'responses', () =>
        this.deleteResponse(scope, {
          formId: key.formId,
          responseId: key.id,
        }),
      );
    }

    // **Counted, not inferred.** Failed items are in it (they are still there),
    // and so is everything the batch did not reach.
    result.remaining = await scope.forms.countDeletedItems(reachable);
    return result;
  }

  /**
   * One item of the run — and the reason the class comment's „one item's
   * failure never ends the run" is now checkable (a review finding).
   *
   * Every outcome the deletion can *report* is tallied by {@link tally}; every
   * outcome it can **throw** lands here as `failed`. The two are not the same
   * set: `files-stuck` is a decision the deletion took, a `P2028` is one
   * PostgreSQL took, and only the first was being handled.
   */
  private async attempt(
    into: TrashPurgeResult,
    bucket: 'forms' | 'responses',
    run: () => Promise<PermanentDeletionOutcome>,
  ): Promise<void> {
    try {
      this.tally(await run(), into, bucket);
    } catch (error: unknown) {
      // The class, never the message — a database error quotes the statement
      // that failed, and that statement names rows.
      this.logger.warn(
        `empty trash: one ${bucket === 'forms' ? 'form' : 'answer'} could not be deleted (${
          error instanceof Error ? error.constructor.name : 'unknown error'
        }); the run continues`,
      );
      into.failed += 1;
    }
  }

  private tally(
    outcome: PermanentDeletionOutcome,
    into: TrashPurgeResult,
    bucket: 'forms' | 'responses',
  ): void {
    switch (outcome) {
      case 'deleted':
        into[bucket] += 1;
        return;
      case 'files-stuck':
        into.failed += 1;
        return;
      case 'not-found':
        // Restored or destroyed between the listing and the attempt. Not a
        // failure: the caller asked for it to be gone and it is.
        return;
      default: {
        // Exhaustive by the compiler, not by inspection — a fourth outcome must
        // not be able to fall through as „nothing happened".
        const unhandled: never = outcome;
        throw new Error(
          `emptyTrash: unhandled outcome ${JSON.stringify(unhandled)}`,
        );
      }
    }
  }

  /**
   * Removes bytes and row for every attachment, one transaction each.
   *
   * Answers `false` as soon as **one** of them will not go: the caller must not
   * delete the owning row while a file of it is still on the volume. Files
   * already removed stay removed — that is the irreversible half, and from the
   * second attachment onwards it is a *partial* deletion, not none.
   * `PURGE_STORAGE_UNAVAILABLE_MESSAGE` says so (a review finding) — otherwise
   * an editor restoring afterwards would find a registration missing
   * attachments with nothing anywhere saying why.
   *
   * `owner` is passed through to {@link ScopedFileDelegate.purgeAttachment},
   * which asks it again under the row's lock immediately before the bytes go
   * (a review finding) — the window between the enumeration and the last
   * `remove()` is otherwise the whole duration of the run.
   */
  private async removeAll(
    scope: TenantScope,
    ids: readonly string[],
    owner: AttachmentOwner,
  ): Promise<boolean> {
    for (const id of ids) {
      try {
        await scope.files.purgeAttachment(id, owner, (key) =>
          this.storage.remove(key),
        );
      } catch (error: unknown) {
        // **The class, never the message.** A failing `rm` reports the path it
        // tried — the volume layout and the id of the very attachment this
        // routine exists to end — into a log that outlives it.
        this.logger.warn(
          `permanent deletion: could not remove one attachment (${
            error instanceof Error ? error.constructor.name : 'unknown error'
          }); this item stays in the Papierkorb, earlier attachments of it are gone`,
        );
        return false;
      }
    }
    return true;
  }
}

/** What one physical deletion did. */
export type PermanentDeletionOutcome = 'deleted' | 'not-found' | 'files-stuck';
