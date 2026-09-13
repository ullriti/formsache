import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { jsonResponse, stubFetch } from '../../test/fetch-mock';
import { renderWithQuery } from '../../test/render-with-query';
import { SystemMailSettingsTab } from './SystemMailSettingsTab';

/**
 * *Mailserver & Basis-Adresse* .
 *
 * Three things are held here that a screenshot cannot show: the password
 * field never carries the stored value, leaving it untouched sends no
 * password at all, and a server-named field issue lands on the field it
 * names rather than only in the banner.
 */

const CONFIGURED = {
  smtp: {
    host: 'mail.example.org',
    port: 587,
    secure: false,
    authUser: 'versand@example.org',
    from: 'versand@example.org',
  },
  publicBaseUrl: 'https://formulare.example.org',
  replyTo: null,
  opsAlertEmail: null,
};

function mailDocument(overrides: Record<string, unknown> = {}) {
  return { values: CONFIGURED, lock: 3, ...overrides };
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>('button', { name: 'Speichern' });
}

async function renderLoaded(doc = mailDocument()) {
  const fetchMock = stubFetch().mockResolvedValue(jsonResponse(200, doc));
  renderWithQuery(<SystemMailSettingsTab />);
  // "Host" only renders while "Mailserver eingerichtet" is on — not a signal
  // every fixture in this file can wait on, since an unconfigured mail server
  // is a fixture of its own.
  await waitFor(() => {
    expect(screen.getByLabelText('Mailserver eingerichtet')).toBeDefined();
  });
  return fetchMock;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SystemMailSettingsTab', () => {
  it('never puts the stored password in the field', async () => {
    await renderLoaded();

    const password =
      screen.getByLabelText<HTMLInputElement>('Passwort ersetzen');
    expect(password.value).toBe('');
    expect(password.type).toBe('password');
    expect(
      screen.getByText('Passwort ist gesetzt.', { exact: false }),
    ).toBeDefined();
  });

  /**
   * `document.values.smtp?.authUser !== null` reads `undefined !== null`
   * as `true` when `smtp` itself is `null`, so a fresh installation used to
   * claim a password was already stored the moment both switches were turned
   * on — exactly the state the e2e walkthrough's Schritt 1 begins from,
   * before anything has been saved.
   */
  it('does not claim a stored password on a fresh installation', async () => {
    await renderLoaded(
      mailDocument({
        values: {
          smtp: null,
          publicBaseUrl: null,
          replyTo: null,
          opsAlertEmail: null,
        },
      }),
    );

    fireEvent.click(screen.getByLabelText('Mailserver eingerichtet'));
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
    await renderLoaded(
      mailDocument({
        values: { ...CONFIGURED, smtp: { ...CONFIGURED.smtp, authUser: null } },
      }),
    );

    // The auth sub-fields only reveal themselves once "Anmeldung erforderlich"
    // is switched on — for a relay without a login that switch starts off.
    expect(screen.queryByLabelText('Passwort ersetzen')).toBeNull();
    expect(
      screen.getByRole<HTMLInputElement>('switch', {
        name: 'Anmeldung erforderlich',
      }).checked,
    ).toBe(false);
  });

  it('sends no password field when host is changed but the password is not retyped', async () => {
    const fetchMock = await renderLoaded();

    fireEvent.change(screen.getByLabelText('Host'), {
      target: { value: 'anderer-server.example.org' },
    });
    fireEvent.click(saveButton());

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT'),
      ).toBe(true);
    });
    const write = fetchMock.mock.calls.find(
      ([, init]) => init?.method === 'PUT',
    );
    const body = write?.[1]?.body;
    if (typeof body !== 'string') {
      throw new Error('The PUT carried no JSON body.');
    }
    const parsed = JSON.parse(body) as {
      smtp: { auth: Record<string, unknown> };
    };
    expect(parsed.smtp.auth).toEqual({ user: 'versand@example.org' });
    expect(parsed.smtp.auth).not.toHaveProperty('password');
  });

  it('sends the typed password when it was replaced', async () => {
    const fetchMock = await renderLoaded();

    fireEvent.change(screen.getByLabelText('Passwort ersetzen'), {
      target: { value: 'ein-neues-passwort' },
    });
    fireEvent.click(saveButton());

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT'),
      ).toBe(true);
    });
    const write = fetchMock.mock.calls.find(
      ([, init]) => init?.method === 'PUT',
    );
    const body = write?.[1]?.body;
    if (typeof body !== 'string') {
      throw new Error('The PUT carried no JSON body.');
    }
    const parsed = JSON.parse(body) as {
      smtp: { auth: Record<string, unknown> };
    };
    expect(parsed.smtp.auth).toEqual({
      user: 'versand@example.org',
      password: 'ein-neues-passwort',
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
                  path: 'smtp.auth.password',
                  message:
                    'Ohne gespeichertes Passwort muss beim Einrichten eines neuen Mailservers ein Passwort angegeben werden.',
                },
              ],
            })
          : jsonResponse(
              200,
              mailDocument({ values: { ...CONFIGURED, smtp: null } }),
            ),
      ),
    );
    renderWithQuery(<SystemMailSettingsTab />);
    await waitFor(() => {
      expect(screen.getByLabelText('Mailserver eingerichtet')).toBeDefined();
    });

    fireEvent.click(screen.getByLabelText('Mailserver eingerichtet'));
    fireEvent.change(screen.getByLabelText('Host'), {
      target: { value: 'mail.example.org' },
    });
    fireEvent.change(screen.getByLabelText('Port'), {
      target: { value: '587' },
    });
    fireEvent.change(screen.getByLabelText('Absenderadresse'), {
      target: { value: 'versand@example.org' },
    });
    fireEvent.click(screen.getByLabelText('Anmeldung erforderlich'));
    fireEvent.change(screen.getByLabelText('Benutzername'), {
      target: { value: 'versand' },
    });
    fireEvent.click(saveButton());

    await waitFor(() => {
      expect(
        screen.getByText(
          'Ohne gespeichertes Passwort muss beim Einrichten eines neuen Mailservers ein Passwort angegeben werden.',
        ),
      ).toBeDefined();
    });
  });

  it('does not send an unconfigured mail server as a half-filled block', async () => {
    const fetchMock = await renderLoaded(
      mailDocument({
        values: {
          smtp: null,
          publicBaseUrl: null,
          replyTo: null,
          opsAlertEmail: null,
        },
      }),
    );

    // `getByRole`, not `getByLabelText`: the card's own heading is also named
    // "Basis-Adresse" and is `aria-labelledby`'d to the section, so the label
    // text alone is ambiguous between the two.
    fireEvent.change(screen.getByRole('textbox', { name: 'Basis-Adresse' }), {
      target: { value: 'https://formulare.example.org' },
    });
    fireEvent.click(saveButton());

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT'),
      ).toBe(true);
    });
    const write = fetchMock.mock.calls.find(
      ([, init]) => init?.method === 'PUT',
    );
    const body = write?.[1]?.body;
    if (typeof body !== 'string') {
      throw new Error('The PUT carried no JSON body.');
    }
    expect(JSON.parse(body)).toMatchObject({
      smtp: null,
      publicBaseUrl: 'https://formulare.example.org',
    });
  });
});

/**
 * **The test mail section of this tab** (finding 29a).
 *
 * What is proven is the one thing a visual inspection does not see: **which
 * route** the button calls. Whether the route that is hit then really selects
 * the system block is the statement of the server and stands in
 * `apps/api/test/mail/test-mail-recipient.spec.ts` — what counts here is that
 * this page does not accidentally press the organisation route, because that
 * would be exactly the state the finding describes, only with a button in front
 * of it.
 */
describe('SystemMailSettingsTab — Testmail', () => {
  /**
   * The addresses of all `POST` calls.
   *
   * `fetch`'s first argument is a `RequestInfo | URL`; this application calls it
   * only with a string (`requestJson` in `api/http.ts`). That is **checked** and
   * not forced with `String()`: a `Request` object would otherwise run through
   * every assertion below as „[object Object]" and leave the test green.
   */
  function postCalls(fetchMock: ReturnType<typeof stubFetch>): string[] {
    return fetchMock.mock.calls
      .filter(([, init]) => init?.method === 'POST')
      .map(([input]) => {
        if (typeof input !== 'string') {
          throw new Error('fetch was called with something other than a URL.');
        }
        return input;
      });
  }

  /**
   * The body of the n-th `POST`, parsed.
   *
   * `RequestInit['body']` is a wide type; the requests of this application
   * always send a JSON string there. That is **checked** here and not forced
   * with `String()` — a body that is none is supposed to kill the test with a
   * readable sentence instead of running through `JSON.parse` as
   * „[object Object]".
   */
  function postBody(
    fetchMock: ReturnType<typeof stubFetch>,
    index: number,
  ): unknown {
    const call = fetchMock.mock.calls.filter(
      ([, init]) => init?.method === 'POST',
    )[index];
    const body = call?.[1]?.body;
    if (typeof body !== 'string') {
      throw new Error(`POST ${String(index)} carried no JSON body.`);
    }
    return JSON.parse(body);
  }

  it('ruft die Systemroute, nicht die der Organisation', async () => {
    const fetchMock = await renderLoaded();
    fetchMock.mockImplementation((_input, init) =>
      Promise.resolve(
        init?.method === 'POST'
          ? jsonResponse(200, {
              recipientEmail: 'super@example.org',
              status: 'sent',
              reason: null,
            })
          : jsonResponse(200, mailDocument()),
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Testmail senden' }));

    await waitFor(() => {
      expect(postCalls(fetchMock)).toHaveLength(1);
    });
    expect(postCalls(fetchMock)[0]).toContain(
      '/admin/system-settings/mail/test',
    );
    expect(postCalls(fetchMock)[0]).not.toContain('/tenant/smtp/test');
  });

  it('schickt die eingetippte Adresse mit — und ohne Eingabe ein `null`', async () => {
    const fetchMock = await renderLoaded();
    fetchMock.mockImplementation((_input, init) =>
      Promise.resolve(
        init?.method === 'POST'
          ? jsonResponse(200, {
              recipientEmail: 'betrieb@example.org',
              status: 'sent',
              reason: null,
            })
          : jsonResponse(200, mailDocument()),
      ),
    );

    // Without an entry: `null` means „to myself" — an empty string would be no
    // address and would get a 400 where nobody has done anything wrong.
    fireEvent.click(screen.getByRole('button', { name: 'Testmail senden' }));
    await waitFor(() => {
      expect(postCalls(fetchMock)).toHaveLength(1);
    });
    expect(postBody(fetchMock, 0)).toStrictEqual({ recipientEmail: null });

    fireEvent.change(screen.getByLabelText('Empfänger (optional)'), {
      target: { value: '  betrieb@example.org  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Testmail senden' }));

    await waitFor(() => {
      expect(postCalls(fetchMock)).toHaveLength(2);
    });
    // Trimmed, because a space from the clipboard is no part of an address —
    // and because the server would otherwise give a 400 for a typo that nobody
    // sees.
    expect(postBody(fetchMock, 1)).toStrictEqual({
      recipientEmail: 'betrieb@example.org',
    });
  });
});
