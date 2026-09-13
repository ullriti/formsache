import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AI_MONTHLY_CALL_LIMIT_MAX,
  DEFAULT_AI_MONTHLY_CALL_LIMIT,
  type TenantOverviewRow,
} from '@formsache/shared';

import { jsonResponse, requestUrl, stubFetch } from '../../test/fetch-mock';
import { renderWithQuery } from '../../test/render-with-query';
import { AiQuotaSection } from './AiQuotaSection';

/**
 * **„KI-Kontingent je Organisation"** (Konzept no. 7 and no. 86).
 *
 * The server half is measured in `apps/api/test/admin/ai-quota.spec.ts` —
 * here stands the half an integration test cannot see: that the
 * way across the screen sends the **right number** to the **right address**,
 * that `0` survives this way unharmed, and that a refusal
 * arrives at the human instead of in the console.
 *
 * ## Why this file measures through `fetch` and not through a faked
 * mutation
 *
 * A stubbed `useSetAiQuota()` would only prove that the component calls *some*
 * function. The three faults that hurt here — wrong route, `0` treated as
 * „leer", number sent as a string — all live **between**
 * component and hook. That is why the real hook runs, and the stub sits at the
 * one place where it can hide nothing: `globalThis.fetch`.
 */

const TENANT_A = '00000000-0000-4000-8000-0000000000a1';
const TENANT_B = '00000000-0000-4000-8000-0000000000b2';

const QUOTA_A = 7;

function row(
  id: string,
  name: string,
  shortName: string,
  aiMonthlyCallLimit: number,
): TenantOverviewRow {
  return {
    tenant: {
      id,
      shortName,
      name,
      logoRef: null,
      branding: {
        accent: '#cea967',
        headerBg: '#212226',
        canvasBg: '#e9e6df',
        stripe: ['#212226', '#7c0800', '#cea967'],
        wideLogo: true,
      },
    },
    forms: 4,
    responses: 12,
    users: 6,
    oidcEnabled: false,
    aiMonthlyCallLimit,
  };
}

/**
 * Two Organisationen, and **neither of the two carries the default** — that is the point
 * of the fixture, not decoration. With `50` in the row the first case would go
 * green even for an interface that simply fills the field with
 * `DEFAULT_AI_MONTHLY_CALL_LIMIT` and does not read the server's answer at
 * all. Organisation B stands at `0`, because „0" and „leer" can produce the same
 * string in the number field, and precisely that must not happen.
 */
function rows(): readonly TenantOverviewRow[] {
  return [
    row(TENANT_A, 'Dachorganisation', 'DACH', QUOTA_A),
    row(TENANT_B, 'Ortsgruppe Musterstadt', 'Musterstadt', 0),
  ];
}

/** Answers every `PUT …/ai-quota` with 204 unless something else is said. */
function stubQuotaRoute(answer: () => Response = () => jsonResponse(204, {})) {
  return stubFetch().mockImplementation((input, init) => {
    if (
      (init?.method ?? 'GET') === 'PUT' &&
      requestUrl(input).endsWith('/ai-quota')
    ) {
      return Promise.resolve(answer());
    }
    return Promise.reject(
      new Error(`Unerwarteter Aufruf: ${requestUrl(input)}`),
    );
  });
}

/** All `PUT`s to the quota route, as (address, body). */
function quotaWrites(
  fetchMock: ReturnType<typeof stubFetch>,
): { url: string; body: unknown }[] {
  return fetchMock.mock.calls
    .filter(
      ([input, init]) =>
        (init?.method ?? 'GET') === 'PUT' &&
        requestUrl(input).endsWith('/ai-quota'),
    )
    .map(([input, init]) => ({
      url: requestUrl(input),
      // `requestVoid` sends the body as a JSON string (`api/http.ts`),
      // so what is read here is what actually travelled.
      body:
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as unknown)
          : undefined,
    }));
}

/** The row of one Organisation — every assurance belongs to exactly one. */
function rowOf(name: string): HTMLElement {
  const field = screen.getByLabelText(name);
  const form = field.closest('form');
  if (form === null) {
    throw new Error(`Die Zeile von „${name}“ wurde nicht gefunden.`);
  }
  return form;
}

function fieldOf(name: string): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>(name);
}

function saveIn(name: string): void {
  fireEvent.click(
    within(rowOf(name)).getByRole('button', { name: /Speichern/ }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('KI-Kontingent je Organisation', () => {
  /**
   * Assurance 1. It turns red as soon as the field shows the default (50), an
   * empty string or the value of the *other* Organisation — that is, for every
   * interface that does not read the row's `aiMonthlyCallLimit`.
   */
  it('zeigt das Kontingent der Organisation, nicht die Vorgabe', () => {
    stubQuotaRoute();
    renderWithQuery(<AiQuotaSection rows={rows()} />);

    expect(fieldOf('Dachorganisation').value).toBe(String(QUOTA_A));
    // Expressly: it is not the default value an interface without
    // server data would show.
    expect(fieldOf('Dachorganisation').value).not.toBe(
      String(DEFAULT_AI_MONTHLY_CALL_LIMIT),
    );
    // …and the second row carries its own number, not that of the first.
    expect(fieldOf('Ortsgruppe Musterstadt').value).toBe('0');
  });

  /**
   * Assurance 2. Red on a wrong address (say the Organisation's own route instead of
   * `admin/tenants/:id/ai-quota`), on a wrong method, on a wrong field name
   * and on a number that travels as a string — `aiQuotaWriteSchema` is a
   * `strictObject` with `z.number()`, the server would accept none of these
   * variants.
   */
  it('schickt PUT an die Adresse der Organisation, mit der getippten Zahl', async () => {
    const fetchMock = stubQuotaRoute();
    renderWithQuery(<AiQuotaSection rows={rows()} />);

    fireEvent.change(fieldOf('Dachorganisation'), {
      target: { value: '120' },
    });
    saveIn('Dachorganisation');

    await waitFor(() => {
      expect(quotaWrites(fetchMock)).toHaveLength(1);
    });
    const [write] = quotaWrites(fetchMock);
    expect(write?.url).toBe(`/api/admin/tenants/${TENANT_A}/ai-quota`);
    expect(write?.body).toEqual({ monthlyCallLimit: 120 });
  });

  /**
   * Assurance 3, first part: `0` is an input like any other and goes
   * out as `0`.
   *
   * The row turns red for every interface that takes `0` for „nichts eingegeben"
   * — an `if (!value) return`, a `value || DEFAULT`, a
   * `Number(value) > 0` guard. All three suggest themselves, and all three
   * would let a superadmin believe they had switched off while the old
   * quota goes on running.
   */
  it('speichert 0 als 0 — nicht als „leer“ und nicht als Vorgabe', async () => {
    const fetchMock = stubQuotaRoute();
    renderWithQuery(<AiQuotaSection rows={rows()} />);

    fireEvent.change(fieldOf('Dachorganisation'), {
      target: { value: '0' },
    });
    saveIn('Dachorganisation');

    await waitFor(() => {
      expect(quotaWrites(fetchMock)).toHaveLength(1);
    });
    expect(quotaWrites(fetchMock)[0]?.body).toEqual({ monthlyCallLimit: 0 });
  });

  /**
   * Assurance 3, second part: the label says what `0` means.
   *
   * Without that sentence „0" is the expensive misreading „unbegrenzt"
   * (`aiQuotaWriteSchema`), and a number field alone does not contradict it.
   * Red as soon as somebody shortens the sentence until only the number stands there.
   */
  it('sagt, dass 0 abschaltet und nicht „unbegrenzt“ heißt', () => {
    stubQuotaRoute();
    renderWithQuery(<AiQuotaSection rows={rows()} />);

    const note = screen.getByText(/0 schaltet die KI/);
    expect(note.textContent).toContain('für diese Organisation ab');
    expect(note.textContent).toContain('nicht „unbegrenzt“');
    // And the reference quantity, without which the number means nothing.
    expect(screen.getByText(/gilt je Kalendermonat/).textContent).toBeDefined();
  });

  /**
   * Assurance 4, part a — **the one place where the interface itself
   * refuses**, and the reason stands in the docblock of `AiQuotaRow`: `Number('')`
   * is `0`, and `0` is the off switch. Submitting an empty field would mean
   * *inventing* the most expensive value of this surface.
   *
   * Red as soon as somebody sends `Number(value)` without this check: then a
   * `PUT` with `{ monthlyCallLimit: 0 }` that nobody typed stands here.
   */
  it('verschickt ein leeres Feld nicht als 0, sondern sagt es', async () => {
    const fetchMock = stubQuotaRoute();
    renderWithQuery(<AiQuotaSection rows={rows()} />);

    fireEvent.change(fieldOf('Dachorganisation'), {
      target: { value: '' },
    });
    saveIn('Dachorganisation');

    const alert = await within(rowOf('Dachorganisation')).findByRole('alert');
    expect(alert.textContent).toContain('Bitte eine Zahl eintragen');
    expect(quotaWrites(fetchMock)).toHaveLength(0);
  });

  /**
   * Assurance 4, part b — **the server decides the limits**, and that is
   * a deliberate choice, not an omission.
   *
   * `CONTRIBUTING.md`: „Der Server validiert immer selbst – die Client-Validierung
   * ist reine UX." `NumberSetting` in `settings/SettingsControls.tsx` says it
   * expressly for every other number field of this application („was ein
   * unmöglicher Wert erzeugt, ist ein 400, der dieses Feld benennt"), and
   * `TenantDeleteConfirm` has a test of its own for the fact that the typed-out
   * name is **not** compared in the browser. A pre-check here would be a
   * new pattern in an application that already has this one — and a second
   * place where `AI_MONTHLY_CALL_LIMIT_MAX` can stand and may drift.
   *
   * The case therefore measures **both**: that the request goes out (the choice)
   * and that the refusal becomes visible (the price for it). Red if somebody
   * secretly does catch it client-side after all — then `quotaWrites` is empty.
   *
   * **And it found the bouncer nobody had built in.** On the
   * first run it was red: `min={0}`/`max={10000}` on the field are
   * constraint validation, and a `<form>` without `noValidate` then does not
   * even submit — in the browser with a fleeting speech bubble, in jsdom
   * silently. The choice „the server decides" would have stood on paper
   * and would not have held in what is shipped. That is why the form carries
   * `noValidate`, and why this line checks that something really goes out.
   */
  it('lässt eine Zahl über der Obergrenze hinaus und zeigt den 400 des Servers', async () => {
    const fetchMock = stubQuotaRoute(() =>
      jsonResponse(400, {
        message: 'Die Anfrage ist ungültig.',
        issues: [
          {
            path: 'monthlyCallLimit',
            message: 'Too big: expected number to be <=10000',
          },
        ],
        issueCount: 1,
      }),
    );
    renderWithQuery(<AiQuotaSection rows={rows()} />);

    fireEvent.change(fieldOf('Dachorganisation'), {
      target: { value: String(AI_MONTHLY_CALL_LIMIT_MAX + 1) },
    });
    saveIn('Dachorganisation');

    const alert = await within(rowOf('Dachorganisation')).findByRole('alert');
    expect(alert.textContent).toContain('ganze Zahl zwischen 0 und 10.000');
    // The server's English Zod message does **not** appear on a
    // German interface — it is the trigger, not the text.
    expect(alert.textContent).not.toContain('Too big');
    expect(quotaWrites(fetchMock)).toHaveLength(1);
    expect(quotaWrites(fetchMock)[0]?.body).toEqual({
      monthlyCallLimit: AI_MONTHLY_CALL_LIMIT_MAX + 1,
    });
    // The state does not hang on the colour of the border alone:
    // the field is marked up **and** the sentence stands next to it.
    expect(fieldOf('Dachorganisation').getAttribute('aria-invalid')).toBe(
      'true',
    );
  });

  /** The same choice in the other direction — a negative number. */
  it('lässt eine negative Zahl hinaus und zeigt den 400 des Servers', async () => {
    const fetchMock = stubQuotaRoute(() =>
      jsonResponse(400, {
        message: 'Die Anfrage ist ungültig.',
        issues: [
          {
            path: 'monthlyCallLimit',
            message: 'Too small: expected number to be >=0',
          },
        ],
        issueCount: 1,
      }),
    );
    renderWithQuery(<AiQuotaSection rows={rows()} />);

    fireEvent.change(fieldOf('Dachorganisation'), {
      target: { value: '-5' },
    });
    saveIn('Dachorganisation');

    const alert = await within(rowOf('Dachorganisation')).findByRole('alert');
    expect(alert.textContent).toContain('ganze Zahl zwischen 0 und 10.000');
    expect(quotaWrites(fetchMock)[0]?.body).toEqual({ monthlyCallLimit: -5 });
  });

  /**
   * Assurance 5. A 404 — the deleted or vanished Organisation — lands
   * at the human, not in the console.
   *
   * Red for every version that swallows the error (no `role="alert"`) or
   * that shows the meaningless default sentence instead of saying what is going on.
   */
  it('zeigt einen 404 des Servers in der Zeile, die ihn ausgelöst hat', async () => {
    stubQuotaRoute(() =>
      jsonResponse(404, { message: 'Organisation nicht gefunden.' }),
    );
    renderWithQuery(<AiQuotaSection rows={rows()} />);

    fireEvent.change(fieldOf('Ortsgruppe Musterstadt'), {
      target: { value: '9' },
    });
    saveIn('Ortsgruppe Musterstadt');

    const alert = await within(rowOf('Ortsgruppe Musterstadt')).findByRole(
      'alert',
    );
    expect(alert.textContent).toContain(
      'Diese Organisation gibt es nicht mehr.',
    );
    // The message belongs to **this** row: the other Organisation stays silent.
    expect(within(rowOf('Dachorganisation')).queryByRole('alert')).toBeNull();
  });

  /**
   * Two buttons with the same accessible name would be indistinguishable for
   * keyboard, screen reader and voice control — in a section where a
   * slip sets the budget of the wrong Organisation.
   */
  it('gibt jedem Speichern-Knopf einen eigenen zugänglichen Namen', () => {
    stubQuotaRoute();
    renderWithQuery(<AiQuotaSection rows={rows()} />);

    // Each query must hit exactly one element — a duplicate name throws
    // here (Testing Library's own strictness).
    const first = screen.getByRole('button', {
      name: 'Speichern — KI-Kontingent für Dachorganisation',
    });
    const second = screen.getByRole('button', {
      name: 'Speichern — KI-Kontingent für Ortsgruppe Musterstadt',
    });
    expect(first).not.toBe(second);
  });
});
