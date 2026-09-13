import { randomBytes } from 'node:crypto';

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { Readable } from 'node:stream';
import { UNCLAIMED_FILE_LIFETIME_MS } from '@formsache/shared';

import { FilePurgeService } from '../../src/files/purge/file-purge.service';
import {
  CLAIM_REFUSAL,
  ClaimRefusedError,
  claimAttachments,
} from '../../src/public/attachment-claim';
import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import { createTestApp, type TestApp } from '../support/create-test-app';
import { createTenant, type TenantFixture } from '../support/fixtures';
import { InMemoryFileStorage } from '../support/in-memory-file-storage';
import { MutableClock } from '../mail/mail-test-context';

/**
 * **The purge of orphaned attachments — the requirement, ADR-0014 no. 15.**
 *
 * An upload happens before the answer exists, so an abandoned fill-in session
 * leaves a file nothing points at. Nobody in this application ever looks at
 * such a row again; the bytes behind it are somebody's certificate, and this
 * purge is what guarantees they eventually go.
 *
 * ## Measured at the boundary, with an injected clock
 *
 * A file aged a year survives *every* deadline between a minute and a year — it
 * would be taken by a purge that keeps nothing and by one that keeps a day, and
 * the case could not tell them apart. Both fixtures here therefore sit one
 * minute either side of {@link UNCLAIMED_FILE_LIFETIME_MS}, and the clock is
 * the injected one, moved by hand: a test that waited twenty-four hours is not
 * a test (`mail-clock.ts`).
 *
 * **One clock, not two.** `created_at` is written explicitly, derived from the
 * same instant the purge computes its cut-off from — anchoring the rows on the
 * database's `now()` while measuring in Node is two machines' opinions, and
 * nothing forces them to agree.
 *
 * ## Counted without a filter, and asked of the storage
 *
 * „Weg, nicht markiert" is a raw `count(*)` over the whole table plus the
 * question to the storage double. Asking the repository would only prove that
 * the repository filters — which is what a `deleted_at` implementation would
 * also do.
 *
 * ## What is deliberately **not** here
 *
 * Another proof — „endgültiges Löschen einer Antwort entfernt ihre
 * Dateien aus dem Storage" — hangs on the trash and belongs elsewhere
 * (ADR-0014 no. 16). And the second owner arm for drafts belongs elsewhere
 * too, which brings its own case: a draft's attachment surviving this purge
 * („die Falle, die aufgeschrieben werden muss").
 */

const SETUP_TIMEOUT_MS = 180_000;
const RESTART_TIMEOUT_MS = 60_000;
const WAIT_BUDGET_MS = 5_000;
/**
 * How long a blocked operation is given to prove it is blocked rather than
 * merely slow. Generous against a slow machine and far below the point at which
 * „waited for the lock" could pass for „was busy": with the lock in place there
 * is one `UPDATE` against a row already held.
 */
const OVERLAP_BUDGET_MS = 1_000;
/**
 * An interval no test can wait out — an hour, where the shipped value is a day.
 * A row that disappears under it did so at startup or not at all.
 */
const HUGE_INTERVAL_MS = 3_600_000;

const MINUTE_MS = 60_000;

/** A fixed instant far from any boundary, so a failure points at the code. */
const EPOCH = new Date('2026-06-15T09:00:00.000Z');
/** The name every fixture row carries — the one a claim has to repeat. */
const FIXTURE_NAME = 'Nachweis.pdf';

/**
 * The storage double with two things a purge test needs: a way to **park**
 * inside `remove()`, and a way to make one `remove()` fail.
 *
 * Both live here rather than in `InMemoryFileStorage`, which every other suite
 * shares: a double that can fail on command is a hazard in a helper and a tool
 * in a file that is about failure.
 */
class ControllableFileStorage extends InMemoryFileStorage {
  private failAfter: number | undefined;
  /** Keys this double was asked to remove, in order. */
  readonly removed: string[] = [];

  /**
   * Lets `count` removals through and rejects the one after.
   *
   * The failure has to land *after* something has already been removed: that is
   * the ordering in which a batch transaction loses the bytes of the earlier
   * files while their rows roll back alive.
   */
  failAfterRemovals(count: number): void {
    this.failAfter = count;
  }

  /** Forgets this class's arrangement as well as the base class's. */
  override resetArrangements(): void {
    super.resetArrangements();
    this.failAfter = undefined;
  }

  protected override async removeObject(key: string): Promise<void> {
    if (this.failAfter !== undefined) {
      if (this.failAfter === 0) {
        this.failAfter = undefined;
        throw new Error('storage unavailable');
      }
      this.failAfter -= 1;
    }
    await super.removeObject(key);
    this.removed.push(key);
  }
}

async function waitUntil(
  condition: () => Promise<boolean>,
  budgetMs = WAIT_BUDGET_MS,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (await condition()) {
      return true;
    }
    if (Date.now() > deadline) {
      return false;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10).unref();
    });
  }
}

/**
 * Whether `condition` held for the whole budget — the mirror of
 * {@link waitUntil}, for asserting that something does **not** happen.
 *
 * A single check right after start-up would only say „it has not happened
 * yet": the purge's startup pass is fired without being awaited, so „nothing
 * was deleted" needs time to be wrong in.
 */
async function stayedTrue(
  condition: () => Promise<boolean>,
  budgetMs = WAIT_BUDGET_MS,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (!(await condition())) {
      return false;
    }
    if (Date.now() > deadline) {
      return true;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10).unref();
    });
  }
}

/** Resolves to `'blocked'` if `promise` has not settled within the budget. */
async function settlesWithin<T>(
  promise: Promise<T>,
  budgetMs = OVERLAP_BUDGET_MS,
): Promise<T | 'blocked'> {
  return Promise.race([
    promise,
    new Promise<'blocked'>((resolve) => {
      setTimeout(() => {
        resolve('blocked');
      }, budgetMs).unref();
    }),
  ]);
}

describe('the purge of orphaned attachments ', () => {
  let database: TestDatabase;
  let testApp: TestApp;
  let prisma: PrismaService;
  let storage: ControllableFileStorage;
  let clock: MutableClock;
  let purge: FilePurgeService;
  let tenant: TenantFixture;
  let formId: string;
  let versionId: string;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    storage = new ControllableFileStorage();
    clock = new MutableClock(EPOCH);
    testApp = await createTestApp({
      databaseUrl: database.url,
      storage,
      clock,
    });
    prisma = testApp.prisma;
    purge = testApp.app.get(FilePurgeService);

    tenant = await createTenant(prisma, 'PURGE');
    const form = await prisma.form.create({
      data: {
        tenantId: tenant.id,
        title: 'Anmeldung mit Nachweis',
        draftSchema: { pages: [] },
        publicSlug: 'slug-file-purge',
      },
    });
    formId = form.id;
    versionId = (
      await prisma.formVersion.create({
        data: {
          tenantId: tenant.id,
          formId: form.id,
          version: 1,
          schema: { pages: [] },
        },
      })
    ).id;
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await testApp.close();
    await database.release();
  }, SETUP_TIMEOUT_MS);

  beforeEach(async () => {
    // Every assertion below is a count over the whole table.
    await prisma.file.deleteMany();
    clock.set(EPOCH);
  });

  afterEach(() => {
    storage.removed.length = 0;
    // An arrangement no case consumed — a `failNextRemoval` whose batch a
    // regression left empty — would otherwise fall into the next case and fail
    // it with „storage unavailable": a misleading second failure standing in
    // front of the real one.
    storage.resetArrangements();
  });

  /** One `file` row plus its bytes in the storage double. */
  async function file(
    overrides: {
      kind?: 'response_attachment' | 'tenant_logo';
      ageMs?: number;
      responseId?: string;
    } = {},
  ): Promise<{ readonly id: string; readonly ref: string }> {
    const ref = randomBytes(16).toString('base64url');
    const isLogo = overrides.kind === 'tenant_logo';
    const row = await prisma.file.create({
      data: {
        tenantId: tenant.id,
        kind: overrides.kind ?? 'response_attachment',
        formId: isLogo ? null : formId,
        publicRef: ref,
        fileName: FIXTURE_NAME,
        contentType: 'application/pdf',
        status: 'stored',
        byteSize: 1024,
        // Explicit, from the injected clock: see „One clock, not two" above.
        createdAt: new Date(clock.now().getTime() - (overrides.ageMs ?? 0)),
        ...(overrides.responseId === undefined
          ? {}
          : { responseId: overrides.responseId }),
      },
    });
    await storage.put(row.id, Readable.from([Buffer.from('%PDF-1.7\n')]), {
      maxBytes: 1024,
    });
    return { id: row.id, ref };
  }

  /** An answer to hang a claimed attachment off. */
  async function response(): Promise<string> {
    const row = await prisma.response.create({
      data: {
        tenantId: tenant.id,
        formId,
        formVersionId: versionId,
        answers: {},
      },
    });
    return row.id;
  }

  /** Rows still physically present, asked without any `where` at all. */
  async function rawRowCount(): Promise<number> {
    const result = await prisma.$queryRaw<
      { count: number }[]
    >`SELECT count(*)::int AS "count" FROM "file"`;
    return result[0]?.count ?? -1;
  }

  /** Whether one particular row is still there — counts cannot say which. */
  async function rawRowExists(id: string): Promise<boolean> {
    const result = await prisma.$queryRaw<
      { count: number }[]
    >`SELECT count(*)::int AS "count" FROM "file" WHERE "id" = ${id}::uuid`;
    return (result[0]?.count ?? 0) > 0;
  }

  /** One claim, in a transaction of its own, exactly as a submission runs it. */
  async function claim(
    ref: string,
    responseId: string,
    now: Date,
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await claimAttachments(tx, {
        files: [{ ref, name: FIXTURE_NAME }],
        formId,
        tenantId: tenant.id,
        responseId,
        now,
      });
    });
  }

  /**
   * **The proof:** a file that was never submitted is gone after
   * the deadline — and one a minute short of it is not.
   *
   * *Reproduction:* widen the cut-off (`<` to `>`, or a second constant instead
   * of `UNCLAIMED_FILE_LIFETIME_MS`) → one half of this case is red whichever
   * way it moves, which is what the pair is for.
   */
  it('deletes an attachment nobody claimed once it is past the deadline', async () => {
    const expired = await file({
      ageMs: UNCLAIMED_FILE_LIFETIME_MS + MINUTE_MS,
    });
    const fresh = await file({ ageMs: UNCLAIMED_FILE_LIFETIME_MS - MINUTE_MS });

    expect(await purge.runOnce()).toBe(1);

    // Physically gone, counted over the whole table — and the bytes with it.
    expect(await rawRowCount()).toBe(1);
    expect(
      await prisma.file.findUnique({ where: { id: expired.id } }),
    ).toBeNull();
    expect(storage.read(expired.id)).toBeUndefined();

    expect(
      await prisma.file.findUnique({ where: { id: fresh.id } }),
    ).not.toBeNull();
    expect(storage.read(fresh.id)).toBeDefined();
  });

  /**
   * A second run answers `0`. The **return value** is what tells „there was
   * nothing left" apart from „it fell over before it got there".
   */
  it('is idempotent: a second run deletes nothing', async () => {
    await file({ ageMs: UNCLAIMED_FILE_LIFETIME_MS + MINUTE_MS });
    const fresh = await file({ ageMs: MINUTE_MS });

    expect(await purge.runOnce()).toBe(1);
    expect(await purge.runOnce()).toBe(0);
    expect(await rawRowCount()).toBe(1);
    expect(storage.read(fresh.id)).toBeDefined();
  });

  /**
   * **The owner half of the predicate.** „Älter als 24 Stunden" alone would
   * take the attachment of every answer this installation has ever stored.
   *
   * *Reproduction:* drop `response_id IS NULL` → this is red, and it is the
   * expensive direction: a stored answer pointing at bytes that are gone.
   */
  it('leaves an attachment that belongs to an answer alone', async () => {
    const owner = await response();
    const owned = await file({
      ageMs: UNCLAIMED_FILE_LIFETIME_MS * 30,
      responseId: owner,
    });

    expect(await purge.runOnce()).toBe(0);
    expect(
      await prisma.file.findUnique({ where: { id: owned.id } }),
    ).not.toBeNull();
    expect(storage.read(owned.id)).toBeDefined();
  });

  /**
   * **The purge does not touch a Logo** (ADR-0014 no. 15, „Warum der
   * Logo-Arm hier nicht steht").
   *
   * A `tenant_logo` has no `response_id` and never gets one — the reference
   * lives in `tenant.logo_ref` as a union, which this query cannot read. Under
   * a two-part predicate every uploaded Logo would therefore be deleted,
   * physically, a day after it was uploaded, while the organisation's public page went
   * on rendering it.
   *
   * *Reproduction:* drop `kind = 'response_attachment'` → this is red.
   */
  it('does not touch a Logo, however old and however unowned', async () => {
    const logo = await file({
      kind: 'tenant_logo',
      ageMs: UNCLAIMED_FILE_LIFETIME_MS * 30,
    });

    expect(await purge.runOnce()).toBe(0);
    expect(
      await prisma.file.findUnique({ where: { id: logo.id } }),
    ).not.toBeNull();
    expect(storage.read(logo.id)).toBeDefined();
    expect(storage.removed).toEqual([]);
  });

  /**
   * **Bytes first, row second** (ADR-0014 no. 16) — measured as: a `remove()`
   * that fails leaves the row standing, and the next run catches up.
   *
   * The order inside one transaction is not what this measures; the
   * *transaction* is. The regression it catches is the one that looks harmless
   * in a diff — deleting the rows, committing, and removing the bytes
   * afterwards. Then a failing `remove()` leaves bytes with no index: personal
   * data the application has declared deleted and, with no `list()` on the
   * seam, can never find again.
   *
   * *Reproduction:* move the `remove()` loop out of the transaction, after the
   * commit → the row is gone here and this case is red on its first assertion.
   */
  it('keeps the row when the storage refuses, and takes it on the next run', async () => {
    const doomed = await file({
      ageMs: UNCLAIMED_FILE_LIFETIME_MS + MINUTE_MS,
    });
    storage.failNextRemoval();

    // **Answers, never rejects** (a security review finding). One file the volume
    // refuses is not a failed run — see the case below for what happens to the
    // others when it is treated as one.
    expect(await purge.runOnce()).toBe(0);

    // The row stands, and its bytes with it — the visible half is the one left
    // over, which is the whole point of the order.
    expect(await rawRowCount()).toBe(1);
    expect(storage.read(doomed.id)).toBeDefined();

    expect(await purge.runOnce()).toBe(1);
    expect(await rawRowCount()).toBe(0);
    expect(storage.read(doomed.id)).toBeUndefined();
  });

  /**
   * **One unremovable file must cost one file, not the whole installation**
   * (a security review finding).
   *
   * `ORDER BY created_at` puts the longest-failing row at the head of *every*
   * batch, so a single file the volume refuses — remounted read-only, `EACCES`,
   * a full disk, all three named as an assumption of ADR-0014 — used to abort
   * the run before it reached anything else. Measured then: three runs, nothing
   * deleted, the healthy third file never touched, while the application went on
   * promising deletion. Silently, because a purge that deletes nothing looks
   * exactly like a purge with nothing to do.
   *
   * *Reproduction:* let the failure out of the per-file `try` in `runOnce` →
   * the two healthy files survive and this case is red.
   */
  it('works past a file the storage refuses and takes the rest', async () => {
    const poison = await file({
      ageMs: UNCLAIMED_FILE_LIFETIME_MS + 3 * MINUTE_MS,
    });
    const second = await file({
      ageMs: UNCLAIMED_FILE_LIFETIME_MS + 2 * MINUTE_MS,
    });
    const third = await file({
      ageMs: UNCLAIMED_FILE_LIFETIME_MS + MINUTE_MS,
    });
    // The oldest, so it is first in every listing.
    storage.failNextRemoval();

    expect(await purge.runOnce()).toBe(2);

    expect(storage.read(poison.id)).toBeDefined();
    expect(storage.read(second.id)).toBeUndefined();
    expect(storage.read(third.id)).toBeUndefined();
    expect(await rawRowCount()).toBe(1);
  });

  /**
   * **A file that fails takes its own row down with it and nothing else's**
   * (a security review finding).
   *
   * This is the case the batch transaction got wrong, and the reasoning that
   * hid it is worth keeping: „a `remove()` that threw never gets here, the
   * transaction aborts, nothing is committed" is true of the rows and **false
   * of the bytes**, because `remove()` cannot be rolled back. With one
   * transaction for fifty files, an abort in the middle left every earlier file
   * byte-less with its row alive *and* unlocked — and a submission could then
   * claim it. An answer naming an attachment with no bytes, no error at
   * submission time: the precise outcome the two-phase design exists to
   * prevent. It needed no broken file either; a container restart or the
   * transaction timeout mid-batch does the same.
   *
   * *Reproduction:* take the removals and the `DELETE` back into one
   * transaction over the whole batch → the file removed before the failure
   * keeps its row while its bytes are gone, and the third assertion is red.
   */
  it('never leaves a row whose bytes it has already removed', async () => {
    const first = await file({
      ageMs: UNCLAIMED_FILE_LIFETIME_MS + 2 * MINUTE_MS,
    });
    const poison = await file({
      ageMs: UNCLAIMED_FILE_LIFETIME_MS + MINUTE_MS,
    });

    // The *second* file fails, so the first one's bytes are already gone when
    // it does — the ordering that made the old shape lose them.
    storage.failAfterRemovals(1);

    expect(await purge.runOnce()).toBe(1);

    // Gone entirely, not half.
    expect(storage.read(first.id)).toBeUndefined();
    expect(await rawRowExists(first.id)).toBe(false);

    // Untouched entirely, not half.
    expect(storage.read(poison.id)).toBeDefined();
    expect(await rawRowExists(poison.id)).toBe(true);
  });

  /**
   * **The race, actually raced** (ADR-0014 no. 15, „der zweite Riegel").
   *
   * The claim's own condition 5 („younger than the deadline") is an argument
   * about *clocks*: it holds because age grows monotonically — provided the
   * claim and the purge measure age the same way. This case is the one where
   * they do not, which is exactly what the lock is for: the claim runs with a
   * clock two minutes behind, so the very row the purge has selected as expired
   * still looks fresh to it.
   *
   * The purge is parked **inside `remove()`**, holding its `FOR UPDATE` lock,
   * and the claim is started underneath it. With the lock the claim waits and
   * then re-evaluates its `WHERE` against a row that is gone: nought rows
   * updated, submission refused, readably. Without it the claim would sail
   * through, commit, and the purge would then delete the row it had already
   * selected — a stored answer naming an attachment with **no bytes**, no error
   * at submission time, visible only when an editor clicks the link weeks
   * later.
   *
   * *Reproduction:* drop `FOR UPDATE` from the selection → the claim no longer
   * blocks (`expect('blocked')` red) and it commits over a file whose bytes and
   * row the purge then removes (the two closing assertions red as well).
   */
  it('makes a concurrent claim wait for the lock, and refuses it afterwards', async () => {
    const contested = await file({
      ageMs: UNCLAIMED_FILE_LIFETIME_MS + MINUTE_MS,
    });
    const owner = await response();

    const gate = storage.holdNextRemoval();
    const run = purge.runOnce();
    await gate.arrived;

    // Two minutes behind, so condition 5 lets this file through: the skew the
    // lock exists to cover, not a contrived value.
    const claiming = claim(
      contested.ref,
      owner,
      new Date(clock.now().getTime() - 2 * MINUTE_MS),
    ).then(
      () => 'claimed' as const,
      (error: unknown) => error,
    );

    expect(await settlesWithin(claiming)).toBe('blocked');

    gate.release();
    expect(await run).toBe(1);

    const outcome = await claiming;
    expect(outcome).toBeInstanceOf(ClaimRefusedError);
    expect((outcome as ClaimRefusedError).refusal).toBe(
      CLAIM_REFUSAL.unavailable,
    );
    expect(await rawRowCount()).toBe(0);
    expect(storage.read(contested.id)).toBeUndefined();
  });

  /**
   * **The other direction of the same race:** a claim that got there first
   * keeps its file, bytes included.
   *
   * The claim holds the row and has not committed; the purge's selection blocks
   * on that lock and, once it is granted, re-evaluates its own `WHERE` against
   * the updated row — `response_id IS NULL` is false now, so the row is not
   * returned at all. Without `FOR UPDATE` the selection would read the row as
   * free, remove its bytes, and delete it by `id` — the `DELETE` names no
   * owner, so the claim winning the race would not save it.
   *
   * *Reproduction:* drop `FOR UPDATE` → the run answers `1`, the row is gone
   * and the answer that just claimed it points at nothing.
   */
  it('leaves a file a concurrent claim took under its nose', async () => {
    const contested = await file({
      ageMs: UNCLAIMED_FILE_LIFETIME_MS + MINUTE_MS,
    });
    const owner = await response();

    let claimed: () => void = () => undefined;
    const hasClaimed = new Promise<void>((resolve) => {
      claimed = resolve;
    });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const claiming = prisma.$transaction(
      async (tx) => {
        await claimAttachments(tx, {
          files: [{ ref: contested.ref, name: FIXTURE_NAME }],
          formId,
          tenantId: tenant.id,
          responseId: owner,
          now: new Date(clock.now().getTime() - 2 * MINUTE_MS),
        });
        claimed();
        await held;
      },
      { timeout: 30_000 },
    );

    await hasClaimed;
    const run = purge.runOnce();
    expect(await settlesWithin(run)).toBe('blocked');

    release();
    await claiming;
    expect(await run).toBe(0);

    const row = await prisma.file.findUnique({ where: { id: contested.id } });
    expect(row?.responseId).toBe(owner);
    expect(storage.read(contested.id)).toBeDefined();
  });

  /**
   * **A row whose bytes never arrived** (a review finding).
   *
   * `status: 'pending'` with no `byte_size` is the window of ADR-0014 no. 4: the
   * row is written before the stream is, so a process that dies mid-upload
   * leaves exactly this. It is the row that really lies around after 24 hours,
   * and every other fixture in this file writes bytes — so „the purge takes it"
   * rested entirely on `remove()` being idempotent (`rm --force`), which is a
   * property of the adapter and not of this service.
   *
   * *Reproduction:* let `removeObject` reject on a missing key instead of
   * ignoring it → red here and nowhere else in this file.
   */
  it('takes a row whose bytes never arrived', async () => {
    const row = await prisma.file.create({
      data: {
        tenantId: tenant.id,
        kind: 'response_attachment',
        formId,
        publicRef: randomBytes(16).toString('base64url'),
        fileName: FIXTURE_NAME,
        contentType: 'application/pdf',
        status: 'pending',
        byteSize: null,
        createdAt: new Date(
          clock.now().getTime() - UNCLAIMED_FILE_LIFETIME_MS - MINUTE_MS,
        ),
      },
    });

    expect(await purge.runOnce()).toBe(1);
    expect(await rawRowExists(row.id)).toBe(false);
  });

  /**
   * More candidates than one batch holds. The loop is what keeps a lock short
   * without leaving work behind — a run that stopped after its first batch
   * would quietly keep the oldest fifty-first file for ever.
   */
  it('works through more files than one batch holds', async () => {
    const many = 55;
    for (let index = 0; index < many; index += 1) {
      await file({ ageMs: UNCLAIMED_FILE_LIFETIME_MS + MINUTE_MS });
    }

    expect(await purge.runOnce()).toBe(many);
    expect(await rawRowCount()).toBe(0);
  });

  /**
   * The scheduler stays off in the test application — every other suite in
   * `test/files/` and `test/public/` writes `file` rows and counts them.
   *
   * **Both halves, because `0` has to switch off two things** (a review finding):
   * the interval *and* the run at startup. `schedulerRunning` only sees the
   * timer, so it was measured that moving `void this.tick()` in front of the
   * `interval <= 0` guard left this suite and all of `test/files` +
   * `test/public` green — 353 cases, none of which would have shown the damage
   * `create-test-app.ts` names: a purge armed under a suite that is counting the
   * very rows it deletes. The row below is what makes the second half real.
   *
   * *Reproduction:* run the startup pass before the guard → red here, green
   * everywhere else.
   */
  it(
    'arms nothing in the test application, and purges nothing either',
    async () => {
      expect(purge.schedulerRunning).toBe(false);

      await file({ ageMs: UNCLAIMED_FILE_LIFETIME_MS + MINUTE_MS });
      const quiet = await createTestApp({
        databaseUrl: database.url,
        storage,
        clock,
        env: { FILE_PURGE_INTERVAL_MS: 0 },
      });
      try {
        expect(quiet.app.get(FilePurgeService).schedulerRunning).toBe(false);
        // Given a moment, so „nothing happened" is not merely „nothing has
        // happened yet": the startup pass is fired without being awaited.
        const stillThere = await stayedTrue(
          async () => (await rawRowCount()) > 0,
        );
        expect(stillThere).toBe(true);
      } finally {
        await quiet.close();
      }
    },
    RESTART_TIMEOUT_MS,
  );

  /**
   * **The proof: a daily redeployment still deletes.**
   *
   * The shipped interval is a day, so „armed on module init" alone would put
   * the first deletion twenty-four hours after the process came up — and an
   * installation that is redeployed every night, one in a crash loop, or one on
   * a host that reboots would never delete a single file. That is the
   * operational fault, and the requirement asks for its reproduction.
   *
   * The row is seeded through the suite's own application, whose purge is off
   * (interval `0` arms nothing and runs nothing), and a second application then
   * comes up with an interval it could not possibly reach inside this test.
   * Nothing is fast forwarded and nothing calls `runOnce()`.
   *
   * *Reproduction:* arm the clean-up by interval only — drop the `void
   * this.tick()` from `onModuleInit` → the row stands and this case is red,
   * while every case above stays green, which is what makes them a control
   * rather than a duplicate.
   */
  it(
    'purges once at startup, without waiting for the first interval',
    async () => {
      const abandoned = await file({
        ageMs: UNCLAIMED_FILE_LIFETIME_MS + MINUTE_MS,
      });
      // The seeding application deletes nothing — that is what makes the next
      // one's result attributable to its own startup.
      expect(await rawRowCount()).toBe(1);

      const restarted = await createTestApp({
        databaseUrl: database.url,
        storage,
        clock,
        env: { FILE_PURGE_INTERVAL_MS: HUGE_INTERVAL_MS },
      });
      try {
        expect(restarted.app.get(FilePurgeService).schedulerRunning).toBe(true);
        const gone = await waitUntil(async () => (await rawRowCount()) === 0);
        expect(gone).toBe(true);
        expect(storage.read(abandoned.id)).toBeUndefined();
      } finally {
        await restarted.close();
      }
    },
    RESTART_TIMEOUT_MS,
  );
});
