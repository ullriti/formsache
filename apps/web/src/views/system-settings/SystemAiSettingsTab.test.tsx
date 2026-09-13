import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AI_MODEL_CHOICES,
  AI_PRECONDITIONS,
  DEFAULT_AI_MODEL,
} from '@formsache/shared';

import { jsonResponse, stubFetch } from '../../test/fetch-mock';
import { renderWithQuery } from '../../test/render-with-query';
import { SystemAiSettingsTab } from './SystemAiSettingsTab';

/**
 * *KI-Anbieter* .
 *
 * Four things are held here that a screenshot does not show:
 *
 * 1. The key field **never** carries the saved value, and leaving it empty
 *    sends no key at all (not `null` — that would mean „entfernen").
 * 2. The five preconditions appear **when a provider is chosen for the first
 *    time**, not only on saving — the moment meant
 *    lies *before* the first call to an outside provider.
 * 3. The region is a **selection** with exactly three values.
 * 4. The lock counter goes out with it, otherwise the server's 409 would never
 *    be reachable.
 */

const EMPTY = {
  enabled: true,
  provider: null,
  model: null,
  region: 'eu',
  apiKeySet: false,
};

const CONFIGURED = {
  enabled: true,
  provider: 'anthropic',
  model: null,
  region: 'eu',
  apiKeySet: true,
};

function document_(
  values: Record<string, unknown> = EMPTY,
  overrides: Record<string, unknown> = {},
) {
  return { values, gap: null, lock: 4, ...overrides };
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>('button', { name: 'Speichern' });
}

/**
 * Change something, so that „Speichern" works at all.
 *
 * ⚠️ **Since 2026-08-18 the save bar locks the button as long as nothing
 * has been changed** (ADR-0022, continuation: the tab now uses
 * `SettingsSaveBar` like every other settings page, instead of carrying a button
 * of its own that always worked). The cases below test **what** goes out
 * — so they need a change that does not interest them. The region is
 * the right one for that: it is exactly the field that gives the model's escape hatch
 * its name („der Betreiber änderte sein laufendes Modell, weil er die
 * Region angefasst hat").
 */
function touchRegion(): void {
  fireEvent.change(screen.getByLabelText('Region'), {
    target: { value: 'us' },
  });
}

async function renderLoaded(doc = document_()) {
  const fetchMock = stubFetch().mockResolvedValue(jsonResponse(200, doc));
  renderWithQuery(<SystemAiSettingsTab />);
  await screen.findByText('KI-Anbieter');
  await waitFor(() => {
    expect(screen.getByLabelText('Anbieter')).toBeDefined();
  });
  return fetchMock;
}

function bodyOf(fetchMock: ReturnType<typeof stubFetch>): unknown {
  const put = fetchMock.mock.calls.find(
    (call) => (call[1] as { method?: string } | undefined)?.method === 'PUT',
  );
  return JSON.parse(String((put?.[1] as { body?: string }).body));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SystemAiSettingsTab', () => {
  it('zeigt drei Regionen und keine freie Adresse', async () => {
    await renderLoaded();
    const region = screen.getByLabelText<HTMLSelectElement>('Region');
    expect(region.tagName).toBe('SELECT');
    expect([...region.options].map((option) => option.value)).toEqual([
      'eu',
      'global',
      'us',
    ]);
    expect(region.value).toBe('eu');
  });

  /**
   * **The moment before the first call to an outside provider.**
   * *Reproduction:* move the condition to „beim Speichern" → this
   * case goes red, and the operator would read the preconditions only after they have
   * taken the decision.
   */
  it('zeigt die fünf Vorbedingungen beim erstmaligen Wählen eines Anbieters', async () => {
    await renderLoaded();
    for (const line of AI_PRECONDITIONS) {
      expect(screen.queryByText(line)).toBeNull();
    }

    fireEvent.change(screen.getByLabelText('Anbieter'), {
      target: { value: 'anthropic' },
    });

    for (const line of AI_PRECONDITIONS) {
      expect(screen.getByText(line)).toBeDefined();
    }
    expect(AI_PRECONDITIONS).toHaveLength(5);
  });

  /**
   * And **not** with an installation that already has a provider: the
   * list is a hint for the first decision, no permanent banner that
   * one overlooks after the third time.
   */
  it('zeigt sie nicht, wenn schon ein Anbieter eingerichtet ist', async () => {
    await renderLoaded(document_(CONFIGURED));
    expect(screen.queryByText(AI_PRECONDITIONS[0] ?? '')).toBeNull();
  });

  it('trägt den gespeicherten Schlüssel nicht im Feld und sendet ihn nicht mit', async () => {
    const fetchMock = await renderLoaded(document_(CONFIGURED));
    const key = screen.getByLabelText<HTMLInputElement>('API-Schlüssel');
    expect(key.value).toBe('');
    expect(key.type).toBe('password');

    touchRegion();
    fireEvent.click(saveButton());
    await waitFor(() => {
      expect(bodyOf(fetchMock)).toBeDefined();
    });
    const body = bodyOf(fetchMock) as Record<string, unknown>;
    // **Not sent along**, not `null`: `null` would mean „entfernen".
    expect(body).not.toHaveProperty('apiKey');
    expect(body.lock).toBe(4);
  });

  it('schickt einen neu eingegebenen Schlüssel mit', async () => {
    const fetchMock = await renderLoaded(document_(CONFIGURED));
    fireEvent.change(screen.getByLabelText('API-Schlüssel'), {
      target: { value: 'sk-neu' },
    });
    fireEvent.click(saveButton());
    await waitFor(() => {
      expect(bodyOf(fetchMock)).toBeDefined();
    });
    expect((bodyOf(fetchMock) as Record<string, unknown>).apiKey).toBe(
      'sk-neu',
    );
  });

  /**
   * The half configuration is a **display** and no start abort —
   * earlier it took the installation down.
   */
  it('benennt die Lücke einer halben Konfiguration', async () => {
    await renderLoaded(
      document_({ ...CONFIGURED, apiKeySet: false }, { gap: 'apiKey' }),
    );
    expect(
      screen.getByText(/kein Schlüssel hinterlegt/i, { selector: 'p' }),
    ).toBeDefined();
  });

  /**
   * **The model field is a selection** (addendum to ADR-0015 no. 5).
   *
   * *Reproduction:* replace the `select` by an `input type="text"` again
   * → this case goes red. The difference is not cosmetic: a
   * mistyped `claude-opus-4` was saved in the text field and only stood out
   * at the first form draft as a 404 of the provider.
   */
  it('bietet die Modelle des Anbieters zur Auswahl an, statt sie tippen zu lassen', async () => {
    await renderLoaded(document_(CONFIGURED));
    const model = screen.getByLabelText<HTMLSelectElement>('Modell');
    expect(model.tagName).toBe('SELECT');
    expect([...model.options].map((option) => option.value)).toEqual([
      '',
      ...AI_MODEL_CHOICES.anthropic.map((choice) => choice.id),
    ]);
    // The empty option names *which* model the default is — otherwise one would choose
    // „Vorgabe" and would not know what one takes with it.
    expect(model.options[0]?.textContent).toContain(DEFAULT_AI_MODEL.anthropic);
  });

  /**
   * **The list changes with the provider — and the old value does not stay
   * standing.**
   *
   * `claude-opus-5` under Mistral is no half-right value but a
   * configuration that can be saved and fails only at the first draft with
   * an error message of the outside service.
   */
  it('setzt das Modell zurück, wenn der Anbieter wechselt', async () => {
    const fetchMock = await renderLoaded(
      document_({ ...CONFIGURED, model: 'claude-sonnet-5' }),
    );
    expect(screen.getByLabelText<HTMLSelectElement>('Modell').value).toBe(
      'claude-sonnet-5',
    );

    fireEvent.change(screen.getByLabelText('Anbieter'), {
      target: { value: 'mistral' },
    });

    const model = screen.getByLabelText<HTMLSelectElement>('Modell');
    expect(model.value).toBe('');
    expect([...model.options].map((option) => option.value)).toEqual([
      '',
      ...AI_MODEL_CHOICES.mistral.map((choice) => choice.id),
    ]);

    fireEvent.click(saveButton());
    await waitFor(() => {
      expect(bodyOf(fetchMock)).toBeDefined();
    });
    const body = bodyOf(fetchMock) as Record<string, unknown>;
    expect(body.provider).toBe('mistral');
    // `null` means „nimm die Vorgabe des Anbieters" — not the Anthropic value.
    expect(body.model).toBeNull();
  });

  /**
   * **A saved value outside the list survives** — otherwise the
   * mere opening and saving of this page would silently pull an installation from the
   * free-text era onto a different model.
   */
  it('behält eine hinterlegte Kennung, die Liste nicht führt', async () => {
    const fetchMock = await renderLoaded(
      document_({ ...CONFIGURED, model: 'claude-opus-4-1-20250805' }),
    );
    const model = screen.getByLabelText<HTMLSelectElement>('Modell');
    expect(model.value).toBe('claude-opus-4-1-20250805');
    expect(
      screen.getByText(/steht nicht in der Auswahl/i, { selector: 'p' }),
    ).toBeDefined();

    touchRegion();
    fireEvent.click(saveButton());
    await waitFor(() => {
      expect(bodyOf(fetchMock)).toBeDefined();
    });
    expect((bodyOf(fetchMock) as Record<string, unknown>).model).toBe(
      'claude-opus-4-1-20250805',
    );
  });

  /**
   * **The round trip A → B → A must not cost the old identifier**
   * (review follow-up, 2026-08-12).
   *
   * The reset on a provider change first wrote `''` — "I have chosen the
   * default". So whoever misclicked and **set it back** sent
   * `model: null` at the next save and ran on
   * `claude-opus-5` from then on, without anything having warned them: the hint had
   * already disappeared at the first change. That is verbatim the damage the
   * escape hatch is meant to prevent.
   *
   * *Counter-test:* unconditionally `setModel('')` in the handler again → this case
   * goes red and names `null`.
   */
  it('behält die Altkennung, wenn der Anbieter gewechselt und zurückgestellt wird', async () => {
    const fetchMock = await renderLoaded(
      document_({ ...CONFIGURED, model: 'claude-opus-4-1-20250805' }),
    );
    const provider = screen.getByLabelText('Anbieter');

    fireEvent.change(provider, { target: { value: 'mistral' } });
    expect(screen.getByLabelText<HTMLSelectElement>('Modell').value).toBe('');

    fireEvent.change(provider, { target: { value: 'anthropic' } });
    expect(screen.getByLabelText<HTMLSelectElement>('Modell').value).toBe(
      'claude-opus-4-1-20250805',
    );
    expect(
      screen.getByText(/steht nicht in der Auswahl/i, { selector: 'p' }),
    ).toBeDefined();

    // After A → B → A the draft stands on the saved state again, so there would
    // be nothing to save. The region makes it dirty — and in exactly
    // this saving the old identifier would earlier have been lost.
    touchRegion();
    fireEvent.click(saveButton());
    await waitFor(() => {
      expect(bodyOf(fetchMock)).toBeDefined();
    });
    expect((bodyOf(fetchMock) as Record<string, unknown>).model).toBe(
      'claude-opus-4-1-20250805',
    );
  });

  it('lässt das Modellfeld ohne Anbieter nicht bedienen', async () => {
    await renderLoaded();
    const model = screen.getByLabelText<HTMLSelectElement>('Modell');
    expect(model.disabled).toBe(true);
    expect(screen.queryByText(/steht nicht in der Auswahl/i)).toBeNull();
  });

  /**
   * **Without a provider nothing is „weiter benutzt" either.**
   *
   * The state can be produced via the API (`provider: null` next to a
   * `model`), and the hint claimed in it that the identifier was in use —
   * `resolveAiConfig` delivers `null` here, nothing at all is used.
   */
  it('behauptet ohne Anbieter nicht, ein hinterlegtes Modell sei in Gebrauch', async () => {
    await renderLoaded(
      document_({ ...EMPTY, model: 'claude-opus-4-1-20250805' }),
    );
    expect(screen.queryByText(/steht nicht in der Auswahl/i)).toBeNull();
  });

  /**
   * **The save bar is now the common one** (ADR-0022, continuation
   * 2026-08-18). That is a deliberate change of behaviour: earlier the
   * button always worked and also sent a round when it had nothing to say.
   */
  it('sperrt „Speichern", solange nichts geändert ist', async () => {
    await renderLoaded(document_(CONFIGURED));
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText('Gespeichert')).toBeDefined();

    touchRegion();

    expect(saveButton().disabled).toBe(false);
    expect(screen.getByText('Nicht gespeichert')).toBeDefined();
  });

  it('sagt einem Nicht-Superadmin, dass die Ansicht ihm nicht gehört', async () => {
    stubFetch().mockResolvedValue(jsonResponse(403, { message: 'nein' }));
    renderWithQuery(<SystemAiSettingsTab />);
    expect(
      await screen.findByText('Diese Ansicht ist Superadmins vorbehalten.'),
    ).toBeDefined();
  });
});
