import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useBuilderStore } from '../builder/builder-store';
import { createQuestion } from '../builder/question-defaults';
import { builderPath } from '../router/routes';
import { jsonResponse, requestUrl, stubFetch } from '../test/fetch-mock';
import {
  UMBRELLA_TENANT_ID,
  membership,
  permissions,
  sessionUser,
} from '../test/fixtures';
import { renderWithQuery } from '../test/render-with-query';
import { AppShell } from './AppShell';

/**
 * **The reconstruction the requirement is built around** — the one that stops
 * data loss without a trash.
 *
 * The review finding spells the break out: *„die Übernahme in den offenen
 * Entwurf schreiben lassen"*. Nothing the dialogue does may ever land in a form
 * that already exists.
 *
 * **The setup has shifted with finding 18, the measurement has not.** The
 * opener sat in the header and was thereby reachable on *every* address,
 * over an open builder as well — exactly the situation this test reconstructed.
 * It now stands on the dashboard, beside „+ Neues Formular", and over an
 * open draft it does not exist at all any more. That is the **stronger** promise,
 * and it is measured first below; everything else runs from the dashboard.
 *
 * Two measurements, because one alone can be fulfilled by the wrong thing:
 *
 * 1. **On the screen** — the suggestion is in the dialogue and in no
 *    document: the builder store stays empty until *Übernehmen* opens a **new**
 *    form. That is the assertion that turns red when somebody loads the
 *    suggestion into the builder, as the prototype does.
 * 2. **On the requests** — in the whole run no `POST` and no `PUT` names the
 *    id of an existing form. A screen assertion alone
 *    would stay green for a write that lands in the database and only becomes
 *    visible after a reload; a request assertion alone would stay
 *    green for a store the dialogue overwrote in memory.
 *
 * The file lies here deliberately and not in `AiFormDialog.test.tsx`: the dialogue
 * on its own cannot show „no existing form is touched", because on
 * its own there is no existing one.
 */

const OPEN_FORM_ID = '019ff100-0000-7000-8000-000000000001';
const OPEN_PAGE_ID = '019ff100-0000-7000-8000-0000000000a1';
const OPEN_QUESTION_ID = '019ff100-0000-7000-8000-0000000000b1';
const NEW_FORM_ID = '019ff100-0000-7000-8000-0000000000f1';

/** The form that is **open in the builder** — with content, as required. */
function openForm(overrides: Record<string, unknown> = {}) {
  return {
    id: OPEN_FORM_ID,
    title: 'Bestandsmeldung',
    status: 'draft',
    publishedVersion: null,
    responseCount: 0,
    permissions: permissions(),
    updatedAt: '2026-08-10T09:00:00.000Z',
    revision: 7,
    publicSlug: 'sem123',
    definition: {
      pages: [
        {
          id: OPEN_PAGE_ID,
          title: 'Angaben zum Semester',
          description: null,
          questions: [
            {
              ...createQuestion('text', OPEN_QUESTION_ID),
              label: 'Organisationsname',
            },
          ],
        },
      ],
    },
    hasUnpublishedChanges: false,
    ...overrides,
  };
}

/** What the model suggests — deliberately nothing like the open form. */
function suggestion() {
  return {
    ok: true,
    title: 'Anmeldung Jahrestagung',
    quota: { used: 4, limit: 50 },
    definition: {
      pages: [
        {
          id: '019ff100-0000-7000-8000-0000000000c1',
          title: 'Ihre Daten',
          description: null,
          questions: [
            {
              ...createQuestion('text', '019ff100-0000-7000-8000-0000000000d1'),
              label: 'Vom Modell erfundene Frage',
            },
          ],
        },
      ],
    },
  };
}

/** The single empty page a freshly created form carries. */
const EMPTY_DEFINITION = {
  pages: [
    {
      id: '019ff100-0000-7000-8000-0000000000e1',
      title: 'Seite 1',
      description: null,
      questions: [],
    },
  ],
};

function newForm(definition: unknown) {
  return {
    ...openForm(),
    id: NEW_FORM_ID,
    title: 'Anmeldung Jahrestagung',
    revision: 1,
    publicSlug: 'neu123',
    definition,
  };
}

const USER = sessionUser({
  memberships: [membership(UMBRELLA_TENANT_ID, 'Dachorganisation', 'DACH')],
  aiFormsAvailable: true,
});

/** Routes everything the shell, the builder and the dialogue ask for. */
function stubEverything() {
  const calls: { method: string; url: string; body: unknown }[] = [];

  stubFetch().mockImplementation((input: unknown, init?: RequestInit) => {
    const url = requestUrl(input as RequestInfo | URL);
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      url,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });

    if (url.endsWith('/api/ai/quota')) {
      return Promise.resolve(jsonResponse(200, { used: 3, limit: 50 }));
    }
    if (url.endsWith('/api/ai/forms')) {
      return Promise.resolve(jsonResponse(200, suggestion()));
    }
    if (url.endsWith('/api/forms') && method === 'POST') {
      // What `POST /forms` answers with: a form with the one empty page it
      // starts life with — the state the `PUT` then replaces.
      return Promise.resolve(jsonResponse(201, newForm(EMPTY_DEFINITION)));
    }
    if (url.includes('/api/forms?')) {
      // The dashboard's form list — the dialogue runs from there.
      return Promise.resolve(
        jsonResponse(200, {
          items: [openForm()],
          total: 1,
          activeTotal: 0,
          responseTotal: 0,
          limit: 24,
          offset: 0,
        }),
      );
    }
    if (url.includes(`/api/forms/${NEW_FORM_ID}`)) {
      return Promise.resolve(
        jsonResponse(200, newForm(suggestion().definition)),
      );
    }
    if (url.includes(`/api/forms/${OPEN_FORM_ID}`)) {
      return Promise.resolve(jsonResponse(200, openForm()));
    }
    return Promise.resolve(jsonResponse(200, []));
  });

  return {
    calls: () => calls,
    /** Every write — the only kind of request that could destroy anything. */
    writes: () => calls.filter((call) => call.method !== 'GET'),
  };
}

/**
 * The captions of the question cards **in the builder** — not in the dialogue.
 *
 * Scoped to `question-card` on purpose: the dialogue's preview lists captions
 * too, and a bare text query could not tell „die Frage steht im Entwurf" from
 * „die Frage steht im Vorschlag", which is the exact distinction this file is
 * about.
 */
function builderQuestionLabels(): string[] {
  return screen
    .queryAllByTestId('question-card')
    .map((card) => card.textContent);
}

/** Starts the AI dialogue where it stands since finding 18: on the dashboard. */
async function runDialogFromDashboard(): Promise<void> {
  window.history.pushState({}, '', '/');
  renderWithQuery(<AppShell user={USER} />);

  fireEvent.click(await screen.findByRole('button', { name: /KI-Formular/ }));
  fireEvent.change(
    within(await screen.findByRole('dialog')).getByLabelText(
      'Beschreibung des Formulars',
    ),
    { target: { value: 'Anmeldung Jahrestagung' } },
  );
  fireEvent.click(screen.getByRole('button', { name: /Formular generieren/ }));
  await screen.findByRole('button', { name: 'Übernehmen' });
}

/**
 * The dialogue's own buttons.
 *
 * Scoped rather than queried off `screen`, and the reason is a collision worth
 * writing down: the builder's **Massenimport** panel already carries a button
 * called „Übernehmen" (`QuestionProperties.tsx`). It is closed in these tests,
 * so a bare query happens to work today — and would start matching two
 * elements the day somebody opens that panel first. The same collision is why
 * an E2E locator for this dialogue has to be scoped as well: Playwright matches
 * names as a **substring**, so „Übernehmen" there also finds „Logo
 * übernehmen".
 */
function dialogButton(name: string): HTMLElement {
  return within(screen.getByRole('dialog')).getByRole('button', { name });
}

beforeEach(() => {
  useBuilderStore.getState().reset();
});

afterEach(() => {
  window.history.pushState({}, '', '/');
  vi.restoreAllMocks();
});

describe('KI-Formular writes into no existing form', () => {
  /**
   * **The structural half, since finding 18.** Over an open draft
   * the opener does not exist — the dialogue cannot stand there in the first place.
   *
   * The builder is really loaded before the claim is checked:
   * otherwise it could also be fulfilled by a builder that never arrived.
   */
  it('cannot even be opened over an open draft', async () => {
    stubEverything();
    window.history.pushState({}, '', builderPath(OPEN_FORM_ID));
    renderWithQuery(<AppShell user={USER} />);

    await screen.findByTestId('question-card');
    expect(builderQuestionLabels().join(' ')).toContain('Organisationsname');

    expect(screen.queryByRole('button', { name: /KI-Formular/ })).toBeNull();
    // „greyed out" would leave the button standing in the tree with `disabled`;
    // this finds it either way.
    expect(
      screen
        .getAllByRole('button')
        .some((button) => button.textContent.includes('KI-Formular')),
    ).toBe(false);
  });

  /**
   * **The measurement on the screen.** Break it by loading the result into the
   * builder — the prototype's own behaviour — and the model's question stands
   * in a document instead of only in the dialogue.
   */
  it('keeps the suggestion in the dialogue and in no document', async () => {
    stubEverything();
    await runDialogFromDashboard();

    // The suggestion is in the dialogue …
    const dialog = screen.getByRole('dialog');
    expect(
      within(dialog).getByText('Vom Modell erfundene Frage'),
    ).toBeDefined();

    // … and in no draft: the builder store carries no document, and on
    // the screen there is not a single question card.
    expect(builderQuestionLabels()).toHaveLength(0);
    expect(useBuilderStore.getState().formId).toBeNull();
  });

  /**
   * *Verwerfen*: the dialogue goes, the draft stays, **and nothing was
   * written** — measured on the request log, because „the list is unchanged in
   * length" cannot be seen from a screen that never refetched.
   */
  it('writes nothing at all when the suggestion is discarded', async () => {
    const routes = stubEverything();
    await runDialogFromDashboard();

    fireEvent.click(dialogButton('Verwerfen'));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    expect(builderQuestionLabels()).toHaveLength(0);
    expect(screen.queryByText('Vom Modell erfundene Frage')).toBeNull();
    expect(useBuilderStore.getState().formId).toBeNull();

    // The only write in the whole run was the model call itself — no form was
    // created, none was changed.
    expect(routes.writes().map((call) => call.url)).toEqual(['/api/ai/forms']);
  });

  /**
   * *Übernehmen*: a **new** form, and the open one is not among the addresses
   * written to.
   *
   * The last assertion is the one that holds the requirement: it does not ask
   * „did a PUT happen?" but „did any write name the open form?". A write into
   * the open draft is exactly the shape that answers the first question the
   * same way as the correct behaviour does.
   */
  it('creates a new form and never writes to the open one', async () => {
    const routes = stubEverything();
    await runDialogFromDashboard();

    fireEvent.click(dialogButton('Übernehmen'));

    await waitFor(() => {
      expect(window.location.pathname).toBe(builderPath(NEW_FORM_ID));
    });

    const writes = routes.writes();
    expect(
      writes.filter(
        (call) => call.method === 'POST' && call.url === '/api/forms',
      ),
    ).toHaveLength(1);

    const puts = writes.filter((call) => call.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0]?.url).toBe(`/api/forms/${NEW_FORM_ID}`);

    // **The requirement, as one line.** Nothing that changes anything ever named
    // the form that already existed.
    expect(writes.some((call) => call.url.includes(OPEN_FORM_ID))).toBe(false);

    // And the revision written is the new form's, never the open draft's `7` —
    // a mixed-up revision would be a save aimed at the wrong document that
    // happened to carry the right id.
    expect(puts[0]?.body).toMatchObject({ revision: 1 });
  });
});
