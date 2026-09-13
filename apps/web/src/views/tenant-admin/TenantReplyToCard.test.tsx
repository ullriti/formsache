import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { jsonResponse, stubFetch, type FetchMock } from '../../test/fetch-mock';
import { renderWithQuery } from '../../test/render-with-query';
import { TenantReplyToCard } from './TenantReplyToCard';

/**
 * *Antwortadresse*  — the own section of the
 * *Mailversand* tab for the `Reply-To` default of an organisation.
 */

const TENANT_ID = '00000000-0000-4000-8000-000000000067';

function putCall(fetchMock: FetchMock): {
  readonly url: string;
  readonly body: Record<string, unknown>;
} {
  const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
  const url = call?.[0];
  const body = call?.[1]?.body;
  if (typeof url !== 'string' || typeof body !== 'string') {
    throw new Error('No PUT with a URL and a JSON body was sent.');
  }
  return { url, body: JSON.parse(body) as Record<string, unknown> };
}

// `getByRole('textbox', …)` instead of `getByLabelText`: the heading of the
// section is likewise called „Antwortadresse" and is connected to it via
// `aria-labelledby` — the same trap that `TenantBaseUrlCard.test.tsx` names
// for its field of the same name.
async function renderLoaded(config: unknown = { replyTo: null }) {
  const fetchMock = stubFetch().mockResolvedValue(jsonResponse(200, config));
  renderWithQuery(<TenantReplyToCard tenantId={TENANT_ID} />);
  await waitFor(() => {
    expect(
      screen.getByRole('textbox', { name: 'Antwortadresse' }),
    ).toBeDefined();
  });
  return fetchMock;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TenantReplyToCard', () => {
  it('shows an empty field while the organisation inherits, and says what that means', async () => {
    await renderLoaded({ replyTo: null });

    expect(
      screen.getByRole<HTMLInputElement>('textbox', {
        name: 'Antwortadresse',
      }).value,
    ).toBe('');
    expect(
      screen.getByText('damit die Systemvorgabe gilt', { exact: false }),
    ).toBeDefined();
    // Trap 1, as a sentence on the screen: if everything is missing, the
    // answer is "no header" — not "no sending".
    expect(
      screen.getByText('trägt die Mail keine Antwortadresse', { exact: false }),
    ).toBeDefined();
  });

  /**
   * **The route is one of its own, not `/tenant/smtp`**  — exactly
   * the question that had to be settled before the build. If the field lay in
   * the block, a save would demand the SMTP password.
   *
   * The address is therefore checked along with it and not only the body: a
   * card that wrote to `/tenant/smtp` would get through a pure body check.
   */
  it('saves through its own route, never through the SMTP block', async () => {
    const fetchMock = await renderLoaded({ replyTo: null });

    fireEvent.change(screen.getByRole('textbox', { name: 'Antwortadresse' }), {
      target: { value: ' geschaeftsstelle@example.org ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

    await waitFor(() => {
      const { url, body } = putCall(fetchMock);
      expect(url).toContain('/tenant/reply-to');
      expect(body).toEqual({ replyTo: 'geschaeftsstelle@example.org' });
    });
  });

  /**
   * An emptied field is `null` — „die Systemvorgabe gilt" —, never the empty
   * string, which `replyToAddressSchema` would refuse with a 400.
   */
  it('sends null for a cleared field', async () => {
    const fetchMock = await renderLoaded({ replyTo: 'alt@example.org' });

    fireEvent.change(screen.getByRole('textbox', { name: 'Antwortadresse' }), {
      target: { value: '   ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

    await waitFor(() => {
      expect(putCall(fetchMock).body).toEqual({ replyTo: null });
    });
  });
});
