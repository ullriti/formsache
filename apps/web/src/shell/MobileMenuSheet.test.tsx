import { fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { UMBRELLA_TENANT_ID, membership, permissions } from '../test/fixtures';
import { renderWithQuery } from '../test/render-with-query';
import { notificationsPath } from '../router/routes';
import { MobileMenuSheet } from './MobileMenuSheet';

/**
 * The off-canvas menu below 1180 px — specifically its section **„Aktuelles
 * Formular"** (Handoff, „Informationsarchitektur/Navigation"), which arrives
 * with the notifications and the mail log.
 *
 * Rendered directly rather than through `AppShell`: the section only exists on
 * a form address, and going through the shell would mount a whole view with its
 * queries to assert five buttons.
 */

const FORM_ID = '019fe700-0000-7000-8000-000000000001';

function renderSheet(
  overrides: Partial<Parameters<typeof MobileMenuSheet>[0]> = {},
) {
  const onClose = vi.fn();
  renderWithQuery(
    <MobileMenuSheet
      id="sheet"
      userName="Test"
      memberships={[membership(UMBRELLA_TENANT_ID, 'Dachorganisation', 'DACH')]}
      activeTenantId={UMBRELLA_TENANT_ID}
      isDashboard={false}
      isTenantDefaults={false}
      isSystemAdmin={false}
      isTrash={false}
      canManageSettings
      canBuild
      isSuperadmin={false}
      formPermissions={permissions()}
      formId={FORM_ID}
      route={{ kind: 'builder', formId: FORM_ID }}
      onClose={onClose}
      onLogout={vi.fn()}
      isLoggingOut={false}
      {...overrides}
    />,
  );
  return { onClose };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MobileMenuSheet — Aktuelles Formular', () => {
  it('carries the same entries as the desktop subheader', () => {
    renderSheet();

    expect(screen.getByText('Aktuelles Formular')).toBeDefined();
    for (const name of [
      /Bearbeiten/,
      /Antworten/,
      /Benachrichtigungen/,
      /E-Mail-Versandprotokoll/,
      /Formular-Einstellungen/,
      /Nutzerrechte/,
    ]) {
      expect(screen.getByRole('button', { name })).toBeDefined();
    }
  });

  /**
   * A heading over nothing is the empty promise out — on
   * an address that is about no form the whole section is absent.
   */
  it('is absent where there is no current form', () => {
    renderSheet({ formId: null, route: { kind: 'dashboard' } });

    expect(screen.queryByText('Aktuelles Formular')).toBeNull();
    expect(
      screen.queryByRole('button', { name: /Benachrichtigungen/ }),
    ).toBeNull();
  });

  it('navigates and closes the sheet', () => {
    const { onClose } = renderSheet();

    fireEvent.click(screen.getByRole('button', { name: /Benachrichtigungen/ }));

    expect(window.location.pathname).toBe(notificationsPath(FORM_ID));
    expect(onClose).toHaveBeenCalled();
  });

  it('hides the mail log from a role holding only one of the two flags', () => {
    renderSheet({ formPermissions: permissions({ canViewResponses: false }) });

    expect(
      screen.queryByRole('button', { name: /E-Mail-Versandprotokoll/ }),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: /Benachrichtigungen/ }),
    ).toBeDefined();
  });

  /**
   * The same regression — the sheet builds from the same `formNavEntries()`, so the
   * flag has to reach it too: a sheet still offering „Bearbeiten" while the
   * desktop subheader dropped it is the drift that shared function exists to
   * prevent.
   */
  it('hides Bearbeiten without can_build', () => {
    renderSheet({ formPermissions: permissions({ canBuild: false }) });

    expect(screen.queryByRole('button', { name: /Bearbeiten/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Antworten/ })).toBeDefined();
  });

  /**
   * With no reachable entry at all the heading would stand over nothing, which
   * reads as a menu that failed to load — the section goes instead.
   */
  it('drops the whole section when no entry is reachable', () => {
    renderSheet({
      formPermissions: permissions({
        canBuild: false,
        canViewResponses: false,
        canManageSettings: false,
        canManageFormSettings: false,
        canManageUsers: false,
      }),
    });

    expect(screen.queryByText('Aktuelles Formular')).toBeNull();
    // The rest of the menu is untouched — this is about one section.
    expect(screen.getByRole('button', { name: /Dashboard/ })).toBeDefined();
  });

  /**
   * Since ADR-0021 two rights open the entry — it is gone only once both are
   * missing. See `FormNav.test.tsx`, where the same pure function stands in all
   * combinations; here it is about the sheet **using** it and not carrying a
   * list of its own.
   */
  it('hides Nutzerrechte only when both rights are gone', () => {
    renderSheet({
      formPermissions: permissions({
        canManageUsers: false,
        canManageFormSettings: false,
      }),
    });

    expect(screen.queryByRole('button', { name: /Nutzerrechte/ })).toBeNull();
    // Not gone because the section would be empty.
    expect(screen.getByRole('button', { name: /Antworten/ })).toBeDefined();
  });

  it('zeigt Nutzerrechte ohne can_manage_users, aber mit can_manage_form_settings', () => {
    renderSheet({ formPermissions: permissions({ canManageUsers: false }) });

    expect(screen.getByRole('button', { name: /Nutzerrechte/ })).toBeDefined();
    expect(
      screen.getByRole('button', { name: /Formular-Einstellungen/ }),
    ).toBeDefined();
  });
});

/**
 * **„✦ KI-Formular" is no longer in the menu** (finding 18).
 *
 * The entry sat in **Allgemein**, right after „Dashboard", and was the only one
 * of the bar that did not navigate: it opened a dialog. It creates a form and
 * therefore now stands where forms are created — on the dashboard, next to
 * „+ Neues Formular" (`views/DashboardView.test.tsx`).
 *
 * This test is the counter-check: the sheet offers it **nowhere** any more, not
 * under a different heading either.
 */
describe('MobileMenuSheet — ✦ KI-Formular (Befund 18)', () => {
  it('offers no KI entry at all any more', () => {
    renderSheet({});

    expect(screen.queryByRole('button', { name: /KI-Formular/ })).toBeNull();
    expect(
      screen
        .getAllByRole('button')
        .some((button) => button.textContent.includes('KI')),
    ).toBe(false);
  });
});

/**
 * **One entry for the system administration** (finding 16).
 *
 * There were three — „Superadmin-Übersicht", „Systemeinstellungen", „Betrieb" —
 * for a single role, directly below one another.
 */
describe('MobileMenuSheet — Systemverwaltung (Befund 16)', () => {
  it('replaces the three superadmin entries with one', () => {
    renderSheet({ isSuperadmin: true });

    expect(
      screen.getByRole('button', { name: /Systemverwaltung/ }),
    ).not.toBeNull();
    for (const gone of [
      'Superadmin-Übersicht',
      'Systemeinstellungen',
      'Betrieb',
    ]) {
      expect(
        screen
          .getAllByRole('button')
          .some((button) => button.textContent.includes(gone)),
      ).toBe(false);
    }
  });

  it('leads to the first of the four tabs and closes the menu', () => {
    const onClose = vi.fn();
    renderSheet({ isSuperadmin: true, onClose });

    fireEvent.click(screen.getByRole('button', { name: /Systemverwaltung/ }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe('/admin/system');
  });

  // Hiding is a courtesy, the guard is the boundary — but the entry is only
  // offered to whoever the routes behind it answer.
  it('is absent without the superadmin flag', () => {
    renderSheet({ isSuperadmin: false });

    expect(
      screen.queryByRole('button', { name: /Systemverwaltung/ }),
    ).toBeNull();
  });

  /**
   * Finding 14 — no colour emoji in the bar. „🗑" renders from a different font
   * and therefore stood there larger than its neighbours.
   */
  it('draws the Papierkorb with a geometric glyph, not an emoji', () => {
    renderSheet({});

    const entry = screen.getByRole('button', { name: /Papierkorb/ });
    expect(entry.textContent).toContain('⊗');
    expect(entry.textContent).not.toContain('🗑');
  });
});

/**
 * **„Andere Sitzungen beenden" is no longer in the menu** (finding 17).
 *
 * The button was here — without context, without a session list, between the
 * organization switch and signing out. The action is right and lives on, only
 * in a place where it can be explained: in the profile, next to the password
 * change (`apps/web/src/views/ProfileView.tsx`). What remains here is the way
 * there.
 *
 * The server side is unchanged and still evidenced in
 * `apps/api/test/auth/session-revocation.spec.ts`.
 */
describe('MobileMenuSheet — der Weg ins Profil (Befund 17)', () => {
  it('bietet „Mein Profil" an und nicht mehr den Sitzungs-Knopf', () => {
    renderSheet({});

    expect(
      screen.queryByRole('button', { name: 'Andere Sitzungen beenden' }),
    ).toBeNull();
    expect(screen.getByRole('button', { name: 'Mein Profil' })).not.toBeNull();
  });

  it('führt auf `/profile` und schließt dabei das Menü', () => {
    const onClose = vi.fn();
    renderSheet({ onClose });

    fireEvent.click(screen.getByRole('button', { name: 'Mein Profil' }));

    // The sheet covers the screen; staying open would cover exactly the page
    // one clicked for.
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe('/profile');
  });
});
