import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  TRASH_PURGE_BATCH_SIZE,
  TRASH_RETENTION_DAYS,
  trashCutoff,
  type ApiEnv,
} from '@formsache/shared';

import { JobKind } from '@prisma/client';

import { API_ENV } from '../../config/env';
import { MailClock } from '../../mail/mail-clock';
import { PrismaService } from '../../prisma/prisma.service';
import { JobRunService } from '../../observability/job-run.service';
// The one version of „gehört dieses Konto noch jemandem?" —
// shared with `ScopedMembershipDelegate.remove`, not repeated here. The
// second export is the same condition without `id`, for the reconciliation at the
// end of a run.
import {
  deleteHomelessAccount,
  deleteHomelessAccounts,
} from '../../tenancy/homeless-account';
import { TenantScopeFactory } from '../../tenancy/tenant-scope';
import {
  PermanentDeletionService,
  type PermanentDeletionOutcome,
} from '../permanent-deletion.service';

/** What one run of {@link RetentionPurgeService.runOnce} did. */
export interface RetentionPurgeResult {
  /** Organisationen physically removed, with everything that cascades from them. */
  readonly tenants: number;
  /** Forms physically removed, with their versions, answers and files. */
  readonly forms: number;
  /** Answers deleted in their own right — their form is still alive. */
  readonly responses: number;
  /**
   * Saved drafts whose own `expires_at` has passed — **not** a trash population: see
   * {@link RetentionPurgeService.purgeDrafts}.
   */
  readonly drafts: number;
  /**
   * Accounts removed because nobody holds them any more —
   * those a purged Organisation left behind ({@link
   * RetentionPurgeService.purgeHomelessAccounts}) **and** whatever the closing
   * reconciliation still found ({@link
   * RetentionPurgeService.reconcileHomelessAccounts}).
   */
  readonly accounts: number;
  /**
   * Items this run could not remove — **accounts included**. They stay where
   * they are, and the next run tries again.
   */
  readonly failed: number;
  /**
   * Work still owed when the run ended — **counted afterwards, not derived**
   * (the shape a follow-up review settled on for „Papierkorb leeren"). „0" is
   * then an observation rather than arithmetic over what this run happened to
   * see.
   */
  readonly remaining: number;
}

/**
 * One item of a listing.
 *
 * `at` travels because it is half the cursor the run pages by — see
 * {@link RetentionPurgeService.drain}. It is a timestamp, not a payload: the
 * listings still hand out keys only.
 *
 * **`at` rather than `deletedAt`** since the drafts joined the run (a review
 * finding): four populations page by `deleted_at`, the fifth by its own
 * `expires_at`, and the cursor does not care which column a listing read it
 * from — only that it is total together with `id`. Each listing names its column
 * in its own `where`.
 */
interface DueItem {
  readonly id: string;
  readonly at: Date;
}

interface DueForm extends DueItem {
  readonly tenantId: string;
}

interface DueResponse extends DueItem {
  readonly formId: string;
  readonly tenantId: string;
}

/**
 * A draft whose `expires_at` has passed — `at` is that column and not
 * `deleted_at`; the table has none.
 */
interface DueDraft extends DueItem {
  readonly tenantId: string;
}

/**
 * Where a listing left off: the `(timestamp, id)` of the last row it handed
 * back — `deleted_at` for the three trash populations, `expires_at` for the
 * drafts.
 *
 * A **keyset**, not an offset and not an exclusion list — the reason is at
 * {@link RetentionPurgeService.drain}.
 */
interface Cursor {
  readonly at: Date;
  readonly id: string;
}

/**
 * „Fällig, und hinter dem Cursor" — the `where` the three **trash**
 * listings of this run are built on, in one place because all three ask exactly
 * the same two things. The drafts are not among them: they carry no
 * `deleted_at`, and {@link RetentionPurgeService.dueDrafts} writes their two
 * conditions out for that reason.
 *
 * The `OR` is the keyset comparison `(deleted_at, id) > (:at, :id)` spelled
 * the way Prisma takes it. `deleted_at` alone would not do: two rows deleted in
 * the same millisecond would make the cursor either skip one or return one for
 * ever, and „im selben Millisekundenwert gelöscht" is what a bulk delete
 * produces.
 */
interface DueWhere {
  deletedAt: { not: null; lte: Date };
  OR?: [{ deletedAt: { gt: Date } }, { deletedAt: Date; id: { gt: string } }];
}

function dueWhere(cutoff: Date, after: Cursor | undefined): DueWhere {
  return {
    deletedAt: { not: null, lte: cutoff },
    ...(after === undefined
      ? {}
      : {
          OR: [
            { deletedAt: { gt: after.at } },
            { deletedAt: after.at, id: { gt: after.id } },
          ] satisfies DueWhere['OR'],
        }),
  };
}

/**
 * Oldest deletion first, and `id` behind it so the order is total — the order
 * {@link dueWhere}'s keyset compares against.
 *
 * Not `as const`: Prisma's `orderBy` takes a mutable array, and a `readonly`
 * one is refused at every call site.
 */
const DUE_ORDER: [{ deletedAt: 'asc' }, { id: 'asc' }] = [
  { deletedAt: 'asc' },
  { id: 'asc' },
];

/**
 * How long {@link RetentionPurgeService.onModuleDestroy} waits for a run in
 * flight before it stops waiting (a review finding).
 *
 * Generous enough that an ordinary batch finishes inside it, short enough that
 * a shutdown never *looks* stuck. It bounds the wait, not the run: nothing here
 * can cancel a purge.
 */
const SHUTDOWN_GRACE_MS = 10_000;

/**
 * Drops the impossible `deletedAt === null` rather than asserting it away.
 *
 * Every listing carries `deletedAt: { not: null }` in its `where`, but Prisma
 * types a nullable column as nullable regardless of the filter — and a
 * non-null assertion here would be a claim about a `where` written elsewhere in
 * the file.
 */
function dated<T extends { readonly deletedAt: Date | null }>(
  rows: readonly T[],
): (Omit<T, 'deletedAt'> & { at: Date })[] {
  return rows.flatMap(({ deletedAt, ...row }) =>
    deletedAt === null ? [] : [{ ...row, at: deletedAt }],
  );
}

/**
 * **After 30 days the application clears up by itself.**
 *
 * A purge in the shape of the `mail_log` one: **one** clock, a run at start-up
 * **plus** an interval, ids only out of the listings, one transaction per item,
 * and counts as the return value so that idempotency is checkable.
 *
 * ## What it removes, and in which order
 *
 * 1. **organisations** whose `deleted_at` is over 30 days old — with the ten cascading
 *    child tables, and together with the accounts that lose their last
 *    membership by it ({@link purgeHomelessAccounts});
 * 2. **forms** that have been in the trash for over 30 days **and whose Organisation
 *    is not itself in the trash**;
 * 3. **answers** deleted in their own right, i.e. whose form *and* whose Organisation
 *    are still alive — the same population
 *    `ScopedFormDelegate.deletedResponseKeys` selects, because an answer of a
 *    deleted form is not a second item: it goes with its form;
 * 4. **saved drafts** whose own `expires_at` has passed (a review finding) — the one population that is **not** a
 *    trash population: it has no `deleted_at`, no restoration and no cut-off of this
 *    run's own, because its boundary is written on the row. See
 *    {@link purgeDrafts};
 * 5. a closing **reconciliation of accounts** ({@link
 *    reconcileHomelessAccounts}) — the one phase that depends on no listing.
 *
 * organisations first, so a due organisation's forms leave in one cascade instead of one
 * transaction each. Forms before answers, so the exclusion in (3) stays true
 * while the run is in progress — the order „Papierkorb leeren" already takes.
 * The drafts come after all three because an organisation's cascade takes its drafts
 * with it, so anything the earlier phases removed is work this one no longer
 * has to do.
 *
 * ## The Organisation is the outer bracket (a review finding)
 *
 * „Eine gelöschte Organisation lässt sich 30 Tage lang wiederherstellen, und danach
 * funktioniert wieder alles"  is a promise about
 * **the Organisation together with its content**. A form that went into the trash on day 0,
 * and an Organisation that followed on day 5, would have broken it: on day 31 the
 * form would be physically gone, the Organisation would still be standing (due only on day 35), and
 * the restoration on day 32 would have brought back an Organisation in which a
 * form is finally missing — without it standing anywhere which one.
 *
 * The retention periods are therefore **nested**: as long as an Organisation lies in the
 * trash, its forms and answers are no longer due items of their own
 * but wait for the period of their Organisation and then go into its
 * cascade. It is the same rule that
 * `ScopedFormDelegate.deletedResponseKeys` already applies one level down
 * („eine Antwort eines gelöschten Formulars ist kein zweites Element") — here
 * one level up. The price is said rather than hidden: a form can thus
 * stand in the trash up to 30 days **longer** than its own period, and
 * for exactly that long it is also still restorable.
 *
 * ## What it deletes itself, and what it does not
 *
 * Every removal of Organisation, form and answer goes through {@link
 * PermanentDeletionService}, which was built session-free expressly for this one
 * caller: it takes a `TenantScope` from an id and nothing else. For
 * these three, this class decides **which** rows are due and nothing
 * about how they go.
 *
 * **For accounts that is not true**
 * (a review finding): `user` is reached by no cascade and no scope, so for
 * this table there is no foreign deletion path this job could use.
 * It therefore owns the most destructive statement of the package itself — a
 * `user.deleteMany` — though not as a version of its own: the condition lives
 * in `tenancy/homeless-account.ts` and is shared with „Person entfernen".
 *
 * ## Installation-wide by design — the tenth entry of the allow-list
 *
 * No request, no caller, no tenant parameter: a job that has to find *every*
 * organisation's due rows cannot be built on a `TenantScope`, because a scope is one
 * Organisation — and the accounts in question live in a table with **no `tenant_id`
 * at all**, which no scope and no cascade can reach. That is what
 * `apps/api/src/trash/purge/**` is on the `PrismaService` allow-list of
 * `eslint.config.js` for. Four properties make the entry defensible, and a
 * change that breaks any of them needs a new decision:
 *
 *   1. **only keys leave the listings** — `id`, `tenant_id`, `form_id`,
 *      `user_id`, plus the `deleted_at` the cursor pages by. No title, no
 *      `answers`, no `email`, no `name`: a job that cannot read a payload
 *      cannot hand one out;
 *   2. **nothing from a request selects a row** — the predicate is `deleted_at`
 *      against a cut-off derived from the injected clock, and nothing else;
 *   3. **every deletion has exactly one definition** — organisations, forms and
 *      answers go through {@link PermanentDeletionService} with a scope minted
 *      from the id just listed, and the account deletion is
 *      {@link deleteHomelessAccount} / {@link deleteHomelessAccounts}, shared
 *      with `ScopedMembershipDelegate` and carrying both of those conditions
 *      in its own `where`. The **drafts** are the third statement
 *      this module owns outright (a review finding): one `deleteMany` on one
 *      row, conditioned on the same `expires_at` the listing read — there is no
 *      scope and no cascade that reaches an expired draft of every organisation, and
 *      there is nothing else to it, because a draft owns no attachment, no
 *      child row and no trash state. What this module does **not** have is
 *      a second spelling of any of them. It is not the property „löscht nichts
 *      selbst" that stood here before an earlier review: this module's phases are
 *      what *runs* `user.deleteMany`, the most destructive statement of the
 *      package, and the entry has to be defensible with that said out loud;
 *   4. **the counter-check** — `apps/api/src/trash/` next door, the trash
 *      routes an editor reaches, is deliberately *not* on that list and
 *      works strictly through the `TenantScope` the guard chain hands in. That
 *      is why the entry is `trash/purge/**` rather than `trash/**`, the same
 *      cut the ninth entry makes by being `files/purge/**`.
 *
 * ## A run must not hold the application still
 *
 * Batches of {@link TRASH_PURGE_BATCH_SIZE} with a counted remainder — the
 * shape a later review settled on — drained in a loop rather than stopped
 * after one batch, because this is a background job and not one HTTP request.
 * Between two items the run holds nothing at all.
 *
 * **Inside one item it holds what the deletion holds, and that is not one
 * transaction per item** (a review finding — the earlier wording said it was).
 * Only a form and an answer are one transaction each
 * (`BULK_TRANSACTION_BOUNDS`: `maxWait` 10 s, `timeout` 30 s). A **Organisation** is a
 * read, then one transaction *per attachment*, then the `DELETE` — so an organisation
 * interrupted halfway is an organisation with fewer files, which is exactly the state
 * `PermanentDeletionService.deleteTenant` documents and the reason its due-check
 * is repeated at every step.
 *
 * The `DELETE` that ends an organisation (`ScopedTenantDelegate.purgeIfDeletedBefore`)
 * is a single `deleteMany` whose cascade walks ten child tables. It used to be
 * the one statement of the run with no bound at all; since a review finding it
 * runs under a `SET LOCAL statement_timeout` (`TENANT_PURGE_STATEMENT_TIMEOUT_MS`
 * in `tenancy/tenant-scope.ts`), so an organisation with a hundred thousand answers can
 * hold a connection of the pool for that long and no longer. It is a *shared*
 * pool: the same connections serve the request path, which is why an unbounded
 * cascade here was a problem for people who never touched the trash. When
 * the timeout bites, PostgreSQL cancels the statement, nothing of the organisation is
 * gone, the item counts as `failed` and the next run tries again.
 *
 * ## One item's failure never ends the run, and never stalls it
 *
 * The lesson of the file purge, measured there: `ORDER BY deleted_at`
 * puts the longest-failing item into *every* first batch, so one item the
 * storage refuses would freeze the purge for the whole installation, silently,
 * while the application went on promising deletion. What answers that here is
 * the cursor of {@link drain}, not an exclusion list — see there for why the
 * list was the wrong answer and what it measured.
 */
@Injectable()
export class RetentionPurgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetentionPurgeService.name);
  private timer: NodeJS.Timeout | undefined;
  /** The run in flight — re-entrancy guard and what shutdown waits for. */
  private purging: Promise<void> | undefined;

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly prisma: PrismaService,
    /**
     * **The application's one injected calendar** (`mail-clock.ts`) — the same
     * instance `TrashService` stamps `deleted_at` from.
     *
     * That is what makes „29 Tage bleibt, 31 Tage ist weg" measurable **through
     * the routes**: a suite moves this clock, deletes over HTTP and then purges,
     * instead of writing a timestamp into the table by hand and measuring its
     * own SQL against its own SQL.
     */
    private readonly clock: MailClock,
    private readonly scopes: TenantScopeFactory,
    private readonly permanent: PermanentDeletionService,
    /**
     * The bookkeeping about this run (ADR-0016).
     */
    private readonly jobRuns: JobRunService,
  ) {}

  onModuleInit(): void {
    const interval = this.env.TRASH_PURGE_INTERVAL_MS;
    if (interval <= 0) {
      return;
    }
    // Armed here, per process: nothing outside remembers that a purge is due.
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref();

    // **And once immediately, not only one interval later** . The shipped interval is a day, so „armed" alone would put the
    // first deletion twenty-four hours after the process came up — and an
    // installation that is redeployed daily, one in a crash loop, or one on a
    // host that reboots every night would never delete anything at all, while
    // the trash went on saying „nach 30 Tagen endgültig gelöscht". That
    // fault was built and measured; this is the same answer. Through
    // the same `purging` guard as every scheduled run, so a long first pass and
    // the first tick cannot overlap.
    void this.tick();
  }

  /**
   * **Waits for the run in flight — but not for ever** (a review finding).
   *
   * A purge that outlived `close()` would delete against a database the caller
   * has already released, and log the failure as if it were a defect. So the
   * shutdown waits.
   *
   * It waits **with a deadline**, because the thing being waited for is a run
   * whose own worst case is a long cascade: an unbounded `await` turns „der
   * Lauf hängt" into „`app.close()` kehrt nicht zurück", and a hanging
   * shutdown is a worse failure than a purge that is still running — it has no
   * message and no end. Measured before this deadline existed: with a run that
   * never resolves, `app.close()` never returned. After the deadline the run is
   * simply left to finish; nothing here can cancel it, and pretending otherwise
   * would be the second half of the same mistake.
   *
   * **Whose lifecycle this actually is, said plainly:** `main.ts` calls neither
   * `enableShutdownHooks()` nor `close()`, so in production this method does
   * not run at all — the process ends with the container. What it serves today
   * is the test lifecycle, where every suite closes its application while the
   * next one is already starting. That is a small job, and it is the whole job.
   */
  async onModuleDestroy(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    const inFlight = this.purging;
    if (inFlight === undefined) {
      return;
    }

    let deadline: NodeJS.Timeout | undefined;
    const expired = new Promise<false>((resolve) => {
      deadline = setTimeout(() => {
        resolve(false);
      }, SHUTDOWN_GRACE_MS);
      // The process must not be held open by this timer — it exists to end a
      // wait, not to create one.
      deadline.unref();
    });

    try {
      // `runTick` never rejects, so this race has no rejected branch.
      if (!(await Promise.race([inFlight.then(() => true), expired]))) {
        this.logger.warn(
          `trash purge: a run was still going after ` +
            `${String(SHUTDOWN_GRACE_MS)} ms; shutting down without it`,
        );
      }
    } finally {
      if (deadline !== undefined) {
        clearTimeout(deadline);
      }
    }
  }

  get schedulerRunning(): boolean {
    return this.timer !== undefined;
  }

  /**
   * One full pass: every organisation, form and answer whose 30 days are up, plus the
   * accounts nobody holds any more.
   *
   * **The account phase has no clock**, and that is not an oversight: „gehört
   * dieses Konto noch jemandem" is not a question about age. The
   * 30 days belong to the trash, and a `user` row was never in one.
   *
   * The cut-off is computed **once** for the whole run rather than per batch:
   * with one instant, „älter als 30 Tage" is a fixed set the batches walk
   * through, and a run cannot take an item that became due while it was already
   * working.
   */
  async runOnce(): Promise<RetentionPurgeResult> {
    const now = this.clock.now();
    const cutoff = trashCutoff(now);

    const tenants = await this.purgeTenants(cutoff);
    const forms = await this.purgeForms(cutoff);
    const responses = await this.purgeResponses(cutoff);
    // **Not `cutoff`** — the boundary of a draft already sits on its own row
    // . See {@link purgeDrafts}.
    const drafts = await this.purgeDrafts(now);
    // **Last, and on purpose**: everything above may have taken somebody's last
    // membership with it, and this phase asks once for the whole installation
    // rather than for the candidates this run happened to read.
    const homeless = await this.reconcileHomelessAccounts();

    const result: RetentionPurgeResult = {
      tenants: tenants.removed,
      forms: forms.removed,
      responses: responses.removed,
      drafts: drafts.removed,
      accounts: tenants.accounts.removed + homeless.removed,
      failed:
        tenants.failed +
        tenants.accounts.failed +
        forms.failed +
        responses.failed +
        drafts.failed +
        homeless.failed,
      remaining: await this.countDue(cutoff, now),
    };

    if (
      result.tenants > 0 ||
      result.forms > 0 ||
      result.responses > 0 ||
      result.drafts > 0 ||
      result.accounts > 0 ||
      result.failed > 0
    ) {
      // Counts only — never an id, a name or an address. A purge line naming
      // what it removed would write the very data back into a log that outlives
      // the deletion.
      //
      // The accounts and the drafts stand outside the „over N days" clause on
      // purpose: an account is deleted for having no holder, a draft for having
      // reached the boundary written on its own row — neither for having waited
      // thirty days in the trash.
      this.logger.log(
        `trash purge: ${String(result.tenants)} Organisation/Organisationen, ` +
          `${String(result.forms)} form(s) and ${String(result.responses)} ` +
          `answer(s) over ${String(TRASH_RETENTION_DAYS)} days old deleted, ` +
          `plus ${String(result.drafts)} expired draft(s) and ` +
          `${String(result.accounts)} account(s) nobody held` +
          (result.failed > 0
            ? `, ${String(result.failed)} left for the next run`
            : ''),
      );
    }
    return result;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // The four populations
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * **organisations whose 30 days are up** — and the accounts they leave behind.
   *
   * The members are read **before** the deletion and judged **after** it; see
   * {@link purgeHomelessAccounts} for why that order is the whole of Konzept
   * no. 68 and why either half alone is wrong.
   */
  private async purgeTenants(cutoff: Date): Promise<{
    removed: number;
    accounts: { removed: number; failed: number };
    failed: number;
  }> {
    const accounts = { removed: 0, failed: 0 };
    const drained = await this.drain<DueItem>(
      'Organisation',
      (after) => this.dueTenants(cutoff, after),
      async ({ id }) => {
        // Read while the memberships still exist. The `DELETE` takes them with
        // it, and afterwards nothing leads from an organisation back to its people.
        const members = await this.membersOf(id);
        const outcome = await this.permanent.deleteTenant(
          this.scopes.create(id),
          cutoff,
        );
        if (outcome === 'deleted') {
          const swept = await this.purgeHomelessAccounts(members);
          accounts.removed += swept.removed;
          accounts.failed += swept.failed;
        }
        return outcome;
      },
    );
    return { ...drained, accounts };
  }

  /**
   * Forms that have been in the trash for over 30 days **and whose Organisation is
   * not itself in one** — see the class comment on the outer bracket.
   */
  private purgeForms(
    cutoff: Date,
  ): Promise<{ removed: number; failed: number }> {
    return this.drain<DueForm>(
      'form',
      (after) => this.dueForms(cutoff, after),
      (form) =>
        this.permanent.deleteForm(this.scopes.create(form.tenantId), form.id),
    );
  }

  /**
   * Answers deleted in their own right, whose form **and** whose Organisation are still
   * alive.
   */
  private purgeResponses(
    cutoff: Date,
  ): Promise<{ removed: number; failed: number }> {
    return this.drain<DueResponse>(
      'answer',
      (after) => this.dueResponses(cutoff, after),
      (response) =>
        this.permanent.deleteResponse(this.scopes.create(response.tenantId), {
          formId: response.formId,
          responseId: response.id,
        }),
    );
  }

  /**
   * **Saved drafts whose period has expired** (a review finding).
   *
   * ## Why this has to be a purge and not a read block
   *
   * The read path refuses an expired draft with the one 404 whether or not
   * anything removed it (`PublicFormsService.loadDraft`), and it shipped with
   * that alone. It is not enough: the requirement says the draft „verschwindet", and
   * `CONTRIBUTING.md` says „endgültiges Löschen ist physisches Löschen".
   * *Measured on 2026-08-05:* clock moved forward by 400 days, `GET` answered 404,
   * `runOnce()` reported `remaining: 0` — and the row with the typed answers
   * of a person without an account lay unchanged in the table. A promise that only
   * locks the door is no deletion promise.
   *
   * ## ⚠️ Not via `trashCutoff`
   *
   * This is the one population of the run whose boundary is **not** „vor über
   * 30 Tagen passiert". `expires_at` *is* the boundary already — computed by
   * `draftExpiresAt` from the form's deadline, or thirty days where there is none,
   * and rewritten every time the draft is used. Running it through
   * {@link dueWhere} would delete a draft thirty days **after** it expired, i.e.
   * keep personal data for exactly the span the retention was meant to end. The
   * predicate is therefore `expires_at <= now`, from the same injected clock the
   * boundary was written from.
   *
   * ## What does not stand here
   *
   * `tenant: { deletedAt: null }` — the outer bracket of the class comment: a
   * draft of an organisation in the trash is not a second item to destroy, it goes
   * with its organisation's cascade. A **form** in the trash is deliberately *not*
   * excluded: its drafts are unreachable anyway (the read refuses a form that is
   * not `active`), their own boundary has passed, and holding them for a
   * restoration would keep data alive that nobody could open in the meantime.
   *
   * There is no `PermanentDeletionService` step, and the reason changed
   * later without changing the answer. A draft **does** own attachments now
   * (`file.draft_id`) — but it owns them through a `SET NULL`
   * foreign key, so this `DELETE` hands them to the purge of ADR-0014 no. 15
   * instead of taking their rows along: unclaimed, and long past the 24 hours,
   * so the next `FilePurgeService` run removes the **bytes first** and the row
   * after. Enumerating and removing them here would be the third place that
   * order is written out, and the one most likely to get it wrong — a `DELETE`
   * of the rows in this transaction would leave the bytes on a volume nothing
   * can enumerate. The draft still has no child rows and no trash state,
   * so `deleteMany` on one row **is** its physical deletion.
   *
   * ⚠️ **The bytes therefore go on the file purge's cadence, not on this one.**
   * Both run daily and both run at start-up, so the gap is one interval; it is
   * named here because „der Entwurf ist weg" and „seine Anlage ist weg" are
   * two events and this method only causes the first.
   *
   * The `expires_at <= now` is repeated in the `DELETE` itself, exactly as
   * `purgeIfDeletedBefore` repeats its own condition: a draft that was resumed
   * between the listing and this statement has a new boundary
   * (`updateDraft` recomputes it), and it must survive.
   */
  private purgeDrafts(now: Date): Promise<{ removed: number; failed: number }> {
    return this.drain<DueDraft>(
      'draft',
      (after) => this.dueDrafts(now, after),
      async ({ id, tenantId }) => {
        const removed = await this.prisma.responseDraft.deleteMany({
          // `tenant_id` beside the unique id, as every write of this file has
          // it (`CONTRIBUTING.md`): the value comes from the row just listed, and
          // an unscoped statement among scoped ones is the one a later reader
          // copies.
          where: { id, tenantId, expiresAt: { lte: now } },
        });
        return removed.count > 0 ? 'deleted' : 'not-found';
      },
    );
  }

  /**
   * **The people a deleted Organisation leaves behind homeless** (2026-08-03 — a finding of the `security` review).
   *
   * `user` carries no `tenant_id` and can therefore be reached by no cascade.
   * Without this, `email`, `name`, `password_hash` and the OIDC identity of
   * every member of a purged Organisation would stay in the database **unbefristet**:
   * no listing shows them (people are enumerated through `membership`), no job
   * removed them — and `AuthService.login` does not ask for a membership, so
   * the person could go on signing in. „Endgültiges Löschen ist physisches
   * Löschen" would hold for the organisation and not for its people.
   *
   * ## The rule itself is not written here
   *
   * „Gehört dieses Konto noch jemandem?" is one question with one answer, and
   * it lives in {@link deleteHomelessAccount} — the same statement
   * `ScopedMembershipDelegate.remove` runs when somebody is taken out of their
   * last Organisation by hand. Its two conditions, `memberships: { none:
   * {} }` and `isSuperadmin: false`, and why both stand in the `where` rather
   * than in a check a moment earlier, are documented there. This method decides
   * only **whom to ask about**.
   *
   * ## Why the ids are collected **before** and judged **after**
   *
   * `membership` cascades from `tenant`, so the two possible orders answer two
   * different questions and only one of them is right:
   *
   * - counting memberships **before** the organisation goes sees the doomed one and
   *   finds *nobody* homeless — the purge would never delete an account;
   * - looking for candidates **after** the organisation is gone finds *nobody at all*,
   *   because the rows that named them are gone with it. *Measured on
   *   2026-08-03: moving {@link membersOf} behind the deletion turns proofs (a)
   *   and (d) red — `accounts` is `0` and the invitation still holds its
   *   address.*
   *
   * So: the ids are read while the memberships still stand, and „hat diese
   * Person noch eine Mitgliedschaft" is asked once they no longer do. An
   * unclaimed invitation is the same case with no extra code: it
   * is a `user` row with a membership in the deleted Organisation, so the address it
   * held installationsweit is free again.
   *
   * `session` and `form_permission` cascade from `user`, so a deleted account
   * cannot sign in with a session that was open when its organisation went.
   *
   * **One statement per account**, and a failure of one does not end the sweep
   * — the same reason the run's own items get one transaction each. **A
   * failure is counted** (a review finding): it used to increment nothing, so a
   * run in which *every* account refused to go reported `accounts: 0,
   * failed: 0` and read like a clean pass.
   *
   * ## This phase is the fast path, not the guarantee
   *
   * It is not what makes the guarantee hold — {@link reconcileHomelessAccounts}
   * is. The organisation's `DELETE` has committed by the time this runs, so anything
   * that ends the process in between (a lost connection, a `SIGKILL`) would
   * leave accounts nothing could ever find again if this were the only path.
   * What this phase buys is that the account normally goes in the same breath
   * as its organisation, close enough to be one event in the log.
   */
  private async purgeHomelessAccounts(
    userIds: readonly string[],
  ): Promise<{ removed: number; failed: number }> {
    const swept = { removed: 0, failed: 0 };
    for (const id of userIds) {
      try {
        swept.removed += await deleteHomelessAccount(this.prisma, id);
      } catch (error: unknown) {
        // The class, never the message: a database error quotes the statement
        // that failed, and this statement names a person.
        this.logger.warn(
          `trash purge: one account could not be deleted (${describe(error)}); ` +
            `the organisation is gone and the run continues`,
        );
        swept.failed += 1;
      }
    }
    return swept;
  }

  /**
   * **The reconciliation at the end of every run** — the same question, without a candidate list
   * (a review finding).
   *
   * ## Why the candidate list alone is not enough
   *
   * The Organisation and its accounts go in **two** statements: the
   * `deleteMany` on `tenant` commits, and only afterwards follows
   * {@link purgeHomelessAccounts}. Everything that breaks off in between — a
   * lost connection, a `SIGKILL`, an exception that the `catch` of the
   * tick swallows — leaves accounts standing **that no later run ever
   * finds again**: the Organisation is gone, so no listing lists it any more, `user`
   * carries no `tenant_id`, no view shows a person without a
   * membership, and `AuthService.login` demands none. Exactly the state
   * this rule is meant to end would then be permanent and invisible.
   *
   * A run is therefore only resumable once its last phase
   * **depends on no list**: it asks what stands in the table now.
   *
   * ## It is not a third rule
   *
   * {@link deleteHomelessAccounts} is the `where` of
   * {@link deleteHomelessAccount} without its `id` — both domain
   * conditions word for word. That an account is thereby also deleted that
   * **never** belonged to a deleted Organisation but became homeless by another
   * route is the decision and not its side effect: since Konzept
   * no. 69 an account without a membership and without superadmin rights has no
   * place any more, and both doors — Organisation purge and *Person entfernen* — lead into
   * the same state. The precondition under which that is free of races (account and
   * membership come about in **one** transaction) stands at the
   * statement.
   *
   * **One** statement for the whole installation, not a batch: in normal operation the `where`
   * hits nothing, because the phase before it has already cleaned up.
   * An error counts as `failed` and does not end the run — the next
   * reconciliation finds the same rows again, which is the whole point.
   */
  private async reconcileHomelessAccounts(): Promise<{
    removed: number;
    failed: number;
  }> {
    try {
      return { removed: await deleteHomelessAccounts(this.prisma), failed: 0 };
    } catch (error: unknown) {
      // The class, never the message — this statement names people.
      this.logger.warn(
        `trash purge: the closing account reconciliation failed ` +
          `(${describe(error)}); the next run asks again`,
      );
      return { removed: 0, failed: 1 };
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // The run itself
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Walks one population in batches until it is empty — **by cursor**.
   *
   * ## The exclusion list was the wrong answer (two review findings)
   *
   * Up to this point the run carried a list `skip` of all the items it
   * could not remove, and appended it as `id: { notIn: [...] }` to every
   * listing. It was meant to prevent the loop from turning over the same
   * page — and it had **no upper bound**:
   *
   * - *measured:* 70 000 due forms with permanently failing deletion →
   *   `The query parameter limit supported by your database is exceeded`, and
   *   `runTick` only swallowed that. The realistic route there is no
   *   special case but a storage outage: then **every** item with an
   *   attachment reports `'files-stuck'`, `skip` grows to the number of all due
   *   items, and the purge clears nothing at all for the whole installation,
   *   silently. Far below that number already, a `notIn` with thousands of ids
   *   is a quadratic scan;
   * - and it kept its promise only by half anyway. The reasoning that stood
   *   here — „mehr als {@link TRASH_PURGE_BATCH_SIZE} fällige Elemente, eines
   *   davon scheiternd, und der Lauf dreht sich über derselben Seite" — is
   *   *measured to be wrong*: with exactly one failing item the run terminates
   *   even without `skip`, after 151 attempts at 150 items. The real
   *   danger is **≥ batch size** permanently failing items, and for that
   *   there is now a case in `test/trash/retention-purge.spec.ts`.
   *
   * ## The cursor
   *
   * Instead of remembering what is to be skipped, the run remembers **where it
   * left off**: `(deleted_at, id)` of the last row of a page,
   * and the next listing takes only what comes after it ({@link dueWhere}).
   * That has three properties the list did not have:
   *
   * 1. **constant memory and one index access** instead of a growing
   *    parameter list — the ordering `(deleted_at, id)` is the same one
   *    the paging goes by;
   * 2. **termination without case distinction.** The cut-off stands fixed for the
   *    whole run, the cursor grows strictly monotonically, so every due
   *    item is touched at most **once**. How many of them
   *    fail no longer plays any role;
   * 3. **no double counting.** A failed item does not come round again in this
   *    run, and therefore not a second time in `failed` either.
   *
   * The price, named: an item that became due *anew* between two pages
   * would lie behind the cursor — but that cannot occur, because `cutoff`
   * is computed once per run. And what fails for this run is picked up by the
   * next one, which starts at the front again.
   *
   * An item that reports `'not-found'` counts as neither removed nor
   * failed: it was restored or destroyed between the listing and the attempt,
   * and the caller wanted it gone — it is gone.
   */
  private async drain<T extends DueItem>(
    label: 'Organisation' | 'form' | 'answer' | 'draft',
    batch: (after: Cursor | undefined) => Promise<readonly T[]>,
    remove: (item: T) => Promise<PermanentDeletionOutcome>,
  ): Promise<{ removed: number; failed: number }> {
    let removed = 0;
    let failed = 0;
    let after: Cursor | undefined;

    for (;;) {
      const items = await batch(after);
      for (const item of items) {
        let outcome: PermanentDeletionOutcome;
        try {
          outcome = await remove(item);
        } catch (error: unknown) {
          // **Every outcome the deletion can throw**, not only the storage one
          // it can *report* — the second half of a review finding: a
          // `P2028` on a form with thousands of answers, a lock timeout, a lost
          // connection. The class, never the message; the message quotes the
          // statement, and the statement names rows.
          this.logger.warn(
            `trash purge: one ${label} could not be deleted (${describe(error)}); ` +
              `it stays and the run continues`,
          );
          failed += 1;
          continue;
        }

        if (outcome === 'deleted') {
          removed += 1;
        } else if (outcome === 'files-stuck') {
          failed += 1;
        }
      }

      // A short batch (an empty one included) means the listing has nothing
      // left behind the cursor; a full one may have.
      const last = items.at(-1);
      if (last === undefined || items.length < TRASH_PURGE_BATCH_SIZE) {
        break;
      }
      after = { at: last.at, id: last.id };
    }

    return { removed, failed };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // The listings — ids only, and nothing from a request in the predicate
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Every organisation whose 30 days are up, ids only.
   *
   * The same predicate `ScopedTenantDelegate.purgeIfDeletedBefore` uses as the
   * condition of its `DELETE`, so an organisation this listing offers is an organisation that
   * statement will accept — and one restored in between is refused *there*
   * rather than here. Oldest deletion first, so a run that is interrupted has
   * removed what has waited longest.
   */
  private async dueTenants(
    cutoff: Date,
    after: Cursor | undefined,
  ): Promise<readonly DueItem[]> {
    return dated(
      await this.prisma.tenant.findMany({
        where: dueWhere(cutoff, after),
        select: { id: true, deletedAt: true },
        orderBy: DUE_ORDER,
        take: TRASH_PURGE_BATCH_SIZE,
      }),
    );
  }

  /**
   * The members of one organisation, **user ids only**.
   *
   * Not a name and not an address: this job runs across every organisation of the
   * installation, and a listing that cannot read a person's data cannot hand
   * one out — the property the allow-list entry rests on.
   */
  private async membersOf(tenantId: string): Promise<readonly string[]> {
    const rows = await this.prisma.membership.findMany({
      where: { tenantId },
      select: { userId: true },
    });
    return rows.map((row) => row.userId);
  }

  /**
   * Every form whose 30 days in the trash are up, with its organisation — **unless
   * the organisation is itself in the trash**.
   *
   * `tenant: { deletedAt: null }` is the outer bracket of the class comment as
   * a *condition*: a form of a deleted Organisation is not a second item to destroy, it
   * goes with its organisation — exactly the shape {@link dueResponses} takes one level
   * down for the form. Without it the organisation's own 30 days would be quietly
   * shorter for its contents than for itself, and „wiederhergestellt
   * funktioniert wieder alles"  would hold for the
   * Organisation and not for what is in it.
   */
  private async dueForms(
    cutoff: Date,
    after: Cursor | undefined,
  ): Promise<readonly DueForm[]> {
    return dated(
      await this.prisma.form.findMany({
        where: { ...dueWhere(cutoff, after), tenant: { deletedAt: null } },
        select: { id: true, tenantId: true, deletedAt: true },
        orderBy: DUE_ORDER,
        take: TRASH_PURGE_BATCH_SIZE,
      }),
    );
  }

  /**
   * Every answer whose 30 days are up **and whose form is still alive**.
   *
   * `form: { deletedAt: null }` is the same exclusion
   * `ScopedFormDelegate.deletedResponseKeys` makes for „Papierkorb leeren": an
   * answer of a deleted form is not a second item to destroy, it goes with its
   * form — and counting it here would report more than ever stood in the
   * trash.
   *
   * `tenant: { deletedAt: null }` is that same sentence one level further up
   * (see {@link dueForms}). It is not implied by the form's: an answer can be
   * in the trash under a **living** form in an organisation that is itself deleted.
   */
  private async dueResponses(
    cutoff: Date,
    after: Cursor | undefined,
  ): Promise<readonly DueResponse[]> {
    return dated(
      await this.prisma.response.findMany({
        where: {
          ...dueWhere(cutoff, after),
          form: { deletedAt: null },
          tenant: { deletedAt: null },
        },
        select: { id: true, formId: true, tenantId: true, deletedAt: true },
        orderBy: DUE_ORDER,
        take: TRASH_PURGE_BATCH_SIZE,
      }),
    );
  }

  /**
   * Every draft whose own `expires_at` has passed, **unless its organisation is in the
   * trash** — ids and the tenant only.
   *
   * The keyset is `(expires_at, id)` rather than `(deleted_at, id)`, which is
   * the whole reason {@link DueItem} calls its timestamp `at`: the cursor needs
   * a total order, not a particular column. The index behind it
   * (`response_draft_expires_at_idx`) has existed since the table did and had no
   * consumer until this listing.
   *
   * Written out rather than built with {@link dueWhere}, because that helper
   * carries `deleted_at` in three places and this population has no such column
   * — the boundary is the row's own (see {@link purgeDrafts}).
   */
  private async dueDrafts(
    now: Date,
    after: Cursor | undefined,
  ): Promise<readonly DueDraft[]> {
    const rows = await this.prisma.responseDraft.findMany({
      where: {
        expiresAt: { lte: now },
        tenant: { deletedAt: null },
        ...(after === undefined
          ? {}
          : {
              OR: [
                { expiresAt: { gt: after.at } },
                { expiresAt: after.at, id: { gt: after.id } },
              ],
            }),
      },
      select: { id: true, tenantId: true, expiresAt: true },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: TRASH_PURGE_BATCH_SIZE,
    });
    return rows.map(({ expiresAt, ...row }) => ({ ...row, at: expiresAt }));
  }

  /**
   * How much work is **still** owed once the run is over.
   *
   * Counted, not inferred, exactly as `TrashPurgeResult.remaining` is: the
   * populations are walked in batches, and „wie viel steht noch da" must not be
   * arithmetic over what this one run happened to see. The **same predicates
   * the listings use**, so „0" means „the listings would return nothing" —
   * `tenant: { deletedAt: null }` included, without which a trashed organisation's
   * forms would be reported as outstanding for ever while nothing was ever
   * going to pick them up (a review finding).
   *
   * **Accounts are a fourth term** (a review finding). Without it a run in which
   * every account deletion failed reported `remaining: 0` and read like a clean
   * pass. It is the `where` of {@link deleteHomelessAccounts}, so after a
   * successful reconciliation it is `0` by construction.
   *
   * **Drafts are a fifth** (a review finding), against `now` and not
   * against `cutoff` — the same distinction {@link purgeDrafts} rests on. Before
   * it existed, a run that had removed nothing at all reported `remaining: 0`
   * while expired drafts lay in the table: measured, and the reason the count is
   * the assertion these things are tested with rather than the status code the
   * read gives.
   */
  private async countDue(cutoff: Date, now: Date): Promise<number> {
    const due = { deletedAt: { not: null, lte: cutoff } } as const;
    const alive = { deletedAt: null } as const;
    const [tenants, forms, responses, drafts, accounts] = await Promise.all([
      this.prisma.tenant.count({ where: due }),
      this.prisma.form.count({ where: { ...due, tenant: alive } }),
      this.prisma.response.count({
        where: { ...due, form: alive, tenant: alive },
      }),
      this.prisma.responseDraft.count({
        where: { expiresAt: { lte: now }, tenant: alive },
      }),
      this.prisma.user.count({
        where: { isSuperadmin: false, memberships: { none: {} } },
      }),
    ]);
    return tenants + forms + responses + drafts + accounts;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // The schedule
  // ───────────────────────────────────────────────────────────────────────────

  /** One scheduled run; never rejects, for the reason the worker's tick gives. */
  private tick(): Promise<void> {
    this.purging ??= this.runTick().finally(() => {
      this.purging = undefined;
    });
    return this.purging;
  }

  private async runTick(): Promise<void> {
    try {
      // the requirement. What is booked is the **sum** of the five populations:
      // one number per run, as with the other four — the breakdown
      // stands in the return value and in the log.
      await this.jobRuns.recordRun(JobKind.retention_purge, async () => {
        const result = await this.runOnce();
        return {
          result,
          itemCount:
            result.tenants +
            result.forms +
            result.responses +
            result.drafts +
            result.accounts,
        };
      });
    } catch (error: unknown) {
      this.logger.error(`trash purge failed: ${describe(error)}`);
    }
  }
}

/**
 * **The class, never the message** (a lesson learned from the file purge).
 *
 * A failing `rm` reports the path it tried, and a failing statement quotes
 * itself — the volume layout and the rows of the very deletion this job exists
 * to make final, written into a log that outlives it. One helper rather than
 * four copies of the ternary, so the next call site cannot pick the other one
 * by accident.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.constructor.name : 'unknown error';
}
