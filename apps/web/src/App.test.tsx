import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import {
  emptyResponse,
  jsonResponse,
  requestUrl,
  stubFetch,
} from './test/fetch-mock';
import { sessionUser } from './test/fixtures';
import { renderWithQuery } from './test/render-with-query';

/**
 * What the app shows is decided by the session query alone.
 * These tests drive that decision through the API, never through a prop or a
 * local flag — there is none.
 *
 * Since ADR-0022 there are **three** states instead of two, and the third lies
 * *before* the login: an installation without a single account shows the
 * initial setup. That too is decided from a single source —
 * `GET /api/setup` —, and the cases below drive it over the
 * interface just like everything else here.
 */
describe('App', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the login view when there is no session', async () => {
    stubFetch().mockResolvedValue(emptyResponse(401));

    renderWithQuery(<App />);

    expect(
      await screen.findByRole('heading', { name: 'Formsache' }),
    ).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).toBeNull();
  });

  it('shows the dashboard when the session query returns a user', async () => {
    stubFetch().mockResolvedValue(jsonResponse(200, sessionUser()));

    renderWithQuery(<App />);

    expect(
      await screen.findByRole('heading', { name: 'Dashboard' }),
    ).toBeDefined();
    expect(screen.getByText(/Alexandra Admin/)).toBeDefined();
  });

  it('does not render the shell when the session payload is malformed', async () => {
    // A payload that lost `activeTenantId`: enough to render a header from if
    // nobody parsed it — which is exactly the half-rendered view B11 must not
    // produce.
    const { activeTenantId, ...broken } = sessionUser();
    expect(activeTenantId).not.toBeNull();
    stubFetch().mockResolvedValue(jsonResponse(200, broken));

    renderWithQuery(<App />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Formsache' })).toBeDefined();
    });
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).toBeNull();
    expect(
      screen.getByText(/Der Anmeldestatus konnte nicht geprüft werden/),
    ).toBeDefined();
  });

  it('reports while the session is still being checked', () => {
    stubFetch().mockReturnValue(new Promise<Response>(() => undefined));

    renderWithQuery(<App />);

    expect(screen.getByRole('status').textContent).toBe(
      'Anmeldestatus wird geprüft…',
    );
  });

  /**
   * Answers `/auth/me` with 401 and `/setup` with the state that was handed
   * in — the two questions the signed-out part of the application
   * consists of.
   */
  function signedOutWithSetup(setup: Response): void {
    stubFetch().mockImplementation((input) =>
      Promise.resolve(
        requestUrl(input).endsWith('/setup') ? setup : emptyResponse(401),
      ),
    );
  }

  it('zeigt die Erstinbetriebnahme statt der Anmeldung, wenn kein Konto existiert', async () => {
    signedOutWithSetup(jsonResponse(200, { setupRequired: true }));

    renderWithQuery(<App />);

    expect(
      await screen.findByRole('heading', { name: 'Erste Einrichtung' }),
    ).toBeDefined();
    // And **not** both: the login is not an alternative route here but
    // the form that does not exist yet.
    expect(screen.queryByRole('button', { name: 'Anmelden' })).toBeNull();
  });

  it('zeigt die Anmeldung, sobald die Installation eingerichtet ist', async () => {
    signedOutWithSetup(jsonResponse(200, { setupRequired: false }));

    renderWithQuery(<App />);

    expect(
      await screen.findByRole('heading', { name: 'Formsache' }),
    ).toBeDefined();
    expect(
      screen.queryByRole('heading', { name: 'Erste Einrichtung' }),
    ).toBeNull();
  });

  it.each([
    ['einem Serverfehler', emptyResponse(500)],
    // An answer that misses the schema: a proxy, an old state, a
    // field that has disappeared. It may lead to the setup as little as
    // a 500 does — the doubt always goes to the login.
    ['einer unlesbaren Antwort', jsonResponse(200, { setup: 'ja' })],
  ])(
    'fällt bei %s auf die Anmeldung zurück, nie auf die Einrichtung',
    async (_what, setup) => {
      signedOutWithSetup(setup);

      renderWithQuery(<App />);

      expect(
        await screen.findByRole('heading', { name: 'Formsache' }),
      ).toBeDefined();
      expect(
        screen.queryByRole('heading', { name: 'Erste Einrichtung' }),
      ).toBeNull();
    },
  );

  it('fragt gar nicht erst nach der Einrichtung, solange jemand angemeldet ist', async () => {
    const fetchMock = stubFetch().mockResolvedValue(
      jsonResponse(200, sessionUser()),
    );

    renderWithQuery(<App />);

    await screen.findByRole('heading', { name: 'Dashboard' });
    // The reason is not frugality but accountability: the question „is
    // this installation set up" has no answer for a signed-in person that
    // could change anything — and a route that ran along on every
    // load regardless would be a route whose boundary nobody can justify any more.
    const setupCalls = fetchMock.mock.calls.filter(([input]) =>
      requestUrl(input).endsWith('/setup'),
    );
    expect(setupCalls).toStrictEqual([]);
  });

  /**
   * **The wizard stays standing after step 1 has established a
   * session** — the finding of 2026-08-18, measured here at the level at which it
   * arises.
   *
   * `SetupView.test.tsx` runs through the same steps and was **green**
   * while the wizard disappeared in the browser from step 3 on: there the
   * view does not hang under `App`, and `App` was precisely the place that
   * switched it away. The trigger is not `GET /api/setup` — that route is asked a
   * single time —, but `GET /api/auth/me`: step 3 brings a
   * second observer of the session query with it (`MailServerStep` needs the
   * own address for the Testmail), the answer now carries the superadministrator
   * that was just created, and without the block in `App` the
   * signed-in shell would stand here.
   *
   * *Reproduction:* remove `setupRunning ||` in `App.tsx` → this case turns
   * red and shows the system administration in the snapshot.
   */
  it('lässt den Assistenten stehen, wenn Schritt 1 eine Sitzung hergestellt hat', async () => {
    let created = false;
    const fetchMock = stubFetch().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url.endsWith('/auth/me')) {
        return Promise.resolve(
          created
            ? jsonResponse(
                200,
                sessionUser({
                  isSuperadmin: true,
                  memberships: [],
                  activeTenantId: null,
                }),
              )
            : emptyResponse(401),
        );
      }
      if (url.endsWith('/setup')) {
        if (init?.method === 'POST') {
          // The answer is 204 without a body and **without a session**
          // (ADR-0022 no. 2) — the session comes from `/auth/login`.
          created = true;
          return Promise.resolve(emptyResponse(204));
        }
        return Promise.resolve(jsonResponse(200, { setupRequired: true }));
      }
      if (url.endsWith('/auth/login')) {
        return Promise.resolve(
          jsonResponse(200, {
            user: sessionUser({
              isSuperadmin: true,
              memberships: [],
              activeTenantId: null,
            }),
          }),
        );
      }
      return Promise.resolve(
        jsonResponse(200, {
          values: {
            smtp: null,
            publicBaseUrl: null,
            replyTo: null,
            opsAlertEmail: null,
          },
          lock: 1,
        }),
      );
    });

    renderWithQuery(<App />);
    await screen.findByRole('heading', { name: 'Erste Einrichtung' });

    const fill = (label: string, value: string): void => {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    };
    fill('Name', 'Erste Betreiberin');
    fill('E-Mail-Adresse', 'erste@example.org');
    fill('Passwort', 'ein-hinreichend-langes-passwort');
    fill('Passwort wiederholen', 'ein-hinreichend-langes-passwort');
    fireEvent.click(
      screen.getByRole('button', { name: 'Zugang anlegen und weiter' }),
    );

    expect(await screen.findByText('Schritt 2 von 7')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Überspringen' }));

    // Step 3 is the one at which it tore — and it is, because this is where the
    // second observer of the session query is mounted.
    expect(await screen.findByText('Schritt 3 von 7')).toBeDefined();

    /*
      **What is waited for is the second answer of `/auth/me`, not a
      timeout.** It is the event at which it tore: before it the
      wizard stands there even without the block, and a case that measures before it would be green
      before the fault can arise at all. Measured: without the block exactly
      the assertion below turns red.
    */
    await waitFor(() => {
      const meCalls = fetchMock.mock.calls.filter(([input]) =>
        requestUrl(input).endsWith('/auth/me'),
      );
      expect(meCalls.length).toBeGreaterThan(1);
    });

    expect(screen.getByText('Schritt 3 von 7')).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).toBeNull();
    expect(
      screen.queryByRole('heading', { name: 'Systemverwaltung' }),
    ).toBeNull();
  });

  /**
   * **The opposite direction, and it is the more expensive one:** an installation that
   * **is** already set up must not get the wizard — not even
   * when the session question changes its answer in between.
   *
   * The block above arises exclusively from `setupRequired: true`. If the
   * server says `false`, there is nothing to block, and the application shows what it
   * always shows without a session: the login — and with a session the shell.
   *
   * *Reproduction:* set the block in `App.tsx` to `useState(true)` →
   * this case turns red.
   */
  it('richtet die Sperre nicht ein, wenn die Installation bereits eingerichtet ist', async () => {
    let signedIn = false;
    stubFetch().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.endsWith('/setup')) {
        return Promise.resolve(jsonResponse(200, { setupRequired: false }));
      }
      if (url.endsWith('/auth/me')) {
        return Promise.resolve(
          signedIn ? jsonResponse(200, sessionUser()) : emptyResponse(401),
        );
      }
      if (url.endsWith('/auth/login')) {
        signedIn = true;
        return Promise.resolve(jsonResponse(200, { user: sessionUser() }));
      }
      return Promise.resolve(jsonResponse(200, []));
    });

    renderWithQuery(<App />);

    // Without a session: the login, not the setup.
    await screen.findByRole('heading', { name: 'Formsache' });
    expect(
      screen.queryByRole('heading', { name: 'Erste Einrichtung' }),
    ).toBeNull();

    // And after an ordinary login the shell — the wizard turns up
    // on neither of the two ways.
    fireEvent.change(screen.getByLabelText('E-Mail-Adresse'), {
      target: { value: 'admin@example.org' },
    });
    fireEvent.change(screen.getByLabelText('Passwort'), {
      target: { value: 'ein-hinreichend-langes-passwort' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Anmelden' }));

    await screen.findByRole('heading', { name: 'Dashboard' });
    expect(
      screen.queryByRole('heading', { name: 'Erste Einrichtung' }),
    ).toBeNull();
  });

  /**
   * **The fill-in path does not ask about the setup** (a review finding).
   *
   * The short circuit on `/f/<slug>` stands before every `return` — but hooks run
   * *before that*, and `useSetupState` in `App` therefore hung off a condition
   * a participant fulfils: they unavoidably collect a 401 on
   * `/auth/me`. Every page view of a public form thereby made
   * a second request and entered it into the counter of
   * `SETUP_STATE_RATE_LIMIT` — 120 per minute and address, shared by a
   * whole office behind one address.
   *
   * **Negative check, measured:** the question lifted back into `App` (`enabled`
   * off a clean 401 instead of off the component) — this case turns red and
   * names the call of `/api/setup` that must not exist.
   */
  it('fragt auf dem öffentlichen Ausfüllpfad nicht nach der Einrichtung', async () => {
    window.history.pushState({}, '', '/f/jahrestagung-2026');
    const fetchMock = stubFetch().mockResolvedValue(emptyResponse(401));

    try {
      renderWithQuery(<App />);

      // What is waited for is a **rendered** end state, not „some
      // fetch has happened": the session check goes out at the same time as the
      // form query, and the 401 reaches React only a few
      // passes later. A case that measures before that is green before the
      // forbidden request could arise at all — measured: with
      // `waitFor(fetch was called)` it stayed green even with the question in the
      // wrong place.
      await screen.findByText(/Formular konnte nicht geladen werden/);

      const setupCalls = fetchMock.mock.calls.filter(([input]) =>
        requestUrl(input).endsWith('/setup'),
      );
      expect(setupCalls).toStrictEqual([]);
    } finally {
      window.history.pushState({}, '', '/');
    }
  });
});
