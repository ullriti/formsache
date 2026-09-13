import type { ReactElement } from 'react';
import { useRef, useState } from 'react';

import { useDeletedTenants, useRestoreTenant } from '../../api/admin';
import { ApiError } from '../../api/http';
import { actionErrorMessage, TENANT_RESTORE_SUBJECT } from '../api-messages';

/**
 * **„Gelöschte Organisationen"** — the section of the superadmin overview a deleted
 * Organisation is wiederhergestellt from.
 *
 * **No logo anywhere in this section, deliberately** (security review
 * finding). `GET /admin/tenants/deleted` still carries a
 * `logoRef` — `deletedTenantSchema` reuses `tenantSummarySchema` whole,
 * branding included — but the public file route that an *uploaded* logo
 * resolves through (`resolveTenantLogo` → `/api/public/files/…`) filters out
 * deleted tenants by the same `tenant.deleted_at IS NULL` rule every other
 * fachlich query applies. Rendering `TenantMark` here would be correct for a
 * bundled asset and a guaranteed broken `<img>` for an uploaded one — a
 * distinction this section has no reason to make when the row's identity is
 * carried perfectly well by its name and Kurzname alone.
 *
 * **Its own heading, `tabIndex={-1}`, always rendered** — the same fix
 * `TrashView.tsx`'s `<h1>` and `DashboardView.tsx`'s `<h1>` apply for the
 * identical shape: restoring the only row in this section removes the row a
 * moment before this component would otherwise have nothing stable left to
 * put focus on.
 *
 * **A row's own error, not a section-wide one.** One `useRestoreTenant` mutation
 * serves every row (a set of in-flight ids, not the mutation's own `variables`
 * — the reasoning `TrashView.tsx` spells out in full for the identical shape),
 * so a refusal on one organisation does not blank out a message that belongs to
 * another.
 */
export function DeletedTenantsSection(): ReactElement {
  const deletedTenants = useDeletedTenants();
  const restoreTenant = useRestoreTenant();
  const [restoringIds, setRestoringIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const headingRef = useRef<HTMLHeadingElement>(null);

  const onRestore = (tenantId: string): void => {
    setErrors((prev) =>
      Object.fromEntries(
        Object.entries(prev).filter(([id]) => id !== tenantId),
      ),
    );
    setRestoringIds((prev) => new Set(prev).add(tenantId));
    restoreTenant.mutate(tenantId, {
      onSuccess: () => {
        headingRef.current?.focus();
      },
      onError: (error) => {
        setErrors((prev) => ({
          ...prev,
          [tenantId]: actionErrorMessage(error, TENANT_RESTORE_SUBJECT),
        }));
      },
      onSettled: () => {
        setRestoringIds((prev) => {
          const next = new Set(prev);
          next.delete(tenantId);
          return next;
        });
      },
    });
  };

  const tenants = deletedTenants.data?.tenants;

  return (
    <section
      className="superadmin__deleted-section"
      aria-labelledby="superadmin-deleted-heading"
    >
      <div className="superadmin__deleted-head">
        <h2
          className="superadmin__deleted-title"
          id="superadmin-deleted-heading"
          ref={headingRef}
          tabIndex={-1}
        >
          Gelöschte Organisationen
        </h2>
        <span
          className="superadmin__count"
          data-testid="superadmin-deleted-count"
        >
          {tenants?.length ?? 0}
        </span>
      </div>

      {deletedTenants.isPending ? (
        <p className="superadmin__deleted-empty" role="status">
          Gelöschte Organisationen werden geladen…
        </p>
      ) : deletedTenants.isError || tenants === undefined ? (
        <p className="superadmin__deleted-empty" role="alert">
          {loadErrorMessage(deletedTenants.error)}
        </p>
      ) : tenants.length === 0 ? (
        <p className="superadmin__deleted-empty">
          Keine gelöschten Organisationen.
        </p>
      ) : (
        tenants.map(({ tenant, deletedAt }) => (
          <div
            className="superadmin__deleted-row"
            data-testid="superadmin-deleted-tenant"
            key={tenant.id}
          >
            <div className="superadmin__deleted-identity">
              <p className="superadmin__deleted-name">{tenant.name}</p>
              <p className="superadmin__deleted-meta">
                {tenant.shortName} · gelöscht {formatDate(deletedAt)}
              </p>
            </div>
            <button
              type="button"
              className="superadmin__deleted-restore"
              data-testid="superadmin-restore-tenant"
              onClick={() => {
                onRestore(tenant.id);
              }}
              disabled={restoringIds.has(tenant.id)}
            >
              <span aria-hidden="true">↩ </span>
              {restoringIds.has(tenant.id)
                ? 'Wird wiederhergestellt…'
                : 'Wiederherstellen'}
            </button>
            {errors[tenant.id] === undefined ? null : (
              <p className="superadmin__deleted-error" role="alert">
                {errors[tenant.id]}
              </p>
            )}
          </div>
        ))
      )}
    </section>
  );
}

/** `Date.toLocaleDateString` — the same formatting `TrashView.tsx` uses. */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('de-DE');
}

/**
 * Why the list could not be read — the same 403-tells-two-guards-apart shape
 * `TrashView.tsx`'s `loadErrorMessage` already has, here for `SuperadminGuard`
 * alone (this route has no `TenantScopeGuard`, `GroupPermissionGuard`, or
 * `FormRestrictionGuard` — see `AdminTenantsController`'s own docblock).
 */
function loadErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) {
    return error.detail ?? 'Diese Ansicht ist Superadmins vorbehalten.';
  }
  return 'Die gelöschten Organisationen konnten nicht geladen werden.';
}
