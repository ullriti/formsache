import type { ReactElement } from 'react';
import { Fragment, useState } from 'react';

import type { TenantOverviewRow } from '@formsache/shared';

import { useDeleteTenant } from '../../api/admin';
import { useSession, useSwitchTenant } from '../../api/session';
import { DASHBOARD_PATH, TENANT_APPEARANCE_PATH } from '../../router/routes';
import { navigate } from '../../router/use-route';
import { TenantMark } from '../../shell/TenantMark';
import { actionErrorMessage, TENANT_DELETE_SUBJECT } from '../api-messages';
import { TenantDeleteConfirm } from './TenantDeleteConfirm';

export interface TenantOverviewTableProps {
  readonly rows: readonly TenantOverviewRow[];
  /** The session's current scope — `null` means none (handoff §Header). */
  readonly activeTenantId: string | null;
  /**
   * Called once a delete succeeds, **before** the row is gone from `rows` —
   * `SuperadminView` moves focus to this tab's own `<h2>` with it, the same
   * „a focus that falls into nothing" fix `TrashView.tsx` and
   * `DashboardView.tsx` apply for the identical shape (the deleted row is
   * removed by the refetch this component's own mutation triggers).
   */
  readonly onDeleted: () => void;
}

/**
 * The table of every organisation (handoff).
 *
 * **„Wechseln" and „Verwalten" both re-scope the session**, and that is spelled
 * out on screen rather than left for someone to discover: the tenant administration
 * names no organisation in its address on purpose (the requirement — „eine Grenze, die
 * man gar nicht adressieren kann, ist stärker als eine, die man adressiert und
 * abgewiesen bekommt"), so „Verwalten" opens *the active organisation's* pages by making
 * the row's Organisation the active one first, then navigating. Someone who followed
 * „Verwalten" expecting to land on a stranger's settings and instead finds their
 * own session moved would be reading a bug report about correct behaviour.
 *
 * **And both are shown only where they work.** `PUT /session/tenant` answers
 * 404 for an organisation the signed-in person is not a member of — deliberately the
 * same answer an unknown id gets — and a superadmin regularly *is* no member of
 * a foreign Organisation: the flag opens `GET /admin/tenants`, it is not a general key
 * . Offered on every row, the two buttons promised something
 * the server refuses, and the row then advised „bitte erneut versuchen", which
 * is wrong twice: repeating it cannot help. The memberships come from the
 * session — the same `GET /auth/me` the organisation switcher in the header lives on —
 * and a row without one says so in a sentence instead of showing a greyed-out
 * button. This is comfort, not enforcement: the session query says which Organisationen
 * *this* person may enter, the server decides it again on every request.
 */
export function TenantOverviewTable({
  rows,
  activeTenantId,
  onDeleted,
}: TenantOverviewTableProps): ReactElement {
  const switcher = useSwitchTenant();
  const session = useSession();
  const deleteTenant = useDeleteTenant();
  /** Which row's delete confirmation is open — one at a time. */
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(
    null,
  );
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});

  const onConfirmDelete = (tenantId: string, confirmName: string): void => {
    setDeleteErrors((prev) =>
      Object.fromEntries(
        Object.entries(prev).filter(([id]) => id !== tenantId),
      ),
    );
    deleteTenant.mutate(
      { tenantId, confirmName },
      {
        onSuccess: () => {
          setConfirmingDeleteId(null);
          onDeleted();
        },
        onError: (error) => {
          setDeleteErrors((prev) => ({
            ...prev,
            [tenantId]: actionErrorMessage(error, TENANT_DELETE_SUBJECT),
          }));
        },
      },
    );
  };

  /**
   * `undefined` while the session has not answered (or could not) — and then
   * the actions stay visible: a page that hides them because it does not know
   * would be inventing a refusal, and the switch itself is guarded by the
   * server anyway.
   */
  const memberOf = session.data?.memberships.map(
    (membership) => membership.tenant.id,
  );

  const runSwitch = (tenantId: string, after: () => void): void => {
    if (tenantId === activeTenantId) {
      after();
      return;
    }
    switcher.mutate(tenantId, { onSuccess: after });
  };

  return (
    <section className="superadmin__table-card">
      <div className="superadmin__table-scroll">
        <table className="superadmin__table">
          <thead>
            <tr>
              <th>Organisation</th>
              <th className="superadmin__table-center">Formulare</th>
              <th className="superadmin__table-center">Antworten</th>
              <th className="superadmin__table-center">Nutzer</th>
              <th className="superadmin__table-center">Anmeldung</th>
              <th aria-hidden="true" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isActive = row.tenant.id === activeTenantId;
              const isPending =
                switcher.isPending && switcher.variables === row.tenant.id;
              const mayEnter =
                isActive ||
                memberOf === undefined ||
                memberOf.includes(row.tenant.id);

              return (
                <Fragment key={row.tenant.id}>
                  <tr>
                    <td>
                      <div className="superadmin__tenant-cell">
                        {/*
                        The `--row` variant, not a new one: `tenant-mark.css`
                        belongs to the shell (AGENTS.md domain boundary of this
                        package), and its one compact modifier already matches
                        the table's row height closely enough that inventing a
                        second is not worth crossing that line for.
                      */}
                        <TenantMark
                          tenant={row.tenant}
                          className="tenant-mark--row"
                        />
                        <div className="superadmin__tenant-identity">
                          <span className="superadmin__tenant-name">
                            {row.tenant.name}
                            {isActive ? (
                              <span className="superadmin__tenant-active-badge">
                                aktiv
                              </span>
                            ) : null}
                          </span>
                          <span className="superadmin__tenant-short">
                            {row.tenant.shortName}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td className="superadmin__table-center superadmin__table-num">
                      {row.forms}
                    </td>
                    <td className="superadmin__table-center superadmin__table-num">
                      {row.responses}
                    </td>
                    <td className="superadmin__table-center superadmin__table-num">
                      {row.users}
                    </td>
                    <td className="superadmin__table-center">
                      <span
                        className={
                          row.oidcEnabled
                            ? 'superadmin__login-badge superadmin__login-badge--oidc'
                            : 'superadmin__login-badge'
                        }
                      >
                        {row.oidcEnabled ? 'OIDC aktiv' : 'nur lokal'}
                      </span>
                    </td>
                    <td className="superadmin__table-actions">
                      {mayEnter ? (
                        <>
                          <button
                            type="button"
                            className="superadmin__switch-button"
                            disabled={isActive || switcher.isPending}
                            onClick={() => {
                              runSwitch(row.tenant.id, () => {
                                navigate(DASHBOARD_PATH);
                              });
                            }}
                          >
                            {isActive
                              ? '✓ Aktiv'
                              : isPending
                                ? 'Wird gewechselt…'
                                : 'Wechseln'}
                          </button>
                          <button
                            type="button"
                            className="superadmin__manage-button"
                            disabled={switcher.isPending}
                            title="Wechselt die aktive Organisation und öffnet die Organisations-Verwaltung"
                            onClick={() => {
                              runSwitch(row.tenant.id, () => {
                                navigate(TENANT_APPEARANCE_PATH);
                              });
                            }}
                          >
                            Verwalten
                          </button>
                        </>
                      ) : (
                        <span className="superadmin__no-membership">
                          Kein Mitglied in dieser Organisation
                        </span>
                      )}
                      {/*
                      Unlike „Wechseln"/„Verwalten", deleting needs no
                      membership (Konzept no. 59: „ohne dass … eine Mitgliedschaft
                      nötig wäre") — offered on every row regardless of
                      `mayEnter`.
                    */}
                      <button
                        type="button"
                        className="superadmin__delete-button"
                        data-testid="superadmin-delete-tenant"
                        disabled={
                          confirmingDeleteId === row.tenant.id &&
                          deleteTenant.isPending
                        }
                        onClick={() => {
                          setConfirmingDeleteId(row.tenant.id);
                        }}
                      >
                        Löschen
                      </button>
                    </td>
                  </tr>
                  {confirmingDeleteId === row.tenant.id ? (
                    <tr>
                      <td colSpan={6} className="superadmin__delete-cell">
                        <TenantDeleteConfirm
                          tenant={row.tenant}
                          isPending={deleteTenant.isPending}
                          error={deleteErrors[row.tenant.id]}
                          onConfirm={(confirmName) => {
                            onConfirmDelete(row.tenant.id, confirmName);
                          }}
                          onCancel={() => {
                            setConfirmingDeleteId(null);
                          }}
                        />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {switcher.isError ? (
        <p className="superadmin__switch-error" role="alert">
          {actionErrorMessage(switcher.error, {
            forbidden:
              'Dieser Organisation lässt sich mit dieser Sitzung nicht öffnen.',
            missing:
              'Der Wechsel ist nicht möglich: Sie sind in dieser Organisation kein Mitglied.',
            failed: 'Der Wechsel ist fehlgeschlagen. Bitte erneut versuchen.',
          })}
        </p>
      ) : null}
    </section>
  );
}
