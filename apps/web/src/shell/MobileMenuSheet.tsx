import type { ReactElement } from 'react';
import { useId } from 'react';
import type { MembershipSummary, Permissions } from '@formsache/shared';

import type { Route } from '../router/routes';
import {
  DASHBOARD_PATH,
  SYSTEM_PATH,
  TENANT_APPEARANCE_PATH,
  PROFILE_PATH,
  TRASH_PATH,
} from '../router/routes';
import { navigate } from '../router/use-route';
import { formNavEntries } from './FormNav';
import { TenantList } from './TenantList';
import { useFocusTrap } from './use-focus-trap';

import './mobile-menu-sheet.css';

export interface MobileMenuSheetProps {
  readonly id: string;
  readonly userName: string;
  readonly memberships: readonly MembershipSummary[];
  readonly activeTenantId: string | null;
  /** Whether the route currently rendered is the dashboard. */
  readonly isDashboard: boolean;
  /** Whether one of the tenant administration's three tabs is currently rendered. */
  readonly isTenantDefaults: boolean;
  /** Whether one of the system administration's four tabs is open — see `AppHeader`. */
  readonly isSystemAdmin: boolean;
  /** Whether the trash is currently rendered. */
  readonly isTrash: boolean;
  /**
   * `can_manage_settings` of the **active** membership, as the server reported
   * it. The entry is hidden without it — never because a local flag says so,
   * and never as a substitute for the guard that answers 403 anyway.
   */
  readonly canManageSettings: boolean;
  /**
   * `can_build` of the **active** membership — gates the trash entry the
   * same way `AppHeader` gates it.
   */
  readonly canBuild: boolean;
  /** `is_superadmin` of the person — see `AppHeader`. */
  readonly isSuperadmin: boolean;
  /**
   * The **effective** permissions on the form of {@link formId} — the same
   * object `FormNav` renders the desktop subheader from (the requirement
   * no. 3), never the organisation-wide flags off the session.
   *
   * Separate from {@link canManageSettings} above on purpose: that one gates
   * **Verwaltung**, which is about the organisation and not about any form, so the two
   * genuinely read different documents and merging them would make one of the
   * two wrong.
   */
  readonly formPermissions: Permissions;
  /**
   * The form the current address is about, or null — the section „Aktuelles
   * Formular" of the handoff exists only while there is one.
   */
  readonly formId: string | null;
  /** The current route, so the open entry can be marked. */
  readonly route: Route;
  readonly onClose: () => void;
  readonly onLogout: () => void;
  readonly isLoggingOut: boolean;
}

/**
 * Off-canvas menu below the breakpoint (handoff: "Mobil (< 1180 px)").
 *
 * Sections of the handoff this application can honestly fill: **Allgemein**
 * (dashboard), **Aktuelles Formular** — only while an address is about a form,
 * including „Nutzerrechte", from the same `formNavEntries()` the desktop
 * subheader uses — and **Verwaltung** with the tenant administration, the
 * trash and the system administration, plus the tenant selection. What is
 * still missing is missing rather than rendered as a dead row: „Vorschau" has
 * no address (see `FormNav`).
 *
 * **„✦ KI-Formular" no longer stands here** (finding 18) — it stands on the
 * dashboard, next to „+ Neues Formular", and thereby at the same place on both
 * widths. That was exactly the reason why it ever stood here: header and
 * mobile menu were not allowed to drift apart. Now there is only one place
 * left where they could, and that is the same view.
 *
 * It behaves as a modal dialog: focus moves in on open, Tab stays inside,
 * Escape and the scrim close it, and focus returns to the hamburger that
 * opened it.
 */
export function MobileMenuSheet({
  id,
  userName,
  memberships,
  activeTenantId,
  isDashboard,
  isTenantDefaults,
  isSystemAdmin,
  isTrash,
  canManageSettings,
  canBuild,
  isSuperadmin,
  formPermissions,
  formId,
  route,
  onClose,
  onLogout,
  isLoggingOut,
}: MobileMenuSheetProps): ReactElement {
  const titleId = useId();
  // The hamburger stays enabled while the sheet is open, so the element that
  // had focus at mount *is* the opener — no ref to thread through.
  const { panelRef, onKeyDown } = useFocusTrap({
    onClose,
  });

  /**
   * The entries of „Aktuelles Formular", computed once so the section can be
   * left out entirely when a role reaches none of them. Since a review
   * gated „Bearbeiten" on `canBuild`, that list can be empty — and a heading
   * over nothing reads as a menu that failed to load.
   */
  const formEntries =
    formId === null
      ? []
      : formNavEntries({ formId, permissions: formPermissions });

  return (
    <div className="app-sheet">
      {/* Redundant convenience: Escape and the close button do the same, so
          this stays out of the accessibility tree instead of becoming a
          second, unlabelled "close" control. */}
      <div className="app-sheet__scrim" aria-hidden="true" onClick={onClose} />
      <div
        className="app-sheet__panel"
        id={id}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={panelRef}
        onKeyDown={onKeyDown}
      >
        <div className="app-sheet__grabber" aria-hidden="true" />
        <div className="app-sheet__head">
          <h2 className="app-sheet__title" id={titleId}>
            Menü
          </h2>
          <button
            type="button"
            className="app-sheet__close"
            aria-label="Menü schließen"
            onClick={onClose}
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>

        <p className="app-sheet__user">Angemeldet als {userName}</p>

        <nav aria-label="Hauptnavigation">
          <p className="app-sheet__section">Allgemein</p>
          {/*
            Navigates and closes the sheet — same in-app, same-tab pattern as
            the desktop header's nav item (see AppHeader for why this is a
            button and not an `<a href>`). Only marked current, and only
            styled as such, while the route actually is the dashboard;
            elsewhere it is a plain way back to it.
          */}
          <button
            type="button"
            className={
              isDashboard
                ? 'app-sheet__item app-sheet__item--current'
                : 'app-sheet__item'
            }
            aria-current={isDashboard ? 'page' : undefined}
            onClick={() => {
              navigate(DASHBOARD_PATH);
              onClose();
            }}
          >
            <span aria-hidden="true">▦ </span>Dashboard
          </button>

          {/*
            „Aktuelles Formular" of the handoff — the same entries as the
            desktop subheader, from the same `formNavEntries()`, so the two
            cannot drift apart about what a role may reach. Absent entirely on
            addresses that are about no form, rather than shown empty.
          */}
          {formEntries.length === 0 ? null : (
            <>
              <p className="app-sheet__section">Aktuelles Formular</p>
              {formEntries.map((entry) => {
                const current = entry.kind === route.kind;
                return (
                  <button
                    key={entry.kind}
                    type="button"
                    className={
                      current
                        ? 'app-sheet__item app-sheet__item--current'
                        : 'app-sheet__item'
                    }
                    aria-current={current ? 'page' : undefined}
                    onClick={() => {
                      navigate(entry.path);
                      onClose();
                    }}
                  >
                    <span aria-hidden="true">{entry.icon} </span>
                    {entry.label}
                  </button>
                );
              })}
            </>
          )}

          {/*
            „Verwaltung" of the handoff, with the entries that exist: the
            tenant administration (opens at its first tab, *Erscheinungsbild &
            Login* — see `AppHeader`), the trash (gated
            on `canBuild` like the desktop header) and, for a superadmin, its
            overview and the system layer below the organisation's own
            standards.

            The heading follows the entries rather than the flags directly: a
            superadmin without `can_manage_settings` and without `canBuild`
            would otherwise get a „Verwaltung" over nothing, or an entry with
            no heading over it.
          */}
          {canManageSettings || canBuild || isSuperadmin ? (
            <>
              <p className="app-sheet__section">Verwaltung</p>
              {canManageSettings ? (
                <button
                  type="button"
                  className={
                    isTenantDefaults
                      ? 'app-sheet__item app-sheet__item--current'
                      : 'app-sheet__item'
                  }
                  aria-current={isTenantDefaults ? 'page' : undefined}
                  onClick={() => {
                    navigate(TENANT_APPEARANCE_PATH);
                    onClose();
                  }}
                >
                  <span aria-hidden="true">⚙ </span>Organisations-Verwaltung
                </button>
              ) : null}
              {canBuild ? (
                <button
                  type="button"
                  className={
                    isTrash
                      ? 'app-sheet__item app-sheet__item--current'
                      : 'app-sheet__item'
                  }
                  aria-current={isTrash ? 'page' : undefined}
                  onClick={() => {
                    navigate(TRASH_PATH);
                    onClose();
                  }}
                >
                  <span aria-hidden="true">⊗ </span>Papierkorb
                </button>
              ) : null}
              {/*
                **The system administration** (finding 16) — one entry for the four
                tabs that were once three entries here, with the same marker as
                in the header. **Built is not reachable**: a view that only
                exists at 1280 px is not present on a phone (the rule).
              */}
              {isSuperadmin ? (
                <button
                  type="button"
                  className={
                    isSystemAdmin
                      ? 'app-sheet__item app-sheet__item--current'
                      : 'app-sheet__item'
                  }
                  aria-current={isSystemAdmin ? 'page' : undefined}
                  onClick={() => {
                    navigate(SYSTEM_PATH);
                    onClose();
                  }}
                >
                  <span aria-hidden="true">★ </span>Systemverwaltung
                </button>
              ) : null}
            </>
          ) : null}
        </nav>

        <p className="app-sheet__section">Organisation</p>
        <TenantList
          memberships={memberships}
          activeTenantId={activeTenantId}
          // The sheet covers the screen, so leaving it open after a switch
          // would hide the very view the switch was made for.
          onSwitched={onClose}
        />

        {/*
          **Mein Profil** — the entry that replaces „Andere Sitzungen beenden"
          (finding 17). The button stood here without context; the action now
          lives in the profile, next to the password change, and this entry
          leads there.
        */}
        <button
          type="button"
          className="app-sheet__item"
          onClick={() => {
            navigate(PROFILE_PATH);
            onClose();
          }}
        >
          Mein Profil
        </button>

        <button
          type="button"
          className="app-sheet__logout"
          onClick={onLogout}
          disabled={isLoggingOut}
        >
          {isLoggingOut ? 'Wird abgemeldet…' : 'Abmelden'}
        </button>
      </div>
    </div>
  );
}
