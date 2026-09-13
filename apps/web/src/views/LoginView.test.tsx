import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_OIDC_BUTTON_LABEL } from '@formsache/shared';

import { emptyResponse, jsonResponse, stubFetch } from '../test/fetch-mock';
import type { FetchMock } from '../test/fetch-mock';
import { sessionUser } from '../test/fixtures';
import { renderWithQuery } from '../test/render-with-query';
import { LoginView } from './LoginView';

function fillCredentials(
  email = 'admin@example.org',
  password = 'secret',
): void {
  fireEvent.change(screen.getByLabelText('E-Mail-Adresse'), {
    target: { value: email },
  });
  fireEvent.change(screen.getByLabelText('Passwort'), {
    target: { value: password },
  });
}

function submit(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Anmelden' }));
}

/**
 * How often `POST /api/auth/login` was called — **not** how often `fetch` was.
 *
 * The view also asks `GET /api/auth/oidc/providers` on mount, so a
 * bare `toHaveBeenCalledTimes` would count the SSO offer and turn „hat den
 * Server nicht gefragt" into a statement about the wrong request.
 */
function loginCalls(fetchMock: FetchMock): unknown[] {
  return fetchMock.mock.calls.filter(([path]) => path === '/api/auth/login');
}

/** The SSO offer, as `GET /api/auth/oidc/providers` answers it. */
function providers(
  entries: readonly {
    tenantId: string;
    name: string;
    shortName: string;
    buttonLabel: string;
  }[] = [],
): Response {
  return jsonResponse(200, entries);
}

/**
 * Routes the two `GET`s a signed-out page makes: the SSO offer and everything
 * else. Needed because the view now speaks to two endpoints, and a single
 * `mockResolvedValue` would hand the offer list a login body.
 */
function stubRoutes(
  offer: readonly {
    tenantId: string;
    name: string;
    shortName: string;
    buttonLabel: string;
  }[],
  otherwise: Response,
): FetchMock {
  const fetchMock = stubFetch();
  fetchMock.mockImplementation((path) =>
    Promise.resolve(
      path === '/api/auth/oidc/providers' ? providers(offer) : otherwise,
    ),
  );
  return fetchMock;
}

describe('LoginView', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders both fields with labels and the right autocomplete hints', () => {
    renderWithQuery(<LoginView />);

    const email = screen.getByLabelText('E-Mail-Adresse');
    const password = screen.getByLabelText('Passwort');

    expect(email.getAttribute('type')).toBe('email');
    expect(email.getAttribute('autocomplete')).toBe('email');
    expect(password.getAttribute('type')).toBe('password');
    expect(password.getAttribute('autocomplete')).toBe('current-password');
  });

  it('carries the product mark above the product name', () => {
    renderWithQuery(<LoginView />);

    // The signed-out card is one of the two places the product mark belongs
    // (ADR-0019) — there is no organisation on screen here whose logo it
    // could crowd. The mark is a `<p>`, so the heading below it is what gives
    // this page its one level-1 landmark; both must be present.
    expect(screen.getByTestId('product-lockup').textContent).toBe('Formsache');
    expect(screen.queryByRole('heading', { name: 'Formsache' })).not.toBeNull();
  });

  it('sends the credentials to the login endpoint on submit', async () => {
    const fetchMock = stubFetch().mockResolvedValue(
      jsonResponse(200, { user: sessionUser() }),
    );

    renderWithQuery(<LoginView />);
    fillCredentials();
    submit();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/auth/login',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            email: 'admin@example.org',
            password: 'secret',
          }),
        }),
      );
    });
  });

  it('normalises the address the way the shared schema does', async () => {
    const fetchMock = stubFetch().mockResolvedValue(
      jsonResponse(200, { user: sessionUser() }),
    );

    renderWithQuery(<LoginView />);
    fillCredentials('  Admin@Example.ORG ', 'secret');
    submit();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/auth/login',
        expect.objectContaining({
          body: JSON.stringify({
            email: 'admin@example.org',
            password: 'secret',
          }),
        }),
      );
    });
  });

  it('answers a 401 with one message that does not reveal whether the address exists', async () => {
    stubFetch().mockResolvedValue(emptyResponse(401));

    renderWithQuery(<LoginView />);
    fillCredentials('unknown@example.org', 'wrong');
    submit();

    const alert = await screen.findByRole('alert');

    // The requirement: this exact wording, not a more helpful one.
    expect(alert.textContent).toBe('E-Mail-Adresse oder Passwort ist falsch.');
    expect(alert.textContent).not.toMatch(/unbekannt|existiert|registriert/i);
  });

  it('distinguishes a server failure from wrong credentials', async () => {
    stubFetch().mockResolvedValue(emptyResponse(500));

    renderWithQuery(<LoginView />);
    fillCredentials();
    submit();

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Die Anmeldung ist zurzeit nicht möglich. Bitte versuche es später erneut.',
    );
  });

  it('rejects an unusable address without asking the server', () => {
    const fetchMock = stubFetch();

    renderWithQuery(<LoginView />);
    fillCredentials('keine-adresse', 'secret');
    submit();

    expect(screen.getByRole('alert').textContent).toBe(
      'Bitte gib eine gültige E-Mail-Adresse und ein Passwort ein.',
    );
    expect(loginCalls(fetchMock)).toHaveLength(0);
  });

  it('shows the pending state and refuses a second submit', async () => {
    const fetchMock = stubFetch().mockReturnValue(
      new Promise<Response>(() => undefined),
    );

    renderWithQuery(<LoginView />);
    fillCredentials();
    submit();

    const button = await screen.findByRole('button', {
      name: 'Anmeldung läuft…',
    });
    expect(button.hasAttribute('disabled')).toBe(true);

    // Even bypassing the disabled button must not produce a second request.
    fireEvent.submit(button.closest('form') ?? button);
    expect(loginCalls(fetchMock)).toHaveLength(1);
  });

  it('explains a failed session check without blocking the form', () => {
    renderWithQuery(<LoginView sessionCheckFailed />);

    expect(
      screen.getByText(/Der Anmeldestatus konnte nicht geprüft werden/),
    ).toBeDefined();
    expect(
      screen.getByRole('button', { name: 'Anmelden' }).hasAttribute('disabled'),
    ).toBe(false);
  });

  describe('the SSO half ', () => {
    const offer = [
      {
        tenantId: '01919c3f-0000-7000-8000-00000000abcd',
        name: 'Ortsgruppe Musterstadt',
        shortName: 'Musterstadt',
        buttonLabel: 'Mit Musterstadt-Konto anmelden',
      },
    ];

    it('offers a button per organisation, pointing at the server route', async () => {
      stubRoutes(offer, emptyResponse(401));

      renderWithQuery(<LoginView />);

      // Beide Texte im zugänglichen Namen, in dieser Reihenfolge: der
      // Organisationsname trägt die Unterscheidung, die Beschriftung die
      // Handlung.
      const link = await screen.findByRole('link', {
        name: 'Ortsgruppe Musterstadt Mit Musterstadt-Konto anmelden',
      });
      // A **navigation** to the API, not a `fetch`: the server answers with a
      // redirect to the provider and sets the transaction cookie on the way.
      expect(link.getAttribute('href')).toBe(
        '/api/auth/oidc/start/01919c3f-0000-7000-8000-00000000abcd',
      );
      // The offer carries the organisation and the caption and nothing else — no
      // issuer, no client id — so there is nothing here to render by accident.
      expect(document.body.textContent).not.toMatch(/https?:\/\//);
    });

    /**
     * **Der Fall, für den der Organisationsname im Knopf steht.**
     *
     * `oidcButtonLabel` ist optional, und der Server setzt dafür
     * {@link DEFAULT_OIDC_BUTTON_LABEL} ein — *denselben Satz* für jede
     * Organisation, die keine eigene Beschriftung gepflegt hat. Ohne den Namen
     * war eine Installation mit mehreren solchen Organisationen eine Reihe
     * wortgleicher Schaltflächen, die sich nur in ihrer Adresse unterschieden:
     * nichts, wonach jemand auswählen kann.
     *
     * Der Test prüft deshalb die *Unterscheidbarkeit*, nicht das Markup —
     * `getByRole('link', { name })` findet nur, was auch eine Vorlesehilfe
     * auseinanderhält, und wäre mehrdeutig, wenn beide Namen gleich lauteten.
     */
    it('keeps two organisations apart when both fall back to the shipped caption', async () => {
      stubRoutes(
        [
          {
            tenantId: '01919c3f-0000-7000-8000-00000000abcd',
            name: 'Ortsgruppe Musterstadt',
            shortName: 'Musterstadt',
            buttonLabel: DEFAULT_OIDC_BUTTON_LABEL,
          },
          {
            tenantId: '01919c3f-0000-7000-8000-0000000012ef',
            name: 'Ortsgruppe Beispieldorf',
            shortName: 'Beispieldorf',
            buttonLabel: DEFAULT_OIDC_BUTTON_LABEL,
          },
        ],
        emptyResponse(401),
      );

      renderWithQuery(<LoginView />);

      const first = await screen.findByRole('link', {
        name: `Ortsgruppe Musterstadt ${DEFAULT_OIDC_BUTTON_LABEL}`,
      });
      const second = screen.getByRole('link', {
        name: `Ortsgruppe Beispieldorf ${DEFAULT_OIDC_BUTTON_LABEL}`,
      });
      expect(first.getAttribute('href')).toBe(
        '/api/auth/oidc/start/01919c3f-0000-7000-8000-00000000abcd',
      );
      expect(second.getAttribute('href')).toBe(
        '/api/auth/oidc/start/01919c3f-0000-7000-8000-0000000012ef',
      );
    });

    it('shows nothing when no organisation offers SSO', async () => {
      stubRoutes([], emptyResponse(401));

      renderWithQuery(<LoginView />);

      await waitFor(() => {
        expect(screen.getByLabelText('E-Mail-Adresse')).toBeDefined();
      });
      expect(screen.queryAllByRole('link')).toHaveLength(0);
    });

    it('keeps the password form usable when the offer cannot be loaded', async () => {
      // Every call fails, the offer included.
      stubFetch().mockResolvedValue(emptyResponse(500));

      renderWithQuery(<LoginView />);

      await waitFor(() => {
        expect(
          screen
            .getByRole('button', { name: 'Anmelden' })
            .hasAttribute('disabled'),
        ).toBe(false);
      });
      // A failed offer is not an error banner: the list is a convenience and
      // the server refuses an organisation that does not offer SSO regardless.
      expect(screen.queryByTestId('sso-error')).toBeNull();
    });

    it.each([
      ['abgelehnt', /kein Zugang vor/],
      ['ohne-Organisation', /gehört aber zu keiner Organisation/],
      ['fehlgeschlagen', /ist fehlgeschlagen/],
    ])('explains the outcome code %s', async (code, expected) => {
      stubRoutes(offer, emptyResponse(401));
      window.history.replaceState({}, '', `/?sso=${code}`);

      renderWithQuery(<LoginView />);

      const alert = await screen.findByTestId('sso-error');
      expect(alert.textContent).toMatch(expected);
      window.history.replaceState({}, '', '/');
    });

    it('takes the code out of the address once it has been shown', async () => {
      stubRoutes(offer, emptyResponse(401));
      window.history.replaceState({}, '', '/?sso=abgelehnt&weiter=egal');

      renderWithQuery(<LoginView />);

      // The message is shown …
      expect((await screen.findByTestId('sso-error')).textContent).toMatch(
        /kein Zugang vor/,
      );
      // … and the code is gone, so a reload does not repeat it over a page it
      // has nothing to do with. Everything else in the query stays.
      expect(window.location.search).toBe('?weiter=egal');
      window.history.replaceState({}, '', '/');
    });

    it('clears a code it refuses to render, too', () => {
      stubRoutes(offer, emptyResponse(401));
      window.history.replaceState({}, '', '/?sso=frei-erfunden');

      renderWithQuery(<LoginView />);

      expect(screen.queryByTestId('sso-error')).toBeNull();
      expect(window.location.search).toBe('');
      window.history.replaceState({}, '', '/');
    });

    it('says nothing at all for a code the server never sends', () => {
      stubRoutes(offer, emptyResponse(401));
      // The whole reason the address carries a **code** and not a message: a
      // sentence taken from the query string would be arbitrary wording on our
      // own login page.
      window.history.replaceState(
        {},
        '',
        '/?sso=' +
          encodeURIComponent('Ihr Konto wurde gesperrt. Rufen Sie an!'),
      );

      renderWithQuery(<LoginView />);

      expect(screen.queryByTestId('sso-error')).toBeNull();
      expect(document.body.textContent).not.toMatch(/Rufen Sie an/);
      window.history.replaceState({}, '', '/');
    });

    it('does not distinguish “no invitation” from “that is a local account”', async () => {
      stubRoutes(offer, emptyResponse(401));
      window.history.replaceState({}, '', '/?sso=abgelehnt');

      renderWithQuery(<LoginView />);

      const alert = await screen.findByTestId('sso-error');
      // ADR-0012 no. 3 step 3: one sentence for both, or the login page becomes
      // a directory of who has an account in this installation.
      expect(alert.textContent).not.toMatch(
        /Einladung|lokal|Passwort|existiert|unbekannt/i,
      );
      window.history.replaceState({}, '', '/');
    });
  });
});
