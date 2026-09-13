import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { USER_PASSWORD_MIN } from '@formsache/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProfileView } from './ProfileView';
import {
  emptyResponse,
  jsonResponse,
  requestUrl,
  stubFetch,
  type FetchMock,
} from '../test/fetch-mock';
import { sessionUser } from '../test/fixtures';
import { renderWithQuery } from '../test/render-with-query';

/**
 * **Mein Profil** — what the cards say before the server is asked
 * (findings 6 and 8).
 *
 * Three statements carry this file, and all three are behaviour and not
 * structure:
 *
 * 1. **A password that is too short says so.** Before, the button was mutely
 *    disabled — the view knew the reason and kept it to itself. An
 *    *empty* field must not complain while doing so: „noch nichts eingegeben" is no
 *    error.
 * 2. **The address change demands the current password and sends both in
 *    one call.** Without the proof it would be an account takeover that gives away
 *    an open session.
 * 3. **What the server refuses stands in the card** — its sentence, not one
 *    invented here: for 409 („Adresse belegt") and 422 („SSO-Konto") the
 *    rule lies on the server, and a second choice of words drifts away from it.
 *
 * ## Counter-check, measured while writing
 *
 * Remove the message „das Passwort braucht mindestens …": case 1 goes red.
 * Take the password prompt out of the body of the address change: case 2 goes
 * red and names the body that went instead.
 */

/** The body of a call to this path, read off the double. */
function sentBody(mock: FetchMock, path: string): unknown {
  const call = mock.mock.calls.find(([input]) =>
    requestUrl(input).endsWith(path),
  );
  const raw = call?.[1]?.body;
  if (typeof raw !== 'string') {
    throw new Error(`Kein JSON-Rumpf an ${path}.`);
  }
  return JSON.parse(raw);
}

const user = sessionUser();

function card(name: string): HTMLElement {
  return screen.getByRole('region', { name });
}

function fill(scope: HTMLElement, label: string, value: string): void {
  fireEvent.change(within(scope).getByLabelText(label), { target: { value } });
}

function press(scope: HTMLElement, name: string): void {
  fireEvent.click(within(scope).getByRole('button', { name }));
}

function saveButton(scope: HTMLElement, name: string): HTMLButtonElement {
  const element = within(scope).getByRole('button', { name });
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`„${name}" ist kein Knopf.`);
  }
  return element;
}

describe('ProfileView', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Passwort ändern', () => {
    it('sagt, was dem Passwort fehlt, statt den Knopf stumm zu sperren', async () => {
      stubFetch().mockResolvedValue(emptyResponse(204));
      renderWithQuery(<ProfileView user={user} />);
      const passwords = card('Passwort ändern');

      fill(passwords, 'Neues Passwort', 'kurz');

      const message = await within(passwords).findByText(
        new RegExp(`mindestens ${String(USER_PASSWORD_MIN)} Zeichen`),
      );
      expect(message).toBeDefined();
      expect(
        within(passwords)
          .getByLabelText('Neues Passwort')
          .getAttribute('aria-invalid'),
      ).toBe('true');
      expect(saveButton(passwords, 'Passwort ändern').disabled).toBe(true);
    });

    it('meckert nicht über ein Feld, in das noch niemand getippt hat', () => {
      stubFetch().mockResolvedValue(emptyResponse(204));
      renderWithQuery(<ProfileView user={user} />);
      const passwords = card('Passwort ändern');

      expect(
        within(passwords)
          .getByLabelText('Neues Passwort')
          .getAttribute('aria-invalid'),
      ).toBeNull();
      // The explanatory sentence in the header stays, of course; what must not
      // stand here is an **objection** at the field.
      expect(
        within(passwords).queryByText(/mindestens/i, {
          selector: '.setting__issue',
        }),
      ).toBeNull();
    });

    it('sperrt das Absenden, bis die Wiederholung stimmt — und sagt warum', async () => {
      const fetchMock = stubFetch().mockResolvedValue(emptyResponse(204));
      renderWithQuery(<ProfileView user={user} />);
      const passwords = card('Passwort ändern');
      const long = 'x'.repeat(USER_PASSWORD_MIN);

      fill(passwords, 'Aktuelles Passwort', 'altes-passwort');
      fill(passwords, 'Neues Passwort', long);
      // Nothing repeated yet: locked, but with a sentence beside it.
      expect(
        await within(passwords).findByText(
          'Bitte wiederhole das neue Passwort.',
        ),
      ).toBeDefined();
      expect(saveButton(passwords, 'Passwort ändern').disabled).toBe(true);

      fill(passwords, 'Neues Passwort wiederholen', `${long}!`);
      expect(
        within(passwords).getByText(
          'Die beiden Eingaben stimmen nicht überein.',
        ),
      ).toBeDefined();
      expect(saveButton(passwords, 'Passwort ändern').disabled).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();

      fill(passwords, 'Neues Passwort wiederholen', long);
      expect(saveButton(passwords, 'Passwort ändern').disabled).toBe(false);
    });
  });

  describe('E-Mail-Adresse ändern (Befund 8)', () => {
    it('schickt Adresse und aktuelles Passwort in **einem** Aufruf', async () => {
      const fetchMock = stubFetch().mockResolvedValue(
        jsonResponse(200, { ...user, email: 'neue@example.org' }),
      );
      renderWithQuery(<ProfileView user={user} />);
      const emails = card('E-Mail-Adresse ändern');

      fill(emails, 'Neue E-Mail-Adresse', 'neue@example.org');
      fill(emails, 'Aktuelles Passwort', 'mein-passwort');
      press(emails, 'Adresse ändern');

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalled();
      });
      expect(sentBody(fetchMock, '/auth/email')).toStrictEqual({
        currentPassword: 'mein-passwort',
        email: 'neue@example.org',
      });
    });

    it('bleibt gesperrt ohne Passwort und ohne geänderte Adresse', () => {
      stubFetch().mockResolvedValue(emptyResponse(204));
      renderWithQuery(<ProfileView user={user} />);
      const emails = card('E-Mail-Adresse ändern');

      // Nothing changed: nothing to do.
      expect(saveButton(emails, 'Adresse ändern').disabled).toBe(true);

      fill(emails, 'Neue E-Mail-Adresse', 'neue@example.org');
      // Address changed, but unpaid for — the password is the condition.
      expect(saveButton(emails, 'Adresse ändern').disabled).toBe(true);

      fill(emails, 'Aktuelles Passwort', 'mein-passwort');
      expect(saveButton(emails, 'Adresse ändern').disabled).toBe(false);
    });

    it('zeigt bei einem falschen Passwort den Satz des Servers, nicht „bitte anmelden"', async () => {
      stubFetch().mockResolvedValue(
        jsonResponse(401, { message: 'Das aktuelle Passwort ist falsch.' }),
      );
      renderWithQuery(<ProfileView user={user} />);
      const emails = card('E-Mail-Adresse ändern');

      fill(emails, 'Neue E-Mail-Adresse', 'neue@example.org');
      fill(emails, 'Aktuelles Passwort', 'falsch');
      press(emails, 'Adresse ändern');

      // The 401 does **not** mean „du bist nicht angemeldet" here — the page
      // is standing, after all. A passed-through „bitte anmelden" would be the most
      // misleading sentence this card could show.
      expect(
        await within(emails).findByText('Das aktuelle Passwort ist falsch.'),
      ).toBeDefined();
    });

    it('zeigt die 409 des Servers, wenn die Adresse schon jemandem gehört', async () => {
      stubFetch().mockResolvedValue(
        jsonResponse(409, {
          message:
            'Diese E-Mail-Adresse gehört bereits zu einem anderen Konto.',
        }),
      );
      renderWithQuery(<ProfileView user={user} />);
      const emails = card('E-Mail-Adresse ändern');

      fill(emails, 'Neue E-Mail-Adresse', 'belegt@example.org');
      fill(emails, 'Aktuelles Passwort', 'mein-passwort');
      press(emails, 'Adresse ändern');

      expect(
        await within(emails).findByText(
          'Diese E-Mail-Adresse gehört bereits zu einem anderen Konto.',
        ),
      ).toBeDefined();
    });

    it('zeigt die 422 eines SSO-Kontos — die Karte steht da, die Grenze steht auf dem Server', async () => {
      const refusal =
        'Dieses Konto meldet sich über Single Sign-on an. Die E-Mail-Adresse ' +
        'wird beim Anmeldedienst Ihrer Organisation gepflegt und kann hier ' +
        'nicht geändert werden.';
      stubFetch().mockResolvedValue(jsonResponse(422, { message: refusal }));
      renderWithQuery(<ProfileView user={user} />);
      const emails = card('E-Mail-Adresse ändern');

      fill(emails, 'Neue E-Mail-Adresse', 'neue@example.org');
      fill(emails, 'Aktuelles Passwort', 'egal');
      press(emails, 'Adresse ändern');

      expect(await within(emails).findByText(refusal)).toBeDefined();
    });
  });
});
