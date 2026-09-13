import {
  RESTORE_REFUSAL_MESSAGES,
  restoreRefusalSchema,
} from '@formsache/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { emptyResponse, jsonResponse, stubFetch } from '../test/fetch-mock';
import { renderWithQuery } from '../test/render-with-query';
import { TrashView } from './TrashView';

/**
 * Trash (handoff §Screens/Views 10).
 *
 * What only a browser can decide — reachability over the navigation, mobile
 * overflow, and the accessible name of every new control once icons are
 * involved — lives in `e2e/trash*.spec.ts` instead (`CONTRIBUTING.md`, Lehre 2
 * and 3). This file pins down what a rendered tree can already answer: the two
 * counters, a refused restore leaving the row exactly where it
 * was while the list is read again so the counters cannot end up lying, where
 * focus goes when the last row leaves, and that two restores in flight at once
 * stay two.
 */

const FORM_ID = '00000000-0000-4000-8000-0000000000f0';
const OTHER_FORM_ID = '00000000-0000-4000-8000-0000000000f1';
const SECOND_FORM_ID = '00000000-0000-4000-8000-0000000000f2';
const RESPONSE_ID = '00000000-0000-4000-8000-0000000000a0';

function deletedForm(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: FORM_ID,
    title: 'Bestandsmeldung 2026',
    responseCount: 3,
    deletedAt: '2026-07-20T10:00:00.000Z',
    ...overrides,
  };
}

function deletedResponse(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: RESPONSE_ID,
    formId: OTHER_FORM_ID,
    formTitle: 'Jahrestagung-Anmeldung',
    submittedAt: '2026-07-01T08:00:00.000Z',
    deletedAt: '2026-07-21T09:00:00.000Z',
    ...overrides,
  };
}

function trashDocument(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    forms: [deletedForm()],
    responses: [deletedResponse()],
    ...overrides,
  };
}

/**
 * The body of a refused restore — **parsed through the wire contract before it
 * is served**.
 *
 * Not decoration. The first version of this fixture sent
 * `position: { pageIndex, questionId }`, a shape `restoreRefusalSchema` rejects
 * and `TrashService.restoreResponse` cannot produce (`refusal()` sends
 * `{ questionId, eventKey }`), while a comment three lines above claimed it was
 * „the exact shape the server sends". Nothing noticed, because the client only
 * ever reads `message`. `parse` here turns the next such drift into a red test
 * instead of a sentence in a comment.
 */
function refusalBody(): Record<string, unknown> {
  const body = {
    message: RESTORE_REFUSAL_MESSAGES.event_full,
    reason: 'event_full',
    position: { questionId: 'q-anreise', eventKey: 'freitag-abend' },
  };
  restoreRefusalSchema.parse(body);
  return body;
}

function pathOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

interface RouteFetchOptions {
  readonly trash?: Record<string, unknown>;
  /** Answers a `POST .../restore` on the form — defaults to 204. */
  readonly onRestoreForm?: () => Response;
  /** Answers a `POST .../responses/:id/restore` — defaults to 204. */
  readonly onRestoreResponse?: () => Response;
  /** Answers a `DELETE .../permanent` on the form — defaults to 204. */
  readonly onPurgeForm?: () => Response;
  /** Answers a `DELETE .../responses/:id/permanent` — defaults to 204. */
  readonly onPurgeResponse?: () => Response;
  /** Answers `DELETE /trash` — defaults to an empty, all-zero result. */
  readonly onEmptyTrash?: () => Response;
  /**
   * What `GET /trash` answers **after** a successful `DELETE /trash` —
   * defaults to fully empty. A case with `remaining > 0` overrides this to
   * the same document as before: this fixture does not model a real batch
   * partially clearing the trash, only that the list the next `GET`
   * answers is whatever the server says is left.
   */
  readonly trashAfterEmpty?: Record<string, unknown>;
}

/**
 * Dispatches by method and path. `currentTrash` is mutable and read by every
 * `GET /trash` — the success handlers below mutate it *before* answering, so
 * a refetch triggered by the mutation's own `invalidateQueries` (both
 * `onSuccess` and `onSettled`, `api/trash.ts`) sees the state the server
 * would actually be in by then.
 *
 * **`DELETE /trash` is matched before `GET /trash`, both by method and by an
 * exact suffix** — `url.endsWith('/trash')` alone would also have matched
 * every `.../permanent` and `.../restore` address below it if checked first,
 * and did not check method either, so a `DELETE` used to fall through to the
 * `GET` branch and read the list back instead of emptying it.
 */
function routeFetch(options: RouteFetchOptions = {}) {
  let currentTrash = options.trash ?? trashDocument();

  const fetchMock = stubFetch().mockImplementation((input, init) => {
    const url = pathOf(input);
    const method = init?.method ?? 'GET';

    if (method === 'POST' && url.endsWith(`/forms/${FORM_ID}/restore`)) {
      const response = options.onRestoreForm?.() ?? emptyResponse(204);
      if (response.ok) {
        currentTrash = {
          ...currentTrash,
          forms: (currentTrash.forms as Record<string, unknown>[]).filter(
            (form) => form.id !== FORM_ID,
          ),
        };
      }
      return Promise.resolve(response);
    }

    if (
      method === 'POST' &&
      url.endsWith(`/forms/${OTHER_FORM_ID}/responses/${RESPONSE_ID}/restore`)
    ) {
      const response = options.onRestoreResponse?.() ?? emptyResponse(204);
      if (response.ok) {
        currentTrash = {
          ...currentTrash,
          responses: (
            currentTrash.responses as Record<string, unknown>[]
          ).filter((response_) => response_.id !== RESPONSE_ID),
        };
      }
      return Promise.resolve(response);
    }

    if (method === 'DELETE' && url.endsWith(`/forms/${FORM_ID}/permanent`)) {
      const response = options.onPurgeForm?.() ?? emptyResponse(204);
      if (response.ok) {
        currentTrash = {
          ...currentTrash,
          forms: (currentTrash.forms as Record<string, unknown>[]).filter(
            (form) => form.id !== FORM_ID,
          ),
        };
      }
      return Promise.resolve(response);
    }

    if (
      method === 'DELETE' &&
      url.endsWith(`/forms/${OTHER_FORM_ID}/responses/${RESPONSE_ID}/permanent`)
    ) {
      const response = options.onPurgeResponse?.() ?? emptyResponse(204);
      if (response.ok) {
        currentTrash = {
          ...currentTrash,
          responses: (
            currentTrash.responses as Record<string, unknown>[]
          ).filter((response_) => response_.id !== RESPONSE_ID),
        };
      }
      return Promise.resolve(response);
    }

    if (method === 'DELETE' && url.endsWith('/trash')) {
      const response =
        options.onEmptyTrash?.() ??
        jsonResponse(200, { forms: 0, responses: 0, failed: 0, remaining: 0 });
      if (response.ok) {
        currentTrash =
          options.trashAfterEmpty ??
          trashDocument({ forms: [], responses: [] });
      }
      return Promise.resolve(response);
    }

    if (method === 'GET' && url.endsWith('/trash')) {
      return Promise.resolve(jsonResponse(200, currentTrash));
    }

    return Promise.resolve(emptyResponse(404));
  });

  return {
    fetchMock,
    trashCallCount: () =>
      fetchMock.mock.calls.filter(
        ([callInput, callInit]) =>
          pathOf(callInput).endsWith('/trash') &&
          (callInit?.method ?? 'GET') === 'GET',
      ).length,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** The row an element sits in, by its `data-testid` — or a clear failure. */
function rowOf(element: Element, testId: string): HTMLElement {
  const row = element.closest(`[data-testid="${testId}"]`);
  if (row === null) {
    throw new Error(`No ancestor with data-testid="${testId}" was found.`);
  }
  return row as HTMLElement;
}

/**
 * Opens a row's „Endgültig löschen" confirmation and presses the confirming
 * button — **not** the trigger a second time, which shares the exact same
 * accessible name (`ConfirmPrompt`'s `confirmLabel` matches the button that
 * opened it) once both are on screen together. The confirming one is the
 * *last* of the two in document order: `trash-row__confirm` renders after
 * `trash-row__actions`.
 */
function confirmPurge(row: HTMLElement): void {
  // **The trigger is fetched through its test id, the confirmation through
  // its name** — and that has only been possible at all since 2026-08-11.
  // Before that both were called „Endgültig löschen", so this function took the
  // **last** hit, and exactly that makeshift was the symptom: what a
  // test tells apart only by its position, a screen-reader
  // operation does not tell apart at all (a review finding,
  // WCAG 2.5.3).
  fireEvent.click(within(row).getByTestId(/^trash-purge-/u));
  // No `exact` — Testing Library does not know the option (that is
  // Playwright's API); a string matches the **whole** accessible name here
  // anyway, so only the confirmation and not the trigger
  // beside it.
  const confirmButton = within(row).getByRole('button', {
    name: 'Endgültig löschen',
  });
  fireEvent.click(confirmButton);
}

describe('TrashView', () => {
  it('shows a loading state, then both sections with their counters', async () => {
    routeFetch();
    renderWithQuery(<TrashView canPurge={false} />);

    expect(screen.getByRole('status').textContent).toContain(
      'Papierkorb wird geladen',
    );

    await waitFor(() => {
      expect(screen.getByText('Bestandsmeldung 2026')).toBeDefined();
    });
    expect(screen.getByTestId('trash-forms-count').textContent).toBe('1');
    expect(screen.getByTestId('trash-responses-count').textContent).toBe('1');
    expect(screen.getByText('Jahrestagung-Anmeldung')).toBeDefined();
  });

  /**
   * Two guards answer 403 here and only one of them is about a role
   * (`TenantScopeGuard` vs. `GroupPermissionGuard`, see `loadErrorMessage`).
   * Answering both with the role sentence told somebody whose membership had
   * just been withdrawn to obtain a permission they already held.
   */
  it('shows the server’s own sentence for a 403, whichever guard sent it', async () => {
    stubFetch().mockResolvedValue(
      jsonResponse(403, {
        message: 'Für diese Anfrage ist keine Organisation ausgewählt.',
      }),
    );
    renderWithQuery(<TrashView canPurge={false} />);

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(
        'keine Organisation ausgewählt',
      );
    });
    // Not the role sentence — that is a different refusal asking for a
    // different reaction.
    expect(screen.getByRole('alert').textContent).not.toContain('Bearbeiten');
  });

  it('falls back to the role sentence when a 403 carried no readable body', async () => {
    stubFetch().mockResolvedValue(emptyResponse(403));
    renderWithQuery(<TrashView canPurge={false} />);

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(
        'Rolle „Bearbeiten" vorbehalten',
      );
    });
  });

  it('tells a failed load apart from a refused one', async () => {
    stubFetch().mockResolvedValue(emptyResponse(500));
    renderWithQuery(<TrashView canPurge={false} />);

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(
        'konnte nicht geladen werden',
      );
    });
  });

  it('shows the empty illustration when both sections are empty', async () => {
    routeFetch({ trash: trashDocument({ forms: [], responses: [] }) });
    renderWithQuery(<TrashView canPurge={false} />);

    await waitFor(() => {
      expect(screen.getByText('Papierkorb ist leer')).toBeDefined();
    });
  });

  /**
   * `canPurge` decides whether „Endgültig löschen" and „Papierkorb leeren"
   * render at all (Konzept no. 65 — comfort, not the boundary; the server asks
   * `canBuild` **and** `canViewResponses` again on every one of the three
   * routes regardless). Hidden, not disabled — the same convention
   * `AppHeader.tsx` and `MobileMenuSheet.tsx` use for a route nobody may
   * open. The requirement's automatic purge is still not built, so the retention
   * line stays the plain DSGVO rule rather than a promise about machinery.
   */
  it('offers neither „Endgültig löschen" nor „Papierkorb leeren" without canPurge', async () => {
    routeFetch();
    renderWithQuery(<TrashView canPurge={false} />);

    await waitFor(() => {
      expect(screen.getByText('Bestandsmeldung 2026')).toBeDefined();
    });

    expect(
      screen.queryByRole('button', { name: /Papierkorb leeren/ }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: /Endgültig löschen/ }),
    ).toBeNull();
    expect(screen.queryByText(/automatisch entfernt/)).toBeNull();
    expect(screen.getByText(/Aufbewahrungsfrist 30 Tage/)).toBeDefined();
  });

  it('restores a form — the row disappears once the list is read again', async () => {
    routeFetch();
    renderWithQuery(<TrashView canPurge={false} />);

    const title = await screen.findByText('Bestandsmeldung 2026');
    const row = rowOf(title, 'trash-deleted-form');
    fireEvent.click(
      within(row).getByRole('button', { name: 'Wiederherstellen' }),
    );

    await waitFor(() => {
      expect(screen.queryByText('Bestandsmeldung 2026')).toBeNull();
    });
    expect(screen.getByTestId('trash-forms-count').textContent).toBe('0');
  });

  /**
   * **The case the section heading could not carry.** One form, no answers:
   * restoring it empties the trash, and React unmounts the section
   * together with the heading a focus target used to live on — leaving
   * `document.activeElement` on `<body>`, which is the bug this asserts is
   * gone. The browser half of the same claim is in `e2e/trash.spec.ts`
   * (`toBeFocused`), because jsdom cannot speak for real focus behaviour.
   */
  it('moves focus to the view heading when the last row leaves the Papierkorb', async () => {
    routeFetch({
      trash: trashDocument({ forms: [deletedForm()], responses: [] }),
    });
    renderWithQuery(<TrashView canPurge={false} />);

    const title = await screen.findByText('Bestandsmeldung 2026');
    const row = rowOf(title, 'trash-deleted-form');
    fireEvent.click(
      within(row).getByRole('button', { name: 'Wiederherstellen' }),
    );

    await waitFor(() => {
      expect(screen.getByText('Papierkorb ist leer')).toBeDefined();
    });
    // The section — heading included — is gone with its last row.
    expect(screen.queryByText('Gelöschte Formulare')).toBeNull();

    const heading = screen.getByRole('heading', {
      name: 'Papierkorb',
      level: 1,
    });
    expect(document.activeElement).toBe(heading);
    expect(document.activeElement).not.toBe(document.body);
    // …and the emptying is announced, not only shown.
    expect(screen.getByRole('status').textContent).toContain(
      'Papierkorb ist leer',
    );
  });

  /**
   * One `useMutation` serves every row, and its `variables` hold the latest
   * call only: reading `isPending && variables === form.id` made the first row
   * look idle again the moment the second was clicked, and a second click on it
   * sent a second `POST` whose 404 landed in a row that no longer existed.
   */
  it('keeps both rows in their in-flight state while two restores are open', async () => {
    const release: (() => void)[] = [];
    const trash = trashDocument({
      forms: [
        deletedForm(),
        deletedForm({ id: SECOND_FORM_ID, title: 'Sterbefallmeldung' }),
      ],
      responses: [],
    });

    stubFetch().mockImplementation((input, init) => {
      const url = pathOf(input);
      if ((init?.method ?? 'GET') === 'POST' && url.endsWith('/restore')) {
        return new Promise<Response>((resolve) => {
          release.push(() => {
            resolve(emptyResponse(204));
          });
        });
      }
      if (url.endsWith('/trash')) {
        return Promise.resolve(jsonResponse(200, trash));
      }
      return Promise.resolve(emptyResponse(404));
    });

    renderWithQuery(<TrashView canPurge={false} />);
    const firstRow = rowOf(
      await screen.findByText('Bestandsmeldung 2026'),
      'trash-deleted-form',
    );
    const secondRow = rowOf(
      screen.getByText('Sterbefallmeldung'),
      'trash-deleted-form',
    );

    fireEvent.click(
      within(firstRow).getByRole('button', { name: 'Wiederherstellen' }),
    );
    await waitFor(() => {
      expect(
        within(firstRow).getByRole('button', {
          name: /Wird wiederhergestellt/,
        }),
      ).toBeDefined();
    });

    fireEvent.click(
      within(secondRow).getByRole('button', { name: 'Wiederherstellen' }),
    );
    await waitFor(() => {
      expect(
        within(secondRow).getByRole('button', {
          name: /Wird wiederhergestellt/,
        }),
      ).toBeDefined();
    });

    // The first request is still open, so its button must not have become
    // clickable again behind the second one.
    expect(
      within(firstRow).queryByRole('button', { name: 'Wiederherstellen' }),
    ).toBeNull();
    const firstButton = within(firstRow).getByRole('button', {
      name: /Wird wiederhergestellt/,
    });
    expect((firstButton as HTMLButtonElement).disabled).toBe(true);
    expect(release).toHaveLength(2);

    for (const settle of release) {
      settle();
    }
    await waitFor(() => {
      expect(release).toHaveLength(2);
    });
  });

  /**
   * **The trap named in the work order.** A restore can be refused with 409
   * (the requirement: the Antwortlimit or a Veranstaltung filled up again while
   * the answer was away) — the row has to stay, the server's own sentence has
   * to appear, and the list has to be read again regardless, because the
   * refusal was decided against a moment that has already passed by the time
   * it reaches this screen.
   */
  it('a refused restore leaves the answer in the Papierkorb, shows why, and rereads the list', async () => {
    const { trashCallCount } = routeFetch({
      onRestoreResponse: () => jsonResponse(409, refusalBody()),
    });
    renderWithQuery(<TrashView canPurge={false} />);

    const title = await screen.findByText('Jahrestagung-Anmeldung');
    const row = rowOf(title, 'trash-deleted-response');
    const callsBefore = trashCallCount();

    fireEvent.click(
      within(row).getByRole('button', { name: 'Wiederherstellen' }),
    );

    await waitFor(() => {
      expect(within(row).getByRole('alert').textContent).toBe(
        RESTORE_REFUSAL_MESSAGES.event_full,
      );
    });

    // The row is still here — the wire contract says so, and so does the eye.
    expect(screen.getByText('Jahrestagung-Anmeldung')).toBeDefined();
    expect(screen.getByTestId('trash-responses-count').textContent).toBe('1');
    // …and the list was fetched again, not only on the first render — the
    // counters must not go on trusting a moment that already passed.
    await waitFor(() => {
      expect(trashCallCount()).toBeGreaterThan(callsBefore);
    });
  });

  it('shows its own sentence for a restore that 404s — already gone from the Papierkorb', async () => {
    routeFetch({
      onRestoreForm: () =>
        jsonResponse(404, { message: 'Formular nicht gefunden.' }),
    });
    renderWithQuery(<TrashView canPurge={false} />);

    const title = await screen.findByText('Bestandsmeldung 2026');
    const row = rowOf(title, 'trash-deleted-form');

    fireEvent.click(
      within(row).getByRole('button', { name: 'Wiederherstellen' }),
    );

    await waitFor(() => {
      expect(within(row).getByRole('alert').textContent).toContain(
        'jemand anderes',
      );
    });
  });

  /**
   * Konzept no. 65 — the two controls it gates on the stronger
   * pair. Every trap named for this area has a case here:
   * a confirmation before either fires, `remaining`/`failed` said out loud
   * rather than swallowed, and focus proven rather than claimed.
   */
  describe('mit canPurge', () => {
    it('asks before endgültig löschen — the row survives a cancel, the request is sent only after confirming', async () => {
      const { fetchMock } = routeFetch();
      renderWithQuery(<TrashView canPurge />);

      const title = await screen.findByText('Bestandsmeldung 2026');
      const row = rowOf(title, 'trash-deleted-form');
      const callsBefore = fetchMock.mock.calls.length;

      fireEvent.click(within(row).getByTestId(/^trash-purge-/u));
      // The question names what is lost and that it cannot be undone — the
      // trap named in the work order: this is not a smaller version of
      // „mit Bestätigung", it is the same promise.
      expect(within(row).getByRole('alert').textContent).toContain(
        'Bestandsmeldung 2026',
      );
      expect(within(row).getByRole('alert').textContent).toContain(
        'nicht rückgängig machen',
      );
      // Nothing was sent while only asking.
      expect(fetchMock.mock.calls.length).toBe(callsBefore);

      fireEvent.click(within(row).getByRole('button', { name: 'Abbrechen' }));
      expect(screen.getByText('Bestandsmeldung 2026')).toBeDefined();
      expect(fetchMock.mock.calls.length).toBe(callsBefore);
    });

    it('endgültig löscht a form after confirming, and moves focus to the heading', async () => {
      routeFetch({
        trash: trashDocument({ forms: [deletedForm()], responses: [] }),
      });
      renderWithQuery(<TrashView canPurge />);

      const title = await screen.findByText('Bestandsmeldung 2026');
      const row = rowOf(title, 'trash-deleted-form');
      confirmPurge(row);

      await waitFor(() => {
        expect(screen.getByText('Papierkorb ist leer')).toBeDefined();
      });
      // The trap named in the work order, measured — not asserted in prose.
      const heading = screen.getByRole('heading', {
        name: 'Papierkorb',
        level: 1,
      });
      expect(document.activeElement).toBe(heading);
      expect(document.activeElement).not.toBe(document.body);
    });

    it('endgültig löscht one answer, keeping the form row untouched', async () => {
      routeFetch();
      renderWithQuery(<TrashView canPurge />);

      const title = await screen.findByText('Jahrestagung-Anmeldung');
      const row = rowOf(title, 'trash-deleted-response');
      confirmPurge(row);

      await waitFor(() => {
        expect(screen.queryByText('Jahrestagung-Anmeldung')).toBeNull();
      });
      expect(screen.getByTestId('trash-responses-count').textContent).toBe('0');
      // The other section is untouched — this was one row's own action.
      expect(screen.getByText('Bestandsmeldung 2026')).toBeDefined();
    });

    /**
     * Konzept no. 65: the pair guards *this route*, not the whole page — `canBuild`
     * alone already opened it. An editor without `can_view_responses`
     * therefore never sees the button (asserted above), but a stale UI state
     * or a revoked permission mid-session can still reach the server, which
     * has to answer readably.
     */
    it('shows the server’s own 403 when endgültig löschen is refused', async () => {
      routeFetch({
        onPurgeForm: () =>
          jsonResponse(403, {
            message:
              'Endgültiges Löschen verlangt zusätzlich das Antwortrecht.',
          }),
      });
      renderWithQuery(<TrashView canPurge />);

      const title = await screen.findByText('Bestandsmeldung 2026');
      const row = rowOf(title, 'trash-deleted-form');
      confirmPurge(row);

      await waitFor(() => {
        expect(within(row).getByRole('alert').textContent).toContain(
          'Antwortrecht',
        );
      });
      // The row is still here — a refusal removed nothing.
      expect(screen.getByText('Bestandsmeldung 2026')).toBeDefined();
    });

    it('asks before „Papierkorb leeren" and sends the request only after confirming', async () => {
      const { fetchMock } = routeFetch();
      renderWithQuery(<TrashView canPurge />);

      await screen.findByText('Bestandsmeldung 2026');
      const callsBefore = fetchMock.mock.calls.length;

      fireEvent.click(
        screen.getByRole('button', { name: /Papierkorb leeren/ }),
      );
      expect(screen.getByRole('alert').textContent).toContain(
        'nicht mehr rückgängig machen',
      );
      expect(fetchMock.mock.calls.length).toBe(callsBefore);

      fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
      // `getByRole` throws if the button is not back — a stronger check than
      // `queryByRole(...).toBeDefined()`, which passes on `null` just as
      // readily as on an element.
      expect(
        screen.getByRole('button', { name: 'Papierkorb leeren' }),
      ).not.toBeNull();
      expect(fetchMock.mock.calls.length).toBe(callsBefore);
    });

    /**
     * Presses „Papierkorb leeren" and confirms it, with the given answer to
     * `DELETE /trash`. The list stays non-empty afterwards, which is what a
     * real `remaining > 0` looks like.
     */
    async function emptyWithResult(
      result: Record<string, number>,
    ): Promise<void> {
      routeFetch({
        onEmptyTrash: () => jsonResponse(200, result),
        trashAfterEmpty: trashDocument(),
      });
      renderWithQuery(<TrashView canPurge />);

      await screen.findByText('Bestandsmeldung 2026');
      fireEvent.click(
        screen.getByRole('button', { name: /Papierkorb leeren/ }),
      );
      fireEvent.click(
        screen.getByRole('button', { name: 'Papierkorb leeren' }),
      );
      await screen.findByTestId('trash-empty-result');
    }

    /**
     * `remaining > 0` is not a courtesy count (the finding that a purge run
     * empties only one batch at a time) — the trap named explicitly in the
     * work order as „der Fall, den man beim Bauen vergisst". The server
     * empties in batches, so what is left after a successful run is
     * genuinely reachable by pressing again.
     */
    it('offers a second run while more remains than failed', async () => {
      await emptyWithResult({
        forms: 1,
        responses: 0,
        failed: 0,
        remaining: 3,
      });

      expect(screen.getByTestId('trash-empty-remaining').textContent).toContain(
        '3',
      );
      expect(screen.getByTestId('trash-empty-remaining').textContent).toContain(
        'erneut drücken',
      );
      // The button that starts that run is still there. It hangs on the list
      // being non-empty, not on `remaining` — asserted here because the
      // sentence above points at it, not as evidence for the sentence.
      expect(
        screen.getByRole('button', { name: /Papierkorb leeren/ }),
      ).not.toBeNull();
    });

    /**
     * Review finding 4. `remaining` is **counted**, not inferred
     * (`TrashService.empty`), so it includes what just failed: with
     * `remaining ≤ failed` there is nothing left *but* the failures, and every
     * further press brings the same elements, the same errors and the same
     * number back. „bitte erneut drücken, um fortzufahren" sold that standstill
     * as progress.
     */
    it('says a second run changes nothing when everything left is what failed', async () => {
      await emptyWithResult({
        forms: 0,
        responses: 1,
        failed: 2,
        remaining: 2,
      });

      const remaining = screen.getByTestId('trash-empty-remaining').textContent;
      expect(remaining).toContain('ändert daran nichts');
      expect(remaining).not.toContain('erneut drücken');
    });

    /**
     * `failed` is the honest half (the finding that the refusal message must
     * not overclaim) — never folded away.
     */
    it('says so when items failed to purge during leeren', async () => {
      // `remaining` deliberately larger than `failed`: this case is about the
      // failure count being said out loud, and it must not double as the case
      // above by accident — both sentences are on screen here.
      await emptyWithResult({
        forms: 0,
        responses: 1,
        failed: 2,
        remaining: 5,
      });

      expect(screen.getByTestId('trash-empty-failed').textContent).toContain(
        '2',
      );
      expect(screen.getByTestId('trash-empty-remaining').textContent).toContain(
        'erneut drücken',
      );
    });

    /**
     * Review finding 5. `DELETE /trash` asks the same pair Konzept no. 65 gates
     * the row purge on, and the whole-trash call is the more dangerous of
     * the two — its 403 had no test at all while the row's did.
     *
     * **And the question closes.** Both it and the error are `role="alert"`;
     * leaving them on screen together announces twice and re-offers the button
     * that was just refused. The three sibling writes in this view close it,
     * each with that reasoning next to them.
     */
    it('shows the server’s own 403 when Papierkorb leeren is refused, and closes the question', async () => {
      routeFetch({
        onEmptyTrash: () =>
          jsonResponse(403, {
            message: 'Papierkorb leeren verlangt zusätzlich das Antwortrecht.',
          }),
      });
      renderWithQuery(<TrashView canPurge />);

      await screen.findByText('Bestandsmeldung 2026');
      fireEvent.click(
        screen.getByRole('button', { name: /Papierkorb leeren/ }),
      );
      fireEvent.click(
        screen.getByRole('button', { name: 'Papierkorb leeren' }),
      );

      await waitFor(() => {
        expect(screen.getByTestId('trash-empty-error').textContent).toContain(
          'Antwortrecht',
        );
      });
      // The question is gone — one live region, not two.
      expect(screen.queryByText(/nicht mehr rückgängig machen/)).toBeNull();
      // Nothing was emptied: both rows are still listed.
      expect(screen.getByText('Bestandsmeldung 2026')).toBeDefined();
      expect(screen.getByText('Jahrestagung-Anmeldung')).toBeDefined();
    });

    it('falls back to its own sentence when Papierkorb leeren fails with a 500', async () => {
      routeFetch({ onEmptyTrash: () => emptyResponse(500) });
      renderWithQuery(<TrashView canPurge />);

      await screen.findByText('Bestandsmeldung 2026');
      fireEvent.click(
        screen.getByRole('button', { name: /Papierkorb leeren/ }),
      );
      fireEvent.click(
        screen.getByRole('button', { name: 'Papierkorb leeren' }),
      );

      await waitFor(() => {
        expect(screen.getByTestId('trash-empty-error').textContent).toContain(
          'Das Leeren des Papierkorbs ist fehlgeschlagen',
        );
      });
      expect(screen.queryByText(/nicht mehr rückgängig machen/)).toBeNull();
      // …and the button is back, because a second attempt is the right
      // reaction to „fehlgeschlagen" — unlike the 403 above.
      expect(
        screen.getByRole('button', { name: /Papierkorb leeren/ }),
      ).not.toBeNull();
    });

    it('leert den Papierkorb vollständig and moves focus to the heading', async () => {
      routeFetch({
        trash: trashDocument({ forms: [deletedForm()], responses: [] }),
        onEmptyTrash: () =>
          jsonResponse(200, {
            forms: 1,
            responses: 0,
            failed: 0,
            remaining: 0,
          }),
      });
      renderWithQuery(<TrashView canPurge />);

      await screen.findByText('Bestandsmeldung 2026');
      fireEvent.click(
        screen.getByRole('button', { name: /Papierkorb leeren/ }),
      );
      fireEvent.click(
        screen.getByRole('button', { name: 'Papierkorb leeren' }),
      );

      await waitFor(() => {
        expect(screen.getByText('Papierkorb ist leer')).toBeDefined();
      });
      const heading = screen.getByRole('heading', {
        name: 'Papierkorb',
        level: 1,
      });
      expect(document.activeElement).toBe(heading);
      expect(document.activeElement).not.toBe(document.body);
    });
  });
});
