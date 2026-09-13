import type { ReactElement } from 'react';
import { useState } from 'react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { deferred } from '../test/deferred';
import { emptyResponse, jsonResponse, stubFetch } from '../test/fetch-mock';
import { permissions } from '../test/fixtures';
import { renderWithQuery } from '../test/render-with-query';
import { DashboardView } from './DashboardView';
import { FormMembersView } from './FormMembersView';

/**
 * Nutzerrechte je Formular.
 *
 * What a screenshot cannot show and this file pins down instead:
 * administrators get a label, not a greyed-out control, an entry made while a
 * row's save is on its way is not lost to the answer (one row
 * at a time rather than one document), and „Keine Einschränkung" is written as
 * the row the server reads it back from — not a second route.
 */

const FORM_ID = '00000000-0000-4000-8000-0000000000f0';
/** A second form, for the „ein Entwurf überlebt den Formularwechsel"-case. */
const OTHER_FORM_ID = '00000000-0000-4000-8000-0000000000f1';
const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const ADMIN_ID = '00000000-0000-4000-8000-0000000000a1';
const SELF_ID = '00000000-0000-4000-8000-0000000000e1';
const VIEWER_ID = '00000000-0000-4000-8000-0000000000e2';
const CAPPED_ID = '00000000-0000-4000-8000-0000000000e3';

const ADMIN_GROUP = {
  id: '00000000-0000-4000-8000-0000000000c1',
  name: 'admin',
  color: '#7c0800',
  rank: 100,
  isSystem: true,
};
const EDITOR_GROUP = {
  id: '00000000-0000-4000-8000-0000000000c2',
  name: 'editor',
  color: '#8a6a12',
  rank: 60,
  isSystem: false,
};
const VIEWER_GROUP = {
  id: '00000000-0000-4000-8000-0000000000c3',
  name: 'viewer',
  color: '#5b6b52',
  rank: 20,
  isSystem: false,
};

function adminMember() {
  return {
    userId: ADMIN_ID,
    name: 'Alexandra Admin',
    email: 'admin@example.org',
    group: ADMIN_GROUP,
    restrictable: false,
    accessRevoked: false,
    cappedGroupId: null,
  };
}

function selfMember(overrides: Record<string, unknown> = {}) {
  return {
    userId: SELF_ID,
    name: 'Erik Editor',
    email: 'erik@example.org',
    group: EDITOR_GROUP,
    restrictable: true,
    accessRevoked: false,
    cappedGroupId: null,
    ...overrides,
  };
}

function viewerMember(overrides: Record<string, unknown> = {}) {
  return {
    userId: VIEWER_ID,
    name: 'Vera Viewer',
    email: 'vera@example.org',
    group: VIEWER_GROUP,
    restrictable: true,
    accessRevoked: true,
    cappedGroupId: null,
    ...overrides,
  };
}

/**
 * An editor who is capped down to „viewer" **on this form**.
 *
 * The fixture is what makes the legend test measure something: with them, the
 * counts (admin 1, editor 1, viewer 2) differ from the counts by Organisation role
 * (admin 1, editor 2, viewer 1), so a legend that forgot the cap is red rather
 * than accidentally right.
 */
function cappedMember(overrides: Record<string, unknown> = {}) {
  return {
    userId: CAPPED_ID,
    name: 'Carla Capped',
    email: 'carla@example.org',
    group: EDITOR_GROUP,
    restrictable: true,
    accessRevoked: false,
    cappedGroupId: VIEWER_GROUP.id,
    ...overrides,
  };
}

function membersDocument(overrides: Record<string, unknown> = {}) {
  return {
    members: [adminMember(), selfMember(), viewerMember(), cappedMember()],
    groups: [ADMIN_GROUP, EDITOR_GROUP, VIEWER_GROUP],
    ...overrides,
  };
}

function groupsDocument() {
  return {
    groups: [
      {
        ...ADMIN_GROUP,
        permissions: {
          canBuild: true,
          canViewResponses: true,
          canExport: true,
          canManageSettings: true,
          canManageFormSettings: true,
          canManageUsers: true,
        },
        memberCount: 1,
      },
      {
        ...EDITOR_GROUP,
        permissions: {
          canBuild: true,
          canViewResponses: true,
          canExport: false,
          canManageSettings: false,
          canManageFormSettings: false,
          canManageUsers: false,
        },
        memberCount: 1,
      },
      {
        ...VIEWER_GROUP,
        permissions: {
          canBuild: false,
          canViewResponses: true,
          canExport: false,
          canManageSettings: false,
          canManageFormSettings: false,
          canManageUsers: false,
        },
        memberCount: 1,
      },
    ],
  };
}

function sessionDocument() {
  return {
    id: SELF_ID,
    email: 'erik@example.org',
    name: 'Erik Editor',
    isSuperadmin: false,
    // The route always sends this field; a document without it would describe a
    // response that does not exist.
    aiFormsAvailable: false,
    memberships: [
      {
        tenant: {
          id: TENANT_ID,
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
        group: EDITOR_GROUP,
        permissions: {
          canBuild: true,
          canViewResponses: true,
          canExport: false,
          canManageSettings: false,
          canManageFormSettings: false,
          canManageUsers: true,
        },
      },
    ],
    activeTenantId: TENANT_ID,
  };
}

function pathOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function bodyOf(init: RequestInit | undefined): unknown {
  return typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
}

/**
 * Dispatches by path, because the four queries of this page all use `GET` —
 * `init?.method` alone cannot tell them apart.
 */
function routeFetch(
  members: unknown,
  groups: unknown = groupsDocument(),
  putHandler?: (body: unknown) => { status: number; body: unknown },
) {
  return stubFetch().mockImplementation((input, init) => {
    const url = pathOf(input);
    if (init?.method === 'PUT' && url.includes(`/forms/${FORM_ID}/members/`)) {
      if (putHandler === undefined) {
        return Promise.resolve(jsonResponse(200, membersDocument()));
      }
      const { status, body: responseBody } = putHandler(bodyOf(init));
      return Promise.resolve(jsonResponse(status, responseBody));
    }
    if (url.endsWith(`/forms/${FORM_ID}/members`)) {
      return Promise.resolve(jsonResponse(200, members));
    }
    if (url.endsWith('/tenant/groups')) {
      return Promise.resolve(jsonResponse(200, groups));
    }
    if (url.endsWith('/auth/me')) {
      return Promise.resolve(jsonResponse(200, sessionDocument()));
    }
    if (url.endsWith(`/forms/${FORM_ID}`)) {
      // The form's title is a nice-to-have this page reads from `useForm` and
      // tolerates missing (`CONTRIBUTING.md`'s own pattern, applied to a query
      // this view does not own) — a 404 here must not block the page.
      return Promise.resolve(emptyResponse(404));
    }
    return Promise.resolve(emptyResponse(404));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

async function renderLoaded(members: unknown = membersDocument()) {
  const fetchMock = routeFetch(members);
  renderWithQuery(<FormMembersView formId={FORM_ID} />);
  await waitFor(() => {
    expect(screen.getByRole('heading', { name: 'Nutzerrechte' })).toBeDefined();
  });
  return fetchMock;
}

describe('Nutzerrechte je Formular', () => {
  it('gives an administrator a label, not a control', async () => {
    await renderLoaded();

    const row = screen.getByText('Alexandra Admin').closest('li');
    if (row === null) {
      throw new Error('The admin row was not found.');
    }
    expect(within(row).getByText('Sieht immer alles')).toBeDefined();
    expect(within(row).queryByRole('switch')).toBeNull();
    expect(within(row).queryByRole('combobox')).toBeNull();
  });

  it('offers a switch and a role cap for a restrictable person', async () => {
    await renderLoaded();

    const row = screen.getByText('Vera Viewer').closest('li');
    if (row === null) {
      throw new Error('The viewer row was not found.');
    }
    expect(within(row).getByRole('switch')).toBeDefined();
    expect(within(row).getByRole('combobox')).toBeDefined();
  });

  /**
   * the evidence, structural half made visible: the cap selector
   * offers only roles *below* the person's own — never their own role, never
   * one above it.
   */
  it('offers only roles below the person’s own as a cap', async () => {
    await renderLoaded();

    const row = screen.getByText('Erik Editor').closest('li');
    if (row === null) {
      throw new Error('The self row was not found.');
    }
    const options = within(row)
      .getByRole('combobox')
      .querySelectorAll('option');
    const labels = Array.from(options).map((option) => option.textContent);

    expect(labels).toContain('Keine Einschränkung');
    expect(labels.some((label) => label.includes('viewer'))).toBe(true);
    expect(labels.some((label) => label.includes('editor'))).toBe(false);
    expect(labels.some((label) => label.includes('admin'))).toBe(false);
    // TypeScript itself pins `HTMLOptionElement.textContent` down to `string`
    // here — this project's DOM lib target, not an assumption of this file.
  });

  /**
   * Counted by the **effective** role, which is only observable when the two
   * differ: Carla is an editor in the organisation and capped to „viewer" here, so a
   * legend that counted Organisation roles would show editor 2 / viewer 1 instead of
   * editor 1 / viewer 2. The earlier version of this test had one person per
   * group and every count at 1 — it stayed green with the cap evaluation
   * deleted.
   */
  it('counts every role in the legend by the role that applies on this form', async () => {
    await renderLoaded();

    const legend = document.querySelector<HTMLElement>('.form-members__legend');
    if (legend === null) {
      throw new Error('The role legend was not found.');
    }
    const countOf = (group: string): string | undefined => {
      const card = within(legend)
        .getByText(group)
        .closest('.form-members__legend-card');
      return (
        card?.querySelector('.form-members__legend-count')?.textContent ??
        undefined
      );
    };

    expect(countOf('admin')).toBe('1');
    // Erik only — Carla is capped down and counts under „viewer".
    expect(countOf('editor')).toBe('1');
    expect(countOf('viewer')).toBe('2');
  });

  it('shows the rights matrix once the organisation’s groups have loaded', async () => {
    await renderLoaded();

    await waitFor(() => {
      expect(screen.getByText('Rechte im Überblick')).toBeDefined();
    });
    expect(screen.getByText('Nutzer verwalten')).toBeDefined();
  });

  it('renders without the matrix when the groups query fails', async () => {
    routeFetch(membersDocument(), { message: 'nope' });
    renderWithQuery(<FormMembersView formId={FORM_ID} />);

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Nutzerrechte' }),
      ).toBeDefined();
    });
    expect(screen.queryByText('Rechte im Überblick')).toBeNull();
  });

  it('says so when the form is unknown or foreign', async () => {
    routeFetch({ message: 'not found' });
    stubFetch().mockResolvedValue(jsonResponse(404, { message: 'nope' }));
    renderWithQuery(<FormMembersView formId={FORM_ID} />);

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('nicht gefunden');
    });
  });

  it('sends the switch and the cap together when saving a row', async () => {
    const fetchMock = routeFetch(membersDocument());
    renderWithQuery(<FormMembersView formId={FORM_ID} />);
    await waitFor(() => {
      expect(screen.getByText('Vera Viewer')).toBeDefined();
    });

    const row = screen.getByText('Vera Viewer').closest('li');
    if (row === null) {
      throw new Error('The viewer row was not found.');
    }
    // Vera starts locked out — unlock them.
    fireEvent.click(within(row).getByRole('switch'));
    fireEvent.click(within(row).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([, init]) =>
            init?.method === 'PUT' &&
            typeof init.body === 'string' &&
            init.body.includes('"accessRevoked":false'),
        ),
      ).toBe(true);
    });
  });

  it('writes „keine Einschränkung" as the document, not a second route', async () => {
    const fetchMock = routeFetch(
      membersDocument({
        members: [
          adminMember(),
          selfMember(),
          viewerMember({
            cappedGroupId: EDITOR_GROUP.id,
            accessRevoked: false,
          }),
        ],
      }),
    );
    renderWithQuery(<FormMembersView formId={FORM_ID} />);
    await waitFor(() => {
      expect(screen.getByText('Vera Viewer')).toBeDefined();
    });

    const row = screen.getByText('Vera Viewer').closest('li');
    if (row === null) {
      throw new Error('The viewer row was not found.');
    }
    fireEvent.change(within(row).getByRole('combobox'), {
      target: { value: '' },
    });
    fireEvent.click(within(row).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => {
      const write = fetchMock.mock.calls.find(
        ([, init]) => init?.method === 'PUT',
      );
      const body = write?.[1]?.body;
      expect(typeof body === 'string' ? JSON.parse(body) : undefined).toEqual({
        accessRevoked: false,
        cappedGroupId: null,
      });
    });
  });

  /**
   * The requirement, applied per row: an edit made **while this row's save is
   * in flight** must survive the answer — the shared `useServerDraft` is what
   * this test is really pinning down, one row at a time instead of one whole
   * document.
   */
  it('keeps a row’s edit made while its save was in flight', async () => {
    const pending = deferred<Response>();
    stubFetch().mockImplementation((input, init) => {
      const url = pathOf(input);
      if (init?.method === 'PUT') {
        return pending.promise;
      }
      if (url.endsWith(`/forms/${FORM_ID}/members`)) {
        return Promise.resolve(jsonResponse(200, membersDocument()));
      }
      if (url.endsWith('/tenant/groups')) {
        return Promise.resolve(jsonResponse(200, groupsDocument()));
      }
      if (url.endsWith('/auth/me')) {
        return Promise.resolve(jsonResponse(200, sessionDocument()));
      }
      return Promise.resolve(emptyResponse(404));
    });
    renderWithQuery(<FormMembersView formId={FORM_ID} />);
    await waitFor(() => {
      expect(screen.getByText('Vera Viewer')).toBeDefined();
    });

    const row = screen.getByText('Vera Viewer').closest('li');
    if (row === null) {
      throw new Error('The viewer row was not found.');
    }
    fireEvent.click(within(row).getByRole('switch'));
    fireEvent.click(within(row).getByRole('button', { name: 'Speichern' }));
    await waitFor(() => {
      expect(within(row).getByText('Wird gespeichert…')).toBeDefined();
    });

    // Locked back out while the save is still on its way.
    fireEvent.click(within(row).getByRole('switch'));

    pending.resolve(
      jsonResponse(
        200,
        membersDocument({
          members: [
            adminMember(),
            selfMember(),
            viewerMember({ accessRevoked: false }),
          ],
        }),
      ),
    );

    await waitFor(() => {
      expect(within(row).queryByText('Wird gespeichert…')).toBeNull();
    });
    // The switch is off again (locked) — the second edit was not thrown away
    // by the answer to the first.
    expect(within(row).getByRole<HTMLInputElement>('switch').checked).toBe(
      false,
    );
  });

  /**
   * The other half of the requirement: a draft belongs to a person **on a
   * form**, and a change of form must drop it.
   *
   * The row is keyed by user id, so it stays mounted across the switch as soon
   * as the other form's list is cached — nothing unmounts, nothing re-seeds,
   * and a draft keyed on the person alone survived into a form it was never
   * typed for. „Speichern" then wrote it there. This test reproduces exactly
   * that situation: form B is loaded first (so it *is* cached), an entry is
   * made on form A, and the page goes back to B.
   */
  it('forgets a row’s draft when the page changes form', async () => {
    stubFetch().mockImplementation((input) => {
      const url = pathOf(input);
      if (url.endsWith(`/forms/${FORM_ID}/members`)) {
        // Form A: Vera is locked out.
        return Promise.resolve(jsonResponse(200, membersDocument()));
      }
      if (url.endsWith(`/forms/${OTHER_FORM_ID}/members`)) {
        // Form B: Vera is locked out here too — so an unlock typed on A is
        // visible as „dirty" if it leaks over.
        return Promise.resolve(jsonResponse(200, membersDocument()));
      }
      if (url.endsWith('/tenant/groups')) {
        return Promise.resolve(jsonResponse(200, groupsDocument()));
      }
      if (url.endsWith('/auth/me')) {
        return Promise.resolve(jsonResponse(200, sessionDocument()));
      }
      return Promise.resolve(emptyResponse(404));
    });

    function FormSwitcher(): ReactElement {
      const [formId, setFormId] = useState(OTHER_FORM_ID);
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setFormId(FORM_ID);
            }}
          >
            zu Formular A
          </button>
          <button
            type="button"
            onClick={() => {
              setFormId(OTHER_FORM_ID);
            }}
          >
            zu Formular B
          </button>
          <FormMembersView formId={formId} />
        </>
      );
    }

    renderWithQuery(<FormSwitcher />);
    // B first, so its list is in the cache and the row survives the way back.
    await waitFor(() => {
      expect(screen.getByText('Vera Viewer')).toBeDefined();
    });

    fireEvent.click(screen.getByRole('button', { name: 'zu Formular A' }));
    await waitFor(() => {
      expect(screen.getByText('Vera Viewer')).toBeDefined();
    });

    const rowOnA = screen.getByText('Vera Viewer').closest('li');
    if (rowOnA === null) {
      throw new Error('The viewer row was not found on form A.');
    }
    // Unlock them on form A, and do not save.
    fireEvent.click(within(rowOnA).getByRole('switch'));
    expect(
      within(rowOnA).getByRole('button', { name: 'Speichern' }),
    ).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'zu Formular B' }));

    const rowOnB = screen.getByText('Vera Viewer').closest('li');
    if (rowOnB === null) {
      throw new Error('The viewer row was not found on form B.');
    }
    // Form B's own document is what shows: still locked, nothing to save.
    expect(within(rowOnB).getByRole<HTMLInputElement>('switch').checked).toBe(
      false,
    );
    expect(
      within(rowOnB).queryByRole('button', { name: 'Speichern' }),
    ).toBeNull();
  });

  it('shows the server’s own refusal, e.g. the self-lockout guard', async () => {
    const fetchMock = routeFetch(membersDocument(), groupsDocument(), () => ({
      status: 409,
      body: {
        message:
          'Sie können sich den Zugriff auf dieses Formular nicht selbst entziehen: Danach könnten Sie diese Seite nicht mehr öffnen.',
      },
    }));
    renderWithQuery(<FormMembersView formId={FORM_ID} />);
    await waitFor(() => {
      expect(screen.getByText('Erik Editor')).toBeDefined();
    });

    const row = screen.getByText('Erik Editor').closest('li');
    if (row === null) {
      throw new Error('The self row was not found.');
    }
    fireEvent.click(within(row).getByRole('switch'));
    fireEvent.click(within(row).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => {
      expect(within(row).getByRole('alert').textContent).toContain(
        'nicht selbst entziehen',
      );
    });
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT'),
    ).toBe(true);
  });

  it('jumps to the Tenant-Nutzerverwaltung from the banner', async () => {
    await renderLoaded();

    fireEvent.click(
      screen.getByRole('button', { name: 'Tenant-Nutzer verwalten' }),
    );

    expect(window.location.pathname).toBe('/admin/members');
  });

  /**
   * The requirement Fund 3: `useSaveFormMember` used to invalidate nothing
   * but its own key, so a write that changed what `GET /forms` answers for
   * the acting person left the dashboard showing a form that route would no
   * longer include — „Formularliste und Navigation" of the finding, both fed
   * by that one route (the card's own „Bearbeiten"/„Antworten" buttons *are*
   * the navigation into the form; see `api/form-members.ts` on why `FormNav`
   * itself reads nothing this write could touch).
   *
   * The mocked `PUT` answers 200 with `accessRevoked: true` on the acting
   * person's own row — a write the real guard refuses today
   * (`SELF_LOCKOUT_MESSAGE`, covered above) — on purpose: this test is about
   * what the *client* does with whatever the server says, not about which
   * write is reachable through today's guard (`api/form-members.ts`'s own
   * comment on the invalidation says why that distinction matters).
   *
   * Asserted on the **result** a person sees, not on which query key was
   * invalidated: a test that only counted the call would stay green with the
   * wrong key, the exact trap named in the finding.
   */
  it('drops the form from the Dashboard grid without a reload once the acting person’s own access is revoked', async () => {
    let ownAccessRevoked = false;
    const formSummary = {
      id: FORM_ID,
      title: 'Bestandsmeldung',
      status: 'active',
      publishedVersion: 1,
      responseCount: 3,
      permissions: permissions(),
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    stubFetch().mockImplementation((input, init) => {
      const url = pathOf(input);
      const method = init?.method ?? 'GET';

      if (
        method === 'PUT' &&
        url.endsWith(`/forms/${FORM_ID}/members/${SELF_ID}`)
      ) {
        ownAccessRevoked = true;
        return Promise.resolve(
          jsonResponse(
            200,
            membersDocument({
              members: [
                adminMember(),
                selfMember({ accessRevoked: true }),
                viewerMember(),
                cappedMember(),
              ],
            }),
          ),
        );
      }
      if (url.endsWith(`/forms/${FORM_ID}/members`)) {
        return Promise.resolve(jsonResponse(200, membersDocument()));
      }
      if (url.endsWith('/tenant/groups')) {
        return Promise.resolve(jsonResponse(200, groupsDocument()));
      }
      if (url.endsWith('/auth/me')) {
        return Promise.resolve(jsonResponse(200, sessionDocument()));
      }
      // `GET /forms/:id` — not asserted on directly here, just kept out of
      // the members view's way.
      if (url.endsWith(`/forms/${FORM_ID}`)) {
        return Promise.resolve(emptyResponse(404));
      }
      // `GET /forms` — narrowed by the same restriction the members route
      // sits behind (`FormRestriction.formFilter()`), which is what this test
      // measures: the list drops the form once the acting person's own row
      // carries `accessRevoked: true`.
      // A **page**, and matched by prefix because the dashboard
      // asks `GET /forms?limit=…&offset=…`.
      if (url.includes('/forms?')) {
        const items = ownAccessRevoked ? [] : [formSummary];
        return Promise.resolve(
          jsonResponse(200, {
            items,
            total: items.length,
            activeTotal: items.length,
            responseTotal: 0,
            limit: 24,
            offset: 0,
          }),
        );
      }
      return Promise.resolve(emptyResponse(404));
    });

    renderWithQuery(
      <>
        <FormMembersView formId={FORM_ID} />
        <DashboardView
          tenantName="Dachorganisation"
          tenantCount={1}
          canBuild={true}
          aiFormsAvailable={false}
          onOpenAiForm={() => undefined}
        />
      </>,
    );

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Bestandsmeldung' }),
      ).toBeDefined();
    });

    const row = screen.getByText('Erik Editor').closest('li');
    if (row === null) {
      throw new Error('The self row was not found.');
    }
    fireEvent.click(within(row).getByRole('switch'));
    fireEvent.click(within(row).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => {
      expect(
        screen.queryByRole('heading', { name: 'Bestandsmeldung' }),
      ).toBeNull();
    });
    // The empty state, not a leftover card — the grid genuinely lost the form
    // rather than merely losing its title text somewhere else on the page.
    expect(screen.getByText('Noch keine Formulare vorhanden.')).toBeDefined();
  });
});
