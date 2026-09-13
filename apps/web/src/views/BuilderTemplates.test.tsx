import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useBuilderStore } from '../builder/builder-store';
import {
  emptyResponse,
  jsonResponse,
  requestUrl,
  stubFetch,
} from '../test/fetch-mock';
import { permissions } from '../test/fixtures';
import { renderWithQuery } from '../test/render-with-query';
import { BuilderView } from './BuilderView';

/**
 * *Vorlagen & Blöcke* through the builder's own surface.
 *
 * What the API tests cannot show is asserted here: that the controls exist,
 * that they are hidden without `canBuild`, and — the one that matters — that
 * the inserted block is the one the **server** handed back, with the ids the
 * server minted. A builder that quietly gave the block its own ids would pass
 * every API test in the suite and still produce the bug the requirement's
 * reproduction names.
 */

const FORM_ID = '019fe500-0000-7000-8000-000000000001';
const PAGE_ID = '019fe500-0000-7000-8000-0000000000a1';
const TEMPLATE_ID = '019fe500-0000-7000-8000-0000000000c1';
const FORM_TEMPLATE_ID = '019fe500-0000-7000-8000-0000000000c2';
const FRESH_PAGE_ID = '019fe500-0000-7000-8000-0000000000d1';
const FRESH_QUESTION_ID = '019fe500-0000-7000-8000-0000000000d2';

function detail(overrides: Record<string, unknown> = {}) {
  return {
    id: FORM_ID,
    title: 'Bestandsmeldung',
    status: 'draft',
    publishedVersion: null,
    responseCount: 0,
    permissions: permissions(),
    updatedAt: '2026-08-05T10:00:00.000Z',
    revision: 1,
    publicSlug: 'abc123',
    definition: {
      pages: [
        { id: PAGE_ID, title: 'Seite 1', description: null, questions: [] },
      ],
    },
    hasUnpublishedChanges: true,
    ...overrides,
  };
}

const PAGE_TEMPLATE = {
  id: TEMPLATE_ID,
  kind: 'page',
  name: 'Ihre Daten',
  questionCount: 1,
  createdAt: '2026-08-05T09:00:00.000Z',
};

const FORM_TEMPLATE = {
  id: FORM_TEMPLATE_ID,
  kind: 'form',
  name: 'Meine Anmeldung',
  questionCount: 7,
  createdAt: '2026-08-05T09:30:00.000Z',
};

const INSTANCE = {
  kind: 'page',
  page: {
    id: FRESH_PAGE_ID,
    title: 'Ihre Daten',
    description: null,
    questions: [
      {
        id: FRESH_QUESTION_ID,
        type: 'text',
        label: 'Name',
        hint: null,
        required: false,
        width: 'full',
        minLength: null,
        maxLength: null,
        pattern: null,
      },
    ],
  },
};

describe('Vorlagen im Builder ', () => {
  beforeEach(() => {
    useBuilderStore.getState().reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * One route table for the whole file: the form detail, the template list,
   * the instance and the save. A single `mockResolvedValue` would answer the
   * list with a form and the parse would fail on something unrelated to what
   * the test is about.
   */
  function routes(
    templates: readonly unknown[] = [PAGE_TEMPLATE, FORM_TEMPLATE],
  ): ReturnType<typeof stubFetch> {
    return stubFetch().mockImplementation((input, init) => {
      const url = requestUrl(input);
      const method = init?.method ?? 'GET';

      if (url.endsWith('/form-templates') && method === 'GET') {
        return Promise.resolve(jsonResponse(200, { templates }));
      }
      if (method === 'DELETE') {
        return Promise.resolve(emptyResponse(204));
      }
      if (url.endsWith(`/form-templates/${TEMPLATE_ID}/instance`)) {
        return Promise.resolve(jsonResponse(200, INSTANCE));
      }
      if (url.endsWith(`/forms/${FORM_ID}/templates`)) {
        return Promise.resolve(jsonResponse(201, PAGE_TEMPLATE));
      }
      // Concept no. 74 — „Aus diesem Formular aktualisieren" and
      // „Umbenennen". Both answer with the *changed* summary, so that a test
      // can read the row afterwards instead of only counting the call.
      if (
        url.endsWith(`/forms/${FORM_ID}/templates/${TEMPLATE_ID}`) &&
        method === 'PUT'
      ) {
        return Promise.resolve(
          jsonResponse(200, { ...PAGE_TEMPLATE, questionCount: 4 }),
        );
      }
      if (
        url.endsWith(`/form-templates/${TEMPLATE_ID}`) &&
        method === 'PATCH'
      ) {
        return Promise.resolve(
          jsonResponse(200, { ...PAGE_TEMPLATE, name: 'BT-Anmeldung 2027' }),
        );
      }
      if (url.endsWith('/forms') && method === 'POST') {
        return Promise.resolve(
          jsonResponse(
            201,
            detail({ id: 'new-form', title: 'Meine Anmeldung' }),
          ),
        );
      }
      return Promise.resolve(jsonResponse(200, detail()));
    });
  }

  async function renderBuilder(
    canBuild = true,
    canManageTemplates = true,
    canUpdateTemplates = canManageTemplates,
  ): Promise<void> {
    renderWithQuery(
      <BuilderView
        formId={FORM_ID}
        canBuild={canBuild}
        canManageTemplates={canManageTemplates}
        canUpdateTemplates={canUpdateTemplates}
        canManageFormSettings={true}
      />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Formularname')).toBeDefined();
    });
  }

  /** Opens the drawer and waits for the organisation's templates to be listed. */
  async function openDrawer(): Promise<void> {
    fireEvent.click(screen.getByRole('button', { name: 'Vorlagen & Blöcke' }));
    await waitFor(() => {
      expect(screen.getByText('Ihre Daten')).toBeDefined();
    });
  }

  /** The sent body of a call, parsed — or `undefined`. */
  function bodyOf(
    call: ReturnType<typeof stubFetch>['mock']['calls'][number] | undefined,
  ): unknown {
    const body = call?.[1]?.body;
    return typeof body === 'string' ? JSON.parse(body) : undefined;
  }

  /** The calls of one method, as a URL list — for „ist etwas passiert?". */
  function callsWith(
    fetchMock: ReturnType<typeof stubFetch>,
    method: string,
  ): string[] {
    return fetchMock.mock.calls
      .filter(([, init]) => (init?.method ?? 'GET') === method)
      .map(([input]) => requestUrl(input));
  }

  it('bietet die drei Vorlagen-Bedienelemente neben den Seiten an', async () => {
    routes();
    await renderBuilder();

    expect(
      screen.getByRole('button', { name: 'Vorlagen & Blöcke' }),
    ).toBeDefined();
    expect(
      screen.getByRole('button', { name: 'Seite als Vorlage speichern' }),
    ).toBeDefined();
    expect(
      screen.getByRole('button', { name: 'Formular als Vorlage speichern' }),
    ).toBeDefined();
  });

  it('zeigt sie ohne canBuild gar nicht — ein Knopf, der nie wirken kann, ist kein Hinweis', async () => {
    routes();
    await renderBuilder(false);

    expect(screen.queryByRole('button', { name: 'Vorlagen & Blöcke' })).toBe(
      null,
    );
    expect(
      screen.queryByRole('button', { name: 'Formular als Vorlage speichern' }),
    ).toBe(null);
  });

  it('listet die Vorlagen der Organisation in zwei Gruppen', async () => {
    routes();
    await renderBuilder();

    fireEvent.click(screen.getByRole('button', { name: 'Vorlagen & Blöcke' }));

    await waitFor(() => {
      expect(screen.getByText('Ihre Daten')).toBeDefined();
    });
    expect(
      screen.getByRole('region', { name: 'Meine Vorlagen' }),
    ).toBeDefined();
    expect(
      screen.getByRole('region', { name: 'Komplette Formular-Vorlagen' }),
    ).toBeDefined();
    expect(screen.getByText('1 Fragen · als Seite')).toBeDefined();
  });

  it('sagt es, wenn noch keine Vorlage gespeichert wurde — ein leeres Fach ist kein Fehler', async () => {
    routes([]);
    await renderBuilder();

    fireEvent.click(screen.getByRole('button', { name: 'Vorlagen & Blöcke' }));

    await waitFor(() => {
      expect(screen.getByText(/Noch keine Vorlagen/)).toBeDefined();
    });
  });

  /**
   * The load-bearing one: the page that lands in the document is the one the
   * server sent, **with the ids the server minted**. A client that copied the
   * block itself — or reused the stored ids — would show the same page and be
   * exactly the bug the review's second reproduction describes.
   */
  it('hängt die eingesetzte Seite mit den Server-IDs an und markiert das Formular als ungespeichert', async () => {
    routes();
    await renderBuilder();

    fireEvent.click(screen.getByRole('button', { name: 'Vorlagen & Blöcke' }));
    await waitFor(() => {
      expect(screen.getByText('Ihre Daten')).toBeDefined();
    });
    // The row's own „Als Seite" button, not its delete button next to it —
    // both mention the template by name.
    fireEvent.click(
      screen.getByRole('button', { name: /^Ihre Daten.*Als Seite$/ }),
    );

    await waitFor(() => {
      expect(useBuilderStore.getState().pages).toHaveLength(2);
    });
    const state = useBuilderStore.getState();
    expect(state.pages[1]?.id).toBe(FRESH_PAGE_ID);
    expect(state.pages[1]?.questions[0]?.id).toBe(FRESH_QUESTION_ID);
    expect(state.activePageIndex).toBe(1);
    expect(state.isDirty).toBe(true);
    // The drawer closes on success — the block is in the document, there is
    // nothing left to pick.
    expect(screen.queryByRole('dialog', { name: 'Vorlagen & Blöcke' })).toBe(
      null,
    );
  });

  it('speichert den Entwurf, bevor es eine Vorlage daraus macht', async () => {
    const fetchMock = routes();
    await renderBuilder();

    // An edit that is not on the server yet.
    fireEvent.change(screen.getByLabelText('Formularname'), {
      target: { value: 'Umbenannt' },
    });

    fireEvent.click(
      screen.getByRole('button', { name: 'Formular als Vorlage speichern' }),
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Name der Vorlage')).toBeDefined();
    });
    // The dialog is prefilled from what is being saved.
    expect(screen.getByLabelText('Name der Vorlage')).toHaveProperty(
      'value',
      'Umbenannt',
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Als Vorlage speichern' }),
    );

    await waitFor(() => {
      const calls = fetchMock.mock.calls.map(([input, init]) => ({
        url: requestUrl(input),
        method: init?.method ?? 'GET',
      }));
      const put = calls.findIndex(
        (call) =>
          call.method === 'PUT' && call.url.endsWith(`/forms/${FORM_ID}`),
      );
      const post = calls.findIndex((call) =>
        call.url.endsWith(`/forms/${FORM_ID}/templates`),
      );
      // Both happened, and the save came first — the server copies what it has
      // stored, so the order is the whole point.
      expect(put).toBeGreaterThanOrEqual(0);
      expect(post).toBeGreaterThan(put);
    });
  });

  /**
   * **The physical deletion of a template**.
   *
   * Two promises, and both are surface questions no API test shows: without
   * the right the button is **gone** (not greyed out), and where it
   * stands it carries the **irreversible** of the two deletion terms together
   * with a confirmation in the danger form. The boundary is and remains the
   * guard behind `DELETE /form-templates/:id`.
   */
  describe('Endgültig löschen ', () => {
    it('bietet ihn ohne das Recht gar nicht an — kein ausgegrauter Knopf', async () => {
      routes();
      await renderBuilder(true, false);
      await openDrawer();

      // Listing and inserting stay open — that is the other half of the
      // decision and must not disappear along with it here.
      expect(
        screen.getByRole('button', { name: /^Ihre Daten.*Als Seite$/ }),
      ).toBeDefined();
      // Searched in the drawer itself, not on the whole page: the builder
      // behind it has „… löschen" buttons of its own, and a search over
      // everything would be green as soon as one of them disappears.
      //
      // Reproduction: `disabled` instead of absence → red, because a disabled
      // button still stands in the role.
      const drawer = screen.getByRole('dialog', { name: 'Vorlagen & Blöcke' });
      expect(within(drawer).queryByRole('button', { name: /löschen/ })).toBe(
        null,
      );
    });

    it('nennt ihn „endgültig löschen" und fragt vorher — die Anfrage geht erst nach dem Bestätigen', async () => {
      const fetchMock = routes();
      await renderBuilder();
      await openDrawer();

      fireEvent.click(
        screen.getByRole('button', {
          name: 'Vorlage „Ihre Daten" endgültig löschen',
        }),
      );

      const prompt = await screen.findByRole('alert');
      expect(prompt.textContent).toContain(
        'lässt sich nicht rückgängig machen',
      );
      // Nothing has happened as long as nothing has been confirmed.
      expect(
        fetchMock.mock.calls.filter(
          ([, init]) => (init?.method ?? 'GET') === 'DELETE',
        ),
      ).toHaveLength(0);

      fireEvent.click(
        within(prompt).getByRole('button', { name: 'Endgültig löschen' }),
      );

      await waitFor(() => {
        expect(
          fetchMock.mock.calls
            .filter(([, init]) => (init?.method ?? 'GET') === 'DELETE')
            .map(([input]) => requestUrl(input)),
        ).toEqual([expect.stringContaining(`/form-templates/${TEMPLATE_ID}`)]);
      });
    });
  });

  /**
   * **Renaming and updating** .
   *
   * The two actions are unequal, and the surface has to show that — no API
   * test can:
   *
   * - *Renaming* is reversible: a field in the row, **no** confirmation.
   * - *Updating* overwrites content for which there is no wastebasket:
   *   confirmation in the danger form, and without the right the button is
   *   **absent**, not greyed out.
   */
  describe('Umbenennen und Aktualisieren ', () => {
    it('benennt um, ohne vorher zu fragen — und schickt nur den Namen', async () => {
      const fetchMock = routes();
      await renderBuilder();
      await openDrawer();

      fireEvent.click(
        screen.getByRole('button', {
          name: 'Vorlage „Ihre Daten" umbenennen',
        }),
      );

      // No confirmation: reversible means that the one red gesture of this
      // drawer is precisely **not** handed out here.
      expect(screen.queryByRole('alert')).toBe(null);

      const field = screen.getByLabelText(
        'Neuer Name der Vorlage „Ihre Daten"',
      );
      fireEvent.change(field, { target: { value: 'BT-Anmeldung 2027' } });
      fireEvent.click(screen.getByRole('button', { name: 'Umbenennen' }));

      await waitFor(() => {
        expect(callsWith(fetchMock, 'PATCH')).toEqual([
          expect.stringContaining(`/form-templates/${TEMPLATE_ID}`),
        ]);
      });
      expect(
        bodyOf(
          fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH'),
        ),
      ).toEqual({ name: 'BT-Anmeldung 2027' });
      // The content is not touched: no second call that replaces it.
      expect(callsWith(fetchMock, 'PUT')).toEqual([]);
    });

    it('fragt vor dem Aktualisieren in der unumkehrbaren Form — und schickt erst danach', async () => {
      const fetchMock = routes();
      await renderBuilder();
      await openDrawer();

      fireEvent.click(
        screen.getByRole('button', {
          name: 'Vorlage „Ihre Daten" aus der aktuell geöffneten Seite aktualisieren',
        }),
      );

      const prompt = await screen.findByRole('alert');
      expect(prompt.textContent).toContain(
        'lässt sich nicht rückgängig machen',
      );
      // „Kopie, keine Referenz"  stands in the confirmation, because the
      // name of the action suggests the opposite.
      expect(prompt.textContent).toContain('Bereits eingefügte Kopien');
      expect(callsWith(fetchMock, 'PUT')).toEqual([]);

      fireEvent.click(
        within(prompt).getByRole('button', { name: 'Inhalt ersetzen' }),
      );

      await waitFor(() => {
        expect(
          callsWith(fetchMock, 'PUT').filter((url) =>
            url.endsWith(`/forms/${FORM_ID}/templates/${TEMPLATE_ID}`),
          ),
        ).toHaveLength(1);
      });
      // The kind stays, and the source is the open page — exactly what the
      // confirmation announced.
      expect(
        bodyOf(
          fetchMock.mock.calls.find(
            ([input, init]) =>
              init?.method === 'PUT' &&
              requestUrl(input).endsWith(
                `/forms/${FORM_ID}/templates/${TEMPLATE_ID}`,
              ),
          ),
        ),
      ).toEqual({ kind: 'page', pageId: PAGE_ID });
    });

    it('bricht ab, ohne etwas zu schicken', async () => {
      const fetchMock = routes();
      await renderBuilder();
      await openDrawer();

      fireEvent.click(
        screen.getByRole('button', {
          name: 'Vorlage „Ihre Daten" aus der aktuell geöffneten Seite aktualisieren',
        }),
      );
      const prompt = await screen.findByRole('alert');
      fireEvent.click(
        within(prompt).getByRole('button', { name: 'Abbrechen' }),
      );

      expect(callsWith(fetchMock, 'PUT')).toEqual([]);
      expect(screen.queryByRole('alert')).toBe(null);
    });

    it('speichert den Entwurf, bevor es die Vorlage überschreibt', async () => {
      const fetchMock = routes();
      await renderBuilder();

      // A change the server does not know yet. Without the save before it,
      // „aktualisieren" would write the old state into the template —
      // unnoticed and irreversible.
      fireEvent.change(screen.getByLabelText('Formularname'), {
        target: { value: 'Umbenannt' },
      });

      await openDrawer();
      fireEvent.click(
        screen.getByRole('button', {
          name: 'Vorlage „Ihre Daten" aus der aktuell geöffneten Seite aktualisieren',
        }),
      );
      const prompt = await screen.findByRole('alert');
      fireEvent.click(
        within(prompt).getByRole('button', { name: 'Inhalt ersetzen' }),
      );

      await waitFor(() => {
        const puts = callsWith(fetchMock, 'PUT');
        const draft = puts.findIndex((url) =>
          url.endsWith(`/forms/${FORM_ID}`),
        );
        const update = puts.findIndex((url) =>
          url.endsWith(`/forms/${FORM_ID}/templates/${TEMPLATE_ID}`),
        );
        expect(draft).toBeGreaterThanOrEqual(0);
        expect(update).toBeGreaterThan(draft);
      });
    });

    it('bietet das Aktualisieren ohne das Rechte-Paar dieses Formulars gar nicht an — das Umbenennen sehr wohl', async () => {
      routes();
      // The pair organisation-wide, cut off on **this** form: exactly the
      // case the two flags are separated for.
      await renderBuilder(true, true, false);
      await openDrawer();

      const drawer = screen.getByRole('dialog', { name: 'Vorlagen & Blöcke' });
      // Reproduction: `disabled` instead of absence → red, because a disabled
      // button still stands in the role.
      expect(
        within(drawer).queryByRole('button', { name: /aktualisieren/ }),
      ).toBe(null);
      // Renaming names no form (`@NoFormIdInRequest`), so no form restriction
      // speaks about it — it stays.
      expect(
        within(drawer).getByRole('button', {
          name: 'Vorlage „Ihre Daten" umbenennen',
        }),
      ).toBeDefined();
    });

    /**
     * *Follow-up to concept no. 74.* Renaming hung on `canBuild` alone, and
     * the route thereby let a member's template be renamed and the name be
     * taken anew (measured on the API side). The surface therefore shows the
     * button only with the pair — **absent**, not greyed out.
     */
    it('bietet das Umbenennen ohne das Rechte-Paar gar nicht an', async () => {
      routes();
      await renderBuilder(true, false, false);
      await openDrawer();

      const drawer = screen.getByRole('dialog', { name: 'Vorlagen & Blöcke' });
      expect(within(drawer).queryByRole('button', { name: /umbenennen/ })).toBe(
        null,
      );
      // And the inserting stays: it still hangs on `canBuild` alone.
      expect(
        within(drawer).getByRole('button', { name: /Ihre Daten/ }),
      ).toBeDefined();
    });

    /**
     * *Follow-up to concept no. 74, a review finding.* The confirmation said
     * „die aktuell geöffnete Seite" and never named it by name — while
     * `BuilderView` sends `activePage(state)`. With the wrong active page the
     * old content is gone afterwards, and there is no wastebasket.
     *
     * *Reproduction:* replace `updateSourceOf` with `UPDATE_SOURCE[kind].by` →
     * the second assertion turns red.
     */
    it('nennt in der Rückfrage die Seite, die den Inhalt überschreiben wird', async () => {
      routes();
      await renderBuilder();
      await openDrawer();

      fireEvent.click(
        screen.getByRole('button', {
          name: 'Vorlage „Ihre Daten" aus der aktuell geöffneten Seite aktualisieren',
        }),
      );

      const prompt = await screen.findByRole('alert');
      expect(prompt.textContent).toContain('die aktuell geöffnete Seite');
      // The title from `detail()` — the page that is about to be copied.
      expect(prompt.textContent).toContain('„Seite 1"');
    });

    it('sagt es, wenn das Überschreiben scheitert — sonst hielte man die Vorlage für geändert', async () => {
      const fetchMock = routes();
      fetchMock.mockImplementation((input, init) => {
        const url = requestUrl(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/form-templates') && method === 'GET') {
          return Promise.resolve(
            jsonResponse(200, { templates: [PAGE_TEMPLATE] }),
          );
        }
        if (
          url.endsWith(`/forms/${FORM_ID}/templates/${TEMPLATE_ID}`) &&
          method === 'PUT'
        ) {
          return Promise.resolve(jsonResponse(403, { message: 'nein' }));
        }
        return Promise.resolve(jsonResponse(200, detail()));
      });
      await renderBuilder();
      await openDrawer();

      fireEvent.click(
        screen.getByRole('button', {
          name: 'Vorlage „Ihre Daten" aus der aktuell geöffneten Seite aktualisieren',
        }),
      );
      const prompt = await screen.findByRole('alert');
      fireEvent.click(
        within(prompt).getByRole('button', { name: 'Inhalt ersetzen' }),
      );

      expect(
        await screen.findByText(
          'Die Vorlage konnte nicht aktualisiert werden.',
        ),
      ).toBeDefined();
    });
  });
});
