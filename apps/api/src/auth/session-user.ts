import { deliverableBranding } from '@formsache/shared';
import type {
  GroupSummary,
  MembershipSummary,
  Permissions,
  SessionUser,
  TenantSummary,
} from '@formsache/shared';
import type { Group, Membership, Prisma, User } from '@prisma/client';

import {
  OWNED_LOGO_INCLUDE,
  ownedLogoRef,
  type TenantWithLogoFiles,
} from '../files/owned-logo';
import type { SessionFeatures } from './session-features';

/**
 * Translation from database rows into the shared wire contract.
 *
 * One direction only, and one place only: every response that names the
 * signed-in person goes through here, so a column that must never leave the
 * server — `password_hash` above all — has exactly one place
 * where it could be added by mistake, and it is a place with tests on it.
 */

/**
 * The query shape every caller uses. Written as a constant so the guard and
 * the login cannot load different amounts of data and produce two subtly
 * different session users.
 */
export const membershipInclude = {
  memberships: {
    /**
     * **Filter 1 of the six of the requirement — `tenant.deleted_at`.**
     *
     * A membership in a deleted Organisation is not reported, and that one condition
     * carries three of the six places the requirement lists, because all three read
     * this list and nothing else:
     *
     * - **Anmeldung** — `AuthService.login` and the OIDC login load the person
     *   through this constant, so `deriveActiveTenant` cannot pick a deleted
     *   Organisation as the fresh session's scope;
     * - **Sitzungsauflösung** — `SessionService.authenticate` loads it on every
     *   request, and `resolveActiveTenantId` keeps `session.active_tenant_id`
     *   only while this list still covers it. An **open** session whose active
     *   Organisation is deleted therefore loses its scope on the next request and gets
     *   the ordinary 403 of `TenantScopeGuard` — not a 500, and not a scope
     *   over an organisation on its way out;
     * - **Tenant-Wechsler** — the switcher is rendered from
     *   `SessionUser.memberships`, so it does not offer what it cannot enter.
     *
     * One condition for three places rather than three conditions, because
     * they are one question asked once: „welche Organisationen stehen dieser Person
     * offen". The *write* side of the switcher asks it a second time and
     * against the database (`TenantSwitchService`, filter 2) — that one is a
     * separate query and needs its own condition.
     *
     * The membership row itself is untouched: the organisation can be restored, and
     * everybody who served it serves it again.
     */
    where: { tenant: { deletedAt: null } },
    // The **second** of the four shores of ADR-0014 no. 12: the tenant is
    // loaded with its own Logo files, so a `logo_ref` naming another organisation's
    // upload finds nothing to be proven by (`files/owned-logo.ts`). Without the
    // include the organisation loses its Logo — never somebody else's.
    include: { tenant: { include: OWNED_LOGO_INCLUDE }, group: true },
    // Stable order, so the tenant switcher does not reshuffle between
    // requests. The Kurzname is what the switcher shows.
    orderBy: { tenant: { shortName: 'asc' } },
  },
} satisfies Prisma.UserInclude;

export type UserWithMemberships = User & {
  memberships: (Membership & { tenant: TenantWithLogoFiles; group: Group })[];
};

/**
 * The six permission flags, exactly as stored.
 *
 * Not "everything, if `is_system`" — although the schema does state that
 * system groups hold every permission. Reporting *more* than the row says
 * would make this mapper a place that grants rights, and rights are granted
 * where groups are managed. Reading the stored flags can only ever
 * under-report, which is the safe direction.
 */
function toPermissions(group: Group): Permissions {
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
 * Exported because the groups endpoint answers the same shape: two mappers for
 * one wire type are two places where a column can start leaking, and only one
 * of them would have the tests on it.
 */
export function toGroupSummary(group: Group): GroupSummary {
  return {
    id: group.id,
    name: group.name,
    color: group.color,
    rank: group.rank,
    isSystem: group.isSystem,
  };
}

/**
 * Only what the header, the tenant switcher and the theming need — the OIDC
 * configuration of a tenant (issuer, client id, encrypted secret) stays here
 * and never travels, even though it sits in the same row.
 *
 * **The branding passes the delivery gate** (the requirements). The
 * columns are not handed on as stored: a colour ends up in a CSS custom
 * property and a `logo_ref` in an `<img src>`, and neither is a place for a
 * value that reached the row past the API — by hand, by an older version, by a
 * restore. `deliverableBranding` is the same predicate the save refuses on, so
 * this cannot reject anything the API itself wrote; that is the point, and it
 * is why gate 2 has unit tests of its own rather than relying on this path.
 */
function toTenantSummary(tenant: TenantWithLogoFiles): TenantSummary {
  const { logoRef, branding } = deliverableBranding(
    tenant,
    ownedLogoRef(tenant),
  );
  return {
    id: tenant.id,
    shortName: tenant.shortName,
    name: tenant.name,
    // The gate's own answer, handed on unchanged (ADR-0014 no. 12): a shipped
    // asset, this organisation's **proven** upload, or nothing. What makes that safe is
    // the line above it — `ownedLogoRef` reads the file relation this query
    // loaded, so a `logo_ref` naming another organisation's file is `null` here rather
    // than a reference somebody's browser goes and fetches.
    logoRef,
    branding,
  };
}

function toMembershipSummary(
  membership: Membership & { tenant: TenantWithLogoFiles; group: Group },
): MembershipSummary {
  return {
    tenant: toTenantSummary(membership.tenant),
    group: toGroupSummary(membership.group),
    permissions: toPermissions(membership.group),
  };
}

/**
 * Which tenant a request is actually scoped to.
 *
 * `session.active_tenant_id` is a *stored* value, and a stored value is a
 * claim, not a fact: memberships are revoked while sessions live on, and a
 * database row can be wrong for less benign reasons too. The column therefore
 * only counts while the membership list loaded in the same breath covers it.
 *
 * Anything else is `null`, and `null` means **no** tenant scope — never "all
 * tenants" (`schema.prisma`, model `Session`). Failing to a smaller scope is
 * the only safe direction: the opposite reading turns a stale row into
 * cross-tenant access.
 *
 * Written as a pure function over ids so that the guard chain and this mapper
 * decide it the same way. Two implementations of "which tenant" is exactly how
 * a request ends up reporting one organisation and reading another.
 */
export function resolveActiveTenantId(
  memberTenantIds: readonly string[],
  activeTenantId: string | null,
): string | null {
  if (activeTenantId === null) {
    return null;
  }
  return memberTenantIds.includes(activeTenantId) ? activeTenantId : null;
}

/**
 * Builds the wire representation of the signed-in person.
 *
 * `activeTenantId` comes from the *session*, not from the user: the same
 * person can be signed in twice and work in a different Organisation in each tab.
 *
 * It is **not** passed through as stored. An earlier draft did, arguing that
 * blanking an unbacked value would hide a bug rather than prevent it; the
 * review gate showed the cost of that position. Revoke a membership while the
 * session lives and `GET /api/auth/me` kept reporting the old Organisation with an
 * empty `memberships` list — a self-contradicting answer, and one the tenant
 * switcher in the app shell renders as a selected Organisation the user cannot use.
 * The memberships are already loaded here, so the check costs nothing.
 *
 * What prevents the *bug* is still that nothing may write the column without a
 * membership check. What this does is refuse to repeat the claim.
 */
export function toSessionUser(
  user: UserWithMemberships,
  activeTenantId: string | null,
  /**
   * What this installation offers — **required, and that is
   * the point**.
   *
   * Three call sites build a session payload (login, session lookup,
   * Organisation-Wechsel), and an optional argument here would mean each of them
   * decides for itself whether the shell learns about the AI. A person who
   * logs in would then see the entry and the same person after an organisation-Wechsel
   * would not — the shape of drift this function exists to prevent, with
   * `password_hash` as its older example.
   */
  features: SessionFeatures,
): SessionUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    isSuperadmin: user.isSuperadmin,
    memberships: user.memberships.map(toMembershipSummary),
    activeTenantId: resolveActiveTenantId(
      user.memberships.map((membership) => membership.tenantId),
      activeTenantId,
    ),
    // Spread rather than named field by field: `SessionFeatures` is the one
    // definition of which flags exist, and a second one here would be the
    // place a future flag is forgotten.
    ...features,
  };
}
