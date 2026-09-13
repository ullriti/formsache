import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithQuery } from '../test/render-with-query';
import { PasswordResetView } from './PasswordResetView';

const TOKEN = 'AbCd_1234-xyz';

/**
 * **One page, two wordings** (ADR-0024).
 *
 * The page behind `/password/` and the one behind `/invitation/` are the same:
 * the same two fields, the same route, the same refusal. What
 * differs are four sentences — and the difference is not cosmetics:
 * „Neues Passwort vergeben" is the wrong sentence for somebody who has never had
 * one. They then look for the old one and take the link for broken.
 *
 * *Counter-check:* let the invitation entry in `WORDING` point at the one for the
 * reset → the second case turns red, and at the heading at that.
 */
describe('PasswordResetView', () => {
  it('sagt „Neues Passwort vergeben", wenn der Rücksetz-Link sie geöffnet hat', () => {
    renderWithQuery(<PasswordResetView token={TOKEN} mode="reset" />);

    expect(
      screen.getByRole('heading', { name: 'Neues Passwort vergeben' }),
    ).toBeDefined();
    expect(screen.getByLabelText('Neues Passwort')).toBeDefined();
    // The sentence about the ended sessions belongs to the reset: it
    // describes what happens to the **existing** logins.
    expect(
      screen.getByText(/alle offenen Anmeldungen dieses Kontos beendet/u),
    ).toBeDefined();
  });

  it('begrüßt stattdessen, wenn der Einladungslink sie geöffnet hat', () => {
    renderWithQuery(<PasswordResetView token={TOKEN} mode="invitation" />);

    expect(
      screen.getByRole('heading', { name: 'Willkommen bei Formsache' }),
    ).toBeDefined();
    // No „neues": this password is the first one.
    expect(screen.getByLabelText('Dein Passwort')).toBeDefined();
    expect(screen.queryByLabelText('Neues Passwort')).toBeNull();
    expect(
      screen.getByText(/Für dich wurde ein Konto angelegt/u),
    ).toBeDefined();
  });

  /**
   * What **both** versions share: the repetition, the button and the
   * minimum length. A `Record` with four sentences must not tempt anybody into
   * duplicating the rest.
   */
  it('zeigt in beiden Fassungen dieselbe Maske', () => {
    for (const mode of ['reset', 'invitation'] as const) {
      const view = renderWithQuery(
        <PasswordResetView token={TOKEN} mode={mode} />,
      );
      expect(screen.getByLabelText('Passwort wiederholen')).toBeDefined();
      expect(
        screen.getByRole('button', { name: 'Passwort setzen' }),
      ).toBeDefined();
      view.unmount();
    }
  });
});
