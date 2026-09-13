import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { QuestionType } from '@formsache/shared';

import { createQuestion } from '../builder/question-defaults';
import { jsonResponse, requestUrl, stubFetch } from '../test/fetch-mock';
import { permissions } from '../test/fixtures';
import { renderWithQuery } from '../test/render-with-query';
import { AiFormDialog } from './AiFormDialog';

/**
 * „✦ KI-Formular" — the dialogue and, above all, **the step the prototype does
 * not have** .
 *
 * The four things this file checks, and what each one here actually measures:
 *
 * 1. **Vorschau** — the pages, questions and types of the answer are on the
 *    screen, together with *Übernehmen* and *Verwerfen*. Measured on the
 *    rendered DOM, not on the state.
 * 2. **A new form, never an open draft** — measured on the **requests**: a
 *    `POST /api/forms` and a `PUT` to *that* new id. The counter-check lives in
 *    `AppShell.test.tsx`, where a builder with content is on screen while this
 *    runs.
 * 3. **Verwerfen created nothing** — measured on the **request log**, not on
 *    the screen: after pressing it, no request was made to any form route at
 *    all. „Die Liste ist unverändert lang" is the same statement seen from the
 *    other side, and this side cannot be satisfied by a list that merely failed
 *    to refetch.
 * 4. **Cancelling leaves nothing half** — the `fetch` was aborted, and the
 *    answer that arrives anyway does not open a preview.
 *
 * Plus the browser half of „the answer is data, never markup": a question
 * caption containing `<script>` lands as **text**, asserted against
 * `document.querySelector('script')` and against the caption's own
 * `textContent`.
 */

const NEW_FORM_ID = '019ff000-0000-7000-8000-0000000000f1';

/**
 * A model answer with two pages, three questions and three types.
 *
 * The questions come from `createQuestion` rather than from hand-written
 * literals: the shared schema demands every field of a variant, and a fixture
 * spelled out here would have to be corrected by hand every time a question
 * type gains one — which is how a fixture ends up describing a payload the
 * application never sees.
 */
function suggestion(overrides: Record<string, unknown> = {}) {
  const question = (
    type: QuestionType,
    id: string,
    label: string,
  ): Record<string, unknown> => ({
    ...createQuestion(type, id),
    label,
  });

  return {
    ok: true,
    title: 'Anmeldung Jahrestagung',
    quota: { used: 4, limit: 50 },
    definition: {
      pages: [
        {
          id: '019ff000-0000-7000-8000-0000000000a1',
          title: 'Ihre Daten',
          description: null,
          questions: [
            question('text', '019ff000-0000-7000-8000-0000000000b1', 'Vorname'),
            question(
              'email',
              '019ff000-0000-7000-8000-0000000000b2',
              'E-Mail-Adresse',
            ),
          ],
        },
        {
          id: '019ff000-0000-7000-8000-0000000000a2',
          title: 'Veranstaltungen',
          description: null,
          questions: [
            question(
              'checkbox',
              '019ff000-0000-7000-8000-0000000000b3',
              'Teilnahme an',
            ),
          ],
        },
      ],
    },
    ...overrides,
  };
}

/** The `FormDetail` `POST /api/forms` answers with. */
function createdForm(overrides: Record<string, unknown> = {}) {
  return {
    id: NEW_FORM_ID,
    title: 'Anmeldung Jahrestagung',
    status: 'draft',
    publishedVersion: null,
    responseCount: 0,
    permissions: permissions(),
    updatedAt: '2026-08-10T10:00:00.000Z',
    revision: 1,
    publicSlug: 'neu123',
    // The empty page `POST /forms` starts a form with — a document with no
    // page at all is not one `formDefinitionSchema` accepts.
    definition: {
      pages: [
        {
          id: '019ff000-0000-7000-8000-0000000000e1',
          title: 'Seite 1',
          description: null,
          questions: [],
        },
      ],
    },
    hasUnpublishedChanges: false,
    ...overrides,
  };
}

interface Routes {
  /** The answer of `POST /api/ai/forms`, or a promise the test resolves later. */
  readonly generate?: unknown;
  readonly generateResponse?: Promise<Response>;
  readonly generateStatus?: number;
}

/**
 * Routes the four addresses this dialogue can reach and **records every call**.
 *
 * The recording is the instrument of the evidence: „nichts angelegt" is a
 * statement about requests, and a test that only looked at the screen would
 * stay green for an adoption that wrote into the wrong form.
 */
function stubRoutes(routes: Routes = {}) {
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
      if (routes.generateResponse !== undefined) {
        return routes.generateResponse;
      }
      return Promise.resolve(
        jsonResponse(routes.generateStatus ?? 200, routes.generate ?? {}),
      );
    }
    if (url.endsWith('/api/forms') && method === 'POST') {
      return Promise.resolve(jsonResponse(201, createdForm()));
    }
    if (url.includes('/api/forms/') && method === 'PUT') {
      return Promise.resolve(
        jsonResponse(200, createdForm({ definition: suggestion().definition })),
      );
    }
    return Promise.resolve(jsonResponse(200, []));
  });

  return {
    /** Every call whose address is about a form — the ones that could create one. */
    formCalls: () => calls.filter((call) => call.url.includes('/api/forms')),
    calls: () => calls,
  };
}

function open(onClose = vi.fn()) {
  renderWithQuery(<AiFormDialog onClose={onClose} />);
  return { onClose };
}

/** Types a prompt and presses „✦ Formular generieren". */
function generate(prompt = 'Anmeldung mit Kontaktfeldern'): void {
  fireEvent.change(screen.getByLabelText('Beschreibung des Formulars'), {
    target: { value: prompt },
  });
  fireEvent.click(screen.getByRole('button', { name: /Formular generieren/ }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AiFormDialog — the free text', () => {
  it('offers the three examples and fills the field with one', () => {
    stubRoutes();
    open();

    fireEvent.click(
      screen.getByRole('button', { name: 'Seminaranmeldung mit Kurswahl' }),
    );

    expect(
      screen.getByLabelText<HTMLTextAreaElement>('Beschreibung des Formulars')
        .value,
    ).toContain('Auswahl eines von mehreren Seminaren');
  });

  /**
   * A button that sends an empty prompt spends a counted call on nothing —
   * and the server would answer 400 after the fact.
   */
  it('refuses to send an empty prompt', () => {
    stubRoutes();
    open();

    expect(
      screen
        .getByRole('button', { name: /Formular generieren/ })
        .hasAttribute('disabled'),
    ).toBe(true);
  });

  /**
   * Konzept no. 86: the organisation **sees** its consumption. The counter-check is in the
   * same assertion — there is no control that could change it.
   */
  it('shows consumption as information, with nothing to set it with', async () => {
    stubRoutes();
    open();

    await screen.findByText(/3 von 50 Aufrufen verbraucht/);
    // …and nothing to set it with. A settable Kontingent would be a number
    // field, and the organisation does not get one: the number is the
    // Superadmin's.
    expect(screen.queryByRole('spinbutton')).toBeNull();
  });
});

describe('AiFormDialog — the evidence: the result is a preview', () => {
  it('names pages, questions and types, and offers Übernehmen and Verwerfen', async () => {
    stubRoutes({ generate: suggestion() });
    open();
    generate();

    await screen.findByText('Seite 1: Ihre Daten');
    expect(screen.getByText('Seite 2: Veranstaltungen')).toBeDefined();
    expect(screen.getByText('Vorname')).toBeDefined();
    expect(screen.getByText('E-Mail-Adresse')).toBeDefined();
    expect(screen.getByText('Teilnahme an')).toBeDefined();
    // The **types**, in the words the builder uses for them.
    expect(screen.getByText('Text')).toBeDefined();
    expect(screen.getByText('E-Mail')).toBeDefined();
    expect(screen.getByText('Mehrfachauswahl')).toBeDefined();
    expect(screen.getByText(/2 Seiten · 3 Fragen/)).toBeDefined();

    expect(screen.getByRole('button', { name: 'Übernehmen' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Verwerfen' })).toBeDefined();
  });

  /**
   * The name is the editor's, prefilled from the model — the same rule „aus
   * einer Vorlage anlegen" follows.
   */
  it('prefills the name from the suggestion and lets it be changed', async () => {
    const routes = stubRoutes({ generate: suggestion() });
    open();
    generate();

    const field = await screen.findByLabelText<HTMLInputElement>(
      'Name des neuen Formulars',
    );
    expect(field.value).toBe('Anmeldung Jahrestagung');

    fireEvent.change(field, { target: { value: 'BT 2027' } });
    fireEvent.click(screen.getByRole('button', { name: 'Übernehmen' }));

    await waitFor(() => {
      expect(
        routes
          .formCalls()
          .some(
            (call) =>
              call.method === 'POST' &&
              (call.body as { title?: string }).title === 'BT 2027',
          ),
      ).toBe(true);
    });
  });

  /** A model that named no title falls back to the first page, not to nothing. */
  it('falls back to the first page title when the model named none', async () => {
    stubRoutes({ generate: suggestion({ title: null }) });
    open();
    generate();

    expect(
      (
        await screen.findByLabelText<HTMLInputElement>(
          'Name des neuen Formulars',
        )
      ).value,
    ).toBe('Ihre Daten');
  });
});

describe('AiFormDialog — the evidence: Übernehmen creates a new form', () => {
  /**
   * **The reconstruction of the requirement, seen from the requests.**
   *
   * Break it by writing the adoption into an open draft — a `PUT` to a form id
   * that came from anywhere but this run's `POST` — and this goes red on the
   * first assertion: the only `PUT` allowed here is the one to the id the
   * creation just returned.
   */
  it('posts a new form and fills exactly that one', async () => {
    const routes = stubRoutes({ generate: suggestion() });
    const { onClose } = open();
    generate();

    await screen.findByRole('button', { name: 'Übernehmen' });
    fireEvent.click(screen.getByRole('button', { name: 'Übernehmen' }));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });

    const writes = routes.formCalls();
    const created = writes.filter(
      (call) => call.method === 'POST' && call.url.endsWith('/api/forms'),
    );
    const filled = writes.filter((call) => call.method === 'PUT');

    expect(created).toHaveLength(1);
    expect(filled).toHaveLength(1);
    // Not „some PUT happened" — a PUT to *this* id, the one the creation
    // answered with. A PUT to any other form is the data loss the review
    // finding is about.
    expect(filled[0]?.url).toContain(`/api/forms/${NEW_FORM_ID}`);
    expect(filled[0]?.body).toMatchObject({
      title: 'Anmeldung Jahrestagung',
      revision: 1,
    });
    // And it carries the suggestion, not an empty document.
    expect(
      (filled[0]?.body as { definition: { pages: unknown[] } }).definition
        .pages,
    ).toHaveLength(2);

    expect(window.location.pathname).toContain(NEW_FORM_ID);
  });

  /**
   * The failure of the second request is named rather than swallowed — and the
   * suggestion stays on screen, so nothing is lost while it is being retried.
   */
  it('keeps the preview when the creation is refused', async () => {
    const routes = stubRoutes({ generate: suggestion() });
    open();
    generate();

    await screen.findByRole('button', { name: 'Übernehmen' });
    routes.calls();
    stubFetch().mockImplementation((input: unknown) => {
      const url = requestUrl(input as RequestInfo | URL);
      if (url.endsWith('/api/forms')) {
        return Promise.resolve(jsonResponse(403, { message: 'nope' }));
      }
      return Promise.resolve(jsonResponse(200, { used: 4, limit: 50 }));
    });

    fireEvent.click(screen.getByRole('button', { name: 'Übernehmen' }));

    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain(
      'darf keine Formulare anlegen',
    );
    // Still there: nothing has been thrown away, and the button can be pressed
    // again once the reason is gone.
    expect(screen.getByText('Seite 1: Ihre Daten')).toBeDefined();
  });
});

describe('AiFormDialog — the evidence: Verwerfen created nothing', () => {
  /**
   * Measured on the **request log**, which is the only place „nichts angelegt"
   * is visible. Break it by having *Verwerfen* create a form „so the editor can
   * find it again" and this goes red — the screen would look identical.
   */
  it('makes no request to any form route', async () => {
    const routes = stubRoutes({ generate: suggestion() });
    const { onClose } = open();
    generate();

    await screen.findByRole('button', { name: 'Verwerfen' });
    fireEvent.click(screen.getByRole('button', { name: 'Verwerfen' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(routes.formCalls()).toHaveLength(0);
    // The only two addresses this run touched are the model's and the quota's.
    for (const call of routes.calls()) {
      expect(call.url).toMatch(/\/api\/ai\/(forms|quota)$/);
    }
  });

  /**
   * A stray click outside must not do what *Verwerfen* does silently — the
   * suggestion cost a counted call, and „das Fenster ist einfach weg" is the
   * worst way to spend one.
   */
  it('does not close on a click outside while the preview stands', async () => {
    stubRoutes({ generate: suggestion() });
    const { onClose } = open();
    generate();

    await screen.findByRole('button', { name: 'Verwerfen' });
    const scrim = document.querySelector('.ai-dialog__scrim');
    if (scrim === null) {
      throw new Error('the dialogue rendered without a scrim');
    }
    fireEvent.click(scrim);

    // The suggestion cost a counted call; a mis-click must not spend it.
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('Seite 1: Ihre Daten')).toBeDefined();
  });

  /**
   * …but the way out is never taken away: Escape does what *Verwerfen* does,
   * so nobody on a keyboard is trapped by the paragraph above.
   */
  it('lets Escape discard the preview', async () => {
    const routes = stubRoutes({ generate: suggestion() });
    const { onClose } = open();
    generate();

    await screen.findByRole('button', { name: 'Verwerfen' });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(routes.formCalls()).toHaveLength(0);
  });
});

describe('AiFormDialog — the evidence: cancelling leaves nothing half', () => {
  /**
   * The reconstruction is the late answer: a run that was abandoned must not
   * paint a preview over a dialogue the editor already left, and must not have
   * created anything.
   *
   * Break it by dropping the `aborted` guard in `onSuccess` and this goes red
   * on the last assertion — the preview appears seconds after *Abbrechen*.
   */
  it('aborts the request and ignores its late answer', async () => {
    let settle: ((response: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => {
      settle = resolve;
    });
    const routes = stubRoutes({ generateResponse: pending });
    open();
    generate();

    await screen.findByText('KI erstellt dein Formular…');
    fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));

    // The signal actually reached `fetch` — an „Abbrechen" that only changes
    // the screen leaves the call running and the bill unchanged.
    const sent = routes
      .calls()
      .find((call) => call.url.endsWith('/api/ai/forms'));
    expect(sent).toBeDefined();

    // Back at the text, with what was typed still there.
    expect(
      screen.getByLabelText<HTMLTextAreaElement>('Beschreibung des Formulars')
        .value,
    ).toBe('Anmeldung mit Kontaktfeldern');

    settle?.(jsonResponse(200, suggestion()));
    await Promise.resolve();

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Übernehmen' })).toBeNull();
    });
    expect(routes.formCalls()).toHaveLength(0);
  });

  it('passes an AbortSignal that is aborted by Abbrechen', async () => {
    let captured: AbortSignal | undefined;
    stubFetch().mockImplementation((input: unknown, init?: RequestInit) => {
      const url = requestUrl(input as RequestInfo | URL);
      if (url.endsWith('/api/ai/forms')) {
        captured = init?.signal ?? undefined;
        return new Promise<Response>(() => {
          // never settles — the abort is the only way out
        });
      }
      return Promise.resolve(jsonResponse(200, { used: 3, limit: 50 }));
    });
    open();
    generate();

    await screen.findByText('KI erstellt dein Formular…');
    expect(captured?.aborted).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));

    expect(captured?.aborted).toBe(true);
  });
});

describe('AiFormDialog — the answer is data, never markup', () => {
  /**
   * A caption containing a `<script>` element is a **caption** , and this is asserted on the rendered DOM rather than on the
   * state: a `dangerouslySetInnerHTML` would leave the state identical and the
   * document a different one.
   */
  it('renders a script tag in a question caption as text', async () => {
    const hostile = '<script>alert("x")</script>Vorname';
    const hostilePageTitle = '<img src=x onerror="alert(1)">Ihre Daten';
    // Built rather than patched into the fixture above: what goes over the wire
    // here **is** a `definition` the schema accepts, with two captions that
    // happen to be markup. Editing a fixture through a cast would describe a
    // payload of a shape the route cannot send, and the test would then be
    // about that shape rather than about this one.
    stubRoutes({
      generate: suggestion({
        definition: {
          pages: [
            {
              id: '019ff000-0000-7000-8000-0000000000a1',
              title: hostilePageTitle,
              description: null,
              questions: [
                {
                  ...createQuestion(
                    'text',
                    '019ff000-0000-7000-8000-0000000000b1',
                  ),
                  label: hostile,
                },
              ],
            },
          ],
        },
      }),
    });
    const { container } = renderWithQuery(<AiFormDialog onClose={vi.fn()} />);
    generate();

    // The caption is on screen **as its own characters** …
    await screen.findByText(hostile);
    // … and nothing of it became an element.
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
  });

  /**
   * The same for the refusal detail — our own sentence, but one that may quote
   * a key the model invented.
   */
  it('renders a refusal detail as text', async () => {
    stubRoutes({
      generate: {
        ok: false,
        failure: 'invalid_output',
        detail: '<b>pages.0.questions.1.type</b>: Ungültiger Fragetyp',
        quota: { used: 5, limit: 50 },
      },
    });
    const { container } = renderWithQuery(<AiFormDialog onClose={vi.fn()} />);
    generate();

    await screen.findByText(/pages.0.questions.1.type/);
    expect(container.querySelector('b')).toBeNull();
  });
});

describe('AiFormDialog — the six named failures', () => {
  it('says what a timeout means and offers a second attempt', async () => {
    const routes = stubRoutes({
      generate: {
        ok: false,
        failure: 'timeout',
        detail: null,
        quota: { used: 5, limit: 50 },
      },
    });
    open();
    generate();

    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain(
      'nicht rechtzeitig geantwortet',
    );
    // Nothing was created by a failure either.
    expect(routes.formCalls()).toHaveLength(0);

    // „Erneut versuchen" goes back to the text rather than firing a second
    // counted call on its own.
    fireEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    expect(screen.getByLabelText('Beschreibung des Formulars')).toBeDefined();
    expect(
      routes.calls().filter((call) => call.url.endsWith('/api/ai/forms')),
    ).toHaveLength(1);
  });

  /**
   * 404 is „gibt es hier nicht", not „ist kaputt" (ADR-0015 no. 9) — what
   * somebody sees who kept a tab open across the key being removed.
   */
  it('explains a 404 as a feature that is not set up', async () => {
    stubRoutes({ generateStatus: 404, generate: {} });
    open();
    generate();

    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain(
      'nicht eingerichtet',
    );
  });

  /**
   * Both 429s — the exhausted Kontingent and the route's rate limit — get **one
   * German sentence naming both possibilities**, and neither gets the server's
   * own `message`.
   *
   * The second case is why: Nest's throttler answers with „ThrottlerException:
   * Too Many Requests", and `ApiError.detail` reads it like any other. A
   * pass-through would therefore show an English exception name to an
   * editor about half the time — which is what this measures.
   */
  it('never shows a foreign exception name on 429', async () => {
    stubRoutes({
      generateStatus: 429,
      generate: {
        statusCode: 429,
        message: 'ThrottlerException: Too Many Requests',
      },
    });
    open();
    generate();

    await screen.findByRole('alert');
    const shown = screen.getByRole('alert').textContent;
    expect(shown).not.toContain('ThrottlerException');
    expect(shown).toContain('Kontingent dieser Organisation aufgebraucht');
  });

  it('says the same about an exhausted Kontingent', async () => {
    stubRoutes({
      generateStatus: 429,
      generate: {
        message: 'Das KI-Kontingent dieser Organisation ist aufgebraucht.',
        quota: { used: 50, limit: 50 },
      },
    });
    open();
    generate();

    await screen.findByRole('alert');
    // The exact figure beside it is what tells the two 429s apart — see the
    // Kontingent line, which the answer's own numbers keep current.
    expect(screen.getByRole('alert').textContent).toContain(
      'keine weiteren KI-Anfragen möglich',
    );
  });
});
