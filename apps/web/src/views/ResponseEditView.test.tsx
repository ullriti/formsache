import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '../api/query-client';
import { jsonResponse, stubFetch } from '../test/fetch-mock';
import { renderWithQuery } from '../test/render-with-query';
import { ResponseEditView } from './ResponseEditView';

/**
 * „Bearbeiten nach Absenden", the participant's half.
 *
 * The server side is covered end to end in
 * `apps/api/test/public/response-edit.spec.ts`, and it is the side that
 * *decides*: every refusal here is the server's, and this file asserts that the
 * browser shows what came back rather than deciding anything of its own.
 *
 * What is worth checking on this side:
 *
 * - the answers arrive **pre-filled** — the whole promise of the requirement;
 * - the save is a `PUT` to the edit route, not a `POST` to the form;
 * - a refusal shows the server's own sentence rather than a second one written
 *   here;
 * - the two timestamps are shown apart, because they are kept apart.
 */

const TOKEN = 'AbCd_1234-xyzAbCd_123';
const NAME_ID = '019fe700-0000-7000-8000-000000000001';
const MEAL_ID = '019fe700-0000-7000-8000-000000000002';
const PAGE_ID = '019fe700-0000-7000-8000-0000000000a1';

const TENANT = {
  name: 'Dachorganisation',
  shortName: 'DACH',
  logoRef: null,
  branding: {
    accent: '#cea967',
    headerBg: '#212226',
    canvasBg: '#e9e6df',
    stripe: ['#212226', '#7c0800', '#cea967'],
    wideLogo: true,
  },
};

const SUBMITTED_AT = '2026-06-01T10:00:00.000Z';

function payload(overrides: Record<string, unknown> = {}) {
  return {
    form: {
      locked: false,
      title: 'Jahrestagung 2026',
      version: 1,
      tenant: TENANT,
      display: {
        showProgress: true,
        showPageNumbers: true,
        showRequiredHint: true,
      },
      availability: { state: 'open', opensAt: null, closesAt: null },
      eventSeats: [],
      // The requirement — `false` throughout here on purpose: editing a filed
      // answer is not a draft, and *Zwischenspeichern* has no business on this
      // route whatever the form's setting says.
      canSaveDraft: false,
      // Finding 32 — this correction runs without a time limit.
      timeLimitMin: null,
      // No form-specific privacy notice (ADR-0028 no. 4).
      privacyNotice: null,
      startToken: 's1.mfa1b2c3.RGllc0lzdEVpbmVTaWduYXR1cg',
      definition: {
        pages: [
          {
            id: PAGE_ID,
            title: 'Person',
            questions: [
              {
                id: NAME_ID,
                label: 'Name',
                hint: null,
                required: true,
                width: 'full',
                type: 'text',
                minLength: null,
                maxLength: null,
                pattern: null,
              },
              {
                id: MEAL_ID,
                label: 'Essen',
                hint: null,
                required: false,
                width: 'full',
                type: 'radio',
                options: [
                  { value: 'fleisch', label: 'Mit Fleisch' },
                  { value: 'vegetarisch', label: 'Vegetarisch' },
                ],
                allowOther: false,
                otherLabel: null,
              },
            ],
          },
        ],
      },
    },
    // Exactly the shape the server stores (`toStoredAnswers`): a choice answer
    // carries `values` **and** `other`, and `other: null` is what „nothing
    // typed into the free-text slot" means. A fixture that left it out would be
    // testing a payload this application never produces.
    answers: {
      [NAME_ID]: 'Anton',
      [MEAL_ID]: { values: ['vegetarisch'], other: null },
    },
    submittedAt: SUBMITTED_AT,
    editedAt: null,
    ...overrides,
  };
}

const EVENT_ID = '019fe700-0000-7000-8000-000000000003';

/**
 * An already submitted answer with a registration for a Veranstaltung.
 *
 * `full` says whether the hall has meanwhile filled up: „2 frei" before, no
 * figure at all after — which is what the server sends for a full one
 * (`publicEventSeats`).
 */
function eventPayload(full: boolean) {
  const base = payload();
  return {
    ...base,
    form: {
      ...base.form,
      eventSeats: [
        full
          ? { questionId: EVENT_ID, eventKey: 'stadtfest', full: true }
          : {
              questionId: EVENT_ID,
              eventKey: 'stadtfest',
              full: false,
              remaining: 2,
            },
      ],
      definition: {
        pages: [
          {
            id: PAGE_ID,
            title: 'Veranstaltungen',
            questions: [
              {
                id: EVENT_ID,
                label: 'Veranstaltungen',
                hint: null,
                required: false,
                width: 'full',
                type: 'event',
                events: [
                  {
                    key: 'stadtfest',
                    label: 'Stadtfest',
                    when: 'Sa, 20:00',
                    capacity: 80,
                    showRemaining: true,
                  },
                ],
              },
            ],
          },
        ],
      },
    },
    // Three seats, just as they were stored (`EventAnswer`).
    answers: { [EVENT_ID]: { seats: { stadtfest: 3 } } },
  };
}

const TABLE_ID = '019fe700-0000-7000-8000-000000000004';

/**
 * A submitted answer with an **extendable** table.
 *
 * `rows: 1` plus `addRows` is the shape the shared schema recommends for
 * „beliebig viele Begleitpersonen"; the stored answer already carries three
 * rows, so two of them were added when the form was first filled in.
 */
function tablePayload() {
  const base = payload();
  return {
    ...base,
    form: {
      ...base.form,
      definition: {
        pages: [
          {
            id: PAGE_ID,
            title: 'Begleitung',
            questions: [
              {
                id: TABLE_ID,
                label: 'Begleitpersonen',
                hint: null,
                required: false,
                width: 'full',
                type: 'table',
                columns: [{ key: 'name', label: 'Name', type: 'text' }],
                rows: 1,
                addRows: { maxRows: 5 },
              },
            ],
          },
        ],
      },
    },
    answers: {
      [TABLE_ID]: {
        cells: [{ name: 'Anna' }, { name: 'Bert' }, { name: 'Carla' }],
      },
    },
  };
}

const CONFIRMATION = {
  confirmationTitle: 'Änderung gespeichert',
  confirmationMessage: 'Die Antwort wurde ersetzt.',
  redirect: null,
  editUrl: `https://formulare.example.org/a/${TOKEN}`,
};

/** Answers the `GET` with the payload and every `PUT` with `onSave`. */
function stubEdit(body: unknown, onSave?: () => Response) {
  return stubFetch().mockImplementation((_input, init) => {
    if ((init?.method ?? 'GET') === 'GET') {
      return Promise.resolve(jsonResponse(200, body));
    }
    return Promise.resolve(onSave?.() ?? jsonResponse(200, CONFIRMATION));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ResponseEditView ', () => {
  it('opens the answer with the stored values already in the fields', async () => {
    stubEdit(payload());
    renderWithQuery(<ResponseEditView token={TOKEN} />);

    const name = await screen.findByLabelText(/Name/);
    expect((name as HTMLInputElement).value).toBe('Anton');
    expect(screen.getByLabelText<HTMLInputElement>('Vegetarisch').checked).toBe(
      true,
    );
    expect(screen.getByLabelText<HTMLInputElement>('Mit Fleisch').checked).toBe(
      false,
    );
  });

  /**
   * The note is what tells a participant that this screen can **replace**
   * something. Without it the page is indistinguishable from a fresh
   * registration form with somebody else's data in it.
   */
  it('says that this is an existing answer and shows when it arrived', async () => {
    stubEdit(payload());
    renderWithQuery(<ResponseEditView token={TOKEN} />);

    const note = await screen.findByTestId('response-edit-note');
    expect(note.textContent).toContain('bereits abgesendete Antwort');
    // The instant, with its zone named (the requirement's rule, applied here).
    expect(note.textContent).toContain('01.06.2026');
    expect(note.textContent).toMatch(/MESZ|MEZ/);
    expect(note.textContent).not.toContain('zuletzt geändert');
  });

  /**
   * The requirement's last sentence, seen from the participant: the two instants
   * are shown **beside** each other because they are stored beside each other.
   * A page that only showed one would hide which of the two moved.
   */
  it('shows the change time next to the submission time once there is one', async () => {
    stubEdit(payload({ editedAt: '2026-06-02T12:30:00.000Z' }));
    renderWithQuery(<ResponseEditView token={TOKEN} />);

    const note = await screen.findByTestId('response-edit-note');
    expect(note.textContent).toContain('01.06.2026');
    expect(note.textContent).toContain('zuletzt geändert am');
    expect(note.textContent).toContain('02.06.2026');
  });

  /**
   * **A `PUT` to the answer, never a `POST` to the form.** That is not REST
   * manners: the requirement's promise is „keine zweite Zeile", and a `POST` to
   * the collection is the shape that produces one.
   */
  it('saves with PUT to the edit address and sends the start token back', async () => {
    const fetchMock = stubEdit(payload());
    renderWithQuery(<ResponseEditView token={TOKEN} />);

    const name = await screen.findByLabelText(/Name/);
    fireEvent.change(name, { target: { value: 'Anton der Ältere' } });
    fireEvent.click(
      screen.getByRole('button', { name: 'Änderungen speichern' }),
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/public/responses/${encodeURIComponent(TOKEN)}`,
        expect.objectContaining({ method: 'PUT' }),
      );
    });

    const sent = fetchMock.mock.calls.find(
      ([, init]) => init?.method === 'PUT',
    );
    const raw = sent?.[1]?.body;
    // Narrowed rather than stringified: `RequestInit['body']` admits a stream
    // and a `FormData`, and `String()` on either yields „[object Object]" —
    // a JSON parse of that fails in a way that blames the test, not the code.
    expect(typeof raw).toBe('string');
    const body = JSON.parse(raw as string) as {
      answers: Record<string, unknown>;
      startToken: string;
    };
    expect(body.answers[NAME_ID]).toBe('Anton der Ältere');
    expect(body.startToken).toBe('s1.mfa1b2c3.RGllc0lzdEVpbmVTaWduYXR1cg');
  });

  it('shows the confirmation the server sent after a save', async () => {
    stubEdit(payload());
    renderWithQuery(<ResponseEditView token={TOKEN} />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Änderungen speichern' }),
    );

    expect(await screen.findByText('Änderung gespeichert')).toBeDefined();
    expect(screen.getByText('Die Antwort wurde ersetzt.')).toBeDefined();
    // …and the address again, so a second correction is still possible.
    expect(screen.getByTestId('public-edit-link')).toBeDefined();
  });

  /**
   * **The refusal sentence is the server's.**
   *
   * `editing_disabled`, `closed` and `not_yet_open` are three different pieces
   * of advice and the server has already written each of them exactly once
   * (`SUBMISSION_REFUSAL_MESSAGES`). A second set here would be a second answer
   * to the same question — the duplication this project has paid for before.
   */
  it.each([
    [
      'editing_disabled',
      'Diese Antwort lässt sich nicht mehr ändern. Für dieses Formular ist das Bearbeiten nach dem Absenden ausgeschaltet.',
    ],
    ['closed', 'Die Frist für dieses Formular ist abgelaufen.'],
    ['not_yet_open', 'Dieses Formular ist noch nicht geöffnet.'],
  ])('shows the server’s own sentence for %s', async (reason, message) => {
    stubFetch().mockResolvedValue(jsonResponse(409, { reason, message }));
    renderWithQuery(<ResponseEditView token={TOKEN} />);

    expect(await screen.findByText(message)).toBeDefined();
    // …and no form is offered underneath it.
    expect(screen.queryByLabelText(/Name/)).toBeNull();
  });

  /**
   * **A failed *background* refetch must not eat what is being typed.**
   *
   * The page is opened, the participant corrects a field, and then a refetch
   * fails — a reconnect, a remount, a restarting API. The view used to render
   * `NotEditable` for the whole page on `query.isError`, and because `FillIn`
   * seeds its state from `initialAnswers` exactly once, the unsaved edit was
   * gone with no way back: the participant would have retyped it, or not
   * noticed and saved the old value.
   *
   * The refetch is triggered through the query client rather than through a
   * window event, deliberately: `refetchOnWindowFocus` is off for this client,
   * so a focus-driven test would prove nothing about the state it claims to be
   * about — and would keep passing if the reachable triggers came back.
   */
  it('keeps the typed answer when a background refetch fails', async () => {
    const fetchMock = stubEdit(payload());
    const queryClient = createQueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <ResponseEditView token={TOKEN} />
      </QueryClientProvider>,
    );

    const name = await screen.findByLabelText(/Name/);
    fireEvent.change(name, { target: { value: 'Anton der Ältere' } });

    // Everything from here on is a lost connection.
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await queryClient.refetchQueries({ queryKey: ['response-edit', TOKEN] });

    await waitFor(() => {
      expect(
        queryClient.getQueryState(['response-edit', TOKEN])?.error,
      ).toBeTruthy();
    });
    // The page is still the form, not the refusal…
    expect(screen.queryByTestId('response-edit-unavailable')).toBeNull();
    // …and the unsaved edit survived.
    expect(screen.getByLabelText<HTMLInputElement>(/Name/).value).toBe(
      'Anton der Ältere',
    );
  });

  /**
   * **The badge after a refused correction** (a review finding).
   *
   * The same promise the fill-in view makes, through the **other** query: this
   * page reads the form — and with it the seat states — from
   * `GET /public/responses/:token`, so invalidating the public form's key would
   * refresh a cache entry this page does not have and leave the badge in front
   * of the participant untouched.
   *
   * *Reproduction:* point `useUpdateResponse`'s `onError` at
   * `publicFormQueryKey` → no second `GET`, and „2 frei" stays on screen beside
   * a message about the very same Veranstaltung.
   */
  it('re-reads the seat states after a refusal on a full Veranstaltung', async () => {
    let full = false;
    const fetchMock = stubFetch().mockImplementation((_input, init) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return Promise.resolve(jsonResponse(200, eventPayload(full)));
      }
      full = true;
      return Promise.resolve(
        jsonResponse(409, {
          message: 'Nicht genügend Plätze frei.',
          reason: 'event_full',
          position: { questionId: EVENT_ID, eventKey: 'stadtfest' },
        }),
      );
    });

    renderWithQuery(<ResponseEditView token={TOKEN} />);
    expect(await screen.findByText('2 frei')).toBeDefined();
    // The stored registration is in the box — this is a correction.
    const box = screen.getByLabelText<HTMLInputElement>(
      'Stadtfest: Anzahl Personen',
    );
    expect(box.value).toBe('3');

    fireEvent.change(box, { target: { value: '5' } });
    fireEvent.click(
      screen.getByRole('button', { name: 'Änderungen speichern' }),
    );

    await waitFor(() => {
      expect(screen.getByText('Ausgebucht')).toBeDefined();
    });
    expect(screen.queryByText('2 frei')).toBeNull();
    // Two reads **of the form**, one write: the refusal triggered
    // the second one. The filter is on the address and not on
    // "all GETs": since ADR-0028 the footer additionally fetches the name of the
    // operation (`/api/public/legal`), and a counter over all GET requests
    // measured the footer along with it from then on.
    expect(
      fetchMock.mock.calls.filter(
        ([input, init]) =>
          (init?.method ?? 'GET') === 'GET' &&
          // `RequestInfo` is a union; this application always passes
          // a string (`http.ts`), and that stands here as a
          // condition instead of an assumption.
          typeof input === 'string' &&
          input.includes('/public/responses/'),
      ),
    ).toHaveLength(2);
    // The box stays usable and keeps the number: „ausgebucht" over somebody's
    // own registration must not lock away the reduction.
    expect(box.disabled).toBe(false);
    expect(box.value).toBe('5');
  });

  /**
   * A 404 stays vague on purpose. Unknown token, deleted answer and withdrawn
   * form are one answer on the server — byte-identical — and a browser that
   * told them apart would undo that.
   */
  it('stays vague about a token that leads nowhere', async () => {
    stubFetch().mockResolvedValue(
      jsonResponse(404, { message: 'Dieses Formular gibt es nicht.' }),
    );
    renderWithQuery(<ResponseEditView token={TOKEN} />);

    const notice = await screen.findByTestId('response-edit-unavailable');
    expect(notice.textContent).toContain('führt zu keiner Antwort');
    expect(notice.textContent).not.toContain('gelöscht wurde die Antwort am');
  });

  /**
   * **The edit path can do both.**
   *
   * The correction path is the fill-in view with the answers already in it, so
   * „+ Zeile" and „Entfernen" arrive here for free — which is precisely why
   * they are worth measuring here rather than assumed: what the requirement asks
   * about is not the button but **the document that goes back**. A removal that
   * only took the row off the screen, or that emptied it instead of taking it
   * out, would put a `{}` where the participant deleted a line, and the
   * evaluation would show a companion who was withdrawn.
   *
   * Measured on the body of the `PUT`, because that is what becomes the
   * `response` row.
   */
  it('adds and removes table rows on the correction path, leaving no remnant', async () => {
    const fetchMock = stubEdit(tablePayload());
    renderWithQuery(<ResponseEditView token={TOKEN} />);

    // The stored answer is what is in the grid — three rows on a form that
    // only starts with one, so all three came from „+ Zeile" the first time.
    expect(
      (await screen.findByLabelText<HTMLInputElement>('Name, Zeile 2')).value,
    ).toBe('Bert');

    fireEvent.click(screen.getByRole('button', { name: '+ Zeile' }));
    fireEvent.change(screen.getByLabelText('Name, Zeile 4'), {
      target: { value: 'Dora' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Entfernen: Zeile 2' }));

    fireEvent.click(
      screen.getByRole('button', { name: 'Änderungen speichern' }),
    );

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT'),
      ).toBe(true);
    });

    const sent = fetchMock.mock.calls.find(
      ([, init]) => init?.method === 'PUT',
    );
    const raw = sent?.[1]?.body;
    expect(typeof raw).toBe('string');
    const body = JSON.parse(raw as string) as {
      answers: Record<string, unknown>;
    };

    // Three rows, and **no** empty one where Bert was: `cells` is positional,
    // so a blanked row would be visible here as `{}` in the middle.
    expect(body.answers[TABLE_ID]).toStrictEqual({
      cells: [{ name: 'Anna' }, { name: 'Carla' }, { name: 'Dora' }],
    });
  });
});
