import { fireEvent, screen, waitFor } from '@testing-library/react';
import { USER_PASSWORD_MIN } from '@formsache/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SetupView } from './SetupView';
import {
  emptyResponse,
  jsonResponse,
  requestUrl,
  stubFetch,
} from '../test/fetch-mock';
import { renderWithQuery } from '../test/render-with-query';

/**
 * **The setup assistant** (ADR-0022, continuation 2026-08-18).
 *
 * Up to here this was one form; now it is seven steps, and the file measures
 * what is really decided about it — not how it looks:
 *
 * 1. **Step 1 sends `tenant: null`**, always. The first organisation is
 *    step 7 and goes over „+ Neue Organisation" — the same route as every
 *    later one. A second way to create an organisation would be a second
 *    place at which its groups and defaults come into being.
 * 2. **`POST /setup` is followed by `POST /auth/login`**, and out of this
 *    step at that. That is the session steps 2 to 8 live on —
 *    and the setup route still issues none.
 * 3. **Nothing goes out that the schema does not accept.** The check in the
 *    browser is convenience and not security — the server checks
 *    anyway —, but a form that waits for a 400 in order to say „das Passwort
 *    ist zu kurz" uses up one of the minute's ten calls for it.
 * 4. **Every step except the first can be skipped**, and the step position
 *    stands there as **text** — not only as a colour in a
 *    bar.
 *
 * ## Counter-probes, measured while writing
 *
 * - `tenant: null` replaced by half an object: the first case turns red and
 *   names the body that went instead.
 * - The login removed from `AccessStep`: „meldet sich danach an" turns red,
 *   and the assistant would run into every further step with a 401.
 * - The browser check removed: **both** „schickt nichts" cases turn red.
 */

/** The sent body of a call on `path`, read out of the double. */
function sentBody(mock: ReturnType<typeof stubFetch>, path: string): unknown {
  const call = mock.mock.calls.find(
    ([input, init]) =>
      requestUrl(input).endsWith(path) && init?.method === 'POST',
  );
  const raw = call?.[1]?.body;
  // Narrowed instead of claimed: `BodyInit` is a union, and a `String()` over
  // it turned a `Blob` into `[object Object]` without complaint — that is, into
  // a case that is green because it no longer compares anything.
  if (typeof raw !== 'string') {
    throw new Error(`Der Aufruf auf ${path} trug keinen JSON-Rumpf.`);
  }
  return JSON.parse(raw);
}

function fill(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function click(name: string): void {
  fireEvent.click(screen.getByRole('button', { name }));
}

function button(name: string): HTMLButtonElement {
  const element = screen.getByRole('button', { name });
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`„${name}" ist kein Knopf.`);
  }
  return element;
}

const SUBMIT = 'Zugang anlegen und weiter';
const PASSWORD = 'x'.repeat(USER_PASSWORD_MIN);

function fillAdmin(): void {
  fill('Name', 'Erste Superadministratorin');
  fill('E-Mail-Adresse', 'erste@example.org');
  fill('Passwort', PASSWORD);
  fill('Passwort wiederholen', PASSWORD);
}

/** The session payload `POST /auth/login` answers with. */
const SESSION = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'erste@example.org',
    name: 'Erste Superadministratorin',
    isSuperadmin: true,
    activeTenantId: null,
    memberships: [],
    aiFormsAvailable: false,
  },
};

/**
 * A double that answers the assistant's routes: 204 for the setup, a session
 * for the login, an empty mail document for step 2.
 */
function stubSetupFlow(): ReturnType<typeof stubFetch> {
  return stubFetch().mockImplementation((input: RequestInfo | URL) => {
    const url = requestUrl(input);
    if (url.endsWith('/setup')) {
      return Promise.resolve(emptyResponse(204));
    }
    if (url.endsWith('/auth/login')) {
      return Promise.resolve(jsonResponse(200, SESSION));
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
}

describe('SetupView', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('schickt immer `tenant: null` — die Organisation ist Schritt 8', async () => {
    const fetchMock = stubSetupFlow();

    renderWithQuery(<SetupView />);
    fillAdmin();
    click(SUBMIT);

    await waitFor(() => {
      expect(sentBody(fetchMock, '/setup')).toBeDefined();
    });
    expect(sentBody(fetchMock, '/setup')).toStrictEqual({
      admin: {
        email: 'erste@example.org',
        name: 'Erste Superadministratorin',
        password: PASSWORD,
      },
      tenant: null,
    });
  });

  /**
   * **The session comes about through an ordinary login** and not through
   * `POST /setup` being allowed more than before (ADR-0022 no. 2). Without it
   * every further step would run into a 401.
   */
  it('meldet sich danach mit denselben Zugangsdaten an', async () => {
    const fetchMock = stubSetupFlow();

    renderWithQuery(<SetupView />);
    fillAdmin();
    click(SUBMIT);

    await waitFor(() => {
      expect(sentBody(fetchMock, '/auth/login')).toBeDefined();
    });
    expect(sentBody(fetchMock, '/auth/login')).toStrictEqual({
      email: 'erste@example.org',
      password: PASSWORD,
    });
  });

  it('geht danach zu Schritt 2 und sagt die Position als Text', async () => {
    stubSetupFlow();

    renderWithQuery(<SetupView />);
    expect(screen.getByText('Schritt 1 von 8')).toBeDefined();

    fillAdmin();
    click(SUBMIT);

    expect(await screen.findByText('Schritt 2 von 8')).toBeDefined();
    expect(
      screen.getByRole('heading', { name: 'Basis-Adresse' }),
    ).toBeDefined();
  });

  /**
   * ⚠️ **Prefilled, but requiring confirmation** — the user's express wish.
   * `window.location.origin` is right most of the time and behind a reverse
   * proxy precisely not, and a wrong value produces links in mails that point
   * into the void and cannot be recalled.
   *
   * *Reproduction:* hide the field and adopt the value silently → this case
   * turns red.
   */
  it('belegt die Basis-Adresse aus der Aufruf-URL vor und legt sie sichtbar vor', async () => {
    stubSetupFlow();

    renderWithQuery(<SetupView />);
    fillAdmin();
    click(SUBMIT);

    // `selector`, because the card **and** its field carry the same accessible
    // name (the heading labels the section, the label the field).
    const field = await screen.findByLabelText<HTMLInputElement>(
      'Basis-Adresse',
      { selector: 'input' },
    );
    expect(field.value).toBe(window.location.origin);
    expect(
      screen.getByText(/hinter einem Reverse-Proxy/i, { selector: 'p' }),
    ).toBeDefined();
  });

  it('lässt Schritt 2 überspringen, ohne etwas zu schreiben', async () => {
    const fetchMock = stubSetupFlow();

    renderWithQuery(<SetupView />);
    fillAdmin();
    click(SUBMIT);
    await screen.findByText('Schritt 2 von 8');

    click('Überspringen');

    expect(await screen.findByText('Schritt 3 von 8')).toBeDefined();
    const writes = fetchMock.mock.calls.filter(
      ([, init]) => init?.method === 'PUT',
    );
    expect(writes).toHaveLength(0);
    // And the list says it as a **word**, not as a colour.
    expect(screen.getAllByText('übersprungen').length).toBeGreaterThan(0);
  });

  /** The first step has neither: before it is nothing, without it nothing works. */
  it('bietet im ersten Schritt weder „Zurück" noch „Überspringen"', () => {
    stubSetupFlow();

    renderWithQuery(<SetupView />);

    expect(screen.queryByRole('button', { name: 'Zurück' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Überspringen' })).toBeNull();
  });

  /**
   * **And step 2 has neither either** — the finding because of which `onBack`
   * became optional.
   *
   * Until then „Zurück" existed in *every* step except the first. Out of step
   * 2 it led back to `AccessStep`, and there the way ends: the
   * account stands, `POST /api/setup` answers 404, the form shows its
   * „gibt es schon" sentence and never calls `onDone()`. The only way out was a
   * reload — the assistant locked people in, although its own header promises
   * that nobody is blocked.
   *
   * *Counter-check:* in `SetupView.tsx` pull `index <= 1` to `index === 0` →
   * this case turns red.
   */
  it('bietet auch im zweiten Schritt kein „Zurück" — dorthin führt kein Weg zurück', async () => {
    stubSetupFlow();

    renderWithQuery(<SetupView />);
    fillAdmin();
    click(SUBMIT);
    await screen.findByText('Schritt 2 von 8');

    expect(screen.queryByRole('button', { name: 'Zurück' })).toBeNull();
    // „Überspringen" on the other hand yes: from here on every step is skippable.
    expect(screen.getByRole('button', { name: 'Überspringen' })).toBeDefined();
  });

  /** From step 3 on „Zurück" is there — and leads back one step, not two. */
  it('bietet ab dem dritten Schritt „Zurück" und geht damit auf Schritt 2', async () => {
    stubSetupFlow();

    renderWithQuery(<SetupView />);
    fillAdmin();
    click(SUBMIT);
    await screen.findByText('Schritt 2 von 8');
    click('Überspringen');
    await screen.findByText('Schritt 3 von 8');

    click('Zurück');

    expect(await screen.findByText('Schritt 2 von 8')).toBeDefined();
    /*
      The **field** and not the heading: on the way back the mail document is
      already in the cache, so the card is there at once —
      and then the frame's step heading **and** the card carry the
      name „Basis-Adresse". `selector: 'input'` points at exactly one of them.
    */
    expect(
      screen.getByLabelText('Basis-Adresse', { selector: 'input' }),
    ).toBeDefined();
  });

  it('schickt nichts, wenn das Passwort zu kurz ist — und sagt es **am Feld**', async () => {
    const fetchMock = stubSetupFlow();

    renderWithQuery(<SetupView />);
    fill('Name', 'Erste Superadministratorin');
    fill('E-Mail-Adresse', 'erste@example.org');
    fill('Passwort', 'kurz');
    fill('Passwort wiederholen', 'kurz');
    click(SUBMIT);

    expect(
      await screen.findByText(
        `Bitte wähle ein Passwort mit mindestens ${String(USER_PASSWORD_MIN)} Zeichen.`,
      ),
    ).toBeDefined();
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST'),
    ).toHaveLength(0);
  });

  it('beschuldigt nur die Adresse, wenn nur sie unbrauchbar ist', async () => {
    stubSetupFlow();

    renderWithQuery(<SetupView />);
    fill('Name', 'Erste Superadministratorin');
    fill('E-Mail-Adresse', 'keine-adresse');
    fill('Passwort', PASSWORD);
    fill('Passwort wiederholen', PASSWORD);
    click(SUBMIT);

    expect(
      await screen.findByText('Bitte gib eine gültige E-Mail-Adresse an.'),
    ).toBeDefined();
    expect(screen.queryByText(/Bitte gib deinen Namen an/u)).toBeNull();
  });

  it('nimmt die Meldung zurück, sobald jemand an dem Feld arbeitet', async () => {
    stubSetupFlow();

    renderWithQuery(<SetupView />);
    click(SUBMIT);
    expect(await screen.findByText('Bitte gib deinen Namen an.')).toBeDefined();

    fill('Name', 'E');

    expect(screen.queryByText('Bitte gib deinen Namen an.')).toBeNull();
  });

  it('sperrt den Knopf, solange die Wiederholung nicht stimmt', () => {
    stubSetupFlow();

    renderWithQuery(<SetupView />);
    fill('Name', 'Erste Superadministratorin');
    fill('E-Mail-Adresse', 'erste@example.org');
    fill('Passwort', PASSWORD);
    fill('Passwort wiederholen', `${PASSWORD}!`);

    expect(button(SUBMIT).disabled).toBe(true);

    fill('Passwort wiederholen', PASSWORD);

    expect(button(SUBMIT).disabled).toBe(false);
  });

  it('schickt die Wiederholung **nicht** mit — sie ist kein Feld des Vertrags', async () => {
    const fetchMock = stubSetupFlow();

    renderWithQuery(<SetupView />);
    fillAdmin();
    click(SUBMIT);

    await waitFor(() => {
      expect(sentBody(fetchMock, '/setup')).toBeDefined();
    });
    expect(JSON.stringify(sentBody(fetchMock, '/setup'))).not.toContain(
      'repeat',
    );
  });

  it('erklärt eine 404 als „inzwischen eingerichtet"', async () => {
    stubFetch().mockResolvedValue(jsonResponse(404, { message: 'weg' }));

    renderWithQuery(<SetupView />);
    fillAdmin();
    click(SUBMIT);

    expect(await screen.findByText(/inzwischen eingerichtet/u)).toBeDefined();
  });

  /**
   * The one case in which the access stands and the assistant nevertheless
   * cannot go on. It must not look as if nothing had happened — otherwise
   * somebody creates the account a second time and gets a 404.
   */
  it('sagt es, wenn der Zugang steht, die Anmeldung aber scheitert', async () => {
    stubFetch().mockImplementation((input: RequestInfo | URL) =>
      Promise.resolve(
        requestUrl(input).endsWith('/setup')
          ? emptyResponse(204)
          : jsonResponse(401, { message: 'nein' }),
      ),
    );

    renderWithQuery(<SetupView />);
    fillAdmin();
    click(SUBMIT);

    expect(
      await screen.findByText(
        /automatische Anmeldung hat aber nicht geklappt/u,
      ),
    ).toBeDefined();
  });
});
