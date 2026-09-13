import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { jsonResponse, stubFetch } from '../test/fetch-mock';
import { renderWithQuery } from '../test/render-with-query';
import { SuperadminView } from './SuperadminView';

/**
 * Superadmin overview.
 *
 * What a screenshot cannot show and this file pins down instead: „Wechseln"
 * and „Verwalten" both re-scope the session before they navigate anywhere
 * (the requirement — the tenant administration names no organisation in its address), a
 * 403 says so rather than looking like an empty installation, and „+ Neuer
 * Tenant" never lets the request carry a form-standards field the schema has
 * no room for.
 */

const TENANT_A = '00000000-0000-4000-8000-0000000000a1';
const TENANT_B = '00000000-0000-4000-8000-0000000000b2';

function tenantRow(overrides: Record<string, unknown> = {}) {
  return {
    tenant: {
      id: TENANT_A,
      shortName: 'DACH',
      name: 'Dachorganisation',
      logoRef: null,
      branding: {
        accent: '#cea967',
        headerBg: '#212226',
        canvasBg: '#e9e6df',
        stripe: ['#212226', '#7c0800', '#cea967'],
        wideLogo: true,
      },
    },
    forms: 4,
    responses: 12,
    users: 6,
    oidcEnabled: false,
    // Deliberately **not** `DEFAULT_AI_MONTHLY_CALL_LIMIT`: with
    // the default in the fixture, "the field shows the value of this
    // organisation" would also pass green for a section that writes the default
    // down and does not read the server's answer at all.
    aiMonthlyCallLimit: 7,
    ...overrides,
  };
}

/**
 * The totals are deliberately **not** the sums of the rows.
 *
 * `GET /admin/tenants` counts across the whole installation; the table shows
 * the same Organisationen but says nothing about how many rows a page may be showing.
 * With `totals` equal to the row sums, a KPI tile that added the visible rows up
 * in the browser would pass the same assertions — which is exactly what the
 * earlier fixture did, and what this comment exists to prevent coming back.
 */
function overviewDocument(overrides: Record<string, unknown> = {}) {
  return {
    tenants: [
      tenantRow(),
      tenantRow({
        tenant: {
          id: TENANT_B,
          shortName: 'Musterstadt',
          name: 'Ortsgruppe Musterstadt',
          logoRef: null,
          branding: {
            accent: '#e30000',
            headerBg: '#131313',
            canvasBg: '#e9e6df',
            stripe: ['#e30000', '#cad0d3', '#131313'],
            wideLogo: false,
          },
        },
        forms: 2,
        responses: 5,
        users: 3,
        oidcEnabled: true,
        aiMonthlyCallLimit: 0,
      }),
    ],
    // Rows: 2 Organisationen, 6 forms, 17 responses, 9 users — the totals say otherwise.
    totals: { tenants: 3, forms: 9, responses: 21, users: 14 },
    ...overrides,
  };
}

/** A session that is a member of both organisations, so the actions are offered. */
function sessionDocument(memberOf: readonly string[] = [TENANT_A, TENANT_B]) {
  return {
    id: '00000000-0000-4000-8000-0000000000f1',
    email: 'super@example.org',
    name: 'Sina Superadmin',
    isSuperadmin: true,
    // Ever since `aiFormsAvailable` became mandatory on the wire, the
    // route always sends this field; a document without it would describe a
    // response that does not exist.
    aiFormsAvailable: false,
    memberships: memberOf.map((id) => ({
      tenant:
        id === TENANT_A
          ? tenantRow().tenant
          : {
              id: TENANT_B,
              shortName: 'Musterstadt',
              name: 'Ortsgruppe Musterstadt',
              logoRef: null,
              branding: {
                accent: '#e30000',
                headerBg: '#131313',
                canvasBg: '#e9e6df',
                stripe: ['#e30000', '#cad0d3', '#131313'],
                wideLogo: false,
              },
            },
      group: {
        id: '00000000-0000-4000-8000-0000000000d1',
        name: 'admin',
        color: '#7c0800',
        rank: 100,
        isSystem: true,
      },
      permissions: {
        canBuild: true,
        canViewResponses: true,
        canExport: true,
        canManageSettings: true,
        canManageFormSettings: true,
        canManageUsers: true,
      },
    })),
    activeTenantId: TENANT_A,
  };
}

function pathOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * The number next to a KPI tile's label — robust against duplicate digits.
 *
 * **Narrowed to the tile row** (finding 16): the word „Organisationen"
 * has stood several times on this page since the merge — as a tab, in the
 * scope badge „Alle Organisationen", in the heading of the tab. The
 * narrowing says that the *tile* is meant here, and not that the
 * others happen to be called something else right now.
 */
function kpiValue(label: string): string | null {
  const tiles = document.querySelector('.superadmin__kpis');
  if (tiles === null) {
    throw new Error('Die KPI-Kacheln sind nicht auf dem Bildschirm.');
  }
  return (
    within(tiles as HTMLElement).getByText(label).previousElementSibling
      ?.textContent ?? null
  );
}

/**
 * An organisation name **in the table**.
 *
 * Ever since „KI-Kontingent je Organisation"  stands under the table,
 * every living organisation carries its name twice on this page: once as a
 * table cell, once as the label of its number field. An
 * unqualified `screen.getByText(name)` is thereby ambiguous — and it was
 * imprecise even before, because in every one of these cases the table was meant.
 */
function tenantCell(name: string): HTMLElement {
  return within(screen.getByRole('table')).getByText(name);
}

function queryTenantCell(name: string): HTMLElement | null {
  const table = screen.queryByRole('table');
  return table === null ? null : within(table).queryByText(name);
}

/** The table row of an organisation — with `<tr>`, not just the cell. */
function tenantTableRow(name: string): HTMLElement {
  const row = tenantCell(name).closest('tr');
  if (row === null) {
    throw new Error(`Die Tabellenzeile von „${name}“ wurde nicht gefunden.`);
  }
  return row;
}

/**
 * Routes by path: the page reads the overview **and** the session (the latter
 * decides which rows may offer „Wechseln"/„Verwalten"), and both are `GET`.
 *
 * **`/admin/tenants/deleted` is matched before the plain overview fallback**,
 * and by method too — the plain fallback used to answer every unmatched
 * request with the overview document, `GET /admin/tenants/deleted` included,
 * which is the wrong shape for `deletedTenantListSchema` and made every
 * existing test's `DeletedTenantsSection` fail its parse silently in the
 * background. An empty list is the default now, matched exactly.
 */
interface OverviewFixture {
  readonly tenants: readonly { readonly tenant: { readonly id: string } }[];
  readonly [key: string]: unknown;
}

interface DeletedTenantsFixture {
  readonly tenants: readonly {
    readonly tenant: { readonly id: string } & Record<string, unknown>;
    readonly [key: string]: unknown;
  }[];
}

function routeFetch(
  options: {
    readonly overview?: OverviewFixture;
    readonly memberOf?: readonly string[];
    readonly onSwitch?: () => Response;
    readonly deletedTenants?: DeletedTenantsFixture;
    /** Answers `DELETE /admin/tenants/:id` — defaults to 204. */
    readonly onDeleteTenant?: () => Response;
    /** Answers `POST /admin/tenants/:id/restore` — defaults to 204. */
    readonly onRestoreTenant?: () => Response;
    /** Answers `PUT /admin/tenants/:id/ai-quota` — defaults to 204. */
    readonly onSetAiQuota?: () => Response;
    /**
     * What stands in the column after a successful write, derived from the
     * number that was sent. Default: the same number.
     */
    readonly quotaEcho?: (sent: number) => number;
  } = {},
) {
  const overview = options.overview ?? overviewDocument();
  const deletedTenants: DeletedTenantsFixture = options.deletedTenants ?? {
    tenants: [],
  };
  // A successful `DELETE`/`restore` moves an id between the two lists on the
  // **next** `GET` of each — the same "the mock's next read reflects the
  // write" shape `TrashView.test.tsx`'s `routeFetch` and
  // `DashboardView.test.tsx`'s `stubDeletableForm` use. Both directions
  // matter here: `useDeleteTenant`/`useRestoreTenant` invalidate the same
  // parent key (`TENANT_OVERVIEW_QUERY_KEY`), which is a prefix of both.
  const deletedIds = new Set<string>();
  const restoredIds = new Set<string>();
  /**
   * What a successful `PUT …/ai-quota` leaves behind in the column — the
   * next `GET` of the overview carries it. A mock that returned the
   * number unchanged after the write would let an interface pass
   * that does not fetch the success at all.
   */
  const setQuotas = new Map<string, number>();

  return stubFetch().mockImplementation((input, init) => {
    const url = pathOf(input);
    const method = init?.method ?? 'GET';

    if (method === 'PUT' && url.endsWith('/ai-quota')) {
      const response = options.onSetAiQuota?.() ?? jsonResponse(204, undefined);
      if (response.ok) {
        const id = url.split('/').slice(-2, -1)[0];
        const sent = init?.body;
        const body: unknown =
          typeof sent === 'string' ? JSON.parse(sent) : undefined;
        const limit =
          typeof body === 'object' &&
          body !== null &&
          'monthlyCallLimit' in body
            ? body.monthlyCallLimit
            : undefined;
        if (id !== undefined && typeof limit === 'number') {
          setQuotas.set(id, options.quotaEcho?.(limit) ?? limit);
        }
      }
      return Promise.resolve(response);
    }
    if (method === 'PUT' && url.endsWith('/session/tenant')) {
      return Promise.resolve(
        options.onSwitch === undefined
          ? jsonResponse(200, {
              ...sessionDocument(options.memberOf),
              activeTenantId: TENANT_B,
            })
          : options.onSwitch(),
      );
    }
    if (url.endsWith('/auth/me')) {
      return Promise.resolve(
        jsonResponse(200, sessionDocument(options.memberOf)),
      );
    }
    if (method === 'GET' && url.endsWith('/admin/tenants/deleted')) {
      return Promise.resolve(
        jsonResponse(200, {
          tenants: deletedTenants.tenants.filter(
            (row) => !restoredIds.has(row.tenant.id),
          ),
        }),
      );
    }
    if (method === 'DELETE' && /\/admin\/tenants\/[^/]+$/.test(url)) {
      const response =
        options.onDeleteTenant?.() ?? jsonResponse(204, undefined);
      if (response.ok) {
        const id = url.split('/').pop();
        if (id !== undefined) {
          deletedIds.add(id);
        }
      }
      return Promise.resolve(response);
    }
    if (method === 'POST' && url.endsWith('/restore')) {
      const response =
        options.onRestoreTenant?.() ?? jsonResponse(204, undefined);
      if (response.ok) {
        const id = url.split('/').slice(-2, -1)[0];
        if (id !== undefined) {
          restoredIds.add(id);
        }
      }
      return Promise.resolve(response);
    }
    if (method === 'GET' && url.endsWith('/admin/tenants')) {
      return Promise.resolve(
        jsonResponse(200, {
          ...overview,
          tenants: overview.tenants
            .filter((row) => !deletedIds.has(row.tenant.id))
            .map((row) => {
              const limit = setQuotas.get(row.tenant.id);
              return limit === undefined
                ? row
                : { ...row, aiMonthlyCallLimit: limit };
            }),
        }),
      );
    }
    return Promise.resolve(jsonResponse(200, overview));
  });
}

async function renderLoaded(
  document = overviewDocument(),
  activeTenantId: string | null = TENANT_A,
) {
  const fetchMock = routeFetch({ overview: document });
  renderWithQuery(<SuperadminView activeTenantId={activeTenantId} />);
  await waitFor(() => {
    expect(
      screen.getByRole('heading', {
        name: 'Organisationen dieser Installation',
        level: 2,
      }),
    ).toBeDefined();
  });
  return fetchMock;
}

describe('the superadmin overview', () => {
  /**
   * **The badge „Alle Tenants" no longer stands here** (finding 16): the
   * overview is a tab of the system administration, and its frame says
   * once whom the whole page applies to („Alle Organisationen",
   * `SystemAdminView.test.tsx`). The same scope twice on one
   * screen does not say it twice, it makes it incidental.
   */
  it('leaves the scope badge to its frame', async () => {
    await renderLoaded();

    expect(screen.queryByText('Alle Tenants')).toBeNull();
  });

  /** The server's `totals`, not the sum of the rows on screen — see the fixture. */
  it('shows the KPI tiles from the totals the server sent', async () => {
    await renderLoaded();

    expect(kpiValue('Organisationen')).toBe('3');
    expect(kpiValue('Formulare gesamt')).toBe('9');
    expect(kpiValue('Antworten gesamt')).toBe('21');
    expect(kpiValue('Nutzer gesamt')).toBe('14');
  });

  it('lists every organisation with its counters and login state', async () => {
    await renderLoaded();

    expect(tenantCell('Dachorganisation')).toBeDefined();
    expect(tenantCell('Ortsgruppe Musterstadt')).toBeDefined();
    expect(screen.getByText('nur lokal')).toBeDefined();
    expect(screen.getByText('OIDC aktiv')).toBeDefined();
  });

  it('marks the active Organisation and disables switching to it', async () => {
    await renderLoaded();

    const activeButton = screen.getByRole('button', { name: '✓ Aktiv' });
    expect(activeButton.hasAttribute('disabled')).toBe(true);
    expect(screen.getAllByText('aktiv')).toHaveLength(1);
  });

  it('says so when the session is not a superadmin one', async () => {
    stubFetch().mockResolvedValue(jsonResponse(403, { message: 'nope' }));
    renderWithQuery(<SuperadminView activeTenantId={null} />);

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(
        'Superadmins vorbehalten',
      );
    });
  });

  /**
   * The requirement: „Wechseln" re-scopes the session via
   * `PUT /session/tenant` — not a client-side flag — and only then leaves the
   * page.
   */
  it('re-scopes the session before leaving on „Wechseln"', async () => {
    const fetchMock = routeFetch();
    // Started away from „/" on purpose: `DASHBOARD_PATH` *is* „/", so landing
    // there is only observable if the page did not already start out there —
    // otherwise a build that never navigates at all would pass the same
    // assertion (the trap this comment exists to name).
    window.history.pushState({}, '', '/admin/superadmin');
    renderWithQuery(<SuperadminView activeTenantId={TENANT_A} />);
    await waitFor(() => {
      expect(tenantCell('Ortsgruppe Musterstadt')).toBeDefined();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Wechseln' }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([, init]) =>
            init?.method === 'PUT' &&
            init.body === '{"tenantId":"00000000-0000-4000-8000-0000000000b2"}',
        ),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(window.location.pathname).toBe('/');
    });
  });

  /**
   * The requirement: „Verwalten" is the same re-scoping, and it says so before
   * anyone discovers it by ending up in the wrong organisation's settings — the
   * tenant administration names no organisation in its own address.
   */
  it('re-scopes the session and opens the Organisations-Verwaltung on „Verwalten"', async () => {
    const fetchMock = routeFetch();
    renderWithQuery(<SuperadminView activeTenantId={TENANT_A} />);
    await waitFor(() => {
      expect(tenantCell('Ortsgruppe Musterstadt')).toBeDefined();
    });

    fireEvent.click(
      screen.getAllByRole('button', { name: 'Verwalten' })[1] ??
        (() => {
          throw new Error('Verwalten button for the second row not found.');
        })(),
    );

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT'),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(window.location.pathname).toBe('/admin/appearance');
    });
  });

  /**
   * The requirement: the superadmin flag opens `GET /admin/tenants`, it is
   * **not** a general key. `PUT /session/tenant` answers 404 for an organisation the
   * person is not a member of, so „Wechseln"/„Verwalten" on every row promised
   * something the server refuses — and the row then advised „bitte erneut
   * versuchen", which no amount of retrying can fix. The memberships come from
   * the session, the same source the header's Organisation switcher lives on.
   */
  it('offers „Wechseln"/„Verwalten" only for an organisation the session may enter', async () => {
    routeFetch({ memberOf: [TENANT_A] });
    renderWithQuery(<SuperadminView activeTenantId={TENANT_A} />);

    await waitFor(() => {
      expect(tenantCell('Ortsgruppe Musterstadt')).toBeDefined();
    });
    // The row without a membership says why, instead of showing a button.
    await waitFor(() => {
      expect(
        screen.getByText('Kein Mitglied in dieser Organisation'),
      ).toBeDefined();
    });

    const foreignRow = tenantTableRow('Ortsgruppe Musterstadt');
    expect(
      within(foreignRow).queryByRole('button', { name: 'Wechseln' }),
    ).toBeNull();
    expect(
      within(foreignRow).queryByRole('button', { name: 'Verwalten' }),
    ).toBeNull();
    // „Löschen" needs no membership — offered regardless.
    expect(
      within(foreignRow).getByRole('button', { name: 'Löschen' }),
    ).not.toBeNull();

    // The organisation this session belongs to keeps both actions.
    const ownRow = tenantTableRow('Dachorganisation');
    expect(
      within(ownRow).getByRole('button', { name: 'Verwalten' }),
    ).toBeDefined();
  });

  it('names the refusal when a switch is answered with 404', async () => {
    routeFetch({
      onSwitch: () => jsonResponse(404, { message: 'not found' }),
    });
    renderWithQuery(<SuperadminView activeTenantId={TENANT_A} />);

    await waitFor(() => {
      expect(tenantCell('Ortsgruppe Musterstadt')).toBeDefined();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Wechseln' }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('kein Mitglied');
    });
  });

  it('explains, up front, that „Verwalten" switches the active Organisation', async () => {
    await renderLoaded();

    expect(
      screen.getAllByTitle(
        'Wechselt die aktive Organisation und öffnet die Organisations-Verwaltung',
      ),
    ).not.toHaveLength(0);
  });

  describe('„+ Neue Organisation"', () => {
    it('opens the create panel and never sends a form-standards field', async () => {
      const fetchMock = await renderLoaded();

      fireEvent.click(
        screen.getByRole('button', { name: '+ Neue Organisation' }),
      );
      fireEvent.change(screen.getByLabelText('Kurzname'), {
        target: { value: 'Nordwind' },
      });
      fireEvent.change(screen.getByLabelText('Name'), {
        target: { value: 'Nordwind Musterstadt' },
      });
      fireEvent.change(screen.getByLabelText('E-Mail des ersten Admins'), {
        target: { value: 'admin@nordwind.example' },
      });
      fireEvent.change(screen.getByLabelText('Name des ersten Admins'), {
        target: { value: 'Anna Admin' },
      });
      fireEvent.click(
        screen.getByRole('button', { name: 'Organisation anlegen' }),
      );

      await waitFor(() => {
        expect(
          fetchMock.mock.calls.some(([, init]) => init?.method === 'POST'),
        ).toBe(true);
      });
      const write = fetchMock.mock.calls.find(
        ([, init]) => init?.method === 'POST',
      );
      const body = write?.[1]?.body;
      if (typeof body !== 'string') {
        throw new Error('The POST carried no JSON body.');
      }
      const parsed: unknown = JSON.parse(body);
      expect(parsed).toEqual({
        shortName: 'Nordwind',
        name: 'Nordwind Musterstadt',
        // No password (ADR-0024): the first administrator gets an
        // invitation and sets it themselves.
        admin: {
          email: 'admin@nordwind.example',
          name: 'Anna Admin',
        },
      });
    });

    it('names a taken Kurzname or e-mail after a 409, without inventing wording', async () => {
      stubFetch().mockImplementation((_input, init) => {
        if (init?.method === 'POST') {
          return Promise.resolve(
            jsonResponse(409, {
              message: 'Diesen Kurznamen gibt es in dieser Installation schon.',
            }),
          );
        }
        return Promise.resolve(jsonResponse(200, overviewDocument()));
      });
      renderWithQuery(<SuperadminView activeTenantId={TENANT_A} />);
      await waitFor(() => {
        expect(
          screen.getByRole('heading', {
            name: 'Organisationen dieser Installation',
            level: 2,
          }),
        ).toBeDefined();
      });

      fireEvent.click(
        screen.getByRole('button', { name: '+ Neue Organisation' }),
      );
      fireEvent.change(screen.getByLabelText('Kurzname'), {
        target: { value: 'Dachorganisation' },
      });
      fireEvent.change(screen.getByLabelText('Name'), {
        target: { value: 'Doppelt' },
      });
      fireEvent.change(screen.getByLabelText('E-Mail des ersten Admins'), {
        target: { value: 'a@example.org' },
      });
      fireEvent.change(screen.getByLabelText('Name des ersten Admins'), {
        target: { value: 'A' },
      });
      fireEvent.click(
        screen.getByRole('button', { name: 'Organisation anlegen' }),
      );

      await waitFor(() => {
        expect(
          screen.getByText(
            'Diesen Kurznamen gibt es in dieser Installation schon.',
          ),
        ).toBeDefined();
      });
      // The panel stays open — a refused create must not lose what was typed.
      expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe(
        'Doppelt',
      );
    });

    it('mentions that the new Organisation keeps following the shipped defaults', async () => {
      await renderLoaded();

      fireEvent.click(
        screen.getByRole('button', { name: '+ Neue Organisation' }),
      );

      expect(
        screen.getByText(/folgt weiter der Vorgabe der Anwendung/),
      ).toBeDefined();
    });

    /**
     * Regression.
     *
     * Creating an organisation with one's own address as the first admin *is* the
     * membership — and memberships live in
     * `GET /auth/me`, not in the overview. While `useCreateTenant` invalidated
     * the overview alone, the fresh row came back reading „Kein Mitglied in
     * dieser Organisation" and offered neither action until a reload: the decided way
     * into a new Organisation looked like a failure at the moment it succeeded.
     *
     * Both server answers therefore change with the create here — the overview
     * gains the row, the session gains the membership — so the assertion is
     * about the *client* fetching the session again, not about a fixture.
     */
    it('offers the new Organisation right away, without a reload', async () => {
      let created = false;
      stubFetch().mockImplementation((input, init) => {
        const url = pathOf(input);
        if (init?.method === 'POST' && url.endsWith('/admin/tenants')) {
          created = true;
          return Promise.resolve(
            jsonResponse(201, overviewDocument().tenants[1] ?? tenantRow()),
          );
        }
        if (url.endsWith('/auth/me')) {
          return Promise.resolve(
            jsonResponse(
              200,
              sessionDocument(created ? [TENANT_A, TENANT_B] : [TENANT_A]),
            ),
          );
        }
        return Promise.resolve(
          jsonResponse(
            200,
            created
              ? overviewDocument()
              : { ...overviewDocument(), tenants: [tenantRow()] },
          ),
        );
      });
      renderWithQuery(<SuperadminView activeTenantId={TENANT_A} />);
      await waitFor(() => {
        expect(
          screen.getByRole('heading', {
            name: 'Organisationen dieser Installation',
            level: 2,
          }),
        ).toBeDefined();
      });
      expect(queryTenantCell('Ortsgruppe Musterstadt')).toBeNull();

      fireEvent.click(
        screen.getByRole('button', { name: '+ Neue Organisation' }),
      );
      fireEvent.change(screen.getByLabelText('Kurzname'), {
        target: { value: 'Musterstadt' },
      });
      fireEvent.change(screen.getByLabelText('Name'), {
        target: { value: 'Ortsgruppe Musterstadt' },
      });
      fireEvent.change(screen.getByLabelText('E-Mail des ersten Admins'), {
        // The own address — that is what makes this way (c).
        target: { value: 'super@example.org' },
      });
      fireEvent.change(screen.getByLabelText('Name des ersten Admins'), {
        target: { value: 'Sina Superadmin' },
      });
      fireEvent.click(
        screen.getByRole('button', { name: 'Organisation anlegen' }),
      );

      await waitFor(() => {
        expect(tenantCell('Ortsgruppe Musterstadt')).toBeDefined();
      });

      const newRow = tenantTableRow('Ortsgruppe Musterstadt');
      await waitFor(() => {
        expect(
          within(newRow).getByRole('button', { name: 'Verwalten' }),
        ).toBeDefined();
      });
      expect(
        within(newRow).getByRole('button', { name: 'Wechseln' }),
      ).toBeDefined();
      expect(
        within(newRow).queryByText('Kein Mitglied in dieser Organisation'),
      ).toBeNull();
    });
  });
});

/**
 * **„KI-Kontingent je Organisation"** (concept no. 7 and no. 86).
 *
 * The section itself is measured in `superadmin/AiQuotaSection.test.tsx` —
 * here stand the two assertions that are only visible *in the interplay with the
 * overview*: that the section hangs on the page at all and
 * draws its numbers from `GET /admin/tenants`, and that a successful
 * save reloads the freshly set value of the server instead of leaving the typed
 * draft standing.
 */
describe('das KI-Kontingent je Organisation', () => {
  it('zeigt je Organisation den Wert aus der Übersicht — auch die 0', async () => {
    await renderLoaded();

    expect(
      screen.getByLabelText<HTMLInputElement>('Dachorganisation').value,
    ).toBe('7');
    // „0" is a value and not an empty field — the expensive misreading of this
    // surface starts exactly here.
    expect(
      screen.getByLabelText<HTMLInputElement>('Ortsgruppe Musterstadt').value,
    ).toBe('0');
  });

  /**
   * The proof that `useSetAiQuota` really invalidates the overview.
   *
   * **The mock answers the next `GET` with a different number from the
   * typed one** (444 instead of 300) — otherwise the assertion would be worthless: a
   * local draft left standing would look exactly like a reloaded
   * server value. Red, then, for every version that does not fetch the success.
   */
  it('lädt nach dem Speichern den Wert des Servers nach, nicht den getippten', async () => {
    // The server "corrects" every written number to 444. Freely invented
    // and usable for exactly that reason: 444 can reach the field from no
    // other source than from the reloaded `GET /admin/tenants`.
    routeFetch({ quotaEcho: () => 444 });
    renderWithQuery(<SuperadminView activeTenantId={TENANT_A} />);
    await waitFor(() => {
      expect(screen.getByLabelText('Dachorganisation')).toBeDefined();
    });

    const field = screen.getByLabelText<HTMLInputElement>('Dachorganisation');
    fireEvent.change(field, { target: { value: '300' } });
    const row = field.closest('form');
    if (row === null) {
      throw new Error(
        'Die Kontingent-Zeile der Organisation wurde nicht gefunden.',
      );
    }
    fireEvent.click(within(row).getByRole('button', { name: /Speichern/ }));

    await waitFor(() => {
      expect(
        screen.getByLabelText<HTMLInputElement>('Dachorganisation').value,
      ).toBe('444');
    });
    // …and not the draft that stood in the field when the button was pressed.
    expect(
      screen.getByLabelText<HTMLInputElement>('Dachorganisation').value,
    ).not.toBe('300');
  });
});

/**
 * „Gelöschte Organisationen" and „Löschen" on a live row (Konzept no. 59 and 64). Its own `describe` — the section it exercises is a
 * sibling of the table this file's other tests cover, not a variant of it.
 */
describe('Gelöschte Organisationen und das Löschen einer Organisation', () => {
  it('lists a deleted Organisation and offers no logo for it', async () => {
    routeFetch({
      deletedTenants: {
        tenants: [
          {
            tenant: {
              id: TENANT_B,
              shortName: 'Musterstadt',
              name: 'Ortsgruppe Musterstadt',
              // An `upload` reference — the shape whose public address 404s
              // for a deleted tenant (security review finding). This is
              // exactly the payload `TenantMark` would
              // turn into a broken `<img>`.
              logoRef: { kind: 'upload', ref: 'ab'.repeat(11) },
              branding: {
                accent: '#e30000',
                headerBg: '#131313',
                canvasBg: '#e9e6df',
                stripe: ['#e30000', '#cad0d3', '#131313'],
                wideLogo: false,
              },
            },
            deletedAt: '2026-07-15T10:00:00.000Z',
          },
        ],
      },
    });
    renderWithQuery(<SuperadminView activeTenantId={TENANT_A} />);

    const row = await screen.findByTestId('superadmin-deleted-tenant');
    expect(within(row).getByText('Ortsgruppe Musterstadt')).toBeDefined();
    expect(screen.getByTestId('superadmin-deleted-count').textContent).toBe(
      '1',
    );
    // No broken logo — `DeletedTenantsSection` renders no `<img>` at all.
    expect(screen.queryByTestId('tenant-logo')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('says „keine gelöschten Organisationen" when the section is empty', async () => {
    routeFetch();
    renderWithQuery(<SuperadminView activeTenantId={TENANT_A} />);

    await screen.findByText('Keine gelöschten Organisationen.');
    expect(screen.getByTestId('superadmin-deleted-count').textContent).toBe(
      '0',
    );
  });

  it('stellt eine gelöschte Organisation wieder her, and moves focus to its own heading', async () => {
    routeFetch({
      deletedTenants: {
        tenants: [
          {
            tenant: {
              id: TENANT_B,
              shortName: 'Musterstadt',
              name: 'Ortsgruppe Musterstadt',
              logoRef: null,
              branding: {
                accent: '#e30000',
                headerBg: '#131313',
                canvasBg: '#e9e6df',
                stripe: ['#e30000', '#cad0d3', '#131313'],
                wideLogo: false,
              },
            },
            deletedAt: '2026-07-15T10:00:00.000Z',
          },
        ],
      },
    });
    renderWithQuery(<SuperadminView activeTenantId={TENANT_A} />);

    await waitFor(() => {
      expect(screen.getByTestId('superadmin-deleted-tenant')).toBeDefined();
    });
    fireEvent.click(screen.getByRole('button', { name: /Wiederherstellen/ }));

    await waitFor(() => {
      expect(
        screen.getByText('Keine gelöschten Organisationen.'),
      ).toBeDefined();
    });
    // The trap named in the work order — measured, not claimed. The section's
    // own `<h2>` survives an empty list (unlike the row it stood next to).
    const heading = screen.getByRole('heading', {
      name: 'Gelöschte Organisationen',
    });
    expect(document.activeElement).toBe(heading);
    expect(document.activeElement).not.toBe(document.body);
  });

  it('asks for the organisation’s name before löschen, without offering a smaller confirmation', async () => {
    const fetchMock = routeFetch();
    renderWithQuery(<SuperadminView activeTenantId={TENANT_A} />);
    await waitFor(() => {
      expect(tenantCell('Dachorganisation')).toBeDefined();
    });

    const row = tenantTableRow('Dachorganisation');
    const callsBefore = fetchMock.mock.calls.length;
    fireEvent.click(within(row).getByRole('button', { name: 'Löschen' }));

    // The typed-name field — Konzept no. 59's confirmation, not `ConfirmPrompt`'s
    // click-to-confirm (a text hurdle belongs to deleting an
    // *Organisation*, nowhere else touches it).
    const nameField = screen.getByLabelText(
      'Name der Organisation zur Bestätigung',
    );
    expect(nameField).toBeDefined();
    const confirmButton = screen.getByRole('button', {
      name: 'Organisation löschen',
    });
    expect((confirmButton as HTMLButtonElement).disabled).toBe(true);
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });

  /**
   * Review finding 8. The most destructive confirmation in this application
   * used to say „Alle Formulare, Antworten und Mitgliedschaften bleiben dabei
   * erhalten" — true of the 30-day window, silent about both its ends.
   */
  it('names the immediate lockout and the physical deletion after 30 days', async () => {
    routeFetch();
    renderWithQuery(<SuperadminView activeTenantId={TENANT_A} />);
    await waitFor(() => {
      expect(tenantCell('Dachorganisation')).toBeDefined();
    });

    const row = tenantTableRow('Dachorganisation');
    fireEvent.click(within(row).getByRole('button', { name: 'Löschen' }));

    const question = screen
      .getByLabelText('Name der Organisation zur Bestätigung')
      .closest('div[role="alert"]');
    if (question === null) {
      throw new Error('The delete confirmation was not found.');
    }
    // Immediate effect  …
    expect(question.textContent).toContain('sofort');
    expect(question.textContent).toContain('ausgesperrt');
    // … and the final destruction after the deadline, accounts included.
    expect(question.textContent).toContain('30 Tage');
    expect(question.textContent).toContain('endgültig gelöscht');
    expect(question.textContent).toContain('Konten');
    // The old promise, which concealed the loss, no longer stands there.
    expect(question.textContent).not.toContain('bleiben dabei erhalten');
  });

  it('shows the server’s own 409 when the typed name does not match, and sends nothing final', async () => {
    const fetchMock = routeFetch({
      onDeleteTenant: () =>
        jsonResponse(409, {
          message:
            'Der eingegebene Name stimmt nicht mit dem Namen dieser Organisation überein.',
        }),
    });
    renderWithQuery(<SuperadminView activeTenantId={TENANT_A} />);
    await waitFor(() => {
      expect(tenantCell('Dachorganisation')).toBeDefined();
    });

    const row = tenantTableRow('Dachorganisation');
    fireEvent.click(within(row).getByRole('button', { name: 'Löschen' }));
    fireEvent.change(
      screen.getByLabelText('Name der Organisation zur Bestätigung'),
      {
        target: { value: 'Falscher Name' },
      },
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Organisation löschen' }),
    );

    await waitFor(() => {
      expect(screen.getByText(/stimmt nicht mit dem Namen/)).toBeDefined();
    });
    // The row is still in the live table — a refusal removed nothing.
    expect(tenantCell('Dachorganisation')).toBeDefined();
    // …and the comparison was the server's: nothing here pre-checked the
    // typed value against `tenant.name` and refused client-side.
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/admin/tenants/${TENANT_A}`),
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  /**
   * The client half of the evidence (review finding 1).
   *
   * „Löschen" is on **every** row, the one marked „✓ Aktiv" included, and the
   * server does not refuse it. Deleting the organisation the session is scoped to
   * withdraws the membership that scope rests on — so the client has to read
   * `GET /auth/me` again, or the header, the logo, the organisation switcher and
   * every permission on screen keep describing an organisation this session no longer
   * has. `useDeleteTenant` invalidated only the overview.
   *
   * **The refused attempt is the control.** Counting the session reads after a
   * successful delete alone would also pass for a client that refetches
   * `/auth/me` on every click; the 409 first pins that the read follows the
   * *loss*, not the interaction.
   */
  it('liest die Sitzung neu, sobald die aktive Organisation gelöscht ist — und nicht, wenn das Löschen scheitert', async () => {
    let deleted = false;
    const fetchMock = stubFetch().mockImplementation((input, init) => {
      const url = pathOf(input);
      const method = init?.method ?? 'GET';

      if (method === 'DELETE' && /\/admin\/tenants\/[^/]+$/.test(url)) {
        // `requestVoid` sends the body as a JSON string (`api/http.ts`), so
        // this reads what actually travelled rather than the object behind it.
        const sent = init?.body;
        const body: unknown =
          typeof sent === 'string' ? JSON.parse(sent) : undefined;
        const confirmName =
          typeof body === 'object' && body !== null && 'confirmName' in body
            ? body.confirmName
            : undefined;
        if (confirmName !== 'Dachorganisation') {
          return Promise.resolve(
            jsonResponse(409, {
              message:
                'Der eingegebene Name stimmt nicht mit dem Namen dieser Organisation überein.',
            }),
          );
        }
        deleted = true;
        return Promise.resolve(jsonResponse(204, undefined));
      }
      if (url.endsWith('/auth/me')) {
        // After the delete the membership in the active Organisation is gone, and with
        // it the session's scope — the payload the server would then send.
        return Promise.resolve(
          jsonResponse(200, {
            ...sessionDocument(deleted ? [TENANT_B] : [TENANT_A, TENANT_B]),
            ...(deleted ? { activeTenantId: null } : {}),
          }),
        );
      }
      if (method === 'GET' && url.endsWith('/admin/tenants/deleted')) {
        return Promise.resolve(jsonResponse(200, { tenants: [] }));
      }
      return Promise.resolve(
        jsonResponse(200, {
          ...overviewDocument(),
          tenants: deleted
            ? overviewDocument().tenants.filter(
                (row) => row.tenant.id !== TENANT_A,
              )
            : overviewDocument().tenants,
        }),
      );
    });
    const sessionReads = (): number =>
      fetchMock.mock.calls.filter(([callInput]) =>
        pathOf(callInput).endsWith('/auth/me'),
      ).length;

    renderWithQuery(<SuperadminView activeTenantId={TENANT_A} />);
    await waitFor(() => {
      expect(tenantCell('Dachorganisation')).toBeDefined();
    });
    await waitFor(() => {
      expect(sessionReads()).toBeGreaterThan(0);
    });

    const row = tenantTableRow('Dachorganisation');
    // The row under test is the **active** one — the whole point of the case.
    expect(within(row).getByRole('button', { name: '✓ Aktiv' })).toBeDefined();

    fireEvent.click(within(row).getByRole('button', { name: 'Löschen' }));
    const nameField = screen.getByLabelText(
      'Name der Organisation zur Bestätigung',
    );

    const readsBeforeRefusal = sessionReads();
    fireEvent.change(nameField, { target: { value: 'Falscher Name' } });
    fireEvent.click(
      screen.getByRole('button', { name: 'Organisation löschen' }),
    );
    await waitFor(() => {
      expect(screen.getByText(/stimmt nicht mit dem Namen/)).toBeDefined();
    });
    // Nothing was lost, so nothing is re-read.
    expect(sessionReads()).toBe(readsBeforeRefusal);

    fireEvent.change(nameField, {
      target: { value: 'Dachorganisation' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Organisation löschen' }),
    );

    await waitFor(() => {
      expect(queryTenantCell('Dachorganisation')).toBeNull();
    });
    // …and now it is: the session behind this screen is read again.
    await waitFor(() => {
      expect(sessionReads()).toBeGreaterThan(readsBeforeRefusal);
    });
  });

  it('löscht die Organisation after a matching confirmation, and moves focus to the page heading', async () => {
    const fetchMock = routeFetch();
    renderWithQuery(<SuperadminView activeTenantId={TENANT_A} />);
    await waitFor(() => {
      expect(tenantCell('Dachorganisation')).toBeDefined();
    });

    const row = tenantTableRow('Dachorganisation');
    fireEvent.click(within(row).getByRole('button', { name: 'Löschen' }));
    fireEvent.change(
      screen.getByLabelText('Name der Organisation zur Bestätigung'),
      {
        target: { value: 'Dachorganisation' },
      },
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Organisation löschen' }),
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(`/admin/tenants/${TENANT_A}`),
        expect.objectContaining({
          method: 'DELETE',
          body: JSON.stringify({
            confirmName: 'Dachorganisation',
          }),
        }),
      );
    });
    // The trap named in the work order: the deleted row is gone, and focus
    // has to land somewhere real rather than on `<body>`.
    await waitFor(() => {
      expect(queryTenantCell('Dachorganisation')).toBeNull();
    });
    const heading = screen.getByRole('heading', {
      name: 'Organisationen dieser Installation',
      level: 2,
    });
    expect(document.activeElement).toBe(heading);
    expect(document.activeElement).not.toBe(document.body);
  });
});
