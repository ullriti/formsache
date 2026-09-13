import { describe, expect, it } from 'vitest';
import type { Permissions } from '@formsache/shared';
import type { Group } from '@prisma/client';

import {
  FormRestriction,
  capPermissions,
  groupPermissions,
  isRestrictable,
} from './form-restriction';

/**
 * The pure half of the fourth link.
 *
 * What is checked here is what no integration test can show convincingly: that
 * a cap **cannot** raise anything, for *any* pair of permission sets rather than
 * for the two a fixture happens to build. The behaviour against real routes and
 * a real database is in `test/tenancy/form-permission.spec.ts`.
 */

const NONE: Permissions = {
  canBuild: false,
  canViewResponses: false,
  canExport: false,
  canManageSettings: false,
  canManageFormSettings: false,
  canManageUsers: false,
};

const ALL: Permissions = {
  canBuild: true,
  canViewResponses: true,
  canExport: true,
  canManageSettings: true,
  canManageFormSettings: true,
  canManageUsers: true,
};

const PERMISSION_NAMES = Object.keys(ALL) as (keyof Permissions)[];

/** Every one of the 2^n permission sets — the whole space, not a sample. */
function everySet(): Permissions[] {
  const sets: Permissions[] = [];
  for (let mask = 0; mask < 1 << PERMISSION_NAMES.length; mask += 1) {
    const set = { ...NONE };
    PERMISSION_NAMES.forEach((name, index) => {
      set[name] = (mask & (1 << index)) !== 0;
    });
    sets.push(set);
  }
  return sets;
}

/** A `group` row with only the columns these functions read. */
function group(overrides: Partial<Group> = {}): Group {
  return {
    id: '019fd000-0000-7000-8000-0000000000c1',
    tenantId: '019fd000-0000-7000-8000-0000000000a1',
    name: 'viewer',
    color: '#5b6b52',
    rank: 20,
    canBuild: false,
    canViewResponses: true,
    canExport: false,
    canManageSettings: false,
    canManageFormSettings: false,
    canManageUsers: false,
    isSystem: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

describe('capPermissions (the evidence, structural)', () => {
  /**
   * The load-bearing case, and it is exhaustive on purpose: every set against
   * every set — 2^n × 2^n pairs over {@link PERMISSION_NAMES}, which is derived
   * from the type rather than written out, so a new permission widens this
   * proof instead of slipping past it (it did, for `canManageFormSettings`).
   * The claim is „no configuration of groups raises anything", not „the two
   * groups in this fixture do not".
   *
   * Replace the intersection with the cap itself — the obvious „set the role to
   * the capped one" implementation — and this goes red for every pair where the
   * cap holds a permission the person does not.
   */
  it('never grants a permission the person does not already hold', () => {
    for (const held of everySet()) {
      for (const cap of everySet()) {
        const effective = capPermissions(held, cap);
        for (const name of PERMISSION_NAMES) {
          if (effective[name]) {
            expect(held[name]).toBe(true);
            expect(cap[name]).toBe(true);
          }
        }
      }
    }
  });

  it('leaves an unrestricted role untouched when the cap holds everything', () => {
    expect(capPermissions(ALL, ALL)).toStrictEqual(ALL);
  });

  it('takes everything away when the cap holds nothing', () => {
    expect(capPermissions(ALL, NONE)).toStrictEqual(NONE);
  });

  /**
   * The case rank arithmetic alone would get wrong: a *lower-ranked* group may
   * well carry a permission the person's own group lacks, because groups are
   * freely configurable. The write route refuses such a cap by rank;
   * the guarantee is that even if it did not, nothing is handed out.
   */
  it('does not hand out export just because the capped group has it', () => {
    const viewerWithoutExport: Permissions = {
      ...NONE,
      canViewResponses: true,
    };
    const oddCap: Permissions = { ...NONE, canExport: true };
    expect(capPermissions(viewerWithoutExport, oddCap)).toStrictEqual(NONE);
  });
});

describe('isRestrictable (the evidence)', () => {
  it('refuses to restrict the system group', () => {
    expect(isRestrictable(group({ isSystem: true }))).toBe(false);
  });

  it('allows every other group', () => {
    expect(isRestrictable(group({ isSystem: false }))).toBe(true);
  });
});

describe('groupPermissions', () => {
  it('reports exactly the five stored flags', () => {
    expect(groupPermissions(group({ canExport: true }))).toStrictEqual({
      canBuild: false,
      canViewResponses: true,
      canExport: true,
      canManageSettings: false,
      canManageFormSettings: false,
      canManageUsers: false,
    });
  });
});

describe('FormRestriction.formFilter (Nachstellung 1)', () => {
  const USER = '019fd000-0000-7000-8000-0000000000b1';

  /** The two arguments this block does not care about — see the block below. */
  const restriction = (restrictable: boolean): FormRestriction =>
    new FormRestriction(USER, restrictable, ALL, undefined);

  /**
   * The fragment is a **relation filter**, so it is evaluated by PostgreSQL —
   * a locked form is never read, rather than read and then dropped. Asserted on
   * the shape because that is the difference an integration test can only show
   * indirectly: `{ permissions: { none: … } }` is a `where`, a `formIds` array
   * would have been a filter afterwards wearing a `where`'s name.
   */
  it('subtracts the forms whose access is revoked', () => {
    expect(restriction(true).formFilter()).toStrictEqual({
      permissions: { none: { userId: USER, accessRevoked: true } },
    });
  });

  /** An administrator's restriction is ignored, in the shape a query wants. */
  it('narrows nothing for somebody who cannot be restricted', () => {
    expect(restriction(false).formFilter()).toStrictEqual({});
  });

  // A cap is deliberately **not** in this fragment: it answers 403 and leaves
  // the form in the list (see „removes a permission the capped group does not
  // hold" in `test/tenancy/form-permission.spec.ts`). There is nothing to
  // assert here about it — the shape above is the whole fragment.
});

/**
 * **The one evaluation of the fourth link** (review finding).
 *
 * It is unit-tested here rather than only through routes because the two
 * callers — `FormRestrictionGuard` and `MailLogService` — must reach the *same*
 * verdict, and „both routes answered 404" is compatible with two
 * implementations that agree today. What is asserted is the verdict itself.
 */
describe('FormRestriction.verdictFor (both halves)', () => {
  const USER = '019fd000-0000-7000-8000-0000000000b1';
  const CAP_GROUP = '019fd000-0000-7000-8000-0000000000c1';

  /** Reads answers and manages settings — what the mail log needs. */
  const READS_ANSWERS: Permissions = {
    ...NONE,
    canViewResponses: true,
    canManageSettings: true,
    canManageFormSettings: true,
  };

  /** The pair `GET /api/mail-log` and its two single-row routes require. */
  const REQUIRES_BOTH = {
    mode: 'all',
    permissions: ['canManageSettings', 'canViewResponses'],
  } as const;

  const resolve = (row: Group | null) => (): Promise<Group | null> =>
    Promise.resolve(row);

  it('lets an unrestricted request through', async () => {
    const restriction = new FormRestriction(
      USER,
      true,
      READS_ANSWERS,
      REQUIRES_BOTH,
    );
    await expect(restriction.verdictFor(null, resolve(null))).resolves.toBe(
      'open',
    );
  });

  it('reports a revoked form as revoked', async () => {
    const restriction = new FormRestriction(
      USER,
      true,
      READS_ANSWERS,
      REQUIRES_BOTH,
    );
    await expect(
      restriction.verdictFor(
        { accessRevoked: true, cappedGroupId: null },
        resolve(null),
      ),
    ).resolves.toBe('revoked');
  });

  /**
   * **The half the mail log had missing.** The person holds
   * `can_view_responses` in their own group — so the *third* link lets them
   * through and proves nothing — and is capped on this one form to a group
   * that does not. Only the fourth link can refuse this.
   */
  it('reports a cap that takes a required permission away', async () => {
    const restriction = new FormRestriction(
      USER,
      true,
      READS_ANSWERS,
      REQUIRES_BOTH,
    );
    const cap = group({
      id: CAP_GROUP,
      canViewResponses: false,
      canManageSettings: true,
      canManageFormSettings: true,
    });

    await expect(
      restriction.verdictFor(
        { accessRevoked: false, cappedGroupId: CAP_GROUP },
        resolve(cap),
      ),
    ).resolves.toBe('capped-out');
  });

  it('lets a cap through that keeps every required permission', async () => {
    const restriction = new FormRestriction(
      USER,
      true,
      READS_ANSWERS,
      REQUIRES_BOTH,
    );
    const cap = group({
      id: CAP_GROUP,
      canViewResponses: true,
      canManageSettings: true,
      canManageFormSettings: true,
      // …and takes something away that this route does not ask for.
      canExport: false,
    });

    await expect(
      restriction.verdictFor(
        { accessRevoked: false, cappedGroupId: CAP_GROUP },
        resolve(cap),
      ),
    ).resolves.toBe('open');
  });

  /** An unresolvable cap grants nothing — never „no group, no cap". */
  it('fails closed when the capped group cannot be resolved', async () => {
    const restriction = new FormRestriction(
      USER,
      true,
      READS_ANSWERS,
      REQUIRES_BOTH,
    );
    await expect(
      restriction.verdictFor(
        { accessRevoked: false, cappedGroupId: CAP_GROUP },
        resolve(null),
      ),
    ).resolves.toBe('capped-out');
  });

  /** An administrator's row is not evaluated at all. */
  it('ignores every restriction of somebody unrestrictable', async () => {
    const restriction = new FormRestriction(
      USER,
      false,
      READS_ANSWERS,
      REQUIRES_BOTH,
    );
    await expect(
      restriction.verdictFor(
        { accessRevoked: true, cappedGroupId: CAP_GROUP },
        resolve(group({ id: CAP_GROUP, canViewResponses: false })),
      ),
    ).resolves.toBe('open');
  });

  /** Both halves, collected for a list that cannot be narrowed by a guard. */
  it('collects the hidden forms of a person for a list query', async () => {
    const restriction = new FormRestriction(
      USER,
      true,
      READS_ANSWERS,
      REQUIRES_BOTH,
    );
    const blind = group({ id: CAP_GROUP, canViewResponses: false });

    await expect(
      restriction.hiddenFormIds(
        [
          { formId: 'form-revoked', accessRevoked: true, cappedGroupId: null },
          {
            formId: 'form-capped',
            accessRevoked: false,
            cappedGroupId: CAP_GROUP,
          },
          { formId: 'form-open', accessRevoked: false, cappedGroupId: null },
        ],
        resolve(blind),
      ),
    ).resolves.toStrictEqual(['form-revoked', 'form-capped']);
  });
});

/**
 * The same calculation, handed out as a value (the requirement).
 *
 * Checked here for the reason `capPermissions` is: what the wire says about a
 * form is a *display* decision, and the whole point of routing it through this
 * class is that it can only ever be the guard's own reading, narrowed the same
 * way. A second implementation would pass an integration test on the one
 * fixture it was written against and disagree everywhere else.
 */
describe('FormRestriction.effectivePermissionsFor', () => {
  const USER = '019fd000-0000-7000-8000-0000000000b1';
  const CAP_GROUP = '019fd000-0000-7000-8000-0000000000c1';
  /** Builds and reads answers — the role the cases below narrow. */
  const BUILDS: Permissions = {
    ...NONE,
    canBuild: true,
    canViewResponses: true,
    canManageUsers: true,
  };
  /** No requirement: this value is asked for by routes, never by one route. */
  const restriction = (restrictable = true) =>
    new FormRestriction(USER, restrictable, BUILDS, undefined);
  const resolve = (row: Group | null) => (): Promise<Group | null> =>
    Promise.resolve(row);

  it('reports the membership’s own rights where no row stands', async () => {
    await expect(
      restriction().effectivePermissionsFor(null, resolve(null)),
    ).resolves.toStrictEqual(BUILDS);
  });

  it('reports the intersection with the capped group, never the group itself', async () => {
    // The capped group holds `canExport`, which this person does **not** —
    // a replacement would hand it out, an intersection cannot.
    const cap = group({
      id: CAP_GROUP,
      canBuild: false,
      canViewResponses: true,
      canExport: true,
      canManageUsers: true,
    });

    await expect(
      restriction().effectivePermissionsFor(
        { accessRevoked: false, cappedGroupId: CAP_GROUP },
        resolve(cap),
      ),
    ).resolves.toStrictEqual({
      ...NONE,
      canViewResponses: true,
      canManageUsers: true,
    });
  });

  it('reports nothing at all for a revoked form', async () => {
    await expect(
      restriction().effectivePermissionsFor(
        { accessRevoked: true, cappedGroupId: CAP_GROUP },
        resolve(group({ id: CAP_GROUP, canBuild: true })),
      ),
    ).resolves.toStrictEqual(NONE);
  });

  it('fails closed when the capped group cannot be resolved', async () => {
    await expect(
      restriction().effectivePermissionsFor(
        { accessRevoked: false, cappedGroupId: CAP_GROUP },
        resolve(null),
      ),
    ).resolves.toStrictEqual(NONE);
  });

  it('ignores every row of somebody unrestrictable', async () => {
    await expect(
      restriction(false).effectivePermissionsFor(
        { accessRevoked: true, cappedGroupId: CAP_GROUP },
        resolve(group({ id: CAP_GROUP })),
      ),
    ).resolves.toStrictEqual(BUILDS);
  });

  /**
   * The list's shape: one entry per row, **nothing** for the forms without one
   * — the caller holds the list of forms, this class holds the rows.
   */
  it('answers per form and reads each capped group once', async () => {
    let reads = 0;
    const cap = group({
      id: CAP_GROUP,
      canBuild: false,
      canViewResponses: true,
    });

    const byForm = await restriction().effectivePermissionsByForm(
      [
        {
          formId: 'form-a',
          accessRevoked: false,
          cappedGroupId: CAP_GROUP,
        },
        {
          formId: 'form-b',
          accessRevoked: false,
          cappedGroupId: CAP_GROUP,
        },
      ],
      () => {
        reads += 1;
        return Promise.resolve(cap);
      },
    );

    expect(byForm.get('form-a')?.canBuild).toBe(false);
    expect(byForm.get('form-b')?.canBuild).toBe(false);
    // Not in the map at all — „kein Eintrag" is what the caller reads as „die
    // Rechte der Mitgliedschaft", and a fabricated entry would hide a form the
    // caller never asked about.
    expect(byForm.has('form-open')).toBe(false);
    expect(reads).toBe(1);
  });
});
