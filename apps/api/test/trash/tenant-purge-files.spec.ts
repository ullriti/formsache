import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';

import { trashCutoff } from '@formsache/shared';
import { afterEach, afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AdminService } from '../../src/admin/admin.service';
import { PermanentDeletionService } from '../../src/trash/permanent-deletion.service';
import {
  TenantScopeFactory,
  type TenantScope,
} from '../../src/tenancy/tenant-scope';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import { createTestApp, type TestApp } from '../support/create-test-app';
import { InMemoryFileStorage } from '../support/in-memory-file-storage';
import {
  createTenant,
  createUser,
  type TenantFixture,
} from '../support/fixtures';

/**
 * **The file side of the organisation purges — and what it must *not* touch**
 * (a security review, two findings).
 *
 * Two promises, and neither of them had a reproduction before this file:
 *
 * 1. `ScopedFileDelegate.purgeFile` and `.dueFileIds` destroy and enumerate
 *    files of an organisation **whose 30 days are up**, and of no other. They hang off
 *    the `ScopedFileDelegate` that `TenantScopeGuard` puts on every guarded
 *    request, and the byte removal cannot be taken back — so „only the purge
 *    calls that" is not a property, it is a hope about callers. What the
 *    review found was exactly that: the condition lived in a doc comment.
 * 2. A **restore landing inside the loop** stops it. The due-question used to be
 *    asked once, before the first file; the closing `DELETE` then correctly
 *    matched nothing while every file already reached was gone — an organisation back in
 *    service whose answers name attachments that answer 404.
 *
 * ## What this file deliberately does not claim
 *
 * The second case is *not* closed to zero and is measured as what it is: the
 * file whose `remove()` is in flight when the restore commits **is lost**, bytes
 * and row. What the fix buys is that the window is one statement per file
 * instead of the whole run — so the case below asserts one loss and two
 * survivors, not three survivors.
 *
 * The organisation is deleted and restored through {@link AdminService}, i.e. through
 * the same two statements the superadmin routes use — a second transaction on a
 * second connection, with no `sleep` anywhere: the storage double parks the
 * `remove()` and the test acts while it is parked.
 *
 * ## Reproductions, measured on 2026-08-03 — see each case
 */

/** Not a real PNG; the delivery gate reads the column, never the bytes. */
const BYTES = Buffer.from('89504e470d0a1a0a', 'hex');

const THIRTY_ONE_DAYS = 31 * 86_400_000;

describe('the file half of an organisation purge (findings 1 and 2)', () => {
  let database: TestDatabase | undefined;
  let testApp: TestApp;
  let storage: InMemoryFileStorage;
  let purge: PermanentDeletionService;
  let scopes: TenantScopeFactory;
  let admin: AdminService;

  /** An organisation that is not in the trash at all — finding 1. */
  let alive: TenantFixture;
  /** …and its logo, bytes and row. */
  let aliveLogo: string;

  const prisma = (): TestApp['prisma'] => testApp.prisma;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    storage = new InMemoryFileStorage();
    testApp = await createTestApp({ databaseUrl: database.url, storage });
    purge = testApp.app.get(PermanentDeletionService);
    scopes = testApp.app.get(TenantScopeFactory);
    admin = testApp.app.get(AdminService);

    alive = await createTenant(prisma(), 'ALIVE');
    aliveLogo = await plantLogo(alive.id);
  }, 240_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  afterEach(() => {
    storage.resetArrangements();
  });

  // ─── fixtures ───────────────────────────────────────────────────────────

  /** A `tenant_logo` row of `tenantId`, with bytes behind it. */
  async function plantLogo(tenantId: string): Promise<string> {
    const row = await prisma().file.create({
      data: {
        tenantId,
        kind: 'tenant_logo',
        publicRef: randomBytes(16).toString('base64url'),
        fileName: 'logo.png',
        contentType: 'image/png',
        status: 'stored',
      },
      select: { id: true },
    });
    await storage.put(row.id, Readable.from([BYTES]), { maxBytes: 4096 });
    return row.id;
  }

  /**
   * An organisation in the trash since `deletedAt`, with a form, an answer and
   * `attachments` files hanging off it — a logo plus the participant
   * attachments the finding is about („a participant's certificate is gone").
   */
  async function doomedTenant(
    shortName: string,
    deletedAt: Date,
    attachments: number,
  ): Promise<{ tenant: TenantFixture; scope: TenantScope; actor: string }> {
    const tenant = await createTenant(prisma(), shortName);
    const user = await createUser(prisma(), {
      email: `admin-${shortName.toLowerCase()}@example.invalid`,
      password: 'test-password-e3',
      tenants: [tenant],
    });
    const form = await prisma().form.create({
      data: {
        tenantId: tenant.id,
        title: 'Anmeldung',
        draftSchema: { pages: [] },
        publicSlug: randomBytes(16).toString('base64url'),
      },
      select: { id: true },
    });
    const version = await prisma().formVersion.create({
      data: {
        tenantId: tenant.id,
        formId: form.id,
        version: 1,
        schema: { pages: [] },
      },
      select: { id: true },
    });
    const response = await prisma().response.create({
      data: {
        tenantId: tenant.id,
        formId: form.id,
        formVersionId: version.id,
        answers: {},
      },
      select: { id: true },
    });

    await plantLogo(tenant.id);
    for (let index = 0; index < attachments; index += 1) {
      const row = await prisma().file.create({
        data: {
          tenantId: tenant.id,
          kind: 'response_attachment',
          formId: form.id,
          responseId: response.id,
          publicRef: randomBytes(16).toString('base64url'),
          fileName: 'Bescheinigung.pdf',
          contentType: 'application/pdf',
          status: 'stored',
        },
        select: { id: true },
      });
      await storage.put(row.id, Readable.from([BYTES]), { maxBytes: 4096 });
    }

    // Deleted through the real verb, then the moment is moved back: the 30 days
    // are what the purge reads, and writing the column by hand *instead* of
    // deleting would prove the purge against a state the application is not
    // shown to produce (the finding a review made on this very shape).
    await admin.remove(
      tenant.id,
      { confirmName: `Organisation ${shortName}` },
      user.id,
    );
    await prisma().tenant.update({
      where: { id: tenant.id },
      data: { deletedAt },
    });

    return { tenant, scope: scopes.create(tenant.id), actor: user.id };
  }

  /** Which of `ids` still have a row, and which still have bytes. */
  async function survivors(ids: readonly string[]): Promise<{
    rows: string[];
    bytes: string[];
  }> {
    const rows = await prisma().file.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true },
    });
    return {
      rows: rows.map((row) => row.id),
      bytes: ids.filter((id) => storage.read(id) !== undefined),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // a review finding — the predicate stands in the statement, not in the comment
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * **A logo of a living organisation survives `purgeFile`** — the delegate
   * every guarded request carries, called on a row it must not be able to
   * reach.
   *
   * This is the whole of finding 1. `purgeFile` took no cut-off: it locked any
   * `file` row of the scope's tenant, of any kind and any status, removed the
   * bytes and deleted the row. What stood in front of it was the sentence
   * „reached only from the purge of an organisation that no longer exists in any
   * listing" — a claim about callers, next to a sibling (`purgeAttachment`)
   * that keeps its own `kind` in the `where` with the opposite argument.
   *
   * *Reproduction, measured on 2026-08-03:* against the pre-fix
   * `purgeFile(id, removeBytes)` this case reads `true`, `storage.read(…) ===
   * undefined` and `file.count === 0` — the organisation's logo destroyed, bytes
   * first and irreversibly, by an organisation that is in nobody's trash. With the
   * predicate in the statement: `false`, bytes present, row present.
   */
  it('finding 1 — refuses a file of an organisation that is not in the Papierkorb', async () => {
    const scope = scopes.create(alive.id);
    const cutoff = trashCutoff(new Date('2099-01-01T00:00:00.000Z'));

    let removals = 0;
    const purged = await scope.files.purgeFile(aliveLogo, cutoff, async () => {
      removals += 1;
      await storage.remove(aliveLogo);
    });

    expect(purged).toBe(false);
    // The bytes never even reached the caller's `remove()`: the refusal is a
    // condition of the statement, not a check after the fact.
    expect(removals).toBe(0);
    expect(storage.read(aliveLogo)).toBeDefined();
    expect(await prisma().file.count({ where: { id: aliveLogo } })).toBe(1);
  }, 120_000);

  /**
   * **And the enumeration does not even name them.** `dueFileIds` is the
   * other half of the same finding: `allFileIds()` answered every file of a
   * living organisation without a single condition, which is the list a caller
   * then walks removing bytes.
   *
   * *Reproduction, measured on 2026-08-03:* with the pre-fix `allFileIds()`
   * this case is red on the **second** expectation, `[…(2)]` instead of `[]` —
   * the trash organisation that has served 29 of its 30 days offering both its
   * files up for removal. The living organisation's half above it reads `[]` in that
   * run for the worst possible reason: the case before this one has by then
   * already destroyed that logo.
   */
  it('finding 1 — enumerates nothing for an organisation that is not due', async () => {
    const scope = scopes.create(alive.id);

    expect(
      await scope.files.dueFileIds(
        trashCutoff(new Date('2099-01-01T00:00:00.000Z')),
      ),
    ).toEqual([]);

    // …and an organisation that *is* in the trash but has not served its 30 days is
    // the same answer, from the `lte` half of the same condition.
    const deletedAt = new Date('2026-09-01T09:00:00.000Z');
    const { scope: young } = await doomedTenant('YOUNG', deletedAt, 1);
    const tooEarly = trashCutoff(
      new Date(deletedAt.getTime() + 29 * 86_400_000),
    );

    expect(await young.files.dueFileIds(tooEarly)).toEqual([]);
    expect(await purge.deleteTenant(young, tooEarly)).toBe('not-found');
    // Nothing was spent on it: three rows, three objects.
    expect(
      await prisma().file.count({ where: { tenantId: young.tenantId } }),
    ).toBe(2);
  }, 180_000);

  // ═══════════════════════════════════════════════════════════════════════
  // a review finding — a restore in the middle of the loop
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * **A restore in the middle of the purge leaves the attachments it has not
   * yet reached standing** — and costs the one whose bytes are in flight.
   *
   * The storage double parks the **first** `remove()` (`holdNextRemoval`); the
   * restore then runs through `AdminService.restore`, i.e. a second transaction
   * on a second connection, while that removal is parked. No `sleep` is
   * involved: the test waits on the gate the double opens, not on a clock.
   *
   * *Reproduction, measured on 2026-08-03:* with the due-check asked only once
   * before the loop (the pre-fix shape), **all three** files are gone — rows and
   * bytes — while the organisation itself comes back, because the closing `DELETE`
   * correctly matches nothing. With the predicate per iteration: one lost, two
   * standing.
   *
   * **What stays lost, said plainly:** the file whose `remove()` had already
   * been entered. Its bytes are gone and its row with them, the answer that
   * named it is back and intact, and nothing in the application records which
   * attachment that was — the `file` row is the only record and it is what was
   * deleted. That is the residue the fix does not remove; closing it would mean
   * holding a lock on `tenant` across filesystem calls.
   */
  it('finding 2 — a restore inside the loop leaves the files it has not reached', async () => {
    const deletedAt = new Date('2026-09-01T09:00:00.000Z');
    const { tenant, scope, actor } = await doomedTenant('MIDWAY', deletedAt, 2);
    const cutoff = trashCutoff(new Date(deletedAt.getTime() + THIRTY_ONE_DAYS));

    const planted = await scope.files.dueFileIds(cutoff);
    expect(planted).toHaveLength(3);

    const held = storage.holdNextRemoval();
    const run = purge.deleteTenant(scope, cutoff);
    await held.arrived;

    // The second transaction, while one file's bytes are in flight.
    await admin.restore(tenant.id, actor);
    held.release();

    // The organisation is not deleted: the closing `DELETE` carries the same condition.
    expect(await run).toBe('not-found');
    expect(
      (
        await prisma().tenant.findUniqueOrThrow({
          where: { id: tenant.id },
          select: { deletedAt: true },
        })
      ).deletedAt,
    ).toBeNull();

    // Exactly one file was reached — the one that was already inside its
    // `remove()`. Which one that is depends on the plan PostgreSQL picked for
    // the enumeration, so the case asserts the count and the agreement between
    // rows and bytes rather than an id.
    const left = await survivors(planted);
    expect(left.rows).toHaveLength(2);
    // No row without its bytes and no bytes without their row: the survivors
    // are whole, which is what makes „restored" mean anything.
    expect([...left.bytes].sort()).toEqual([...left.rows].sort());
  }, 180_000);

  /**
   * The counterpart, so „stays standing" cannot be true of a purge that simply
   * stopped working: **without** a restore the same organisation goes, files and all.
   */
  it('finding 2 — undisturbed, the same purge removes every file and the organisation', async () => {
    const deletedAt = new Date('2026-09-01T09:00:00.000Z');
    const { tenant, scope } = await doomedTenant('GONE', deletedAt, 2);
    const cutoff = trashCutoff(new Date(deletedAt.getTime() + THIRTY_ONE_DAYS));

    const planted = await scope.files.dueFileIds(cutoff);
    expect(planted).toHaveLength(3);

    expect(await purge.deleteTenant(scope, cutoff)).toBe('deleted');

    const left = await survivors(planted);
    expect(left.rows).toEqual([]);
    expect(left.bytes).toEqual([]);
    expect(await prisma().tenant.count({ where: { id: tenant.id } })).toBe(0);
  }, 180_000);
});
