import { SYSTEM_FORM_SETTINGS } from '@formsache/shared';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useBuilderStore } from '../builder/builder-store';
import { createQuestion } from '../builder/question-defaults';
import { DASHBOARD_PATH, previewPath } from '../router/routes';
import { navigate } from '../router/use-route';
import { jsonResponse, requestUrl, stubFetch } from '../test/fetch-mock';
import { UMBRELLA_TENANT_ID, membership, permissions } from '../test/fixtures';
import { renderWithQuery } from '../test/render-with-query';
import { BuilderView } from './BuilderView';
import { PreviewView } from './PreviewView';

/**
 * **Review finding 21b: the switch to the preview discarded the work.**
 *
 * Three causes worked together, and two of them lie in these two views:
 * `BuilderView` emptied the store on unmount, and `PreviewView` read
 * exclusively `GET /forms/:id`, that is the last *saved* state. Whoever built
 * something and wanted to look at how it looks got the form from before to see
 * — and had lost what was built while doing so.
 *
 * Both are measured separately, because both can break on their own: that the
 * builder leaves the document standing, and that the preview reads it **and
 * names it**.
 */

const FORM_ID = '019fe900-0000-7000-8000-000000000001';
const PAGE_ID = '019fe900-0000-7000-8000-0000000000a1';
const QUESTION_ID = '019fe900-0000-7000-8000-0000000000b1';
const DRAFT_QUESTION_ID = '019fe900-0000-7000-8000-0000000000b2';

const TENANT = membership(
  UMBRELLA_TENANT_ID,
  'Ortsgruppe Musterstadt',
  'Musterstadt',
).tenant;

/** The **saved** state, the way the server delivers it. */
function formDetail(): Record<string, unknown> {
  return {
    id: FORM_ID,
    title: 'Bestandsmeldung',
    status: 'draft',
    publishedVersion: null,
    responseCount: 0,
    permissions: permissions(),
    updatedAt: '2026-08-14T08:00:00.000Z',
    revision: 3,
    publicSlug: 'abcdefghijklmnopqrstuv',
    definition: {
      pages: [
        {
          id: PAGE_ID,
          title: 'Angaben',
          description: null,
          questions: [
            {
              id: QUESTION_ID,
              type: 'text',
              label: 'Name',
              hint: null,
              required: true,
              width: 'full',
              minLength: null,
              maxLength: null,
              pattern: null,
            },
          ],
        },
      ],
    },
    hasUnpublishedChanges: false,
  };
}

function settingsDocument(): Record<string, unknown> {
  return {
    overridden: {
      avail: false,
      access: false,
      confirm: false,
      display: false,
      budget: false,
    },
    values: {},
    tenantDefaults: SYSTEM_FORM_SETTINGS,
    effective: SYSTEM_FORM_SETTINGS,
    revision: 1,
    tenantRevision: 1,
  };
}

function stubApi(): ReturnType<typeof stubFetch> {
  const fetchMock = stubFetch();
  fetchMock.mockImplementation((input) => {
    const url = requestUrl(input);
    if (url.endsWith(`/forms/${FORM_ID}`)) {
      return Promise.resolve(jsonResponse(200, formDetail()));
    }
    if (url.endsWith(`/forms/${FORM_ID}/settings`)) {
      return Promise.resolve(jsonResponse(200, settingsDocument()));
    }
    if (url.endsWith(`/forms/${FORM_ID}/notifications`)) {
      return Promise.resolve(
        jsonResponse(200, {
          notifications: [],
          templates: [],
          inheritedReplyTo: [],
        }),
      );
    }
    if (url.includes('/form-templates')) {
      return Promise.resolve(jsonResponse(200, { templates: [] }));
    }
    throw new Error(`unerwartete Anfrage: ${url}`);
  });
  return fetchMock;
}

/** An unsaved draft in the store, the way an edit leaves it behind. */
function unsavedDraft(formId = FORM_ID): void {
  useBuilderStore.getState().reset();
  useBuilderStore.getState().load({
    id: formId,
    title: 'Bestandsmeldung',
    definition: {
      pages: [
        {
          id: PAGE_ID,
          title: 'Angaben',
          description: null,
          questions: [
            {
              ...createQuestion('text', DRAFT_QUESTION_ID),
              label: 'Mitgliedsnummer',
            },
          ],
        },
      ],
    },
    revision: 3,
  });
  useBuilderStore.getState().setTitle('Bestandsmeldung 2027');
}

beforeEach(() => {
  useBuilderStore.getState().reset();
  window.history.pushState(null, '', previewPath(FORM_ID));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BuilderView – was beim Verlassen mit dem Entwurf geschieht', () => {
  it('lässt einen ungespeicherten Entwurf im Store stehen', async () => {
    stubApi();
    const view = renderWithQuery(
      <BuilderView
        formId={FORM_ID}
        canBuild
        canManageTemplates
        canUpdateTemplates
        canManageFormSettings
      />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Formularname')).toBeDefined();
    });

    fireEvent.change(screen.getByLabelText('Formularname'), {
      target: { value: 'Bestandsmeldung 2027' },
    });
    expect(useBuilderStore.getState().isDirty).toBe(true);

    view.unmount();

    // Exactly what the finding demands: the switch to another view does not
    // take the work with it.
    const state = useBuilderStore.getState();
    expect(state.formId).toBe(FORM_ID);
    expect(state.title).toBe('Bestandsmeldung 2027');
    expect(state.isDirty).toBe(true);
  });

  /**
   * Without open work it stays with the old behaviour, and that is deliberate:
   * the store then only carries a copy of what the server has, and an emptied
   * store makes the next opening load freshly instead of showing a possibly
   * outdated state.
   */
  it('leert den Store, wenn nichts ungespeichert ist', async () => {
    stubApi();
    const view = renderWithQuery(
      <BuilderView
        formId={FORM_ID}
        canBuild
        canManageTemplates
        canUpdateTemplates
        canManageFormSettings
      />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Formularname')).toBeDefined();
    });

    view.unmount();

    expect(useBuilderStore.getState().formId).toBeNull();
  });
});

describe('PreviewView – der Stand aus dem Builder', () => {
  it('zeigt den ungespeicherten Entwurf statt des Server-Standes', async () => {
    stubApi();
    unsavedDraft();

    renderWithQuery(
      <PreviewView
        formId={FORM_ID}
        tenant={TENANT}
        canBuild
        canManageFormSettings
      />,
    );

    // The question out of the builder stands in the form …
    expect(await screen.findByText('Mitgliedsnummer')).toBeDefined();
    // … and the saved one does not any more.
    expect(screen.queryByText('Name')).toBeNull();
  });

  it('kennzeichnet sichtbar, dass es ein ungespeicherter Stand ist', async () => {
    stubApi();
    unsavedDraft();

    renderWithQuery(
      <PreviewView
        formId={FORM_ID}
        tenant={TENANT}
        canBuild
        canManageFormSettings
      />,
    );

    const note = await screen.findByTestId('preview-draft-note');
    expect(note.textContent).toContain('ungespeicherten');
  });

  /**
   * The preview clears a **clean** draft away when leaving as well (review
   * rework): otherwise a copy would stay lying in the store after „save and
   * then away", and the builder would show it at the next opening instead of
   * loading anew — outdated as soon as somebody else has saved in between.
   */
  it('leert den Store beim Verlassen, wenn nichts ungespeichert ist', async () => {
    stubApi();
    unsavedDraft();
    useBuilderStore.getState().markSaved(4);

    const view = renderWithQuery(
      <PreviewView
        formId={FORM_ID}
        tenant={TENANT}
        canBuild
        canManageFormSettings
      />,
    );
    await screen.findByText('Mitgliedsnummer');

    view.unmount();

    expect(useBuilderStore.getState().formId).toBeNull();
  });

  it('behält einen ungespeicherten Entwurf beim Verlassen', async () => {
    stubApi();
    unsavedDraft();

    const view = renderWithQuery(
      <PreviewView
        formId={FORM_ID}
        tenant={TENANT}
        canBuild
        canManageFormSettings
      />,
    );
    await screen.findByText('Mitgliedsnummer');

    view.unmount();

    expect(useBuilderStore.getState().formId).toBe(FORM_ID);
    expect(useBuilderStore.getState().isDirty).toBe(true);
  });

  /**
   * The way back without the edit permission — the case in which the permission
   * is withdrawn *during* the session while an unsaved draft lies in the store
   * (review rework). The blocker then still stands; without the dialog this view
   * swallowed every navigation click without a word.
   */
  it('zeigt die Rückfrage auch ohne Bearbeiten-Recht', () => {
    stubApi();
    unsavedDraft();

    renderWithQuery(
      <PreviewView
        formId={FORM_ID}
        tenant={TENANT}
        canBuild={false}
        canManageFormSettings
      />,
    );

    act(() => {
      navigate(DASHBOARD_PATH);
    });

    expect(
      screen.getByRole('dialog', { name: 'Ungespeicherte Änderungen' }),
    ).toBeDefined();
    expect(window.location.pathname).toBe(previewPath(FORM_ID));
    // Without the permission every save would fail at the guard of the server
    // — the button is therefore not offered.
    expect(screen.queryByRole('button', { name: 'Speichern' })).toBeNull();
  });

  it('bleibt beim Server-Stand, wenn der Store ein anderes Formular trägt', async () => {
    stubApi();
    unsavedDraft('019fe900-0000-7000-8000-0000000000ff');

    renderWithQuery(
      <PreviewView
        formId={FORM_ID}
        tenant={TENANT}
        canBuild
        canManageFormSettings
      />,
    );

    expect(await screen.findByText('Name')).toBeDefined();
    expect(screen.queryByText('Mitgliedsnummer')).toBeNull();
    expect(screen.queryByTestId('preview-draft-note')).toBeNull();
  });

  /**
   * Saved means saved: the document in the store is then the same one the
   * server has, and a note „ungespeichert" would be plainly wrong.
   */
  it('nennt einen gespeicherten Stand nicht ungespeichert', async () => {
    stubApi();
    unsavedDraft();
    useBuilderStore.getState().markSaved(4);

    renderWithQuery(
      <PreviewView
        formId={FORM_ID}
        tenant={TENANT}
        canBuild
        canManageFormSettings
      />,
    );

    expect(await screen.findByText('Mitgliedsnummer')).toBeDefined();
    expect(screen.queryByTestId('preview-draft-note')).toBeNull();
  });
});
