import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { jsonResponse, stubFetch, type FetchMock } from '../../test/fetch-mock';
import { renderWithQuery } from '../../test/render-with-query';
import { TenantBaseUrlCard } from './TenantBaseUrlCard';

/**
 * *Basis-Adresse* (ADR-0013 no. 3) — the
 * *Mailversand*-Reiter's own, separate section for an organisation's own address.
 * `MailIdentityCard.test.tsx` covers that this card actually renders inside
 * that tab; this suite covers the section on its own.
 */

const TENANT_ID = '00000000-0000-4000-8000-0000000000c8';

function putBody(fetchMock: FetchMock): Record<string, unknown> {
  const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
  const body = call?.[1]?.body;
  if (typeof body !== 'string') {
    throw new Error('No PUT with a JSON body was sent.');
  }
  return JSON.parse(body) as Record<string, unknown>;
}

// `getByRole('textbox', …)`, not `getByLabelText`: the card's own heading is
// also named "Basis-Adresse" and is `aria-labelledby`'d to the section, so
// the label text alone is ambiguous between the two — the exact trap
// `SystemMailSettingsTab.test.tsx` names for its own field of the same name.

async function renderLoaded(config: unknown = { baseUrl: null }) {
  const fetchMock = stubFetch().mockResolvedValue(jsonResponse(200, config));
  renderWithQuery(<TenantBaseUrlCard tenantId={TENANT_ID} />);
  await waitFor(() => {
    expect(
      screen.getByRole('textbox', { name: 'Basis-Adresse' }),
    ).toBeDefined();
  });
  return fetchMock;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TenantBaseUrlCard', () => {
  it('shows an empty field while the organisation has none of its own', async () => {
    await renderLoaded({ baseUrl: null });

    expect(
      screen.getByRole<HTMLInputElement>('textbox', { name: 'Basis-Adresse' })
        .value,
    ).toBe('');
    // (c) of Offener Punkt 9 — the hint names what it is for and what not.
    expect(
      screen.getByText('an Teilnehmer gehen', { exact: false }),
    ).toBeDefined();
    expect(
      screen.getByText('bleibt auf der Adresse der Installation', {
        exact: false,
      }),
    ).toBeDefined();
  });

  it('shows the stored address', async () => {
    await renderLoaded({ baseUrl: 'https://organisation.example.org' });

    expect(
      screen.getByRole<HTMLInputElement>('textbox', { name: 'Basis-Adresse' })
        .value,
    ).toBe('https://organisation.example.org');
  });

  it('saves a typed address', async () => {
    const fetchMock = await renderLoaded({ baseUrl: null });

    fireEvent.change(screen.getByRole('textbox', { name: 'Basis-Adresse' }), {
      target: { value: 'https://organisation.example.org' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

    await waitFor(() => {
      expect(putBody(fetchMock)).toEqual({
        baseUrl: 'https://organisation.example.org',
      });
    });
  });

  /** Clearing means “the system default applies” — `null`, never the empty string. */
  it('clearing the field writes null, not an empty string', async () => {
    const fetchMock = await renderLoaded({
      baseUrl: 'https://organisation.example.org',
    });

    fireEvent.change(screen.getByRole('textbox', { name: 'Basis-Adresse' }), {
      target: { value: '  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

    await waitFor(() => {
      expect(putBody(fetchMock)).toEqual({ baseUrl: null });
    });
  });

  it("shows a rejected value's field issue next to the field", async () => {
    stubFetch().mockImplementation((_input, init) =>
      Promise.resolve(
        init?.method === 'PUT'
          ? jsonResponse(400, {
              message: 'Die Anfrage ist ungültig.',
              issues: [
                { path: 'baseUrl', message: 'Basis-Adresse ist ungültig.' },
              ],
            })
          : jsonResponse(200, { baseUrl: null }),
      ),
    );
    renderWithQuery(<TenantBaseUrlCard tenantId={TENANT_ID} />);
    await waitFor(() => {
      expect(
        screen.getByRole('textbox', { name: 'Basis-Adresse' }),
      ).toBeDefined();
    });

    fireEvent.change(screen.getByRole('textbox', { name: 'Basis-Adresse' }), {
      target: { value: 'nicht-valide' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

    await waitFor(() => {
      expect(screen.getByText('Basis-Adresse ist ungültig.')).toBeDefined();
    });
  });

  it('is absent, not disabled, when the caller may not see it', async () => {
    stubFetch().mockResolvedValue(jsonResponse(403, { message: 'nope' }));
    renderWithQuery(<TenantBaseUrlCard tenantId={TENANT_ID} />);

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('nicht sehen');
    });
    expect(screen.queryByRole('button', { name: 'Speichern' })).toBeNull();
  });
});
