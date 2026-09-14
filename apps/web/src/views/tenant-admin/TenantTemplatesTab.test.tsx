import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOTIFICATION_TEMPLATES_FLOOR } from '@formsache/shared';

import { jsonResponse, stubFetch } from '../../test/fetch-mock';
import { renderWithQuery } from '../../test/render-with-query';
import { TenantTemplatesTab } from './TenantTemplatesTab';

/**
 * **The tab *Vorlagen* of an organisation** (ADR-0032, moved here from the
 * system administration) — the surface to `PUT /tenant/notification-templates`.
 *
 * Three things a screenshot does not show:
 *
 * 1. **„Nothing decided" says so.** A row without a document shows the
 *    shipped templates — and next to them the sentence that they are the
 *    shipped ones. Without it nobody would know whether they are changing
 *    something or confirming something.
 * 2. **The lock goes out with it.** Without it the server's 409 would never
 *    be reachable, and two people editing the same organisation would
 *    silently overwrite each other.
 * 3. **What is written is the whole document**, never a single entry: the
 *    route knows no patch.
 * 4. **„Nothing decided" is saveable.** Otherwise this tab would be locked
 *    exactly where it is needed — at a row that cannot be read.
 */

function document_(overrides: Record<string, unknown> = {}) {
  return {
    templates: NOTIFICATION_TEMPLATES_FLOOR.map((entry) => ({ ...entry })),
    decided: false,
    lock: 2,
    ...overrides,
  };
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>('button', { name: 'Speichern' });
}

function bodyOf(fetchMock: ReturnType<typeof stubFetch>): unknown {
  const put = fetchMock.mock.calls.find(
    (call) => (call[1] as { method?: string } | undefined)?.method === 'PUT',
  );
  return JSON.parse(String((put?.[1] as { body?: string }).body));
}

async function renderLoaded(doc = document_()) {
  const fetchMock = stubFetch().mockResolvedValue(jsonResponse(200, doc));
  renderWithQuery(<TenantTemplatesTab tenantId="t-1" />);
  // Three templates, three identically labelled fields — `findAllBy`, and what
  // is waited for is the first one.
  await screen.findAllByLabelText('Betreff', { selector: 'input' });
  return fetchMock;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TenantTemplatesTab', () => {
  it('zeigt die ausgelieferten Vorlagen und sagt, dass es sie sind', async () => {
    await renderLoaded();

    expect(screen.getByText(/ausgelieferten Vorlagen zu sehen/u)).toBeDefined();
    for (const template of NOTIFICATION_TEMPLATES_FLOOR) {
      expect(
        screen.getByRole('heading', { name: template.name }),
      ).toBeDefined();
    }
  });

  it('sagt es anders, sobald die Zeile entscheidet', async () => {
    await renderLoaded(document_({ decided: true }));

    expect(screen.getByText(/hat eigene Vorlagen hinterlegt/u)).toBeDefined();
  });

  it('sperrt „Speichern", solange nichts geändert ist', async () => {
    await renderLoaded(document_({ decided: true }));

    expect(saveButton().disabled).toBe(true);
  });

  /**
   * **The tab has to be able to repair a broken document** — a blocking finding
   * carried over from the tab this one replaced, and the case that holds it
   * fast.
   *
   * `decided: false` means „no document **or** one that cannot be read"; the
   * server then delivers the shipped state, promising that this tab is the
   * one place at which such a thing is to be repaired. The comparison „draft
   * against document" is inevitably equal in this state — the button would
   * thus be locked exactly when it is needed, and the bar would on top of
   * that claim „Gespeichert".
   *
   * *Counter-check:* remove the `!document.decided ||` in
   * `use-tenant-notification-templates.ts` → both assertions here turn red.
   */
  it('lässt bei einem unentschiedenen Dokument sofort speichern und sagt, dass nichts hinterlegt ist', async () => {
    await renderLoaded();

    expect(saveButton().disabled).toBe(false);
    expect(
      screen.getByText(
        'Nicht hinterlegt — es gelten die ausgelieferten Vorlagen',
      ),
    ).toBeDefined();
  });

  /** And with a decided row the ordinary sentence stands there again. */
  it('sagt „Gespeichert", sobald die Zeile entscheidet und nichts geändert ist', async () => {
    await renderLoaded(document_({ decided: true }));

    expect(screen.getByText('Gespeichert')).toBeDefined();
  });

  it('schickt das ganze Dokument mit der Sperre', async () => {
    const fetchMock = await renderLoaded();

    const [subject] = screen.getAllByLabelText('Betreff', {
      selector: 'input',
    });
    if (subject === undefined) {
      throw new Error('Keine Vorlage mit einem Betreff-Feld.');
    }
    fireEvent.change(subject, { target: { value: 'Neuer Betreff' } });
    fireEvent.click(saveButton());

    await waitFor(() => {
      expect(bodyOf(fetchMock)).toBeDefined();
    });
    const body = bodyOf(fetchMock) as {
      templates: { subject: string }[];
      lock: number;
    };
    expect(body.lock).toBe(2);
    expect(body.templates).toHaveLength(NOTIFICATION_TEMPLATES_FLOOR.length);
    expect(body.templates[0]?.subject).toBe('Neuer Betreff');
  });

  /**
   * **The empty list is a decision**, not a „nothing decided": it means „this
   * organisation offers no templates". Removing must therefore be able to go
   * down to zero.
   */
  it('lässt eine Vorlage entfernen', async () => {
    // `decided: true`, so that the assertion about the button at the end says
    // something: with an undecided row it is open anyway.
    await renderLoaded(document_({ decided: true }));

    const removes = screen.getAllByRole('button', { name: 'Entfernen' });
    expect(removes).toHaveLength(NOTIFICATION_TEMPLATES_FLOOR.length);
    const [remove] = removes;
    if (remove === undefined) {
      throw new Error('Keine Vorlage zum Entfernen.');
    }
    fireEvent.click(remove);

    expect(screen.getAllByRole('button', { name: 'Entfernen' })).toHaveLength(
      NOTIFICATION_TEMPLATES_FLOOR.length - 1,
    );
    expect(saveButton().disabled).toBe(false);
  });

  /**
   * The server rejects a template without a trigger (`min(1)`); the surface says
   * so beforehand — as a hint, not as the truth.
   */
  it('sagt an der Vorlage, dass ohne Auslöser nichts gespeichert wird', async () => {
    await renderLoaded();

    const [first] = screen.getAllByLabelText('Beim Absenden');
    if (first === undefined) {
      throw new Error('Keine Vorlage mit dem Auslöser „Beim Absenden".');
    }
    fireEvent.click(first);

    expect(screen.getByText(/Ohne einen Auslöser/u)).toBeDefined();
  });

  it('sagt jemandem ohne das Recht, dass diese Ansicht ihm nicht gehört', async () => {
    stubFetch().mockResolvedValue(jsonResponse(403, { message: 'nein' }));
    renderWithQuery(<TenantTemplatesTab tenantId="t-1" />);

    expect(
      await screen.findByText(
        'Dafür fehlt dir das Recht „Einstellungen verwalten".',
      ),
    ).toBeDefined();
  });
});
