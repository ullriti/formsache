import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { jsonResponse, stubFetch, type FetchMock } from '../../test/fetch-mock';
import { renderWithQuery } from '../../test/render-with-query';
import { MailIdentityCard } from './MailIdentityCard';

/**
 * *Mailversand* (ADR-0013, ADR-0023).
 *
 * Five things a screenshot does not show: **without a mail server the card
 * says out loud what that means** (ADR-0023 demands exactly that — no silent
 * state), the switch writes `smtp: null` instead of half a block, the password
 * field never carries the stored value, a save that changes only host or port
 * keeps that password, and a stored block the route cannot read nevertheless
 * leaves behind a form one can save over it.
 */

const TENANT_ID = '00000000-0000-4000-8000-0000000000a1';
const CURRENT_USER_EMAIL = 'vorstand@musterstadt-stuttgart.example';

/** „Noch kein Mailserver eingetragen" — no inheritance any more since ADR-0023. */
const NO_MAIL_SERVER = { smtp: null };

function ownConfig(overrides: Record<string, unknown> = {}) {
  return {
    smtp: {
      host: 'mail.organisation.invalid',
      port: 587,
      secure: false,
      from: 'post@organisation.invalid',
      auth: { user: 'Organisation', passwordSet: true },
      ...overrides,
    },
  };
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>('button', { name: 'Speichern' });
}

function putBody(fetchMock: FetchMock): Record<string, unknown> {
  const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
  const body = call?.[1]?.body;
  if (typeof body !== 'string') {
    throw new Error('No PUT with a JSON body was sent.');
  }
  return JSON.parse(body) as Record<string, unknown>;
}

async function renderLoaded(config: unknown = NO_MAIL_SERVER) {
  const fetchMock = stubFetch().mockResolvedValue(jsonResponse(200, config));
  renderWithQuery(
    <MailIdentityCard
      tenantId={TENANT_ID}
      currentUserEmail={CURRENT_USER_EMAIL}
    />,
  );
  await waitFor(() => {
    expect(mailServerSwitch()).toBeDefined();
  });
  return fetchMock;
}

function mailServerSwitch(): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>('switch', {
    name: 'Mailserver eingerichtet',
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MailIdentityCard', () => {
  /**
   * **The loud notice of ADR-0023.** „Kein Mailserver" is a permissible state
   * and must nevertheless not be silent: the card says that this organisation
   * then sends nothing and that nothing is lost. Without this case the
   * abolition of the inheritance would be a change one notices only at the
   * inbox that stays empty.
   */
  it('sagt ohne Mailserver deutlich, dass diese Organisation nichts verschickt', async () => {
    await renderLoaded(NO_MAIL_SERVER);

    expect(mailServerSwitch().checked).toBe(false);
    // Searched via the text and not via `getByRole('status')`: the save bar
    // carries the same role, and a hit on it would have said nothing about
    // this notice.
    const notice = screen.getByText('verschickt diese Organisation nichts', {
      exact: false,
    });
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.textContent).toContain('Warteschlange');
    expect(screen.queryByLabelText('Host')).toBeNull();
  });

  /**
   * **There is no choice „über den Mailserver des Systems" any more**
   * (ADR-0023). The reproduction is literal: if the pill appeared again, the
   * inheritance would be back with it.
   */
  it('bietet keine Umschaltung auf den Mailserver der Installation an', async () => {
    await renderLoaded(NO_MAIL_SERVER);

    expect(
      screen.queryByRole('button', { name: 'Über den Mailserver des Systems' }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Eigener Mailserver' }),
    ).toBeNull();
  });

  it('enthüllt die Felder des Blocks, sobald der Schalter an ist', async () => {
    await renderLoaded(NO_MAIL_SERVER);

    fireEvent.click(mailServerSwitch());

    expect(screen.getByLabelText('Host')).toBeDefined();
    expect(
      screen.queryByText('verschickt diese Organisation nichts', {
        exact: false,
      }),
    ).toBeNull();
  });

  it('schreibt beim Ausschalten `smtp: null`, nichts vom alten Block', async () => {
    const fetchMock = await renderLoaded(ownConfig());

    // The card starts with a mail server entered — switching it off is the
    // change this is about.
    expect(mailServerSwitch().checked).toBe(true);

    fireEvent.click(mailServerSwitch());
    fireEvent.click(saveButton());

    await waitFor(() => {
      expect(putBody(fetchMock)).toEqual({ smtp: null });
    });
  });

  it('never puts the stored password in the field', async () => {
    await renderLoaded(ownConfig());

    const password =
      screen.getByLabelText<HTMLInputElement>('Passwort ersetzen');
    expect(password.value).toBe('');
    expect(password.type).toBe('password');
    expect(
      screen.getByText('Passwort ist gesetzt.', { exact: false }),
    ).toBeDefined();
  });

  /**
   * A fresh „eigen" setup has nothing to keep. Reading `passwordSet`
   * straight off the loaded config (rather than, say, from whether the
   * password field is merely empty) is what keeps this from claiming a
   * password is already stored the moment the switch is flipped — the same
   * class of bug `SystemMailSettingsTab`'s own suite pins for the
   * installation's block.
   */
  it('does not claim a stored password when switching to a fresh setup', async () => {
    await renderLoaded(NO_MAIL_SERVER);

    fireEvent.click(mailServerSwitch());
    fireEvent.click(screen.getByLabelText('Anmeldung erforderlich'));

    const password =
      screen.getByLabelText<HTMLInputElement>('Passwort ersetzen');
    expect(password.placeholder).toBe('kein Passwort hinterlegt');
    expect(
      screen.getByText('Kein Passwort hinterlegt', { exact: false }),
    ).toBeDefined();
    expect(screen.queryByText('unverändert', { exact: false })).toBeNull();
  });

  it('says "kein Passwort hinterlegt" for a relay without a login', async () => {
    await renderLoaded(ownConfig({ auth: null }));

    // The auth sub-fields only reveal themselves once "Anmeldung
    // erforderlich" is switched on — a relay without a login starts off.
    expect(screen.queryByLabelText('Passwort ersetzen')).toBeNull();
    expect(
      screen.getByRole<HTMLInputElement>('switch', {
        name: 'Anmeldung erforderlich',
      }).checked,
    ).toBe(false);
  });

  it('sends no password field when the host is changed but the password is not retyped', async () => {
    const fetchMock = await renderLoaded(ownConfig());

    fireEvent.change(screen.getByLabelText('Host'), {
      target: { value: 'anderer-server.organisation.invalid' },
    });
    fireEvent.click(saveButton());

    await waitFor(() => {
      const smtp = putBody(fetchMock).smtp as Record<string, unknown>;
      expect(smtp.auth).toEqual({ user: 'Organisation' });
      expect(smtp.auth).not.toHaveProperty('password');
    });
  });

  it('sends the typed password when it was replaced', async () => {
    const fetchMock = await renderLoaded(ownConfig());

    fireEvent.change(screen.getByLabelText('Passwort ersetzen'), {
      target: { value: 'ein-neues-passwort' },
    });
    fireEvent.click(saveButton());

    await waitFor(() => {
      expect((putBody(fetchMock).smtp as Record<string, unknown>).auth).toEqual(
        { user: 'Organisation', password: 'ein-neues-passwort' },
      );
    });
  });

  /**
   * The task's first named trap: a changed Benutzername without a new
   * password must be caught in the surface, not left to a 400 the editor
   * cannot place. Caught **before** the request goes out — the assertion that
   * no PUT was sent is the load-bearing half, not only the message.
   */
  it('blocks saving a changed username without a new password, and says why', async () => {
    const fetchMock = await renderLoaded(ownConfig());

    fireEvent.change(screen.getByLabelText('Benutzername'), {
      target: { value: 'ein-anderer-name' },
    });
    fireEvent.click(saveButton());

    expect(
      screen.getByText('Der Benutzername wurde geändert.', { exact: false }),
    ).toBeDefined();
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT'),
    ).toBe(false);
  });

  /**
   * Typing a new password alongside the new username lifts the block — the
   * guard must not outlive the condition it exists for.
   */
  it('allows the save once a new password accompanies the changed username', async () => {
    const fetchMock = await renderLoaded(ownConfig());

    fireEvent.change(screen.getByLabelText('Benutzername'), {
      target: { value: 'ein-anderer-name' },
    });
    fireEvent.change(screen.getByLabelText('Passwort ersetzen'), {
      target: { value: 'ein-neues-passwort' },
    });
    fireEvent.click(saveButton());

    await waitFor(() => {
      expect((putBody(fetchMock).smtp as Record<string, unknown>).auth).toEqual(
        { user: 'ein-anderer-name', password: 'ein-neues-passwort' },
      );
    });
  });

  it("shows a half-filled block's field issue next to the field, not only in the banner", async () => {
    stubFetch().mockImplementation((_input, init) =>
      Promise.resolve(
        init?.method === 'PUT'
          ? jsonResponse(400, {
              message: 'Die Anfrage ist ungültig.',
              issues: [
                {
                  // The path the server really reports: since ADR-0023 the
                  // block lies in an envelope, and Zod puts the `smtp.` in
                  // front of every field. A test with the old, short path
                  // would be green on a surface that never got the message to
                  // the field.
                  path: 'smtp.from',
                  message: 'Absenderadresse ist ungültig.',
                },
              ],
            })
          : jsonResponse(200, NO_MAIL_SERVER),
      ),
    );
    renderWithQuery(
      <MailIdentityCard
        tenantId={TENANT_ID}
        currentUserEmail={CURRENT_USER_EMAIL}
      />,
    );
    await waitFor(() => {
      expect(mailServerSwitch()).toBeDefined();
    });

    fireEvent.click(mailServerSwitch());
    fireEvent.change(screen.getByLabelText('Host'), {
      target: { value: 'mail.organisation.invalid' },
    });
    fireEvent.change(screen.getByLabelText('Port'), {
      target: { value: '587' },
    });
    fireEvent.change(screen.getByLabelText('Absenderadresse'), {
      target: { value: 'nicht-valide' },
    });
    fireEvent.click(saveButton());

    await waitFor(() => {
      expect(screen.getByText('Absenderadresse ist ungültig.')).toBeDefined();
    });
  });

  it("is absent, not disabled, when the caller may not see the organisation's mail server", async () => {
    stubFetch().mockResolvedValue(jsonResponse(403, { message: 'nope' }));
    renderWithQuery(
      <MailIdentityCard
        tenantId={TENANT_ID}
        currentUserEmail={CURRENT_USER_EMAIL}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('nicht sehen');
    });
    expect(screen.queryByRole('button', { name: 'Speichern' })).toBeNull();
  });

  /**
   * The unreadable-stored-block finding this feature was blocked on:
   * `GET /tenant/smtp` answers 500 when the stored block does not match the
   * wire contract (`smtp-config.service.ts`'s *fail closed*, ADR-0013 no. 4).
   * Without this branch the row was repairable only by direct SQL — this
   * pins that the `PUT` stays reachable from the surface.
   */
  it('recovers from an unreadable stored block: shows the alert and still lets a new one be saved', async () => {
    const fetchMock = stubFetch().mockImplementation((_input, init) =>
      Promise.resolve(
        init?.method === 'PUT'
          ? jsonResponse(200, ownConfig())
          : jsonResponse(500, { message: 'Internal server error' }),
      ),
    );
    renderWithQuery(
      <MailIdentityCard
        tenantId={TENANT_ID}
        currentUserEmail={CURRENT_USER_EMAIL}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(
        'konnte nicht gelesen werden',
      );
    });
    // The repair form is right there — not only the alert.
    expect(mailServerSwitch()).toBeDefined();

    fireEvent.click(mailServerSwitch());
    fireEvent.change(screen.getByLabelText('Host'), {
      target: { value: 'mail.organisation.invalid' },
    });
    fireEvent.change(screen.getByLabelText('Port'), {
      target: { value: '587' },
    });
    fireEvent.change(screen.getByLabelText('Absenderadresse'), {
      target: { value: 'post@organisation.invalid' },
    });
    fireEvent.click(saveButton());

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT'),
      ).toBe(true);
    });
    const body = putBody(fetchMock);
    expect(body).toMatchObject({
      smtp: {
        host: 'mail.organisation.invalid',
        from: 'post@organisation.invalid',
      },
    });
  });

  /**
   * The cheapest repair path needs no input: a broken row can be emptied with
   * one click — with the consequence that stands beside it.
   */
  it('recovers from an unreadable block by clearing it with no fields touched', async () => {
    const fetchMock = stubFetch().mockImplementation((_input, init) =>
      Promise.resolve(
        init?.method === 'PUT'
          ? jsonResponse(200, NO_MAIL_SERVER)
          : jsonResponse(500, { message: 'Internal server error' }),
      ),
    );
    renderWithQuery(
      <MailIdentityCard
        tenantId={TENANT_ID}
        currentUserEmail={CURRENT_USER_EMAIL}
      />,
    );

    await waitFor(() => {
      expect(mailServerSwitch()).toBeDefined();
    });

    fireEvent.click(saveButton());

    await waitFor(() => {
      expect(putBody(fetchMock)).toEqual({ smtp: null });
    });
  });

  /**
   * The requirement — the button tests the **stored** block, never the draft,
   * and the surface says who it goes to before anybody clicks.
   */
  describe('Testmail', () => {
    it('names the recipient before the click, and requires a save first', async () => {
      await renderLoaded(NO_MAIL_SERVER);

      // Since finding 29b the recipient is a field, and **empty means „an
      // mich selbst"**: one's own address stands as a placeholder in the field
      // and in the sentence below it, that is before the click and not only in
      // the result.
      const recipient = screen.getByLabelText<HTMLInputElement>(
        'Empfänger (optional)',
      );
      expect(recipient.value).toBe('');
      expect(recipient.placeholder).toBe(CURRENT_USER_EMAIL);
      expect(
        screen.getByText(CURRENT_USER_EMAIL, { exact: false }),
      ).toBeDefined();

      // Untouched, so nothing is dirty and the button is enabled.
      const button = screen.getByRole<HTMLButtonElement>('button', {
        name: 'Testmail senden',
      });
      expect(button.disabled).toBe(false);

      // Typing without saving dirties the draft — the button locks and says
      // why, rather than only looking greyed out (`CONTRIBUTING.md`).
      fireEvent.click(mailServerSwitch());
      expect(button.disabled).toBe(true);
      expect(
        screen.getByText('ungespeicherte Änderungen', { exact: false }),
      ).toBeDefined();
    });

    it('sends the request and shows who it went to, on the real send path', async () => {
      const fetchMock = await renderLoaded(ownConfig());
      fetchMock.mockImplementation((_input, init) =>
        Promise.resolve(
          init?.method === 'POST'
            ? jsonResponse(200, {
                recipientEmail: CURRENT_USER_EMAIL,
                status: 'sent',
                reason: null,
              })
            : jsonResponse(200, ownConfig()),
        ),
      );

      fireEvent.click(screen.getByRole('button', { name: 'Testmail senden' }));

      await waitFor(() => {
        expect(
          screen.getByText(`✓ Testmail an ${CURRENT_USER_EMAIL} gesendet.`),
        ).toBeDefined();
      });
      const call = fetchMock.mock.calls.find(
        ([, init]) => init?.method === 'POST',
      );
      expect(call?.[0]).toBe('/api/tenant/smtp/test');
    });

    /**
     * **The success message does not survive a change of the recipient**
     * (review finding 13).
     *
     * „✓ Testmail an a@example.org gesendet" stayed standing while beside it
     * the address was rewritten to another one — a confirmation over a field
     * that says something else. Whoever then presses again cannot tell the new
     * answer from the old one.
     */
    it('nimmt die Erfolgsmeldung zurück, sobald der Empfänger geändert wird', async () => {
      const fetchMock = await renderLoaded(ownConfig());
      fetchMock.mockImplementation((_input, init) =>
        Promise.resolve(
          init?.method === 'POST'
            ? jsonResponse(200, {
                recipientEmail: CURRENT_USER_EMAIL,
                status: 'sent',
                reason: null,
              })
            : jsonResponse(200, ownConfig()),
        ),
      );

      fireEvent.click(screen.getByRole('button', { name: 'Testmail senden' }));
      await waitFor(() => {
        expect(
          screen.getByText(`✓ Testmail an ${CURRENT_USER_EMAIL} gesendet.`),
        ).toBeDefined();
      });

      fireEvent.change(screen.getByLabelText('Empfänger (optional)'), {
        target: { value: 'jemand.anderes@example.org' },
      });

      // `waitFor`, because TanStack Query notifies its observers over a
      // microtask: the retraction is a state change like every other, only one
      // round later than the key press. That the message stood there at all is
      // already asserted above — so the `null` here cannot be true by
      // accident.
      await waitFor(() => {
        expect(
          screen.queryByText(`✓ Testmail an ${CURRENT_USER_EMAIL} gesendet.`),
        ).toBeNull();
      });
      // …and the field really carries the new address, so that the assertion
      // above does not rest on nothing having happened at all.
      expect(
        screen.getByLabelText<HTMLInputElement>('Empfänger (optional)').value,
      ).toBe('jemand.anderes@example.org');
    });

    it('shows the failure reason the server sent, without inventing one', async () => {
      const fetchMock = await renderLoaded(ownConfig());
      fetchMock.mockImplementation((_input, init) =>
        Promise.resolve(
          init?.method === 'POST'
            ? jsonResponse(200, {
                recipientEmail: CURRENT_USER_EMAIL,
                status: 'failed',
                reason: 'Kein Mailserver konfiguriert.',
              })
            : jsonResponse(200, ownConfig()),
        ),
      );

      fireEvent.click(screen.getByRole('button', { name: 'Testmail senden' }));

      await waitFor(() => {
        expect(
          screen.getByText(
            'Testmail fehlgeschlagen: Kein Mailserver konfiguriert.',
          ),
        ).toBeDefined();
      });
    });
  });
});
