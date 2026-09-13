import type { ReactElement } from 'react';
import type { MembershipSummary } from '@formsache/shared';

import { useSwitchTenant } from '../api/session';
import { DASHBOARD_PATH } from '../router/routes';
import { navigate } from '../router/use-route';
import { TenantMark } from './TenantMark';

import './tenant-list.css';

export interface TenantListProps {
  /** Every tenant the signed-in person may work in — the server's list. */
  readonly memberships: readonly MembershipSummary[];
  /** The tenant the current session is scoped to; `null` means none. */
  readonly activeTenantId: string | null;
  /**
   * Called after a switch actually succeeded — the popover and the mobile
   * sheet use it to close themselves.
   *
   * After success, not on click: a switch that failed leaves the user in the
   * tenant they were in, and closing the chooser would hide both the error and
   * the second attempt. The container decides *what* closing means, this
   * component decides *when* there is something to close over.
   */
  readonly onSwitched?: () => void;
}

/**
 * The tenant selection of the handoff — used by the desktop switcher popover
 * and by the mobile sheet, which is why it is a component and not markup
 * repeated twice.
 *
 * **Wired.** This was left read-only on purpose at first: the switch
 * re-scopes the session, so the whole query cache has to be invalidated, and
 * there was exactly one view to re-fetch — an empty dashboard, which could not
 * show whether the invalidation worked. With the first tenant-bound views the
 * path can be proven, so it is built.
 *
 * The mutation lives here rather than being handed in from both call sites:
 * the behaviour is identical in the popover and in the mobile sheet, and two
 * handlers for one behaviour is how the two later stop agreeing.
 *
 * `null` as `activeTenantId` means **no** scope, never "all" — someone with
 * two memberships gets no active tenant from the login, because the server
 * only scopes an unambiguous one. That state is the reason this list exists,
 * so it is called out rather than left looking like an oversight.
 */
export function TenantList({
  memberships,
  activeTenantId,
  onSwitched,
}: TenantListProps): ReactElement {
  const switcher = useSwitchTenant();

  if (memberships.length === 0) {
    return (
      <p className="tenant-list__empty">
        Diesem Konto ist noch kein Tenant zugeordnet.
      </p>
    );
  }

  return (
    <>
      <ul className="tenant-list">
        {memberships.map((membership) => {
          const isActive = membership.tenant.id === activeTenantId;
          // Only one switch is ever in flight, and the row being switched *to*
          // is the one that says so — a global spinner would leave the user
          // guessing which Organisation they are about to land in.
          const isPending =
            switcher.isPending && switcher.variables === membership.tenant.id;

          return (
            <li
              key={membership.tenant.id}
              className={
                isActive
                  ? 'tenant-list__row tenant-list__row--active'
                  : 'tenant-list__row'
              }
            >
              <button
                type="button"
                className="tenant-list__select"
                // The active tenant is not a target: switching to where one
                // already is would spend a round trip and a full cache
                // invalidation on nothing.
                disabled={isActive || switcher.isPending}
                aria-current={isActive ? 'true' : undefined}
                onClick={() => {
                  switcher.mutate(membership.tenant.id, {
                    onSuccess: () => {
                      // Close the chooser first, then go: the order is the
                      // one people see.
                      onSwitched?.();
                      // **And on to the dashboard** (finding 19). Before,
                      // the switch stayed standing on the address it had been
                      // triggered on — and that one belonged to the
                      // organisation one had just left: a form, a wastebasket,
                      // a tenant administration that does not exist that way
                      // in the new one. That became visible as an empty view
                      // or as a 404, although the switch had succeeded. The
                      // dashboard is the one address every organisation has.
                      navigate(DASHBOARD_PATH);
                    },
                  });
                }}
              >
                <TenantMark
                  tenant={membership.tenant}
                  className="tenant-mark--row"
                />
                <span className="tenant-list__body">
                  <span className="tenant-list__name">
                    {membership.tenant.name}
                  </span>
                  <span className="tenant-list__meta">
                    {membership.tenant.shortName} · {membership.group.name}
                  </span>
                </span>
                {isActive ? (
                  <span className="tenant-list__badge">
                    <span aria-hidden="true">✓ </span>Aktiv
                  </span>
                ) : null}
                {isPending ? (
                  <span className="tenant-list__badge">Wird gewechselt…</span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
      {switcher.isError ? (
        <p
          className="tenant-list__note tenant-list__note--warning"
          role="alert"
        >
          Der Wechsel ist fehlgeschlagen. Bitte erneut versuchen.
        </p>
      ) : null}
      {activeTenantId === null && !switcher.isError ? (
        <p
          className="tenant-list__note tenant-list__note--warning"
          role="status"
        >
          Diese Sitzung ist keiner Organisation zugeordnet. Bitte eine
          Organisation auswählen – bis dahin sind keine Daten sichtbar.
        </p>
      ) : null}
    </>
  );
}
