import type { ReactElement } from 'react';
import { useRef, useState } from 'react';

import { useCreateTenant, useTenantOverview } from '../api/admin';
import { ApiError } from '../api/http';
import { DASHBOARD_PATH } from '../router/routes';
import { navigate } from '../router/use-route';
import { AiQuotaSection } from './superadmin/AiQuotaSection';
import { CreateTenantForm } from './superadmin/CreateTenantForm';
import { DeletedTenantsSection } from './superadmin/DeletedTenantsSection';
import { TenantOverviewTable } from './superadmin/TenantOverviewTable';

import './superadmin-view.css';

export interface SuperadminViewProps {
  /**
   * The session's current scope, straight from `GET /auth/me` — never a
   * remembered choice (`AppShell`'s own rule, applied here too). `null` means
   * no tenant is active yet, which a fresh superadmin account can be.
   */
  readonly activeTenantId: string | null;
}

/**
 * The *Organisationen* tab of the system administration — until finding 16 a
 * page of its own called „Superadmin-Übersicht" at `/admin/superadmin`.
 *
 * **The page's title is no longer here**, but in the frame
 * (`SystemAdminView`): „Systemverwaltung" with the red badge „Alle
 * Organisationen". What remains is this one tab's heading — and it is still the
 * landing place for the focus that a deleted row drops.
 *
 * **Behind a guard the view cannot see.** `AdminTenantsController` answers 403
 * to anyone without `is_superadmin` — the navigation entry that leads here is
 * hidden as a courtesy, this view's only job for that case is to say the guard
 * refused rather than invent a reason (`CONTRIBUTING.md`, the same pattern
 * the mail and KI tabs use for the same guard).
 *
 * **The one cross-tenant query of this application outside the mail worker and
 * the purge jobs**  — the KPI tiles and the table read
 * `GET /admin/tenants`, and nothing else on this page reaches past the active
 * organisation's own data.
 */
export function SuperadminView({
  activeTenantId,
}: SuperadminViewProps): ReactElement {
  const overview = useTenantOverview();
  const create = useCreateTenant();
  const [creating, setCreating] = useState(false);
  /**
   * Focus target after „Löschen" on the table below removes a row
   *  — the same “a focus that falls into nothing” fix
   * `TrashView.tsx`'s and `DashboardView.tsx`'s own `<h1>` apply.
   */
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Captured before any narrowing (`FormMembersView` does the same, see the
  // comment there): a query result's own `data` narrows to "never undefined"
  // the moment `isError` is known false, which would turn the guard below into
  // a type error instead of the runtime check it has to stay for the case that
  // needs it — a query that has not settled yet.
  const document = overview.data;

  if (overview.isPending) {
    return (
      <div className="superadmin">
        <p className="superadmin__state" role="status">
          Organisationen werden geladen…
        </p>
      </div>
    );
  }

  if (document === undefined) {
    const forbidden =
      overview.error instanceof ApiError && overview.error.status === 403;
    return (
      <div className="superadmin">
        <p className="superadmin__state" role="alert">
          {forbidden
            ? 'Diese Ansicht ist Superadmins vorbehalten.'
            : 'Die Tenant-Übersicht konnte nicht geladen werden.'}{' '}
          <button
            type="button"
            className="superadmin__link"
            onClick={() => {
              navigate(DASHBOARD_PATH);
            }}
          >
            Zurück zum Dashboard
          </button>
        </p>
      </div>
    );
  }

  const { tenants, totals } = document;

  return (
    <div className="superadmin">
      <div className="superadmin__head">
        <div className="superadmin__title-block">
          {/*
            An `<h2>` below the frame's `<h1>` (finding 16). The badge „Alle
            Tenants" used to stand next to it here and now stands once at the
            top — the same reach twice on one screen does not state it twice, it
            makes it incidental.

            **Not plainly „Organisationen".** The tab above is already called
            that, and so is the first KPI tile below it — three identical words
            on one screen, each of which means something different. This heading
            says what the list *is*.
          */}
          <h2 className="superadmin__title" ref={headingRef} tabIndex={-1}>
            Organisationen dieser Installation
          </h2>
          <p className="superadmin__subtitle">
            Zentrale Verwaltung über alle Verbände und Organisationen hinweg
          </p>
        </div>
        {creating ? null : (
          <button
            type="button"
            className="superadmin__create-open"
            onClick={() => {
              setCreating(true);
            }}
          >
            + Neue Organisation
          </button>
        )}
      </div>

      {creating ? (
        <CreateTenantForm
          create={create}
          onCreated={() => {
            setCreating(false);
            create.reset();
          }}
          onCancel={() => {
            setCreating(false);
            create.reset();
          }}
        />
      ) : null}

      <div className="superadmin__kpis">
        <div className="superadmin__kpi">
          <span className="superadmin__kpi-number">{totals.tenants}</span>
          <span className="superadmin__kpi-label">Organisationen</span>
        </div>
        <div className="superadmin__kpi">
          <span className="superadmin__kpi-number">{totals.forms}</span>
          <span className="superadmin__kpi-label">Formulare gesamt</span>
        </div>
        <div className="superadmin__kpi">
          <span className="superadmin__kpi-number superadmin__kpi-number--success">
            {totals.responses}
          </span>
          <span className="superadmin__kpi-label">Antworten gesamt</span>
        </div>
        <div className="superadmin__kpi">
          <span className="superadmin__kpi-number superadmin__kpi-number--info">
            {totals.users}
          </span>
          <span className="superadmin__kpi-label">Nutzer gesamt</span>
        </div>
      </div>

      <TenantOverviewTable
        rows={tenants}
        activeTenantId={activeTenantId}
        onDeleted={() => {
          headingRef.current?.focus();
        }}
      />

      {/* Below the table and before the deleted organizations: the section sets
          a number on *living* organizations, and a deleted organization no
          longer accepts one (the route answers 404 for it). */}
      <AiQuotaSection rows={tenants} />

      <DeletedTenantsSection />
    </div>
  );
}
