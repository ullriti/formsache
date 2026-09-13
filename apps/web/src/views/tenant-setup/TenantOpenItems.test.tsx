import { fireEvent, screen } from '@testing-library/react';
import type { Permissions } from '@formsache/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TenantOpenItems } from './TenantOpenItems';
import { TENANT_SETUP_PATH } from '../../router/routes';
import { jsonResponse, requestUrl, stubFetch } from '../../test/fetch-mock';
import { renderWithQuery } from '../../test/render-with-query';

/**
 * **What stands on the dashboard of an organisation about its setup**
 * (ADR-0025 no. 4).
 *
 * The one decision measured here: **invitation or list, never
 * both** — and what the application tells „new" from „running" by, namely
 * by the state (does this organisation already have forms?) and not by a
 * marker.
 *
 * *Reproduction:* ignore `hasForms` → an organisation that has been running
 * forms for months would get an invitation into the setup wizard on
 * its dashboard.
 */

const TENANT_ID = '00000000-0000-4000-8000-0000000000aa';

const ALL_PERMISSIONS: Permissions = {
  canBuild: true,
  canViewResponses: true,
  canExport: true,
  canManageSettings: true,
  canManageFormSettings: true,
  canManageUsers: true,
};

function stubWithoutMailServer(): void {
  stubFetch().mockImplementation((input: RequestInfo | URL) =>
    Promise.resolve(
      requestUrl(input).includes('/tenant/smtp')
        ? jsonResponse(200, { smtp: null })
        : jsonResponse(200, { groups: [] }),
    ),
  );
}

describe('die Einrichtungs-Auskunft auf dem Dashboard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lädt eine neue Organisation in den Assistenten ein — ohne sie dorthin zu schieben', async () => {
    stubWithoutMailServer();

    renderWithQuery(
      <TenantOpenItems
        tenantId={TENANT_ID}
        permissions={ALL_PERMISSIONS}
        hasForms={false}
      />,
    );

    const invite = await screen.findByRole('button', {
      name: 'Einrichtung starten',
    });
    // The address is entered only on a click: no redirect, a button.
    expect(window.location.pathname).not.toBe(TENANT_SETUP_PATH);
    fireEvent.click(invite);
    expect(window.location.pathname).toBe(TENANT_SETUP_PATH);
  });

  /**
   * **Jeder offene Punkt führt zu seiner Einstellung — auch in der Einladung**
   * (Review-Runde 3 Nr. 7).
   *
   * Der Befund: *„Wenn ich dann auf Einrichtung starten klicke, dann sollte
   * ich jeweils immer beim richtigen Schritt landen bzw. vermutlich noch
   * besser: direkt in den Tenant-Einstellungen."*
   *
   * Die Einladung hatte bis dahin eine **zweite, abgeschriebene** Fassung der
   * Liste, und in der fehlte je Zeile der Sprungknopf: wer las, welche
   * Einstellung fehlt, kam trotzdem nur bei Schritt 1 heraus. Gemessen wird
   * deshalb der direkte Weg — und dass die Einladung daneben stehen bleibt.
   */
  it('führt aus der Einladung heraus direkt zur fehlenden Einstellung', async () => {
    stubWithoutMailServer();

    renderWithQuery(
      <TenantOpenItems
        tenantId={TENANT_ID}
        permissions={ALL_PERMISSIONS}
        hasForms={false}
      />,
    );

    const jump = await screen.findByRole('button', {
      name: 'Zum Mailversand',
    });
    // Die Einladung steht weiterhin daneben — der geführte Weg ist ein
    // Angebot und kein Ersatz für den direkten.
    expect(
      screen.getByRole('button', { name: 'Einrichtung starten' }),
    ).toBeDefined();

    fireEvent.click(jump);
    expect(window.location.pathname).not.toBe(TENANT_SETUP_PATH);
    expect(window.location.pathname).toContain('mail');
  });

  it('zeigt einer laufenden Organisation nur die offenen Punkte', async () => {
    stubWithoutMailServer();

    renderWithQuery(
      <TenantOpenItems
        tenantId={TENANT_ID}
        permissions={ALL_PERMISSIONS}
        hasForms
      />,
    );

    expect(
      await screen.findByRole('button', { name: 'Zum Mailversand' }),
    ).toBeDefined();
    expect(
      screen.queryByRole('button', { name: 'Einrichtung starten' }),
    ).toBeNull();
  });

  it('behandelt „wir wissen es nicht" wie „läuft"', async () => {
    stubWithoutMailServer();

    renderWithQuery(
      <TenantOpenItems
        tenantId={TENANT_ID}
        permissions={ALL_PERMISSIONS}
        hasForms={undefined}
      />,
    );

    expect(
      await screen.findByRole('button', { name: 'Zum Mailversand' }),
    ).toBeDefined();
    expect(
      screen.queryByRole('button', { name: 'Einrichtung starten' }),
    ).toBeNull();
  });

  it('fragt nichts, was diese Rolle nicht lesen darf — und zeigt dann nichts', () => {
    const fetchMock = stubFetch();

    const { container } = renderWithQuery(
      <TenantOpenItems
        tenantId={TENANT_ID}
        permissions={{
          ...ALL_PERMISSIONS,
          canManageSettings: false,
          canManageUsers: false,
        }}
        hasForms={false}
      />,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.textContent).toBe('');
  });
});
