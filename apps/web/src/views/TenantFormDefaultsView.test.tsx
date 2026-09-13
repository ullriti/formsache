import type { ReactElement } from 'react';
import { useState } from 'react';
import {
  MAIL_BUDGET_LIMIT_MAX,
  MAIL_BUDGET_WINDOW_MIN_MAX,
  SYSTEM_FORM_SETTINGS,
  omitAvailabilityKeys,
} from '@formsache/shared';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { deferred } from '../test/deferred';
import { jsonResponse, stubFetch } from '../test/fetch-mock';
import { renderWithQuery } from '../test/render-with-query';
import { TenantFormDefaultsView } from './TenantFormDefaultsView';

/**
 * Tenant administration · Formular-Standards.
 *
 * The tab exists so that „↳ Standardwert vom Tenant" on the form points at
 * something somebody can change.
 *
 * **Without an inheritance switch, since review finding 10**, and half the
 * point of this file is the counter-check to that: no toggle „Vorgabe ⇄
 * Angepasst", no locked section, no line explaining what „Vorgabe" means.
 * Below an organisation there is no second administration, but the values
 * this application is shipped with — those stand pre-filled in the
 * fields, and the organisation changes them.
 *
 * **Four cards, not five** (ADR-0011, continuation 2026-08-14):
 * *Verfügbarkeit* belongs to the form.
 */

/** The complete set this organisation has decided on. */
const OWN_VALUES = omitAvailabilityKeys({
  ...SYSTEM_FORM_SETTINGS,
  confirmTitle: 'Standardtitel der Organisation',
  mailBudgetLimit: 300,
});

/**
 * What the server answers: **one** document and its revision.
 *
 * Complete, always — an organisation that has never saved gets the
 * application's default values inserted before the answer comes into being
 * (`parseTenantFormDefaults`).
 */
function defaultsDocument() {
  return { values: OWN_VALUES, revision: 5 };
}

function lastWrite(fetchMock: ReturnType<typeof stubFetch>): unknown {
  const writes = fetchMock.mock.calls.filter(
    ([, init]) => init?.method === 'PUT',
  );
  const last = writes[writes.length - 1];
  const body = last?.[1]?.body;
  if (typeof body !== 'string') {
    throw new Error('No PUT with a JSON body was sent.');
  }
  return JSON.parse(body);
}

const TENANT_A = '00000000-0000-4000-8000-0000000000a1';
const TENANT_B = '00000000-0000-4000-8000-0000000000b2';

const TENANTS = [
  { id: TENANT_A, name: 'Dachorganisation' },
  { id: TENANT_B, name: 'Musterstadt' },
] as const;

/**
 * The organisation switch as the shell performs it: same component, new props.
 *
 * It **toggles**, so a test can also come back to the organisation it started in —
 * which is the case a review found the hook getting wrong.
 */
function TenantSwitchHarness(): ReactElement {
  const [index, setIndex] = useState(0);
  const tenant = TENANTS[index % TENANTS.length] ?? TENANTS[0];

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setIndex((previous) => previous + 1);
        }}
      >
        Organisation wechseln
      </button>
      <TenantFormDefaultsView tenantId={tenant.id} tenantName={tenant.name} />
    </>
  );
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>('button', { name: 'Speichern' });
}

async function renderLoaded() {
  const fetchMock = stubFetch().mockResolvedValue(
    jsonResponse(200, defaultsDocument()),
  );
  renderWithQuery(
    <TenantFormDefaultsView
      tenantId={TENANT_A}
      tenantName="Dachorganisation"
    />,
  );
  await waitFor(() => {
    expect(
      screen.getByRole('heading', { name: 'Formular-Standards' }),
    ).toBeDefined();
  });
  return fetchMock;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the tenant form standards', () => {
  it('shows the four inherited sections of a form’s settings — and no Verfügbarkeit', async () => {
    await renderLoaded();

    for (const heading of [
      'Zugriff & Sicherheit',
      'Nach dem Absenden',
      'Darstellung',
      'Versandbudget',
    ]) {
      expect(screen.getByRole('heading', { name: heading })).toBeDefined();
    }
    // A deadline belongs to a form. Prescribed organisation-wide it would
    // close registrations nobody has looked at.
    expect(screen.queryByRole('heading', { name: 'Verfügbarkeit' })).toBeNull();
    expect(screen.queryByLabelText('Schließt am')).toBeNull();
  });

  /**
   * A review finding: an organisation has no way to learn the budget's ceiling
   * except by typing a large number and reading a 400. The field's own `max`
   * and the hint next to it (Konzept no. 49 — the maximum *is*
   * how „kein Limit" is spelled) close that gap without a round trip.
   */
  it('shows the mail budget’s ceiling on the field, not only on the server', async () => {
    await renderLoaded();

    const limit = screen.getByLabelText<HTMLInputElement>('Mails je Fenster');
    expect(limit.max).toBe(String(MAIL_BUDGET_LIMIT_MAX));
    expect(
      screen.getByText(
        (_, node) =>
          node?.tagName === 'P' &&
          node.textContent.includes(
            MAIL_BUDGET_LIMIT_MAX.toLocaleString('de-DE'),
          ),
      ),
    ).toBeDefined();

    const windowMin = screen.getByLabelText<HTMLInputElement>('Fensterlänge');
    expect(windowMin.max).toBe(String(MAIL_BUDGET_WINDOW_MIN_MAX));
  });

  /**
   * **No switch, no lock** (review finding 10) — the counter-check to the
   * page that existed up to 2026-08-17.
   *
   * Four questions, and every single one was the other way round before: no
   * toggle group, no locked `<fieldset>`, no explanatory line „Vorgabe
   * der Anwendung – zurückhaltend eingestellt…", and the fields carry the
   * values that apply.
   *
   * *Counter-check:* pass `inheritance` in `TenantFormDefaultsView` through to
   * `SettingsSectionCard` again → all four red.
   */
  it('has no inheritance switch and no locked section', async () => {
    await renderLoaded();

    expect(screen.queryAllByRole('radiogroup')).toEqual([]);
    expect(screen.queryByText('Angepasst')).toBeNull();
    expect(
      screen.queryByText(/Vorgabe der Anwendung – zurückhaltend eingestellt/),
    ).toBeNull();
    expect(screen.queryByText(/Standardwert vom Tenant/)).toBeNull();
    expect(
      screen.queryByText(/Beim Speichern werden die aktuellen Werte/),
    ).toBeNull();

    // Every field is there and operable — including those of the sections an
    // organisation could previously only „take over" in order to touch them.
    const progress = screen.getByLabelText<HTMLInputElement>(
      'Fortschrittsbalken anzeigen',
    );
    expect(progress.closest('fieldset')?.disabled).toBe(false);
    expect(progress.checked).toBe(SYSTEM_FORM_SETTINGS.showProgress);

    const limit = screen.getByLabelText<HTMLInputElement>('Mails je Fenster');
    expect(limit.closest('fieldset')?.disabled).toBe(false);
    expect(limit.value).toBe('300');
  });

  /**
   * Only this one tab has arrived so far. The rest of the
   * tenant administration is absent rather than shown as a disabled tab — a tab bar
   * with two dead entries promises the views behind them.
   */
  it('promises none of the tenant-administration tabs', async () => {
    await renderLoaded();

    expect(screen.queryByText(/Erscheinungsbild/)).toBeNull();
    expect(screen.queryByText(/Nutzerrechte/)).toBeNull();
    expect(screen.queryByText(/OIDC/)).toBeNull();
  });

  it('sends the changed field and the revision, and nothing else', async () => {
    const fetchMock = await renderLoaded();

    fireEvent.change(screen.getByLabelText('Mails je Fenster'), {
      target: { value: '150' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

    await waitFor(() => {
      expect(lastWrite(fetchMock)).toBeDefined();
    });
    // A patch, and no `overridden` any more: there is no section that could
    // be „not taken over" (review finding 10).
    expect(lastWrite(fetchMock)).toEqual({
      values: { mailBudgetLimit: 150 },
      revision: 5,
    });
  });

  /**
   * The data loss a review reproduced: without a tenant tag on the local patch,
   * switching organisations in the header left one organisation's edits in state while the
   * loaded document became the other's — and „Speichern" wrote them into the
   * *other* organisation's standards, the inheritance root of every form there.
   *
   * Driven through a state change in an ancestor rather than through
   * `rerender`, because that is what a tenant switch actually is: `AppShell`
   * re-renders this view with a different id, it does not remount it.
   */
  it('drops the unsaved edits of the previous Organisation when the tenant changes', async () => {
    const fetchMock = stubFetch().mockResolvedValue(
      jsonResponse(200, defaultsDocument()),
    );
    renderWithQuery(<TenantSwitchHarness />);
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Formular-Standards' }),
      ).toBeDefined();
    });

    fireEvent.change(screen.getByLabelText('Titel der Bestätigungsseite'), {
      target: { value: 'Nur für den Dachorganisation' },
    });
    expect(saveButton().disabled).toBe(false);

    fireEvent.click(
      screen.getByRole('button', { name: 'Organisation wechseln' }),
    );
    await waitFor(() => {
      expect(screen.getByText('Musterstadt')).toBeDefined();
    });

    // Nothing typed for this organisation, so nothing to save — and nothing of the
    // other organisation's on screen either.
    expect(saveButton().disabled).toBe(true);
    expect(
      screen.getByLabelText<HTMLInputElement>('Titel der Bestätigungsseite')
        .value,
    ).not.toBe('Nur für den Dachorganisation');
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT'),
    ).toBe(false);
  });

  /**
   * …and it does not come back, which is the half a review found missing.
   *
   * Hiding the stale patch behind the tag left it lying in the slot: coming back
   * to Organisation A resurrected entries typed before the switch — now over a
   * **reloaded** document with a newer revision, so „Speichern" would have
   * overwritten somebody else's write with them. The field has to read the
   * server's value again, and there has to be nothing to save.
   */
  it('does not resurrect them when the previous Organisation is opened again', async () => {
    const fetchMock = stubFetch().mockResolvedValue(
      jsonResponse(200, defaultsDocument()),
    );
    renderWithQuery(<TenantSwitchHarness />);
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Formular-Standards' }),
      ).toBeDefined();
    });

    const title = (): HTMLInputElement =>
      screen.getByLabelText<HTMLInputElement>('Titel der Bestätigungsseite');
    fireEvent.change(title(), {
      target: { value: 'Nur für den Dachorganisation' },
    });
    expect(title().value).toBe('Nur für den Dachorganisation');

    fireEvent.click(
      screen.getByRole('button', { name: 'Organisation wechseln' }),
    );
    await waitFor(() => {
      expect(screen.getByText('Musterstadt')).toBeDefined();
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Organisation wechseln' }),
    );
    await waitFor(() => {
      expect(screen.getByText('Dachorganisation')).toBeDefined();
    });

    expect(title().value).toBe(OWN_VALUES.confirmTitle);
    expect(saveButton().disabled).toBe(true);
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT'),
    ).toBe(false);
  });

  /**
   * The requirement — the same race as on the other two settings surfaces, and
   * the same shared shape behind it (`use-server-draft.ts`).
   *
   * Three different numbers on purpose: 300 was stored, 150 was saved, 777 was
   * typed while the request was on its way. A test that only asked whether the
   * field still holds *something* would be green even when the answer overwrote
   * the entry with a matching value.
   */
  describe('an entry made while the save is in flight', () => {
    async function renderWithStalledSave() {
      const pending = deferred<Response>();
      stubFetch().mockImplementation((_input, init) =>
        init?.method === 'PUT'
          ? pending.promise
          : Promise.resolve(jsonResponse(200, defaultsDocument())),
      );
      renderWithQuery(
        <TenantFormDefaultsView
          tenantId={TENANT_A}
          tenantName="Dachorganisation"
        />,
      );
      await waitFor(() => {
        expect(
          screen.getByRole('heading', { name: 'Formular-Standards' }),
        ).toBeDefined();
      });
      return pending;
    }

    function limitField(): HTMLInputElement {
      return screen.getByLabelText<HTMLInputElement>('Mails je Fenster');
    }

    function answeredWith(mailBudgetLimit: number): Response {
      return jsonResponse(200, {
        values: { ...OWN_VALUES, mailBudgetLimit },
        revision: 6,
      });
    }

    it('survives the answer, and the comparison state follows it', async () => {
      const pending = await renderWithStalledSave();

      fireEvent.change(limitField(), { target: { value: '150' } });
      fireEvent.click(saveButton());
      await waitFor(() => {
        expect(screen.getByText('Wird gespeichert…')).toBeDefined();
      });

      fireEvent.change(limitField(), { target: { value: '777' } });
      pending.resolve(answeredWith(150));

      await waitFor(() => {
        expect(screen.queryByText('Wird gespeichert…')).toBeNull();
      });
      expect(limitField().value).toBe('777');
      expect(screen.getByText('Nicht gespeichert')).toBeDefined();
    });

    /**
     * The control: with nothing typed in between, the answer *is* the new
     * baseline. The stub answers with a number nobody entered, because a stub
     * echoing the sent value could not tell „adopted" from „kept".
     */
    it('is not in the way when nothing was typed', async () => {
      const pending = await renderWithStalledSave();

      fireEvent.change(limitField(), { target: { value: '150' } });
      fireEvent.click(saveButton());
      await waitFor(() => {
        expect(screen.getByText('Wird gespeichert…')).toBeDefined();
      });

      pending.resolve(answeredWith(999));

      await waitFor(() => {
        expect(screen.getByText('Gespeichert')).toBeDefined();
      });
      expect(limitField().value).toBe('999');
    });
  });

  it('says so when the role may not see the standards', async () => {
    stubFetch().mockResolvedValue(jsonResponse(403, { message: 'nope' }));
    renderWithQuery(
      <TenantFormDefaultsView
        tenantId={TENANT_A}
        tenantName="Dachorganisation"
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(
        'darf die Formular-Standards dieser Organisation nicht sehen',
      );
    });
  });

  it('asks for an organisation before asking the server for anything', async () => {
    const fetchMock = stubFetch();
    renderWithQuery(<TenantFormDefaultsView />);

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain(
        'Bitte zuerst eine Organisation auswählen',
      );
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
