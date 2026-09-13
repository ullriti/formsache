import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { jsonResponse, requestUrl, stubFetch } from '../test/fetch-mock';
import { renderWithQuery } from '../test/render-with-query';
import {
  OTHER_TENANT_ID,
  UMBRELLA_TENANT_ID,
  membership,
  sessionUser,
} from '../test/fixtures';
import { DASHBOARD_PATH, TRASH_PATH } from '../router/routes';
import { TenantList } from './TenantList';

/**
 * **Where an organization switch leads** (finding 19).
 *
 * The switch itself was built and checked; where it *takes* you was never
 * decided — and the answer was “nowhere”: the session was re-hung, the address
 * stayed put. Whoever switched out of the trash, out of a form or out of the
 * tenant administration then stood on an address that does not belong to the new
 * organization at all.
 *
 * The picker sits in the header's popover **and** in the mobile version, and
 * both use this component — which is why the assertion stands here and not
 * twice next to it.
 */

const MEMBERSHIPS = [
  membership(UMBRELLA_TENANT_ID, 'Dachorganisation', 'DACH'),
  membership(OTHER_TENANT_ID, 'Musterstadt', 'MUST'),
];

function stubSwitch() {
  const fetchMock = stubFetch();
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    if (requestUrl(input).endsWith('/session/tenant')) {
      return Promise.resolve(
        jsonResponse(200, sessionUser({ activeTenantId: OTHER_TENANT_ID })),
      );
    }
    return Promise.resolve(jsonResponse(200, null));
  });
  return fetchMock;
}

beforeEach(() => {
  window.history.pushState(null, '', TRASH_PATH);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TenantList', () => {
  it('führt nach einem geglückten Wechsel auf das Dashboard', async () => {
    stubSwitch();
    renderWithQuery(
      <TenantList
        memberships={MEMBERSHIPS}
        activeTenantId={UMBRELLA_TENANT_ID}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Musterstadt/u }));

    await waitFor(() => {
      expect(window.location.pathname).toBe(DASHBOARD_PATH);
    });
  });

  it('schließt den Wähler und geht — in dieser Reihenfolge', async () => {
    stubSwitch();
    const onSwitched = vi.fn(() => {
      // The order is visible: first the popover closes, then the view changes.
      // The other way round the open popover would stand over the result of
      // one's own action for the blink of an eye.
      expect(window.location.pathname).toBe(TRASH_PATH);
    });
    renderWithQuery(
      <TenantList
        memberships={MEMBERSHIPS}
        activeTenantId={UMBRELLA_TENANT_ID}
        onSwitched={onSwitched}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Musterstadt/u }));

    await waitFor(() => {
      expect(onSwitched).toHaveBeenCalledTimes(1);
    });
    expect(window.location.pathname).toBe(DASHBOARD_PATH);
  });

  it('bleibt bei einem gescheiterten Wechsel, wo es war', async () => {
    // The counter-check: a navigation that set off even when the server refuses
    // would leave somebody standing in the dashboard of an organization they
    // did not switch into at all.
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse(403, { message: 'nein' }));

    renderWithQuery(
      <TenantList
        memberships={MEMBERSHIPS}
        activeTenantId={UMBRELLA_TENANT_ID}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Musterstadt/u }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined();
    });
    expect(window.location.pathname).toBe(TRASH_PATH);
  });

  it('lässt die aktive Organisation kein Ziel sein', () => {
    // Unchanged and therefore recorded here: a switch to where one already is
    // cost a round trip and a complete invalidation of the cache for nothing —
    // and would now navigate on top of that.
    renderWithQuery(
      <TenantList
        memberships={MEMBERSHIPS}
        activeTenantId={UMBRELLA_TENANT_ID}
      />,
    );

    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: /Dachorganisation/u,
      }).disabled,
    ).toBe(true);
  });
});
