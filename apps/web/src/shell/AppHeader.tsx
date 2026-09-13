import type { ReactElement } from 'react';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { MembershipSummary, TenantSummary } from '@formsache/shared';

import {
  DASHBOARD_PATH,
  PROFILE_PATH,
  SYSTEM_PATH,
  TENANT_APPEARANCE_PATH,
  TRASH_PATH,
} from '../router/routes';
import { navigate, useLinkHandler } from '../router/use-route';
import { navLabelMediaQuery } from '../styles/breakpoints';
import { PRODUCT_NAME } from '../brand/ProductLockup';
import { TenantList } from './TenantList';
import { TenantMark } from './TenantMark';

import './app-header.css';

/** One destination of the header's navigation — see {@link AppHeader}. */
interface NavEntry {
  /** React key — stable per destination, not a position. */
  readonly id: string;
  /** The geometric glyph in front of the label; decorative, never the name. */
  readonly icon: string;
  /** The German label — visible above the label width, hidden below it. */
  readonly label: string;
  readonly path: string;
  /** Whether the route currently rendered is this destination. */
  readonly isCurrent: boolean;
}

/**
 * Whether the labels fit next to their symbols at the current width.
 *
 * The number comes from `styles/breakpoints.ts` and depends on how many
 * entries the signed-in role actually sees; this hook only subscribes to it.
 * `useSyncExternalStore` for the same reason as `useIsDesktop`: no render pass
 * with the wrong layout before an effect corrects it.
 */
function useNavLabels(entryCount: number): boolean {
  const query = navLabelMediaQuery(entryCount);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onStoreChange);

      return () => {
        list.removeEventListener('change', onStoreChange);
      };
    },
    [query],
  );
  const getSnapshot = useCallback(
    () => window.matchMedia(query).matches,
    [query],
  );

  return useSyncExternalStore(subscribe, getSnapshot, () => true);
}

export interface AppHeaderProps {
  readonly userName: string;
  /** The tenant of the active session, or `undefined` when none is scoped. */
  readonly activeTenant: TenantSummary | undefined;
  readonly memberships: readonly MembershipSummary[];
  readonly activeTenantId: string | null;
  /** Desktop layout above 1180 px — see `useIsDesktop`. */
  readonly isDesktop: boolean;
  /** Whether the route currently rendered is the dashboard. */
  readonly isDashboard: boolean;
  /** Whether one of the tenant administration's three tabs is currently rendered. */
  readonly isTenantDefaults: boolean;
  /**
   * Whether one of the four tabs of the system administration is open (finding 16) — one
   * marker for one entry, where there were once three for three.
   */
  readonly isSystemAdmin: boolean;
  /** Whether the trash is currently rendered. */
  readonly isTrash: boolean;
  /**
   * `can_manage_settings` of the **active** membership, as the server reported
   * it. Without it the entry is not rendered — a hidden control is a courtesy,
   * the guard behind the route is the boundary (`CONTRIBUTING.md`).
   */
  readonly canManageSettings: boolean;
  /**
   * `can_build` of the **active** membership — „löschen darf, wer bauen darf"
   * . Gates the trash entry the same way it already
   * gates „+ Neues Formular" on the dashboard; hidden without it is a
   * courtesy, `GET /trash` answers 403 regardless.
   */
  readonly canBuild: boolean;
  /**
   * `is_superadmin` of the signed-in **person** .
   *
   * Deliberately not a sixth group permission and deliberately not read off a
   * membership: whoever manages one organisation must not thereby decide the default
   * for all of them, and switching Organisationen changes nothing about it.
   */
  readonly isSuperadmin: boolean;
  readonly isMenuOpen: boolean;
  /** DOM id of the off-canvas sheet, for `aria-controls` on the hamburger. */
  readonly menuId: string;
  readonly onOpenMenu: () => void;
  readonly onLogout: () => void;
  readonly isLoggingOut: boolean;
}

/**
 * Global top header of the handoff: tenant mark and name on the left, the
 * actions on the right, the colour stripe underneath.
 *
 * **The handoff's "⚙ Verwaltung" dropdown, flattened into individual nav
 * items rather than kept as a popover.** A dropdown for entries that are
 * mostly hidden per-role would often collapse to a single item — a menu
 * promising more than it holds — so each destination gets its own button,
 * shown only when its guard would let the request through. "⊗ Papierkorb" is
 * gated on `canBuild` — „löschen darf, wer bauen darf" — the same flag that
 * gates „+ Neues Formular" on the dashboard.
 *
 * - **"⚙ Organisations-Verwaltung"** opens the first of the view's three tabs,
 *   *Erscheinungsbild & Login* — not the middle one. The address
 *   is `TENANT_APPEARANCE_PATH`; `isTenantDefaults` still covers all three
 *   sibling routes so the entry reads as current on any of them (see
 *   `AppShell`).
 * - **"★ Systemverwaltung"** is gated on `isSuperadmin` — the property of the
 *   *person*, not of a membership. It was once three things
 *   („Superadmin-Übersicht", „Systemeinstellungen", „Betrieb") and has been
 *   **one** entry since finding 16: three pages next to each other for a single role
 *   are not three destinations but one destination with three doors.
 *
 * **„✦ KI-Formular" is no longer here** (finding 18). The entry
 * did not navigate, it opened a dialog — in a bar in which every
 * other entry is an address. It creates a form and therefore now stands
 * where forms are created: on the dashboard, beside „+ Neues
 * Formular" (`DashboardView`).
 *
 * **The symbols are all geometric** (finding 14). „🗑" was the only
 * colour emoji of the bar, and an emoji renders from a different font: its own
 * glyph width, its own line box, no normalisation through `font-size` —
 * the trash entry therefore stood visibly larger than its neighbours,
 * although all of them share the same class and the same geometry. „⊗" comes from
 * the same text font as „▦ ⚙ ★ ✦".
 *
 * **The bar knows two widths above the hamburger** (finding 12). Above
 * `navLabelMinWidthPx` — the threshold depends on the *number* of entries,
 * i.e. on the role — the names stand beside their symbols; below it only
 * the symbol stands there, and the name travels along as a visually hidden label.
 * Nothing is cut off any more: `text-overflow: ellipsis` had turned
 * „Organisations-Verwaltung" into a „Tenant-Verwal…", and half a name is
 * not half a destination but one to be guessed.
 *
 * **The brand is a link to the dashboard** (finding 19) — logo, kicker and
 * organisation name together. The entry „▦ Dashboard" stays beside it: the
 * brand is a habit, not an announced destination, and `aria-current` cannot
 * carry it.
 *
 * What is here otherwise: the dashboard marker, the tenant selection —
 * switching included — and logout.
 */
export function AppHeader({
  userName,
  activeTenant,
  memberships,
  activeTenantId,
  isDesktop,
  isDashboard,
  isTenantDefaults,
  isSystemAdmin,
  isTrash,
  canManageSettings,
  canBuild,
  isSuperadmin,
  isMenuOpen,
  menuId,
  onOpenMenu,
  onLogout,
  isLoggingOut,
}: AppHeaderProps): ReactElement {
  /*
    The four destinations as data rather than as four hand-written buttons.
    Their *number* is what decides whether the labels fit (see
    `navLabelMinWidthPx`), and a list is the only shape in which the header can
    count them. Each one is still gated exactly as before — a hidden control is
    a courtesy, the guard behind the route is the boundary.
  */
  const navEntries: readonly NavEntry[] = [
    {
      id: 'dashboard',
      icon: '▦',
      label: 'Dashboard',
      path: DASHBOARD_PATH,
      isCurrent: isDashboard,
    },
    ...(canManageSettings
      ? [
          {
            id: 'tenant',
            icon: '⚙',
            label: 'Organisations-Verwaltung',
            path: TENANT_APPEARANCE_PATH,
            isCurrent: isTenantDefaults,
          },
        ]
      : []),
    ...(canBuild
      ? [
          {
            id: 'trash',
            icon: '⊗',
            label: 'Papierkorb',
            path: TRASH_PATH,
            isCurrent: isTrash,
          },
        ]
      : []),
    ...(isSuperadmin
      ? [
          {
            id: 'system',
            icon: '★',
            label: 'Systemverwaltung',
            path: SYSTEM_PATH,
            isCurrent: isSystemAdmin,
          },
        ]
      : []),
  ];
  const showNavLabels = useNavLabels(navEntries.length);
  const onBrandClick = useLinkHandler(DASHBOARD_PATH);
  const onProfileClick = useLinkHandler(PROFILE_PATH);

  const [isSwitcherOpen, setSwitcherOpen] = useState(false);
  const switcherId = useId();
  const switcherRef = useRef<HTMLDivElement>(null);
  /** The trigger that gets the focus back after Escape. */
  const switcherTriggerRef = useRef<HTMLButtonElement>(null);

  // A popover that only closes through its own button is a trap for anyone who
  // clicks past it, so Escape and a click outside close it as well.
  useEffect(() => {
    if (!isSwitcherOpen) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setSwitcherOpen(false);
        // **Only after Escape** (a review finding): without giving it back,
        // the focus lands at the start of the document, and the next tab key starts
        // the whole header from the beginning. After a press beside it, the focus stays
        // where the press pointed.
        switcherTriggerRef.current?.focus();
      }
    };
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && switcherRef.current?.contains(target)) {
        return;
      }
      setSwitcherOpen(false);
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [isSwitcherOpen]);

  // The desktop layout hides the switcher; leaving it "open" in state would
  // make it reappear on the next resize back to desktop.
  useEffect(() => {
    if (!isDesktop) {
      setSwitcherOpen(false);
    }
  }, [isDesktop]);

  return (
    <>
      <header className="app-header">
        {/*
          **The brand is the way to the dashboard** (finding 19).

          Logo, kicker and organisation name were `<span>`s — the place
          everybody clicks first when they want „zurück zum Anfang", and the
          only place in the header where nothing happened. Now a
          real anchor with `href`, so that middle click, „Link in neuem Tab
          öffnen" and the browser's status bar are right; `useLinkHandler`
          intercepts the plain left click and navigates on within the tab instead of
          reloading the document.

          The entry „▦ Dashboard" stays beside it: a brand that
          navigates is a habit, not an announced destination — and
          `aria-current` cannot carry it, because it is the same in every role and on
          every address.

          The accessible name names the destination **and** the organisation; without
          `aria-label` it would be „Formsache Musterstadt" and would not say where
          the click leads.
        */}
        <a
          className="app-header__brand"
          href={DASHBOARD_PATH}
          aria-label={
            activeTenant === undefined
              ? 'Zum Dashboard'
              : `Zum Dashboard von ${activeTenant.name}`
          }
          onClick={onBrandClick}
        >
          {activeTenant === undefined ? null : (
            <TenantMark tenant={activeTenant} />
          )}
          <span className="app-header__identity">
            {/*
              The name of the software, not of the installation (ADR-0019). Here
              stood „Formularsystem" — the working title that had survived the
              renaming, at the one place where the interface calls the
              product by its name. `PRODUCT_NAME` and no second
              spelling: typing the name twice means forgetting it
              once.
            */}
            <span className="app-header__kicker">{PRODUCT_NAME}</span>
            {/* PT Serif, always — with no resolvable logo asset this name is
                what the header falls back to. */}
            <span className="app-header__tenant">
              {activeTenant?.name ?? 'Keine Organisation ausgewählt'}
            </span>
          </span>
        </a>

        {isDesktop ? (
          <div className="app-header__switcher" ref={switcherRef}>
            <button
              ref={switcherTriggerRef}
              type="button"
              className="app-header__switcher-button"
              aria-expanded={isSwitcherOpen}
              aria-controls={switcherId}
              onClick={() => {
                setSwitcherOpen((open) => !open);
              }}
            >
              <span className="app-header__dot" aria-hidden="true" />
              Organisations-Auswahl
              <span className="app-header__caret" aria-hidden="true">
                ▼
              </span>
            </button>
            {isSwitcherOpen ? (
              <div className="app-header__popover" id={switcherId}>
                <TenantList
                  memberships={memberships}
                  activeTenantId={activeTenantId}
                  // A popover that stays open over the view it just changed
                  // hides the result of the action taken in it.
                  onSwitched={() => {
                    setSwitcherOpen(false);
                  }}
                />
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="app-header__spacer" />

        {isDesktop ? (
          <div className="app-header__actions">
            {/*
              **One step between the hamburger and the full bar** (finding 12).

              The entries stand as data at the top of the component, and their
              number decides from which width the labels fit
              (`navLabelMinWidthPx`). Below it every entry shows **only its
              symbol**; the name travels along as a visually hidden label
              and thereby stays the accessible name, `title` gives it to the
              mouse as a short hint. Previously `text-overflow: ellipsis` cut
              the names down to „Tenant-Verwal…" — half a destination that says
              nothing about being half a one.

              `<button onClick={navigate(...)}>` and no `<a href>`: this is
              navigation within the same tab, the same pattern as „Zurück
              zum Dashboard". `aria-current="page"` only as long as the address
              really is this one; a click from there is without consequence, because
              `navigate()` does not push an identical path a second time.
            */}
            <nav
              aria-label="Hauptnavigation"
              className={
                showNavLabels
                  ? 'app-header__nav'
                  : 'app-header__nav app-header__nav--icons'
              }
            >
              {navEntries.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className="app-header__nav-item"
                  aria-current={entry.isCurrent ? 'page' : undefined}
                  title={showNavLabels ? undefined : entry.label}
                  onClick={() => {
                    navigate(entry.path);
                  }}
                >
                  <span className="app-header__nav-icon" aria-hidden="true">
                    {entry.icon}
                  </span>
                  <span
                    className={
                      showNavLabels
                        ? 'app-header__nav-label'
                        : 'visually-hidden'
                    }
                  >
                    {entry.label}
                  </span>
                </button>
              ))}
            </nav>
            {/*
              **„Angemeldet als …" is now the way into the profile** (finding 17).

              Previously there was a text here and beside it a button „Andere
              Sitzungen beenden" — an action without context, between a
              statement and an „Abmelden". The button has moved into the profile,
              next to the password change, and what stays here leads
              there: the same text, now as an address, under which name,
              password and one's own sessions stand together.

              An anchor and no `onClick` button: it is a navigation, and
              middle click, keyboard and screen reader already understand an
              anchor. `useLinkHandler` intercepts the plain click — without it
              the browser reloads the whole application, because there is no global
              click interception.
            */}
            <a
              className="app-header__user"
              href={PROFILE_PATH}
              onClick={onProfileClick}
            >
              Angemeldet als {userName}
            </a>
            <button
              type="button"
              className="app-header__logout"
              onClick={onLogout}
              disabled={isLoggingOut}
            >
              {isLoggingOut ? 'Wird abgemeldet…' : 'Abmelden'}
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="app-header__hamburger"
            aria-label="Menü öffnen"
            aria-expanded={isMenuOpen}
            aria-controls={menuId}
            onClick={onOpenMenu}
          >
            <span aria-hidden="true">☰</span>
          </button>
        )}
      </header>
      {/* Colour stripe of the tenant, directly under the header bar. */}
      <div className="app-header__stripe" />
    </>
  );
}
