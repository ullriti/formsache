import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
import {
  EMPTY_TENANT_LEGAL_PAGES,
  ORPHANED_PLACEHOLDER_LEAD,
  questionTypeSchema,
  TENANT_LEGAL_PAGES,
  TENANT_LEGAL_TEMPLATES,
  UNRESOLVABLE_CONDITION_LEAD,
  unresolvableConditionText,
  type TenantLegalPages,
} from '@formsache/shared';

import { createQueryClient } from '../api/query-client';
import { useBuilderStore } from '../builder/builder-store';
import { jsonResponse, stubFetch } from '../test/fetch-mock';
import {
  membership,
  permissions,
  sessionUser,
  UMBRELLA_TENANT_ID,
} from '../test/fixtures';
import { renderWithQuery } from '../test/render-with-query';
import { BuilderView } from './BuilderView';

/**
 * The builder through its own surface.
 *
 * The document rules are covered next door in `builder-store.test.ts`; what is
 * asserted here is that the *controls* reach them — a store that reorders
 * correctly is worth nothing behind a grip nobody can operate.
 *
 * The keyboard drag is tested here rather than only in Playwright, because it
 * is the one interaction with no pointer at all: a test that clicks cannot
 * fail on it.
 */

const FORM_ID = '019fe500-0000-7000-8000-000000000001';
const PAGE_ID = '019fe500-0000-7000-8000-0000000000a1';

function detail(overrides: Record<string, unknown> = {}) {
  return {
    id: FORM_ID,
    title: 'Bestandsmeldung',
    status: 'draft',
    publishedVersion: null,
    responseCount: 0,
    permissions: permissions(),
    updatedAt: '2026-07-27T10:00:00.000Z',
    revision: 1,
    publicSlug: 'abc123',
    definition: { pages: [{ id: PAGE_ID, title: 'Seite 1', questions: [] }] },
    hasUnpublishedChanges: true,
    ...overrides,
  };
}

/**
 * Adds a further question.
 *
 * The panel switches to the properties of whatever was just inserted, so a
 * second type button only exists after going back to the library — which is
 * exactly the path a user takes.
 */
function addSecond(type: string): void {
  fireEvent.click(screen.getByRole('button', { name: '+ Weitere Frage' }));
  fireEvent.click(screen.getByRole('button', { name: type }));
}

describe('BuilderView', () => {
  beforeEach(() => {
    useBuilderStore.getState().reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function renderLoaded(
    overrides: Record<string, unknown> = {},
    canManageFormSettings = true,
    canBuild = true,
  ): Promise<ReturnType<typeof stubFetch>> {
    const fetchMock = stubFetch().mockResolvedValue(
      jsonResponse(200, detail(overrides)),
    );
    renderWithQuery(
      <BuilderView
        formId={FORM_ID}
        canBuild={canBuild}
        canManageTemplates={canBuild}
        canUpdateTemplates={canBuild}
        canManageFormSettings={canManageFormSettings}
      />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Formularname')).toBeDefined();
    });
    return fetchMock;
  }

  it('loads the form and shows its name and page', async () => {
    await renderLoaded();

    expect(screen.getByLabelText('Formularname')).toHaveProperty(
      'value',
      'Bestandsmeldung',
    );
    expect(screen.getByLabelText('Titel von Seite 1')).toBeDefined();
    expect(screen.getByText('0 Fragen')).toBeDefined();
  });

  /**
   * A momentary state while renaming (the field is cleared and retyped), not
   * one the dashboard ever creates a form in — creation there refuses an
   * empty title. Still, an empty field with no placeholder looks like a
   * rendering accident rather than an editable one.
   */
  it('offers a placeholder for an unnamed form', async () => {
    await renderLoaded();

    expect(screen.getByLabelText('Formularname')).toHaveProperty(
      'placeholder',
      'Formularname',
    );
  });

  /**
   * The form name is the heading of the document being edited — the `<h1>`
   * every other view has and this one was missing. It is a heading that
   * happens to be editable, not a form field that happens to hold a title.
   */
  it('carries the form name as the view heading', async () => {
    await renderLoaded();

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.contains(screen.getByLabelText('Formularname'))).toBe(true);
  });

  /**
   * The typography of the two editable headings, read out of the stylesheet.
   *
   * jsdom applies no stylesheets, so nothing in this file can ask for a
   * computed `font-size` — and a wrong token here is invisible to every other
   * test while being exactly what the client sees: the form name used to take
   * `--font-size-title-sm` (18 px, the size for a heading *inside* a card) and
   * read as a stray form field because of it.
   */
  describe('the type of the editable headings', () => {
    const STYLESHEET = resolve(process.cwd(), 'src/views/builder-view.css');

    /**
     * Every declaration that applies to `selector`, comments stripped.
     *
     * Matched block by block, and **all** matching blocks: a selector may
     * appear in more than one rule (the form name does — once for its grid
     * cell, once for its type). Deliberately not a slice from the first
     * mention to the end of the file — such a slice keeps finding the property
     * it looks for somewhere further down and stays green whatever the
     * intended rule says.
     */
    function declarationsOf(selector: string): readonly string[] {
      const css = readFileSync(STYLESHEET, 'utf8').replace(
        /\/\*[\s\S]*?\*\//g,
        '',
      );
      const declarations: string[] = [];

      for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selectors = (match[1] ?? '')
          .split(',')
          .map((entry) => entry.trim());
        if (selectors.includes(selector)) {
          declarations.push(
            ...(match[2] ?? '')
              .split(';')
              .map((entry) => entry.trim())
              .filter((entry) => entry !== ''),
          );
        }
      }

      if (declarations.length === 0) {
        throw new Error(`no rule declares ${selector}`);
      }

      return declarations;
    }

    /** The type of a selector: the declarations that decide how text sets. */
    function typeOf(selector: string): readonly string[] {
      return declarationsOf(selector)
        .filter((entry) => /^(font-|line-height|letter-spacing)/.test(entry))
        .toSorted();
    }

    it.each(['.builder__title', '.canvas__title'])(
      'sets %s in the display face at view-title size',
      (selector) => {
        const declarations = declarationsOf(selector);

        expect(declarations).toContain('font-family: var(--font-display)');
        expect(declarations).toContain('font-size: var(--font-size-title)');
        expect(declarations.join(';')).not.toContain('--font-size-title-sm');
      },
    );

    /**
     * The mirror that measures the field has to be set in the same type, or it
     * measures a different string than the one on screen.
     */
    it('measures the form name in the very same type', () => {
      expect(typeOf('.builder__title-sizer::after')).toStrictEqual(
        typeOf('.builder__title'),
      );
      // And that type is not empty — two selectors with no font declarations
      // at all would satisfy the comparison above and prove nothing.
      expect(typeOf('.builder__title').length).toBeGreaterThan(2);
    });
  });

  it('offers all sixteen question types of the prototype', async () => {
    await renderLoaded();

    for (const label of [
      'Text',
      'Mehrzeilig',
      'Zahl',
      'Datum',
      'E-Mail',
      'Telefon',
      'Dropdown',
      'Einfachauswahl',
      'Mehrfachauswahl',
      // Landed — the palette now offers it like any other type,
      // not as a disabled placeholder.
      'Bewertung',
      // Landed, same reasoning.
      'Infotext',
      // Landed, same reasoning.
      'Adresse',
      // Landed — the pair, appended together.
      'Matrix',
      'Tabelle',
      // Landed, same reasoning.
      'Datei-Upload',
      // Landed — the last of the sixteen, and the one the project was
      // started for.
      'Veranstaltung',
    ]) {
      expect(screen.getByRole('button', { name: label })).toBeDefined();
    }
    // **Nothing is outstanding any more**, so the counter-assertion changes
    // shape rather than disappearing: the palette offers exactly the sixteen
    // types the schema knows and nothing beside them — a seventeenth button
    // would be a control promising a feature that does not exist, which is what
    // the „absent, not disabled" rule was about.
    expect(
      screen
        .getAllByRole('button', { name: /.+/u })
        .filter((button) => button.classList.contains('palette__item')),
    ).toHaveLength(questionTypeSchema.options.length);
  });

  it('adds a question, shows its preview and opens its properties', async () => {
    await renderLoaded();

    fireEvent.click(screen.getByRole('button', { name: 'Dropdown' }));

    // The card, its type pill and a live preview of the field.
    expect(screen.getByText('1 Frage')).toBeDefined();
    expect(
      screen.getByRole('button', { name: 'Frage 1 verschieben' }),
    ).toBeDefined();
    // Selected on insertion, so the panel shows properties rather than the
    // palette — which is what makes "add and configure" one gesture.
    expect(screen.getByLabelText('Fragetext')).toBeDefined();
    expect(screen.getByLabelText('Option 1')).toBeDefined();
  });

  /** The requirement through the panel: the rule reaches the document. */
  it('writes validation rules into the document', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Text' }));

    fireEvent.click(screen.getByLabelText('Pflichtfeld'));
    fireEvent.change(screen.getByLabelText('Höchstlänge'), {
      target: { value: '12' },
    });

    const question = useBuilderStore.getState().pages[0]?.questions[0];
    expect(question?.required).toBe(true);
    expect(question && 'maxLength' in question && question.maxLength).toBe(12);
  });

  /**
   * The rule that is *not* deferred to the server: a pattern that cannot be
   * compiled is refused in the panel, so the editor learns about it at the
   * field rather than through a save that names a JSON path.
   */
  it('refuses a pattern that does not compile, at the field', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Text' }));

    fireEvent.change(screen.getByLabelText('Muster (RegEx)'), {
      target: { value: '([a-z' },
    });

    expect(screen.getByRole('alert').textContent).toContain('regulärer');
    const question = useBuilderStore.getState().pages[0]?.questions[0];
    expect(question && 'pattern' in question && question.pattern).toBeNull();
  });

  it('imports options in bulk and keeps explicit values', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Dropdown' }));

    fireEvent.click(screen.getByRole('button', { name: 'Massenimport' }));
    fireEvent.change(screen.getByLabelText('Eine Option je Zeile'), {
      target: { value: 'ja = Ja, ich komme\nNein' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Übernehmen' }));

    const question = useBuilderStore.getState().pages[0]?.questions[0];
    expect(question && 'options' in question && question.options).toStrictEqual(
      [
        { value: 'ja', label: 'Ja, ich komme' },
        { value: 'nein', label: 'Nein' },
      ],
    );
  });

  /**
   * Regression: adding an option counted from the list *length*, so deleting
   * option 2 of three and adding a new one produced `option-3` — a value that
   * was still there. The schema refused the patch, and the button looked
   * broken with nothing on screen explaining why.
   */
  it('adds an option with a value that is free, not merely the next number', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Dropdown' }));

    // Two options by default; add a third, then remove the middle one.
    fireEvent.click(screen.getByRole('button', { name: '+ Option' }));
    fireEvent.click(screen.getByRole('button', { name: 'Option 2 entfernen' }));

    fireEvent.click(screen.getByRole('button', { name: '+ Option' }));

    const question = useBuilderStore.getState().pages[0]?.questions[0];
    const values =
      question && 'options' in question
        ? question.options.map((option) => option.value)
        : [];
    expect(values).toHaveLength(3);
    expect(new Set(values).size).toBe(3);
    // No refusal reached the user.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  describe('pages', () => {
    it('adds a page and refuses to delete the last one', async () => {
      await renderLoaded();

      // One page: its delete button is visibly unavailable rather than
      // reporting failure after the click.
      expect(
        screen.getByRole('button', { name: 'Seite 1 löschen' }),
      ).toHaveProperty('disabled', true);

      fireEvent.click(
        screen.getByRole('button', { name: '+ Seite hinzufügen' }),
      );

      expect(useBuilderStore.getState().pages).toHaveLength(2);
      expect(
        screen.getByRole('button', { name: 'Seite 1 löschen' }),
      ).toHaveProperty('disabled', false);
    });
  });

  describe('keyboard operation of the grip', () => {
    /**
     * The requirement in one test, and **without a single mouse event**: focus
     * the grip, pick up with Space, move with an arrow, drop with Enter — then
     * check the *document*, not the DOM order.
     */
    it('reorders questions with the keyboard alone', async () => {
      await renderLoaded();
      fireEvent.click(screen.getByRole('button', { name: 'Text' }));
      addSecond('Zahl');

      const before = useBuilderStore
        .getState()
        .pages[0]?.questions.map((question) => question.type);
      expect(before).toStrictEqual(['text', 'number']);

      const grip = screen.getByRole('button', { name: 'Frage 2 verschieben' });
      grip.focus();
      fireEvent.keyDown(grip, { key: ' ' });
      expect(grip.getAttribute('aria-pressed')).toBe('true');

      fireEvent.keyDown(grip, { key: 'ArrowLeft' });
      fireEvent.keyDown(grip, { key: 'Enter' });

      expect(
        useBuilderStore.getState().pages[0]?.questions.map((q) => q.type),
      ).toStrictEqual(['number', 'text']);
      expect(grip.getAttribute('aria-pressed')).toBe('false');
    });

    it('announces the mode, so the change is not silent', async () => {
      await renderLoaded();
      fireEvent.click(screen.getByRole('button', { name: 'Text' }));

      const grip = screen.getByRole('button', { name: 'Frage 1 verschieben' });
      fireEvent.keyDown(grip, { key: ' ' });

      const status = screen
        .getAllByRole('status')
        .map((element) => element.textContent)
        .join(' ');
      expect(status).toContain('angehoben');
    });

    /**
     * Arrow keys must not move anything while the grip is merely focused —
     * otherwise tabbing through the builder reorders the form by accident.
     */
    it('ignores the arrows until something is picked up', async () => {
      await renderLoaded();
      fireEvent.click(screen.getByRole('button', { name: 'Text' }));
      addSecond('Zahl');

      const grip = screen.getByRole('button', { name: 'Frage 2 verschieben' });
      fireEvent.keyDown(grip, { key: 'ArrowLeft' });

      expect(
        useBuilderStore.getState().pages[0]?.questions.map((q) => q.type),
      ).toStrictEqual(['text', 'number']);
    });

    it('puts the card back on Escape', async () => {
      await renderLoaded();
      fireEvent.click(screen.getByRole('button', { name: 'Text' }));
      addSecond('Zahl');

      const grip = screen.getByRole('button', { name: 'Frage 2 verschieben' });
      fireEvent.keyDown(grip, { key: ' ' });
      fireEvent.keyDown(grip, { key: 'ArrowLeft' });
      fireEvent.keyDown(grip, { key: 'Escape' });

      expect(
        useBuilderStore.getState().pages[0]?.questions.map((q) => q.type),
      ).toStrictEqual(['text', 'number']);
    });

    it('moves pages the same way', async () => {
      await renderLoaded();
      fireEvent.click(
        screen.getByRole('button', { name: '+ Seite hinzufügen' }),
      );

      const first = useBuilderStore.getState().pages[0]?.id;
      const grip = screen.getByRole('button', { name: 'Seite 1 verschieben' });
      fireEvent.keyDown(grip, { key: 'Enter' });
      fireEvent.keyDown(grip, { key: 'ArrowDown' });
      fireEvent.keyDown(grip, { key: 'Enter' });

      expect(useBuilderStore.getState().pages[1]?.id).toBe(first);
    });
  });

  describe('saving and publishing', () => {
    it('shows the unsaved state and sends the loaded revision', async () => {
      const fetchMock = await renderLoaded();

      fireEvent.change(screen.getByLabelText('Formularname'), {
        target: { value: 'Neuer Name' },
      });
      expect(screen.getByText('Nicht gespeichert')).toBeDefined();

      fetchMock.mockResolvedValue(
        jsonResponse(200, detail({ title: 'Neuer Name', revision: 2 })),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          `/api/forms/${FORM_ID}`,
          expect.objectContaining({ method: 'PUT' }),
        );
      });
      // The **PUT**, found by method rather than by position: a successful
      // save invalidates the query, so the last call is the refetch that
      // follows it and carries no body at all.
      const put = fetchMock.mock.calls.find(
        ([, init]) =>
          (init as { method?: string } | undefined)?.method === 'PUT',
      );
      const init = put?.[1] as { body?: string } | undefined;
      const body = JSON.parse(String(init?.body)) as {
        revision: number;
        title: string;
      };
      // The revision the editor *loaded*, which is what makes the server able
      // to refuse a stale save at all.
      expect(body.revision).toBe(1);
      expect(body.title).toBe('Neuer Name');

      await waitFor(() => {
        expect(screen.getByText('Gespeichert')).toBeDefined();
      });
    });

    /** The requirement from the editor's side: a message, not a silent loss. */
    it('reports the concurrent-edit refusal instead of retrying', async () => {
      const fetchMock = await renderLoaded();

      fireEvent.change(screen.getByLabelText('Formularname'), {
        target: { value: 'Kollision' },
      });
      fetchMock.mockResolvedValue(jsonResponse(409, { message: 'stale' }));
      fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

      await waitFor(() => {
        expect(screen.getByRole('alert').textContent).toContain(
          'zwischenzeitlich',
        );
      });
      // Still unsaved — the editor keeps their work and decides what to do.
      expect(screen.getByText('Nicht gespeichert')).toBeDefined();
    });

    it('refuses to publish an unsaved draft', async () => {
      await renderLoaded();

      fireEvent.change(screen.getByLabelText('Formularname'), {
        target: { value: 'Ungespeichert' },
      });

      // Publishing now would publish the *stored* document, not the one on
      // screen.
      expect(
        screen.getByRole('button', { name: 'Veröffentlichen' }),
      ).toHaveProperty('disabled', true);
    });

    it('shows the public address once the form is published', async () => {
      await renderLoaded({ status: 'active', publishedVersion: 2 });

      expect(screen.getByText(/Veröffentlicht \(Fassung 2\)/)).toBeDefined();
      expect(
        screen.getByRole('button', { name: 'Erneut veröffentlichen' }),
      ).toBeDefined();
    });

    /**
     * The bug the second report was about: `/f/abc123` is a site-relative
     * path, worthless once pasted into a round-mail sent outside the app. The
     * link text and its `href` must both carry the full, absolute address.
     */
    it('shows the absolute public URL, not the bare relative path', async () => {
      await renderLoaded({ status: 'active', publishedVersion: 1 });

      const link = screen.getByRole('link', { name: /\/f\/abc123$/ });
      expect(link.textContent).toMatch(/^https?:\/\/.+\/f\/abc123$/);
      expect(link.getAttribute('href')).toMatch(/^https?:\/\/.+\/f\/abc123$/);
    });

    describe('copying the public address', () => {
      afterEach(() => {
        Reflect.deleteProperty(navigator, 'clipboard');
      });

      it('copies the absolute URL and announces success', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', {
          value: { writeText },
          configurable: true,
        });

        await renderLoaded({ status: 'active', publishedVersion: 1 });
        fireEvent.click(screen.getByRole('button', { name: 'Kopieren' }));

        await waitFor(() => {
          expect(screen.getByRole('button', { name: 'Kopiert' })).toBeDefined();
        });
        expect(writeText).toHaveBeenCalledWith(
          expect.stringMatching(/^https?:\/\/.+\/f\/abc123$/),
        );
        expect(
          screen.getByText('Adresse in die Zwischenablage kopiert.'),
        ).toHaveProperty('role', 'status');
      });

      /**
       * `navigator.clipboard` does not exist in every context (insecure
       * origin, older browser). A button that looks like it copied when it
       * did not is worse than none, so the failure has to reach the user —
       * not fail silently.
       */
      it('reports failure visibly when the clipboard API is unavailable', async () => {
        Reflect.deleteProperty(navigator, 'clipboard');

        await renderLoaded({ status: 'active', publishedVersion: 1 });
        fireEvent.click(screen.getByRole('button', { name: 'Kopieren' }));

        await waitFor(() => {
          expect(screen.getByText(/Kopieren war nicht möglich/)).toHaveProperty(
            'role',
            'status',
          );
        });
        // The button never claims success it did not have.
        expect(screen.queryByRole('button', { name: 'Kopiert' })).toBeNull();
      });

      it('reports failure visibly when the browser refuses the write', async () => {
        const writeText = vi.fn().mockRejectedValue(new Error('denied'));
        Object.defineProperty(navigator, 'clipboard', {
          value: { writeText },
          configurable: true,
        });

        await renderLoaded({ status: 'active', publishedVersion: 1 });
        fireEvent.click(screen.getByRole('button', { name: 'Kopieren' }));

        await waitFor(() => {
          expect(screen.getByText(/Kopieren war nicht möglich/)).toBeDefined();
        });
      });
    });
  });

  /**
   * The notice before republishing over existing answers (Konzept no. 23).
   *
   * Every case here goes through the *button* the editor presses, not through
   * the dialog component: what the decision promises is that a republish over
   * answers cannot happen by accident, and only the button can prove that.
   */
  describe('the notice before republishing (Konzept Nr. 23)', () => {
    const REMOVED_ID = '019fe500-0000-7000-8000-0000000000b1';
    const ADDED_ID = '019fe500-0000-7000-8000-0000000000b2';
    const CHANGED_ID = '019fe500-0000-7000-8000-0000000000b3';

    function preview(overrides: Record<string, unknown> = {}) {
      return {
        revision: 1,
        publishedVersion: 2,
        responseCount: 7,
        changes: { removed: [], added: [], typeChanged: [] },
        ...overrides,
      };
    }

    const EVERY_CHANGE = {
      removed: [{ id: REMOVED_ID, label: 'Fahrgemeinschaft', type: 'text' }],
      added: [{ id: ADDED_ID, label: 'Übernachtung', type: 'checkbox' }],
      typeChanged: [
        { id: CHANGED_ID, label: 'Ankunft', from: 'text', to: 'date' },
      ],
    };

    /** A promise the test releases by hand — a preview that takes its time. */
    function deferred(): {
      readonly promise: Promise<void>;
      readonly release: () => void;
    } {
      let release = (): void => undefined;
      const promise = new Promise<void>((resolve) => {
        release = (): void => {
          resolve();
        };
      });
      return {
        promise,
        release: () => {
          release();
        },
      };
    }

    /**
     * The path a `fetch` call went to. `http.ts` always passes a string, so a
     * non-string argument means the call was not made by the API layer.
     */
    function pathOf(input: unknown): string {
      return typeof input === 'string' ? input : '';
    }

    /**
     * A published form whose builder answers `/publish-preview` with
     * `previewBody` (`undefined` answers 500) and everything else with the
     * form itself. `gate`, when given, holds the preview back until the test
     * releases it — the window in which the draft can move underneath.
     */
    async function renderPublished(
      previewBody: unknown,
      gate?: Promise<void>,
    ): Promise<ReturnType<typeof stubFetch>> {
      const fetchMock = stubFetch().mockImplementation((input) => {
        if (pathOf(input).endsWith('/publish-preview')) {
          return (gate ?? Promise.resolve()).then(() =>
            previewBody === undefined
              ? jsonResponse(500, { message: 'kaputt' })
              : jsonResponse(200, previewBody),
          );
        }
        return Promise.resolve(
          jsonResponse(200, detail({ status: 'active', publishedVersion: 2 })),
        );
      });

      renderWithQuery(
        <BuilderView
          formId={FORM_ID}
          canBuild
          canManageTemplates
          canUpdateTemplates
          canManageFormSettings
        />,
      );
      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: 'Erneut veröffentlichen' }),
        ).toBeDefined();
      });
      return fetchMock;
    }

    /** The button in the bar. Only ever pressed while no notice is open. */
    function pressPublish(): void {
      fireEvent.click(
        screen.getByRole('button', { name: 'Erneut veröffentlichen' }),
      );
    }

    /** The POST that actually publishes — none means nothing was published. */
    function publishCalls(
      fetchMock: ReturnType<typeof stubFetch>,
    ): readonly unknown[] {
      return fetchMock.mock.calls.filter(
        ([input, init]) =>
          pathOf(input).endsWith('/publish') &&
          (init as { method?: string } | undefined)?.method === 'POST',
      );
    }

    /**
     * One group of the notice, by its heading.
     *
     * Scoped on purpose: searching the **whole** dialog for a question label
     * proves only that it is mentioned somewhere. Swapping the removed and the
     * added list left every such assertion green while the notice claimed the
     * exact opposite of what would happen.
     */
    function group(dialog: HTMLElement, title: string): HTMLElement {
      return within(dialog).getByRole('region', { name: title });
    }

    const REMOVED_GROUP = 'Diese Fragen werden entfernt';
    const ADDED_GROUP = 'Diese Fragen kommen hinzu';
    const RETYPED_GROUP = 'Diese Fragen wechseln den Typ';

    it('announces the answers on file and names every change in its own group', async () => {
      await renderPublished(preview({ changes: EVERY_CHANGE }));
      pressPublish();

      const dialog = await screen.findByRole('dialog');
      expect(dialog.textContent).toContain(
        'Es liegen bereits 7 Antworten vor.',
      );

      const removed = group(dialog, REMOVED_GROUP);
      expect(within(removed).getByText(/Fahrgemeinschaft/)).toBeDefined();
      expect(within(removed).queryByText(/Übernachtung/)).toBeNull();
      expect(within(removed).queryByText(/Ankunft/)).toBeNull();

      const added = group(dialog, ADDED_GROUP);
      expect(within(added).getByText(/Übernachtung/)).toBeDefined();
      expect(within(added).queryByText(/Fahrgemeinschaft/)).toBeNull();

      const retyped = group(dialog, RETYPED_GROUP);
      expect(within(retyped).getByText(/Ankunft/)).toBeDefined();
      expect(within(retyped).queryByText(/Fahrgemeinschaft/)).toBeNull();
      // Old → new, both named.
      expect(retyped.textContent).toContain('Text');
      expect(retyped.textContent).toContain('Datum');
    });

    /** German has no „Es liegen bereits 1 Antworten vor". */
    it('says it in the singular for a single answer', async () => {
      await renderPublished(
        preview({ responseCount: 1, changes: EVERY_CHANGE }),
      );
      pressPublish();

      const dialog = await screen.findByRole('dialog');
      expect(dialog.textContent).toContain('Es liegt bereits 1 Antwort vor.');
    });

    /**
     * The sentence that keeps an editor from fearing data loss: Konzept no. 22
     * keeps every answer ever given and only marks the column.
     */
    it('says, in the removal group, that those answers survive', async () => {
      await renderPublished(preview({ changes: EVERY_CHANGE }));
      pressPublish();

      const removed = group(await screen.findByRole('dialog'), REMOVED_GROUP);
      expect(removed.textContent).toContain('bleiben erhalten');
      expect(removed.textContent).toContain('nicht mehr gefragt');
    });

    it('says, in the addition group, that new questions start empty', async () => {
      await renderPublished(preview({ changes: EVERY_CHANGE }));
      pressPublish();

      const added = group(await screen.findByRole('dialog'), ADDED_GROUP);
      expect(added.textContent).toContain(
        'Bei den bisherigen Antworten bleiben sie leer.',
      );
    });

    it('says, in the type group, that the old answers stay where they are', async () => {
      await renderPublished(preview({ changes: EVERY_CHANGE }));
      pressPublish();

      const retyped = group(await screen.findByRole('dialog'), RETYPED_GROUP);
      expect(retyped.textContent).toContain('bleiben bei der alten Frage');
    });

    it('publishes nothing until it is confirmed', async () => {
      const fetchMock = await renderPublished(
        preview({ changes: EVERY_CHANGE }),
      );
      pressPublish();
      await screen.findByRole('dialog');

      expect(publishCalls(fetchMock)).toHaveLength(0);
    });

    it('publishes on confirmation, with the loaded revision', async () => {
      const fetchMock = await renderPublished(
        preview({ changes: EVERY_CHANGE }),
      );
      pressPublish();
      const dialog = await screen.findByRole('dialog');

      fireEvent.click(
        within(dialog).getByRole('button', { name: 'Erneut veröffentlichen' }),
      );

      await waitFor(() => {
        expect(publishCalls(fetchMock)).toHaveLength(1);
      });
      const [, init] = publishCalls(fetchMock)[0] as [
        unknown,
        { body: string },
      ];
      expect(JSON.parse(init.body)).toStrictEqual({ revision: 1 });
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });
    });

    /**
     * **The hint about this form's missing privacy notice**
     * (ADR-0028 no. 4).
     *
     * Three properties, and each of them is a decision:
     *
     * 1. It stops the dialog **even when** nothing about the questions has
     *    changed — otherwise it would fail to appear exactly when it is
     *    needed.
     * 2. It comes from the **preview** and thus from behind `can_build`, so
     *    it reaches the person who publishes. The hint about the
     *    Organisation's legal texts next to it demands `can_manage_settings`
     *    and may not reach them.
     * 3. It **blocks nothing**: „Erneut veröffentlichen" stays operable.
     */
    it('hält den Dialog an, wenn der Datenschutzhinweis dieses Formulars fehlt', async () => {
      const fetchMock = await renderPublished(
        // No change to the questions and no answer on the table: without
        // the legal finding there would be nothing to stop here.
        preview({ responseCount: 0, privacyNotice: 'empty' }),
      );
      pressPublish();

      const dialog = await screen.findByRole('dialog');
      const hint = within(dialog).getByRole('region', {
        name: 'Datenschutzhinweis zu diesem Formular',
      });
      expect(hint.textContent).toContain('kein Datenschutzhinweis hinterlegt');

      // A hint, not a block.
      fireEvent.click(
        within(dialog).getByRole('button', { name: 'Erneut veröffentlichen' }),
      );
      await waitFor(() => {
        expect(publishCalls(fetchMock)).toHaveLength(1);
      });
    });

    it('sagt bei einer angefangenen Fassung, dass sie unvollständig ist', async () => {
      await renderPublished(
        preview({ responseCount: 0, privacyNotice: 'incomplete' }),
      );
      pressPublish();

      const dialog = await screen.findByRole('dialog');
      expect(
        within(dialog).getByRole('region', {
          name: 'Datenschutzhinweis zu diesem Formular',
        }).textContent,
      ).toContain('ist unvollständig');
    });

    it('schweigt, sobald der Hinweis vollständig ist', async () => {
      const fetchMock = await renderPublished(
        preview({ responseCount: 0, privacyNotice: 'ready' }),
      );
      pressPublish();

      // Nothing stops it: the form is published without an intermediate step.
      await waitFor(() => {
        expect(publishCalls(fetchMock)).toHaveLength(1);
      });
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    /**
     * **The legal texts of this organisation** (ADR-0028, open item 3) —
     * **two stages**, with the guard standing between them.
     *
     * 1. *That* something is missing comes from `preview.organisationLegal`,
     *    that is, from the preview behind `can_build` — the right that
     *    publishes. This stage reaches everybody who can press the button.
     * 2. *What* is missing comes from `GET /tenant/legal` behind
     *    `can_manage_settings`. Whoever holds the documents anyway gets the
     *    pages by name; whoever does not gets the sentence without them.
     *
     * The predecessor `useLegalPublishHint` read both halves from the guarded
     * route and therefore stayed silent towards exactly the editor this is
     * about. The first case below is the gap this rebuild closes.
     */
    describe('the hint about this organisation’s legal texts', () => {
      /**
       * A published form whose session carries — or does not carry —
       * `can_manage_settings`, and whose `/tenant/legal` answers with
       * `pages`.
       *
       * The session is mocked in full rather than stubbed away: whether the
       * guarded query is issued at all is part of what is asserted here, and
       * a session the hook cannot read would make every case pass for the
       * wrong reason.
       */
      async function renderWithSession(
        previewBody: unknown,
        canManageSettings: boolean,
        pages: TenantLegalPages = EMPTY_TENANT_LEGAL_PAGES,
      ): Promise<ReturnType<typeof stubFetch>> {
        const fetchMock = stubFetch().mockImplementation((input) => {
          const path = pathOf(input);
          if (path.endsWith('/publish-preview')) {
            return Promise.resolve(jsonResponse(200, previewBody));
          }
          if (path.endsWith('/auth/me')) {
            return Promise.resolve(
              jsonResponse(
                200,
                sessionUser({
                  memberships: [
                    membership(
                      UMBRELLA_TENANT_ID,
                      'Dachorganisation',
                      'DACH',
                      null,
                      { canManageSettings },
                    ),
                  ],
                }),
              ),
            );
          }
          if (path.endsWith('/tenant/legal')) {
            return Promise.resolve(jsonResponse(200, { pages, lock: 1 }));
          }
          return Promise.resolve(
            jsonResponse(
              200,
              detail({ status: 'active', publishedVersion: 2 }),
            ),
          );
        });

        renderWithQuery(
          <BuilderView
            formId={FORM_ID}
            canBuild
            canManageTemplates
            canUpdateTemplates
            canManageFormSettings
          />,
        );
        await waitFor(() => {
          expect(
            screen.getByRole('button', { name: 'Erneut veröffentlichen' }),
          ).toBeDefined();
        });
        return fetchMock;
      }

      /** The two page titles, from the templates and not from a literal. */
      const PAGE_TITLES = TENANT_LEGAL_PAGES.map(
        (page) => TENANT_LEGAL_TEMPLATES[page].title,
      );

      function legalHint(): HTMLElement {
        return within(screen.getByRole('dialog')).getByRole('region', {
          name: 'Rechtstexte dieser Organisation',
        });
      }

      /**
       * **The gap this is about.** Without `can_manage_settings` the editor
       * learns *that* the legal texts are unfinished — and no page along with
       * it.
       */
      it('sagt einer Bearbeiterin ohne Einstellungsrecht, dass etwas fehlt — ohne die Seiten zu nennen', async () => {
        const fetchMock = await renderWithSession(
          // Nothing changed and no answer on file: without this finding
          // there would be nothing to stop the publish here.
          preview({ responseCount: 0, organisationLegal: 'incomplete' }),
          false,
        );
        pressPublish();
        await screen.findByRole('dialog');

        const hint = legalHint();
        expect(hint.textContent).toContain(
          'Die Rechtstexte dieser Organisation sind unvollständig.',
        );
        for (const title of PAGE_TITLES) {
          expect(hint.textContent).not.toContain(title);
        }
        expect(hint.textContent).not.toContain('Betroffen');

        // And the guarded route was not even asked — a 403 per builder visit
        // over a document this person may not read would be the wrong way to
        // reach the same silence.
        expect(
          fetchMock.mock.calls.filter(([input]) =>
            pathOf(input).endsWith('/tenant/legal'),
          ),
        ).toHaveLength(0);

        // A hint, not a lock (ADR-0028 §6).
        fireEvent.click(
          within(screen.getByRole('dialog')).getByRole('button', {
            name: 'Erneut veröffentlichen',
          }),
        );
        await waitFor(() => {
          expect(publishCalls(fetchMock)).toHaveLength(1);
        });
      });

      /** The second stage: with `can_manage_settings` the names are there. */
      it('nennt die Seiten, sobald jemand die Einstellungen verwalten darf', async () => {
        await renderWithSession(
          preview({ responseCount: 0, organisationLegal: 'empty' }),
          true,
        );
        pressPublish();
        await screen.findByRole('dialog');

        const hint = await waitFor(() => {
          const region = legalHint();
          expect(region.textContent).toContain('Betroffen');
          return region;
        });
        for (const title of PAGE_TITLES) {
          expect(hint.textContent).toContain(title);
        }
        expect(hint.textContent).toContain(
          'Für diese Organisation fehlen Rechtstexte.',
        );
      });

      /** And the case that shows nothing at all. */
      it('schweigt, sobald die Rechtstexte fertig sind', async () => {
        const fetchMock = await renderWithSession(
          preview({ responseCount: 0, organisationLegal: 'ready' }),
          true,
        );
        pressPublish();

        // Nothing stops it: the form is published without an intermediate
        // step, so there is no dialog to look into at all.
        await waitFor(() => {
          expect(publishCalls(fetchMock)).toHaveLength(1);
        });
        expect(screen.queryByRole('dialog')).toBeNull();
      });
    });

    /** The whole point of the intermediate step: „Abbrechen" publishes nothing. */
    it('publishes nothing when it is cancelled', async () => {
      const fetchMock = await renderPublished(
        preview({ changes: EVERY_CHANGE }),
      );
      pressPublish();
      const dialog = await screen.findByRole('dialog');

      fireEvent.click(
        within(dialog).getByRole('button', { name: 'Abbrechen' }),
      );

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });
      expect(publishCalls(fetchMock)).toHaveLength(0);
    });

    it('cancels on Escape as well', async () => {
      const fetchMock = await renderPublished(
        preview({ changes: EVERY_CHANGE }),
      );
      pressPublish();
      const dialog = await screen.findByRole('dialog');

      fireEvent.keyDown(dialog, { key: 'Escape' });

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });
      expect(publishCalls(fetchMock)).toHaveLength(0);
    });

    /** The scrim is the third way out, and it was deletable without a red test. */
    it('cancels when the scrim is clicked', async () => {
      const fetchMock = await renderPublished(
        preview({ changes: EVERY_CHANGE }),
      );
      pressPublish();
      const dialog = await screen.findByRole('dialog');

      // No accessible handle by design (`aria-hidden`), so the class is the
      // only way in — and a missing scrim fails loudly rather than silently
      // skipping the click.
      const scrim = dialog.parentElement?.querySelector(
        '.publish-notice__scrim',
      );
      if (!(scrim instanceof HTMLElement)) {
        throw new Error('the notice rendered no scrim');
      }
      fireEvent.click(scrim);

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });
      expect(publishCalls(fetchMock)).toHaveLength(0);
    });

    describe('keyboard and focus', () => {
      it('takes focus in and names itself by its own heading', async () => {
        await renderPublished(preview({ changes: EVERY_CHANGE }));
        pressPublish();

        const dialog = await screen.findByRole('dialog');
        /*
          `waitFor`, not a bare assertion: `findByRole` resolves as soon as the
          node is in the DOM, while the focus is set by a passive effect that
          runs afterwards. Locally the two land in the same flush and the bare
          assertion passed; on a loaded CI runner it observed `<body>` — a red
          run that said nothing about the application. Waiting for the
          condition itself does not weaken the check: without
          `panelRef.current?.focus()` this times out and fails.
        */
        await waitFor(() => {
          expect(document.activeElement).toBe(dialog);
        });
        expect(dialog.getAttribute('aria-modal')).toBe('true');
        expect(dialog.getAttribute('aria-labelledby')).toBe(
          within(dialog).getByRole('heading', { level: 2 }).id,
        );
      });

      /**
       * The defect a component test cannot see on its own: pressing publish
       * disables the button, and **a real browser blurs a control the moment
       * it becomes `disabled`** — jsdom does not. The dialog then remembered
       * `<body>` as its opener and handed focus to nothing on close. The blur
       * is reproduced here by hand.
       */
      it('hands focus back to the publish button the browser blurred', async () => {
        const gate = deferred();
        await renderPublished(preview({ changes: EVERY_CHANGE }), gate.promise);
        const button = screen.getByRole('button', {
          name: 'Erneut veröffentlichen',
        });
        if (!(button instanceof HTMLButtonElement)) {
          throw new Error('the publish control is not a button');
        }
        button.focus();
        pressPublish();

        // jsdom leaves focus on a control that becomes `disabled`; a real
        // browser blurs it. Reproduced by hand — and jsdom refuses to blur a
        // disabled element at all, hence the momentary re-enable.
        button.disabled = false;
        button.blur();
        button.disabled = true;
        expect(document.activeElement).toBe(document.body);

        await act(async () => {
          gate.release();
          await gate.promise;
        });
        const dialog = await screen.findByRole('dialog');
        fireEvent.click(
          within(dialog).getByRole('button', { name: 'Abbrechen' }),
        );

        await waitFor(() => {
          expect(screen.queryByRole('dialog')).toBeNull();
        });
        expect(document.activeElement).toBe(button);
      });

      /**
       * The same wound on the confirm path: the button is disabled while the
       * publish runs, so the notice stays up until it has settled and only
       * then hands focus back to a button that can take it.
       */
      it('hands focus back after confirming, once the publish has settled', async () => {
        await renderPublished(preview({ changes: EVERY_CHANGE }));
        const button = screen.getByRole('button', {
          name: 'Erneut veröffentlichen',
        });
        button.focus();
        pressPublish();

        const dialog = await screen.findByRole('dialog');
        fireEvent.click(
          within(dialog).getByRole('button', {
            name: 'Erneut veröffentlichen',
          }),
        );

        await waitFor(() => {
          expect(screen.queryByRole('dialog')).toBeNull();
        });
        expect(document.activeElement).toBe(button);
      });

      /**
       * The cage, in both directions — including from the panel itself, which
       * is where focus sits right after opening. Shift+Tab from there used to
       * walk straight out of the dialog into the builder behind it.
       */
      it('keeps Tab inside the notice', async () => {
        await renderPublished(preview({ changes: EVERY_CHANGE }));
        pressPublish();
        const dialog = await screen.findByRole('dialog');
        const cancel = within(dialog).getByRole('button', {
          name: 'Abbrechen',
        });
        const confirm = within(dialog).getByRole('button', {
          name: 'Erneut veröffentlichen',
        });

        confirm.focus();
        fireEvent.keyDown(dialog, { key: 'Tab' });
        expect(document.activeElement).toBe(cancel);

        cancel.focus();
        fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
        expect(document.activeElement).toBe(confirm);

        dialog.focus();
        fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
        expect(document.activeElement).toBe(confirm);
      });
    });

    /**
     * Nothing to warn about without a single answer: a removed question strands
     * no data, so a modal here would be friction that teaches editors to click
     * the notice away unread.
     */
    it('does not stop a republish that no answer is affected by', async () => {
      const fetchMock = await renderPublished(
        preview({ responseCount: 0, changes: EVERY_CHANGE }),
      );
      pressPublish();

      await waitFor(() => {
        expect(publishCalls(fetchMock)).toHaveLength(1);
      });
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    /** A fixed typo in the title changes no question — no empty list for it. */
    it('does not stop a republish that changes no question', async () => {
      const fetchMock = await renderPublished(preview({ responseCount: 7 }));
      pressPublish();

      await waitFor(() => {
        expect(publishCalls(fetchMock)).toHaveLength(1);
      });
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    /** A first publication has no version in force to differ from. */
    it('asks nothing before the very first publication', async () => {
      const fetchMock = stubFetch().mockResolvedValue(
        jsonResponse(200, detail()),
      );
      renderWithQuery(
        <BuilderView
          formId={FORM_ID}
          canBuild
          canManageTemplates
          canUpdateTemplates
          canManageFormSettings
        />,
      );
      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: 'Veröffentlichen' }),
        ).toBeDefined();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Veröffentlichen' }));

      await waitFor(() => {
        expect(publishCalls(fetchMock)).toHaveLength(1);
      });
      expect(
        fetchMock.mock.calls.filter(([input]) =>
          pathOf(input).endsWith('/publish-preview'),
        ),
      ).toHaveLength(0);
    });

    /**
     * A preview that cannot be fetched must not turn into a silent publish:
     * „ich weiß nicht, was sich ändert" is exactly what the editor has to hear
     * before deciding.
     */
    it('says so when the preview cannot be fetched, and publishes nothing yet', async () => {
      const fetchMock = await renderPublished(undefined);
      pressPublish();

      const dialog = await screen.findByRole('dialog');
      expect(dialog.textContent).toContain('nicht ermitteln');
      expect(publishCalls(fetchMock)).toHaveLength(0);
    });

    /**
     * Two independent problems, and the notice used to show only one of them
     * because they were the two arms of a single `? :`.
     */
    it('states both problems when the preview failed and the draft moved', async () => {
      await renderPublished(undefined);
      pressPublish();
      const dialog = await screen.findByRole('dialog');

      act(() => {
        useBuilderStore.getState().setTitle('Inzwischen umbenannt');
      });

      expect(dialog.textContent).toContain('nicht ermitteln');
      expect(dialog.textContent).toContain('Der Entwurf hat sich geändert');
    });

    describe('the state the notice describes', () => {
      /**
       * The freshness check sits at the **publish**, not at the notice.
       *
       * While the preview is in flight the publish button is disabled — but the
       * canvas is not: there is no dialog and no scrim yet. A keystroke in that
       * window used to be followed by a publish of the *stored* draft while the
       * bar read „Nicht gespeichert".
       */
      it('does not publish a draft that changed while the preview was in flight', async () => {
        const gate = deferred();
        const fetchMock = await renderPublished(
          preview({ responseCount: 0 }),
          gate.promise,
        );
        pressPublish();

        act(() => {
          useBuilderStore.getState().setTitle('Während der Prüfung getippt');
        });
        await act(async () => {
          gate.release();
          await gate.promise;
        });

        expect(publishCalls(fetchMock)).toHaveLength(0);
        const dialog = await screen.findByRole('dialog');
        expect(dialog.textContent).toContain('Der Entwurf hat sich geändert');
        expect(screen.getByText('Nicht gespeichert')).toBeDefined();
      });

      /**
       * The second, nastier shape of the same hole: the editor's **own** save
       * lands during the check. Publishing the revision from the press would
       * answer 409 — and the builder would tell them „jemand anderem" had
       * changed the form.
       */
      it('does not publish a revision the editor themselves moved on from', async () => {
        const gate = deferred();
        const fetchMock = await renderPublished(
          preview({ responseCount: 0 }),
          gate.promise,
        );
        pressPublish();

        act(() => {
          useBuilderStore.getState().markSaved(2);
        });
        await act(async () => {
          gate.release();
          await gate.promise;
        });

        expect(publishCalls(fetchMock)).toHaveLength(0);
        // And above all: no accusation aimed at somebody else.
        expect(screen.queryByText(/zwischenzeitlich/)).toBeNull();
      });

      /** One press, one publish — even while the preview is still travelling. */
      it('starts only one publish while the preview is in flight', async () => {
        const gate = deferred();
        const fetchMock = await renderPublished(
          preview({ responseCount: 0 }),
          gate.promise,
        );
        pressPublish();
        pressPublish();

        await act(async () => {
          gate.release();
          await gate.promise;
        });
        await waitFor(() => {
          expect(publishCalls(fetchMock)).toHaveLength(1);
        });
        expect(publishCalls(fetchMock)).toHaveLength(1);
      });

      it('refuses to confirm a notice that describes another state of the draft', async () => {
        const fetchMock = await renderPublished(
          preview({ changes: EVERY_CHANGE }),
        );
        pressPublish();
        const dialog = await screen.findByRole('dialog');

        act(() => {
          useBuilderStore.getState().setTitle('Inzwischen umbenannt');
        });

        const confirm = within(dialog).getByRole('button', {
          name: 'Erneut veröffentlichen',
        });
        expect(confirm).toHaveProperty('disabled', true);
        expect(dialog.textContent).toContain('Der Entwurf hat sich geändert');

        fireEvent.click(confirm);
        expect(publishCalls(fetchMock)).toHaveLength(0);
      });

      /**
       * What the editor just read stays on screen. Taking the list away would
       * leave them with „bitte speichern" and no memory of the decision.
       */
      it('keeps the overview readable once it is out of date', async () => {
        await renderPublished(preview({ changes: EVERY_CHANGE }));
        pressPublish();
        const dialog = await screen.findByRole('dialog');

        act(() => {
          useBuilderStore.getState().setTitle('Inzwischen umbenannt');
        });

        expect(
          within(group(dialog, REMOVED_GROUP)).getByText(/Fahrgemeinschaft/),
        ).toBeDefined();
        expect(dialog.textContent).toContain(
          'Es liegen bereits 7 Antworten vor.',
        );
      });

      /**
       * Same rule from the other side: the preview describes the revision the
       * server had. If somebody else saved in between, the notice describes a
       * document this editor has never seen.
       */
      it('refuses to confirm a preview taken of somebody else’s revision', async () => {
        const fetchMock = await renderPublished(
          preview({ revision: 9, changes: EVERY_CHANGE }),
        );
        pressPublish();
        const dialog = await screen.findByRole('dialog');

        const confirm = within(dialog).getByRole('button', {
          name: 'Erneut veröffentlichen',
        });
        expect(confirm).toHaveProperty('disabled', true);
        fireEvent.click(confirm);
        expect(publishCalls(fetchMock)).toHaveLength(0);
      });
    });

    /**
     * The requirement — „Ein Platzhalter darf nicht ins Leere zeigen."
     *
     * The server refuses such a publish with a 422; the decision says the
     * announcement of Konzept no. 23 **gets this check as well**, so the editor
     * reads it before pressing rather than after. These cases are therefore
     * about the *dialog* and the button in it, not about the refusal.
     */
    describe('the publish lock of a dangling placeholder', () => {
      const BLOCKED = [
        {
          notificationName: 'Bestätigung an Teilnehmer',
          token: '{{frage:019fe500-0000-7000-8000-0000000000c1}}',
          label: 'E-Mail-Adresse',
          places: ['recipients', 'body'],
        },
      ];

      it('stops the publish even when no answer is on file and nothing else changed', async () => {
        const fetchMock = await renderPublished(
          preview({ responseCount: 0, blocked: BLOCKED }),
        );
        pressPublish();

        // Without `blocked` this combination publishes straight away (see „does
        // not stop a republish that no answer is affected by" above), so the
        // dialog appearing at all is the assertion.
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByTestId('publish-blocked')).toBeDefined();
        expect(publishCalls(fetchMock)).toHaveLength(0);
      });

      /**
       * The requirement, verbatim: the message „nennt die betroffene
       * Benachrichtigung und den Platzhalter" — otherwise the editor searches
       * *n* texts by hand. Both, and where in the notification it sits.
       */
      it('names the notification, the placeholder and where it sits', async () => {
        await renderPublished(preview({ blocked: BLOCKED }));
        pressPublish();

        const blocked = within(await screen.findByRole('dialog')).getByTestId(
          'publish-blocked',
        );
        expect(blocked.textContent).toContain('Bestätigung an Teilnehmer');
        expect(blocked.textContent).toContain(
          '{{frage:019fe500-0000-7000-8000-0000000000c1}}',
        );
        expect(blocked.textContent).toContain('E-Mail-Adresse');
        expect(blocked.textContent).toContain('Empfängerliste');
        expect(blocked.textContent).toContain('Text');
      });

      it('does not offer a confirm button that the server would refuse', async () => {
        const fetchMock = await renderPublished(
          preview({ blocked: BLOCKED, changes: EVERY_CHANGE }),
        );
        pressPublish();
        const dialog = await screen.findByRole('dialog');

        const confirm = within(dialog).getByRole('button', {
          name: 'Erneut veröffentlichen',
        });
        expect(confirm).toHaveProperty('disabled', true);
        fireEvent.click(confirm);
        expect(publishCalls(fetchMock)).toHaveLength(0);
      });

      /**
       * **The lead belongs to its own list**, and it is a heading.
       *
       * Two things at once, both about the two groups the block has carried.
       * The lead is asserted to be the *placeholder* one and the
       * condition lead to be absent, because the block's `textContent` contains
       * everything either way — swapping the two `lead` props renders a list of
       * notifications under „Diese Fragen haben eine bedingte Anzeige …" and no
       * other case here would notice.
       *
       * `getByRole('heading')` rather than `getByText`: since 0.2 both leads can
       * be mounted at once, and two `role="alert"` live regions appearing
       * together are typically announced as one of them or as neither. As
       * headings they are announced with the block and are something to navigate
       * between — and the assertion pins that, because a `role="alert"` put back
       * on the element would take the heading role away.
       */
      it('leads the list with its own sentence, as a heading', async () => {
        await renderPublished(preview({ blocked: BLOCKED }));
        pressPublish();

        const blocked = within(await screen.findByRole('dialog')).getByTestId(
          'publish-blocked',
        );
        expect(
          within(blocked).getByRole('heading', {
            name: ORPHANED_PLACEHOLDER_LEAD,
          }),
        ).toBeDefined();
        expect(blocked.textContent).not.toContain(UNRESOLVABLE_CONDITION_LEAD);
      });

      /** Nothing dangling, nothing said — the block is not a permanent banner. */
      it('says nothing when no placeholder dangles', async () => {
        await renderPublished(preview({ changes: EVERY_CHANGE, blocked: [] }));
        pressPublish();

        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).queryByTestId('publish-blocked')).toBeNull();
        expect(
          within(dialog).getByRole('button', {
            name: 'Erneut veröffentlichen',
          }),
        ).toHaveProperty('disabled', false);
      });

      /**
       * A server one deploy behind sends no `blocked` at all. The field
       * defaults to `[]`, so the dialog behaves exactly as it did before the
       * field existed — additive means additive.
       */
      it('treats a payload without the field as nothing blocked', async () => {
        await renderPublished(preview({ changes: EVERY_CHANGE }));
        pressPublish();

        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).queryByTestId('publish-blocked')).toBeNull();
      });
    });

    /**
     * The requirement — „Der Vorschau-Dialog trägt den Bedingungs-Befund."
     *
     * The same lock as above, one requirement further along: the server
     * refuses a draft whose bedingte Anzeige points at nothing with a 422
     * , and since 0.2 the dialog says so **before** the press. These
     * cases are about the dialog and its button; that the server produces the
     * finding at all is measured where it is produced
     * (`apps/api/test/forms/condition-publish-lock.spec.ts`) — a fixture cannot
     * prove that half, and that gap went unnoticed for a long stretch.
     */
    describe('the publish lock of an unresolvable condition', () => {
      const BLOCKED_CONDITION = [
        {
          kind: 'condition',
          questionLabel: 'Mitfahrgelegenheit',
          sourceLabel: 'Anreise',
          defect: 'missing',
        },
      ];

      it('stops the publish even when no answer is on file and nothing else changed', async () => {
        const fetchMock = await renderPublished(
          preview({ responseCount: 0, blocked: BLOCKED_CONDITION }),
        );
        pressPublish();

        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByTestId('publish-blocked')).toBeDefined();
        expect(publishCalls(fetchMock)).toHaveLength(0);
      });

      /**
       * **The sentence, not a paraphrase.** The requirement asks the dialog to
       * name the affected question in „derselbe Text, den die 422 nennt", so the
       * assertion is the shared function's own output — a dialog that assembled
       * its own wording from `defect` would go red here even while it mentioned
       * both captions.
       */
      it('renders the finding in the words of the refusal', async () => {
        await renderPublished(preview({ blocked: BLOCKED_CONDITION }));
        pressPublish();

        const blocked = within(await screen.findByRole('dialog')).getByTestId(
          'publish-blocked',
        );
        expect(blocked.textContent).toContain(
          unresolvableConditionText({
            questionLabel: 'Mitfahrgelegenheit',
            sourceLabel: 'Anreise',
            defect: 'missing',
          }),
        );
        // Both captions in as many words, so the assertion above cannot pass by
        // rendering an empty string against an empty expectation.
        expect(blocked.textContent).toContain('Mitfahrgelegenheit');
        expect(blocked.textContent).toContain('Anreise');
        // The half sentence that makes the type change readable — „Anreise" is
        // still on the canvas under that very caption.
        expect(blocked.textContent).toContain('Typwechsel');
      });

      /** The mirror of „leads the list with its own sentence" above. */
      it('leads the list with its own sentence, as a heading', async () => {
        await renderPublished(preview({ blocked: BLOCKED_CONDITION }));
        pressPublish();

        const blocked = within(await screen.findByRole('dialog')).getByTestId(
          'publish-blocked',
        );
        expect(
          within(blocked).getByRole('heading', {
            name: UNRESOLVABLE_CONDITION_LEAD,
          }),
        ).toBeDefined();
        expect(blocked.textContent).not.toContain(ORPHANED_PLACEHOLDER_LEAD);
      });

      it('does not offer a confirm button that the server would refuse', async () => {
        const fetchMock = await renderPublished(
          preview({ blocked: BLOCKED_CONDITION, changes: EVERY_CHANGE }),
        );
        pressPublish();
        const dialog = await screen.findByRole('dialog');

        const confirm = within(dialog).getByRole('button', {
          name: 'Erneut veröffentlichen',
        });
        expect(confirm).toHaveProperty('disabled', true);
        fireEvent.click(confirm);
        expect(publishCalls(fetchMock)).toHaveLength(0);
      });

      /**
       * Both kinds at once — the case one field for two shapes exists for. A
       * dialog that rendered only the first kind it found would drop half the
       * repair list, and the editor would fix one and be refused again.
       */
      it('says both when a placeholder and a condition block the same publish', async () => {
        await renderPublished(
          preview({
            blocked: [
              ...BLOCKED_CONDITION,
              {
                notificationName: 'Bestätigung an Teilnehmer',
                token: '{{frage:019fe500-0000-7000-8000-0000000000c1}}',
                label: 'E-Mail-Adresse',
                places: ['recipients'],
              },
            ],
          }),
        );
        pressPublish();

        const blocked = within(await screen.findByRole('dialog')).getByTestId(
          'publish-blocked',
        );
        expect(blocked.textContent).toContain('Mitfahrgelegenheit');
        expect(blocked.textContent).toContain('Bestätigung an Teilnehmer');
        expect(blocked.textContent).toContain(
          '{{frage:019fe500-0000-7000-8000-0000000000c1}}',
        );
      });
    });
  });

  /**
   * „Knopf sperren + Erfolgsmeldung" (Konzept no. 29).
   *
   * The two halves belong together and are tested together: republishing used
   * to raise the version number over an unchanged document, and the rising
   * number was at the same time the **only** sign that the button had done
   * anything. Locking it without the message would leave the most consequential
   * control in the builder silent.
   *
   * Everything below goes through the bar the editor actually reads.
   */
  describe('the publish state (Konzept Nr. 29)', () => {
    /** The path a `fetch` call went to — `http.ts` always passes a string. */
    function urlOf(input: unknown): string {
      return typeof input === 'string' ? input : '';
    }

    function methodOf(init: unknown): string {
      return (init as { method?: string } | undefined)?.method ?? 'GET';
    }

    /**
     * A builder on a form the test describes, whose publish POST answers with
     * `afterPublish`.
     *
     * The answer is kept in a variable rather than queued: a successful publish
     * writes it into the query cache *and* invalidates it, so the refetch that
     * follows has to return the new state too — a mock that kept answering the
     * old one would put „es gibt etwas zu veröffentlichen" back on screen and
     * hide exactly the regression this describes.
     */
    function renderForm(
      initial: Record<string, unknown>,
      options: {
        afterPublish?: Record<string, unknown>;
        publishStatus?: number;
        /** Body of the refused publish — a refusal the server put words to. */
        publishBody?: Record<string, unknown>;
      } = {},
    ): ReturnType<typeof stubFetch> {
      let current = detail(initial);
      return stubFetch().mockImplementation((input, init) => {
        if (urlOf(input).endsWith('/publish-preview')) {
          return Promise.resolve(
            jsonResponse(200, {
              revision: current.revision,
              publishedVersion: current.publishedVersion, // No answers on file, so nothing stops for Konzept no. 23
              // notice — this suite is about the bar, not the dialog.
              responseCount: 0,
              changes: { removed: [], added: [], typeChanged: [] },
            }),
          );
        }
        if (urlOf(input).endsWith('/publish') && methodOf(init) === 'POST') {
          if (options.publishStatus !== undefined) {
            return Promise.resolve(
              jsonResponse(
                options.publishStatus,
                // **No `message`.** These cases are about the status code, and
                // since the requirement a 422 body that carries a sentence is
                // shown instead of the client's own wording (see the alert
                // chain in `BuilderView`). A stub sentence here would make
                // every one of them assert the stub rather than the rule; the
                // sentence path has its own test below.
                options.publishBody ?? {},
              ),
            );
          }
          current = detail({ ...initial, ...options.afterPublish });
          return Promise.resolve(jsonResponse(200, current));
        }
        return Promise.resolve(jsonResponse(200, current));
      });
    }

    async function open(
      initial: Record<string, unknown>,
      options?: Parameters<typeof renderForm>[1],
    ): Promise<ReturnType<typeof stubFetch>> {
      const fetchMock = renderForm(initial, options);
      renderWithQuery(
        <BuilderView
          formId={FORM_ID}
          canBuild
          canManageTemplates
          canUpdateTemplates
          canManageFormSettings
        />,
      );
      await waitFor(() => {
        expect(screen.getByLabelText('Formularname')).toBeDefined();
      });
      return fetchMock;
    }

    /** The publish control, whichever of its two labels it currently wears. */
    function publishButton(): HTMLElement {
      return screen.getByRole('button', {
        name: /^(Erneut veröffentlichen|Veröffentlichen)$/,
      });
    }

    const UP_TO_DATE = {
      status: 'active',
      publishedVersion: 3,
      revision: 4,
      hasUnpublishedChanges: false,
    };

    const WITH_CHANGES = {
      status: 'active',
      publishedVersion: 3,
      revision: 4,
      hasUnpublishedChanges: true,
    };

    it('locks the button when the draft is already the version in force', async () => {
      await open(UP_TO_DATE);

      expect(publishButton()).toHaveProperty('disabled', true);
    });

    /**
     * The state is readable **before** the press, which is the whole reason the
     * server sends the flag: the rising version number used to be the only way
     * to find out, and by then it had already risen.
     */
    it('says which Fassung is current, in a live region', async () => {
      await open(UP_TO_DATE);

      const state = screen.getByText('Fassung 3 ist aktuell');
      expect(state).toHaveProperty('role', 'status');
    });

    it('offers the button again once the saved draft differs', async () => {
      await open(WITH_CHANGES);

      expect(publishButton()).toHaveProperty('disabled', false);
      expect(screen.queryByText(/ist aktuell/)).toBeNull();
    });

    /**
     * A form that has never been published has nothing to compare against, so
     * it must never sit behind a locked button — the case that would otherwise
     * be unreachable altogether.
     */
    it('never locks the very first publication', async () => {
      await open({ status: 'draft', publishedVersion: null });

      expect(
        screen.getByRole('button', { name: 'Veröffentlichen' }),
      ).toHaveProperty('disabled', false);
      expect(screen.queryByText(/ist aktuell/)).toBeNull();
    });

    /**
     * **The two locked states must not read alike.** Both disable the button,
     * and labelling them the same would send an editor with unsaved work away
     * as though they were finished — the more expensive of the two mistakes,
     * because their draft never reaches a participant.
     */
    describe('the two reasons the button can be locked', () => {
      it('asks for a save rather than claiming the Fassung is current', async () => {
        await open(UP_TO_DATE);

        fireEvent.change(screen.getByLabelText('Formularname'), {
          target: { value: 'Noch nicht gespeichert' },
        });

        expect(publishButton()).toHaveProperty('disabled', true);
        expect(
          screen.getByText('Erst speichern, dann veröffentlichen'),
        ).toBeDefined();
        // The sentence of the *other* reason is gone, not merely joined.
        expect(screen.queryByText(/ist aktuell/)).toBeNull();
      });

      it('says the Fassung is current only while nothing is unsaved', async () => {
        await open(UP_TO_DATE);

        expect(screen.getByText('Fassung 3 ist aktuell')).toBeDefined();
        expect(
          screen.queryByText('Erst speichern, dann veröffentlichen'),
        ).toBeNull();
      });
    });

    /**
     * The visible success the second report asked for. Announced through the
     * same `role="status"` mechanism the save label uses, because there is no
     * toast system in this app and inventing one here would be a second way of
     * saying the same thing.
     */
    it('announces the Fassung it just published', async () => {
      const fetchMock = await open(WITH_CHANGES, {
        afterPublish: {
          status: 'active',
          publishedVersion: 4,
          revision: 5,
          hasUnpublishedChanges: false,
        },
      });

      fireEvent.click(publishButton());

      const message = await screen.findByText('Fassung 4 veröffentlicht');
      expect(message).toHaveProperty('role', 'status');
      // …and the button has locked itself behind the new state, so a second
      // press cannot mint version 5 out of the same document.
      expect(publishButton()).toHaveProperty('disabled', true);
      expect(
        fetchMock.mock.calls.filter(
          ([input, init]) =>
            urlOf(input).endsWith('/publish') && methodOf(init) === 'POST',
        ),
      ).toHaveLength(1);
    });

    /**
     * A success message that outlived its truth is worse than none: the editor
     * reads „Fassung 4 veröffentlicht" over a draft that is not in version 4.
     */
    it('drops the success message as soon as there is something to publish again', async () => {
      await open(WITH_CHANGES, {
        afterPublish: {
          status: 'active',
          publishedVersion: 4,
          revision: 5,
          hasUnpublishedChanges: false,
        },
      });

      fireEvent.click(publishButton());
      await screen.findByText('Fassung 4 veröffentlicht');

      fireEvent.change(screen.getByLabelText('Formularname'), {
        target: { value: 'Weiter gebaut' },
      });

      expect(screen.queryByText('Fassung 4 veröffentlicht')).toBeNull();
      expect(
        screen.getByText('Erst speichern, dann veröffentlichen'),
      ).toBeDefined();
    });

    /**
     * The race the locked button cannot cover: another tab published this very
     * draft a moment ago. The refusal is a **422**, not the 409 of a stale
     * revision, and the two must not share a sentence — „bitte neu laden" is
     * wrong advice about a form that is already up to date.
     */
    it('reports the server’s refusal without sending the editor to reload', async () => {
      await open(WITH_CHANGES, { publishStatus: 422 });

      fireEvent.click(publishButton());

      await waitFor(() => {
        expect(screen.getByRole('alert').textContent).toContain(
          'nichts zu veröffentlichen',
        );
      });
      expect(screen.getByRole('alert').textContent).not.toContain(
        'zwischenzeitlich',
      );
    });

    /**
     * The same stale-claim problem as the success message above, one layer up
     * — and it was missed there while being carefully avoided here. A mutation
     * error outlives the situation that produced it: the editor reads „der
     * Entwurf entspricht bereits der veröffentlichten Fassung", types on, and
     * the sentence keeps standing over a draft that now differs. The state line
     * beside it already asks for a save, so the page contradicts itself.
     */
    it('drops the refusal once the draft differs from the published version again', async () => {
      await open(WITH_CHANGES, { publishStatus: 422 });

      fireEvent.click(publishButton());
      await waitFor(() => {
        expect(screen.getByRole('alert').textContent).toContain(
          'nichts zu veröffentlichen',
        );
      });

      fireEvent.change(screen.getByLabelText('Formularname'), {
        target: { value: 'Doch noch etwas geändert' },
      });

      // `waitFor`, unlike the success-message case above: that one is derived
      // state and vanishes in the same render, this one is a mutation reset and
      // lands a tick later. Waiting is the honest description, not a workaround.
      await waitFor(() => {
        expect(screen.queryByText(/nichts zu veröffentlichen/)).toBeNull();
      });
      expect(
        screen.getByText('Erst speichern, dann veröffentlichen'),
      ).toBeDefined();
    });

    /**
     * „Veröffentlichen gibt keine sichtbare Rückmeldung" was the second of the
     * two reports this work item answers. A failed publish reporting
     * „Speichern fehlgeschlagen" would have left it with the wrong one — the
     * editor looks for a save that never happened.
     */
    it('names the failed publish rather than blaming the save', async () => {
      await open(WITH_CHANGES, { publishStatus: 500 });

      fireEvent.click(publishButton());

      await waitFor(() => {
        expect(screen.getByRole('alert').textContent).toContain(
          'Veröffentlichen fehlgeschlagen',
        );
      });
      expect(screen.getByRole('alert').textContent).not.toContain(
        'Speichern fehlgeschlagen',
      );
    });

    it('still sends the editor to reload when somebody else was faster', async () => {
      await open(WITH_CHANGES, { publishStatus: 409 });

      fireEvent.click(publishButton());

      await waitFor(() => {
        expect(screen.getByRole('alert').textContent).toContain(
          'zwischenzeitlich',
        );
      });
    });
  });

  /**
   * The Editor-Rundlauf for, per type: **creating, reordering and removing
   * rows and columns** — through the panel, and
   * measured on the document the store holds, because that is what gets saved.
   */
  describe('Matrix und Tabelle im Inspektor', () => {
    function currentQuestion() {
      return useBuilderStore.getState().pages[0]?.questions[0];
    }

    it('starts a Matrix with the handoff’s own rows and scale', async () => {
      await renderLoaded();
      fireEvent.click(screen.getByRole('button', { name: 'Matrix' }));

      const question = currentQuestion();
      expect(question?.type).toBe('matrix');
      expect(question?.type === 'matrix' && question.rows).toStrictEqual([
        { value: 'organisation', label: 'Organisation' },
        { value: 'programm', label: 'Programm' },
        { value: 'verpflegung', label: 'Verpflegung' },
      ]);
      expect(screen.getByLabelText('Zeilen (Aussagen) 1')).toHaveProperty(
        'value',
        'Organisation',
      );
      expect(screen.getByLabelText('Spalten (Skala) 4')).toHaveProperty(
        'value',
        'Schlecht',
      );
    });

    it('adds, renames, reorders and removes a Matrix row', async () => {
      await renderLoaded();
      fireEvent.click(screen.getByRole('button', { name: 'Matrix' }));

      fireEvent.click(screen.getByRole('button', { name: '+ Zeile' }));
      expect(rowLabels()).toStrictEqual([
        'Organisation',
        'Programm',
        'Verpflegung',
        'Neue Zeile',
      ]);

      fireEvent.change(screen.getByLabelText('Zeilen (Aussagen) 4'), {
        target: { value: 'Unterkunft' },
      });
      expect(rowLabels()).toStrictEqual([
        'Organisation',
        'Programm',
        'Verpflegung',
        'Unterkunft',
      ]);

      fireEvent.click(
        screen.getByRole('button', { name: 'Zeilen (Aussagen) 4 nach oben' }),
      );
      expect(rowLabels()).toStrictEqual([
        'Organisation',
        'Programm',
        'Unterkunft',
        'Verpflegung',
      ]);

      fireEvent.click(
        screen.getByRole('button', { name: 'Zeilen (Aussagen) 1 entfernen' }),
      );
      expect(rowLabels()).toStrictEqual([
        'Programm',
        'Unterkunft',
        'Verpflegung',
      ]);
    });

    /**
     * Renaming keeps the **value**, which is what stored answers and export
     * column keys point at — the rule `questionOptionSchema` states and the
     * one thing a list editor can quietly break.
     */
    it('keeps a row’s value when its caption is renamed', async () => {
      await renderLoaded();
      fireEvent.click(screen.getByRole('button', { name: 'Matrix' }));

      fireEvent.change(screen.getByLabelText('Zeilen (Aussagen) 1'), {
        target: { value: 'Organisation & Ablauf' },
      });

      const question = currentQuestion();
      // Narrowed by `type`, not by `'rows' in question`: a table also has
      // `rows`, and there it is a **number** — the one place the two types'
      // vocabularies overlap.
      const rows = question?.type === 'matrix' ? question.rows : [];
      expect(rows[0]).toStrictEqual({
        value: 'organisation',
        label: 'Organisation & Ablauf',
      });
    });

    it('switches a Matrix to Mehrfachauswahl je Zeile', async () => {
      await renderLoaded();
      fireEvent.click(screen.getByRole('button', { name: 'Matrix' }));

      fireEvent.click(screen.getByLabelText('Mehrfachauswahl je Zeile'));

      const question = currentQuestion();
      expect(question && 'multiple' in question && question.multiple).toBe(
        true,
      );
    });

    it('adds a Tabellenspalte, changes its Zelltyp and seeds a Liste with options', async () => {
      await renderLoaded();
      fireEvent.click(screen.getByRole('button', { name: 'Tabelle' }));

      fireEvent.click(screen.getByRole('button', { name: '+ Spalte' }));
      fireEvent.change(screen.getByLabelText('Spalte 3'), {
        target: { value: 'Kategorie' },
      });
      fireEvent.change(screen.getByLabelText('Spalte 3: Art'), {
        target: { value: 'select' },
      });

      const question = currentQuestion();
      const columns = question?.type === 'table' ? question.columns : undefined;
      expect(columns).toHaveLength(3);
      // A „Liste" cannot exist without entries — the schema says so, and the
      // panel seeds them rather than producing a document that will not parse.
      expect(columns?.[2]).toStrictEqual({
        key: 'spalte-3',
        label: 'Kategorie',
        type: 'select',
        options: [
          { value: 'option-1', label: 'Option 1' },
          { value: 'option-2', label: 'Option 2' },
        ],
      });
      expect(screen.getByLabelText('Spalte 3: Einträge 1')).toBeDefined();
    });

    it('reorders and removes a Tabellenspalte', async () => {
      await renderLoaded();
      fireEvent.click(screen.getByRole('button', { name: 'Tabelle' }));

      fireEvent.click(
        screen.getByRole('button', { name: 'Spalte 2 nach oben' }),
      );
      expect(columnLabels()).toStrictEqual(['Spalte 2', 'Spalte 1']);

      fireEvent.click(
        screen.getByRole('button', { name: 'Spalte 1 entfernen' }),
      );
      expect(columnLabels()).toStrictEqual(['Spalte 1']);
    });

    /**
     * The setting the handoff does **not** have (its `rows` lives only in the
     * data model): the row count is editable, and it is clamped rather than
     * left to the schema to refuse — a field that visibly rejects the number
     * just typed reads as broken.
     *
     * **„Startzeilen", not „Zeilen",:** with „Zeilen ergänzbar"
     * beside it the bare word no longer says which of the two numbers this is.
     * What a participant may grow the table to lives in
     * `builder/table-row-growth.test.tsx`.
     */
    it('makes the row count editable and clamps it', async () => {
      await renderLoaded();
      fireEvent.click(screen.getByRole('button', { name: 'Tabelle' }));

      const rowCount = screen.getByLabelText('Startzeilen');
      expect(rowCount).toHaveProperty('value', '2');

      fireEvent.change(rowCount, { target: { value: '4' } });
      expect(rowsOfTable()).toBe(4);

      fireEvent.change(rowCount, { target: { value: '99' } });
      expect(rowsOfTable()).toBe(20);

      fireEvent.change(rowCount, { target: { value: '0' } });
      expect(rowsOfTable()).toBe(1);
    });

    function rowLabels(): string[] {
      const question = currentQuestion();
      return question?.type === 'matrix'
        ? question.rows.map((row) => row.label)
        : [];
    }

    function columnLabels(): string[] {
      const question = currentQuestion();
      return question?.type === 'table'
        ? question.columns.map((column) => column.label)
        : [];
    }

    function rowsOfTable(): number | undefined {
      const question = currentQuestion();
      return question?.type === 'table' ? question.rows : undefined;
    }
  });

  /**
   * **The button „⚙ Einstellungen" is gone** (review finding 18) — the way to the
   * form settings is not.
   *
   * It stood in the same bar as „Speichern" and „Veröffentlichen" and
   * led to an address the subheader one line above already offers
   * (`shell/FormNav.tsx`, „⚙ Formular-Einstellungen", under the same right
   * `can_manage_form_settings`) — on narrow devices out of the same
   * `formNavEntries()` in the menu (`shell/MobileMenuSheet.tsx`). Both ways are
   * checked there; what remains here is the statement that this bar no longer
   * carries the second one.
   */
  it('offers no settings button of its own any more', async () => {
    await renderLoaded();

    expect(screen.queryByRole('button', { name: /Einstellungen/ })).toBeNull();
    // Not gone because the bar would be empty.
    expect(screen.getByRole('button', { name: 'Speichern' })).toBeDefined();
  });

  /**
   * **„Änderungen verwerfen"** (review finding 18).
   *
   * Four questions, and the third is the load-bearing one: the button is off as long as
   * there is nothing to discard; it asks back instead of discarding at once;
   * „Abbrechen" leaves everything standing; and „Verwerfen" restores the last
   * **saved** state — not an empty one.
   *
   * *Counter-check:* replacing the `load` in `onDiscardChanges` by `reset` → the
   * last case turns red, because the builder then stands there without a form.
   */
  describe('„Änderungen verwerfen"', () => {
    it('is off while there is nothing to discard', async () => {
      await renderLoaded();

      expect(
        screen.getByRole<HTMLButtonElement>('button', {
          name: 'Änderungen verwerfen',
        }).disabled,
      ).toBe(true);
    });

    it('asks before it throws anything away, and „Abbrechen" keeps it', async () => {
      await renderLoaded();

      fireEvent.change(screen.getByLabelText('Formularname'), {
        target: { value: 'Umbenannt' },
      });
      fireEvent.click(
        screen.getByRole('button', { name: 'Änderungen verwerfen' }),
      );

      const dialog = screen.getByRole('dialog');
      expect(
        within(dialog).getByRole('heading', { name: 'Änderungen verwerfen' }),
      ).toBeDefined();

      fireEvent.click(
        within(dialog).getByRole('button', { name: 'Abbrechen' }),
      );

      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByLabelText('Formularname')).toHaveProperty(
        'value',
        'Umbenannt',
      );
      expect(useBuilderStore.getState().isDirty).toBe(true);
    });

    it('puts the last saved state back when it is confirmed', async () => {
      await renderLoaded();

      fireEvent.change(screen.getByLabelText('Formularname'), {
        target: { value: 'Umbenannt' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Text' }));
      expect(useBuilderStore.getState().isDirty).toBe(true);

      fireEvent.click(
        screen.getByRole('button', { name: 'Änderungen verwerfen' }),
      );
      fireEvent.click(
        within(screen.getByRole('dialog')).getByRole('button', {
          name: 'Verwerfen',
        }),
      );

      expect(screen.getByLabelText('Formularname')).toHaveProperty(
        'value',
        'Bestandsmeldung',
      );
      expect(screen.getByText('0 Fragen')).toBeDefined();
      expect(useBuilderStore.getState().isDirty).toBe(false);
      // The loaded state, not an empty one: the server's page stands
      // there again, with its revision.
      expect(useBuilderStore.getState().revision).toBe(1);
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  /**
   * Regression.
   *
   * Every door into the builder is hidden without `can_build` now, so what
   * reaches this view without it is a bookmark or a link in a mail — and that
   * is the case that used to cost work: the editor was fully operable and
   * `PUT /api/forms/:id` refused the save at the end.
   *
   * **Explained, not silently stripped**: with the two buttons gone and nothing
   * said, the bar would look like a page that had not finished loading — so the
   * sentence stands before any work is done rather than after it. Comfort, not
   * a boundary; the guard answers 403 whatever this view renders.
   */
  describe('without can_build', () => {
    it('offers neither „Speichern" nor „Veröffentlichen" and says why', async () => {
      await renderLoaded({}, true, false);

      expect(screen.queryByRole('button', { name: 'Speichern' })).toBeNull();
      expect(
        screen.queryByRole('button', { name: 'Veröffentlichen' }),
      ).toBeNull();
      expect(
        screen.getByText(/der Rolle „Bearbeiten" vorbehalten/),
      ).toBeDefined();
    });

    it('offers both again with can_build', async () => {
      await renderLoaded();

      expect(screen.getByRole('button', { name: 'Speichern' })).toBeDefined();
      expect(
        screen.getByRole('button', { name: 'Veröffentlichen' }),
      ).toBeDefined();
      expect(
        screen.queryByText(/der Rolle „Bearbeiten" vorbehalten/),
      ).toBeNull();
    });
  });

  it('says so when the form does not exist', async () => {
    stubFetch().mockResolvedValue(jsonResponse(404, { message: 'weg' }));
    renderWithQuery(
      <BuilderView
        formId={FORM_ID}
        canBuild
        canManageTemplates
        canUpdateTemplates
        canManageFormSettings
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('gibt es nicht');
    });
  });

  /**
   * The guard that protects unsaved work: a refetch of the same form must not
   * refill the store. Without it, every background refetch would silently
   * discard everything typed since the last save.
   */
  it('does not overwrite the editor when the same form is refetched', async () => {
    const fetchMock = await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Text' }));
    expect(useBuilderStore.getState().pages[0]?.questions).toHaveLength(1);

    fetchMock.mockResolvedValue(jsonResponse(200, detail()));
    await waitFor(() => {
      expect(
        within(screen.getByRole('button', { name: 'Speichern' })).queryByText(
          'x',
        ),
      ).toBeNull();
    });

    expect(useBuilderStore.getState().pages[0]?.questions).toHaveLength(1);
  });

  /**
   * **A failed background refetch must not throw the draft
   * away.** The same finding as on the public path, here in its
   * severest form: the guard read `query.isError || form ===
   * undefined`, and the only button of the error page led to the dashboard —
   * i.e. through the unmount effect in `useBuilderStore.reset()`. Whoever clicked it
   * during a short Wi-Fi dropout had finally lost the rebuild.
   *
   * The counter-check to this case is the condition itself: with `query.isError`
   * in front of it, the refusal stands below instead of the builder. Run, was red.
   */
  it('keeps the draft when a background refetch fails', async () => {
    let failNext = false;
    stubFetch().mockImplementation(() =>
      failNext
        ? Promise.resolve(jsonResponse(500, { message: 'kaputt' }))
        : Promise.resolve(jsonResponse(200, detail())),
    );

    // The own client instead of `renderWithQuery`: this case has to be able to
    // trigger the second fetch, and for that it needs the reference (the same lesson
    // as in `PublicFormView.test.tsx`).
    const queryClient = createQueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <BuilderView
          formId={FORM_ID}
          canBuild
          canManageTemplates
          canUpdateTemplates
          canManageFormSettings
        />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Formularname')).toBeDefined();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Text' }));
    fireEvent.change(screen.getByLabelText('Formularname'), {
      target: { value: 'Jahrestagung 2026' },
    });

    failNext = true;
    await act(async () => {
      await queryClient.refetchQueries();
    });

    // The error flag really has to be set — otherwise the lines below check
    // a state that never existed.
    expect(
      queryClient
        .getQueryCache()
        .getAll()
        .some((query) => query.state.status === 'error'),
    ).toBe(true);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(screen.queryByText(/konnte nicht geladen werden/)).toBeNull();
    const name: HTMLInputElement = screen.getByLabelText('Formularname');
    expect(name.value).toBe('Jahrestagung 2026');
    expect(useBuilderStore.getState().pages[0]?.questions).toHaveLength(1);
  });
});
