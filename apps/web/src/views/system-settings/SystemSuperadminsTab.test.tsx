import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  emptyResponse,
  jsonResponse,
  requestUrl,
  stubFetch,
  type FetchMock,
} from '../../test/fetch-mock';
import { renderWithQuery } from '../../test/render-with-query';
import { SystemSuperadminsTab } from './SystemSuperadminsTab';

/**
 * *Systemverwaltung · Superadmins* (ADR-0029).
 *
 * Five things are held here that a screenshot does not show:
 *
 * 1. **Nothing here decides what the server decides.** The button
 *    „Ernennung zurücknehmen" stands on **every** row — on one's own as well
 *    and on the only one as well. An interface that forbids more than the
 *    server lies about the rule (`MemberRow` writes it out one level
 *    deeper); what it does instead is show the server's sentence.
 * 2. **The 409 of the last superadministrator stands in the row** and not
 *    in an invented replacement sentence. It is the one refusal for which this
 *    whole interface was built.
 * 3. **A confirmation prompt before every withdrawal**, with **two** wordings: what one
 *    takes from oneself, one cannot give back to oneself.
 * 4. **The id is encoded** when it travels into the address.
 * 5. **The two warnings of the row** — no place, never logged in — stand
 *    there before anybody clicks. The first is the preview of a refusal, the
 *    second the information about who actually holds this appointment in hand.
 */

const YOU = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const YOU_ROW = {
  userId: YOU,
  email: 'du@example.org',
  name: 'Dana Beispiel',
  hasMembership: true,
  invitationPending: false,
};

const OTHER_ROW = {
  userId: OTHER,
  email: 'zweite@example.org',
  name: 'Robin Zweite',
  hasMembership: true,
  invitationPending: false,
};

function listOf(...rows: object[]) {
  return { superadmins: rows };
}

async function renderLoaded(document_: object = listOf(YOU_ROW, OTHER_ROW)) {
  const fetchMock = stubFetch().mockResolvedValue(jsonResponse(200, document_));
  renderWithQuery(<SystemSuperadminsTab currentUserId={YOU} />);
  await screen.findByText('Dana Beispiel');
  return fetchMock;
}

/** The request that an action triggered — method and address. */
function callsOf(fetchMock: FetchMock, method: string) {
  return fetchMock.mock.calls.filter(
    (call) =>
      ((call[1] as { method?: string } | undefined)?.method ?? 'GET') ===
      method,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('der Reiter „Superadmins"', () => {
  it('zählt, wer das System verwaltet, und nennt die Personen', async () => {
    await renderLoaded();

    expect(
      screen.getByRole('heading', { name: '2 Personen verwalten das System' }),
    ).toBeTruthy();
    expect(screen.getByText('du@example.org')).toBeTruthy();
    expect(screen.getByText('Robin Zweite')).toBeTruthy();
    // One's own row is marked — the sentence of the prompt hangs on it.
    expect(screen.getByText('Du')).toBeTruthy();
  });

  it('bietet den Entzug auch auf der einzigen Zeile an', async () => {
    // **The core of no. 1.** A single person, and the button stands
    // there nonetheless: the refusal is the server's, not this view's.
    await renderLoaded(listOf(YOU_ROW));

    expect(
      screen.getByRole('button', {
        name: 'Ernennung von Dana Beispiel zurücknehmen',
      }),
    ).toBeTruthy();
  });

  it('fragt vor dem Entzug nach — mit zwei Sätzen für zwei Fälle', async () => {
    await renderLoaded();

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Ernennung von Dana Beispiel zurücknehmen',
      }),
    );
    expect(
      screen.getByText(/Du nimmst dir selbst die Systemverwaltung/u),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Ernennung von Robin Zweite zurücknehmen',
      }),
    );
    expect(
      screen.getByText(
        /„Robin Zweite“ verwaltet das System danach nicht mehr/u,
      ),
    ).toBeTruthy();
  });

  it('schickt den Entzug erst nach der Bestätigung — mit kodierter Kennung', async () => {
    const fetchMock = await renderLoaded();

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Ernennung von Robin Zweite zurücknehmen',
      }),
    );
    // Up to here nothing has gone out: the prompt is not the action,
    // it stands before it.
    expect(callsOf(fetchMock, 'DELETE')).toHaveLength(0);

    fetchMock.mockResolvedValue(emptyResponse(204));
    fireEvent.click(
      screen.getByRole('button', { name: 'Ernennung zurücknehmen' }),
    );

    await waitFor(() => {
      expect(callsOf(fetchMock, 'DELETE')).toHaveLength(1);
    });
    expect(requestUrl(callsOf(fetchMock, 'DELETE')[0]?.[0] as string)).toBe(
      `/api/admin/superadmins/${encodeURIComponent(OTHER)}`,
    );
  });

  it('zeigt die Absage des Servers, wenn der letzte gehen will', async () => {
    const fetchMock = await renderLoaded(listOf(YOU_ROW));
    const refusal =
      'Diese Person ist die letzte Superadministratorin oder der letzte ' +
      'Superadministrator dieser Installation.';

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Ernennung von Dana Beispiel zurücknehmen',
      }),
    );
    fetchMock.mockResolvedValue(jsonResponse(409, { message: refusal }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Ernennung zurücknehmen' }),
    );

    // Literally the server's sentence and no replacement from the interface: the
    // rule is formulated at one place, and that is the one that
    // enforces it.
    expect(await screen.findByText(refusal)).toBeTruthy();
  });

  it('warnt bei einem Konto ohne Organisation und bei einer offenen Einladung', async () => {
    await renderLoaded(
      listOf(YOU_ROW, {
        ...OTHER_ROW,
        hasMembership: false,
        invitationPending: true,
      }),
    );

    expect(screen.getByText(/In keiner Organisation Mitglied/u)).toBeTruthy();
    expect(screen.getByText(/hat sich noch nie angemeldet/u)).toBeTruthy();
  });

  it('ernennt über eine Adresse und meldet, wer es geworden ist', async () => {
    const fetchMock = await renderLoaded();

    fireEvent.change(screen.getByLabelText('E-Mail-Adresse'), {
      target: { value: '  Dritte@Example.ORG ' },
    });
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: '  Kim Dritte ' },
    });
    fetchMock.mockResolvedValue(
      jsonResponse(201, {
        userId: '33333333-3333-4333-8333-333333333333',
        email: 'dritte@example.org',
        name: 'Kim Dritte',
        hasMembership: true,
        invitationPending: false,
        invited: false,
      }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Zur Systemverwaltung hinzufügen' }),
    );

    await waitFor(() => {
      expect(callsOf(fetchMock, 'POST')).toHaveLength(1);
    });
    const [, init] = callsOf(fetchMock, 'POST')[0] ?? [];
    /*
      **Trimmed, but not lower-cased.** The spelling is decided by
      `emailAddressSchema` on the server; a second normalization in this
      view would be a second version of the same rule. The case records exactly
      that — were the view to do more here, it would be red.
    */
    expect(JSON.parse(String((init as { body?: string }).body))).toEqual({
      email: 'Dritte@Example.ORG',
      name: 'Kim Dritte',
    });
    expect(
      await screen.findByText('✓ Kim Dritte verwaltet jetzt das System.'),
    ).toBeTruthy();
  });

  /**
   * **Eine Adresse ohne Konto wird eingeladen** (Review-Runde 3 Nr. 13):
   * *„dort würde ich ja auch gerne jemanden einladen, der in keiner Orga
   * ist."*
   *
   * Gemessen wird der Satz, der den Unterschied trägt: bei einem vorhandenen
   * Konto ändert sich eine Spalte, hier entsteht ein Konto **und** eine Mail
   * geht hinaus. Ohne diesen Zusatz führe die Person, die eingeladen hat, in
   * dem Glauben fort, die andere könne sich sofort anmelden.
   */
  it('sagt es, wenn dabei ein Konto entstanden ist', async () => {
    const fetchMock = await renderLoaded();

    fireEvent.change(screen.getByLabelText('E-Mail-Adresse'), {
      target: { value: 'neu@example.org' },
    });
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Neue Person' },
    });
    fetchMock.mockResolvedValue(
      jsonResponse(201, {
        userId: '44444444-4444-4444-8444-444444444444',
        email: 'neu@example.org',
        name: 'Neue Person',
        // In keiner Organisation — genau der Fall, um den es geht.
        hasMembership: false,
        invitationPending: true,
        invited: true,
      }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Zur Systemverwaltung hinzufügen' }),
    );

    const flash = await screen.findByRole('status');
    expect(flash.textContent).toContain(
      'Neue Person verwaltet jetzt das System',
    );
    expect(flash.textContent).toContain('neu angelegt');
    expect(flash.textContent).toContain('Einladung');
  });

  /**
   * ⚠️ **Ging die Einladung nicht hinaus, entsteht kein Konto.** Der Server
   * nimmt es zurück und antwortet 422 mit seinem Satz — die Ansicht zeigt
   * genau den, statt „Bitte erneut versuchen", das hier nichts erklärte.
   */
  it('zeigt die Absage des Servers, wenn die Einladung scheitert', async () => {
    const fetchMock = await renderLoaded();

    fireEvent.change(screen.getByLabelText('E-Mail-Adresse'), {
      target: { value: 'neu@example.org' },
    });
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Neue Person' },
    });
    fetchMock.mockResolvedValue(
      jsonResponse(422, {
        message: 'Die Einladung konnte nicht verschickt werden.',
      }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Zur Systemverwaltung hinzufügen' }),
    );

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Die Einladung konnte nicht verschickt werden.',
    );
  });

  it('sagt bei 403 den Satz, den jede Superadmin-Ansicht sagt', async () => {
    stubFetch().mockResolvedValue(jsonResponse(403, { message: 'nein' }));
    renderWithQuery(<SystemSuperadminsTab currentUserId={YOU} />);

    expect(
      // Literally the version from `api-messages.ts` — the sentence by which
      // the E2E run too recognizes the locked address.
      await screen.findByText('Diese Ansicht ist Superadmins vorbehalten.'),
    ).toBeTruthy();
  });
});
