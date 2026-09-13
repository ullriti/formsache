import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { jsonResponse, stubFetch } from '../test/fetch-mock';
import { permissions } from '../test/fixtures';
import { renderWithQuery } from '../test/render-with-query';
import { DashboardView } from './DashboardView';

/**
 * The dashboard: the card grid is real, and so are three of
 * the four figures.
 *
 * Every test that expects forms stubs `fetch`, because the grid is server
 * state now — a component test that rendered without one would be asserting
 * against a loading state.
 */

/** The URL of a `fetch` argument, whichever of its three shapes it is. */
function requestPath(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

/**
 * The figure belonging to a KPI label.
 *
 * Anchored on the `term` **role**, not on the text: since the cards exist,
 * "Aktiv" is also a status badge, and a text lookup matches both. The role is
 * what distinguishes the tile from the badge — which is a good reason for the
 * tiles to be a description list in the first place.
 */
function kpiValue(label: string): string | null {
  const term = screen
    .getAllByRole('term')
    .find((candidate) => candidate.textContent === label);
  const group = term?.parentElement;
  if (group === undefined || group === null) {
    throw new Error(`KPI "${label}" has no surrounding group.`);
  }
  return within(group).getByRole('definition').textContent;
}

/**
 * One page of `GET /api/forms`, as the wire contract shapes it.
 *
 * Every stub goes through here rather than returning a bare array: the three
 * KPI figures come off `total`/`activeTotal`/`responseTotal` now, and a fixture
 * that left them out would let the view render zeroes while the cards are on
 * screen — a green test about a broken dashboard.
 *
 * The three totals **default to the page's own contents**, which is exactly
 * right for the tests that show one short page and exactly wrong for the ones
 * about paging — so those pass them explicitly.
 */
function page(
  items: ReturnType<typeof form>[],
  overrides: Record<string, unknown> = {},
) {
  return {
    items,
    total: items.length,
    activeTotal: items.filter((entry) => entry.status === 'active').length,
    responseTotal: items.reduce((sum, entry) => sum + entry.responseCount, 0),
    limit: 24,
    offset: 0,
    ...overrides,
  };
}

function form(overrides: Record<string, unknown> = {}) {
  return {
    id: '019fe200-0000-7000-8000-000000000001',
    title: 'Bestandsmeldung',
    status: 'draft',
    publishedVersion: null,
    responseCount: 0,
    permissions: permissions(),
    updatedAt: '2026-07-27T10:00:00.000Z',
    ...overrides,
  };
}

describe('DashboardView', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('counts the figures from the forms the server reported', async () => {
    stubFetch().mockResolvedValue(
      jsonResponse(
        200,
        page([
          form({ status: 'active', publishedVersion: 1, responseCount: 12 }),
          form({
            id: '019fe200-0000-7000-8000-000000000002',
            title: 'Sterbefallmeldung',
          }),
        ]),
      ),
    );

    renderWithQuery(
      <DashboardView
        tenantName="Dachorganisation"
        tenantCount={3}
        canBuild
        aiFormsAvailable={false}
        onOpenAiForm={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(kpiValue('Formulare')).toBe('2');
    });
    // "Aktiv" counts the published ones, not all of them — the difference is
    // the whole point of the badge next to it.
    expect(kpiValue('Aktiv')).toBe('1');
    expect(kpiValue('Antworten gesamt')).toBe('12');
    expect(kpiValue('Organisationen')).toBe('3');
  });

  it('shows a card per form with its status badge', async () => {
    stubFetch().mockResolvedValue(
      jsonResponse(
        200,
        page([
          form({ status: 'active', publishedVersion: 2, responseCount: 1 }),
        ]),
      ),
    );

    renderWithQuery(
      <DashboardView
        tenantName="Dachorganisation"
        tenantCount={1}
        canBuild
        aiFormsAvailable={false}
        onOpenAiForm={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Bestandsmeldung')).toBeDefined();
    });
    expect(screen.getByText('Aktiv', { selector: 'span' })).toBeDefined();
    // Singular, because "1 Antworten" is the kind of detail that makes an
    // application feel unfinished.
    expect(screen.getByText('1 Antwort')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Bearbeiten' })).toBeDefined();
  });

  it('reads the label before the figure, as a description list must', async () => {
    stubFetch().mockResolvedValue(jsonResponse(200, page([])));

    renderWithQuery(
      <DashboardView
        tenantName="Dachorganisation"
        tenantCount={1}
        canBuild
        aiFormsAvailable={false}
        onOpenAiForm={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(kpiValue('Formulare')).toBe('0');
    });
    const group = screen
      .getAllByRole('term')
      .find(
        (candidate) => candidate.textContent === 'Formulare',
      )?.parentElement;
    // The reading order assistive technology follows, not the visual one:
    // "Formulare, 0". The handoff's figure-on-top look comes from CSS
    // (`column-reverse`), which is invisible to this assertion — and that is
    // the point of asserting it here.
    expect(group?.textContent).toBe('Formulare0');
  });

  it('shows the empty state instead of invented forms', async () => {
    stubFetch().mockResolvedValue(jsonResponse(200, page([])));

    renderWithQuery(
      <DashboardView
        tenantName="Dachorganisation"
        tenantCount={1}
        canBuild
        aiFormsAvailable={false}
        onOpenAiForm={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Noch keine Formulare vorhanden/)).toBeDefined();
    });
    expect(
      screen.getByRole('heading', { level: 1, name: 'Dashboard' }),
    ).toBeDefined();
    expect(
      screen.getByText('Alle Formulare von Dachorganisation'),
    ).toBeDefined();
  });

  it('creates a form from the name that was typed', async () => {
    const created = jsonResponse(201, {
      ...form({ title: 'Jahrestagung' }),
      definition: {
        pages: [
          {
            id: '019fe200-0000-7000-8000-0000000000a0',
            title: 'Seite 1',
            questions: [],
          },
        ],
      },
      revision: 1,
      publicSlug: 'abc',
      hasUnpublishedChanges: true,
    });
    // Answered by path and not by order: since review finding 17 the page also
    // asks for the templates, and which of the two read requests
    // goes out first is TanStack Query's business.
    const fetchMock = stubFetch().mockImplementation((input, init) =>
      Promise.resolve(
        init?.method === 'POST'
          ? created
          : requestPath(input).includes('/form-templates')
            ? jsonResponse(200, { templates: [] })
            : jsonResponse(200, page([])),
      ),
    );

    renderWithQuery(
      <DashboardView
        tenantName="Dachorganisation"
        tenantCount={1}
        canBuild
        aiFormsAvailable={false}
        onOpenAiForm={() => undefined}
      />,
    );

    fireEvent.change(screen.getByLabelText('Name des neuen Formulars'), {
      target: { value: 'Jahrestagung' },
    });
    fireEvent.click(screen.getByRole('button', { name: '+ Neues Formular' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/forms',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ title: 'Jahrestagung' }),
        }),
      );
    });
  });

  /**
   * **Starting from a template without opening a form first**
   * (review finding 17).
   *
   * The templates already existed, but only in the builder — whoever wanted to use one
   * had to open some other form. Three things are measured,
   * and the third is the load-bearing one:
   *
   * 1. only the kind `form` is on offer (a page template does not create a
   *    form),
   * 2. „Ohne Vorlage" is the default,
   * 3. the choice travels as `templateId` to **the same** `POST /forms` the
   *    builder calls — no second way.
   *
   * *Counter-check:* removing the filter on `kind === 'form'` → „Seite:
   * Adressblock" is on offer and produces a 400 at the server.
   */
  it('creates a form from a chosen Vorlage, over the same POST the builder uses', async () => {
    const created = jsonResponse(201, {
      ...form({ title: 'Aus Vorlage' }),
      definition: {
        pages: [
          {
            id: '019fe200-0000-7000-8000-0000000000a0',
            title: 'Seite 1',
            questions: [],
          },
        ],
      },
      revision: 1,
      publicSlug: 'abc',
      hasUnpublishedChanges: true,
    });
    const templateId = '019fe200-0000-7000-8000-0000000000f1';
    const fetchMock = stubFetch().mockImplementation((input, init) =>
      Promise.resolve(
        init?.method === 'POST'
          ? created
          : requestPath(input).includes('/form-templates')
            ? jsonResponse(200, {
                templates: [
                  {
                    id: templateId,
                    kind: 'form',
                    name: 'Jahrestagung',
                    questionCount: 4,
                    createdAt: '2026-07-27T10:00:00.000Z',
                  },
                  {
                    id: '019fe200-0000-7000-8000-0000000000f2',
                    kind: 'page',
                    name: 'Adressblock',
                    questionCount: 3,
                    createdAt: '2026-07-27T10:00:00.000Z',
                  },
                ],
              })
            : jsonResponse(200, page([])),
      ),
    );

    renderWithQuery(
      <DashboardView
        tenantName="Dachorganisation"
        tenantCount={1}
        canBuild
        aiFormsAvailable={false}
        onOpenAiForm={() => undefined}
      />,
    );

    const select = await screen.findByLabelText<HTMLSelectElement>('Vorlage');
    expect(
      Array.from(select.options).map((option) => option.textContent),
    ).toStrictEqual(['Ohne Vorlage', 'Jahrestagung']);
    expect(select.value).toBe('');

    fireEvent.change(screen.getByLabelText('Name des neuen Formulars'), {
      target: { value: 'Aus Vorlage' },
    });
    fireEvent.change(select, { target: { value: templateId } });
    fireEvent.click(screen.getByRole('button', { name: '+ Neues Formular' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/forms',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ title: 'Aus Vorlage', templateId }),
        }),
      );
    });
  });

  /**
   * The counter-check: without templates no select. A select with the
   * single entry „Ohne Vorlage" is a question without an answer.
   */
  it('shows no Vorlage select while the organisation has none', async () => {
    stubFetch().mockImplementation((input) =>
      Promise.resolve(
        requestPath(input).includes('/form-templates')
          ? jsonResponse(200, { templates: [] })
          : jsonResponse(200, page([])),
      ),
    );

    renderWithQuery(
      <DashboardView
        tenantName="Dachorganisation"
        tenantCount={1}
        canBuild
        aiFormsAvailable={false}
        onOpenAiForm={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Noch keine Formulare vorhanden/)).toBeDefined();
    });
    expect(screen.queryByLabelText('Vorlage')).toBeNull();
  });

  /**
   * Without a tenant scope every tenant-bound route answers 403, so the query
   * is not fired at all — the app has an explanation for "no tenant" and none
   * for "403 on a request nobody needed to make".
   */
  it('asks for no forms while the session is scoped to no tenant', () => {
    const fetchMock = stubFetch().mockResolvedValue(
      jsonResponse(200, page([])),
    );

    renderWithQuery(
      <DashboardView
        tenantCount={0}
        canBuild
        aiFormsAvailable={false}
        onOpenAiForm={() => undefined}
      />,
    );

    expect(screen.getByText('Keine Organisation ausgewählt.')).toBeDefined();
    expect(kpiValue('Organisationen')).toBe('0');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * A disabled button explains nothing. Someone looking for „wie lege ich ein
   * Formular an" has to be able to press the obvious control and be told what
   * is missing — the earlier version sat there greyed out and said nothing,
   * which is how this was reported.
   */
  it('says what is missing instead of sitting there disabled', async () => {
    const fetchMock = stubFetch().mockResolvedValue(
      jsonResponse(200, page([])),
    );

    renderWithQuery(
      <DashboardView
        tenantName="Dachorganisation"
        tenantCount={1}
        canBuild
        aiFormsAvailable={false}
        onOpenAiForm={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/Noch keine Formulare vorhanden/)).toBeDefined();
    });

    const button = screen.getByRole('button', { name: '+ Neues Formular' });
    expect(button).toHaveProperty('disabled', false);

    fireEvent.click(button);

    expect(screen.getByText(/Bitte zuerst einen Namen eingeben/)).toBeDefined();
    // Told, not sent away: the field is where the answer goes.
    expect(document.activeElement).toBe(
      screen.getByLabelText('Name des neuen Formulars'),
    );
    // And nothing was created from nothing. What is counted are the writes
    // and not the calls: since review finding 17 the page also reads the
    // templates, and „wie viele GETs" was never the statement of this case.
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === 'POST'),
    ).toBe(false);
  });

  it('drops the hint as soon as a name is typed', async () => {
    stubFetch().mockResolvedValue(jsonResponse(200, page([])));

    renderWithQuery(
      <DashboardView
        tenantName="Dachorganisation"
        tenantCount={1}
        canBuild
        aiFormsAvailable={false}
        onOpenAiForm={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/Noch keine Formulare vorhanden/)).toBeDefined();
    });

    fireEvent.click(screen.getByRole('button', { name: '+ Neues Formular' }));
    expect(screen.getByText(/Bitte zuerst einen Namen eingeben/)).toBeDefined();

    fireEvent.change(screen.getByLabelText('Name des neuen Formulars'), {
      target: { value: 'Jahrestagung' },
    });

    expect(screen.queryByText(/Bitte zuerst einen Namen eingeben/)).toBeNull();
  });

  /**
   * Regression.
   *
   * The card and the button hung on `hasTenant` alone, so a role with only
   * „Antworten ansehen" was offered „+ Neues Formular" and `POST /api/forms`
   * answered 403. **Explained, not merely hidden**: this is the one control on
   * the landing page, and with several organisations the same person finds it in one
   * and not in the next — a box that is simply gone reads as a broken page.
   *
   * Display only. The guard decides again on every request (`CONTRIBUTING.md`).
   */
  describe('without can_build', () => {
    async function renderWithout() {
      stubFetch().mockResolvedValue(
        jsonResponse(
          200,
          page([
            form({
              status: 'active',
              publishedVersion: 1,
              responseCount: 3,
              // The card's **own** rights, not the organisation's (the requirement
              // no. 3). A role without `can_build` in the organisation cannot hold it on
              // a single form either — a restriction only ever intersects — so a
              // payload saying otherwise would be one the server cannot send.
              permissions: permissions({ canBuild: false }),
            }),
          ]),
        ),
      );
      renderWithQuery(
        <DashboardView
          tenantName="Dachorganisation"
          tenantCount={2}
          canBuild={false}
          aiFormsAvailable={false}
          onOpenAiForm={() => undefined}
        />,
      );
      await waitFor(() => {
        expect(screen.getByText('Bestandsmeldung')).toBeDefined();
      });
    }

    it('offers neither the name field nor „+ Neues Formular"', async () => {
      await renderWithout();

      expect(
        screen.queryByRole('button', { name: '+ Neues Formular' }),
      ).toBeNull();
      expect(screen.queryByLabelText('Name des neuen Formulars')).toBeNull();
    });

    it('says why, naming the right as the group editor names it', async () => {
      await renderWithout();

      expect(
        screen.getByText(/Formulare anlegen ist in dieser Organisation/),
      ).toBeDefined();
      expect(screen.getByText(/„Bearbeiten"/)).toBeDefined();
    });

    it('drops „Bearbeiten" on the cards, keeping „Antworten"', async () => {
      await renderWithout();

      expect(screen.queryByRole('button', { name: 'Bearbeiten' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Antworten' })).toBeDefined();
    });

    /**
     * The case that is not about the organisation at all (the requirement no. 3): the
     * membership may build — the create box is right there — and **one** form
     * caps this person to a role that may not. Two cards, one answer each.
     *
     * The card used to read the organisation-wide flag, so this person was offered
     * „Bearbeiten" on the capped form and got a 403 from behind it. Asserted
     * per card rather than by counting buttons: „eine Schaltfläche weniger"
     * would also be true if the *wrong* card had lost it.
     */
    it('drops „Bearbeiten" only on the form the person is capped on', async () => {
      stubFetch().mockResolvedValue(
        jsonResponse(
          200,
          page([
            form({ title: 'Frei', status: 'active', publishedVersion: 1 }),
            form({
              id: '019fe200-0000-7000-8000-00000000000c',
              title: 'Gedeckelt',
              status: 'active',
              publishedVersion: 1,
              permissions: permissions({ canBuild: false }),
            }),
          ]),
        ),
      );
      renderWithQuery(
        <DashboardView
          tenantName="Dachorganisation"
          tenantCount={2}
          canBuild
          aiFormsAvailable={false}
          onOpenAiForm={() => undefined}
        />,
      );
      await waitFor(() => {
        expect(screen.getByText('Gedeckelt')).toBeDefined();
      });

      const cardOf = (title: string): HTMLElement => {
        const heading = screen.getByRole('heading', { name: title });
        const card = heading.closest('article');
        if (card === null) {
          throw new Error(`No card around "${title}".`);
        }
        return card;
      };

      expect(
        within(cardOf('Frei')).getByRole('button', { name: 'Bearbeiten' }),
      ).toBeDefined();
      expect(
        within(cardOf('Gedeckelt')).queryByRole('button', {
          name: 'Bearbeiten',
        }),
      ).toBeNull();
      // …and the capped card is still a card: „Antworten" stays, so this is
      // about the one control and not about a card that failed to render.
      expect(
        within(cardOf('Gedeckelt')).getByRole('button', { name: 'Antworten' }),
      ).toBeDefined();
      // The create box reads the **Organisation-wide** flag and is untouched by a cap
      // on one form — creating a form is not an act on any form.
      expect(
        screen.getByRole('button', { name: '+ Neues Formular' }),
      ).toBeDefined();
    });

    /** The counter-check — with the right, everything is there. */
    it('offers all of it again with can_build', async () => {
      stubFetch().mockResolvedValue(
        jsonResponse(
          200,
          page([
            form({ status: 'active', publishedVersion: 1, responseCount: 3 }),
          ]),
        ),
      );
      renderWithQuery(
        <DashboardView
          tenantName="Dachorganisation"
          tenantCount={2}
          canBuild
          aiFormsAvailable={false}
          onOpenAiForm={() => undefined}
        />,
      );
      await waitFor(() => {
        expect(screen.getByText('Bestandsmeldung')).toBeDefined();
      });

      expect(
        screen.getByRole('button', { name: '+ Neues Formular' }),
      ).toBeDefined();
      expect(screen.getByRole('button', { name: 'Bearbeiten' })).toBeDefined();
      expect(
        screen.queryByText(/Formulare anlegen ist in dieser Organisation/),
      ).toBeNull();
    });
  });

  /**
   * **The requirement — the dashboard renders a page, not an Organisation.**
   *
   * The suite that replaces „offers no search bar", which asserted the
   * absence this package fills. Every case here is written so that it fails
   * against the *plausible wrong* build rather than against no build at all —
   * see each one for which wrong build it is aimed at.
   */
  describe('page, search and counter', () => {
    /** 60 forms; the term „Sterbefallmeldung" matches exactly one, on page three. */
    const TOTAL = 60;

    function pageOf(offset: number, limit = 24) {
      const items = Array.from(
        { length: Math.max(0, Math.min(limit, TOTAL - offset)) },
        (_unused, index) =>
          form({
            id: `019fe200-0000-7000-8000-${String(offset + index).padStart(12, '0')}`,
            title: `Formular ${String(offset + index).padStart(2, '0')}`,
          }),
      );
      return {
        items,
        total: TOTAL,
        activeTotal: 7,
        responseTotal: 123,
        limit,
        offset,
      };
    }

    /**
     * A server that pages **and** searches — the two behaviours the view is
     * measured against, in one stub, reading the query string the view sent.
     *
     * Reading `?q=` rather than ignoring it is what makes the search cases
     * meaningful: a view that filtered on the client would send no `q`, get
     * the unfiltered page back, and find nothing — which is precisely the
     * failure most likely to slip through unnoticed.
     */
    function stubPagedForms() {
      return stubFetch().mockImplementation((input) => {
        const url = new URL(requestPath(input), 'https://test.invalid');
        const term = url.searchParams.get('q') ?? '';
        const offset = Number(url.searchParams.get('offset') ?? '0');
        if (term !== '') {
          const hit = form({
            id: '019fe200-0000-7000-8000-0000000000ff',
            title: 'Sterbefallmeldung',
          });
          const matches = 'Sterbefallmeldung'
            .toLowerCase()
            .includes(term.toLowerCase())
            ? [hit]
            : [];
          return Promise.resolve(
            jsonResponse(200, {
              items: matches,
              total: matches.length,
              activeTotal: 0,
              responseTotal: 0,
              limit: 24,
              offset: 0,
            }),
          );
        }
        return Promise.resolve(jsonResponse(200, pageOf(offset)));
      });
    }

    /**
     * „Ein Web-Test mit einer Antwort über zwei Seiten zeigt die
     * Blätterbedienung und lädt nach."
     *
     * Both halves are asserted: the control is **there**, and pressing it
     * **fetches** the next offset and shows what came back. A test that only
     * looked for the button would stay green for a pager that is drawn and
     * dead.
     */
    it('shows the pager and loads the next page when it is pressed', async () => {
      const fetchMock = stubPagedForms();
      renderWithQuery(
        <DashboardView
          tenantName="Dachorganisation"
          tenantCount={1}
          canBuild
          aiFormsAvailable={false}
          onOpenAiForm={() => undefined}
        />,
      );
      await waitFor(() => {
        expect(screen.getByText('Formular 00')).toBeDefined();
      });

      expect(screen.getByText('Seite 1 von 3')).toBeDefined();
      // Page one holds nothing of page two.
      expect(screen.queryByText('Formular 24')).toBeNull();

      fireEvent.click(
        screen.getByRole('button', {
          name: 'Nächste Seite der Formularliste',
        }),
      );

      await waitFor(() => {
        expect(screen.getByText('Formular 24')).toBeDefined();
      });
      expect(screen.getByText('Seite 2 von 3')).toBeDefined();
      // The request actually carried the offset — the view did not slice a
      // list it already had.
      expect(
        fetchMock.mock.calls.some(([input]) =>
          requestPath(input).includes('offset=24'),
        ),
      ).toBe(true);
    });

    it('walks back with „Zurück", and the first page has no way further back', async () => {
      stubPagedForms();
      renderWithQuery(
        <DashboardView
          tenantName="Dachorganisation"
          tenantCount={1}
          canBuild
          aiFormsAvailable={false}
          onOpenAiForm={() => undefined}
        />,
      );
      await waitFor(() => {
        expect(screen.getByText('Seite 1 von 3')).toBeDefined();
      });

      const back = screen.getByRole('button', {
        name: 'Vorherige Seite der Formularliste',
      });
      expect(back.hasAttribute('disabled')).toBe(true);

      fireEvent.click(
        screen.getByRole('button', {
          name: 'Nächste Seite der Formularliste',
        }),
      );
      await waitFor(() => {
        expect(screen.getByText('Seite 2 von 3')).toBeDefined();
      });

      fireEvent.click(
        screen.getByRole('button', {
          name: 'Vorherige Seite der Formularliste',
        }),
      );
      await waitFor(() => {
        expect(screen.getByText('Formular 00')).toBeDefined();
      });
      expect(screen.getByText('Seite 1 von 3')).toBeDefined();
    });

    /**
     * **The search takes effect server-side.**
     *
     * The hit („Sterbefallmeldung") is deliberately **not on the loaded page**: the
     * stub only ever returns it in answer to a request carrying `?q=`. So a
     * client-side filter finds nothing and this case is red — which is the
     * reproduction the requirement names, made unavoidable by the fixture rather
     * than promised in a comment.
     */
    it('finds a form that the loaded page does not hold', async () => {
      const fetchMock = stubPagedForms();
      renderWithQuery(
        <DashboardView
          tenantName="Dachorganisation"
          tenantCount={1}
          canBuild
          aiFormsAvailable={false}
          onOpenAiForm={() => undefined}
        />,
      );
      await waitFor(() => {
        expect(screen.getByText('Formular 00')).toBeDefined();
      });
      expect(screen.queryByText('Sterbefallmeldung')).toBeNull();

      fireEvent.change(screen.getByLabelText('Formulare durchsuchen'), {
        target: { value: 'Sterbefallmeldung' },
      });

      await waitFor(() => {
        expect(screen.getByText('Sterbefallmeldung')).toBeDefined();
      });
      // …and it went to the server as a query parameter.
      expect(
        fetchMock.mock.calls.some(([input]) =>
          requestPath(input).includes('q=Sterbefallmeldung'),
        ),
      ).toBe(true);
    });

    it('says how many matched, and offers a way back to everything', async () => {
      stubPagedForms();
      renderWithQuery(
        <DashboardView
          tenantName="Dachorganisation"
          tenantCount={1}
          canBuild
          aiFormsAvailable={false}
          onOpenAiForm={() => undefined}
        />,
      );
      await waitFor(() => {
        expect(screen.getByText('Formular 00')).toBeDefined();
      });

      fireEvent.change(screen.getByLabelText('Formulare durchsuchen'), {
        target: { value: 'Sterbefallmeldung' },
      });
      await waitFor(() => {
        expect(
          screen.getByText('1 Treffer für „Sterbefallmeldung"'),
        ).toBeDefined();
      });
      // One hit is one page — the pager is gone rather than showing „1 von 1".
      expect(
        screen.queryByRole('button', {
          name: 'Nächste Seite der Formularliste',
        }),
      ).toBeNull();

      fireEvent.click(
        screen.getByRole('button', { name: 'Suche zurücksetzen' }),
      );
      await waitFor(() => {
        expect(screen.getByText('Formular 00')).toBeDefined();
      });
    });

    it('says the term found nothing, not that the organisation is empty', async () => {
      stubPagedForms();
      renderWithQuery(
        <DashboardView
          tenantName="Dachorganisation"
          tenantCount={1}
          canBuild
          aiFormsAvailable={false}
          onOpenAiForm={() => undefined}
        />,
      );
      await waitFor(() => {
        expect(screen.getByText('Formular 00')).toBeDefined();
      });

      fireEvent.change(screen.getByLabelText('Formulare durchsuchen'), {
        target: { value: 'gibtesnicht' },
      });

      await waitFor(() => {
        expect(screen.getByText(/Kein Formular passt zur Suche/)).toBeDefined();
      });
      // The other empty state would be a lie about the organisation.
      expect(screen.queryByText(/Noch keine Formulare vorhanden/)).toBeNull();
    });

    /**
     * **The counter names the total, not the loaded number.**
     *
     * The numbers are chosen so that no reading off the page can produce them
     * by accident: 60 forms against a page of 24, seven active against a page
     * of drafts, 123 answers against cards that each report zero. A view that
     * counted its own cards would say 24 / 0 / 0.
     */
    it('counts the whole list in the tiles, not the loaded page', async () => {
      stubPagedForms();
      renderWithQuery(
        <DashboardView
          tenantName="Dachorganisation"
          tenantCount={1}
          canBuild
          aiFormsAvailable={false}
          onOpenAiForm={() => undefined}
        />,
      );

      await waitFor(() => {
        expect(kpiValue('Formulare')).toBe('60');
      });
      expect(screen.getAllByRole('article')).toHaveLength(24);
      expect(kpiValue('Aktiv')).toBe('7');
      expect(kpiValue('Antworten gesamt')).toBe('123');
    });

    /**
     * **Regression, review finding of this package.** `useFormPage` keeps the
     * previous page on screen while the next one loads, so between a new term
     * and its answer the `total` in hand belongs to the **old** query — and the
     * counter is a `role="status"` live region, so it did not merely show the
     * stale number, it announced it.
     */
    it('says nothing about a term whose answer has not arrived yet', async () => {
      let releaseSearch: ((value: Response) => void) | undefined;
      stubFetch().mockImplementation((input) => {
        const url = new URL(requestPath(input), 'https://test.invalid');
        if ((url.searchParams.get('q') ?? '') !== '') {
          // Held open on purpose: this is the window the finding is about.
          return new Promise<Response>((resolve) => {
            releaseSearch = resolve;
          });
        }
        return Promise.resolve(jsonResponse(200, pageOf(0)));
      });

      renderWithQuery(
        <DashboardView
          tenantName="Dachorganisation"
          tenantCount={1}
          canBuild
          aiFormsAvailable={false}
          onOpenAiForm={() => undefined}
        />,
      );
      await waitFor(() => {
        expect(screen.getByText('Formular 00')).toBeDefined();
      });

      fireEvent.change(screen.getByLabelText('Formulare durchsuchen'), {
        target: { value: 'Sterbefallmeldung' },
      });

      // The request is out and unanswered — and nothing claims a number.
      await waitFor(() => {
        expect(releaseSearch).toBeDefined();
      });
      expect(screen.queryByText(/Treffer für/)).toBeNull();
      // …specifically not the previous page's 60, which is what it used to say.
      expect(screen.queryByText(/60 Treffer/)).toBeNull();

      releaseSearch?.(
        jsonResponse(200, {
          items: [],
          total: 0,
          activeTotal: 0,
          responseTotal: 0,
          limit: 24,
          offset: 0,
        }),
      );
      await waitFor(() => {
        expect(
          screen.getByText('0 Treffer für „Sterbefallmeldung"'),
        ).toBeDefined();
      });
    });

    /**
     * **Regression, review finding of this package.** A browser blurs a control
     * it disables, so „Weiter" pressed onto the last page dropped focus to
     * `<body>` and the next Tab restarted at the top of the document — the
     * „focus that falls into nothing" this file already guards against for a
     * deleted card.
     */
    it('keeps focus somewhere when the pressed pager button disables itself', async () => {
      stubPagedForms();
      renderWithQuery(
        <DashboardView
          tenantName="Dachorganisation"
          tenantCount={1}
          canBuild
          aiFormsAvailable={false}
          onOpenAiForm={() => undefined}
        />,
      );
      await waitFor(() => {
        expect(screen.getByText('Seite 1 von 3')).toBeDefined();
      });

      const next = screen.getByRole('button', {
        name: 'Nächste Seite der Formularliste',
      });
      fireEvent.click(next);
      await waitFor(() => {
        expect(screen.getByText('Seite 2 von 3')).toBeDefined();
      });
      // Page two of three — „Weiter" is still live, focus is nobody's problem.
      fireEvent.click(
        screen.getByRole('button', {
          name: 'Nächste Seite der Formularliste',
        }),
      );
      await waitFor(() => {
        expect(screen.getByText('Seite 3 von 3')).toBeDefined();
      });

      expect(
        screen
          .getByRole('button', { name: 'Nächste Seite der Formularliste' })
          .hasAttribute('disabled'),
      ).toBe(true);
      // The landing place, not `<body>`.
      expect(document.activeElement).toBe(screen.getByText('Seite 3 von 3'));
    });

    /** A single page needs no pager — and must not draw two dead buttons. */
    it('draws no pager when everything fits on one page', async () => {
      stubFetch().mockResolvedValue(jsonResponse(200, page([form()])));
      renderWithQuery(
        <DashboardView
          tenantName="Dachorganisation"
          tenantCount={1}
          canBuild
          aiFormsAvailable={false}
          onOpenAiForm={() => undefined}
        />,
      );
      await waitFor(() => {
        expect(screen.getByText('Bestandsmeldung')).toBeDefined();
      });

      expect(
        screen.queryByRole('button', {
          name: 'Nächste Seite der Formularliste',
        }),
      ).toBeNull();
    });
  });

  /**
   * „× Löschen" — into the trash, reversibly. Every
   * trap the work order names for this control has a case here: the
   * confirmation says „Papierkorb" and not „endgültig", the request only
   * fires once confirmed, and the focus a removed card leaves behind is
   * measured, not claimed.
   *
   * **`['trash']` actually being invalidated is not asserted here.**
   * `queryClient.invalidateQueries` only *refetches* an **active** query by
   * default, and no `useTrash()` consumer is mounted in a `DashboardView`-only
   * tree — so a network assertion against `/api/trash` in this file would
   * prove nothing (or worse, pass for the wrong reason if the request never
   * needed to fire here at all). The genuine round trip — delete on the
   * Dashboard, the row shows up in the trash, restore it, it is back —
   * is `e2e/dashboard-delete.spec.ts`, which mounts both views for real by
   * navigating between them.
   */
  describe('× Löschen', () => {
    function cardOf(title: string): HTMLElement {
      const heading = screen.getByRole('heading', { name: title });
      const card = heading.closest('article');
      if (card === null) {
        throw new Error(`No card around "${title}".`);
      }
      return card;
    }

    /** A `GET /api/forms` that stops listing the form once it was deleted. */
    function stubDeletableForm() {
      let deleted = false;
      const fetchMock = stubFetch().mockImplementation((input, init) => {
        const url = requestPath(input);
        const method = init?.method ?? 'GET';
        if (method === 'DELETE' && url.endsWith(`/api/forms/${form().id}`)) {
          deleted = true;
          return Promise.resolve(jsonResponse(204, undefined));
        }
        return Promise.resolve(
          jsonResponse(200, page(deleted ? [] : [form()])),
        );
      });
      return fetchMock;
    }

    it('asks first, in words that say this is reversible — not endgültig', async () => {
      const fetchMock = stubDeletableForm();
      renderWithQuery(
        <DashboardView
          tenantName="Dachorganisation"
          tenantCount={1}
          canBuild
          aiFormsAvailable={false}
          onOpenAiForm={() => undefined}
        />,
      );
      await waitFor(() => {
        expect(screen.getByText('Bestandsmeldung')).toBeDefined();
      });

      const card = cardOf('Bestandsmeldung');
      const callsBefore = fetchMock.mock.calls.length;
      fireEvent.click(within(card).getByRole('button', { name: 'Löschen' }));

      const question = within(card).getByRole('alert');
      expect(question.textContent).toContain('Papierkorb');
      expect(question.textContent).toContain('30 Tage');
      expect(question.textContent).not.toContain('endgültig');
      // Nothing was sent while only asking.
      expect(fetchMock.mock.calls.length).toBe(callsBefore);
    });

    it('cancelling leaves the card exactly where it was, unsent', async () => {
      const fetchMock = stubDeletableForm();
      renderWithQuery(
        <DashboardView
          tenantName="Dachorganisation"
          tenantCount={1}
          canBuild
          aiFormsAvailable={false}
          onOpenAiForm={() => undefined}
        />,
      );
      await waitFor(() => {
        expect(screen.getByText('Bestandsmeldung')).toBeDefined();
      });

      const card = cardOf('Bestandsmeldung');
      const callsBefore = fetchMock.mock.calls.length;
      fireEvent.click(within(card).getByRole('button', { name: 'Löschen' }));
      fireEvent.click(within(card).getByRole('button', { name: 'Abbrechen' }));

      expect(screen.getByText('Bestandsmeldung')).toBeDefined();
      expect(fetchMock.mock.calls.length).toBe(callsBefore);
    });

    it('moves the form into the Papierkorb after confirming — the card leaves the grid', async () => {
      const fetchMock = stubDeletableForm();
      renderWithQuery(
        <DashboardView
          tenantName="Dachorganisation"
          tenantCount={1}
          canBuild
          aiFormsAvailable={false}
          onOpenAiForm={() => undefined}
        />,
      );
      await waitFor(() => {
        expect(screen.getByText('Bestandsmeldung')).toBeDefined();
      });

      const card = cardOf('Bestandsmeldung');
      fireEvent.click(within(card).getByRole('button', { name: 'Löschen' }));
      fireEvent.click(
        within(card).getByRole('button', { name: 'In den Papierkorb legen' }),
      );

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          `/api/forms/${form().id}`,
          expect.objectContaining({ method: 'DELETE' }),
        );
      });
      await waitFor(() => {
        expect(screen.queryByText('Bestandsmeldung')).toBeNull();
      });
    });

    /**
     * **The trap named in the work order.** The card that carried the
     * pressed button is gone after the refetch — the same „focus falls into
     * nothing" shape the trash already had to fix once.
     */
    it('moves focus to the page heading once the card leaves the grid', async () => {
      stubDeletableForm();
      renderWithQuery(
        <DashboardView
          tenantName="Dachorganisation"
          tenantCount={1}
          canBuild
          aiFormsAvailable={false}
          onOpenAiForm={() => undefined}
        />,
      );
      await waitFor(() => {
        expect(screen.getByText('Bestandsmeldung')).toBeDefined();
      });

      const card = cardOf('Bestandsmeldung');
      fireEvent.click(within(card).getByRole('button', { name: 'Löschen' }));
      fireEvent.click(
        within(card).getByRole('button', { name: 'In den Papierkorb legen' }),
      );

      await waitFor(() => {
        expect(screen.queryByText('Bestandsmeldung')).toBeNull();
      });
      const heading = screen.getByRole('heading', {
        name: 'Dashboard',
        level: 1,
      });
      expect(document.activeElement).toBe(heading);
      expect(document.activeElement).not.toBe(document.body);
    });

    it('shows the server’s own refusal and leaves the card in place', async () => {
      stubFetch().mockImplementation((input, init) => {
        const url = requestPath(input);
        if (
          (init?.method ?? 'GET') === 'DELETE' &&
          url.endsWith(`/api/forms/${form().id}`)
        ) {
          return Promise.resolve(
            jsonResponse(403, {
              message: 'Diese Rolle darf dieses Formular nicht löschen.',
            }),
          );
        }
        return Promise.resolve(jsonResponse(200, page([form()])));
      });
      renderWithQuery(
        <DashboardView
          tenantName="Dachorganisation"
          tenantCount={1}
          canBuild
          aiFormsAvailable={false}
          onOpenAiForm={() => undefined}
        />,
      );
      await waitFor(() => {
        expect(screen.getByText('Bestandsmeldung')).toBeDefined();
      });

      const card = cardOf('Bestandsmeldung');
      fireEvent.click(within(card).getByRole('button', { name: 'Löschen' }));
      fireEvent.click(
        within(card).getByRole('button', { name: 'In den Papierkorb legen' }),
      );

      await waitFor(() => {
        expect(within(card).getByRole('alert').textContent).toContain('nicht');
      });
      expect(screen.getByText('Bestandsmeldung')).toBeDefined();
    });

    it('is absent without can_build, alongside „Bearbeiten"', async () => {
      stubFetch().mockResolvedValue(
        jsonResponse(
          200,
          page([form({ permissions: permissions({ canBuild: false }) })]),
        ),
      );
      renderWithQuery(
        <DashboardView
          tenantName="Dachorganisation"
          tenantCount={1}
          canBuild={false}
          aiFormsAvailable={false}
          onOpenAiForm={() => undefined}
        />,
      );
      await waitFor(() => {
        expect(screen.getByText('Bestandsmeldung')).toBeDefined();
      });

      const card = cardOf('Bestandsmeldung');
      expect(
        within(card).queryByRole('button', { name: 'Löschen' }),
      ).toBeNull();
    });
  });

  /**
   * „⧉ Duplizieren" — unlike „× Löschen" it fires straight
   * from the click, no confirmation: a duplicate adds a card, it does not
   * take one away.
   */
  describe('⧉ Duplizieren', () => {
    function cardOf(title: string): HTMLElement {
      const heading = screen.getByRole('heading', { name: title });
      const card = heading.closest('article');
      if (card === null) {
        throw new Error(`No card around "${title}".`);
      }
      return card;
    }

    const COPY_ID = '019fe200-0000-7000-8000-0000000000d0';

    function duplicateResponseBody(): unknown {
      return {
        ...form({ id: COPY_ID, title: 'Bestandsmeldung (Kopie)' }),
        definition: {
          pages: [
            {
              id: '019fe200-0000-7000-8000-0000000000e0',
              title: 'Seite 1',
              questions: [],
            },
          ],
        },
        revision: 1,
        publicSlug: 'kopie-slug',
        hasUnpublishedChanges: true,
      };
    }

    /** A `GET /api/forms` that starts listing the copy once it exists. */
    function stubDuplicableForm() {
      let duplicated = false;
      const fetchMock = stubFetch().mockImplementation((input, init) => {
        const url = requestPath(input);
        const method = init?.method ?? 'GET';
        if (
          method === 'POST' &&
          url.endsWith(`/api/forms/${form().id}/duplicate`)
        ) {
          duplicated = true;
          return Promise.resolve(jsonResponse(201, duplicateResponseBody()));
        }
        return Promise.resolve(
          jsonResponse(
            200,
            page(
              duplicated
                ? [
                    form(),
                    form({ id: COPY_ID, title: 'Bestandsmeldung (Kopie)' }),
                  ]
                : [form()],
            ),
          ),
        );
      });
      return fetchMock;
    }

    it('sends the request on a click, no confirmation asked', async () => {
      const fetchMock = stubDuplicableForm();
      renderWithQuery(
        <DashboardView
          tenantName="Dachorganisation"
          tenantCount={1}
          canBuild
          aiFormsAvailable={false}
          onOpenAiForm={() => undefined}
        />,
      );
      await waitFor(() => {
        expect(screen.getByText('Bestandsmeldung')).toBeDefined();
      });

      const card = cardOf('Bestandsmeldung');
      fireEvent.click(
        within(card).getByRole('button', { name: 'Duplizieren' }),
      );

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          `/api/forms/${form().id}/duplicate`,
          expect.objectContaining({ method: 'POST' }),
        );
      });
    });

    it('shows the copy as its own card once the server answers', async () => {
      stubDuplicableForm();
      renderWithQuery(
        <DashboardView
          tenantName="Dachorganisation"
          tenantCount={1}
          canBuild
          aiFormsAvailable={false}
          onOpenAiForm={() => undefined}
        />,
      );
      await waitFor(() => {
        expect(screen.getByText('Bestandsmeldung')).toBeDefined();
      });

      fireEvent.click(
        within(cardOf('Bestandsmeldung')).getByRole('button', {
          name: 'Duplizieren',
        }),
      );

      await waitFor(() => {
        expect(screen.getByText('Bestandsmeldung (Kopie)')).toBeDefined();
      });
      // The original is still there — duplicating adds a card, it does not
      // replace one.
      expect(screen.getByText('Bestandsmeldung')).toBeDefined();
    });

    it('shows the server’s own refusal and leaves the card in place', async () => {
      stubFetch().mockImplementation((input, init) => {
        const url = requestPath(input);
        if (
          (init?.method ?? 'GET') === 'POST' &&
          url.endsWith(`/api/forms/${form().id}/duplicate`)
        ) {
          return Promise.resolve(
            jsonResponse(403, {
              message: 'Diese Rolle darf Formulare nicht duplizieren.',
            }),
          );
        }
        return Promise.resolve(jsonResponse(200, page([form()])));
      });
      renderWithQuery(
        <DashboardView
          tenantName="Dachorganisation"
          tenantCount={1}
          canBuild
          aiFormsAvailable={false}
          onOpenAiForm={() => undefined}
        />,
      );
      await waitFor(() => {
        expect(screen.getByText('Bestandsmeldung')).toBeDefined();
      });

      const card = cardOf('Bestandsmeldung');
      fireEvent.click(
        within(card).getByRole('button', { name: 'Duplizieren' }),
      );

      await waitFor(() => {
        expect(within(card).getByRole('alert').textContent).toContain('nicht');
      });
      expect(screen.getByText('Bestandsmeldung')).toBeDefined();
    });

    it('is absent without can_build, alongside „Bearbeiten" and „× Löschen"', async () => {
      stubFetch().mockResolvedValue(
        jsonResponse(
          200,
          page([form({ permissions: permissions({ canBuild: false }) })]),
        ),
      );
      renderWithQuery(
        <DashboardView
          tenantName="Dachorganisation"
          tenantCount={1}
          canBuild={false}
          aiFormsAvailable={false}
          onOpenAiForm={() => undefined}
        />,
      );
      await waitFor(() => {
        expect(screen.getByText('Bestandsmeldung')).toBeDefined();
      });

      const card = cardOf('Bestandsmeldung');
      expect(
        within(card).queryByRole('button', { name: 'Duplizieren' }),
      ).toBeNull();
    });
  });
});

/**
 * **„✦ KI-Formular" next to „+ Neues Formular"** (finding 18).
 *
 * The button stood as the last entry of the header navigation and was the only one
 * there that did not navigate. It creates a form — and now stands next to
 * the button that does the same. The counter-check on the header stands in
 * `shell/AppShell.test.tsx`.
 */
describe('das Dashboard und „✦ KI-Formular" (Befund 18)', () => {
  it('bietet ihn neben „+ Neues Formular" an und öffnet den Dialog', async () => {
    stubFetch().mockResolvedValue(jsonResponse(200, page([])));
    const onOpenAiForm = vi.fn();
    renderWithQuery(
      <DashboardView
        tenantName="Dachorganisation"
        tenantCount={1}
        canBuild
        aiFormsAvailable
        onOpenAiForm={onOpenAiForm}
      />,
    );

    const create = await screen.findByRole('button', {
      name: '+ Neues Formular',
    });
    const ai = screen.getByRole('button', { name: /KI-Formular/ });
    // In the same row, not somewhere on the page: „daneben" is the
    // whole statement of the finding.
    expect(ai.parentElement).toBe(create.parentElement);

    fireEvent.click(ai);
    expect(onOpenAiForm).toHaveBeenCalledTimes(1);
  });

  /**
   * **Absent, not greyed out.** Without a key the route answers 404,
   * and a grey button would promise a feature that does not exist.
   */
  it('fehlt ganz, wo die Installation keinen Schlüssel hat', async () => {
    stubFetch().mockResolvedValue(jsonResponse(200, page([])));
    renderWithQuery(
      <DashboardView
        tenantName="Dachorganisation"
        tenantCount={1}
        canBuild
        aiFormsAvailable={false}
        onOpenAiForm={() => undefined}
      />,
    );

    await screen.findByRole('button', { name: '+ Neues Formular' });
    expect(screen.queryByRole('button', { name: /KI-Formular/ })).toBeNull();
    expect(
      screen
        .getAllByRole('button')
        .some((button) => button.textContent.includes('KI-Formular')),
    ).toBe(false);
  });

  /**
   * Without `canBuild` the whole box does not exist — and therefore neither does this
   * button. Two questions, two conditions: „gibt es die Funktion?" and
   * „darf diese Person bauen?".
   */
  it('fehlt für eine Rolle, die nicht bauen darf — Schlüssel hin oder her', async () => {
    stubFetch().mockResolvedValue(jsonResponse(200, page([])));
    renderWithQuery(
      <DashboardView
        tenantName="Dachorganisation"
        tenantCount={1}
        canBuild={false}
        aiFormsAvailable
        onOpenAiForm={() => undefined}
      />,
    );

    await screen.findByText(/Formulare anlegen ist in dieser Organisation/u);
    expect(screen.queryByRole('button', { name: /KI-Formular/ })).toBeNull();
  });

  /**
   * Without an Organisation the box does not exist either: the form that is
   * created belongs to one, and without a scope every
   * organisation-bound request answers 403.
   */
  it('fehlt ohne aktive Organisation', () => {
    renderWithQuery(
      <DashboardView
        tenantCount={2}
        canBuild
        aiFormsAvailable
        onOpenAiForm={() => undefined}
      />,
    );

    expect(screen.queryByRole('button', { name: /KI-Formular/ })).toBeNull();
  });
});
