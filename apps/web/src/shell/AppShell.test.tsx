import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { emptyResponse, jsonResponse, stubFetch } from '../test/fetch-mock';
import {
  UMBRELLA_TENANT_ID,
  OTHER_TENANT_ID,
  membership,
  permissions,
  sessionUser,
} from '../test/fixtures';
import beispielSignetUrl from '../assets/beispiel-signet.svg';
import { setViewportWidth } from '../test/match-media';
import { renderWithQuery } from '../test/render-with-query';
import { mailLogPath } from '../router/routes';
import { navigate } from '../router/use-route';
import { AppShell } from './AppShell';

/**
 * A fetch response that never settles — parks whatever view mounts after
 * navigation in its loading state, so a test about the *address* is not also
 * a test about that view's data. The executor deliberately never calls
 * `resolve`.
 */
function pendingForever(): Promise<Response> {
  // eslint-disable-next-line @typescript-eslint/no-empty-function -- deliberately never resolved
  return new Promise<Response>(() => {});
}

const bothMemberships = [
  membership(UMBRELLA_TENANT_ID, 'Dachorganisation', 'DACH', {
    kind: 'asset',
    ref: 'assets/beispiel-signet.svg',
  }),
  membership(OTHER_TENANT_ID, 'Ortsgruppe Musterstadt', 'MUS'),
];

/**
 * Two memberships and **no** active tenant — what the server actually sends
 * after such an account logs in: it scopes a session only when the choice is
 * unambiguous (`sessionUser()` derives that, see `test/fixtures.ts`).
 */
const twoTenantsUnscoped = sessionUser({ memberships: bothMemberships });

/**
 * Two memberships *with* a scope. Reachable through the session-tenant
 * endpoint, not through the login — kept apart from the state above because
 * the shell has to be right about both.
 */
const twoTenantsScoped = sessionUser({
  memberships: bothMemberships,
  activeTenantId: UMBRELLA_TENANT_ID,
});

describe('AppShell', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('desktop (≥ 1180 px)', () => {
    it('shows the tenant name and the bundled logo in the header', () => {
      renderWithQuery(<AppShell user={twoTenantsScoped} />);

      expect(screen.getByText('Dachorganisation')).toBeDefined();
      // Compared against the import, not against a filename fragment: Vite
      // inlines assets below its size threshold as a data URI, so whether the
      // name survives into `src` is the bundler's decision, not this view's.
      expect(screen.getByTestId('tenant-logo').getAttribute('src')).toBe(
        beispielSignetUrl,
      );
    });

    it('falls back to the tenant name when no logo asset resolves', () => {
      renderWithQuery(
        <AppShell
          user={sessionUser({
            memberships: [
              membership(UMBRELLA_TENANT_ID, 'Ortsgruppe Musterstadt', 'MUS'),
            ],
          })}
        />,
      );

      expect(screen.queryByTestId('tenant-logo')).toBeNull();
      expect(screen.getByText('Ortsgruppe Musterstadt')).toBeDefined();
    });

    it('lists the tenants and marks the active one', () => {
      renderWithQuery(<AppShell user={twoTenantsScoped} />);

      const trigger = screen.getByRole('button', {
        name: /Organisations-Auswahl/,
      });
      expect(trigger.getAttribute('aria-expanded')).toBe('false');

      fireEvent.click(trigger);
      expect(trigger.getAttribute('aria-expanded')).toBe('true');

      const rows = screen.getAllByRole('listitem');
      expect(rows).toHaveLength(2);

      const activeRow = rows.find(
        (row) => within(row).queryByText('Aktiv') !== null,
      );
      expect(activeRow?.textContent).toContain('Dachorganisation');
    });

    /**
     * The requirement. Every row is a real button — reachable by Tab and
     * operable with Enter, which a clickable `<li>` would not be — and the
     * active one is disabled, because switching to where one already is costs
     * a round trip and a full cache invalidation for no change.
     */
    it('offers every tenant as a control and disables the active one', () => {
      renderWithQuery(<AppShell user={twoTenantsScoped} />);
      fireEvent.click(
        screen.getByRole('button', { name: /Organisations-Auswahl/ }),
      );

      const rows = screen.getAllByRole('listitem');
      const controls = rows.map((row) => within(row).getByRole('button'));

      expect(controls).toHaveLength(2);
      const active = controls.find((control) =>
        control.textContent.includes('Aktiv'),
      );
      const other = controls.find((control) => control !== active);
      expect((active as HTMLButtonElement).disabled).toBe(true);
      expect((other as HTMLButtonElement).disabled).toBe(false);
    });

    it('switches the session into the chosen tenant', async () => {
      const fetchMock = stubFetch().mockResolvedValue(
        jsonResponse(
          200,
          sessionUser({
            memberships: bothMemberships,
            activeTenantId: OTHER_TENANT_ID,
          }),
        ),
      );

      renderWithQuery(<AppShell user={twoTenantsScoped} />);
      fireEvent.click(
        screen.getByRole('button', { name: /Organisations-Auswahl/ }),
      );
      fireEvent.click(
        screen.getByRole('button', { name: /Ortsgruppe Musterstadt/ }),
      );

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          '/api/session/tenant',
          expect.objectContaining({
            method: 'PUT',
            body: JSON.stringify({ tenantId: OTHER_TENANT_ID }),
          }),
        );
      });
    });

    /**
     * The state the login of a two-membership account really produces: the
     * server scopes no tenant, every tenant-bound request would answer 403.
     * There is a way out, so the shell has to name it — an empty
     * dashboard next to a header reading "Keine Organisation ausgewählt" is a dead
     * end the user cannot even describe, let alone leave.
     */
    it('explains the dead end when the session is scoped to no tenant', () => {
      renderWithQuery(<AppShell user={twoTenantsUnscoped} />);

      expect(screen.getByText('Keine Organisation ausgewählt')).toBeDefined();
      expect(
        screen.getByText(/Die Anmeldung hat diese Sitzung keiner Organisation/),
      ).toBeDefined();

      fireEvent.click(
        screen.getByRole('button', { name: /Organisations-Auswahl/ }),
      );
      const rows = screen.getAllByRole('listitem');
      expect(rows).toHaveLength(2);
      // No row may claim a scope the session does not have.
      expect(
        rows.every((row) => within(row).queryByText('Aktiv') === null),
      ).toBe(true);
      expect(
        screen.getByText(/Diese Sitzung ist keiner Organisation zugeordnet/),
      ).toBeDefined();
    });

    /**
     * The header's "Dashboard" entry used to be a static `<span>`
     * that never navigated (a leftover from when the dashboard was the
     * only view). It has to be a real control now that the builder and the
     * responses view exist, and it may only claim to be the current page
     * while the route actually is the dashboard.
     */
    it('navigates to the dashboard from the header and marks it current only there', () => {
      window.history.pushState({}, '', '/gibt-es-nicht');
      try {
        renderWithQuery(<AppShell user={twoTenantsScoped} />);

        const dashboardButton = screen.getByRole('button', {
          name: 'Dashboard',
        });
        expect(dashboardButton.getAttribute('aria-current')).toBeNull();

        fireEvent.click(dashboardButton);

        expect(
          screen.getByRole('heading', { level: 1, name: 'Dashboard' }),
        ).toBeDefined();
        expect(
          screen
            .getByRole('button', { name: 'Dashboard' })
            .getAttribute('aria-current'),
        ).toBe('page');
      } finally {
        window.history.pushState({}, '', '/');
      }
    });

    /**
     * The pair the requirement needs on the client side: the entry appears with
     * `can_manage_settings` and is **absent** without it. The route behind it
     * answers 403 either way — the hidden control is a courtesy, not the
     * boundary — but a test that only ever saw the permitted case would let a
     * later refactor show the door to everyone and stay green.
     */
    describe('the Organisations-Verwaltung entry', () => {
      const withFlag = sessionUser({
        memberships: [
          membership(
            UMBRELLA_TENANT_ID,
            'Dachorganisation',
            'Dachorganisation',
          ),
        ],
      });
      const withoutFlag = sessionUser({
        memberships: [
          membership(
            UMBRELLA_TENANT_ID,
            'Dachorganisation',
            'Dachorganisation',
            null,
            {
              canManageSettings: false,
              canManageFormSettings: false,
            },
          ),
        ],
      });

      it('is offered to a role that may manage settings', () => {
        renderWithQuery(<AppShell user={withFlag} />);

        expect(
          screen.getByRole('button', { name: 'Organisations-Verwaltung' }),
        ).toBeDefined();
      });

      it('is absent for a role that may not', () => {
        renderWithQuery(<AppShell user={withoutFlag} />);

        expect(
          screen.queryByRole('button', { name: 'Organisations-Verwaltung' }),
        ).toBeNull();
      });

      /**
       * The entry opens the *first* tab, Erscheinungsbild & Login
       * — not the middle one it used to point at when only the
       * middle tab existed.
       */
      it('navigates to the first tab, not the middle one', () => {
        // The destination view fetches on mount; parked in a permanent
        // pending state because only the address, not the view's content, is
        // under test here.
        stubFetch().mockImplementation(pendingForever);

        try {
          renderWithQuery(<AppShell user={withFlag} />);

          fireEvent.click(
            screen.getByRole('button', { name: 'Organisations-Verwaltung' }),
          );

          expect(window.location.pathname).toBe('/admin/appearance');
        } finally {
          window.history.pushState({}, '', '/');
        }
      });
    });

    /**
     * The trash entry — gated on `canBuild`,
     * „löschen darf, wer bauen darf", the same flag „+ Neues Formular" reads
     * on the dashboard. Same pair-of-cases shape as the tenant administration
     * block above, plus the reachability case Lehre 3 (`CONTRIBUTING.md`) asks
     * for: a route can parse and a view can exist while `AppShell`'s render
     * switch never grows a branch for either, answering 404 to everyone
     * regardless of who asked — a case that only pushes the address straight
     * in is what catches that.
     */
    describe('the Papierkorb entry', () => {
      const withFlag = sessionUser({
        memberships: [
          membership(
            UMBRELLA_TENANT_ID,
            'Dachorganisation',
            'Dachorganisation',
          ),
        ],
      });
      const withoutFlag = sessionUser({
        memberships: [
          membership(
            UMBRELLA_TENANT_ID,
            'Dachorganisation',
            'Dachorganisation',
            null,
            { canBuild: false },
          ),
        ],
      });

      it('is offered to a role that may build', () => {
        renderWithQuery(<AppShell user={withFlag} />);

        expect(
          screen.getByRole('button', { name: 'Papierkorb' }),
        ).toBeDefined();
      });

      it('is absent for a role that may not', () => {
        renderWithQuery(<AppShell user={withoutFlag} />);

        expect(screen.queryByRole('button', { name: 'Papierkorb' })).toBeNull();
      });

      it('navigates to /admin/trash', () => {
        stubFetch().mockImplementation(pendingForever);
        try {
          renderWithQuery(<AppShell user={withFlag} />);

          fireEvent.click(screen.getByRole('button', { name: 'Papierkorb' }));

          expect(window.location.pathname).toBe('/admin/trash');
          expect(
            screen
              .getByRole('button', { name: 'Papierkorb' })
              .getAttribute('aria-current'),
          ).toBe('page');
        } finally {
          window.history.pushState({}, '', '/');
        }
      });

      it('reaches the Papierkorb at its address instead of 404', () => {
        window.history.pushState({}, '', '/admin/trash');
        try {
          renderWithQuery(<AppShell user={withFlag} />);

          expect(screen.getByText('Papierkorb wird geladen…')).toBeDefined();
          expect(screen.queryByText('Diese Seite gibt es nicht.')).toBeNull();
        } finally {
          window.history.pushState({}, '', '/');
        }
      });

      /**
       * The one line that puts Konzept no. 65 on the surface — review finding 3.
       *
       * `canPurge={canBuild && canViewResponses}` was covered nowhere: the
       * view's own tests take the prop as given, and the E2E suite runs as a
       * superadmin who holds both flags, so `&&` → `||` stayed green across
       * the whole 1087/132. All four combinations are spelled out here, and
       * the two mixed ones are the ones that measure something — a role with
       * exactly one of the pair.
       *
       * **`canPurge` is comfort, never the boundary** (`TrashView`'s own
       * docblock): the three routes behind the controls ask the same pair
       * again. What is asserted here is that the surface does not offer a
       * control the server would then refuse.
       */
      describe('canPurge — the stronger pair of Konzept Nr. 65', () => {
        const deletedForm = {
          id: '00000000-0000-4000-8000-0000000000c1',
          title: 'Bestandsmeldung 2026',
          responseCount: 2,
          deletedAt: '2026-07-20T10:00:00.000Z',
        };

        afterEach(() => {
          window.history.pushState({}, '', '/');
        });

        /**
         * Opens the trash at its address for a membership with exactly
         * these flags, and waits for the list — not the loading state: both
         * controls live behind that load, and asserting their absence against
         * a view that never rendered would pass for the wrong reason.
         */
        async function openTrashWith(
          overrides: Parameters<typeof permissions>[0],
        ): Promise<void> {
          stubFetch().mockImplementation((input: unknown) => {
            const url = String(input);
            if (url.endsWith('/api/trash')) {
              return Promise.resolve(
                jsonResponse(200, { forms: [deletedForm], responses: [] }),
              );
            }
            return pendingForever();
          });
          window.history.pushState({}, '', '/admin/trash');
          renderWithQuery(
            <AppShell
              user={sessionUser({
                memberships: [
                  membership(
                    UMBRELLA_TENANT_ID,
                    'Dachorganisation',
                    'Dachorganisation',
                    null,
                    overrides,
                  ),
                ],
              })}
            />,
          );
          await waitFor(() => {
            expect(screen.getByText('Bestandsmeldung 2026')).toBeDefined();
          });
        }

        it('offers both purge controls to a role holding the whole pair', async () => {
          await openTrashWith({ canBuild: true, canViewResponses: true });

          expect(
            screen.getByRole('button', { name: /Papierkorb leeren/ }),
          ).toBeDefined();
          expect(
            screen.getByRole('button', { name: /endgültig löschen/iu }),
          ).toBeDefined();
        });

        it('offers neither to a Bearbeiter without „Antworten ansehen"', async () => {
          await openTrashWith({ canBuild: true, canViewResponses: false });

          expect(
            screen.queryByRole('button', { name: /Papierkorb leeren/ }),
          ).toBeNull();
          expect(
            screen.queryByRole('button', { name: /endgültig löschen/iu }),
          ).toBeNull();
          // …while the reversible way back stays offered: this is the pair,
          // not the page (`canBuild` alone already opened it).
          expect(
            screen.getByRole('button', { name: /Wiederherstellen/ }),
          ).toBeDefined();
        });

        it('offers neither to a role that may see answers but not build', async () => {
          await openTrashWith({ canBuild: false, canViewResponses: true });

          expect(
            screen.queryByRole('button', { name: /Papierkorb leeren/ }),
          ).toBeNull();
          expect(
            screen.queryByRole('button', { name: /endgültig löschen/iu }),
          ).toBeNull();
        });

        it('offers neither to a role holding neither flag', async () => {
          await openTrashWith({ canBuild: false, canViewResponses: false });

          expect(
            screen.queryByRole('button', { name: /Papierkorb leeren/ }),
          ).toBeNull();
          expect(
            screen.queryByRole('button', { name: /endgültig löschen/iu }),
          ).toBeNull();
        });
      });
    });

    /**
     * The same pair for the system layer — and the
     * difference to the entry above is the point: `is_superadmin` hangs on the
     * **person**, so it is not read off a membership and an organisation's own
     * `can_manage_settings` must not produce it.
     *
     * The second case is the one that measures something: a full admin of the
     * active Organisation — all five group permissions — must **not** see the door to
     * the settings of every other organisation. A user who happens to have no rights at
     * all would only prove that some flag is being read.
     */
    describe('the Systemverwaltung entry', () => {
      const superadmin = sessionUser({
        isSuperadmin: true,
        memberships: [
          membership(
            UMBRELLA_TENANT_ID,
            'Dachorganisation',
            'Dachorganisation',
          ),
        ],
      });
      const tenantAdmin = sessionUser({
        memberships: [
          membership(
            UMBRELLA_TENANT_ID,
            'Dachorganisation',
            'Dachorganisation',
          ),
        ],
      });

      it('is offered to a superadmin', () => {
        renderWithQuery(<AppShell user={superadmin} />);

        expect(
          screen.getByRole('button', { name: 'Systemverwaltung' }),
        ).toBeDefined();
      });

      /**
       * **One entry, not three** (finding 16). The three old names are the
       * counter-check: if one of them stayed, the merge would have
       * left a corpse in the bar.
       */
      it('replaces the three former superadmin entries', () => {
        renderWithQuery(<AppShell user={superadmin} />);

        const labels = screen
          .getAllByRole('button')
          .map((button) => button.textContent);
        for (const gone of [
          'Superadmin-Übersicht',
          'Systemeinstellungen',
          'Betrieb',
        ]) {
          expect(labels.some((label) => label.includes(gone))).toBe(false);
        }
      });

      it('is absent for an admin of the active Organisation', () => {
        expect(tenantAdmin.isSuperadmin).toBe(false);
        expect(tenantAdmin.memberships[0]?.permissions.canManageSettings).toBe(
          true,
        );

        renderWithQuery(<AppShell user={tenantAdmin} />);

        expect(
          screen.queryByRole('button', { name: 'Systemverwaltung' }),
        ).toBeNull();
        // …while the tenant administration stays reachable, so the assertion
        // above cannot pass because the whole section disappeared.
        expect(
          screen.getByRole('button', { name: 'Organisations-Verwaltung' }),
        ).toBeDefined();
      });

      /**
       * The one entry reads „page" on **all four** tabs — otherwise
       * it would go out the moment somebody moves on within the view,
       * and the bar would claim one is nowhere.
       */
      it('reads as current on every one of the four tabs', () => {
        stubFetch().mockImplementation(pendingForever);
        for (const path of [
          '/admin/system',
          '/admin/system/monitoring',
          '/admin/system/mail',
          '/admin/system/ai',
        ]) {
          window.history.pushState({}, '', path);
          try {
            const view = renderWithQuery(<AppShell user={superadmin} />);

            expect(
              screen
                .getByRole('button', { name: 'Systemverwaltung' })
                .getAttribute('aria-current'),
            ).toBe('page');
            view.unmount();
          } finally {
            window.history.pushState({}, '', '/');
          }
        }
      });

      /*
        Hier standen drei Fälle über die **Weiterleitung** alter Adressen der
        Systemverwaltung (Befund 16): dass `/verwaltung/superadmin` und die
        beiden Nachbarn auf ihren Reiter führten, dass die Adresszeile dabei
        mit `replace` heilte, und dass sie das auch dann tat, wenn alte und
        neue Adresse dieselbe Route ergeben.

        Sie sind mit ihrem Gegenstand fort. Review-Runde 4 Nr. 8 hat alle Pfade
        auf Englisch gezogen und dafür ausdrücklich den harten Schnitt gewählt
        — es gibt keine Weiterleitungstabelle mehr, und damit auch nichts, was
        diese Fälle noch messen könnten. Die Begründung steht in
        [ADR-0030](../../../../docs/architecture/0030-englische-url-pfade.md).
      */
    });

    /**
     * **The start page of a superadmin without an organization** (findings 15
     * and 26) — the switch itself, which up to here was measured nowhere.
     *
     * Where to is decided by `startPath` (checked there too). What is measured
     * here is the *when*: that the switch strikes after the login, that
     * it does **not** do so with an existing membership, and that it
     * stays silent on the **second** visit to `/` — otherwise the entry
     * „Dashboard" in the header would be a button that does not do what it says on it.
     */
    describe('die Startseite nach der Anmeldung', () => {
      const homeless = sessionUser({ isSuperadmin: true, memberships: [] });
      const settled = sessionUser({
        isSuperadmin: true,
        memberships: [
          membership(
            UMBRELLA_TENANT_ID,
            'Dachorganisation',
            'Dachorganisation',
          ),
        ],
      });

      afterEach(() => {
        window.history.pushState({}, '', '/');
      });

      it('schickt einen Superadmin ohne Mitgliedschaft in die Systemverwaltung', () => {
        stubFetch().mockImplementation(pendingForever);
        renderWithQuery(<AppShell user={homeless} />);

        expect(window.location.pathname).toBe('/admin/system');
        expect(
          screen.getByText('Organisationen werden geladen…'),
        ).toBeDefined();
      });

      /**
       * The counter-check on the same path: the same person, only with an
       * organization. „Superadmin" alone must not trigger the switch —
       * otherwise nobody with a membership would ever arrive at their dashboard.
       */
      it('lässt einen Superadmin mit Mitgliedschaft auf dem Dashboard', () => {
        stubFetch().mockImplementation(pendingForever);
        renderWithQuery(<AppShell user={settled} />);

        expect(window.location.pathname).toBe('/');
        expect(
          screen.getByRole('heading', { level: 1, name: 'Dashboard' }),
        ).toBeDefined();
      });

      /**
       * **The second visit to `/`** — the promise in the comment at the switch,
       * and the reason it hangs on a `useRef` instead of on the address.
       * After the landing the header's „Dashboard" entry leads back
       * to `/`; if the switch struck again there, it would immediately push away
       * again, and the entry would be inoperable.
       */
      it('schlägt beim zweiten Besuch von „/" nicht noch einmal zu', () => {
        stubFetch().mockImplementation(pendingForever);
        renderWithQuery(<AppShell user={homeless} />);
        expect(window.location.pathname).toBe('/admin/system');

        fireEvent.click(screen.getByRole('button', { name: 'Dashboard' }));

        expect(window.location.pathname).toBe('/');
        expect(
          screen.getByRole('heading', { level: 1, name: 'Dashboard' }),
        ).toBeDefined();
      });
    });

    /**
     * The address renders the page — and it renders it for **whoever asks**,
     * superadmin or not.
     *
     * There is no client-side gate in front of it on purpose: the guard on the
     * route is the boundary, and a second authority in the shell would be the
     * one that is wrong first, because it cannot see the session
     * (`CONTRIBUTING.md`). What a non-superadmin gets here is the server's 403,
     * spelled out — not a 404 that turns an answer into a riddle.
     */
    it('renders the Systemverwaltung at its address, and lets the server refuse', async () => {
      stubFetch().mockResolvedValue(jsonResponse(403, { message: 'nope' }));
      window.history.pushState({}, '', '/admin/system/mail');
      try {
        renderWithQuery(
          <AppShell
            user={sessionUser({
              memberships: [
                membership(
                  UMBRELLA_TENANT_ID,
                  'Dachorganisation',
                  'Dachorganisation',
                ),
              ],
            })}
          />,
        );

        await waitFor(() => {
          expect(screen.getByRole('alert').textContent).toContain(
            'Superadmins vorbehalten',
          );
        });
      } finally {
        window.history.pushState({}, '', '/');
      }
    });

    /**
     * The four tabs of the system administration — reachable **over the
     * navigation**, not merely by the route parsing their address.
     *
     * Named expressly, because exactly this error has already happened once in
     * this application: a route was parsed correctly (`routes.ts`) and
     * had a real view, but the shell's render switch never got
     * a branch for it — the page answered 404 to everyone, no matter who asked. A
     * test that only calls `parseRoute()` does not see that; it has to go through the
     * header, the way a human arrives here.
     */
    it('reaches each of the four tabs by clicking, not just by its address', () => {
      stubFetch().mockImplementation(pendingForever);
      const superadmin = sessionUser({
        isSuperadmin: true,
        memberships: [
          membership(
            UMBRELLA_TENANT_ID,
            'Dachorganisation',
            'Dachorganisation',
          ),
        ],
      });
      renderWithQuery(<AppShell user={superadmin} />);

      // The header entry opens the first tab; the other three are
      // one click further each, within the view.
      fireEvent.click(screen.getByRole('button', { name: 'Systemverwaltung' }));
      expect(window.location.pathname).toBe('/admin/system');

      for (const [label, path] of [
        ['Überwachung', '/admin/system/monitoring'],
        ['Mailserver', '/admin/system/mail'],
        ['KI', '/admin/system/ai'],
        ['Organisationen', '/admin/system'],
      ] as const) {
        fireEvent.click(screen.getByRole('button', { name: label }));
        expect(window.location.pathname).toBe(path);
        expect(
          screen
            .getByRole('button', { name: label })
            .getAttribute('aria-current'),
        ).toBe('page');
        expect(screen.queryByText('Diese Seite gibt es nicht.')).toBeNull();
      }
    });

    /**
     * The fourth tab of the tenant administration — *Mailversand*
     * — reachable **over the navigation**,
     * not merely by the route parsing its address. Same class of bug named at
     * `MailIdentityCard`'s own doc comment and the same reason it gets a test
     * of its own here: a route can parse and a view can exist while
     * `AppShell`'s render switch never grows a branch for either, which
     * answers 404 to everyone regardless of who asked.
     */
    it('reaches Mailversand by clicking the navigation, not just by its address', () => {
      stubFetch().mockImplementation(pendingForever);
      renderWithQuery(<AppShell user={twoTenantsScoped} />);

      fireEvent.click(
        screen.getByRole('button', { name: /Organisations-Verwaltung/ }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Mailversand' }));

      expect(
        screen
          .getByRole('button', { name: 'Mailversand' })
          .getAttribute('aria-current'),
      ).toBe('page');
      expect(screen.queryByText('Diese Seite gibt es nicht.')).toBeNull();
      // Somebody removing the fourth entry from the tab bar entirely (rather
      // than breaking the render switch) must fail this test too — it is not
      // enough for the *address* to work if nothing in the navigation leads
      // to it.
      expect(
        screen.getByText('Mailversand wird geladen…', { exact: false }),
      ).toBeDefined();
    });

    /**
     * Regression: both addresses parsed (`routes.ts`) and had a view
     * (`FormMembersView`, `SuperadminView`), but
     * `AppShell`'s own render switch never grew a branch for either — so both
     * fell through to the 404 page no matter who asked. Only the loading
     * state is asserted (`stubFetch` is left unset, so the query never
     * settles); the point is that the address reaches the view at all, not
     * what the view shows once data arrives.
     */
    it('reaches the per-form Nutzerrechte view at its address instead of 404', () => {
      window.history.pushState(
        {},
        '',
        '/forms/019fe700-0000-7000-8000-000000000001/members',
      );
      try {
        renderWithQuery(<AppShell user={twoTenantsScoped} />);

        expect(screen.getByText('Nutzerrechte werden geladen…')).toBeDefined();
        expect(screen.queryByText('Diese Seite gibt es nicht.')).toBeNull();
      } finally {
        window.history.pushState({}, '', '/');
      }
    });

    it('reaches the tenants tab at its address instead of 404', () => {
      window.history.pushState({}, '', '/admin/system');
      try {
        renderWithQuery(
          <AppShell
            user={sessionUser({
              isSuperadmin: true,
              memberships: [
                membership(
                  UMBRELLA_TENANT_ID,
                  'Dachorganisation',
                  'Dachorganisation',
                ),
              ],
            })}
          />,
        );

        expect(
          screen.getByText('Organisationen werden geladen…'),
        ).toBeDefined();
        expect(screen.queryByText('Diese Seite gibt es nicht.')).toBeNull();
      } finally {
        window.history.pushState({}, '', '/');
      }
    });

    /**
     * The requirement no. 3 — the subheader reads the rights of **this form**,
     * not the organisation-wide ones off the session.
     *
     * The reachable case the review gate measured: somebody caps *themselves*
     * on one form to a weaker group that keeps `can_manage_users` (revoking
     * one's own access is refused with 409, so it is not reachable at all).
     * The membership still says `can_build`; the form says it does not. Until
     * the rights were on the wire, the bar offered „Bearbeiten" and
     * `PUT /api/forms/:id` answered 403.
     *
     * **Driven over the real path**: one render, a click on the dashboard card,
     * a route change. Two views mounted side by side would prove the component
     * reads a prop and nothing about the application, which is how the earlier
     * attempt at this finding passed while the defect stood.
     */
    describe('the form subheader', () => {
      const FORM_ID = '019fe700-0000-7000-8000-0000000000f1';

      /** Organisation-wide: may build. The cap below is what disagrees. */
      const builder = sessionUser({
        memberships: [
          membership(
            UMBRELLA_TENANT_ID,
            'Dachorganisation',
            'Dachorganisation',
          ),
        ],
      });

      const QUESTION_ID = '019fe700-0000-7000-8000-0000000000c1';
      const DEFINITION = {
        pages: [
          {
            id: '019fe700-0000-7000-8000-0000000000b1',
            title: 'Seite 1',
            description: null,
            questions: [
              {
                id: QUESTION_ID,
                type: 'text',
                label: 'Name',
                hint: null,
                required: true,
                width: 'full',
                minLength: null,
                maxLength: null,
                pattern: null,
              },
            ],
          },
        ],
      };

      /**
       * Navigates from the dashboard to the form's answers by **clicking the
       * card**, and answers `GET /forms` with the given per-form rights.
       *
       * The answers view is served for real (an empty table) rather than parked
       * in its loading state: the export control lives behind that load, and an
       * assertion that it is absent would otherwise pass against a view that
       * had not rendered at all.
       */
      async function openFormFromDashboard(
        formPermissions: ReturnType<typeof permissions>,
      ): Promise<void> {
        const summary = {
          id: FORM_ID,
          title: 'Anmeldung Jahrestagung',
          status: 'active',
          publishedVersion: 1,
          responseCount: 0,
          permissions: formPermissions,
          updatedAt: '2026-07-27T10:00:00.000Z',
        };
        stubFetch().mockImplementation((input: unknown) => {
          const url = String(input);
          // `startsWith`: the shell asks `GET /api/forms?id=…` for
          // the one form, and the payload is a **page** rather than an array.
          if (url.includes('/api/forms?')) {
            return Promise.resolve(
              jsonResponse(200, {
                items: [summary],
                total: 1,
                activeTotal: 1,
                responseTotal: 0,
                limit: 24,
                offset: 0,
              }),
            );
          }
          if (url.endsWith(`/api/forms/${FORM_ID}/responses/columns`)) {
            return Promise.resolve(
              jsonResponse(200, {
                columns: [
                  { key: QUESTION_ID, label: 'Name', retired: false },
                  {
                    key: 'submitted_at',
                    label: 'Eingereicht am (UTC)',
                    retired: false,
                  },
                ],
                versions: [{ version: 1, definition: DEFINITION }],
              }),
            );
          }
          if (url.endsWith(`/api/forms/${FORM_ID}/responses`)) {
            return Promise.resolve(jsonResponse(200, []));
          }
          if (url.endsWith(`/api/forms/${FORM_ID}`)) {
            return Promise.resolve(
              jsonResponse(200, {
                ...summary,
                revision: 1,
                publicSlug: 'AbCdEf123456',
                definition: DEFINITION,
                hasUnpublishedChanges: false,
              }),
            );
          }
          return pendingForever();
        });

        renderWithQuery(<AppShell user={builder} />);
        await waitFor(() => {
          expect(screen.getByText('Anmeldung Jahrestagung')).toBeDefined();
        });

        // The route change the application itself performs — no `pushState`.
        fireEvent.click(screen.getByRole('button', { name: 'Antworten' }));
        await waitFor(() => {
          expect(
            screen.getByRole('navigation', { name: 'Aktuelles Formular' }),
          ).toBeDefined();
        });
      }

      function navEntries(): string[] {
        return within(
          screen.getByRole('navigation', { name: 'Aktuelles Formular' }),
        )
          .getAllByRole('button')
          .map((entry) => entry.textContent);
      }

      afterEach(() => {
        window.history.pushState({}, '', '/');
      });

      /**
       * ⚠️ **`waitFor` rather than an immediate assertion, and that is a
       * deliberate behaviour change, not a flaky test.**
       *
       * Until the list was paged, the per-form rights were read out of the
       * dashboard's *already loaded* list, so the answer was in hand the
       * instant this view mounted. A paged list cannot answer for a form it
       * may not hold, so the shell asks `GET /forms?id=…` — one request, and
       * for its duration `useFormPermissions` returns `undefined`, which
       * `AppShell` deliberately reads as „noch nicht bekannt" and answers with
       * the membership's flags (its own comment says why: the fallback is the
       * *upper bound* of what a cap could leave, so it can never show more
       * than the old code did).
       *
       * That window already existed for anyone opening a form by link rather
       * than by click; it now also exists for the click. What must be true —
       * and is what this case measures — is that it **closes**: once the
       * server has answered about this form, „Bearbeiten" is gone.
       */
      it('drops „Bearbeiten" for somebody capped on that form', async () => {
        await openFormFromDashboard(permissions({ canBuild: false }));

        await waitFor(() => {
          expect(
            navEntries().some((label) => label.includes('Bearbeiten')),
          ).toBe(false);
        });
        // The other entries the capped role keeps are still there, so this is
        // about the one flag and not about a bar that failed to render.
        expect(navEntries().some((label) => label.includes('Antworten'))).toBe(
          true,
        );
        expect(
          navEntries().some((label) => label.includes('Nutzerrechte')),
        ).toBe(true);
      });

      /**
       * The counter-check on the identical path: the same session, the same
       * click, only the form's own rights differ. Without it „Bearbeiten ist
       * weg" would also be true of a bar that lost the entry for any other
       * reason.
       */
      it('keeps „Bearbeiten" where the form does not cap it', async () => {
        await openFormFromDashboard(permissions());

        expect(navEntries().some((label) => label.includes('Bearbeiten'))).toBe(
          true,
        );
      });

      /**
       * …and the export, the second half of the same gap: `…/export.csv`
       * requires `can_export`, and the button sat behind the organisation-wide flag
       * too.
       */
      it('hides the export where the form caps can_export away', async () => {
        await openFormFromDashboard(permissions({ canExport: false }));
        await waitFor(() => {
          expect(screen.getByRole('heading', { level: 1 })).toBeDefined();
        });

        expect(
          screen.getByText(/Export ist der Rolle „Export" vorbehalten/),
        ).toBeDefined();
      });

      /** The counter-check for the export, on the identical path. */
      it('offers the export where the form does not cap it', async () => {
        await openFormFromDashboard(permissions());
        await waitFor(() => {
          expect(screen.getByRole('heading', { level: 1 })).toBeDefined();
        });

        expect(
          screen.queryByText(/Export ist der Rolle „Export" vorbehalten/),
        ).toBeNull();
      });
    });

    /**
     * The nachbesserung (security review finding): the shell's
     * membership fallback (`AppShell.tsx`) is sound only while `GET /forms`
     * has not answered yet. Once it *has* answered and this form is not in
     * the payload, that is not "not known yet" — `formFilter()` removes an
     * `accessRevoked` form permanently, and a successfully loaded list
     * without `take`/pagination that lacks a form means the form is locked
     * out or belongs to someone else, never "still loading". Reached by
     * typing the address directly (`window.history.pushState`), which is
     * exactly how the finding described the reachable case: a stale link
     * into a form the session was capped out of.
     */
    describe('the membership fallback and its limit', () => {
      const REVOKED_FORM_ID = '019fe700-0000-7000-8000-0000000000f2';
      // Full Organisation-wide rights — chosen so a wrongly-applied fallback would
      // offer every entry, not just one, and so the assertion cannot pass by
      // accident of a single flag happening to be false already.
      const fullRights = sessionUser({
        memberships: [
          membership(
            UMBRELLA_TENANT_ID,
            'Dachorganisation',
            'Dachorganisation',
          ),
        ],
      });

      afterEach(() => {
        window.history.pushState({}, '', '/');
      });

      it('offers nothing for a form the successfully loaded list does not contain', async () => {
        stubFetch().mockImplementation((input: unknown) => {
          const url = String(input);
          if (url.includes('/api/forms?')) {
            // Loaded, successfully, and this form is not in it — the
            // `accessRevoked` / foreign-tenant case, not a slow request. Since
            // Since paging, the question is asked **about this form** (`?id=…`), so an
            // empty page here can no longer also mean „auf Seite zwei".
            return Promise.resolve(
              jsonResponse(200, {
                items: [],
                total: 0,
                activeTotal: 0,
                responseTotal: 0,
                limit: 24,
                offset: 0,
              }),
            );
          }
          return pendingForever();
        });
        window.history.pushState({}, '', `/forms/${REVOKED_FORM_ID}/responses`);

        renderWithQuery(<AppShell user={fullRights} />);

        await waitFor(() => {
          expect(
            screen.queryByRole('navigation', { name: 'Aktuelles Formular' }),
          ).toBeNull();
        });
      });

      /**
       * **Regression, review finding.** Paging the list turned „does
       * this form exist for me?" into a request that names the id — and the id
       * is parsed as a uuid, so a hand-edited or stale address answers **400**
       * rather than „loaded, and not in it".
       *
       * Left as a plain failure, that 400 fell into „noch nicht bekannt", the
       * shell used the membership's flags, and the navigation offered
       * „Bearbeiten / Antworten / Nutzerrechte" for a form that does not
       * exist — the exact regression the case above was written against, come
       * back through a different door.
       */
      it('offers nothing for an id the route cannot even read', async () => {
        stubFetch().mockImplementation((input: unknown) => {
          const url = String(input);
          if (url.includes('/api/forms?')) {
            return Promise.resolve(
              jsonResponse(400, { message: 'id muss eine UUID sein.' }),
            );
          }
          return pendingForever();
        });
        window.history.pushState({}, '', '/forms/kaputt/responses');

        renderWithQuery(<AppShell user={fullRights} />);

        await waitFor(() => {
          expect(
            screen.queryByRole('navigation', { name: 'Aktuelles Formular' }),
          ).toBeNull();
        });
      });

      /**
       * The counter-check required alongside it: while the list has not
       * answered yet (or fails), the membership still has to stand in —
       * otherwise every control a person is actually allowed to use would
       * blink out of existence on first paint, which is the mirror-image bug
       * the work order names explicitly.
       */
      it('keeps the membership fallback while the list is still pending', () => {
        stubFetch().mockImplementation(pendingForever);
        window.history.pushState({}, '', `/forms/${REVOKED_FORM_ID}/responses`);

        renderWithQuery(<AppShell user={fullRights} />);

        expect(
          screen.getByRole('navigation', { name: 'Aktuelles Formular' }),
        ).toBeDefined();
        expect(
          screen.getByRole('button', { name: /Bearbeiten/ }),
        ).toBeDefined();
      });

      it('keeps the membership fallback when the list request fails', async () => {
        stubFetch().mockImplementation((input: unknown) => {
          const url = String(input);
          if (url.includes('/api/forms?')) {
            return Promise.resolve(jsonResponse(500, { message: 'nope' }));
          }
          return pendingForever();
        });
        window.history.pushState({}, '', `/forms/${REVOKED_FORM_ID}/responses`);

        renderWithQuery(<AppShell user={fullRights} />);

        await waitFor(() => {
          expect(
            screen.getByRole('navigation', { name: 'Aktuelles Formular' }),
          ).toBeDefined();
        });
        expect(
          screen.getByRole('button', { name: /Bearbeiten/ }),
        ).toBeDefined();
      });
    });

    /**
     * **The route announcement has to speak even when the sentence is the same**
     * (finding 7 of the follow-up).
     *
     * `routeTitle` is static per route kind (`route-title.ts` gives the reason),
     * so a change *within* a kind — dispatch log with a
     * form filter → without, `/forms/A` → `/forms/B` — means setting the same sentence
     * once more. A `role="status"` region with an unchanged
     * text node is not read out again; the announcement therefore fell silent precisely
     * where it is needed most.
     *
     * What is measured is therefore the **text node**, not the sentence: after the
     * second announcement it stands somewhere else than after the first, and exactly that is
     * the change a screen reader reads out on.
     */
    it('sagt einen Wechsel innerhalb derselben Routenart erneut an', () => {
      stubFetch().mockImplementation(pendingForever);
      const FORM_ID = '019fe700-0000-7000-8000-0000000000e1';
      window.history.pushState({}, '', mailLogPath(FORM_ID));
      try {
        const { container } = renderWithQuery(
          <AppShell user={twoTenantsScoped} />,
        );
        const regions = (): string[] =>
          [...container.querySelectorAll('.app-shell__route-announcement')].map(
            (region) => region.textContent,
          );

        // Both regions stand in the tree from the start — a live region that
        // only comes into being together with its text is frequently not announced at all.
        expect(regions()).toHaveLength(2);
        expect(regions().join('')).toBe('');

        act(() => {
          navigate(mailLogPath());
        });
        const afterFirst = regions();
        expect(afterFirst.join('')).toBe('Versandprotokoll');

        act(() => {
          navigate(mailLogPath(FORM_ID));
        });
        const afterSecond = regions();
        expect(afterSecond.join('')).toBe('Versandprotokoll');
        // The same sentence, a different node: the region that spoke before is
        // empty, the other one carries the text. Without this swap the
        // tree would stay unchanged and the second announcement mute.
        expect(afterSecond).not.toStrictEqual(afterFirst);
      } finally {
        window.history.pushState({}, '', '/');
      }
    });

    it('renders no mobile control on the desktop layout', () => {
      renderWithQuery(<AppShell user={twoTenantsScoped} />);

      // „⊗ Papierkorb" has a describe block of its own; „✦ KI-Formular"
      // has stood on the dashboard since finding 18. What remains here is the
      // hamburger, and that belongs to the other width.
      expect(screen.queryByRole('button', { name: 'Menü öffnen' })).toBeNull();
    });

    /**
     * „✦ KI-Formular" — **on the dashboard, not in the header**
     * (finding 18).
     *
     * The button sat as the last entry of the main navigation and was the
     * only one there that did not navigate. What it does is create a
     * form; it therefore stands next to „+ Neues Formular". The conditions have
     * stayed the same, and the shell is still the place where they
     * come together — which is why this block stays here and does not move
     * entirely into `DashboardView.test.tsx`.
     */
    describe('✦ KI-Formular (Befund 18)', () => {
      it('is not an entry of the header navigation any more', () => {
        renderWithQuery(
          <AppShell
            user={sessionUser({
              memberships: bothMemberships,
              activeTenantId: UMBRELLA_TENANT_ID,
              aiFormsAvailable: true,
            })}
          />,
        );

        const nav = screen.getByRole('navigation', {
          name: 'Hauptnavigation',
        });
        expect(
          within(nav).queryByRole('button', { name: /KI-Formular/ }),
        ).toBeNull();
        // …and the button is there nonetheless, one level deeper: otherwise the
        // assertion above could also be true because it exists nowhere.
        expect(
          screen.getByRole('button', { name: /KI-Formular/ }),
        ).toBeDefined();
      });

      /**
       * The direction a missing answer has to fall in. An installation without
       * a key sends no flag (or `false`), and the entry is **gone** — not
       * greyed out, which would promise a feature the route answers 404 to.
       */
      it('is absent where the installation has no key', () => {
        renderWithQuery(<AppShell user={twoTenantsScoped} />);

        expect(
          screen.queryByRole('button', { name: /KI-Formular/ }),
        ).toBeNull();
        // „ausgegraut" would leave the label in the tree with `disabled` on it;
        // this finds it either way.
        expect(
          screen
            .getAllByRole('button')
            .some((button) => button.textContent.includes('KI-Formular')),
        ).toBe(false);
      });

      it('appears where the server says the feature exists', () => {
        renderWithQuery(
          <AppShell
            user={sessionUser({
              memberships: bothMemberships,
              activeTenantId: UMBRELLA_TENANT_ID,
              aiFormsAvailable: true,
            })}
          />,
        );

        expect(
          screen.getByRole('button', { name: /KI-Formular/ }),
        ).toBeDefined();
      });

      /**
       * Two gates, and they are different questions: „gibt es die Funktion?"
       * and „darf diese Person Formulare bauen?". A role without `can_build`
       * gets 403 from the route, so the entry would be a door that does not
       * open.
       */
      it('is absent for a role that may not build', () => {
        renderWithQuery(
          <AppShell
            user={sessionUser({
              memberships: [
                membership(
                  UMBRELLA_TENANT_ID,
                  'Dachorganisation',
                  'Dachorganisation',
                  null,
                  {
                    canBuild: false,
                  },
                ),
              ],
              aiFormsAvailable: true,
            })}
          />,
        );

        expect(
          screen.queryByRole('button', { name: /KI-Formular/ }),
        ).toBeNull();
      });

      /**
       * The dialogue mounts **beside** the view, not inside it — and it is the
       * one with *Übernehmen* and *Verwerfen*, i.e. the deviation from the
       * prototype, not the prototype's straight-into-the-builder step.
       */
      it('opens the dialogue over whatever is on screen', async () => {
        stubFetch().mockImplementation(pendingForever);
        renderWithQuery(
          <AppShell
            user={sessionUser({
              memberships: bothMemberships,
              activeTenantId: UMBRELLA_TENANT_ID,
              aiFormsAvailable: true,
            })}
          />,
        );

        fireEvent.click(screen.getByRole('button', { name: /KI-Formular/ }));

        const dialog = await screen.findByRole('dialog');
        expect(
          within(dialog).getByText('Formular mit KI erstellen'),
        ).toBeDefined();
      });
    });

    /**
     * The 404 was a single unstyled line of text with no CSS behind its class
     * names — reported by the client. It is a real page now, and it repeats the
     * address: a stale bookmark, a link a mail client truncated and a plain
     * typo all land here, and the URL is the one thing that says which of the
     * three happened.
     */
    it('renders a real 404 page for an address the app does not have', () => {
      window.history.pushState({}, '', '/gibt-es-nicht');
      try {
        renderWithQuery(<AppShell user={twoTenantsScoped} />);

        expect(
          screen.getByRole('heading', {
            level: 1,
            name: 'Diese Seite gibt es nicht.',
          }),
        ).toBeDefined();
        expect(screen.getByText('/gibt-es-nicht')).toBeDefined();
        expect(
          screen.getByRole('button', { name: 'Zurück zum Dashboard' }),
        ).toBeDefined();
      } finally {
        window.history.pushState({}, '', '/');
      }
    });

    it('ends the session server-side on logout', async () => {
      const fetchMock = stubFetch().mockResolvedValue(emptyResponse(204));

      renderWithQuery(<AppShell user={twoTenantsScoped} />);
      fireEvent.click(screen.getByRole('button', { name: 'Abmelden' }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          '/api/auth/logout',
          expect.objectContaining({ method: 'POST' }),
        );
      });
    });
  });

  describe('mobile (< 1180 px)', () => {
    it('replaces the desktop actions with a hamburger', () => {
      setViewportWidth(360);
      renderWithQuery(<AppShell user={twoTenantsScoped} />);

      const hamburger = screen.getByRole('button', { name: 'Menü öffnen' });
      expect(hamburger.getAttribute('aria-expanded')).toBe('false');
      expect(hamburger.getAttribute('aria-controls')).toBeTruthy();
      expect(
        screen.queryByRole('button', { name: /Organisations-Auswahl/ }),
      ).toBeNull();
    });

    /** The same pair as on the desktop header — the sheet has its own row. */
    describe('the Organisations-Verwaltung row of the sheet', () => {
      // `canBuild` defaults to `true` (`test/fixtures.ts`), right for the
      // "offered" case below but wrong for the "absent" one — it would leave
      // the trash row reachable, which is exactly the state that case
      // needs to rule out, now that the requirement gives the section a
      // second entry.
      function openSheet(canManageSettings: boolean, canBuild = true): void {
        setViewportWidth(360);
        renderWithQuery(
          <AppShell
            user={sessionUser({
              memberships: [
                membership(
                  UMBRELLA_TENANT_ID,
                  'Dachorganisation',
                  'Dachorganisation',
                  null,
                  {
                    canManageSettings,
                    canBuild,
                  },
                ),
              ],
            })}
          />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Menü öffnen' }));
      }

      it('is offered to a role that may manage settings', () => {
        openSheet(true);

        expect(
          screen.getByRole('button', { name: 'Organisations-Verwaltung' }),
        ).toBeDefined();
        expect(screen.getByText('Verwaltung')).toBeDefined();
      });

      it('is absent for a role that may neither manage settings nor build — and so is the heading', () => {
        openSheet(false, false);

        expect(
          screen.queryByRole('button', { name: 'Organisations-Verwaltung' }),
        ).toBeNull();
        expect(screen.queryByRole('button', { name: 'Papierkorb' })).toBeNull();
        // The section heading goes with it: „Verwaltung" over nothing is the
        // empty promise out.
        expect(screen.queryByText('Verwaltung')).toBeNull();
      });

      /** Mobile half: the row opens the first tab too. */
      it('navigates to the first tab, not the middle one, and closes the sheet', () => {
        stubFetch().mockImplementation(pendingForever);
        openSheet(true);

        fireEvent.click(
          screen.getByRole('button', { name: 'Organisations-Verwaltung' }),
        );

        try {
          expect(window.location.pathname).toBe('/admin/appearance');
          expect(screen.queryByRole('dialog')).toBeNull();
        } finally {
          window.history.pushState({}, '', '/');
        }
      });
    });

    /** The trash row of the sheet — same pair as on the desktop header. */
    describe('the Papierkorb row of the sheet', () => {
      function openSheet(canBuild: boolean): void {
        setViewportWidth(360);
        renderWithQuery(
          <AppShell
            user={sessionUser({
              memberships: [
                membership(
                  UMBRELLA_TENANT_ID,
                  'Dachorganisation',
                  'Dachorganisation',
                  null,
                  { canBuild },
                ),
              ],
            })}
          />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Menü öffnen' }));
      }

      it('is offered to a role that may build', () => {
        openSheet(true);

        expect(
          screen.getByRole('button', { name: 'Papierkorb' }),
        ).toBeDefined();
      });

      it('is absent for a role that may not', () => {
        openSheet(false);

        expect(screen.queryByRole('button', { name: 'Papierkorb' })).toBeNull();
      });

      it('navigates to /admin/trash and closes the sheet', () => {
        stubFetch().mockImplementation(pendingForever);
        openSheet(true);

        fireEvent.click(screen.getByRole('button', { name: 'Papierkorb' }));

        try {
          expect(window.location.pathname).toBe('/admin/trash');
          expect(screen.queryByRole('dialog')).toBeNull();
          expect(screen.queryByText('Diese Seite gibt es nicht.')).toBeNull();
        } finally {
          window.history.pushState({}, '', '/');
        }
      });

      // jsdom computes no real layout, so it cannot see horizontal overflow —
      // that half of the requirement's mobile requirement (Lehre 4, // `CONTRIBUTING.md`) is measured in a real browser instead
      // (`e2e/trash-mobile.spec.ts`), the same split the project already
      // draws for every other 360 px view.
    });

    /** The system administration in the sheet — one entry, as in the header. */
    describe('the Systemverwaltung row of the sheet', () => {
      function openSheet(isSuperadmin: boolean): void {
        setViewportWidth(360);
        renderWithQuery(
          <AppShell
            user={sessionUser({
              isSuperadmin,
              memberships: [
                membership(
                  UMBRELLA_TENANT_ID,
                  'Dachorganisation',
                  'Dachorganisation',
                ),
              ],
            })}
          />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Menü öffnen' }));
      }

      it('is offered to a superadmin', () => {
        openSheet(true);

        expect(
          screen.getByRole('button', { name: 'Systemverwaltung' }),
        ).toBeDefined();
      });

      /**
       * **Both widths say the same** (finding 16). The three old rows
       * are the counter-check: if one of them stayed in the sheet, the
       * telephone would have a navigation that the screen no longer has.
       */
      it('replaces the three former superadmin rows', () => {
        openSheet(true);

        const labels = screen
          .getAllByRole('button')
          .map((button) => button.textContent);
        for (const gone of [
          'Superadmin-Übersicht',
          'Systemeinstellungen',
          'Betrieb',
        ]) {
          expect(labels.some((label) => label.includes(gone))).toBe(false);
        }
      });

      it('is absent for an admin of the active tenants', () => {
        openSheet(false);

        expect(
          screen.queryByRole('button', { name: 'Systemverwaltung' }),
        ).toBeNull();
        // The heading stays, because the other entries are still there — the
        // section is built from the entries, not from one of the flags.
        expect(screen.getByText('Verwaltung')).toBeDefined();
      });
    });

    it('opens a sheet with "Allgemein" and the tenant selection (B12)', () => {
      setViewportWidth(360);
      renderWithQuery(<AppShell user={twoTenantsScoped} />);

      const hamburger = screen.getByRole('button', { name: 'Menü öffnen' });
      fireEvent.click(hamburger);

      const sheet = screen.getByRole('dialog');
      expect(sheet.getAttribute('aria-modal')).toBe('true');
      expect(hamburger.getAttribute('aria-controls')).toBe(sheet.id);
      expect(hamburger.getAttribute('aria-expanded')).toBe('true');

      expect(within(sheet).getByText('Allgemein')).toBeDefined();
      expect(
        within(sheet).getByRole('button', { name: /Dashboard/ }),
      ).toBeDefined();
      expect(within(sheet).getByText('Organisation')).toBeDefined();
      expect(within(sheet).getByText('Dachorganisation')).toBeDefined();
      expect(within(sheet).getByText('Ortsgruppe Musterstadt')).toBeDefined();
    });

    it("marks the sheet's Dashboard entry current only on the dashboard route, and navigates from elsewhere", () => {
      setViewportWidth(360);
      window.history.pushState({}, '', '/gibt-es-nicht');
      try {
        renderWithQuery(<AppShell user={twoTenantsScoped} />);
        fireEvent.click(screen.getByRole('button', { name: 'Menü öffnen' }));

        const dashboardItem = within(screen.getByRole('dialog')).getByRole(
          'button',
          { name: 'Dashboard' },
        );
        expect(dashboardItem.getAttribute('aria-current')).toBeNull();

        fireEvent.click(dashboardItem);

        // Navigating from the sheet also dismisses it — the sheet covers the
        // whole screen, so leaving it open would hide the view just switched to.
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(
          screen.getByRole('heading', { level: 1, name: 'Dashboard' }),
        ).toBeDefined();
      } finally {
        window.history.pushState({}, '', '/');
      }
    });

    it('closes the sheet with Escape and returns focus to the hamburger', () => {
      setViewportWidth(360);
      renderWithQuery(<AppShell user={twoTenantsScoped} />);

      const hamburger = screen.getByRole('button', { name: 'Menü öffnen' });
      // jsdom does not focus on click the way a browser does; focusing here
      // reproduces the state the sheet has to restore.
      hamburger.focus();
      fireEvent.click(hamburger);
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(hamburger);
    });

    it('keeps no sheet open when the viewport grows back to desktop', () => {
      setViewportWidth(360);
      renderWithQuery(<AppShell user={twoTenantsScoped} />);
      fireEvent.click(screen.getByRole('button', { name: 'Menü öffnen' }));
      expect(screen.getByRole('dialog')).toBeDefined();

      act(() => {
        setViewportWidth(1280);
      });

      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByRole('button', { name: 'Abmelden' })).toBeDefined();
    });
  });
});
