import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PRODUCT_NAME } from '../brand/ProductLockup';
import { DASHBOARD_PATH } from '../router/routes';
import { Cascade } from '../test/css-cascade';
import { setViewportWidth } from '../test/match-media';
import { renderWithQuery } from '../test/render-with-query';
import { UMBRELLA_TENANT_ID, membership } from '../test/fixtures';
import { AppHeader, type AppHeaderProps } from './AppHeader';

/**
 * **The header between 1180 and 1920 px** (finding 12) — and the brand as a
 * way onto the dashboard (finding 19).
 *
 * Before, the bar knew one width: above 1180 px a fixed row in which
 * `text-overflow: ellipsis` decided what happens when the entries no
 * longer fit into it. The result was „Tenant-Verwal…" on a 1300 px
 * wide screen — a target whose name is half missing, without
 * anything in the layout admitting that something is missing.
 *
 * What is measured is therefore at the five widths of the finding and in the four
 * role combinations that exist: a member (one entry), a superadmin
 * without an organisation (two), an organisation admin (three), a superadmin with an
 * organisation (four). The assurance is the same in both states —
 * **every entry keeps its full name**, visible or as an
 * accessible name.
 *
 * What a jsdom run cannot do is measure whether the labels
 * *really* fit next to each other; for that there is the measurement in
 * `e2e/shell-desktop.spec.ts`, which tests
 * `scrollWidth <= clientWidth` at the bar at the same five widths.
 */

const styles = Cascade.fromFile('src/shell/app-header.css');

const TENANT = membership(UMBRELLA_TENANT_ID, 'Musterstadt', 'MUST').tenant;

interface Roles {
  readonly canManageSettings: boolean;
  readonly canBuild: boolean;
  readonly isSuperadmin: boolean;
}

/** The four role combinations of the finding, with their number of entries. */
const ROLE_CASES: readonly {
  readonly label: string;
  readonly roles: Roles;
  readonly entries: readonly string[];
}[] = [
  {
    label: 'Mitglied',
    roles: {
      canManageSettings: false,
      canBuild: false,
      isSuperadmin: false,
    },
    entries: ['Dashboard'],
  },
  {
    label: 'Superadmin ohne Organisation',
    roles: { canManageSettings: false, canBuild: false, isSuperadmin: true },
    entries: ['Dashboard', 'Systemverwaltung'],
  },
  {
    label: 'Organisations-Admin',
    roles: { canManageSettings: true, canBuild: true, isSuperadmin: false },
    entries: ['Dashboard', 'Organisations-Verwaltung', 'Papierkorb'],
  },
  {
    label: 'Superadmin mit Organisation',
    roles: { canManageSettings: true, canBuild: true, isSuperadmin: true },
    entries: [
      'Dashboard',
      'Organisations-Verwaltung',
      'Papierkorb',
      'Systemverwaltung',
    ],
  },
];

function renderHeader(overrides: Partial<AppHeaderProps> = {}) {
  return renderWithQuery(
    <AppHeader
      userName="Alexandra Admin"
      activeTenant={TENANT}
      memberships={[membership(UMBRELLA_TENANT_ID, 'Musterstadt', 'MUST')]}
      activeTenantId={UMBRELLA_TENANT_ID}
      isDesktop
      isDashboard={false}
      isTenantDefaults={false}
      isSystemAdmin={false}
      isTrash={false}
      canManageSettings={false}
      canBuild={false}
      isSuperadmin={false}
      isMenuOpen={false}
      menuId="menu"
      onOpenMenu={vi.fn()}
      onLogout={vi.fn()}
      isLoggingOut={false}
      {...overrides}
    />,
  );
}

function navItem(name: string): HTMLElement {
  return within(screen.getByRole('navigation')).getByRole('button', { name });
}

/** The label of an entry — visible or visually hidden. */
function labelOf(name: string): Element {
  const found = navItem(name).querySelector('span:not([aria-hidden])');
  if (found === null) {
    throw new Error(`Der Eintrag „${name}" trägt keine Beschriftung.`);
  }
  return found;
}

beforeEach(() => {
  window.history.pushState(null, '', '/forms');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AppHeader — Navigation zwischen den Breiten', () => {
  it.each(ROLE_CASES)(
    '$label: jeder Eintrag behält bei 1180 px seinen vollen Namen',
    ({ entries, roles }) => {
      setViewportWidth(1180);
      renderHeader(roles);

      // The accessible name is the proof: it is the same whether the
      // label stands beside it or belongs to the screen reader alone. A
      // cut-off *visible* text would be invisible here — hence the
      // rule measurement further below, which shows that nothing is cut
      // any more.
      for (const entry of entries) {
        expect(navItem(entry)).toBeDefined();
      }
      expect(
        within(screen.getByRole('navigation')).getAllByRole('button'),
      ).toHaveLength(entries.length);
    },
  );

  it.each([1180, 1300, 1440, 1500, 1920])(
    'hält bei %i px in jeder Rolle jeden Eintrag erreichbar',
    (width) => {
      for (const { entries, roles } of ROLE_CASES) {
        setViewportWidth(width);
        const view = renderHeader(roles);

        for (const entry of entries) {
          expect(navItem(entry)).toBeDefined();
        }
        view.unmount();
      }
    },
  );

  it('zeigt dem Superadmin mit Organisation bei 1500 px nur die Zeichen', () => {
    // Exactly the case of the finding: four entries, and at 1500 px the
    // row was already not enough for the names.
    setViewportWidth(1500);
    renderHeader({
      canManageSettings: true,
      canBuild: true,
      isSuperadmin: true,
    });

    const item = navItem('Systemverwaltung');
    // The name travels along as a hidden label — it is thereby still
    // the accessible name, not merely a title attribute.
    expect(labelOf('Systemverwaltung').className).toBe('visually-hidden');
    // …and the mouse gets it as a tooltip, otherwise „★" would be a riddle.
    expect(item.getAttribute('title')).toBe('Systemverwaltung');
  });

  it('zeigt demselben Superadmin bei 1920 px die Beschriftungen', () => {
    setViewportWidth(1920);
    renderHeader({
      canManageSettings: true,
      canBuild: true,
      isSuperadmin: true,
    });

    expect(labelOf('Systemverwaltung').className).toBe('app-header__nav-label');
    // No title where the text stands beside it: a tooltip that repeats the visible
    // text is noise.
    expect(navItem('Systemverwaltung').getAttribute('title')).toBeNull();
  });

  it('gibt dem Organisations-Admin seine Beschriftungen schon bei 1440 px', () => {
    // The counter-check to the intermediate stage: it takes hold **by the number of entries**.
    // A single threshold for all roles would leave three entries on a
    // 1440 px screen as bare characters, although they fit effortlessly.
    setViewportWidth(1440);
    renderHeader({ canManageSettings: true, canBuild: true });

    expect(labelOf('Organisations-Verwaltung').className).toBe(
      'app-header__nav-label',
    );
  });

  it('gibt dem Mitglied seine Beschriftung an der Schwelle selbst', () => {
    setViewportWidth(1180);
    renderHeader();

    expect(labelOf('Dashboard').className).toBe('app-header__nav-label');
  });

  it('schneidet keine Beschriftung mehr ab — die Regel dazu ist weg', () => {
    // The actual regression test for finding 12. As long as
    // `text-overflow: ellipsis` stands on the entry, a name *can* half
    // disappear, and no width measurement sees it: the surplus text
    // is then cut off instead of overflowing.
    setViewportWidth(1300);
    renderHeader({
      canManageSettings: true,
      canBuild: true,
      isSuperadmin: true,
    });

    const item = navItem('Dashboard');
    expect(styles.declaredValue(item, 'text-overflow')).toBeUndefined();
    expect(styles.declaredValue(item, 'overflow')).toBeUndefined();
    expect(styles.declaredValue(item, 'flex')).toBe('none');
  });
});

describe('AppHeader — die Marke führt aufs Dashboard', () => {
  it('ist ein echter Anker mit dem Ziel im Namen', () => {
    renderHeader();

    const brand = screen.getByRole('link', { name: /Zum Dashboard/u });

    // An `href`, not only an `onClick`: middle click, „in neuem Tab öffnen"
    // and the browser's status line hang on it.
    expect(brand.getAttribute('href')).toBe(DASHBOARD_PATH);
    // And the target stands **in** the name, together with the organisation — otherwise
    // the link would be called „Formsache Musterstadt" and would not say where it leads.
    expect(brand.getAttribute('aria-label')).toBe(
      'Zum Dashboard von Musterstadt',
    );
    // Both stay visible: the kicker and the name of the organisation.
    expect(within(brand).getByText(PRODUCT_NAME)).toBeDefined();
    expect(within(brand).getByText('Musterstadt')).toBeDefined();
  });

  it('navigiert im selben Tab, statt das Dokument neu zu laden', () => {
    renderHeader();

    fireEvent.click(screen.getByRole('link', { name: /Zum Dashboard/u }));

    expect(window.location.pathname).toBe(DASHBOARD_PATH);
  });

  it('lässt den Eintrag „Dashboard" daneben stehen', () => {
    // A brand that navigates is a habit — no announced
    // target. The named entry therefore stays, and it is the one that
    // can carry `aria-current`.
    setViewportWidth(1920);
    renderHeader({ isDashboard: true });

    expect(navItem('Dashboard').getAttribute('aria-current')).toBe('page');
  });

  it('nennt ohne Organisation nur das Ziel', () => {
    renderWithQuery(
      <AppHeader
        userName="Alexandra Admin"
        activeTenant={undefined}
        memberships={[]}
        activeTenantId={null}
        isDesktop
        isDashboard={false}
        isTenantDefaults={false}
        isSystemAdmin={false}
        isTrash={false}
        canManageSettings={false}
        canBuild={false}
        isSuperadmin
        isMenuOpen={false}
        menuId="menu"
        onOpenMenu={vi.fn()}
        onLogout={vi.fn()}
        isLoggingOut={false}
      />,
    );

    expect(
      screen.getByRole('link', { name: 'Zum Dashboard' }).getAttribute('href'),
    ).toBe(DASHBOARD_PATH);
  });
});
