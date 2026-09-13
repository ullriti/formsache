import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { StrictMode } from 'react';

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '../api/query-client';

import {
  emptyResponse,
  jsonResponse,
  requestUrl,
  stubFetch,
} from '../test/fetch-mock';
import { renderWithQuery } from '../test/render-with-query';
import { DESKTOP_BREAKPOINT_PX } from '../styles/breakpoints';
import { leaveTo } from '../fill/leave-to';
import {
  REDIRECT_RUNNING_TEXT,
  RedirectCountdown,
} from '../fill/RedirectCountdown';
import { REQUIRED_HINT_TEXT } from '../fill/RequiredHint';
import { PublicFormView } from './PublicFormView';

/**
 * Leaving the application is the one thing this view does that jsdom cannot
 * carry out: `window.location.assign` is "not implemented" there, so a real
 * call would print a warning and prove nothing. Mocked at the module seam that
 * exists for exactly this (`fill/leave-to.ts`), which also makes „did *not*
 * navigate" assertable — the half that matters for the `javascript:` case.
 */
vi.mock('../fill/leave-to', () => ({ leaveTo: vi.fn() }));

/**
 * Filling in a form without a login.
 *
 * The server side of the same promise is covered by
 * `apps/api/test/public-forms.spec.ts`; what is asserted here is the half a
 * participant actually touches — that the questions render as fillable fields,
 * that a refusal names the field it belongs to, and that the confirmation is
 * the server's text rather than one invented in the browser.
 */

const SLUG = 'AbCdEf123456';
const NAME_ID = '019fe600-0000-7000-8000-000000000001';
const MAIL_ID = '019fe600-0000-7000-8000-000000000002';
const MEAL_ID = '019fe600-0000-7000-8000-000000000003';

function brandColor(digits: string): string {
  return `#${digits}`;
}

const TENANT = {
  name: 'Dachorganisation',
  shortName: 'DACH',
  logoRef: null,
  branding: {
    accent: brandColor('cea967'),
    headerBg: brandColor('212226'),
    canvasBg: brandColor('e9e6df'),
    stripe: ['212226', '7c0800', 'cea967'].map(brandColor),
    wideLogo: true,
  },
};

function textQuestion(
  id: string,
  label: string,
  required: boolean,
  width: 'full' | 'half' = 'full',
) {
  return {
    id,
    label,
    hint: null,
    required,
    width,
    type: 'text',
    minLength: null,
    maxLength: null,
    pattern: null,
  };
}

function page(id: string, title: string, questions: unknown[]) {
  return { id, title, questions };
}

const PAGE_ONE = '019fe600-0000-7000-8000-0000000000a1';
const PAGE_TWO = '019fe600-0000-7000-8000-0000000000a2';

/**
 * The three *Darstellung* flags as the server merges them.
 *
 * All on, because that is the system default (`SYSTEM_FORM_SETTINGS`) and
 * therefore what every form shows: the tests written earlier assert the
 * behaviour of exactly this document and must keep passing unchanged.
 */
const DISPLAY_ALL_ON = {
  showProgress: true,
  showPageNumbers: true,
  showRequiredHint: true,
};

const AVAILABILITY_OPEN = {
  state: 'open',
  opensAt: null,
  closesAt: null,
};

/**
 * The signed start of the attempt.
 *
 * Opaque, exactly as the browser treats it: the view neither reads nor renews
 * it, it only hands the same string back with the submission — which is what
 * the „sends the start token back" test below asserts.
 */
const START_TOKEN = 's1.mfa1b2c3.RGllc0lzdEVpbmVTaWduYXR1cg';

function publicForm(overrides: Record<string, unknown> = {}) {
  return {
    // The requirement — the discriminator of the read answer. `false` is „past
    // the gate, or there never was one", which is what every test in this file
    // outside the gate block assumes.
    locked: false,
    title: 'Jahrestagung 2026',
    version: 1,
    tenant: TENANT,
    display: DISPLAY_ALL_ON,
    availability: AVAILABILITY_OPEN,
    // The requirement — always present, empty for a form with no
    // Veranstaltung (`publicFormSchema`).
    eventSeats: [],
    // The requirement — whether this read offers *Zwischenspeichern*. `false`
    // is the state every test in this file assumes; the button and its address
    // are a review finding's subject.
    canSaveDraft: false,
    // Finding 32 — `null` means „no time limit", and so the line above the
    // fields stays silent; its wording stands in `fill/deadline-notice.test.ts`.
    timeLimitMin: null,
    // No form-specific privacy notice (ADR-0028 no. 4).
    privacyNotice: null,
    startToken: START_TOKEN,
    definition: {
      pages: [
        page(PAGE_ONE, 'Person', [
          textQuestion(NAME_ID, 'Name', true),
          {
            id: MAIL_ID,
            label: 'E-Mail',
            hint: 'Für die Bestätigung.',
            required: false,
            width: 'full',
            type: 'email',
          },
        ]),
      ],
    },
    ...overrides,
  };
}

const EVENT_ID = '019fe600-0000-7000-8000-000000000004';

/**
 * An event question with one entry.
 *
 * `showRemaining` on, so the payload may carry a figure at all — which is what
 * makes „das Abzeichen zeigt nach der Absage etwas anderes" observable.
 */
function eventQuestion() {
  return {
    id: EVENT_ID,
    label: 'Veranstaltungen',
    hint: null,
    required: false,
    width: 'full',
    type: 'event',
    events: [
      {
        key: 'stadtfest',
        label: 'Stadtfest',
        when: 'Sa, 20:00',
        capacity: 80,
        showRemaining: true,
      },
    ],
  };
}

/** The two-page variant, for the paging assertions. */
function twoPageForm() {
  return publicForm({
    definition: {
      pages: [
        page(PAGE_ONE, 'Person', [textQuestion(NAME_ID, 'Name', true)]),
        page(PAGE_TWO, 'Verpflegung', [
          {
            id: MEAL_ID,
            label: 'Essen',
            hint: null,
            required: false,
            width: 'full',
            type: 'radio',
            options: [
              { value: 'fleisch', label: 'Mit Fleisch' },
              { value: 'vegetarisch', label: 'Vegetarisch' },
            ],
            allowOther: false,
            otherLabel: null,
          },
        ]),
      ],
    },
  });
}

const CONFIRMATION = {
  confirmationTitle: 'Vielen Dank!',
  confirmationMessage: 'Deine Antwort wurde gespeichert.',
  redirect: null,
};

/**
 * Answers the form request, then every submission with `onSubmit`.
 *
 * Split by method rather than by call order: the view loads the form once but
 * may submit repeatedly, and an order-based stub would silently answer the
 * second attempt with the form document.
 */
function stubForm(form: unknown, onSubmit?: () => Response) {
  return stubFetch().mockImplementation((_input, init) => {
    if ((init?.method ?? 'GET') === 'GET') {
      return Promise.resolve(jsonResponse(200, form));
    }
    return Promise.resolve(onSubmit?.() ?? jsonResponse(201, CONFIRMATION));
  });
}

/**
 * The text of the **visible** page line (`showPageNumbers`).
 *
 * `getByText('Seite 1 von 2 · Person')` is what this once was, and since
 * concept no. 93 that finds two elements: the same sentence stands a second
 * time in the `role="status"` region that announces the page change — exactly
 * the same wording, because two versions of the same state could
 * drift apart (`pageLabel`). What these cases mean is the line **on the
 * screen**; the announcement has its own assertions in
 * `fill/page-change.test.tsx`.
 *
 * Grabbed by the class, as `document.querySelector('.public__page-
 * progress')` further below already is: the line is a pure display element
 * without a role and without an accessible name.
 */
function pageInfoText(): string {
  const line = document.querySelector('.public__page-info');
  return line?.textContent ?? '<keine Seitenzeile>';
}

async function renderLoaded(form: unknown, onSubmit?: () => Response) {
  const fetchMock = stubForm(form, onSubmit);
  renderWithQuery(<PublicFormView slug={SLUG} />);
  await waitFor(() => {
    expect(screen.getByRole('heading', { level: 1 })).toBeDefined();
  });
  return fetchMock;
}

describe('PublicFormView', () => {
  beforeEach(() => {
    vi.mocked(leaveTo).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the questions of the published form as fillable fields', async () => {
    await renderLoaded(publicForm());

    expect(
      screen.getByRole('heading', { level: 1, name: 'Jahrestagung 2026' }),
    ).toBeDefined();
    /*
      `getAllByText`: seit Review-Runde 3 Nr. 8 steht der Name der
      verantwortlichen Stelle in der Rechtsfußzeile in einem **eigenen**
      Element (vorher hing er mit Doppelpunkt an der versal gesetzten
      Beschriftung und passte dort auf keiner Breite hinein). Damit gibt es
      ihn zweimal auf der Seite — in der Kopfzeile und in der Fußzeile —, und
      das ist richtig so. Gemessen wird die Kopfzeile.
    */
    expect(
      screen
        .getAllByText('Dachorganisation')
        .some((node) => node.className === 'public__tenant'),
    ).toBe(true);
    expect(screen.getByLabelText(/Name/)).toBeDefined();
    // The hint is a description, never part of the accessible name — the
    // lookup by the bare label is what proves it.
    expect(screen.getByLabelText('E-Mail')).toBeDefined();
    expect(
      screen.getByLabelText('E-Mail').getAttribute('aria-describedby'),
    ).not.toBeNull();
  });

  it('shows the tenant logo at its own, larger fill-in size', async () => {
    await renderLoaded(
      publicForm({
        tenant: {
          ...TENANT,
          logoRef: { kind: 'asset', ref: 'assets/beispiel-signet.svg' },
        },
      }),
    );

    const logo = screen.getByTestId('public-tenant-logo');
    // One box for every logo format (see `PublicFormView.tsx`'s
    // `TenantHeader`) — no more `--wide`-keyed variant, so the class alone is
    // the whole contract; the sizing itself lives in the CSS layout tokens
    // `--layout-logo-width-fill`/`--layout-logo-height-fill`, which jsdom does
    // not compute.
    expect(logo.className).toBe('public__logo');
    expect(logo.getAttribute('alt')).toBe(TENANT.name);
  });

  /**
   * **The requirement, measured on the rendered page** — „das
   * hochgeladene Logo wird auf der öffentlichen, sitzungslosen Ausfüllseite
   * ausgeliefert, gemessen an der gerenderten Seite (nicht am Wire-Feld)".
   *
   * The wire half is `apps/api/test/tenant-admin/tenant-logo.spec.ts`; this is
   * the half it cannot see. The lesson it comes from is the branding finding:
   * the payload carried the organisation's colours correctly while the page rendered
   * the defaults, and every server-side assertion was green throughout.
   *
   * *Reproduction:* drop the `upload` branch from `resolveTenantLogo` → the
   * `<img>` disappears entirely and this case goes red, while the payload it
   * was built from is unchanged.
   */
  it('renders an uploaded logo from the public file route', async () => {
    await renderLoaded(
      publicForm({
        tenant: {
          ...TENANT,
          logoRef: { kind: 'upload', ref: 'iM4a5oW1hLcVKQr3jd0lZQ' },
        },
      }),
    );

    const logo = screen.getByTestId('public-tenant-logo');
    expect(logo.getAttribute('src')).toBe(
      '/api/public/files/iM4a5oW1hLcVKQr3jd0lZQ',
    );
    expect(logo.getAttribute('alt')).toBe(TENANT.name);
  });

  /**
   * The other half of the same claim, and the one that stops the first from
   * being a hole: an organisation whose logo did not pass the server's gate renders
   * **no image at all** rather than an `<img src>` built out of a column.
   *
   * The malformed-reference cases sit one layer down, in
   * `shell/tenant-logo.test.ts`: a payload carrying `javascript:…` in the
   * `upload` arm never reaches this view, because `publicTenantSchema` refuses
   * it — the resolver is the second gate, and it is measured where it can be
   * measured on its own.
   */
  it('renders no image for an organisation the gate answered null for', async () => {
    await renderLoaded(publicForm({ tenant: { ...TENANT, logoRef: null } }));

    expect(screen.queryByTestId('public-tenant-logo')).toBeNull();
  });

  /**
   * The handoff asks for a "Fortschrittsbalken" next to the page
   * numbers — before this the block was text only. `role="progressbar"` is
   * the accessible surface (`fill/PageProgressBar.tsx`); `aria-valuetext` is
   * asserted here rather than only the numeric bounds because that is the
   * sentence a screen reader actually announces.
   */
  it('shows an accessible progress bar alongside the page numbers', async () => {
    await renderLoaded(twoPageForm());

    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('1');
    expect(bar.getAttribute('aria-valuemin')).toBe('1');
    expect(bar.getAttribute('aria-valuemax')).toBe('2');
    expect(bar.getAttribute('aria-valuetext')).toBe('Seite 1 von 2 · Person');

    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: 'Anton' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe(
      '2',
    );
    expect(screen.getByRole('progressbar').getAttribute('aria-valuetext')).toBe(
      'Seite 2 von 2 · Verpflegung',
    );
  });

  /**
   * A one-page form has no "progress" to report — page 1 of 1 is always
   * full, and the bar would tell a participant nothing they do not already
   * see from the form itself — so the whole block, page numbers and bar
   * alike, stays absent exactly as it did before the bar existed.
   */
  it('shows no progress block for a form with only one page', async () => {
    await renderLoaded(publicForm());

    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByText(/^Seite 1 von 1/)).toBeNull();
  });

  /**
   * The requirement — the three *Darstellung* flags actually reach the page.
   *
   * The defect these exist for was not in this view: the server has sent
   * `display`, but the shared `publicFormSchema` did not carry the
   * two new members, and Zod drops what it does not know. Every setting an
   * editor made in the *Darstellung* section arrived in the browser and was
   * thrown away — so the first assertion below is really about
   * `packages/shared/src/public-form.ts`.
   *
   * Each flag is asserted **on and off**, and the two paging flags are
   * additionally asserted *against each other*: a single conditional around
   * both halves — which is what this view used to have — passes every "both
   * on" and "both off" case and fails only these two.
   */
  describe('Darstellung', () => {
    function twoPagesWith(display: Record<string, boolean>) {
      return { ...twoPageForm(), display: { ...DISPLAY_ALL_ON, ...display } };
    }

    it('hides the bar and keeps the page numbers on „nur Seitennummern"', async () => {
      await renderLoaded(twoPagesWith({ showProgress: false }));

      expect(screen.queryByRole('progressbar')).toBeNull();
      expect(screen.getByText('Seite 1 von 2 · Person')).toBeDefined();
    });

    it('hides the page numbers and keeps the bar on „nur Balken"', async () => {
      await renderLoaded(twoPagesWith({ showPageNumbers: false }));

      expect(screen.queryByText('Seite 1 von 2 · Person')).toBeNull();
      // The sentence is gone from the page but not from the accessible tree:
      // without it a screen reader is left with „1 von 2" and no subject.
      expect(
        screen.getByRole('progressbar').getAttribute('aria-valuetext'),
      ).toBe('Seite 1 von 2 · Person');
    });

    it('hides both when the editor turned both off', async () => {
      await renderLoaded(
        twoPagesWith({ showProgress: false, showPageNumbers: false }),
      );

      expect(screen.queryByRole('progressbar')).toBeNull();
      expect(screen.queryByText(/^Seite 1 von 2/)).toBeNull();
      // The wrapper goes with them — an empty flex column would still spend
      // the card's gap on nothing.
      expect(document.querySelector('.public__page-progress')).toBeNull();
    });

    it('shows the global required hint above the questions', async () => {
      await renderLoaded(publicForm());

      const hint = screen.getByRole('note');
      // The wording is the handoff's („Zeigt ‚* Pflichtfeld' oben im
      // Formular"), star included — a hint that lost the star would still be a
      // hint and would explain nothing.
      expect(hint.textContent).toBe(REQUIRED_HINT_TEXT);
      const firstRow = screen.getAllByTestId('public-row')[0];

      // Above, not merely present: the hint is a legend for the stars in the
      // labels below it, and one printed underneath them explains nothing.
      // Both are direct children of the card, so their order in it *is* the
      // reading order — no bit-mask arithmetic needed to say so.
      const card = Array.from(hint.parentElement?.children ?? []);
      expect(card).toContain(hint);
      expect(card).toContain(firstRow);
      expect(card.indexOf(hint)).toBeLessThan(
        card.indexOf(firstRow as Element),
      );
    });

    it('hides the required hint when the editor turned it off', async () => {
      await renderLoaded(
        publicForm({
          display: { ...DISPLAY_ALL_ON, showRequiredHint: false },
        }),
      );

      expect(screen.queryByRole('note')).toBeNull();
      // …and the per-field marking is untouched: the flag is about the legend,
      // not about which fields are required.
      expect(screen.getByLabelText(/Name/)).toBeDefined();
      fireEvent.click(screen.getByRole('button', { name: 'Absenden' }));
      expect(screen.getByText('Pflichtfeld.')).toBeDefined();
    });
  });

  it('asks nothing of a participant beyond the questions — no login', async () => {
    await renderLoaded(publicForm());

    expect(screen.queryByLabelText('E-Mail-Adresse')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Anmelden' })).toBeNull();
  });

  it('refuses to submit while a required answer is missing', async () => {
    const fetchMock = await renderLoaded(publicForm());
    const before = fetchMock.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: 'Absenden' }));

    expect(screen.getByText('Pflichtfeld.')).toBeDefined();
    // Nothing left the browser: the client check is UX, and its job here is to
    // spare the participant a round trip, not to replace the server's check.
    expect(fetchMock.mock.calls).toHaveLength(before);
  });

  it('drops the message as soon as the field is touched', async () => {
    await renderLoaded(publicForm());

    fireEvent.click(screen.getByRole('button', { name: 'Absenden' }));
    expect(screen.getByText('Pflichtfeld.')).toBeDefined();

    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: 'Anton' },
    });

    expect(screen.queryByText('Pflichtfeld.')).toBeNull();
  });

  it('sends the answers as typed and shows the server’s confirmation', async () => {
    const fetchMock = await renderLoaded(publicForm());

    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: 'Anton Aktiv' },
    });
    fireEvent.change(screen.getByLabelText('E-Mail'), {
      target: { value: 'anton@example.org' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Absenden' }));

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { level: 1, name: 'Vielen Dank!' }),
      ).toBeDefined();
    });
    expect(screen.getByText('Deine Antwort wurde gespeichert.')).toBeDefined();

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/public/forms/${SLUG}/responses`,
      expect.objectContaining({
        method: 'POST',
        // The start token of the requirement rides along with the answers, exactly
        // as it arrived. `JSON.stringify` pins the *order* too, which is why
        // the token is named here rather than in a `toMatchObject`.
        // `honeypot` is the decoy of the requirement and is sent **every**
        // time, empty for an ordinary participant: a request whose shape
        // depends on what the participant did is a request a bot can be told
        // apart from.
        body: JSON.stringify({
          answers: { [NAME_ID]: 'Anton Aktiv', [MAIL_ID]: 'anton@example.org' },
          startToken: START_TOKEN,
          honeypot: '',
        }),
      }),
    );
  });

  /**
   * The requirement — the browser is a courier for the token and nothing more.
   *
   * Asserted separately from the round trip above because the failure it guards
   * against is a different one: a view that invented, refreshed or dropped the
   * token would still send *a* submission, and the server would refuse it with
   * a message about a time limit nobody set.
   */
  it('hands the server’s own start token back, unchanged', async () => {
    const fetchMock = await renderLoaded(
      publicForm({ startToken: 's1.eigenes.Wert' }),
    );

    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: 'Anton' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Absenden' }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: 'Vielen Dank!' }));
    });

    const body = fetchMock.mock.calls.find(
      ([, init]) => init?.method === 'POST',
    )?.[1]?.body;
    // The fetch layer serialises the body itself, so it is a string here; the
    // check is what makes the parse below safe rather than hopeful.
    expect(typeof body).toBe('string');
    expect(JSON.parse(body as string) as { startToken: unknown }).toMatchObject(
      { startToken: 's1.eigenes.Wert' },
    );
  });

  /**
   * The requirement, second half — a form that cannot be handed in is not
   * offered.
   *
   * The verdict comes from the server (`availability`); the view
   * renders it. The wording of the four states is asserted next door in
   * `fill/unavailable-notice.test.ts` — what matters here is that the *form* is
   * gone, not merely that a sentence was added above it.
   */
  describe('ein geschlossenes Formular wird nicht angeboten', () => {
    async function renderState(
      availability: Record<string, unknown>,
    ): Promise<void> {
      stubForm(publicForm({ availability }));
      renderWithQuery(<PublicFormView slug={SLUG} />);
      await waitFor(() => {
        expect(screen.getByTestId('public-unavailable')).toBeDefined();
      });
    }

    it.each([
      ['closed', { state: 'closed', opensAt: null, closesAt: null }],
      [
        'not_yet_open',
        { state: 'not_yet_open', opensAt: null, closesAt: null },
      ],
      [
        'limit_reached',
        { state: 'limit_reached', opensAt: null, closesAt: null },
      ],
    ])('offers no fields and no button for %s', async (_name, availability) => {
      await renderState(availability);

      // Not „the notice is somewhere on the page": the fields and the button
      // have to be **absent**. A card added above a still-usable form would
      // pass a text assertion and fail the participant.
      expect(screen.queryByLabelText(/Name/)).toBeNull();
      expect(screen.queryByRole('button', { name: 'Absenden' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Weiter' })).toBeNull();
    });

    it('keeps the organisation’s header and the form title on the page', async () => {
      await renderState({ state: 'closed', opensAt: null, closesAt: null });

      // The participant has to be able to see *which* registration is closed —
      // a bare sentence on a blank page is a link they cannot report.
      expect(
        screen.getByRole('heading', { level: 1, name: 'Jahrestagung 2026' }),
      ).toBeDefined();
      // In der Kopfzeile, nicht irgendwo: seit Nr. 8 steht der Name auch in
      // der Rechtsfußzeile, und die trägt kein geschlossenes Formular.
      expect(
        screen
          .getAllByText(TENANT.name)
          .some((node) => node.className === 'public__tenant'),
      ).toBe(true);
    });

    it('renders the fields again as soon as the verdict is „open"', async () => {
      await renderLoaded(publicForm());

      expect(screen.queryByTestId('public-unavailable')).toBeNull();
      expect(screen.getByLabelText(/Name/)).toBeDefined();
    });
  });

  /**
   * **A failed background refetch must not throw away what was typed.**
   *
   * The case that `isError` alone does not tell apart from „es gibt nichts zu
   * zeigen": the data stands in the cache, a *second* read fails
   * (connection loss, `event_full` invalidation), and the view thereupon
   * replaced the whole page with the refusal. `FillIn` reads
   * `initialAnswers` exactly once — what the participant had typed was thereby
   * gone for good, on the one page of the application whose whole purpose is
   * typing.
   *
   * The same fault had already been fixed in `ResponseEditView`; here it was
   * still standing. The counter-check for this case is the condition itself:
   * with `query.isError` instead of `query.isError && query.data === undefined`
   * `getByLabelText(/Name/)` below finds nothing any more.
   */
  it('keeps what was typed when a background refetch fails', async () => {
    let failNext = false;
    stubFetch().mockImplementation((_input, init) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return failNext
          ? Promise.resolve(emptyResponse(500))
          : Promise.resolve(jsonResponse(200, publicForm()));
      }
      return Promise.resolve(jsonResponse(201, CONFIRMATION));
    });

    /*
     * The client of its own instead of `renderWithQuery`: this case has to be
     * **able to trigger** the refetch, and for that it needs the reference. The
     * first draft instead sent an `online` event to the window — the test
     * was green, and green **without** the fix too. The reason: TanStack listens
     * over its `onlineManager`, not at the window; there was never a second
     * read, never an error, never anything to measure. A guard with a wrong
     * precondition measures something other than what it claims.
     */
    const queryClient = createQueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <PublicFormView slug={SLUG} />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 })).toBeDefined();
    });

    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: 'Anton Mustermann' },
    });

    failNext = true;
    await act(async () => {
      await queryClient.refetchQueries();
    });

    // The error flag really has to be raised — otherwise the two lines
    // below check a state that never existed.
    expect(
      queryClient
        .getQueryCache()
        .getAll()
        .some((query) => query.state.status === 'error'),
    ).toBe(true);
    /*
     * **Wait for the rerender, and do so explicitly.** The observer is not
     * notified in the same tick after the failed refetch:
     * immediately after `refetchQueries()` the old tree is still standing, and
     * both assertions below would be green — even without the fix. Measured;
     * without this line the counter-check was worthless.
     */
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    // The refusal must not be standing there …
    expect(screen.queryByText(/konnte nicht geladen werden/)).toBeNull();
    // … and what was typed has to still be there.
    // The **property**, not the attribute: typed text stands in `.value`,
    // the attribute still carries the initial value.
    const field: HTMLInputElement = screen.getByLabelText(/Name/);
    expect(field.value).toBe('Anton Mustermann');
  });

  /**
   * the requirements — what a refused submission looks like.
   *
   * The advice is the opposite of the generic failure's: „erneut versuchen"
   * cannot help against a passed deadline, a full form or an expired attempt.
   */
  it('tells a refused submission apart from a failed one', async () => {
    await renderLoaded(publicForm(), () => emptyResponse(409));

    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: 'Anton' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Absenden' }));

    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toContain('nicht angenommen');
    expect(banner.textContent).toContain('neu laden');
    // …and specifically **not** the sentence that invites another press.
    expect(banner.textContent).not.toContain('erneut versuchen');
  });

  /**
   * **The requirement — the two refusals that are about the *attachments*, and
   * where the shared sentence above would be actively wrong.**
   *
   * „Bitte die Seite neu laden; dort steht, woran es liegt" is right for a
   * closed form and the worst possible advice here: the page says nothing about
   * it, and a reload throws away every answer typed so far **and** the
   * attachments that were fine. What a participant can actually do is pick the
   * file again (`attachment_unavailable`) or remove one (`attachment_limit`),
   * and both keep them where they are standing.
   *
   * *Reproduction:* take the two branches out of `FillIn` → both are red and
   * the generic „neu laden" sentence shows in their place.
   */
  it.each([
    ['attachment_unavailable', 'verfallen nach einem Tag', 'erneut hochladen'],
    ['attachment_limit', 'zu viele oder zu große Anhänge', 'entfernen'],
  ])(
    'tells a participant what to do about %s without sending them to a reload',
    async (reason, said, advice) => {
      await renderLoaded(publicForm(), () =>
        jsonResponse(409, { message: 'Anhang', reason }),
      );

      fireEvent.change(screen.getByLabelText(/Name/), {
        target: { value: 'Anton' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Absenden' }));

      const banner = await screen.findByRole('alert');
      expect(banner.textContent).toContain(said);
      expect(banner.textContent).toContain(advice);
      // The generic 409 sentence must not be the one shown: reloading is what
      // costs the participant everything they have typed.
      expect(banner.textContent).not.toContain('neu laden');
    },
  );

  /**
   * The requirement — the confirmation page and the redirect.
   *
   * The texts have always come from the server's answer; what changes here
   * is that they are now the *configured* ones and that a target may follow.
   * Nothing here recomputes settings in the browser, so the assertions are
   * about what the view does with an answer, not about what the answer says.
   */
  describe('Bestätigung und Weiterleitung', () => {
    afterEach(() => {
      Reflect.deleteProperty(navigator, 'clipboard');
    });

    async function submitAndConfirm(
      answer: Record<string, unknown>,
    ): Promise<void> {
      await renderLoaded(publicForm(), () => jsonResponse(200, answer));
      fireEvent.change(screen.getByLabelText(/Name/), {
        target: { value: 'Anton' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Absenden' }));
      await waitFor(() => {
        expect(screen.getByRole('heading', { level: 1 })).toBeDefined();
      });
    }

    it('shows the configured texts, not the built-in constants', async () => {
      await submitAndConfirm({
        confirmationTitle: 'Danke, Mitglied',
        confirmationMessage:
          'Die Anmeldung ist bei der Geschäftsstelle eingegangen.',
        redirect: null,
      });

      expect(
        screen.getByRole('heading', { level: 1, name: 'Danke, Mitglied' }),
      ).toBeDefined();
      expect(
        screen.getByText(
          'Die Anmeldung ist bei der Geschäftsstelle eingegangen.',
        ),
      ).toBeDefined();
      expect(screen.queryByText(/Weiterleitung in/)).toBeNull();
      expect(leaveTo).not.toHaveBeenCalled();
      // The requirement: this form does not offer editing, so there is no address
      // on the receipt. The block is absent, not empty.
      expect(screen.queryByTestId('public-edit-link')).toBeNull();
    });

    /**
     * The requirement — **the edit address is on the confirmation page**, and
     * it is the one the *server* sent.
     *
     * The assertion is deliberately on the exact string: a link this view
     * assembled from `window.location.origin` would look right in a browser and
     * be a second answer to where this installation lives — the one that goes
     * into the confirmation mail comes from `PUBLIC_BASE_URL`, and two
     * builders are two addresses.
     */
    it('shows the edit address the server sent, and lets it be copied', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
      });

      await submitAndConfirm({
        confirmationTitle: 'Vielen Dank!',
        confirmationMessage: 'Gespeichert.',
        redirect: null,
        editUrl: 'https://formulare.example.org/a/AbCd_1234-xyzAbCd_123',
      });

      const block = screen.getByTestId('public-edit-link');
      const link = within(block).getByRole('link');
      // Display text and `href` are the same string, so „Linkadresse kopieren"
      // from the browser's own menu yields what is on screen.
      expect(link.getAttribute('href')).toBe(
        'https://formulare.example.org/a/AbCd_1234-xyzAbCd_123',
      );
      expect(link.textContent).toBe(
        'https://formulare.example.org/a/AbCd_1234-xyzAbCd_123',
      );

      fireEvent.click(within(block).getByRole('button', { name: 'Kopieren' }));
      await waitFor(() => {
        expect(writeText).toHaveBeenCalledWith(
          'https://formulare.example.org/a/AbCd_1234-xyzAbCd_123',
        );
      });
      expect(
        within(block).getByText('Adresse in die Zwischenablage kopiert.'),
      ).toBeDefined();
    });

    /**
     * The failure has to be *visible*. A button that says „Kopiert" when
     * nothing was copied is worse than none — and `navigator.clipboard` is
     * absent in an insecure context, which is exactly where an organisation's office
     * machine sits.
     */
    it('says so when copying was not possible', async () => {
      // Absent, not a rejecting stub: an insecure origin leaves the property
      // undefined at runtime although the DOM types call it non-optional, and
      // that is the case an organisation's office machine actually sits in.
      Reflect.deleteProperty(navigator, 'clipboard');

      await submitAndConfirm({
        confirmationTitle: 'Vielen Dank!',
        confirmationMessage: 'Gespeichert.',
        redirect: null,
        editUrl: 'https://formulare.example.org/a/AbCd_1234-xyzAbCd_123',
      });

      const block = screen.getByTestId('public-edit-link');
      fireEvent.click(within(block).getByRole('button', { name: 'Kopieren' }));

      await waitFor(() => {
        expect(
          within(block).getByText(
            'Kopieren war nicht möglich – bitte die Adresse markieren und manuell kopieren.',
          ),
        ).toBeDefined();
      });
      expect(within(block).queryByText('Kopiert')).toBeNull();
    });

    it('counts down and then leaves for the configured target', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        await submitAndConfirm({
          confirmationTitle: 'Vielen Dank!',
          confirmationMessage: 'Gespeichert.',
          redirect: {
            url: 'https://beispielverein.de/',
            delaySec: 2,
          },
        });

        expect(screen.getByText('Weiterleitung in 2 Sekunden …')).toBeDefined();
        expect(leaveTo).not.toHaveBeenCalled();

        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_000);
        });
        // Singular, because a German sentence that says „in 1 Sekunden" is one
        // nobody wrote on purpose.
        expect(screen.getByText('Weiterleitung in 1 Sekunde …')).toBeDefined();
        expect(leaveTo).not.toHaveBeenCalled();

        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_000);
        });
        expect(leaveTo).toHaveBeenCalledWith('https://beispielverein.de/');
        // The confirmation stays put while the browser does the leaving, and
        // so does a notice — the countdown is over, the navigation is not. A
        // page that went silent here would look like nothing had happened, in
        // front of a form that has already been submitted.
        expect(
          screen.getByRole('heading', { level: 1, name: 'Vielen Dank!' }),
        ).toBeDefined();
        expect(screen.queryByText(/Weiterleitung in/)).toBeNull();
        expect(screen.getByText(REDIRECT_RUNNING_TEXT)).toBeDefined();
      } finally {
        vi.useRealTimers();
      }
    });

    /**
     * **Leaving happens once.**
     *
     * The effect had no idempotence guard, so `StrictMode` — mount, unmount,
     * mount, which is what React does in development — turned `delaySec: 0`
     * into two `location.assign` calls. Asserted with the *count*, because
     * `toHaveBeenCalledWith` is satisfied by two identical calls just as
     * happily as by one.
     */
    it('leaves exactly once, even when the effect runs twice', async () => {
      // `StrictMode` explicitly and **at the root of the render**, which is
      // where React's double-mount simulation lives: nested inside another
      // element it runs the effect once, and the test would stay green with
      // the guard taken out — measured, not assumed. `renderWithQuery` is
      // therefore the wrong helper here (its provider would be the root), and
      // this component needs no query cache anyway.
      render(
        <StrictMode>
          <RedirectCountdown
            redirect={{
              url: 'https://beispielverein.de/',
              delaySec: 0,
            }}
          />
        </StrictMode>,
      );

      await waitFor(() => {
        expect(leaveTo).toHaveBeenCalled();
      });
      expect(leaveTo).toHaveBeenCalledTimes(1);
      expect(screen.getByText(REDIRECT_RUNNING_TEXT)).toBeDefined();
    });

    /**
     * The other half of the same guard, and the one a timer bug shows up in:
     * a participant who closes the confirmation — or whom the app navigates
     * away from — mid-countdown must not be sent anywhere afterwards.
     */
    it('never leaves when the countdown is unmounted before it ends', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const { unmount } = render(
          <RedirectCountdown
            redirect={{
              url: 'https://beispielverein.de/',
              delaySec: 3,
            }}
          />,
        );

        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_000);
        });
        expect(screen.getByText('Weiterleitung in 2 Sekunden …')).toBeDefined();

        unmount();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10_000);
        });

        expect(leaveTo).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    /**
     * **The security half, seen from the browser.**
     *
     * The server refuses a `javascript:` target at both ends already — the
     * settings schema rejects it when it is saved and again when the stored
     * document is read (`packages/shared/src/form-settings.ts`). This is the
     * third gate and the only one on this side of the wire: the client cannot
     * know which version of the server answered it, and this value is the one
     * thing in the payload the browser *acts on*.
     *
     * It costs the redirect and not the confirmation — the answer is stored at
     * this point, and losing the receipt over a bad target would be the more
     * expensive failure.
     */
    it('refuses to follow a target that is not http or https', async () => {
      await submitAndConfirm({
        confirmationTitle: 'Vielen Dank!',
        confirmationMessage: 'Gespeichert.',
        redirect: { url: 'javascript:alert(1)', delaySec: 0 },
      });

      expect(leaveTo).not.toHaveBeenCalled();
      expect(screen.queryByText(/Weiterleitung in/)).toBeNull();
      expect(
        screen.getByRole('heading', { level: 1, name: 'Vielen Dank!' }),
      ).toBeDefined();
      expect(screen.getByText('Gespeichert.')).toBeDefined();
    });

    /** An answer from an older server still confirms. */
    it('shows the confirmation when the answer carries no redirect at all', async () => {
      await submitAndConfirm({
        confirmationTitle: 'Vielen Dank!',
        confirmationMessage: 'Gespeichert.',
      });

      expect(
        screen.getByRole('heading', { level: 1, name: 'Vielen Dank!' }),
      ).toBeDefined();
      expect(leaveTo).not.toHaveBeenCalled();
    });
  });

  /**
   * The decisive one for the requirement: the client is allowed to be wrong, the
   * server is not. A stub that accepts what the browser accepted could never
   * show this, so the submission is refused with a field reference the client
   * did not produce.
   */
  it('marks the field the server refused, not the one the client guessed', async () => {
    await renderLoaded(publicForm(), () =>
      jsonResponse(400, {
        message: 'Die Antwort ist ungültig.',
        issues: [{ path: MAIL_ID, message: 'Keine gültige E-Mail-Adresse.' }],
      }),
    );

    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: 'Anton' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Absenden' }));

    await waitFor(() => {
      expect(screen.getByText('Keine gültige E-Mail-Adresse.')).toBeDefined();
    });
    expect(screen.queryByRole('heading', { name: 'Vielen Dank!' })).toBeNull();
    expect(screen.getByLabelText('E-Mail').getAttribute('aria-invalid')).toBe(
      'true',
    );
  });

  /**
   * The failure mode this view had, and the worst kind: **nothing happened.**
   * The banner used to be tied to "not an `ApiError`", so a 500, a 413 or a
   * 400 that named no field rendered no message at all — the button snapped
   * back to „Absenden", the page looked untouched, and everything the
   * participant had typed was one closed tab away from gone.
   */
  it.each([
    ['a server fault', () => emptyResponse(500)],
    ['an oversized payload', () => emptyResponse(413)],
    [
      'a refusal that names no field',
      () =>
        jsonResponse(400, { message: 'Die Anfrage ist ungültig.', issues: [] }),
    ],
  ])('tells the participant about %s', async (_case, answer) => {
    await renderLoaded(publicForm(), answer);

    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: 'Anton' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Absenden' }));

    await waitFor(() => {
      expect(screen.getByText(/konnte nicht übermittelt werden/)).toBeDefined();
    });
    // And what was typed is still there to try again with.
    expect(screen.getByLabelText(/Name/)).toHaveProperty('value', 'Anton');
  });

  /**
   * The server checks the whole submission while the participant stands on the
   * last page. A field reference to an earlier page would otherwise mark an
   * input nobody can see.
   */
  it('goes back to the page carrying the field the server refused', async () => {
    await renderLoaded(twoPageForm(), () =>
      jsonResponse(400, {
        message: 'Die Antwort ist ungültig.',
        issues: [{ path: NAME_ID, message: 'So nicht.' }],
      }),
    );

    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: 'Anton' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    expect(pageInfoText()).toBe('Seite 2 von 2 · Verpflegung');

    fireEvent.click(screen.getByRole('button', { name: 'Absenden' }));

    await waitFor(() => {
      expect(pageInfoText()).toBe('Seite 1 von 2 · Person');
    });
    expect(screen.getByText('So nicht.')).toBeDefined();
  });

  /**
   * **After a refusal the tile must not go on claiming the old state.**
   *
   * The seat states are part of the *read*, and this refusal is the one that
   * proves them stale: the server has just judged the registration against a
   * newer count than the one on screen. Without the re-read the participant sees
   * a green „2 frei" beside a message about the very same Veranstaltung, and it
   * stays that way until a reload — which is exactly what this path must not
   * require, because a reload costs every answer typed so far.
   *
   * *Reproduction:* take the `onError` out of `useSubmitResponse` → the second
   * `GET` never happens and the badge keeps reading „2 frei".
   */
  it('re-reads the seat states after a refusal on a full Veranstaltung', async () => {
    let full = false;
    const fetchMock = stubFetch().mockImplementation((_input, init) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return Promise.resolve(
          jsonResponse(
            200,
            publicForm({
              eventSeats: full
                ? [{ questionId: EVENT_ID, eventKey: 'stadtfest', full: true }]
                : [
                    {
                      questionId: EVENT_ID,
                      eventKey: 'stadtfest',
                      full: false,
                      remaining: 2,
                    },
                  ],
              definition: {
                pages: [page(PAGE_ONE, 'Veranstaltungen', [eventQuestion()])],
              },
            }),
          ),
        );
      }
      // The seats were gone by the time the button was pressed.
      full = true;
      return Promise.resolve(
        jsonResponse(409, {
          message:
            'Für diese Veranstaltung sind nicht mehr genügend Plätze frei.',
          reason: 'event_full',
          position: { questionId: EVENT_ID, eventKey: 'stadtfest' },
        }),
      );
    });

    renderWithQuery(<PublicFormView slug={SLUG} />);
    await waitFor(() => {
      expect(screen.getByText('2 frei')).toBeDefined();
    });

    fireEvent.change(screen.getByLabelText('Stadtfest: Anzahl Personen'), {
      target: { value: '5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Absenden' }));

    await waitFor(() => {
      expect(screen.getByText('Ausgebucht')).toBeDefined();
    });
    expect(screen.queryByText('2 frei')).toBeNull();
    // Two reads **of the form**, one write: the refusal triggered
    // the second. Filtered on the address and not on
    // „all GETs": since ADR-0028 the footer additionally fetches the name of
    // the operator (`/api/public/legal`), and a counter over all GET requests
    // measured the footer along with them from then on.
    expect(
      fetchMock.mock.calls.filter(
        ([input, init]) =>
          (init?.method ?? 'GET') === 'GET' &&
          // `RequestInfo` is a union; this application always passes
          // a string (`http.ts`), and that stands here as a
          // condition instead of as an assumption.
          typeof input === 'string' &&
          input.includes(`/public/forms/${SLUG}`),
      ),
    ).toHaveLength(2);
    // …and nothing the participant typed was lost on the way.
    expect(
      screen.getByLabelText<HTMLInputElement>('Stadtfest: Anzahl Personen')
        .value,
    ).toBe('5');
  });

  it('explains a rate-limited submission instead of failing silently', async () => {
    await renderLoaded(publicForm(), () => emptyResponse(429));

    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: 'Anton' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Absenden' }));

    await waitFor(() => {
      expect(screen.getByText(/Zu viele Übermittlungen/)).toBeDefined();
    });
  });

  it('pages forward only once the current page is complete', async () => {
    await renderLoaded(twoPageForm());

    expect(pageInfoText()).toBe('Seite 1 von 2 · Person');
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    // Still page one — the required answer is missing.
    expect(pageInfoText()).toBe('Seite 1 von 2 · Person');

    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: 'Anton' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

    expect(pageInfoText()).toBe('Seite 2 von 2 · Verpflegung');
    expect(screen.getByLabelText('Vegetarisch')).toBeDefined();
    // The last page is the one that submits; „Weiter" is gone.
    expect(screen.getByRole('button', { name: 'Absenden' })).toBeDefined();
  });

  /**
   * Going back must not be gated: someone returning to correct an earlier
   * answer would otherwise be held on the page they are trying to leave.
   */
  it('lets a participant page back without re-validating', async () => {
    await renderLoaded(twoPageForm());

    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: 'Anton' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zurück' }));

    expect(pageInfoText()).toBe('Seite 1 von 2 · Person');
    expect(screen.getByLabelText(/Name/)).toHaveProperty('value', 'Anton');
  });

  it('says a link is gone rather than showing an empty form', async () => {
    stubFetch().mockResolvedValue(emptyResponse(404));
    renderWithQuery(<PublicFormView slug={SLUG} />);

    await waitFor(() => {
      expect(screen.getByText(/Dieses Formular gibt es nicht/)).toBeDefined();
    });
  });

  /**
   * A server fault reads differently from an expired link: „gibt es nicht"
   * would send a participant looking for a new invitation that nobody has to
   * send. The status is the only thing that tells the two apart.
   */
  it('distinguishes a broken load from a gone link', async () => {
    const fetchMock = stubFetch().mockResolvedValue(emptyResponse(500));
    renderWithQuery(<PublicFormView slug={SLUG} />);

    await waitFor(() => {
      expect(screen.getByText(/konnte nicht geladen werden/)).toBeDefined();
    });
    expect(screen.queryByText(/Dieses Formular gibt es nicht/)).toBeNull();
    // Answered once, not three times: an HTTP status is an answer, and the
    // query client retries only a lost connection.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /**
   * *Zwischenspeichern*  — the evidence. The
   * fourth API request this view now makes, `POST …/drafts`, is told apart
   * from the form read and the submission by path rather than by call order:
   * a participant may press the button any number of times on any page.
   */
  describe('Zwischenspeichern', () => {
    const DRAFT_TOKEN = 'AbCd_1234-xyzAbCd_123';
    const SAVED_DRAFT = {
      draftUrl: `https://formulare.example.org/e/${DRAFT_TOKEN}`,
      expiresAt: '2026-09-04T21:59:00.000Z',
      // Which draft was written (`savedDraftSchema.token`) — what turns the
      // second press into a `PUT` on this address instead of a second `POST`.
      token: DRAFT_TOKEN,
    };

    /**
     * Answers the form read, both draft writes and the ordinary submission —
     * each from its own path, since all of them may be in flight over the
     * lifetime of one page and a participant may save more than once.
     *
     * `onSaveDraft` answers **whichever** of the two draft writes is made, so a
     * case that hands one in says nothing about which method it expects; the
     * requests themselves are what the assertions read.
     */
    function stubFormWithDraft(
      form: unknown,
      onSaveDraft?: () => Response,
    ): ReturnType<typeof stubFetch> {
      return stubFetch().mockImplementation((input, init) => {
        if ((init?.method ?? 'GET') === 'GET') {
          return Promise.resolve(jsonResponse(200, form));
        }
        const path = requestUrl(input);
        if (path.endsWith('/drafts') || path.includes('/public/drafts/')) {
          return Promise.resolve(
            onSaveDraft?.() ?? jsonResponse(200, SAVED_DRAFT),
          );
        }
        return Promise.resolve(jsonResponse(201, CONFIRMATION));
      });
    }

    /** The body the submission went out with, parsed — `null` if none was made. */
    function submission(
      fetchMock: ReturnType<typeof stubFetch>,
    ): Record<string, unknown> | null {
      const call = fetchMock.mock.calls.find(
        ([input, init]) =>
          init?.method === 'POST' &&
          requestUrl(input).endsWith(`/forms/${SLUG}/responses`),
      );
      const body = call?.[1]?.body;
      // The fetch layer serialises the body itself, so it is a string here.
      return typeof body === 'string'
        ? (JSON.parse(body) as Record<string, unknown>)
        : null;
    }

    /** Every draft write this render made, as method + path. */
    function draftWrites(
      fetchMock: ReturnType<typeof stubFetch>,
    ): { method: string; path: string }[] {
      return fetchMock.mock.calls
        .map(([input, init]) => ({
          method: init?.method ?? 'GET',
          path: requestUrl(input),
        }))
        .filter(
          (call) =>
            call.method !== 'GET' &&
            (call.path.endsWith('/drafts') ||
              call.path.includes('/public/drafts/')),
        );
    }

    async function renderWithDraft(
      form: unknown,
      onSaveDraft?: () => Response,
    ): Promise<ReturnType<typeof stubFetch>> {
      const fetchMock = stubFormWithDraft(form, onSaveDraft);
      renderWithQuery(<PublicFormView slug={SLUG} />);
      await waitFor(() => {
        expect(screen.getByRole('heading', { level: 1 })).toBeDefined();
      });
      return fetchMock;
    }

    /**
     * The first half of the requirement, on the read that offers nothing:
     * every other test in this file renders `canSaveDraft: false`, so this
     * names the assumption instead of leaving it implicit.
     */
    it('offers no Zwischenspeichern button while the switch is off', async () => {
      await renderLoaded(publicForm());

      expect(
        screen.queryByRole('button', { name: /Zwischenspeichern/ }),
      ).toBeNull();
    });

    /**
     * the evidence — the button, the address, and both the copying and the
     * expiry it names. The address block reuses the exact
     * markup the confirmation page's edit address does
     * (`CopyableAddress` — see its own doc comment for why).
     */
    it('saves a draft and shows the copyable address with its expiry', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
      });
      try {
        await renderWithDraft(publicForm({ canSaveDraft: true }));

        // A draft may be half filled — the evidence does not ask for the
        // required field to be answered first, unlike „Absenden".
        fireEvent.change(screen.getByLabelText(/Name/), {
          target: { value: 'Anton' },
        });
        fireEvent.click(
          screen.getByRole('button', { name: 'Zwischenspeichern' }),
        );

        const block = await screen.findByTestId('public-draft-link');
        const link = within(block).getByRole('link');
        expect(link.getAttribute('href')).toBe(SAVED_DRAFT.draftUrl);
        expect(link.textContent).toBe(SAVED_DRAFT.draftUrl);
        // Konzept no. 63 — how long the address stays good, and Konzept no. 58 — that
        // no account stands behind it.
        expect(within(block).getByText(/Gültig bis/).textContent).toMatch(
          /04\.09\.2026/,
        );
        expect(within(block).getByText(/Konto/)).toBeDefined();

        fireEvent.click(
          within(block).getByRole('button', { name: 'Kopieren' }),
        );
        await waitFor(() => {
          expect(writeText).toHaveBeenCalledWith(SAVED_DRAFT.draftUrl);
        });

        // The field is untouched by the save — it is not a submission.
        expect(screen.getByLabelText<HTMLInputElement>(/Name/).value).toBe(
          'Anton',
        );
      } finally {
        Reflect.deleteProperty(navigator, 'clipboard');
      }
    });

    /**
     * the evidence, second half — the switch can flip off while somebody is
     * typing (the setting is read on *every* access, as the rule for
     * `allowEdit` states), and the resulting 409 must show the server's own
     * sentence **without** losing what was typed.
     */
    it('shows the server’s refusal and keeps the typed answer when saving is switched off mid-typing', async () => {
      await renderWithDraft(publicForm({ canSaveDraft: true }), () =>
        jsonResponse(409, {
          message: 'Zwischenspeichern ist für dieses Formular nicht möglich.',
          reason: 'saving_disabled',
        }),
      );

      fireEvent.change(screen.getByLabelText(/Name/), {
        target: { value: 'Bertha' },
      });
      fireEvent.click(
        screen.getByRole('button', { name: 'Zwischenspeichern' }),
      );

      // The server's exact sentence — not a client-composed one, and not the
      // generic 409 text the submission's own banner would show.
      const banner = await screen.findByText(
        'Zwischenspeichern ist für dieses Formular nicht möglich.',
      );
      expect(banner.getAttribute('role')).toBe('alert');
      expect(screen.getByLabelText<HTMLInputElement>(/Name/).value).toBe(
        'Bertha',
      );
      expect(screen.queryByTestId('public-draft-link')).toBeNull();
    });

    /**
     * **One participant, one draft, one address** (a review finding).
     *
     * *Measured on 2026-08-05, before the correction:* pressing
     * *Zwischenspeichern* twice → **two** `POST …/drafts`, two addresses, two
     * rows. The display replaced the first address with the second without
     * comment; the first lived on for thirty days and carried an older
     * personal state that nobody could reach any more.
     *
     * The API side of the same promise — **one** `response_draft` row — stands
     * in `apps/api/test/public/draft.spec.ts`; here stands the half that a
     * person actually triggers.
     */
    describe('a second press', () => {
      it('replaces the same draft instead of creating a second one', async () => {
        const fetchMock = await renderWithDraft(
          publicForm({ canSaveDraft: true }),
        );
        const press = async (value: string): Promise<void> => {
          fireEvent.change(screen.getByLabelText(/Name/), {
            target: { value },
          });
          fireEvent.click(
            screen.getByRole('button', { name: 'Zwischenspeichern' }),
          );
          await screen.findByTestId('public-draft-link');
        };

        await press('Anton');
        await press('Anton Rein');
        // The second write has to have been made — otherwise „one POST" would
        // also pass for a button that stopped working.
        await waitFor(() => {
          expect(draftWrites(fetchMock)).toHaveLength(2);
        });

        expect(draftWrites(fetchMock)).toStrictEqual([
          { method: 'POST', path: `/api/public/forms/${SLUG}/drafts` },
          { method: 'PUT', path: `/api/public/drafts/${DRAFT_TOKEN}` },
        ]);

        // One address on screen, and it is the one the first save minted.
        // `getAllByTestId` first: `getByTestId` throws on a second block, so
        // the count is asserted rather than assumed.
        expect(screen.getAllByTestId('public-draft-link')).toHaveLength(1);
        expect(
          within(screen.getByTestId('public-draft-link'))
            .getByRole('link')
            .getAttribute('href'),
        ).toBe(SAVED_DRAFT.draftUrl);
      });

      /**
       * The case that the change opens up: the draft disappears
       * *between* two clicks (discarded from another device, withdrawn by a
       * Zugangswort that has been set, deadline expired). The `PUT`
       * hits the one 404 of the public routes.
       *
       * The decision stands at `useDraftSaving`: the message stays up,
       * the dead address disappears from the screen, the **typed state
       * stays**, and only a *further* press creates a new draft —
       * none of that happens automatically.
       */
      it('reports a draft that vanished in between, keeps the typing, and starts a new one only on the next press', async () => {
        let saves = 0;
        const fetchMock = await renderWithDraft(
          publicForm({ canSaveDraft: true }),
          () => {
            saves += 1;
            return saves === 2
              ? emptyResponse(404)
              : jsonResponse(200, SAVED_DRAFT);
          },
        );
        const press = (): void => {
          fireEvent.click(
            screen.getByRole('button', { name: 'Zwischenspeichern' }),
          );
        };

        fireEvent.change(screen.getByLabelText(/Name/), {
          target: { value: 'Cäcilie' },
        });
        press();
        await screen.findByTestId('public-draft-link');

        press();
        const banner = await screen.findByText(/nicht mehr vorhanden/);
        expect(banner.getAttribute('role')).toBe('alert');
        // The address is gone from the screen — it leads nowhere now, and
        // leaving it up would leave the participant a way back that is not one.
        expect(screen.queryByTestId('public-draft-link')).toBeNull();
        // …and the whole point: what they typed is still in front of them.
        expect(screen.getByLabelText<HTMLInputElement>(/Name/).value).toBe(
          'Cäcilie',
        );

        press();
        await screen.findByTestId('public-draft-link');
        expect(draftWrites(fetchMock)).toStrictEqual([
          { method: 'POST', path: `/api/public/forms/${SLUG}/drafts` },
          { method: 'PUT', path: `/api/public/drafts/${DRAFT_TOKEN}` },
          // Not a retry — the participant pressed again, and there is nothing
          // left to replace, so this is a new draft with a new address.
          { method: 'POST', path: `/api/public/forms/${SLUG}/drafts` },
        ]);
      });
    });

    /**
     * **The submission names the draft it comes from** (a finding of the security review).
     *
     * Since then the Zwischenspeichern hands this participant's attachments to
     * the **draft** (`claimForDraft`). A submission without its token
     * thereby names files that the claim may no longer take — *measured
     * on 2026-08-06 over the real routes:* upload `201` →
     * save a draft `200` → submit **`409 attachment_unavailable`** for
     * a file that is two seconds old. On top of that the draft remained
     * **unconsumed**, that is, half-filled personal data for
     * up to thirty days.
     *
     * The server half — that the claim really refuses without the token and
     * does not consume the draft — stands in
     * `apps/api/test/public/draft-attachment.spec.ts`; here stands the half
     * that this page triggers: the token comes out of `useDraftSaving` and
     * goes to `useSubmitResponse`.
     *
     * *Reproduction:* leave out the fourth parameter to `useSubmitResponse` in
     * `PublicFormView` → the first case goes red, and precisely at the
     * place where a real registration with an attachment fails.
     */
    describe('der Entwurf auf der Absendung', () => {
      it('hands the token of the draft it saved to the submission', async () => {
        const fetchMock = await renderWithDraft(
          publicForm({ canSaveDraft: true }),
        );

        fireEvent.change(screen.getByLabelText(/Name/), {
          target: { value: 'Anton' },
        });
        fireEvent.click(
          screen.getByRole('button', { name: 'Zwischenspeichern' }),
        );
        await screen.findByTestId('public-draft-link');

        fireEvent.click(screen.getByRole('button', { name: 'Absenden' }));
        await waitFor(() => {
          expect(
            screen.getByRole('heading', { level: 1, name: 'Vielen Dank!' }),
          );
        });

        expect(submission(fetchMock)).toMatchObject({
          draftToken: DRAFT_TOKEN,
        });
      });

      /** An ordinary first filling-in names no draft. */
      it('names no draft when nothing was saved', async () => {
        const fetchMock = await renderWithDraft(
          publicForm({ canSaveDraft: true }),
        );
        fireEvent.change(screen.getByLabelText(/Name/), {
          target: { value: 'Berta' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Absenden' }));
        await waitFor(() => {
          expect(
            screen.getByRole('heading', { level: 1, name: 'Vielen Dank!' }),
          );
        });

        expect(submission(fetchMock)).not.toHaveProperty('draftToken');
      });

      /**
       * And the draft that no longer exists between two presses: the
       * submission **no longer** names it. That is the half a
       * handed-out token without the reset in the `onError` would lose — it
       * would carry a token that the server refuses as
       * `draft_already_submitted`, and the participant would lose their answers
       * over a draft that no longer exists.
       */
      it('names no draft any more once it vanished between two presses', async () => {
        let saves = 0;
        const fetchMock = await renderWithDraft(
          publicForm({ canSaveDraft: true }),
          () => {
            saves += 1;
            return saves === 2
              ? emptyResponse(404)
              : jsonResponse(200, SAVED_DRAFT);
          },
        );
        const press = (): void => {
          fireEvent.click(
            screen.getByRole('button', { name: 'Zwischenspeichern' }),
          );
        };

        fireEvent.change(screen.getByLabelText(/Name/), {
          target: { value: 'Cäcilie' },
        });
        press();
        await screen.findByTestId('public-draft-link');
        press();
        await screen.findByText(/nicht mehr vorhanden/);

        fireEvent.click(screen.getByRole('button', { name: 'Absenden' }));
        await waitFor(() => {
          expect(submission(fetchMock)).not.toBeNull();
        });
        expect(submission(fetchMock)).not.toHaveProperty('draftToken');
      });
    });
  });

  /**
   * Half width in the **fill-in view**.
   *
   * The point of these is that the participant sees the form the editor built:
   * the grouping comes from `rowsOf` in `@formsache/shared`, the same function the
   * builder's width invariant is written with, so a change that makes the two
   * disagree fails in `packages/shared/src/question-rows.test.ts` — what is
   * asserted here is only that this view *asks*.
   */
  describe('halbe Breite', () => {
    function rows(): HTMLElement[] {
      return screen.getAllByTestId('public-row');
    }

    /** The nth row — a helper, so no assertion needs a non-null cast. */
    function row(index: number): HTMLElement {
      const found = rows()[index];
      if (found === undefined) {
        throw new Error(`no row at index ${String(index)}`);
      }
      return found;
    }

    it('puts two half-width questions into one row', async () => {
      await renderLoaded(
        publicForm({
          definition: {
            pages: [
              page(PAGE_ONE, 'Person', [
                textQuestion(NAME_ID, 'Vorname', false, 'half'),
                textQuestion(MAIL_ID, 'Nachname', false, 'half'),
              ]),
            ],
          },
        }),
      );

      expect(rows()).toHaveLength(1);
      // `getAllByRole` yields document order, and document order *is* the tab
      // order: the row is laid out by CSS alone, nothing reorders visually.
      expect(within(row(0)).getAllByRole('textbox')).toStrictEqual([
        within(row(0)).getByLabelText('Vorname'),
        within(row(0)).getByLabelText('Nachname'),
      ]);
    });

    it('gives a full-width question a row of its own', async () => {
      await renderLoaded(publicForm());

      expect(rows()).toHaveLength(2);
      for (const row of rows()) {
        expect(within(row).getAllByRole('textbox')).toHaveLength(1);
      }
    });

    /**
     * The third half card in a run has nobody to share with — a document the
     * builder's invariant never saw, because the API accepts any width
     * combination. It gets a row to itself, and a row of one is full width by
     * layout; nothing is rewritten to achieve that.
     */
    it('renders an orphaned half-width question alone across the row', async () => {
      await renderLoaded(
        publicForm({
          definition: {
            pages: [
              page(PAGE_ONE, 'Person', [
                textQuestion(NAME_ID, 'Vorname', false, 'half'),
                textQuestion(MAIL_ID, 'Nachname', false, 'half'),
                textQuestion(MEAL_ID, 'Organisation', false, 'half'),
              ]),
            ],
          },
        }),
      );

      expect(rows()).toHaveLength(2);
      expect(within(row(0)).getAllByRole('textbox')).toHaveLength(2);
      expect(within(row(1)).getAllByRole('textbox')).toHaveLength(1);
      expect(within(row(1)).getByLabelText('Organisation')).toBeDefined();
    });

    /** A half-width choice question, to pair a group with a plain input. */
    function radioQuestion(id: string, label: string) {
      return {
        id,
        label,
        hint: null,
        required: false,
        width: 'half',
        type: 'radio',
        options: [
          { value: 'fleisch', label: 'Mit Fleisch' },
          { value: 'vegetarisch', label: 'Vegetarisch' },
        ],
        allowOther: false,
        otherLabel: null,
      };
    }

    /**
     * A row of two *different* kinds of question.
     *
     * The fixtures above pair two text fields, which is the easy case: one
     * input each, both the same height. A choice question brings a whole
     * `role="group"` with wrapping option captions into half a card — the case
     * `min-width: 0` exists for — and it is invisible to a `textbox` query, so
     * a grouping that dropped it would not even be noticed above.
     */
    it('pairs a choice question with a text field in one row', async () => {
      await renderLoaded(
        publicForm({
          definition: {
            pages: [
              page(PAGE_ONE, 'Person', [
                textQuestion(NAME_ID, 'Vorname', false, 'half'),
                radioQuestion(MEAL_ID, 'Verpflegung'),
              ]),
            ],
          },
        }),
      );

      expect(rows()).toHaveLength(1);
      expect(within(row(0)).getByLabelText('Vorname')).toBeDefined();
      expect(
        within(row(0)).getByRole('group', { name: 'Verpflegung' }),
      ).toBeDefined();
      expect(within(row(0)).getByLabelText('Vegetarisch')).toBeDefined();
    });

    /**
     * The message is what the CSS comment promises it is: something that makes
     * one column taller, not something that breaks the row apart. Without this
     * the claim in `public-form-view.css` is checked by nobody.
     */
    it('keeps a row intact when one of its fields is marked invalid', async () => {
      await renderLoaded(
        publicForm({
          definition: {
            pages: [
              page(PAGE_ONE, 'Person', [
                textQuestion(NAME_ID, 'Vorname', true, 'half'),
                textQuestion(MAIL_ID, 'Nachname', false, 'half'),
              ]),
            ],
          },
        }),
      );

      fireEvent.click(screen.getByRole('button', { name: 'Absenden' }));

      await waitFor(() => {
        expect(screen.getByText('Pflichtfeld.')).toBeDefined();
      });

      // Still one row, still both fields in it — and the message inside it,
      // under the field it belongs to.
      expect(rows()).toHaveLength(1);
      expect(within(row(0)).getAllByRole('textbox')).toHaveLength(2);
      expect(within(row(0)).getByText('Pflichtfeld.')).toBeDefined();
    });

    /**
     * Paging is the one thing that can serve a stale grouping: `rows` is
     * memoised on the current page, so a wrong dependency would show page one's
     * layout with page two's questions.
     */
    it('groups the rows of the page that is actually shown', async () => {
      await renderLoaded(
        publicForm({
          definition: {
            pages: [
              page(PAGE_ONE, 'Person', [textQuestion(NAME_ID, 'Name', false)]),
              page(PAGE_TWO, 'Anschrift', [
                textQuestion(MAIL_ID, 'Straße', false, 'half'),
                textQuestion(MEAL_ID, 'Hausnummer', false, 'half'),
              ]),
            ],
          },
        }),
      );

      expect(rows()).toHaveLength(1);
      expect(within(row(0)).getAllByRole('textbox')).toHaveLength(1);

      fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

      expect(rows()).toHaveLength(1);
      expect(within(row(0)).getAllByRole('textbox')).toStrictEqual([
        within(row(0)).getByLabelText('Straße'),
        within(row(0)).getByLabelText('Hausnummer'),
      ]);
    });

    /**
     * Stacking below the breakpoint is a **CSS** rule — the document keeps its
     * `width: 'half'`, exactly as in the builder, so a wider window restores
     * the layout. jsdom evaluates no media queries, so the rule is asserted on
     * the stylesheet itself (the same approach `styles/tokens.test.ts` takes);
     * the measurement that two fields really do not overflow a phone is the
     * Playwright case in `e2e/public-form-rows.spec.ts`.
     */
    it('stacks the row below the one desktop breakpoint', () => {
      const css = readFileSync(
        resolve(process.cwd(), 'src/views/public-form-view.css'),
        'utf8',
      );

      // Not a literal 1179: the number has one home (`styles/breakpoints.ts`),
      // and a media query that drifts away from it would stack at a width
      // where the shell and the builder do not.
      const query = `@media (max-width: ${String(DESKTOP_BREAKPOINT_PX - 1)}px)`;
      const start = css.indexOf(query);
      expect(start).toBeGreaterThan(-1);

      // Cut at the end of the **block**, not at the end of the file.
      // `flex-direction: column` appears elsewhere in this stylesheet, so a
      // slice running to EOF stayed green with the rule deleted from the media
      // query — the one regression this test exists to catch.
      const block = css.slice(start, css.indexOf('\n}\n', start));

      expect(block).toContain('.public__row');
      expect(block).toContain('flex-direction: column');
      // The cross axis has to come with it. Turning the row into a column
      // while `align-items` stays at `flex-start` leaves every field as wide
      // as its own label — measured, not imagined: 189 px of a 344 px card on
      // a 360 px screen, in the right place and a third of the width. The
      // Playwright case asserts the pixels; this one names the rule.
      expect(block).toContain('align-items: stretch');
    });
  });
  /**
   * The requirement — the password gate, from the participant's side.
   *
   * **What this block can and cannot prove.** It cannot prove the protection:
   * the questions are withheld by the server, and every test here is driving a
   * stubbed `fetch`. What it does prove is the half that is genuinely the
   * browser's — that the word goes into a **body**, that the proof is attached
   * to the requests that need it, and that nothing about a locked answer is
   * rendered as a form.
   */
  describe('the password gate', () => {
    const LOCKED = { locked: true, title: 'Jahrestagung 2026', tenant: TENANT };
    const PROOF = 'p1.mfa1b2c3.RGFzSXN0RGVyTmFjaHdlaXM';

    /**
     * Answers a locked read until the gate is passed, then the open form.
     *
     * Keyed on the proof header rather than on call order: the view reloads the
     * form after unlocking, and an order-based stub would answer that reload
     * with whatever came next instead of with what the header asked for — which
     * is exactly the behaviour under test.
     */
    function stubGate(onUnlock?: () => Response) {
      return stubFetch().mockImplementation((_input, init) => {
        const method = init?.method ?? 'GET';
        if (method === 'GET') {
          const headers = (init?.headers ?? {}) as Record<string, string>;
          return Promise.resolve(
            jsonResponse(
              200,
              headers['X-Form-Access'] === PROOF ? publicForm() : LOCKED,
            ),
          );
        }
        return Promise.resolve(
          onUnlock?.() ?? jsonResponse(200, { accessToken: PROOF }),
        );
      });
    }

    async function renderGate(onUnlock?: () => Response) {
      const fetchMock = stubGate(onUnlock);
      renderWithQuery(<PublicFormView slug={SLUG} />);
      await waitFor(() => {
        expect(screen.getByLabelText('Zugangswort')).toBeDefined();
      });
      return fetchMock;
    }

    /**
     * The rendering half of bullet 1: a locked answer produces a gate and
     * **not** a form. Asserted with `queryBy…().toBeNull()` for the questions,
     * because „shows the gate" alone would also be true of a page that showed
     * both.
     */
    it('shows the gate instead of the questions', async () => {
      await renderGate();

      expect(
        screen.getByRole('heading', { level: 1, name: 'Jahrestagung 2026' }),
      ).toBeDefined();
      expect(
        screen
          .getAllByText('Dachorganisation')
          .some((node) => node.className === 'public__tenant'),
      ).toBe(true);
      expect(screen.getByText(/passwortgeschützt/)).toBeDefined();

      expect(screen.queryByLabelText(/^Name/)).toBeNull();
      expect(screen.queryByLabelText('E-Mail')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Absenden' })).toBeNull();
    });

    /** The field is a password field, not a text field over somebody's shoulder. */
    it('hides the word while it is typed', async () => {
      await renderGate();

      expect(screen.getByLabelText('Zugangswort').getAttribute('type')).toBe(
        'password',
      );
    });

    /**
     * **Bullet 6, in the browser.** The word travels in the body of a `POST`
     * and the URL carries nothing but the address — asserted on the request the
     * view actually made, not on the code that made it.
     */
    it('sends the word in the body of a POST and never in the URL', async () => {
      const fetchMock = await renderGate();

      fireEvent.change(screen.getByLabelText('Zugangswort'), {
        target: { value: 'Jahrestagung2026' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

      await waitFor(() => {
        expect(
          fetchMock.mock.calls.some(([, init]) => init?.method === 'POST'),
        ).toBe(true);
      });

      const call = fetchMock.mock.calls.find(
        ([, options]) => options?.method === 'POST',
      );
      // The fetch layer takes a string path and serialises the body itself, so
      // both are strings here; asserting that is what makes the checks below
      // measurements rather than hopes.
      const url = call?.[0];
      const body = call?.[1]?.body;
      expect(typeof url).toBe('string');
      expect(typeof body).toBe('string');

      expect(url).toBe(`/api/public/forms/${SLUG}/access`);
      expect(url as string).not.toContain('Jahrestagung2026');
      expect(JSON.parse(body as string)).toEqual({
        password: 'Jahrestagung2026',
      });
    });

    /**
     * The whole flow: word in, questions out — and the proof rides along on the
     * reload. The stub answers on the header alone, so a view that dropped the
     * proof would stay on the gate forever.
     */
    it('shows the questions once the word was accepted', async () => {
      await renderGate();

      fireEvent.change(screen.getByLabelText('Zugangswort'), {
        target: { value: 'Jahrestagung2026' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

      await waitFor(() => {
        expect(screen.getByLabelText(/^Name/)).toBeDefined();
      });
      expect(screen.queryByLabelText('Zugangswort')).toBeNull();
    });

    /**
     * …and the proof is on the **submission** as well, which is the request the
     * server refuses without it. A view that attached it only to the read would
     * pass every test above and fail at the one moment that costs a
     * participant their answers.
     */
    it('carries the proof on the submission too', async () => {
      const fetchMock = await renderGate();

      fireEvent.change(screen.getByLabelText('Zugangswort'), {
        target: { value: 'Jahrestagung2026' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
      await waitFor(() => {
        expect(screen.getByLabelText(/^Name/)).toBeDefined();
      });

      fireEvent.change(screen.getByLabelText(/^Name/), {
        target: { value: 'Anton' },
      });
      fetchMock.mockImplementation((_input, init) =>
        Promise.resolve(
          (init?.method ?? 'GET') === 'GET'
            ? jsonResponse(200, publicForm())
            : jsonResponse(200, CONFIRMATION),
        ),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Absenden' }));

      await waitFor(() => {
        expect(screen.getByText('Vielen Dank!')).toBeDefined();
      });

      const [, submitInit] =
        fetchMock.mock.calls.findLast(
          ([url, options]) =>
            options?.method === 'POST' &&
            typeof url === 'string' &&
            url.endsWith('/responses'),
        ) ?? [];
      expect(
        (submitInit?.headers as Record<string, string> | undefined)?.[
          'X-Form-Access'
        ],
      ).toBe(PROOF);
    });

    /**
     * The refusal, and the one place the client deliberately says more than the
     * server: the API answers a wrong word byte-identically to an unknown
     * address („Dieses Formular gibt es nicht."), which would be a baffling
     * thing to show somebody who has the form in front of them. The browser
     * already knows the form is real, so it says the useful sentence.
     */
    it('names a wrong word without repeating the server’s 404 wording', async () => {
      await renderGate(() => emptyResponse(404));

      fireEvent.change(screen.getByLabelText('Zugangswort'), {
        target: { value: 'falsch' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('Zugangswort stimmt nicht');
      expect(alert.textContent).not.toContain('gibt es nicht');
      // …and the gate stays up.
      expect(screen.getByLabelText('Zugangswort')).toBeDefined();
      expect(screen.queryByLabelText(/^Name/)).toBeNull();
    });

    /**
     * **The message belongs to the field, not just to the page.**
     *
     * `role="alert"` reads the sentence out once, when it appears — and then it
     * is gone. Somebody who tabs back into the input to correct their typing,
     * which is the very next thing anybody does, hears the label and nothing
     * else unless the field itself says it is at fault. `FieldInput.tsx` does
     * this correctly for every question of a form; the gate did not.
     */
    it('ties the refusal to the input for a screen reader', async () => {
      await renderGate(() => emptyResponse(404));

      const field = screen.getByLabelText('Zugangswort');
      // Before the attempt the field is not marked as faulty…
      expect(field.getAttribute('aria-invalid')).toBe('false');
      expect(field.getAttribute('aria-describedby')).toBeNull();

      fireEvent.change(field, { target: { value: 'falsch' } });
      fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

      const alert = await screen.findByRole('alert');
      expect(field.getAttribute('aria-invalid')).toBe('true');
      // …and afterwards it points at the very element carrying the sentence.
      expect(field.getAttribute('aria-describedby')).toBe(alert.id);
      expect(alert.id).not.toBe('');
    });

    it('says so when the address ran out of attempts', async () => {
      await renderGate(() => emptyResponse(429));

      fireEvent.change(screen.getByLabelText('Zugangswort'), {
        target: { value: 'falsch' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('Zu viele Versuche');
    });

    /**
     * The proof is never written anywhere the next person on this machine could
     * find it. A public form is filled in on borrowed devices — an organisation's office
     * computer, a phone passed around — and a proof in `localStorage` would
     * leave the next visitor in front of an open registration.
     */
    it('keeps the proof out of localStorage and out of the cookie jar', async () => {
      await renderGate();

      fireEvent.change(screen.getByLabelText('Zugangswort'), {
        target: { value: 'Jahrestagung2026' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
      await waitFor(() => {
        expect(screen.getByLabelText(/^Name/)).toBeDefined();
      });

      expect(window.localStorage.length).toBe(0);
      expect(window.sessionStorage.length).toBe(0);
      expect(document.cookie).not.toContain(PROOF);
      expect(document.cookie).not.toContain('Jahrestagung2026');
    });
  });
});
