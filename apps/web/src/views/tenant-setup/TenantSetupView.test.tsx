import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { Permissions } from '@formsache/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TenantSetupView } from './TenantSetupView';
import { TENANT_SETUP_STEPS } from './steps';
import { jsonResponse, requestUrl, stubFetch } from '../../test/fetch-mock';
import { renderWithQuery } from '../../test/render-with-query';

/**
 * **The assistant of a newly created organisation** (ADR-0025).
 *
 * What is measured is what is really decided about it — not how it looks:
 *
 * 1. **Every step says what does not work without it**, and the most important
 *    one says the sharpest thing: without a mail server this organisation sends
 *    nothing.
 * 2. **A step this role is not allowed is visibly skipped** —
 *    with the reason and without a form that says 403 on saving. That is
 *    the promise the whole rights part of this assistant hangs on.
 * 3. **If the installation's AI is off, the step falls away** — with the
 *    reason, and without a select box whose position has no effect.
 * 4. **The position stands there as text** („Schritt 1 von 9"), and the state
 *    of every step as a word. Both come from the scaffolding and are measured
 *    here, because here is where they arrive.
 *
 * ## Counter-probes, measured while writing
 *
 * - Let `stepPermitted` always return `true` → case 2 turns red, and an editor
 *   without `canManageUsers` would get the group editor as a broken
 *   form.
 * - Ignore `systemAvailable` in `AiStep` → case 3 turns red, and an
 *   organisation would get a switch that has no effect.
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

const BRANDING = {
  name: 'Musterstadt',
  shortName: 'MUSTER',
  logoRef: null,
  logoWide: false,
  logoChoices: [],
  stripeColors: ['#123456'],
  accent: '#123456',
  headerBg: '#123456',
  canvasBg: '#fefefe',
  revision: 1,
};

/** A double that answers every route of the assistant with an empty document. */
function stubTenantRoutes(
  overrides: Readonly<Record<string, unknown>> = {},
): ReturnType<typeof stubFetch> {
  return stubFetch().mockImplementation((input: RequestInfo | URL) => {
    const url = requestUrl(input);
    for (const [path, body] of Object.entries(overrides)) {
      if (url.includes(path)) {
        return Promise.resolve(jsonResponse(200, body));
      }
    }
    if (url.includes('/tenant/branding')) {
      return Promise.resolve(jsonResponse(200, BRANDING));
    }
    if (url.includes('/tenant/smtp')) {
      return Promise.resolve(jsonResponse(200, { smtp: null }));
    }
    if (url.includes('/ai/tenant-settings')) {
      return Promise.resolve(
        jsonResponse(200, { enabled: null, systemAvailable: true }),
      );
    }
    return Promise.resolve(jsonResponse(403, { message: 'nope' }));
  });
}

function renderWizard(permissions: Permissions = ALL_PERMISSIONS): void {
  renderWithQuery(
    <TenantSetupView
      tenantId={TENANT_ID}
      tenantName="Musterstadt"
      tenantShortName="MUST"
      permissions={permissions}
      currentUserId="user-1"
      currentUserEmail="admin@example.org"
    />,
  );
}

/**
 * Clicks „Überspringen" until the step with `title` is up.
 *
 * Without waiting in between: the step's heading belongs to the **frame**
 * and stands there before any document is loaded — what a case waits for
 * afterwards is the content, not the step.
 */
function skipTo(title: string): void {
  for (let attempt = 0; attempt <= TENANT_SETUP_STEPS.length; attempt += 1) {
    if (screen.queryByRole('heading', { level: 2, name: title }) !== null) {
      return;
    }
    fireEvent.click(screen.getByRole('button', { name: 'Überspringen' }));
  }
  throw new Error(`Der Schritt „${title}" wurde nie erreicht.`);
}

describe('TenantSetupView', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('führt durch alle Einstellungen und sagt die Position als Text', () => {
    stubTenantRoutes();
    renderWizard();

    expect(
      screen.getByText(`Schritt 1 von ${String(TENANT_SETUP_STEPS.length)}`),
    ).toBeDefined();
    // The step list names every step by name — it is the overview a skippable
    // flow needs.
    const list = screen.getByRole('navigation', {
      name: 'Schritte des Assistenten',
    });
    for (const step of TENANT_SETUP_STEPS) {
      expect(within(list).getByText(step.title)).toBeDefined();
    }
  });

  it('zeigt im ersten Schritt dieselben Karten wie der Reiter — samt Kontrast-Hinweisen', async () => {
    stubTenantRoutes();
    renderWizard();

    // The cards of the *Erscheinungsbild & Login* tab, not a second version
    // of them: the same building block, the same labels.
    expect(
      await screen.findByRole('heading', { name: 'Logo & Name' }),
    ).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Farben' })).toBeDefined();
    expect(
      screen.getByLabelText('Akzent (Buttons, Fortschritt)'),
    ).toBeDefined();
  });

  it('speichert und geht weiter — ein Dokument, ein Knopf', async () => {
    const fetchMock = stubTenantRoutes();
    renderWizard();

    const save = await screen.findByRole('button', {
      name: 'Speichern und weiter',
    });
    fireEvent.click(save);

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            requestUrl(input).includes('/tenant/branding') &&
            init?.method === 'PUT',
        ),
      ).toBe(true);
    });
    // And the flow stands on the second step afterwards.
    await waitFor(() => {
      expect(
        screen.getByText(`Schritt 2 von ${String(TENANT_SETUP_STEPS.length)}`),
      ).toBeDefined();
    });
  });

  it('sagt beim Mailserver das Schärfste: diese Organisation verschickt sonst nichts', () => {
    stubTenantRoutes();
    renderWizard();

    skipTo('Mailserver der Organisation');

    expect(
      screen.getByText(/verschickt diese Organisation nichts/u),
    ).toBeDefined();
  });

  it('überspringt einen Schritt sichtbar, für den das Recht fehlt — statt ihn als Formular zu zeigen', () => {
    stubTenantRoutes();
    renderWizard({ ...ALL_PERMISSIONS, canManageUsers: false });

    skipTo('Gruppen und Rechte');

    // The reason stands there …
    expect(screen.getByText(/„Nutzer verwalten"/u)).toBeDefined();
    // … and no form: the group editor is not even loaded.
    expect(
      screen.queryByRole('button', { name: '+ Gruppe hinzufügen' }),
    ).toBeNull();
    // The main button promises no saving.
    expect(screen.getByRole('button', { name: 'Weiter' })).toBeDefined();
  });

  it('zeigt in der Schrittliste einen unerlaubten Schritt von Anfang an als übersprungen', () => {
    stubTenantRoutes();
    renderWizard({ ...ALL_PERMISSIONS, canManageUsers: false });

    const list = screen.getByRole('navigation', {
      name: 'Schritte des Assistenten',
    });
    const groups = within(list).getByText('Gruppen und Rechte').closest('li');
    expect(groups?.textContent).toContain('übersprungen');
  });

  it('lässt den KI-Schritt aus, wenn die Installation keine KI hat', async () => {
    stubTenantRoutes({
      '/ai/tenant-settings': { enabled: null, systemAvailable: false },
    });
    renderWizard();

    skipTo('KI-Formularerstellung');

    await waitFor(() => {
      expect(
        screen.getByText(/Diese Installation hat keine KI eingerichtet/u),
      ).toBeDefined();
    });
    // No select box whose position has no effect.
    expect(
      screen.queryByLabelText('KI-Formularerstellung in dieser Organisation'),
    ).toBeNull();
  });

  it('bietet den KI-Schalter an, wenn die Installation eine KI hat', async () => {
    stubTenantRoutes();
    renderWizard();

    skipTo('KI-Formularerstellung');

    await waitFor(() => {
      expect(
        screen.getByLabelText('KI-Formularerstellung in dieser Organisation'),
      ).toBeDefined();
    });
  });

  it('endet mit einer Bilanz, die auf die Liste offener Punkte verweist', async () => {
    stubTenantRoutes();
    renderWizard();

    TENANT_SETUP_STEPS.forEach(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Überspringen' }));
    });

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Eingerichtet' }),
      ).toBeDefined();
    });
    expect(screen.getByText(/Dashboard dieser Organisation/u)).toBeDefined();
    // The way out is always there — this flow locks nobody in.
    expect(screen.getByRole('button', { name: 'Zum Dashboard' })).toBeDefined();
  });
});
