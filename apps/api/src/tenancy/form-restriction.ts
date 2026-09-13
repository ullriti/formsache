import {
  ForbiddenException,
  createParamDecorator,
  type ExecutionContext,
} from '@nestjs/common';
import type { Permissions } from '@formsache/shared';
import type { Group, Prisma } from '@prisma/client';

import type { TenantScopedRequest } from './request-context';
import {
  holdsRequirement,
  type PermissionRequirement,
} from './require-permission.decorator';
import { NO_TENANT_SCOPE_MESSAGE } from './tenant-scope.guard';

/**
 * What a per-form restriction *is* — the fourth link of the chain
 * *tenant scope → group permissions → **form restriction***.
 *
 * Everything in this file is a pure function or a value object, deliberately:
 * the two places that evaluate a restriction — the guard, for one form, and the
 * form list, for all of them — must decide the same way, and the surest way to
 * make them is to give them one implementation with no database in it. The
 * guard reads the row; this decides what it means.
 *
 * **The direction is fixed and that is the whole rule: a restriction can
 * only take away.** There is no function here that adds a permission, and
 * {@link capPermissions} is written as an intersection rather than a
 * replacement precisely so that no configuration of groups can turn a cap into
 * a promotion — not even one PostgreSQL would accept.
 */

/**
 * Whether somebody can be restricted on a single form at all.
 *
 * **Administrators cannot** (the rule: „gesperrt auf
 * *Sieht immer alles*"). The marker is the group's `isSystem` flag, which the
 * schema reserves for the one `admin` group an organisation is created with and which no
 * route can set (`ScopedGroupDelegate.create` pins it to `false`).
 *
 * It is asked **here, in the evaluation**, and not only where restrictions are
 * written. That is the second half of the requirement and it is not a belt-and-braces
 * check: a row can reach `form_permission` past every route — a migration, a
 * hand-edited database, a future service — and that promise („sieht
 * immer alles") must not depend on which way the row got there. A restriction on
 * an administrator is therefore not refused at read time, it is *ignored*.
 *
 * Superadmins get no special case, and that is deliberate rather than an
 * omission: a superadmin working *inside* an organisation does so through a membership
 * like anybody else, and their cross-tenant reach is a separate surface with
 * separate routes. One rule, read off the membership, is what
 * keeps the guard and the members list from disagreeing about the same person.
 */
export function isRestrictable(group: { readonly isSystem: boolean }): boolean {
  return !group.isSystem;
}

/**
 * The six flags of a group row.
 *
 * A local mapping rather than the one in `auth/session-user.ts`: that one is
 * private to the module that owns the wire representation of the signed-in
 * person, and the tenancy chain has no business widening its surface. Spelled
 * out field by field for the reason `GroupWrite` is spelled out — a mapped loop
 * would silently pick up a boolean column added to `group` for something else.
 */
export function groupPermissions(group: Group): Permissions {
  return {
    canBuild: group.canBuild,
    canViewResponses: group.canViewResponses,
    canExport: group.canExport,
    canManageSettings: group.canManageSettings,
    canManageFormSettings: group.canManageFormSettings,
    canManageUsers: group.canManageUsers,
  };
}

/**
 * What somebody may do on **this** form once a cap applies: the intersection of
 * what their Organisation role grants and what the capped role grants.
 *
 * **An intersection, not a replacement, and that is the structural half of
 * „eine Restriktion kann nie hochstufen"** . A
 * replacement would be a promotion whenever the capped group happens to hold a
 * permission the person's own group does not — and groups are freely
 * configurable, so „viewer" is only lower than „editor" by
 * convention, never by construction. The write route additionally refuses a cap
 * that is not *ranked* below the person's role, because an editor deserves a
 * readable refusal; but the guarantee is here, where no ranking is trusted.
 *
 * Written out per field rather than as a loop over `Object.keys`, so a further
 * permission is a compile error rather than a flag that quietly stays ungated.
 * That is not theory: `canManageFormSettings` (ADR-0021) was the sixth, and it
 * arrived here as a type error rather than as an ungated flag.
 */
export function capPermissions(
  held: Permissions,
  cap: Permissions,
): Permissions {
  return {
    canBuild: held.canBuild && cap.canBuild,
    canViewResponses: held.canViewResponses && cap.canViewResponses,
    canExport: held.canExport && cap.canExport,
    canManageSettings: held.canManageSettings && cap.canManageSettings,
    canManageFormSettings:
      held.canManageFormSettings && cap.canManageFormSettings,
    canManageUsers: held.canManageUsers && cap.canManageUsers,
  };
}

/** Nothing at all — what a cap naming a group that cannot be resolved grants. */
export const NO_PERMISSIONS: Permissions = {
  canBuild: false,
  canViewResponses: false,
  canExport: false,
  canManageSettings: false,
  canManageFormSettings: false,
  canManageUsers: false,
};

/**
 * What one stored `form_permission` row means for the request being made.
 *
 * Three answers rather than a boolean, because the two refusals are **not the
 * same refusal** and the difference is a decided one (see `FormRestrictionGuard`):
 * `revoked` is answered 404, byte-identical to an unknown form, and
 * `capped-out` 403 — the form is still there, this person simply may not do
 * *this* on it.
 */
export type RestrictionVerdict = 'open' | 'revoked' | 'capped-out';

/** The two columns of a `form_permission` row the evaluation reads. */
export interface StoredRestriction {
  readonly accessRevoked: boolean;
  readonly cappedGroupId: string | null;
}

/** …and which form it stands on, for the callers that weigh several at once. */
export interface StoredFormRestriction extends StoredRestriction {
  readonly formId: string;
}

/**
 * How a caller turns a `capped_group_id` into the group row it names — always
 * `scope.groups.findById`, passed in rather than imported so this file stays
 * free of database access (see the header of this file).
 */
export type GroupResolver = (groupId: string) => Promise<Group | null>;

/**
 * Where {@link FormRestriction.effectivePermissionsIn} reads its two rows from
 * — the `TenantScope` of the request, described **structurally**.
 *
 * Named by shape rather than imported, so this file keeps the rule its header
 * states: no database in here. A scope satisfies it by being what it already
 * is; nothing else in the application does, because nothing else has both
 * delegates.
 */
export interface RestrictionRowSource {
  readonly formPermissions: {
    findManyOfUser(userId: string): Promise<StoredFormRestriction[]>;
  };
  readonly groups: { findById(groupId: string): Promise<Group | null> };
}

/**
 * What a request carries about the person's per-form restrictions — put on the
 * request by `FormRestrictionGuard` and read by the handlers that need it.
 *
 * The object exists because of the requirement's **first reproduction**: „die
 * Restriktion nach dem Laden angewandt statt in der Query". A guard can refuse a
 * request, but it cannot narrow a list — so the list route has to express the
 * restriction itself, and the only honest place to express it is the `where` of
 * the statement PostgreSQL runs. What travels here is therefore not a decision
 * the service re-makes, it is a **query fragment** the service can only pass on:
 * `FormsService` receives it, spreads it into its `where`, and has nothing to
 * filter afterwards with even if somebody wanted to.
 */
export class FormRestriction {
  constructor(
    /** The person the request is made by — never a parameter of a route. */
    readonly userId: string,
    /** False for administrators — see {@link isRestrictable}. */
    readonly restrictable: boolean,
    /**
     * What the **third** link already granted: the permissions of this
     * person's membership in the active Organisation. Carried along so that a cap is
     * always intersected with the same set the guard intersected it with — a
     * service re-reading the membership would be the second calculation this
     * class exists to prevent.
     */
    private readonly held: Permissions,
    /**
     * What the route this request hit demands (`@RequirePermission` and
     * friends), read off the handler by the guard.
     *
     * It travels with the restriction because a cap is only meaningful
     * *against a requirement*: „auf Formular X auf `nur-lesen` gedeckelt" says
     * nothing until one asks „und diese Route will was?". A service that named
     * its own requirement here would be free to name a weaker one than its own
     * decorator does — and the weaker reading is the one nobody notices.
     */
    private readonly required: PermissionRequirement | undefined,
  ) {}

  /**
   * **The one evaluation of the fourth link** — what a stored row means for
   * this request (a review finding: the mail log closed only the
   * `access_revoked` half and let every cap through).
   *
   * Both callers ask *here*: the guard, for the form a route names, and
   * `MailLogService`, for the form that hangs off `mail_log.form_id` one read
   * further in. What differs between them is only what they do with the
   * answer, which is the point — a second implementation next to this one is
   * how „gesperrt" and „gedeckelt" end up meaning different things two routes
   * apart, and the reading that *grants* is the one that survives.
   *
   * The order follows the same rule: an administrator's row is
   * not read at all, a revocation outranks a cap, and a cap that
   * cannot be resolved grants nothing rather than lifting itself.
   */
  async verdictFor(
    stored: StoredRestriction | null,
    resolveGroup: GroupResolver,
  ): Promise<RestrictionVerdict> {
    if (!this.restrictable || stored === null) {
      return 'open';
    }
    if (stored.accessRevoked) {
      return 'revoked';
    }
    if (stored.cappedGroupId === null) {
      return 'open';
    }

    const required = this.required;
    if (required === undefined || required.permissions.length === 0) {
      // A route that asks for no permission has none to narrow. A cap lowers a
      // *role*; it is not a second way to close a door nobody guarded. Asked
      // *before* the group is resolved, so a route without a requirement still
      // costs no query — {@link effectivePermissionsFor} has no such shortcut
      // because it has no requirement to be short about.
      return 'open';
    }

    return holdsRequirement(
      await this.effectivePermissionsFor(stored, resolveGroup),
      required,
    )
      ? 'open'
      : 'capped-out';
  }

  /**
   * **What this person may actually do on one form** — the same calculation
   * {@link verdictFor} judges by, handed out as a value instead of a verdict
   * (the requirement).
   *
   * It exists because a *verdict* only answers the question one route asked,
   * and the interface has to make several display decisions about the same
   * form at once: which entries the form navigation lists, whether the
   * dashboard card offers „Bearbeiten". Those used to be taken from the
   * **Organisation-wide** flags of the membership, which is why somebody capped to a
   * role without `can_build` was still offered the door to the builder and got
   * a 403 from behind it.
   *
   * **One calculation, not two.** `verdictFor` now decides by asking this, so
   * the payload the dashboard renders and the guard that refuses the request
   * cannot drift apart — a second reading of „was darf diese Person hier?" is
   * exactly how the offered button and the answered 403 disagree again.
   *
   * The order is `verdictFor`'s, and it means the same things: an
   * administrator's row is not read (see {@link isRestrictable}), a revocation
   * grants nothing at all, and a cap that cannot be resolved grants nothing
   * rather than lifting itself.
   *
   * `revoked` answers {@link NO_PERMISSIONS} rather than throwing, because this
   * is not a gate: the form list never contains a revoked form ({@link
   * formFilter} keeps it in PostgreSQL), so the value is unreachable from the
   * routes that ask — and „nothing" is the only safe reading if a caller ever
   * does reach it.
   */
  async effectivePermissionsFor(
    stored: StoredRestriction | null,
    resolveGroup: GroupResolver,
  ): Promise<Permissions> {
    if (!this.restrictable || stored === null) {
      return this.held;
    }
    if (stored.accessRevoked) {
      return NO_PERMISSIONS;
    }
    if (stored.cappedGroupId === null) {
      return this.held;
    }

    const cap = await resolveGroup(stored.cappedGroupId);
    return cap === null
      ? // The composite key `(capped_group_id, tenant_id)` is `NO ACTION`, so
        // a group in use cannot be deleted and this is unreachable through
        // the application. If it happens anyway, *fail closed*: an
        // unresolvable cap grants nothing. The opposite reading — „no group,
        // no cap" — would turn a damaged row into a restriction that
        // silently lifted itself.
        NO_PERMISSIONS
      : capPermissions(this.held, groupPermissions(cap));
  }

  /**
   * {@link effectivePermissionsFor} for every form the caller carries a row on
   * — what the form **list** needs, which decides for thirty cards at once.
   *
   * Forms without a row are deliberately **absent** from the map rather than
   * present with {@link heldPermissions}: the caller holds the whole list and
   * this class does not, so inventing entries for ids it has never seen would
   * be guessing. `map.get(id) ?? restriction.heldPermissions` is the reading,
   * and it is the same one {@link effectivePermissionsFor} makes for
   * `stored === null`.
   *
   * The group resolver is memoised over the call: an organisation caps to a handful of
   * roles, so thirty forms are two or three `group` reads rather than thirty.
   */
  async effectivePermissionsByForm(
    stored: readonly StoredFormRestriction[],
    resolveGroup: GroupResolver,
  ): Promise<ReadonlyMap<string, Permissions>> {
    const resolve = memoiseGroups(resolveGroup);
    const byForm = new Map<string, Permissions>();
    for (const row of stored) {
      byForm.set(row.formId, await this.effectivePermissionsFor(row, resolve));
    }
    return byForm;
  }

  /**
   * {@link effectivePermissionsByForm} **against the request's own scope** —
   * the whole calculation, including „whose rows are read at all", in one call.
   *
   * It exists because the four lines around that method were copied verbatim
   * into a second caller the moment there was one (`FormsService.list` and
   * `TrashService.view`, a review finding), comment included — and the
   * copied part is the part that matters: the `restrictedUserId() === undefined`
   * arm is what keeps an administrator's stored rows from being read, and a
   * second spelling of it is a second place to get {@link isRestrictable}
   * wrong. Two lists whose cards disagree about what may be done with the same
   * form is exactly the drift {@link effectivePermissionsFor} was pulled
   * together to end.
   *
   * The source is a **structural** parameter and not `TenantScope`: this file
   * stays free of database access and of an import from the delegate that has
   * it (see the header). What it takes is „something that can look up this
   * person's rows and a group", which is what the scope of the request is.
   */
  async effectivePermissionsIn(
    source: RestrictionRowSource,
  ): Promise<ReadonlyMap<string, Permissions>> {
    const userId = this.restrictedUserId();
    return this.effectivePermissionsByForm(
      userId === undefined
        ? // An administrator's rows are not read at all — reading them and then
          // ignoring them is one `if` away from honouring them.
          []
        : await source.formPermissions.findManyOfUser(userId),
      (groupId) => source.groups.findById(groupId),
    );
  }

  /**
   * What applies to a form this person carries **no** `form_permission` row on
   * — their membership's permissions, unnarrowed.
   *
   * Exposed so the form list can spell the „no row" case without reaching for
   * `auth.user.memberships` a second time, which is the re-reading the
   * {@link held} field was introduced to prevent.
   */
  get heldPermissions(): Permissions {
    return this.held;
  }

  /**
   * Which forms this request may not see rows *of* — the same verdict as
   * above, asked for every restriction this person carries in the organisation.
   *
   * It exists for the mail log, whose lines name their form only
   * through `mail_log.form_id`: a guard cannot narrow a list, so the answer has
   * to become a **condition** (`ScopedMailLogDelegate.where`) rather than a
   * decision after the load — the requirement's first reproduction. The rows read
   * here are the person's own handful of `form_permission` rows, which are the
   * *input* to that condition; not one `mail_log` row a caller may not see
   * leaves the database.
   *
   * The form list needs nothing of this and deliberately keeps
   * {@link formFilter}: a cap does **not** hide a form (it answers 403, not
   * 404), so the two lists narrow by different rules on purpose.
   */
  async hiddenFormIds(
    stored: readonly StoredFormRestriction[],
    resolveGroup: GroupResolver,
  ): Promise<string[]> {
    const hidden: string[] = [];
    for (const row of stored) {
      if ((await this.verdictFor(row, resolveGroup)) !== 'open') {
        hidden.push(row.formId);
      }
    }
    return hidden;
  }

  /**
   * {@link hiddenFormIds} **against the request's own scope** — the whole
   * calculation, including „whose rows are read at all", in one call.
   *
   * The counterpart to {@link effectivePermissionsIn}, and it exists for the
   * same reason that one does: the four lines around `hiddenFormIds` were about
   * to be copied into a second caller. „Papierkorb leeren" needs exactly what
   * the mail log needs — which forms of this organisation does the requirement
   * of *this route* not open for this person — and the copied part would have
   * been the `restrictedUserId() === undefined` arm, i.e. the one place the
   * administrator exception lives.
   *
   * Note what „hidden" means here and why it is the right question for a
   * deletion: it is `verdictFor` against the **route's own** requirement
   * (`@RequireAllPermissions('canViewResponses', 'canBuild')` on
   * `DELETE /trash`), so a revocation and a cap that falls short of that pair
   * both land in the list. {@link formFilter} cannot answer it — a cap is only
   * decidable against a requirement, and that fragment has none.
   */
  async hiddenFormIdsIn(source: RestrictionRowSource): Promise<string[]> {
    const userId = this.restrictedUserId();
    if (userId === undefined) {
      // An administrator's rows are not read at all — reading them and then
      // ignoring them is one `if` away from honouring them.
      return [];
    }
    return this.hiddenFormIds(
      await source.formPermissions.findManyOfUser(userId),
      (groupId) => source.groups.findById(groupId),
    );
  }

  /**
   * „Formulare, auf die mir der Zugriff nicht entzogen ist" — as a condition,
   * not as a filter afterwards.
   *
   * A relation filter PostgreSQL evaluates: a locked form never leaves the
   * database, so it is not in the payload of the list route to be hidden by a
   * client. That is what makes the boundary a boundary rather than an
   * Anzeigefrage, and it is what a test searching the **whole**
   * payload of `GET /api/forms` proves.
   *
   * `tenantId` is omitted from the type for the reason `ScopedFormQuery` omits
   * it: the tenant binding belongs to the scope and is merged in last, so this
   * fragment can narrow a query and never widen it.
   *
   * An administrator gets an empty fragment — the ignored restriction of
   * {@link isRestrictable}, in the shape a query understands.
   */
  formFilter(): Omit<Prisma.FormWhereInput, 'tenantId'> {
    const userId = this.restrictedUserId();
    if (userId === undefined) {
      return {};
    }
    return {
      permissions: { none: { userId, accessRevoked: true } },
    };
  }

  /**
   * Whose restrictions a scoped read has to honour — `undefined` for an
   * administrator, whose rows are not read at all ({@link isRestrictable}).
   *
   * The one place „ist diese Person überhaupt einschränkbar?" is turned into a
   * value a query can take. It exists because the fourth link now narrows a
   * second table (`mail_log`, a review finding), and the alternative would
   * have been a second `if (restriction.restrictable)` next to a second
   * fragment — two places to get the admin exception right, of which only one
   * has a test on it.
   */
  restrictedUserId(): string | undefined {
    return this.restrictable ? this.userId : undefined;
  }
}

/**
 * A {@link GroupResolver} that reads each group once per call.
 *
 * Only for the batch above: `null` is cached like any other answer, because
 * „this id resolves to nothing" is an answer and asking again inside one
 * request would not produce a different one.
 */
function memoiseGroups(resolveGroup: GroupResolver): GroupResolver {
  const seen = new Map<string, Promise<Group | null>>();
  return (groupId) => {
    const cached = seen.get(groupId);
    if (cached !== undefined) {
      return cached;
    }
    const pending = resolveGroup(groupId);
    seen.set(groupId, pending);
    return pending;
  };
}

/**
 * Hands a handler the restriction `FormRestrictionGuard` established.
 *
 * The counterpart to `@CurrentTenantScope()`, and it fails closed for the same
 * reason: a route that forgot the guard would otherwise hand the service
 * `undefined`, which spreads into a `where` as nothing at all — „no condition"
 * being exactly the wrong default for a rule that only takes away.
 */
export const CurrentFormRestriction = createParamDecorator(
  (_data: unknown, context: ExecutionContext): FormRestriction => {
    const request = context.switchToHttp().getRequest<TenantScopedRequest>();
    const restriction = request.formRestriction;
    if (restriction === undefined) {
      throw new ForbiddenException(NO_TENANT_SCOPE_MESSAGE);
    }
    return restriction;
  },
);
