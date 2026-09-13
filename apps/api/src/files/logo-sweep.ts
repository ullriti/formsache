import { Logger } from '@nestjs/common';

import type { TenantScope } from '../tenancy/tenant-scope';
import type { FileStorage } from './file-storage';

const logger = new Logger('LogoSweep');

/**
 * **The life cycle of an uploaded logo, decided here** (the open point
 * ADR-0014 no. 15 hands off).
 *
 * ## What was open, and what is decided
 *
 * ADR-0014 no. 15 keeps the purge away from `tenant_logo` on purpose: „auf das
 * keine Organisation mehr zeigt" has no expression a purge could evaluate — the
 * reference lives in `tenant.logo_ref` as a union, so a purge would have to
 * read backwards across every organisation and parse every value, and a parse failure,
 * a new union arm or a row being written at that moment deletes a **live**
 * logo, physically. The ADR names two candidate answers and assigns the
 * choice here: a relation column (`tenant.logo_file_id`) or explicit deletion
 * when the logo is replaced.
 *
 * **Decided: explicit deletion, in the write path, with the invariant *a
 * `tenant_logo` row exists only while `tenant.logo_ref` names it*.**
 *
 * Why not the relation column: it buys referential integrity for one pointer
 * and costs a second source of truth for the same fact. `logo_ref` would still
 * exist (a shipped asset is not a file), so an organisation would have *two* columns
 * saying what its logo is, and „welche gilt" becomes a rule instead of a
 * lookup — the shape ADR-0013 no. 1 rules out. It also does not answer the
 * question by itself: `ON DELETE SET NULL` cleans the pointer when a file goes,
 * not the file when the pointer moves, which is the direction that leaks.
 *
 * ## Why this is safe to do here and unsafe to do in a purge
 *
 * The difference is the **scope**, not the predicate. Inside one organisation, in the
 * same request that has just written `logo_ref`, „welche Zeilen zeigt niemand
 * mehr an" is one comparison against a value that was read in the same breath.
 * Across an installation, at an interval, it is a guess about every organisation at
 * once. So the sweep runs exactly where an organisation's logo *changes* — the upload
 * route and the *Erscheinungsbild* save — and nowhere else.
 *
 * ## The order, and the remainder that is named rather than wished away
 *
 * Bytes first, row second (ADR-0014 no. 16): a failed `remove()` leaves the row
 * standing, which is the *visible* half. The reverse would leave bytes without
 * an index — the seam has no `list()` — and they would outlive every deletion
 * promise the concept makes.
 *
 * A `remove()` that fails therefore leaves one row behind, and **that is the
 * whole remainder**: it is unreferenced, it is scoped to one organisation, and the
 * **next** branding write of that organisation tries it again, because this function
 * re-derives its candidates from the database rather than from what a caller
 * remembered. It is not „räumt später mal jemand auf" — it is a retry with a
 * trigger. What it is *not* is a promise that an organisation which never touches its
 * appearance again will be swept; that case is stated in ADR-0014 rather than
 * covered by a claim.
 *
 * A failure never propagates: the caller has already replaced the logo
 * successfully, and answering 500 to „dein neues logo ist da, aber das alte
 * ließ sich nicht löschen" would ask an admin to act on something they cannot
 * act on — and would tempt them to upload again, making it worse.
 */
export async function sweepUnreferencedLogos(
  scope: TenantScope,
  storage: FileStorage,
): Promise<void> {
  let ids: readonly string[];
  try {
    ids = await scope.files.unreferencedLogoIds();
  } catch (cause: unknown) {
    logger.error(`Could not look for unreferenced logos: ${describe(cause)}`);
    return;
  }

  for (const id of ids) {
    try {
      // Bytes first (no. 16). `remove()` is idempotent, so a row whose bytes a
      // previous run already took is not an error here — which is what makes
      // the retry above a retry rather than a second failure mode.
      await storage.remove(id);
      await scope.files.deleteLogo(id);
    } catch (cause: unknown) {
      // One failure does not stop the rest, for the reason the file purge
      // learned the hard way (ADR-0014 no. 15): a single undeletable file that
      // aborts the loop freezes the deletion promise for everything behind it.
      logger.error(`Could not remove an unreferenced logo: ${describe(cause)}`);
    }
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.name : 'unknown error';
}
