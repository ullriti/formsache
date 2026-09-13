import type { ReactElement } from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { jsonResponse, requestUrl, stubFetch } from '../test/fetch-mock';
import { renderWithQuery } from '../test/render-with-query';
import {
  builderPath,
  DASHBOARD_PATH,
  previewPath,
  responsesPath,
} from '../router/routes';
import { navigate, useRoute } from '../router/use-route';
import { useBuilderStore } from './builder-store';
import { createQuestion } from './question-defaults';
import { DraftGuardDialog } from './DraftGuardDialog';
import { useDraftGuard } from './use-draft-guard';

/**
 * **Review finding 21a: the leaving dialog.**
 *
 * Before this work there was no navigation block anywhere in the frontend — no
 * `beforeunload`, no query —, and the builder lost unsaved
 * changes to every tab somebody clicked. What is measured here is
 * the same thing from four sides: that the query comes, that it does *not*
 * come where nothing is lost, that „Verwerfen" really discards, and that the
 * browser's back button is the same door as a click in the navigation.
 */

const FORM_ID = '019fe800-0000-7000-8000-000000000001';
/** **Another** form — for the block over a foreign document. */
const OTHER_FORM_ID = '019fe800-0000-7000-8000-000000000002';
const PAGE_ID = '019fe800-0000-7000-8000-0000000000a1';
const QUESTION_ID = '019fe800-0000-7000-8000-0000000000b1';

function loadDraft(id: string = FORM_ID): void {
  useBuilderStore.getState().reset();
  useBuilderStore.getState().load({
    id,
    title: 'Bestandsmeldung',
    definition: {
      pages: [
        {
          id: PAGE_ID,
          title: 'Seite 1',
          description: null,
          questions: [createQuestion('text', QUESTION_ID)],
        },
      ],
    },
    revision: 3,
  });
}

/** Makes the draft unsaved — like every edit in the builder. */
function makeDirty(): void {
  act(() => {
    useBuilderStore.getState().setTitle('Bestandsmeldung 2027');
  });
}

/**
 * The view, as small as possible: the hook, its dialog, and a
 * `useRoute()` that subscribes to the address — without a subscriber the
 * router's `popstate` listener does not hang on the window at all, and the
 * test for the back button checked nothing.
 */
function Harness({
  canSave = true,
  formId = FORM_ID,
}: {
  readonly canSave?: boolean;
  /** The id the **view** was called with — not the one in the store. */
  readonly formId?: string;
}): ReactElement {
  const route = useRoute();
  const guard = useDraftGuard({ formId, canSave });

  return (
    <div>
      <p data-testid="route">{route.kind}</p>
      {guard.pending === null ? null : (
        <DraftGuardDialog
          busy={guard.busy}
          error={guard.error}
          canSave={guard.canSave}
          onSave={guard.onSave}
          onDiscard={guard.onDiscard}
          onCancel={guard.onCancel}
        />
      )}
    </div>
  );
}

function dialog(): HTMLElement | null {
  return screen.queryByRole('dialog', { name: 'Ungespeicherte Änderungen' });
}

beforeEach(() => {
  useBuilderStore.getState().reset();
  window.history.pushState(null, '', builderPath(FORM_ID));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Verlassen-Dialog', () => {
  it('fängt jede Navigation ab, die den Entwurf verlöre', () => {
    loadDraft();
    renderWithQuery(<Harness />);
    makeDirty();

    act(() => {
      navigate(DASHBOARD_PATH);
    });

    expect(dialog()).not.toBeNull();
    // The address has **not** moved: the question stands over the page
    // one was about to leave, not over the new one.
    expect(window.location.pathname).toBe(builderPath(FORM_ID));
    expect(screen.getByTestId('route').textContent).toBe('builder');
  });

  /**
   * **The block applies to the document that is open — not merely to the
   * circumstance that some document is dirty** (review rework on finding 21).
   *
   * The view is called with a form id, the store possibly still carries
   * another one: the loading of the new form is
   * running, and until then the draft of the previous one stands in memory. If
   * the block asked then too, its „Speichern" would offer to send
   * `currentDefinition(state)` — that is, the **foreign** document — to the
   * route of `formId` and thereby overwrite the wrong form.
   *
   * Both are measured in one go: no query, and the address really
   * moves.
   */
  it('sperrt nicht, wenn der Store ein fremdes Dokument hält', () => {
    loadDraft(OTHER_FORM_ID);
    renderWithQuery(<Harness formId={FORM_ID} />);
    makeDirty();

    act(() => {
      navigate(DASHBOARD_PATH);
    });

    expect(dialog()).toBeNull();
    expect(window.location.pathname).toBe(DASHBOARD_PATH);
    expect(screen.getByTestId('route').textContent).toBe('dashboard');
    // And the foreign draft has been left untouched — neither saved
    // nor discarded, since nothing was asked after all.
    expect(useBuilderStore.getState().formId).toBe(OTHER_FORM_ID);
    expect(useBuilderStore.getState().isDirty).toBe(true);
  });

  it('fragt nicht, solange nichts ungespeichert ist', () => {
    loadDraft();
    renderWithQuery(<Harness />);

    act(() => {
      navigate(DASHBOARD_PATH);
    });

    expect(dialog()).toBeNull();
    expect(window.location.pathname).toBe(DASHBOARD_PATH);
  });

  /**
   * The one exception, and it is the second part of the same finding: the
   * preview **keeps** the draft and shows it (`PreviewView`), so there is
   * nothing to lose and nothing to ask there. A query both of whose
   * answers do away with the unsaved state would make the
   * live preview unreachable — the very thing it would be asked for.
   */
  it('lässt den Weg zur Vorschau desselben Formulars ungefragt durch', () => {
    loadDraft();
    renderWithQuery(<Harness />);
    makeDirty();

    act(() => {
      navigate(previewPath(FORM_ID));
    });

    expect(dialog()).toBeNull();
    expect(window.location.pathname).toBe(previewPath(FORM_ID));
    // And the draft is still standing there — exactly the point.
    expect(useBuilderStore.getState().isDirty).toBe(true);
    expect(useBuilderStore.getState().title).toBe('Bestandsmeldung 2027');
  });

  it('fragt dagegen beim Weg zu den Antworten desselben Formulars', () => {
    loadDraft();
    renderWithQuery(<Harness />);
    makeDirty();

    act(() => {
      navigate(responsesPath(FORM_ID));
    });

    expect(dialog()).not.toBeNull();
    expect(window.location.pathname).toBe(builderPath(FORM_ID));
  });

  it('„Verwerfen" geht weiter und wirft den Entwurf weg', () => {
    loadDraft();
    renderWithQuery(<Harness />);
    makeDirty();

    act(() => {
      navigate(DASHBOARD_PATH);
    });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Verwerfen' }));
    });

    expect(dialog()).toBeNull();
    expect(window.location.pathname).toBe(DASHBOARD_PATH);
    // Discarded means discarded: a document left standing is what the
    // builder would find again the next time it opens.
    const state = useBuilderStore.getState();
    expect(state.formId).toBeNull();
    expect(state.pages).toStrictEqual([]);
    expect(state.isDirty).toBe(false);
  });

  it('„Abbrechen" bleibt, und Escape tut dasselbe', () => {
    loadDraft();
    renderWithQuery(<Harness />);
    makeDirty();

    act(() => {
      navigate(DASHBOARD_PATH);
    });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
    });

    expect(dialog()).toBeNull();
    expect(window.location.pathname).toBe(builderPath(FORM_ID));
    expect(useBuilderStore.getState().isDirty).toBe(true);

    act(() => {
      navigate(DASHBOARD_PATH);
    });
    act(() => {
      fireEvent.keyDown(
        screen.getByRole('dialog', { name: 'Ungespeicherte Änderungen' }),
        { key: 'Escape' },
      );
    });

    expect(dialog()).toBeNull();
    expect(window.location.pathname).toBe(builderPath(FORM_ID));
  });

  it('„Speichern" speichert und geht erst dann weiter', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url.endsWith(`/forms/${FORM_ID}`) && init?.method === 'PUT') {
        return Promise.resolve(
          jsonResponse(200, {
            id: FORM_ID,
            title: 'Bestandsmeldung 2027',
            status: 'draft',
            publishedVersion: null,
            responseCount: 0,
            permissions: {
              canBuild: true,
              canViewResponses: true,
              canExport: true,
              canManageSettings: true,
              canManageFormSettings: true,
              canManageUsers: true,
            },
            updatedAt: '2026-08-14T10:00:00.000Z',
            revision: 4,
            publicSlug: 'abc123',
            definition: useBuilderStore.getState().pages.length
              ? { pages: useBuilderStore.getState().pages }
              : { pages: [] },
            hasUnpublishedChanges: true,
          }),
        );
      }
      throw new Error(`unerwartete Anfrage: ${url}`);
    });

    loadDraft();
    renderWithQuery(<Harness />);
    makeDirty();

    act(() => {
      navigate(DASHBOARD_PATH);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

    await waitFor(() => {
      expect(window.location.pathname).toBe(DASHBOARD_PATH);
    });
    expect(dialog()).toBeNull();
    expect(useBuilderStore.getState().isDirty).toBe(false);
    expect(useBuilderStore.getState().revision).toBe(4);
    // And the draft really went out, with the revision it stood on.
    const body = fetchMock.mock.calls[0]?.[1]?.body;
    expect(JSON.parse(typeof body === 'string' ? body : '{}')).toMatchObject({
      title: 'Bestandsmeldung 2027',
      revision: 3,
    });
  });

  /**
   * **Escape during the saving** (review rework).
   *
   * The focus trap knows no „busy" and closes the dialog in the middle of the
   * request too. Until now the returning mutation still carried the target of
   * the cancelled query with it and navigated there — that is, precisely where
   * the editor no longer wanted to go. It is saved nonetheless:
   * the request was on its way and has arrived.
   */
  it('navigiert nicht mehr, wenn die Rückfrage währenddessen abgebrochen wird', async () => {
    let land = (): void => undefined;
    const landed = new Promise<Response>((resolve) => {
      land = () => {
        resolve(
          jsonResponse(200, {
            id: FORM_ID,
            title: 'Bestandsmeldung 2027',
            status: 'draft',
            publishedVersion: null,
            responseCount: 0,
            permissions: {
              canBuild: true,
              canViewResponses: true,
              canExport: true,
              canManageSettings: true,
              canManageFormSettings: true,
              canManageUsers: true,
            },
            updatedAt: '2026-08-14T10:00:00.000Z',
            revision: 4,
            publicSlug: 'abc123',
            definition: { pages: useBuilderStore.getState().pages },
            hasUnpublishedChanges: true,
          }),
        );
      };
    });
    stubFetch().mockReturnValue(landed);

    loadDraft();
    renderWithQuery(<Harness />);
    makeDirty();

    act(() => {
      navigate(DASHBOARD_PATH);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

    // Cancelled while the request is still running.
    act(() => {
      fireEvent.keyDown(
        screen.getByRole('dialog', { name: 'Ungespeicherte Änderungen' }),
        { key: 'Escape' },
      );
    });
    expect(dialog()).toBeNull();

    await act(async () => {
      land();
      await landed;
    });

    await waitFor(() => {
      expect(useBuilderStore.getState().isDirty).toBe(false);
    });
    expect(window.location.pathname).toBe(builderPath(FORM_ID));
  });

  it('bleibt stehen, wenn das Speichern scheitert', async () => {
    stubFetch().mockResolvedValue(jsonResponse(500, { message: 'kaputt' }));

    loadDraft();
    renderWithQuery(<Harness />);
    makeDirty();

    act(() => {
      navigate(DASHBOARD_PATH);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

    await screen.findByRole('alert');
    expect(dialog()).not.toBeNull();
    expect(window.location.pathname).toBe(builderPath(FORM_ID));
    expect(useBuilderStore.getState().isDirty).toBe(true);
  });

  /**
   * The browser's back button.
   *
   * Reproduced the way the browser does it — first the address is a different
   * one, *then* `popstate` comes — because jsdom's own `history.back()` is
   * asynchronous and not reliable in tests. What is measured is what is to be
   * seen afterwards: the query stands, and the address has been turned back.
   */
  it('fängt auch den Zurück-Knopf ab und dreht die Adresse zurück', () => {
    loadDraft();
    renderWithQuery(<Harness />);
    makeDirty();

    act(() => {
      window.history.pushState(null, '', DASHBOARD_PATH);
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(dialog()).not.toBeNull();
    expect(window.location.pathname).toBe(builderPath(FORM_ID));
    expect(screen.getByTestId('route').textContent).toBe('builder');
  });

  /** Closing the tab — the one door no dialog of our own reaches. */
  it('widerspricht dem Schließen des Tabs, solange etwas ungespeichert ist', () => {
    loadDraft();
    renderWithQuery(<Harness />);

    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);

    makeDirty();

    const dirty = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
    /*
      Only the one half is measured. The hook additionally sets
      `returnValue` (see there), because individual browsers ask only on it —
      and precisely that is **not** checkable here: jsdom does not know
      `BeforeUnloadEvent` and maps `Event.returnValue` onto `!defaultPrevented`,
      so every assertion on it would be a repetition of the line above. Whoever
      removes the line in the hook sees it in no test — only in a Safari.
    */
  });

  /**
   * Without `can_build` every save fails at the server's guard — the button
   * is therefore not offered, instead of being offered and refused
   * (the same rule by which the builder's bar leaves it out).
   */
  it('bietet ohne Bearbeiten-Recht kein „Speichern" an', () => {
    loadDraft();
    renderWithQuery(<Harness canSave={false} />);
    makeDirty();

    act(() => {
      navigate(DASHBOARD_PATH);
    });

    expect(dialog()).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Speichern' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Verwerfen' })).toBeDefined();
  });
});
