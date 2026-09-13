import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { emptyResponse, jsonResponse, stubFetch } from '../test/fetch-mock';
import { renderWithQuery } from '../test/render-with-query';
import { FormMembersView } from './FormMembersView';
import { TenantMembersTab } from './tenant-admin/TenantMembersTab';

/**
 * **The organisation's groups are one document, so they are one query.**
 *
 * Two surfaces read them: the „Rechte im Überblick"-matrix of *Nutzerrechte je
 * Formular* and the group editor of the tenant administration. They used to cache
 * them under two keys — a bare `['tenant-groups']` in `api/form-members.ts`
 * next to `['tenant-groups', tenantId]` in `api/tenant-admin.ts` — and the two
 * copies never met: after an organisation switch the unscoped one still held the
 * previous organisation's groups, and every invalidation the editor triggered reached
 * only its own.
 *
 * That is what this file measures, and it needs both surfaces in one tree
 * because the defect lives *between* them: a write in the editor has to be
 * visible in the matrix without a reload.
 */

const FORM_ID = '00000000-0000-4000-8000-0000000000f0';
const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const USER_ID = '00000000-0000-4000-8000-0000000000e1';
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

const ALL_PERMISSIONS = {
  canBuild: true,
  canViewResponses: true,
  canExport: true,
  canManageSettings: true,
  canManageFormSettings: true,
  canManageUsers: true,
};

function groupsDocument(editorName = 'editor') {
  return {
    groups: [
      { ...ADMIN_GROUP, permissions: ALL_PERMISSIONS, memberCount: 1 },
      {
        ...EDITOR_GROUP,
        name: editorName,
        permissions: { ...ALL_PERMISSIONS, canManageUsers: false },
        memberCount: 1,
      },
    ],
  };
}

function sessionDocument() {
  return {
    id: USER_ID,
    email: 'erik@example.org',
    name: 'Erik Editor',
    isSuperadmin: false,
    // Since `aiFormsAvailable` became mandatory on the wire, the route always
    // sends this field; a document without it would describe a response that
    // does not exist.
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
        permissions: ALL_PERMISSIONS,
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the organisation’s groups', () => {
  it('share one cache entry: a rename in the editor reaches the matrix', async () => {
    let editorName = 'editor';
    stubFetch().mockImplementation((input, init) => {
      const url = pathOf(input);
      const method = init?.method ?? 'GET';

      if (url.endsWith('/tenant/groups') && method === 'GET') {
        return Promise.resolve(jsonResponse(200, groupsDocument(editorName)));
      }
      if (url.includes('/tenant/groups/') && method === 'PUT') {
        editorName = 'Schriftleitung';
        return Promise.resolve(
          jsonResponse(200, {
            ...EDITOR_GROUP,
            name: editorName,
            permissions: { ...ALL_PERMISSIONS, canManageUsers: false },
            memberCount: 1,
          }),
        );
      }
      if (url.endsWith('/tenant/users') && method === 'GET') {
        return Promise.resolve(
          jsonResponse(200, {
            members: [
              {
                userId: USER_ID,
                email: 'erik@example.org',
                name: 'Erik Editor',
                accountKind: 'local',
                group: EDITOR_GROUP,
              },
            ],
          }),
        );
      }
      if (url.endsWith('/tenant/oidc')) {
        return Promise.resolve(emptyResponse(403));
      }
      if (url.endsWith(`/forms/${FORM_ID}/members`)) {
        return Promise.resolve(
          jsonResponse(200, {
            members: [
              {
                userId: USER_ID,
                name: 'Erik Editor',
                email: 'erik@example.org',
                group: EDITOR_GROUP,
                restrictable: true,
                accessRevoked: false,
                cappedGroupId: null,
              },
            ],
            groups: [ADMIN_GROUP, EDITOR_GROUP],
          }),
        );
      }
      if (url.endsWith('/auth/me')) {
        return Promise.resolve(jsonResponse(200, sessionDocument()));
      }
      return Promise.resolve(emptyResponse(404));
    });

    renderWithQuery(
      <>
        <FormMembersView formId={FORM_ID} />
        <TenantMembersTab tenantId={TENANT_ID} currentUserId={USER_ID} />
      </>,
    );

    await waitFor(() => {
      expect(screen.getByText('Rechte im Überblick')).toBeDefined();
    });
    await waitFor(() => {
      expect(screen.getByLabelText('Name der Gruppe editor')).toBeDefined();
    });

    /*
      Counting the requests would **not** measure this, and that is worth
      writing down: with the default `staleTime` of 0, a second observer
      mounting a moment after the first legitimately refetches the same key, so
      „two requests" is the normal shape of one shared query here. What only one
      key can do is what follows — an invalidation from the editor arriving at
      the matrix. Invalidating `['tenant-groups', tenantId]` never matched a
      bare `['tenant-groups']` (a filter key has to be a *prefix* of the query
      key), so the second copy simply stayed as it was.
    */
    const matrix = document.querySelector<HTMLElement>('.form-members__matrix');
    if (matrix === null) {
      throw new Error('The rights matrix was not found.');
    }
    expect(within(matrix).getByText('editor')).toBeDefined();

    // Rename the group in the editor and save.
    fireEvent.change(screen.getByLabelText('Name der Gruppe editor'), {
      target: { value: 'Schriftleitung' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

    // The matrix is another surface on the same cache entry, so the editor's
    // invalidation reaches it — without a reload and without its own request.
    await waitFor(() => {
      expect(within(matrix).getByText('Schriftleitung')).toBeDefined();
    });
  });
});
