import type {
  DeliverableLogo,
  MembershipSummary,
  Permissions,
  SessionUser,
} from '@formsache/shared';

/**
 * Session fixtures in the exact shape of the wire contract.
 *
 * Built through the shared types rather than as loose object literals, so a
 * change to `sessionUserSchema` breaks these first — which is the point of
 * consuming `@formsache/shared` from source (ADR-0007).
 */

export const UMBRELLA_TENANT_ID = '00000000-0000-4000-8000-000000000001';
export const OTHER_TENANT_ID = '00000000-0000-4000-8000-000000000002';

/**
 * Composes a colour literal from its digits.
 *
 * Branding colours are **wire data** here, not styling — they are what the
 * server sends and what `tenantThemeStyle()` has to survive. Spelling them as
 * `#cea967` would still trip `formsache/no-hardcoded-colors`, which covers every
 * non-test file under `apps/web/src`; this file is a fixture module, so it
 * misses the test-file exemption in the root ESLint config. That config is not
 * this wave's to change, hence the indirection — and the comment, so nobody
 * mistakes it for a way to sneak a colour into a component.
 */
function brandColor(digits: string): string {
  return `#${digits}`;
}

/**
 * The five flags, all granted unless a case says otherwise.
 *
 * Two payloads carry them and mean different things: `MembershipSummary`
 * („was darf diese Person in dieser Organisation?") and, since the requirement no. 3,
 * `FormSummary`/`FormDetail` („…und auf *diesem* Formular?"). One helper for
 * both, because the interesting fixtures are the ones where the two **differ** —
 * that is the whole finding — and hand-written literals make the difference
 * look like a typo instead of the point.
 */
export function permissions(overrides: Partial<Permissions> = {}): Permissions {
  return {
    canBuild: true,
    canViewResponses: true,
    canExport: true,
    canManageSettings: true,
    canManageFormSettings: true,
    canManageUsers: true,
    ...overrides,
  };
}

export function membership(
  tenantId: string,
  name: string,
  shortName: string,
  // Typed as the union the wire carries, not as `string`: `tenantSummarySchema`
  // narrowed `logoRef` to the shipped assets and widened it to
  // the discriminated union with the upload arm (ADR-0014 no. 12), so a
  // fixture inventing a reference describes a payload the server cannot send.
  logoRef: DeliverableLogo = null,
  /**
   * Overrides on the six permission flags — the whole point of which is the
   * `false` case: a test that only ever sees the permitted case proves nothing
   * (`CONTRIBUTING.md`), and the shell hides several controls behind these.
   */
  permissionOverrides: Partial<Permissions> = {},
): MembershipSummary {
  return {
    tenant: {
      id: tenantId,
      shortName,
      name,
      logoRef,
      branding: {
        accent: brandColor('cea967'),
        headerBg: brandColor('212226'),
        canvasBg: brandColor('e9e6df'),
        stripe: ['212226', '7c0800', 'cea967'].map(brandColor),
        wideLogo: true,
      },
    },
    group: {
      id: '00000000-0000-4000-8000-0000000000a1',
      name: 'admin',
      color: brandColor('7c0800'),
      rank: 100,
      isSystem: true,
    },
    permissions: permissions(permissionOverrides),
  };
}

/**
 * The active tenant the **server** would report for these memberships.
 *
 * `AuthService` scopes a session at login only when the choice is unambiguous:
 * exactly one membership becomes the active tenant, anything else stays `null`
 * until the session-tenant endpoint is used. A fixture that hands out an active
 * tenant for two memberships describes a payload the API never sends — and the
 * dead end that state leads to (no scope, 403 on every tenant-bound request)
 * then cannot show up in any test.
 */
function derivedActiveTenantId(
  memberships: readonly MembershipSummary[],
): string | null {
  const only = memberships.length === 1 ? memberships[0] : undefined;
  return only?.tenant.id ?? null;
}

/**
 * A session payload in the shape `GET /api/auth/me` returns it.
 *
 * `activeTenantId` follows from `memberships` by the server's own rule, so
 * passing two memberships gives the unscoped session a real account gets.
 * Tests that need the scoped-with-several-tenants state (what the switch
 * endpoint produces) pass `activeTenantId` explicitly.
 */
export function sessionUser(overrides: Partial<SessionUser> = {}): SessionUser {
  const {
    memberships = [
      membership(UMBRELLA_TENANT_ID, 'Dachorganisation', 'DACH', {
        kind: 'asset',
        ref: 'assets/beispiel-signet.svg',
      }),
    ],
    activeTenantId,
    ...rest
  } = overrides;

  return {
    id: '00000000-0000-4000-8000-00000000000f',
    email: 'admin@example.org',
    name: 'Alexandra Admin',
    isSuperadmin: false,
    // The server always sends this, so the schema is no longer optional and
    // a fixture without it would describe a payload the route cannot
    // produce. `false` is the state of an installation without a key.
    aiFormsAvailable: false,
    ...rest,
    memberships,
    // `undefined` means "not passed" — `exactOptionalPropertyTypes` keeps a
    // caller from spelling it out, so an explicit `null` still wins and can
    // ask for the unscoped session even with a single membership.
    activeTenantId:
      activeTenantId === undefined
        ? derivedActiveTenantId(memberships)
        : activeTenantId,
  };
}
