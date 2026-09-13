import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Cascade } from '../../test/css-cascade';
import { emptyResponse, jsonResponse, stubFetch } from '../../test/fetch-mock';
import { renderWithQuery } from '../../test/render-with-query';
import { FormMembersView } from '../FormMembersView';

/**
 * **„Gesperrt" must not cripple the button** (review finding).
 *
 * The dimming of the locked state lay on the whole row. With that
 * „Speichern" inherited the opacity 0,55 and was no longer distinguishable
 * from `.form-members__save:disabled` (0,6) — of all moments in the one in
 * which saving **must** happen: the button appears only on an unsaved
 * change, and the locking is exactly such a one.
 *
 * What is measured is the **effective opacity** of the button, not the class of
 * the row: opacity is not inherited, it multiplies over the
 * ancestors, and exactly for that reason the button here never needed a rule of
 * its own in order to be pale. The second part of the case is just as important
 * — that the row *still* looks dimmed at all: a "fix" that makes the
 * locked state invisible would be the next finding.
 *
 * The view is rendered whole and not the row alone: the mutation
 * belongs to `FormMembersView` (one instance for all rows), and a
 * rebuilt `UseMutationResult` would be a claim about it.
 */
const styles = Cascade.fromFile('src/views/form-members-view.css');

const FORM_ID = '00000000-0000-4000-8000-0000000000f0';
const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const SELF_ID = '00000000-0000-4000-8000-0000000000e1';
const VIEWER_ID = '00000000-0000-4000-8000-0000000000e2';

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

const NO_PERMISSIONS = {
  canBuild: false,
  canViewResponses: true,
  canExport: false,
  canManageSettings: false,
  canManageFormSettings: false,
  canManageUsers: false,
};

function membersDocument() {
  return {
    members: [
      {
        userId: SELF_ID,
        name: 'Erik Editor',
        email: 'erik@example.org',
        group: EDITOR_GROUP,
        restrictable: true,
        accessRevoked: false,
        cappedGroupId: null,
      },
      {
        userId: VIEWER_ID,
        name: 'Vera Viewer',
        email: 'vera@example.org',
        group: VIEWER_GROUP,
        restrictable: true,
        accessRevoked: false,
        cappedGroupId: null,
      },
    ],
    groups: [EDITOR_GROUP, VIEWER_GROUP],
  };
}

function groupsDocument() {
  return {
    groups: [
      { ...EDITOR_GROUP, permissions: NO_PERMISSIONS, memberCount: 1 },
      { ...VIEWER_GROUP, permissions: NO_PERMISSIONS, memberCount: 1 },
    ],
  };
}

function sessionDocument() {
  return {
    id: SELF_ID,
    email: 'erik@example.org',
    name: 'Erik Editor',
    isSuperadmin: false,
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
        permissions: { ...NO_PERMISSIONS, canManageUsers: true },
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

async function renderLoaded(): Promise<void> {
  stubFetch().mockImplementation((input) => {
    const url = pathOf(input);
    if (url.endsWith(`/forms/${FORM_ID}/members`)) {
      return Promise.resolve(jsonResponse(200, membersDocument()));
    }
    if (url.endsWith('/tenant/groups')) {
      return Promise.resolve(jsonResponse(200, groupsDocument()));
    }
    if (url.endsWith('/auth/me')) {
      return Promise.resolve(jsonResponse(200, sessionDocument()));
    }
    // The title is a nice-to-have of this view; a 404 does not block it.
    return Promise.resolve(emptyResponse(404));
  });
  renderWithQuery(<FormMembersView formId={FORM_ID} />);
  await waitFor(() => {
    expect(screen.getByRole('heading', { name: 'Nutzerrechte' })).toBeDefined();
  });
}

function rowOf(name: string): HTMLElement {
  const row = screen.getByText(name).closest('li');
  if (row === null) {
    throw new Error(`Die Zeile „${name}" wurde nicht gefunden.`);
  }
  return row;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('FormMemberRow › gesperrter Zugriff', () => {
  it('lässt „Speichern" voll deckend, während die Zeile gesperrt ist', async () => {
    await renderLoaded();

    const row = rowOf('Vera Viewer');
    // The state this is about: the locking *is* the unsaved
    // change — the button appears only through it.
    fireEvent.click(within(row).getByRole('switch'));
    expect(within(row).getByText('Gesperrt')).toBeDefined();

    const save = within(row).getByRole('button', { name: 'Speichern' });
    // It is operable …
    expect(save.hasAttribute('disabled')).toBe(false);
    // … and it looks that way too. `1` and not "anything above 0,6": everything
    // below that is the degree of paleness with which this view says "this does
    // not work right now".
    expect(styles.effectiveOpacity(save)).toBe(1);
    // The selection next to it belongs to the same controls.
    expect(styles.effectiveOpacity(within(row).getByRole('combobox'))).toBe(1);
  });

  it('dämpft dabei weiterhin, was die Zeile über die Person sagt', async () => {
    await renderLoaded();

    const row = rowOf('Vera Viewer');
    const name = screen.getByText('Vera Viewer');
    // Before: nothing is dimmed — otherwise the measurement afterwards would
    // prove nothing.
    expect(styles.effectiveOpacity(name)).toBe(1);

    fireEvent.click(within(row).getByRole('switch'));

    expect(styles.effectiveOpacity(name)).toBeLessThan(1);
  });
});
