import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PrismaService } from '../../src/prisma/prisma.service';
import { TenantScope } from '../../src/tenancy/tenant-scope';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import { createTestApp, type TestApp } from '../support/create-test-app';
import {
  createGroup,
  createTenant,
  createUser,
  testAccountInvitation,
  type TenantFixture,
} from '../support/fixtures';

/**
 * The foundation of this requirement against a real PostgreSQL database: the
 * composite floor under `form_permission`, and the three delegates the parallel
 * packages of this stage build on.
 *
 * **The first `describe` is the one that carries the requirement.** Everything
 * else here is about a delegate refusing to do something; that block is about
 * the *database* refusing, with the application entirely out of the way. That
 * distinction is the requirement's fourth proof — „eine Restriktion auf ein
 * Formular einer fremden Organisation ist nicht anlegbar" has to hold even if a
 * future guard chain is reordered, and it does, because such a row cannot exist.
 *
 * Every case is the **forbidden** one wherever there is one. A test that shows
 * an organisation reading its own rows stays green against a delegate with no binding at
 * all, which is the mistake this whole file exists to catch.
 */

const SETUP_TIMEOUT_MS = 180_000;

/** A uuid of the right shape that belongs to nothing. */
const ABSENT_UUID = '01919c3f-0000-7000-8000-000000000000';

describe('tenant administration scope ', () => {
  let database: TestDatabase | undefined;
  let testApp: TestApp | undefined;
  let prisma: PrismaService;

  let alpha: TenantFixture;
  let beta: TenantFixture;
  let alphaFormId: string;
  let betaFormId: string;
  let alphaViewerGroup: { id: string; name: string };
  let betaViewerGroup: { id: string; name: string };

  /** Member of ALPHA only. */
  let alphaUser: { id: string };
  /** Member of BETA only — the person ALPHA must not be able to reach. */
  let betaUser: { id: string };
  /** Member of both — the fixture the evidence needs. */
  let beideUser: { id: string };

  function alphaScope(): TenantScope {
    return new TenantScope(prisma, alpha.id);
  }

  function betaScope(): TenantScope {
    return new TenantScope(prisma, beta.id);
  }

  /**
   * A `form_permission` row written **straight into PostgreSQL** — no Prisma
   * model, no delegate, no service.
   *
   * `$executeRawUnsafe` with bound parameters rather than `prisma.formPermission
   * .create()`: the point of the block below is that the *database* refuses, and
   * a rejection coming out of the client would leave open whether Prisma had
   * checked something on the way. What comes back here can only be PostgreSQL.
   */
  function rawInsert(
    tenantId: string,
    formId: string,
    userId: string,
    cappedGroupId: string | null,
  ): Promise<number> {
    return prisma.$executeRawUnsafe(
      `INSERT INTO "form_permission"
         ("id", "tenant_id", "form_id", "user_id", "access_revoked",
          "capped_group_id", "created_at", "updated_at")
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, true,
               $4::uuid, now(), now())`,
      tenantId,
      formId,
      userId,
      cappedGroupId,
    );
  }

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });
    prisma = testApp.prisma;

    alpha = await createTenant(prisma, 'ALPHA');
    beta = await createTenant(prisma, 'BETA');

    alphaViewerGroup = await createGroup(prisma, alpha, {
      name: 'alpha-viewer',
      rank: 20,
    });
    betaViewerGroup = await createGroup(prisma, beta, {
      name: 'beta-viewer',
      rank: 20,
    });

    alphaUser = await createUser(prisma, {
      email: 'alpha@example.org',
      password: 'korrektes-pferd-batterie',
      tenants: [alpha],
    });
    betaUser = await createUser(prisma, {
      email: 'beta@example.org',
      password: 'korrektes-pferd-batterie',
      tenants: [beta],
    });
    beideUser = await createUser(prisma, {
      email: 'beide@example.org',
      password: 'korrektes-pferd-batterie',
      tenants: [alpha, beta],
    });

    const alphaForm = await prisma.form.create({
      data: {
        tenantId: alpha.id,
        title: 'Anmeldung ALPHA',
        draftSchema: { pages: [] },
        publicSlug: 'slug-alpha-admin-scope',
      },
    });
    alphaFormId = alphaForm.id;

    const betaForm = await prisma.form.create({
      data: {
        tenantId: beta.id,
        title: 'Anmeldung BETA',
        draftSchema: { pages: [] },
        publicSlug: 'slug-beta-admin-scope',
      },
    });
    betaFormId = betaForm.id;
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await testApp?.close();
    await database?.release();
  });

  /**
   * The composite foreign keys of `form_permission` — the floor, proven with
   * the application removed from the picture.
   */
  describe('the database floor under a restriction (the evidence)', () => {
    it('refuses a restriction on a form of another organisation', async () => {
      await expect(
        rawInsert(alpha.id, betaFormId, alphaUser.id, null),
      ).rejects.toThrow(/form_permission_form_id_tenant_id_fkey/);

      // Nothing was written — „it threw" and „it stored nothing" are two
      // statements, and only the second one is the guarantee.
      expect(
        await prisma.formPermission.count({ where: { formId: betaFormId } }),
      ).toBe(0);
    });

    /**
     * The other direction of the same mistake: the row names its *own* organisation's
     * form but caps the person to a group of the other one. Without the second
     * composite key this would insert cleanly and hand a person the permissions
     * of a group in an organisation they are not a member of.
     */
    it('refuses a cap naming a group of another organisation', async () => {
      await expect(
        rawInsert(alpha.id, alphaFormId, alphaUser.id, betaViewerGroup.id),
      ).rejects.toThrow(/form_permission_capped_group_id_tenant_id_fkey/);
      expect(
        await prisma.formPermission.count({ where: { formId: alphaFormId } }),
      ).toBe(0);
    });

    /**
     * The control. Without it the two cases above would also pass against a
     * table that refuses every insert — for instance because the statement is
     * malformed rather than because the keys hold.
     */
    it('accepts the same row when both halves belong to one organisation', async () => {
      expect(
        await rawInsert(
          alpha.id,
          alphaFormId,
          alphaUser.id,
          alphaViewerGroup.id,
        ),
      ).toBe(1);
      await prisma.formPermission.deleteMany({
        where: { formId: alphaFormId },
      });
    });

    /**
     * „Keine Deckelung" needs no group to exist: the group key is `MATCH
     * SIMPLE`, so a null column imposes nothing. Worth a case of its own,
     * because a key written `MATCH FULL` would make the ordinary „Zugriff
     * gesperrt" row unstorable and only be noticed by whoever built the editor.
     */
    it('stores a revocation without a cap', async () => {
      expect(await rawInsert(alpha.id, alphaFormId, alphaUser.id, null)).toBe(
        1,
      );
      await prisma.formPermission.deleteMany({
        where: { formId: alphaFormId },
      });
    });
  });

  describe('ScopedFormPermissionDelegate', () => {
    it('does not read a restriction of another organisation', async () => {
      await betaScope().formPermissions.set(betaFormId, betaUser.id, {
        accessRevoked: true,
        cappedGroupId: null,
      });

      expect(
        await alphaScope().formPermissions.findFor(betaFormId, betaUser.id),
      ).toBe(null);
      expect(
        await alphaScope().formPermissions.findManyOfForm(betaFormId),
      ).toStrictEqual([]);
      expect(
        await alphaScope().formPermissions.findManyOfUser(betaUser.id),
      ).toStrictEqual([]);

      // The counter-check: the row does exist, so the empty answers above are
      // about the binding rather than about an empty table.
      expect(
        await betaScope().formPermissions.findManyOfForm(betaFormId),
      ).toHaveLength(1);
    });

    /**
     * Writing through the delegate under the wrong Organisation is not „returns false",
     * it is a foreign-key error: the create half carries this scope's tenant,
     * and `(form_id, tenant_id)` then has nowhere to point.
     */
    it('cannot write a restriction onto a foreign form', async () => {
      await expect(
        alphaScope().formPermissions.set(betaFormId, alphaUser.id, {
          accessRevoked: true,
          cappedGroupId: null,
        }),
      ).rejects.toThrow();
      expect(
        await betaScope().formPermissions.findManyOfForm(betaFormId),
      ).toHaveLength(1);
    });

    it('neither removes nor overwrites a foreign restriction', async () => {
      expect(
        await alphaScope().formPermissions.remove(betaFormId, betaUser.id),
      ).toBe(false);
      const stored = await betaScope().formPermissions.findFor(
        betaFormId,
        betaUser.id,
      );
      expect(stored?.accessRevoked).toBe(true);
    });

    /** Store, change, lift — and „lift" is the absence of a row, not a flag. */
    it('stores, replaces and lifts a restriction of its own Organisation', async () => {
      const scope = alphaScope();
      await scope.formPermissions.set(alphaFormId, alphaUser.id, {
        accessRevoked: false,
        cappedGroupId: alphaViewerGroup.id,
      });
      expect(
        (await scope.formPermissions.findFor(alphaFormId, alphaUser.id))
          ?.cappedGroupId,
      ).toBe(alphaViewerGroup.id);

      await scope.formPermissions.set(alphaFormId, alphaUser.id, {
        accessRevoked: true,
        cappedGroupId: null,
      });
      const replaced = await scope.formPermissions.findFor(
        alphaFormId,
        alphaUser.id,
      );
      expect(replaced?.accessRevoked).toBe(true);
      expect(replaced?.cappedGroupId).toBe(null);
      // One row, not two: the second `set` replaced rather than appended.
      expect(
        await scope.formPermissions.findManyOfForm(alphaFormId),
      ).toHaveLength(1);

      expect(
        await scope.formPermissions.remove(alphaFormId, alphaUser.id),
      ).toBe(true);
      expect(
        await scope.formPermissions.findFor(alphaFormId, alphaUser.id),
      ).toBe(null);
    });

    /**
     * The shape the requirement's first reproduction asks for: the restriction is
     * part of the **query**, not a filter after the load. A form the person is
     * locked out of never leaves PostgreSQL, so a test searching the payload of
     * the list route has nothing to find.
     */
    it('subtracts a locked form inside the form query', async () => {
      const scope = alphaScope();
      await scope.formPermissions.set(alphaFormId, alphaUser.id, {
        accessRevoked: true,
        cappedGroupId: null,
      });

      const visible = await scope.forms.findManyWithCounts({
        where: {
          permissions: { none: { userId: alphaUser.id, accessRevoked: true } },
        },
      });
      expect(visible.map((form) => form.id)).not.toContain(alphaFormId);

      // The control: somebody without a restriction still sees it.
      const forBeide = await scope.forms.findManyWithCounts({
        where: {
          permissions: { none: { userId: beideUser.id, accessRevoked: true } },
        },
      });
      expect(forBeide.map((form) => form.id)).toContain(alphaFormId);

      await scope.formPermissions.remove(alphaFormId, alphaUser.id);
    });
  });

  describe('ScopedMembershipDelegate', () => {
    it('lists only the people of its own Organisation', async () => {
      const members = await alphaScope().memberships.findMany();
      const ids = members.map((member) => member.userId);
      expect(ids).toContain(alphaUser.id);
      expect(ids).toContain(beideUser.id);
      expect(ids).not.toContain(betaUser.id);

      // Nothing of the other organisation travels along in a joined column either.
      const serialised = JSON.stringify(members);
      for (const trace of [beta.id, betaUser.id, betaViewerGroup.id]) {
        expect(serialised).not.toContain(trace);
      }
    });

    /**
     * A member of another organisation and a person who does not exist have to come
     * back the **same** way — the caller answers 404 to both, byte-identically
     * (the evidence; a lesson learned before was that only the status code
     * differed and the whole suite stayed green).
     */
    it('answers null for a foreign member exactly as for an unknown one', async () => {
      expect(await alphaScope().memberships.findByUserId(betaUser.id)).toBe(
        null,
      );
      expect(await alphaScope().memberships.findByUserId(ABSENT_UUID)).toBe(
        null,
      );
    });

    /**
     * The list is exhaustive on purpose: a `select` that grows is a decision,
     * and this is where it has to be made again. `oidcIssuer` joined it for
     * the „OIDC"/„Lokal" badge of an unclaimed invitation (review finding) — `passwordHash` still is not on it and must not be.
     */
    it('carries no password hash out of the database', async () => {
      const members = await alphaScope().memberships.findMany();
      const person = members[0]?.user;
      expect(person).toBeDefined();
      expect(Object.keys(person ?? {}).sort()).toStrictEqual([
        'email',
        'id',
        'name',
        'oidcIssuer',
        'oidcSubject',
      ]);
    });

    it('neither moves nor removes a member of another organisation', async () => {
      const scope = alphaScope();
      expect(
        await scope.memberships.updateGroup(betaUser.id, alphaViewerGroup.id),
      ).toBe('unknown');
      expect(await scope.memberships.remove(betaUser.id)).toBe('unknown');

      const stored = await prisma.membership.findUniqueOrThrow({
        where: { tenantId_userId: { tenantId: beta.id, userId: betaUser.id } },
      });
      expect(stored.groupId).toBe(beta.adminGroupId);
    });

    /**
     * **Removing a membership is not deleting a person** . The person keeps their account and their access to the other
     * Organisation; only this organisation's row goes.
     */
    it('leaves the user row and the other organisation untouched', async () => {
      expect(await alphaScope().memberships.remove(beideUser.id)).toBe('ok');

      expect(
        await prisma.user.findUnique({ where: { id: beideUser.id } }),
      ).not.toBe(null);
      expect(await betaScope().memberships.findByUserId(beideUser.id)).not.toBe(
        null,
      );
      expect(await alphaScope().memberships.findByUserId(beideUser.id)).toBe(
        null,
      );

      // Put them back, so the order of the cases in this file does not matter.
      await alphaScope().memberships.create(beideUser.id, alphaViewerGroup.id);
    });

    it('counts the members of each group of its own Organisation', async () => {
      const counts = await alphaScope().memberships.memberCounts();
      const admins = counts.find((row) => row.groupId === alpha.adminGroupId);
      expect(admins?.members).toBe(1);
      expect(counts.map((row) => row.groupId)).not.toContain(beta.adminGroupId);
    });

    /**
     * **`createLocal` mints a `user` row and its `membership` in one
     * transaction** (coordinator review) — a group of another organisation
     * fails the membership half on the composite foreign key
     * `(group_id, tenant_id)`, and the user half must not survive that
     * failure: a `user` row carries no `tenant_id` (`schema.prisma`), so a
     * `user` left behind here would be an account no admin route could ever
     * find again.
     */
    it('creates the account and the membership atomically — a foreign group leaves no orphan', async () => {
      const email = 'atomic-create@example.org';

      await expect(
        alphaScope().memberships.createLocal(betaViewerGroup.id, {
          email,
          name: 'Atomarer Test',
          invitation: testAccountInvitation(),
        }),
      ).rejects.toThrow();

      expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
    });

    it('creates the account and the membership together, on the happy path', async () => {
      const email = 'atomic-create-ok@example.org';

      const membership = await alphaScope().memberships.createLocal(
        alphaViewerGroup.id,
        {
          email,
          name: 'Atomarer Test Zwei',
          invitation: testAccountInvitation(),
        },
      );

      expect(membership.tenantId).toBe(alpha.id);
      expect(membership.groupId).toBe(alphaViewerGroup.id);
      const user = await prisma.user.findUniqueOrThrow({
        where: { id: membership.userId },
      });
      expect(user.email).toBe(email);
    });
  });

  /**
   * The last administrator of an organisation — the guard that
   * has to be evaluated *inside* the write, in its own Organisation.
   */
  describe('the last administrator (the evidence)', () => {
    let gamma: TenantFixture;
    let gammaAdmin: { id: string };
    let gammaViewerGroup: { id: string };

    beforeAll(async () => {
      gamma = await createTenant(prisma, 'GAMMA');
      gammaViewerGroup = await createGroup(prisma, gamma, {
        name: 'gamma-viewer',
        rank: 20,
      });
      gammaAdmin = await createUser(prisma, {
        email: 'gamma@example.org',
        password: 'korrektes-pferd-batterie',
        tenants: [gamma],
      });
    }, SETUP_TIMEOUT_MS);

    function gammaScope(): TenantScope {
      return new TenantScope(prisma, gamma.id);
    }

    it('refuses to remove the only member of the guarded group', async () => {
      expect(await gammaScope().memberships.remove(gammaAdmin.id)).toBe(
        'would-empty-group',
      );

      // The row is unchanged — checked with a raw read, not by looking at the
      // answer that was just refused.
      const stored = await prisma.membership.findUniqueOrThrow({
        where: {
          tenantId_userId: { tenantId: gamma.id, userId: gammaAdmin.id },
        },
      });
      expect(stored.groupId).toBe(gamma.adminGroupId);
    });

    it('refuses to demote them either', async () => {
      expect(
        await gammaScope().memberships.updateGroup(
          gammaAdmin.id,
          gammaViewerGroup.id,
        ),
      ).toBe('would-empty-group');
      const stored = await prisma.membership.findUniqueOrThrow({
        where: {
          tenantId_userId: { tenantId: gamma.id, userId: gammaAdmin.id },
        },
      });
      expect(stored.groupId).toBe(gamma.adminGroupId);
    });

    /**
     * The control, and it is what makes the two above mean something: with a
     * second administrator the very same call goes through. Without it, „refuses
     * everything" would pass just as well.
     */
    it('allows it once somebody else holds the group', async () => {
      const second = await createUser(prisma, {
        email: 'gamma-zwei@example.org',
        password: 'korrektes-pferd-batterie',
        tenants: [gamma],
      });

      expect(
        await gammaScope().memberships.updateGroup(
          gammaAdmin.id,
          gammaViewerGroup.id,
        ),
      ).toBe('ok');
      expect(await gammaScope().memberships.remove(second.id)).toBe(
        'would-empty-group',
      );
    });

    /** A person who is not in this organisation is „unknown", never „last". */
    it('tells an unknown member apart from a last one', async () => {
      expect(await gammaScope().memberships.remove(ABSENT_UUID)).toBe(
        'unknown',
      );
    });

    /**
     * **Both write paths carry the safeguard, structurally** (coordinator
     * review): `remove` and `updateGroup` take no option to enable the
     * last-administrator check any more — there is nothing left to forget it
     * on. This test is the one that would have caught the earlier shape,
     * where the guard was an opt-in `keepAtLeastOneIn` a caller could omit on
     * either path without anything failing.
     *
     * A fresh Organisation is used so this test is not order-dependent on the
     * `gammaAdmin` fixture above, whose group by now varies test to test.
     */
    it('protects the last administrator on both `remove` and `updateGroup`, with no option to omit it', async () => {
      const delta = await createTenant(prisma, 'DELTA');
      const deltaViewer = await createGroup(prisma, delta, {
        name: 'delta-viewer',
        rank: 20,
      });
      const soleAdmin = await createUser(prisma, {
        email: 'delta-solo@example.org',
        password: 'korrektes-pferd-batterie',
        tenants: [delta],
      });
      const deltaScope = new TenantScope(prisma, delta.id);

      // `updateGroup` — called with the same two arguments a caller of the
      // old, optional shape would still compile with, and it still refuses.
      expect(
        await deltaScope.memberships.updateGroup(soleAdmin.id, deltaViewer.id),
      ).toBe('would-empty-group');

      // `remove` — same story, same fixture, the other path.
      expect(await deltaScope.memberships.remove(soleAdmin.id)).toBe(
        'would-empty-group',
      );

      const stored = await prisma.membership.findUniqueOrThrow({
        where: {
          tenantId_userId: { tenantId: delta.id, userId: soleAdmin.id },
        },
      });
      expect(stored.groupId).toBe(delta.adminGroupId);
    });
  });

  describe('ScopedGroupDelegate writes', () => {
    const WRITE = {
      name: 'alpha-redaktion',
      color: '#7c0800',
      rank: 60,
      canBuild: true,
      canViewResponses: true,
      canExport: false,
      canManageSettings: false,
      canManageFormSettings: false,
      canManageUsers: false,
    };

    it('creates in its own Organisation and never as a system group', async () => {
      const created = await alphaScope().groups.create(WRITE);
      expect(created.tenantId).toBe(alpha.id);
      expect(created.isSystem).toBe(false);

      // The counter-check: BETA's scope must not see what ALPHA just wrote.
      expect(await betaScope().groups.findById(created.id)).toBe(null);
      await prisma.group.delete({ where: { id: created.id } });
    });

    /**
     * The tenant binding of `removeIfEmpty` itself (a review finding
     * follow-up) — called directly on the delegate, not through
     * `TenantGroupsService.remove`, whose own `requireGroup` already answers
     * 404 for a group of another organisation before the delegate is ever reached.
     * That earlier layer is exactly what let this case stay green while
     * proving nothing about `removeIfEmpty`'s own `where`: dropping
     * `tenantId` from the `deleteMany` inside it turns this test red on its
     * own, because BETA's group then matches `{ id, isSystem: false }` from
     * ALPHA's scope and is actually deleted.
     */
    it('neither updates nor removes a group of another organisation', async () => {
      const scope = alphaScope();
      expect(await scope.groups.update(betaViewerGroup.id, WRITE)).toBe(false);
      expect(await scope.groups.removeIfEmpty(betaViewerGroup.id)).toEqual({
        kind: 'not-found',
      });

      const stored = await prisma.group.findUniqueOrThrow({
        where: { id: betaViewerGroup.id },
      });
      expect(stored.name).toBe('beta-viewer');
      expect(stored.canManageUsers).toBe(false);
    });

    /**
     * The `admin` group is not editable and not deletable, and that is in the
     * `where` rather than in a check before it — so it
     * holds for every caller of this delegate, present and future.
     *
     * Alpha's admin group never loses its one administrator in this fixture
     * (`alphaUser`, added by `createUser`'s default membership), so
     * `removeIfEmpty` answers `has-members` before it ever reaches the
     * delete's own `isSystem: false` — the row is left untouched either way,
     * which the read below still checks directly rather than trusting the
     * outcome alone.
     */
    it('cannot touch the system group of its own Organisation', async () => {
      const scope = alphaScope();
      expect(
        await scope.groups.update(alpha.adminGroupId, {
          ...WRITE,
          name: 'übernommen',
          canManageUsers: false,
        }),
      ).toBe(false);
      expect(await scope.groups.removeIfEmpty(alpha.adminGroupId)).toEqual({
        kind: 'has-members',
        memberCount: 1,
      });

      const stored = await prisma.group.findUniqueOrThrow({
        where: { id: alpha.adminGroupId },
      });
      expect(stored.name).toBe('admin');
      expect(stored.canManageUsers).toBe(true);
      expect(stored.isSystem).toBe(true);
    });

    /**
     * A group that still has members is refused **without** an attempted
     * delete — the member count and the delete decided in one transaction
     * (`ScopedGroupDelegate.removeIfEmpty`'s own
     * JSDoc). This case used to reach PostgreSQL's `NO ACTION` foreign key
     * instead, through the now-deleted bare `remove(id)`, which did no count
     * of its own (a review finding follow-up); that floor is still there
     * for the narrower race window `removeIfEmpty`'s own JSDoc describes, but
     * forcing it open needs an actual race, not a single `it()`.
     */
    it('reports a non-system group still has a member, without attempting the delete', async () => {
      // Two by this point: `beideUser` (re-added after the removal test
      // above) and the account `createLocal`'s own happy-path test minted
      // straight into this group — the exact count is incidental to this
      // test, only "not zero, and no delete attempted" is.
      expect(
        await alphaScope().groups.removeIfEmpty(alphaViewerGroup.id),
      ).toEqual({ kind: 'has-members', memberCount: 2 });
      expect(
        await prisma.group.findUnique({ where: { id: alphaViewerGroup.id } }),
      ).not.toBe(null);
    });
  });
});
