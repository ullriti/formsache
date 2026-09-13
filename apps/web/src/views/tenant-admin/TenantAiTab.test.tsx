import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TenantAiTab } from './TenantAiTab';
import { jsonResponse, requestUrl, stubFetch } from '../../test/fetch-mock';
import { renderWithQuery } from '../../test/render-with-query';

/**
 * **An organisation's own AI switch** (ADR-0025 no. 6) — the interface to a
 * route that has existed since ADR-0015 and that up to then appeared in
 * **not a single** line of `apps/web/src`.
 *
 * What is measured:
 *
 * 1. **Three positions, not two.** `null` („like the installation") is a
 *    decision of its own and no „not set" — a toggle would have turned the
 *    inheriting into a fixed yes or no on the first click.
 * 2. **What goes out is exactly one field.**
 *    `updateTenantAiSwitchRequestSchema` is a `strictObject` with `enabled`; a
 *    body that sent `systemAvailable` along would get a 400 — and that piece
 *    of information belongs to the installation, not to the caller.
 * 3. **If the installation has no AI, the card says so** — instead of offering
 *    a choice that has no effect.
 * 4. **A 403 is a piece of role information**, not a loading error.
 */

const TENANT_ID = '00000000-0000-4000-8000-0000000000aa';
const FIELD = 'KI-Formularerstellung in dieser Organisation';

function sentBody(mock: ReturnType<typeof stubFetch>): unknown {
  const call = mock.mock.calls.find(([, init]) => init?.method === 'PUT');
  const raw = call?.[1]?.body;
  if (typeof raw !== 'string') {
    throw new Error('Es wurde kein JSON-Rumpf geschrieben.');
  }
  return JSON.parse(raw);
}

describe('der KI-Reiter einer Organisation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('zeigt die drei Stellungen und schickt genau ein Feld hinaus', async () => {
    const fetchMock = stubFetch().mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        expect(requestUrl(input)).toContain('/ai/tenant-settings');
        return Promise.resolve(
          jsonResponse(200, {
            enabled: init?.method === 'PUT' ? false : null,
            systemAvailable: true,
          }),
        );
      },
    );

    renderWithQuery(<TenantAiTab tenantId={TENANT_ID} />);

    const field = await screen.findByLabelText(FIELD);
    expect((field as HTMLSelectElement).value).toBe('inherit');

    fireEvent.change(field, { target: { value: 'off' } });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

    await waitFor(() => {
      expect(sentBody(fetchMock)).toEqual({ enabled: false });
    });
  });

  it('sagt, wenn die Installation gar keine KI hat', async () => {
    stubFetch().mockResolvedValue(
      jsonResponse(200, { enabled: null, systemAvailable: false }),
    );

    renderWithQuery(<TenantAiTab tenantId={TENANT_ID} />);

    expect(
      await screen.findByText(/Diese Installation hat keine KI eingerichtet/u),
    ).toBeDefined();
    // The choice stays operable nonetheless: an organisation may give its
    // answer in advance, and the installation can get the feature later.
    expect(await screen.findByLabelText(FIELD)).toBeDefined();
  });

  it('sagt bei 403, dass diese Rolle das nicht darf — und zeigt kein Formular', async () => {
    stubFetch().mockResolvedValue(jsonResponse(403, { message: 'nope' }));

    renderWithQuery(<TenantAiTab tenantId={TENANT_ID} />);

    expect(
      await screen.findByText(
        /Diese Rolle darf die KI-Einstellung dieser Organisation nicht sehen/u,
      ),
    ).toBeDefined();
    expect(screen.queryByLabelText(FIELD)).toBeNull();
  });
});
