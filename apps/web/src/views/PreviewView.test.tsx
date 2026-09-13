import { SYSTEM_FORM_SETTINGS } from '@formsache/shared';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { jsonResponse, requestUrl, stubFetch } from '../test/fetch-mock';
import { UMBRELLA_TENANT_ID, membership } from '../test/fixtures';
import { renderWithQuery } from '../test/render-with-query';
import { PreviewView } from './PreviewView';

/**
 * The test mode.
 *
 * What only a browser can decide — reachability through the navigation and
 * operability at 360 px — stands in Playwright (`e2e-tester`). This file records
 * what a rendered tree already answers:
 *
 * - the bar stands there, word for word;
 * - „Beispielwerte eintragen" enters values that land *in the form*;
 * - a test run **calls no writing route** — counted at the `fetch` calls, not
 *   claimed;
 * - a field for which no valid value can be generated is **named** instead of
 *   filled.
 */

const FORM_ID = '00000000-0000-4000-8000-0000000000c0';
const PAGE_ID = '00000000-0000-4000-8000-0000000000c1';
const TEXT_ID = '00000000-0000-4000-8000-0000000000c2';
const BROKEN_ID = '00000000-0000-4000-8000-0000000000c3';

/**
 * The organisation, the way the shell hands it in — out of the fixture of the
 * wire contract and not as an object literal: the branding has a `wideLogo`,
 * and a handwritten organisation here would describe a payload that the server
 * cannot send.
 */
const TENANT = membership(
  UMBRELLA_TENANT_ID,
  'Ortsgruppe Musterstadt',
  'Musterstadt',
).tenant;

function question(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    hint: null,
    required: true,
    width: 'full',
    ...overrides,
  };
}

function formDetail(
  questions: Record<string, unknown>[] = [
    question({
      id: TEXT_ID,
      type: 'text',
      label: 'Name',
      minLength: null,
      maxLength: null,
      pattern: null,
    }),
  ],
): Record<string, unknown> {
  return {
    id: FORM_ID,
    title: 'Jahrestagung-Anmeldung',
    status: 'draft',
    publishedVersion: null,
    responseCount: 0,
    updatedAt: '2026-07-01T08:00:00.000Z',
    permissions: {
      canBuild: true,
      canViewResponses: true,
      canExport: true,
      canManageSettings: true,
      canManageFormSettings: true,
      canManageUsers: true,
    },
    definition: {
      pages: [
        {
          id: PAGE_ID,
          title: 'Angaben',
          description: null,
          questions,
        },
      ],
    },
    revision: 1,
    publicSlug: 'abcdefghijklmnopqrstuv',
    hasUnpublishedChanges: false,
  };
}

function settingsDocument(): Record<string, unknown> {
  return {
    overridden: {
      avail: false,
      access: false,
      confirm: false,
      display: false,
      budget: false,
    },
    values: {},
    tenantDefaults: SYSTEM_FORM_SETTINGS,
    effective: SYSTEM_FORM_SETTINGS,
    revision: 1,
    tenantRevision: 1,
  };
}

function notification(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: '00000000-0000-4000-8000-0000000000d0',
    formId: FORM_ID,
    name: 'Bestätigung an Teilnehmer',
    triggers: ['submit'],
    format: 'text',
    toSubmitter: true,
    recipients: [],
    subject: 'Anmeldung für {{formular}}',
    body: 'Danke, {{formularorganisation}}.\n{{antworten}}',
    replyTo: null,
    effectiveReplyTo: { address: null, origin: null },
    active: true,
    createdAt: '2026-07-01T08:00:00.000Z',
    updatedAt: '2026-07-01T08:00:00.000Z',
    ...overrides,
  };
}

/** Routes every request this view makes; anything else is a test bug. */
function stubApi(
  options: {
    readonly detail?: Record<string, unknown>;
    readonly notifications?: Record<string, unknown>[];
  } = {},
): ReturnType<typeof stubFetch> {
  const fetchMock = stubFetch();
  fetchMock.mockImplementation((input) => {
    const url = requestUrl(input);
    if (url.endsWith(`/forms/${FORM_ID}`)) {
      return Promise.resolve(jsonResponse(200, options.detail ?? formDetail()));
    }
    if (url.endsWith(`/forms/${FORM_ID}/settings`)) {
      return Promise.resolve(jsonResponse(200, settingsDocument()));
    }
    if (url.endsWith(`/forms/${FORM_ID}/notifications`)) {
      return Promise.resolve(
        jsonResponse(200, {
          notifications: options.notifications ?? [notification()],
          templates: [],
          // the requirement: the two inherited levels belong to the list
          // document. This view does not evaluate them — but it parses it, and
          // `notificationListResponseSchema` is strict.
          inheritedReplyTo: [],
        }),
      );
    }
    throw new Error(`unerwartete Anfrage: ${url}`);
  });
  return fetchMock;
}

function renderPreview(canManageFormSettings = true, canBuild = true): void {
  renderWithQuery(
    <PreviewView
      formId={FORM_ID}
      tenant={TENANT}
      canBuild={canBuild}
      canManageFormSettings={canManageFormSettings}
    />,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PreviewView — der Balken', () => {
  it('nennt den Testmodus in den Worten des Handoffs', async () => {
    stubApi();
    renderPreview();

    const bar = await screen.findByTestId('test-mode-bar');
    expect(bar.textContent).toContain('● Testmodus');
    expect(bar.textContent).toContain(
      'Eingaben werden nicht gespeichert oder versendet.',
    );
  });

  it('bietet kein Zwischenspeichern an', async () => {
    // "Does not save" tolerates no exception: the button is not disabled,
    // it does not exist.
    stubApi();
    renderPreview();

    await screen.findByTestId('test-mode-bar');
    expect(screen.queryByRole('button', { name: 'Zwischenspeichern' })).toBe(
      null,
    );
  });
});

describe('PreviewView — Beispielwerte', () => {
  it('trägt gültige Werte in die Felder ein', async () => {
    stubApi();
    renderPreview();

    const field = await screen.findByLabelText<HTMLInputElement>(/Name/);
    expect(field.value).toBe('');

    fireEvent.click(
      screen.getByRole('button', { name: 'Beispielwerte eintragen' }),
    );

    const filled = await screen.findByLabelText<HTMLInputElement>(/Name/);
    expect(filled.value).toBe('Beispieltext');
  });

  it('trägt zweimal dieselben Werte ein', async () => {
    stubApi();
    renderPreview();

    await screen.findByLabelText(/Name/);
    const seed = screen.getByRole('button', {
      name: 'Beispielwerte eintragen',
    });

    fireEvent.click(seed);
    const first = (await screen.findByLabelText<HTMLInputElement>(/Name/))
      .value;
    fireEvent.click(seed);
    const second = (await screen.findByLabelText<HTMLInputElement>(/Name/))
      .value;

    expect(second).toBe(first);
  });

  it('räumt die Felder mit „erneut testen" wieder leer', async () => {
    stubApi();
    renderPreview();

    await screen.findByLabelText(/Name/);
    fireEvent.click(
      screen.getByRole('button', { name: 'Beispielwerte eintragen' }),
    );
    await screen.findByDisplayValue('Beispieltext');

    fireEvent.click(
      screen.getByRole('button', { name: '↻ Formular erneut testen' }),
    );

    const cleared = (await screen.findByLabelText<HTMLInputElement>(/Name/))
      .value;
    expect(cleared).toBe('');
  });
});

describe('PreviewView — kein gültiger Wert möglich', () => {
  /** A form with exactly one question whose rules contradict each other. */
  function brokenDetail(): Record<string, unknown> {
    return formDetail([
      question({
        id: BROKEN_ID,
        type: 'number',
        label: 'Beitrag in Euro',
        min: 0.2,
        max: 0.8,
        integer: true,
      }),
    ]);
  }

  /**
   * A rework, a review finding: the finding is a **statement about the form**,
   * not a result of an operation. Deliberately **without** a preceding click —
   * exactly the gap the existing test below does not see, because it clicks
   * beforehand.
   *
   * *Reproduction:* hang the block on a state with initial value `[]` again,
   * which only the click handler fills → this assertion turns red. Measured on
   * 2026-08-05 the finding text was invisible before the click, there after the
   * click and gone again after „↻ erneut testen".
   */
  it('benennt das Feld, bevor irgendjemand einen Knopf gedrückt hat', async () => {
    stubApi({ detail: brokenDetail() });
    renderPreview();

    expect(
      await screen.findByText(/ihre Regeln widersprechen sich vermutlich/),
    ).toBeTruthy();
    expect(screen.getByRole('listitem').textContent).toBe('Beitrag in Euro');
  });

  it('lässt den Befund stehen, wenn „erneut testen" die Felder leert', async () => {
    stubApi({ detail: brokenDetail() });
    renderPreview();

    await screen.findByText(/ihre Regeln widersprechen sich vermutlich/);
    fireEvent.click(
      screen.getByRole('button', { name: '↻ Formular erneut testen' }),
    );

    // The form does not change from that — so neither does the finding.
    expect(
      screen.getByText(/ihre Regeln widersprechen sich vermutlich/),
    ).toBeTruthy();
  });

  /**
   * The case for which Konzept no. 28 demands the generator in the first place:
   * the field is **named**, not filled. A whole number between 0.2 and 0.8 does
   * not exist — the rules of this field contradict each other, and that is a
   * finding about the form.
   */
  it('benennt das Feld, statt es zu füllen', async () => {
    stubApi({ detail: brokenDetail() });
    renderPreview();

    const field =
      await screen.findByLabelText<HTMLInputElement>(/Beitrag in Euro/);
    fireEvent.click(
      screen.getByRole('button', { name: 'Beispielwerte eintragen' }),
    );

    expect(
      await screen.findByText(/ihre Regeln widersprechen sich vermutlich/),
    ).toBeTruthy();
    expect(screen.getByRole('listitem').textContent).toBe('Beitrag in Euro');
    // And nothing entered — a value here would swallow precisely the finding.
    expect(field.value).toBe('');
  });
});

describe('PreviewView — der Testlauf verschickt nichts', () => {
  it('ruft für den Testlauf keine einzige weitere Route', async () => {
    const fetchMock = stubApi();
    renderPreview();

    await screen.findByLabelText(/Name/);
    fireEvent.click(
      screen.getByRole('button', { name: 'Beispielwerte eintragen' }),
    );
    await screen.findByDisplayValue('Beispieltext');

    const before = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Testlauf starten' }));
    await screen.findByTestId('run-nothing');

    // **Counted, not claimed.** No `POST /public/forms/:slug/responses`, no
    // draft, no mail route — there is no write path in this view that anything
    // could reach.
    expect(fetchMock.mock.calls.length).toBe(before);
    expect(
      fetchMock.mock.calls.every(
        ([, init]) => (init?.method ?? 'GET') === 'GET',
      ),
    ).toBe(true);
  });

  it('zeigt die Bestätigungsseite, die eine Teilnehmerin bekäme', async () => {
    stubApi();
    renderPreview();

    await screen.findByLabelText(/Name/);
    fireEvent.click(
      screen.getByRole('button', { name: 'Beispielwerte eintragen' }),
    );
    await screen.findByDisplayValue('Beispieltext');
    fireEvent.click(screen.getByRole('button', { name: 'Testlauf starten' }));

    expect(
      await screen.findByRole('heading', { name: 'Vielen Dank!' }),
    ).toBeTruthy();
  });

  it('listet die E-Mail, die hinausginge — mit den Werten des Probelaufs', async () => {
    stubApi();
    renderPreview();

    await screen.findByLabelText(/Name/);
    fireEvent.click(
      screen.getByRole('button', { name: 'Beispielwerte eintragen' }),
    );
    await screen.findByDisplayValue('Beispieltext');
    fireEvent.click(screen.getByRole('button', { name: 'Testlauf starten' }));

    await screen.findByTestId('run-nothing');
    expect(
      screen.getByRole('heading', { name: 'Bestätigung an Teilnehmer' }),
    ).toBeTruthy();
    expect(screen.getByTestId('preview-subject').textContent).toBe(
      'Anmeldung für Jahrestagung-Anmeldung',
    );
    // The inserted value is the one of the trial run, no example placeholder.
    expect(screen.getByTestId('preview-body').textContent).toContain(
      'Beispieltext',
    );
  });

  it('sagt es, wenn keine Benachrichtigung feuern würde', async () => {
    stubApi({ notifications: [notification({ active: false })] });
    renderPreview();

    await screen.findByLabelText(/Name/);
    fireEvent.click(
      screen.getByRole('button', { name: 'Beispielwerte eintragen' }),
    );
    await screen.findByDisplayValue('Beispieltext');
    fireEvent.click(screen.getByRole('button', { name: 'Testlauf starten' }));

    expect(await screen.findByText(/ginge keine E-Mail hinaus/)).toBeTruthy();
  });
});

describe('PreviewView — ohne das Recht „bearbeiten"', () => {
  /**
   * A rework, a review finding. "The test mode hangs off `canBuild`" stood in
   * three comments and was enforced nowhere: `PreviewViewProps` did not know
   * the property, and `/forms/<id>/preview` was fully reachable through
   * the address bar for whoever only had `canViewResponses`.
   *
   * *Reproduction:* remove the `canBuild` branch in `PreviewView` → the bar
   * stands there again and the form is loaded, although the menu hides the
   * entry.
   */
  it('zeigt den Testmodus nicht und fragt das Formular gar nicht erst ab', async () => {
    const fetchMock = stubApi();
    renderPreview(true, false);

    expect(
      await screen.findByText(
        /nur denen offen, die dieses Formular bearbeiten/,
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId('test-mode-bar')).toBe(null);
    expect(
      screen.queryByRole('button', { name: 'Beispielwerte eintragen' }),
    ).toBe(null);
    // Not a single request — neither the draft nor settings or
    // notifications.
    expect(fetchMock.mock.calls.length).toBe(0);
  });
});

describe('PreviewView — ohne das Recht „Formular-Einstellungen"', () => {
  it('fragt Einstellungen und Benachrichtigungen gar nicht erst und sagt warum', async () => {
    const fetchMock = stubApi();
    renderPreview(false);

    await screen.findByTestId('test-mode-bar');
    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    });

    expect(
      fetchMock.mock.calls.every(
        ([input]) => !requestUrl(input).includes('/settings'),
      ),
    ).toBe(true);
    expect(
      fetchMock.mock.calls.every(
        ([input]) => !requestUrl(input).includes('/notifications'),
      ),
    ).toBe(true);
    expect(
      screen.getByText(/Formular-Einstellungen/, { exact: false }),
    ).toBeTruthy();
  });
});
