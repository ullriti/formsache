import { DEFAULT_TENANT_BRANDING } from '@formsache/shared';
import type { Prisma, PrismaClient } from '@prisma/client';

import { DEFAULT_GROUPS, adminGroupName } from '../admin/admin.repository';

/**
 * **The first superadministrator of an installation** — the one place in this
 * application that sets `is_superadmin` without anyone being signed in
 * (ADR-0022).
 *
 * It has exactly two callers and therefore shares this file: the route
 * `POST /api/setup` (`setup.service.ts`) and the command for operators who
 * never want to release the setup page (`create-superadmin.main.ts`). **One
 * definition, two doors** — two versions of this transaction would be two
 * opportunities to lose the uniqueness, and the database would have no
 * opinion about it.
 *
 * ---------------------------------------------------------------------------
 * ## The exception, named instead of softened
 *
 * `is_superadmin` can be set via **no** route, and that is intention with
 * proof: `admin.repository.ts` writes the first administrator of an
 * organisation field by field instead of by spread, so that the flag cannot
 * travel along from a payload; `tenancy/tenant-scope.ts` holds the same line for
 * the user administration of an organisation; no schema in `packages/shared` has
 * a field for it.
 *
 * This file is the exception, and it is **a property of the code, not a
 * statement of the caller**: {@link FirstSuperadminInput} has no field
 * `isSuperadmin`, the wire schema (`setupRequestSchema`) has none, and the
 * value stands below literally as `true` in the `create`. There is no way on which
 * a request document reaches this column — only the one way on which the
 * application writes it itself, and that one exists only as long as there are
 * **zero rows in `user`**.
 *
 * ## Why the check stands *inside* the transaction
 *
 * "Is there already a user" and "create one" are two statements, and
 * between two statements a second request fits. Asked separately,
 * two simultaneous setups would yield two superadministrators — the
 * second with a password that the first never set, on an
 * installation that is reachable from outside. That is why the check stands in the
 * same `$transaction` block as the write, and that is why the
 * block locks itself beforehand.
 *
 * ### And why a pre-lock and not `Serializable`
 *
 * On an **empty** table there is nothing to lock: `SELECT … FOR UPDATE`
 * finds no row, and `INSERT … WHERE NOT EXISTS` does not help under `READ
 * COMMITTED`, because the not yet committed row of the concurrent request
 * is invisible — both would see "empty" and both would write. Two
 * means remain:
 *
 * 1. **`Serializable`.** Correct, but the collision comes back as error 40001
 *    and has to be translated by hand into "already set up" and
 *    retried. A retry path that runs exactly once in the life of an
 *    installation is a path that nobody ever finds checked.
 * 2. **A pre-lock** — {@link SETUP_LOCK}. It puts the requests into a
 *    queue instead of letting them collide: the second waits, afterwards sees
 *    the committed row of the first and answers `already-set-up`. A
 *    result, not an error.
 *
 * Chosen is 2. It costs nothing when nobody sets up alongside (that is,
 * always), and it has only one way through the code — the one that the test measures.
 *
 * ⚠️ **It hangs on `READ COMMITTED`**, the default of PostgreSQL and of
 * Prisma. There every statement takes its own snapshot, so the
 * `findFirst` *after* the lock sees what the predecessor committed. Under
 * `REPEATABLE READ` the snapshot would lie before the lock and the queue would be
 * without effect — whoever enters an isolation level here revokes the promise.
 *
 * ### What the lock does not achieve, explicitly
 *
 * It serialises the callers **of this function**, not every `INSERT` on
 * `user`. That suffices, because there is no other unauthenticated way to a
 * user row: as long as the table is empty there is no session, hence
 * no route behind `SessionGuard` either, via which someone could create an
 * account. The development seed does not take the lock — it runs against a
 * database that belongs to the developer, and here would only compete with
 * itself.
 * ---------------------------------------------------------------------------
 */

/**
 * The key of the pre-lock — two `int4`, because `pg_advisory_xact_lock` is
 * resolved unambiguously in this form and the single-argument variant would run
 * via `bigint`.
 *
 * The values are arbitrary and only have to be **stable**; they stand there as a
 * named constant so that "which lock is that" has a place in the text.
 * The first value is the namespace of this application (`0x666f726d` — "form"),
 * the second the serial number of this one lock. A second lock of this
 * application increases the second number and leaves the first as it is.
 *
 * `xact`, not `session`: it is released on commit **and** on rollback.
 * A lock that has to be released by hand is a lock
 * that holds a broken-off setup forever.
 */
export const SETUP_LOCK = {
  namespace: 0x666f_726d,
  id: 1,
} as const;

/** What the setup is to create. Without any permission field — see above. */
export interface FirstSuperadminInput {
  /** Already normalised (trimmed, lower-cased) — as in `user.email`. */
  readonly email: string;
  readonly name: string;
  /** Argon2id PHC. Hashing happens **before** the transaction, never inside it. */
  readonly passwordHash: string;
  /**
   * The first organisation — or `null` for "skipped".
   *
   * Skipped is a **valid end state**, not a half one: `user` carries
   * no `tenant_id`, and `SuperadminGuard` runs without `TenantScopeGuard`. Whoever
   * wants to run the installation first and create the organisations later
   * should not have to pay for it with a throwaway organisation.
   */
  readonly tenant: { readonly shortName: string; readonly name: string } | null;
}

/**
 * The result — **a value, not an error**.
 *
 * `already-set-up` is the normal outcome of the second of two simultaneous
 * requests and just as much that of a request that comes a year too late. Both
 * callers translate it themselves: the route into a 404 ("like a route that
 * does not exist"), the command into a message and an exit code.
 */
export type FirstSuperadminOutcome =
  | {
      readonly kind: 'created';
      readonly userId: string;
      /** Id of the created organisation, or `null` when skipped. */
      readonly tenantId: string | null;
    }
  | { readonly kind: 'already-set-up' };

/**
 * Creates the first superadministrator — and only if there is not yet **a
 * single** user.
 *
 * "Not a single user", not "no superadministrator": an
 * installation in which accounts exist is set up, even if just now
 * nobody carries the flag. The weaker condition would be an open door in
 * every installation whose only superadministrator has been deleted — that is,
 * exactly when it is most expensive.
 */
export async function createFirstSuperadmin(
  prisma: PrismaClient,
  input: FirstSuperadminInput,
): Promise<FirstSuperadminOutcome> {
  return prisma.$transaction(async (tx) => {
    // The queue. From here on this block is the only one that sets up — see
    // the file header for the full reasoning.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SETUP_LOCK.namespace}::int4, ${SETUP_LOCK.id}::int4)`;

    // **The binding check**, and the only one. `findFirst` instead of `count`:
    // what is asked is "is there any row at all", and a count over a
    // table that later has tens of thousands of rows answers the same question
    // more expensively. Only the id is read — nothing that could end up in a
    // response.
    const existing = await tx.user.findFirst({ select: { id: true } });
    if (existing !== null) {
      return { kind: 'already-set-up' };
    }

    const tenantId =
      input.tenant === null ? null : await createFirstTenant(tx, input.tenant);

    const user = await tx.user.create({
      // Field by field, not by spread — the same precaution as in
      // `admin.repository.ts`, and here with the opposite sign: there
      // `isSuperadmin` may not come from the payload, here **nothing
      // else** may come from the payload than the three fields above. The value
      // `true` stands there literally and comes from no input.
      data: {
        email: input.email,
        name: input.name,
        passwordHash: input.passwordHash,
        isSuperadmin: true,
      },
      select: { id: true },
    });

    if (tenantId !== null) {
      const adminGroup = await tx.group.findUniqueOrThrow({
        where: { tenantId_name: { tenantId, name: adminGroupName() } },
        select: { id: true },
      });
      // The superadministrator is at the same time administrator of their first
      // organisation. Not because they would have to be — they see it anyway —,
      // but so that the organisation is "able to work right away": without a
      // membership it would have nobody who works in it, and the
      // tenant selection would be empty at the first sign-in.
      await tx.membership.create({
        data: { tenantId, userId: user.id, groupId: adminGroup.id },
      });
    }

    return { kind: 'created', userId: user.id, tenantId };
  });
}

/**
 * The first organisation with its three groups — **the same construction as
 * „+ Neue Organisation"**, from the same list.
 *
 * What is deliberately *not* written here is the same as there and for
 * the same reason: no `formDefaults`, so that the column keeps its `{}` default
 * and the organisation goes on inheriting from the system layer (ADR-0011).
 * A copy of the system values would look the same on the first day and would cut
 * the organisation off forever from every later change — and of all
 * organisations it would be the *first* one of an installation that it hits.
 *
 * The appearance is the default of the installation, not that of
 * anyone in particular: fresh colours from `DEFAULT_TENANT_BRANDING`, as **fresh
 * arrays**, because Prisma's input type is mutable and a later `.push()`
 * would otherwise reach every organisation.
 *
 * ⚠️ These four lines stand a second time in `admin.repository.ts`, and that
 * is deliberately **not** a shared call: sharing the group list is worthwhile
 * (six permissions per group that could drift apart), sharing four colour fields
 * from the same constant costs an indirection and saves nothing. What
 * holds the two places together is therefore a test instead of a comment:
 * `apps/api/test/setup/setup.spec.ts` compares the first organisation of the
 * setup column by column with one that „+ Neue Organisation" creates.
 */
async function createFirstTenant(
  tx: Prisma.TransactionClient,
  tenant: { readonly shortName: string; readonly name: string },
): Promise<string> {
  const created = await tx.tenant.create({
    data: {
      shortName: tenant.shortName,
      name: tenant.name,
      logoRef: null,
      logoWide: false,
      stripeColors: [...DEFAULT_TENANT_BRANDING.stripeColors],
      accentColor: DEFAULT_TENANT_BRANDING.accent,
      headerColor: DEFAULT_TENANT_BRANDING.headerBg,
      canvasColor: DEFAULT_TENANT_BRANDING.canvasBg,
    },
    select: { id: true },
  });

  await tx.group.createMany({
    data: DEFAULT_GROUPS.map((group) => ({ ...group, tenantId: created.id })),
  });

  return created.id;
}
