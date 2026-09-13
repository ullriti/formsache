import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EXPORT_FORMAT_LABELS,
  RESPONSE_BULK_DELETE_MAX,
  RETIRED_COLUMN_NOTE,
  exportFormatSchema,
} from '@formsache/shared';

import { emptyResponse, jsonResponse, stubFetch } from '../test/fetch-mock';
import { permissions } from '../test/fixtures';
import { renderWithQuery } from '../test/render-with-query';
import { ResponsesView } from './ResponsesView';

/**
 * The responses table.
 *
 * The point of these tests is the promise that ties search and export together: the
 * export follows the **visible** view. Sorting, searching and the column menu
 * therefore get asserted against the rendered cell, and the export link gets
 * asserted against what the table is showing at that moment.
 *
 * Since no. 22 there is a second promise underneath it: the columns are the
 * union of every **published** version, and every row is rendered against the
 * version it was submitted to. The fixture below is built for that — two
 * published versions, one question retired between them and one option label
 * rewritten, so a row rendered against the wrong version says something
 * visibly wrong rather than merely something different.
 */

const FORM_ID = '019fe700-0000-7000-8000-000000000001';
const NAME_ID = '019fe700-0000-7000-8000-000000000011';
const COUNT_ID = '019fe700-0000-7000-8000-000000000012';
const MEAL_ID = '019fe700-0000-7000-8000-000000000013';
/** Asked in version 1 and removed in version 2 — the retired column. */
const PHONE_ID = '019fe700-0000-7000-8000-000000000014';
/** One id, two types across two versions — see `dateQuestion`. */
const SHIFTY_ID = '019fe700-0000-7000-8000-000000000015';
const PAGE_ID = '019fe700-0000-7000-8000-0000000000a1';

const SUBMITTED_AT_KEY = '__submitted_at__';

function nameQuestion() {
  return {
    id: NAME_ID,
    label: 'Name',
    hint: null,
    required: true,
    width: 'full',
    type: 'text',
    minLength: null,
    maxLength: null,
    pattern: null,
  };
}

function countQuestion() {
  return {
    id: COUNT_ID,
    label: 'Gäste',
    hint: null,
    required: false,
    width: 'full',
    type: 'number',
    min: null,
    max: null,
    integer: true,
  };
}

/**
 * The meal question — with the option label of the given version.
 *
 * `mealLabel` is what makes „jede Zeile gegen ihre Fassung" observable: the
 * stored answer is the value `fleisch`, and only the version the row was
 * submitted to knows what that value was called at the time.
 */
function mealQuestion(mealLabel: string) {
  return {
    id: MEAL_ID,
    label: 'Essen',
    hint: null,
    required: false,
    width: 'full',
    type: 'radio',
    options: [
      { value: 'fleisch', label: mealLabel },
      { value: 'vegetarisch', label: 'Vegetarisch' },
    ],
    allowOther: false,
    otherLabel: null,
  };
}

function phoneQuestion() {
  return {
    id: PHONE_ID,
    label: 'Telefon',
    hint: null,
    required: false,
    width: 'full',
    type: 'phone',
  };
}

/**
 * One question id, two types across two versions — `date` here, `text` below.
 *
 * The pairing is chosen so the two branches render the *same stored string*
 * differently: `2026-05-15` becomes `15.05.2026` as a date and stays as it is
 * as text. A pairing whose branches agree would prove nothing.
 */
function dateQuestion() {
  return {
    id: SHIFTY_ID,
    label: 'Stichtag',
    hint: null,
    required: false,
    width: 'full',
    type: 'date',
    minDate: null,
    maxDate: null,
  };
}

function textQuestion() {
  return {
    id: SHIFTY_ID,
    label: 'Stichtag',
    hint: null,
    required: false,
    width: 'full',
    type: 'text',
    minLength: null,
    maxLength: null,
    pattern: null,
  };
}

function page(questions: unknown[]) {
  return { pages: [{ id: PAGE_ID, title: 'Seite 1', questions }] };
}

/** Version 1: with „Telefon", and „Mit Fleisch" still spelled that way. */
const VERSION_1 = page([
  nameQuestion(),
  countQuestion(),
  mealQuestion('Mit Fleisch'),
  phoneQuestion(),
]);

/** Version 2, the one in force: „Telefon" gone, the option renamed. */
const VERSION_2 = page([
  nameQuestion(),
  countQuestion(),
  mealQuestion('Fleischgericht'),
]);

/**
 * What `GET /forms/:id/responses/columns` answers: active columns first, the
 * retired one behind them, then the timestamp — the server's order, which the
 * view is not allowed to rearrange.
 */
const COLUMN_SET = {
  columns: [
    { key: NAME_ID, label: 'Name', retired: false },
    { key: COUNT_ID, label: 'Gäste', retired: false },
    { key: MEAL_ID, label: 'Essen', retired: false },
    { key: PHONE_ID, label: 'Telefon', retired: true },
    { key: SUBMITTED_AT_KEY, label: 'Eingereicht am (UTC)', retired: false },
  ],
  versions: [
    { version: 1, definition: VERSION_1 },
    { version: 2, definition: VERSION_2 },
  ],
};

/**
 * The **draft** the builder edits — deliberately unlike the published versions.
 *
 * It carries a question no published version ever had, so a view that still
 * read its columns from here would be caught by the test that says the draft
 * is not a source of columns.
 */
const DRAFT = page([
  nameQuestion(),
  countQuestion(),
  mealQuestion('Fleischgericht'),
  {
    id: '019fe700-0000-7000-8000-0000000000d1',
    label: 'Nur im Entwurf',
    hint: null,
    required: false,
    width: 'full',
    type: 'text',
    minLength: null,
    maxLength: null,
    pattern: null,
  },
]);

function detail() {
  return {
    id: FORM_ID,
    title: 'Jahrestagung 2026',
    status: 'active',
    publishedVersion: 2,
    responseCount: 2,
    permissions: permissions(),
    updatedAt: '2026-07-27T10:00:00.000Z',
    revision: 2,
    publicSlug: 'AbCdEf123456',
    definition: DRAFT,
    hasUnpublishedChanges: false,
  };
}

function response(
  id: string,
  submittedAt: string,
  answers: Record<string, unknown>,
  formVersion = 2,
) {
  return { id, formId: FORM_ID, submittedAt, formVersion, answers };
}

const RESPONSES = [
  // Version 1 — from the time „Telefon" was still asked.
  response(
    '019fe700-0000-7000-8000-0000000000f1',
    '2026-07-20T08:00:00.000Z',
    {
      [NAME_ID]: 'Anton Aktiv',
      [COUNT_ID]: 2,
      [MEAL_ID]: { values: ['vegetarisch'], other: null },
      [PHONE_ID]: '0160 3884482',
    },
    1,
  ),
  // Version 2 — the same form after „Telefon" was removed.
  response('019fe700-0000-7000-8000-0000000000f2', '2026-07-21T09:30:00.000Z', {
    [NAME_ID]: 'Berta Mitglied',
    [COUNT_ID]: 10,
    [MEAL_ID]: { values: ['fleisch'], other: null },
  }),
];

/**
 * An answer pointing at a version the payload does not carry.
 *
 * Reachable in production through a damaged snapshot: `responseColumnSet`
 * leaves a version out of `versions` when it no longer parses, and the answers
 * that name it arrive with nothing to render against.
 */
const ORPHAN = response(
  '019fe700-0000-7000-8000-0000000000f7',
  '2026-07-19T08:00:00.000Z',
  { [NAME_ID]: 'Verwaist' },
  99,
);

/**
 * Answers the three GETs the view fires, by path.
 *
 * By path and not by call order: the view starts all queries at once, and
 * their order is TanStack Query's business, not this test's. The columns route
 * has to be matched **before** the answers route — `/responses/columns` also
 * contains `/responses`.
 */
function stubTable(
  responses: unknown = RESPONSES,
  columnSet: unknown = COLUMN_SET,
) {
  return stubFetch().mockImplementation((input) => {
    const path = requestPath(input);
    if (path.endsWith('/responses/columns')) {
      return Promise.resolve(jsonResponse(200, columnSet));
    }
    return Promise.resolve(
      path.endsWith('/responses')
        ? jsonResponse(200, responses)
        : jsonResponse(200, detail()),
    );
  });
}

/** The URL of a `fetch` argument, whichever of its three shapes it is. */
function requestPath(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

async function renderLoaded(
  responses: unknown = RESPONSES,
  columnSet: unknown = COLUMN_SET,
) {
  const fetchMock = stubTable(responses, columnSet);
  renderWithQuery(<ResponsesView formId={FORM_ID} canBuild canExport />);
  await waitFor(() => {
    expect(screen.getByRole('heading', { level: 1 })).toBeDefined();
  });
  return fetchMock;
}

/** One data row of the table. */
function tableRow(index: number): HTMLElement {
  const row = screen.getAllByRole('row')[index + 1];
  if (row === undefined) {
    throw new Error(`No row ${String(index)} in the table.`);
  }
  return row;
}

/**
 * Drops the two cells that carry controls rather than data: the trailing
 * opener, and — for a Mehrfachauswahl — the leading tick box.
 *
 * The tick box is detected rather than assumed, because it is only rendered
 * with `canBuild`: a fixed `slice(1, -1)` would silently drop the first *data*
 * column in the tests that render this view without that right.
 */
function withoutControlCells(cells: HTMLElement[]): HTMLElement[] {
  const withoutOpener = cells.slice(0, -1);
  const first = withoutOpener[0];
  return first !== undefined && within(first).queryByRole('checkbox') !== null
    ? withoutOpener.slice(1)
    : withoutOpener;
}

/**
 * The visible cells of one row, in column order — without the cells that carry
 * a control rather than data.
 */
function rowCells(index: number): string[] {
  return withoutControlCells(within(tableRow(index)).getAllByRole('cell')).map(
    (cell) => cell.textContent,
  );
}

/**
 * The visible column headers, in order — without the control columns, and
 * without the sort indicators, which are decoration rather than label.
 */
function columnLabels(): string[] {
  return withoutControlCells(screen.getAllByRole('columnheader')).map(
    (header) => header.textContent.replace(/[▲▼↕]/gu, ''),
  );
}

/** The „Ansehen" button of one row. */
function openerOfRow(index: number): HTMLElement {
  return within(tableRow(index)).getByRole('button', { name: 'Ansehen' });
}

/** Opens the export menu unless it is already open. */
function openExportMenu(): void {
  const button = screen.getByRole('button', { name: 'Export' });
  if (button.getAttribute('aria-expanded') !== 'true') {
    fireEvent.click(button);
  }
}

/** Picks „Angezeigte Spalten" or „Alle Spalten" in the export menu. */
function chooseExportScope(name: RegExp): void {
  openExportMenu();
  fireEvent.click(screen.getByRole('radio', { name }));
}

/**
 * Everything `aria-describedby` points a control at, joined.
 *
 * Plural on purpose: the attribute takes a **list** of ids, and the export
 * menu uses two of them once the default leaves columns out. A helper reading
 * `getElementById(attribute)` would return `null` for „id1 id2" and quietly
 * assert nothing.
 */
function describedText(element: HTMLElement): string {
  return (element.getAttribute('aria-describedby') ?? '')
    .split(/\s+/u)
    .filter((id) => id !== '')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');
}

/**
 * The address one format of the export points at.
 *
 * Reads the `href` of a real anchor, which is the point: the file name comes
 * from `Content-Disposition`, so the export has to stay a navigation rather
 * than a fetch (no. 27, and `e2e/core-flow.spec.ts` asserts the name).
 */
function exportHref(format = 'CSV'): string {
  openExportMenu();
  return screen.getByRole('link', { name: format }).getAttribute('href') ?? '';
}

/**
 * The formats the menu offers, as the person opening it sees them.
 *
 * Read from `EXPORT_FORMAT_LABELS` rather than spelled out: the assertion is
 * that the menu offers **the** formats the route answers to, and a hand-written
 * list here would pass a menu that had quietly lost one.
 */
const FORMAT_LABELS = exportFormatSchema.options.map(
  (format) => EXPORT_FORMAT_LABELS[format],
);

/** Every format entry of the open menu, in the order it is drawn. */
function formatLinks(): HTMLElement[] {
  openExportMenu();
  return within(exportMenu()).getAllByRole('link');
}

/** The one open export menu — `getBy…` because „genau eines" is the assertion. */
function exportMenu(): HTMLElement {
  openExportMenu();
  return screen.getByRole('group', { name: 'Export' });
}

describe('ResponsesView', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows one row per response, with the labels a reader recognises', async () => {
    await renderLoaded();

    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'Antworten · Jahrestagung 2026',
      }),
    ).toBeDefined();
    expect(screen.getByText('2 Antworten')).toBeDefined();

    // Sorted by the timestamp, newest first — the default of the handoff.
    expect(rowCells(0)[0]).toBe('Berta Mitglied');
    // The *label*, not the stored option value `vegetarisch`.
    expect(rowCells(1)).toContain('Vegetarisch');
  });

  it('searches the rendered value, not the stored one', async () => {
    await renderLoaded();

    fireEvent.change(screen.getByLabelText('Antworten durchsuchen'), {
      target: { value: 'Vegetarisch' },
    });

    expect(screen.getByText('1 Antwort')).toBeDefined();
    expect(rowCells(0)[0]).toBe('Anton Aktiv');
    // `vegetarisch` is what the answer stores; nobody typed it and nobody sees
    // it, so a search for the label has to be the one that works.
    expect(screen.queryByText('Berta Mitglied')).toBeNull();
  });

  it('says so when nothing matches, rather than showing an empty table', async () => {
    await renderLoaded();

    fireEvent.change(screen.getByLabelText('Antworten durchsuchen'), {
      target: { value: 'Zeppelin' },
    });

    expect(screen.getByText('Keine Antwort passt zur Suche.')).toBeDefined();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('distinguishes "no responses yet" from "nothing matches"', async () => {
    await renderLoaded([]);

    expect(
      screen.getByText('Für dieses Formular gibt es noch keine Antworten.'),
    ).toBeDefined();
  });

  /**
   * Numeric when both values are numbers: `10` belongs after `2`, and a column
   * sorted as text would put it before.
   */
  it('sorts a number column numerically', async () => {
    await renderLoaded();

    fireEvent.click(
      screen.getByRole('button', { name: 'Nach Gäste sortieren' }),
    );
    expect(rowCells(0)[1]).toBe('2');

    fireEvent.click(
      screen.getByRole('button', { name: 'Nach Gäste sortieren' }),
    );
    expect(rowCells(0)[1]).toBe('10');
  });

  it('sorts a text column alphabetically and reverses on a second click', async () => {
    await renderLoaded();

    fireEvent.click(
      screen.getByRole('button', { name: 'Nach Name sortieren' }),
    );
    expect(rowCells(0)[0]).toBe('Anton Aktiv');

    fireEvent.click(
      screen.getByRole('button', { name: 'Nach Name sortieren' }),
    );
    expect(rowCells(0)[0]).toBe('Berta Mitglied');
  });

  it('opens one response in full, with the version it was checked against', async () => {
    await renderLoaded();

    // The opener is a column of its own, not the first cell: hanging it on the
    // first cell tied „open this response" to whichever column happened to be
    // leftmost, so hiding that column made the detail panel unreachable.
    fireEvent.click(openerOfRow(1));

    const panel = screen.getByRole('dialog', { name: 'Antwort' });
    expect(within(panel).getByText('Name')).toBeDefined();
    expect(within(panel).getByText('Anton Aktiv')).toBeDefined();
    // Every field, including the ones the table does not show.
    expect(within(panel).getByText('Vegetarisch')).toBeDefined();
    expect(within(panel).getByText(/Fassung 1/)).toBeDefined();

    fireEvent.click(within(panel).getByRole('button', { name: 'Schließen' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  /**
   * The default view is „neueste zuerst", so this is the one order every
   * reader sees first — and it was wrong. The cell reads `TT.MM.JJJJ HH:MM`,
   * and comparing that as text puts „3.8." before „20.7.". The fixture above
   * keeps both answers inside one month, which is exactly why that test stayed
   * green; this one crosses a month boundary on purpose.
   */
  it('sorts the timestamp chronologically, not as text', async () => {
    await renderLoaded([
      response(
        '019fe700-0000-7000-8000-0000000000f3',
        '2026-07-20T08:00:00.000Z',
        { [NAME_ID]: 'Juli' },
      ),
      response(
        '019fe700-0000-7000-8000-0000000000f4',
        '2026-08-03T08:00:00.000Z',
        { [NAME_ID]: 'August' },
      ),
    ]);

    // Newest first by default.
    expect(rowCells(0)[0]).toBe('August');

    fireEvent.click(screen.getByRole('button', { name: /Eingereicht am/ }));
    expect(rowCells(0)[0]).toBe('Juli');
  });

  /**
   * The search runs over the timestamp too. Leaving it out on the server —
   * which is what happened — meant a search for a date listed rows here and
   * produced a file with nothing but a header row.
   */
  it('finds a row by its submission date, the way the export does', async () => {
    await renderLoaded();

    fireEvent.change(screen.getByLabelText('Antworten durchsuchen'), {
      target: { value: '20.07.2026' },
    });

    expect(screen.getByText('1 Antwort')).toBeDefined();
    expect(rowCells(0)[0]).toBe('Anton Aktiv');
    // And the export is told about that search, so it filters the same rows.
    expect(exportHref()).toContain(encodeURIComponent('20.07.2026'));
  });

  /**
   * Switching every column off used to render a table of nothing, hide the way
   * into the detail panel, and send an export request without a `columns`
   * parameter — whereupon the server rebuilt the default view. The file then
   * held columns that were not on screen, which is exactly what the
   * screen-matches-export guarantee exists to prevent.
   */
  it('keeps a usable view when every column is switched off', async () => {
    await renderLoaded();

    fireEvent.click(screen.getByRole('button', { name: '⚙ Felder' }));
    for (const box of screen.getAllByRole('checkbox')) {
      // Only the ones that are on — clicking an unchecked retired column would
      // switch a column *in* rather than out, which is not what this describes.
      if (box instanceof HTMLInputElement && box.checked) {
        fireEvent.click(box);
      }
    }

    expect(screen.getByRole('table')).toBeDefined();
    expect(rowCells(0).length).toBeGreaterThan(0);
    // The export still describes what is on screen.
    expect(exportHref()).toContain(encodeURIComponent(NAME_ID));
  });

  it('hides and shows columns through the field menu', async () => {
    await renderLoaded();

    expect(screen.getByRole('columnheader', { name: /Gäste/ })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: '⚙ Felder' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Gäste' }));

    expect(screen.queryByRole('columnheader', { name: /Gäste/ })).toBeNull();
    expect(screen.getByRole('columnheader', { name: /Name/ })).toBeDefined();
  });

  /**
   * The requirement in one assertion: the file the link fetches is described by
   * the table's own state — the chosen columns and the search term — so it
   * cannot contain a column the reader hid or a row they filtered away.
   */
  it('points the export at the view that is on screen', async () => {
    await renderLoaded();

    expect(exportHref()).toContain(`/api/forms/${FORM_ID}/export.csv`);
    expect(exportHref()).toContain(encodeURIComponent(NAME_ID));

    // „Angezeigte Spalten" — since Konzept no. 80 that is a choice rather than the
    // preselection, and it is the choice the requirement is about: the file
    // then carries what the table carries and nothing else.
    chooseExportScope(/Angezeigte Spalten/);
    fireEvent.click(screen.getByRole('button', { name: '⚙ Felder' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Gäste' }));
    fireEvent.change(screen.getByLabelText('Antworten durchsuchen'), {
      target: { value: 'Anton' },
    });

    const href = exportHref();
    expect(href).toContain('q=Anton');
    expect(href).not.toContain(encodeURIComponent(COUNT_ID));
    expect(href).toContain(encodeURIComponent(NAME_ID));
  });

  /**
   * **The export asks which columns.**
   *
   * Both options stay (no. 22); since Konzept no. 80 the **preselection** is „alle
   * Spalten", and „angezeigte" is the choice that keeps the requirement.
   */
  describe('the export asks for visible or all columns (Konzept Nr. 27)', () => {
    /**
     * **Konzept no. 80, both halves in one place** : the
     * export preselects every column, **and** the table keeps its three
     * questions. Measured together, because the decision is the *difference*
     * between the two — a change that widened both, or neither, would leave one
     * of these two assertions standing and is exactly what a single-sided test
     * would miss.
     */
    it('preselects „Alle Spalten", while the table keeps its three questions', async () => {
      await renderLoaded();
      openExportMenu();

      expect(
        screen.getByRole('radio', { name: /Alle Spalten/ }),
      ).toHaveProperty('checked', true);
      expect(
        screen.getByRole('radio', { name: /Angezeigte Spalten/ }),
      ).toHaveProperty('checked', false);

      // The file: every column, the retired „Telefon" included.
      const href = exportHref();
      expect(href).toContain(encodeURIComponent(NAME_ID));
      expect(href).toContain(encodeURIComponent(PHONE_ID));

      // The screen: three questions plus the timestamp, „Telefon" not among
      // them — the other half of the decision, unchanged.
      expect(columnLabels()).toEqual([
        'Name',
        'Gäste',
        'Essen',
        'Eingereicht am (UTC)',
      ]);
    });

    /**
     * And „Angezeigte Spalten" still means the screen — the option, not the
     * preselection. Before the default changed to „Alle Spalten", this was
     * what an untouched export delivered.
     */
    it('narrows to the columns on screen once „angezeigte" is chosen', async () => {
      await renderLoaded();

      chooseExportScope(/Angezeigte Spalten/);

      const href = exportHref();
      expect(href).toContain(encodeURIComponent(NAME_ID));
      // „Telefon" is retired, so it is not on screen — and not in the file.
      expect(href).not.toContain(encodeURIComponent(PHONE_ID));
    });

    /** The whole point: a handover or an archive wants everything. */
    it('carries the retired columns under „alle Spalten"', async () => {
      await renderLoaded();

      chooseExportScope(/Alle Spalten/);

      const href = exportHref();
      expect(href).toContain(encodeURIComponent(PHONE_ID));
      expect(href).toContain(encodeURIComponent(NAME_ID));
      expect(href).toContain(encodeURIComponent(MEAL_ID));
    });

    /** Hidden is not the same as retired — „alle" has to mean both. */
    it('carries a column the reader hid, too', async () => {
      await renderLoaded();

      chooseExportScope(/Angezeigte Spalten/);
      fireEvent.click(screen.getByRole('button', { name: '⚙ Felder' }));
      fireEvent.click(screen.getByRole('checkbox', { name: 'Gäste' }));
      expect(exportHref()).not.toContain(encodeURIComponent(COUNT_ID));

      chooseExportScope(/Alle Spalten/);

      expect(exportHref()).toContain(encodeURIComponent(COUNT_ID));
    });

    /**
     * **The condition that protects the reader**: the choice is about columns,
     * never about rows. „Alle Spalten" must not quietly become „alle
     * Antworten" — someone who filtered to one name and exports would
     * otherwise be handed the whole database.
     */
    it('keeps the search filtering the rows in both variants', async () => {
      await renderLoaded();

      fireEvent.change(screen.getByLabelText('Antworten durchsuchen'), {
        target: { value: 'Anton' },
      });

      chooseExportScope(/Angezeigte Spalten/);
      expect(exportHref()).toContain('q=Anton');

      chooseExportScope(/Alle Spalten/);

      const href = exportHref();
      expect(href).toContain('q=Anton');
      // …and it really is the wider column set that carries the same filter.
      expect(href).toContain(encodeURIComponent(PHONE_ID));
    });

    /**
     * **the requirement — the search filters the rows of *every*
     * format.**
     *
     * „Alle Spalten" must never unnoticed also mean „alle Antworten", and the place where that would happen in the client is one
     * address per format: if a format builds its URL itself, the `q` will be
     * missing there one day. The measurement is therefore taken over **every** address of the menu, in
     * both column views — not over the CSV's with a „die anderen
     * werden schon".
     *
     * The rows of the **produced file** are counted by `export-seam.test.ts`
     * („die Suche filtert die Zeilen jedes Formats"); here only the
     * order can be measured, and exactly that is the half that can break in the
     * client.
     */
    it('carries the search into the address of every format', async () => {
      await renderLoaded();

      fireEvent.change(screen.getByLabelText('Antworten durchsuchen'), {
        target: { value: 'Anton' },
      });

      for (const scope of [/Angezeigte Spalten/, /Alle Spalten/]) {
        chooseExportScope(scope);
        const links = formatLinks();
        expect(links).toHaveLength(FORMAT_LABELS.length);
        for (const link of links) {
          expect(link.getAttribute('href')).toContain('q=Anton');
        }
      }
    });

    /**
     * And the interface says so, at the point of choice rather than as a
     * footnote — no. 27 asks for it in as many words („Die Oberfläche sagt
     * das"). Under an active search the sentence names the numbers, because
     * that is the moment the misreading would cost something.
     */
    it('says in the menu that the choice does not widen the rows', async () => {
      await renderLoaded();
      openExportMenu();

      expect(
        screen.getByText(/Die Auswahl betrifft nur die Spalten/),
      ).toBeDefined();
      expect(screen.getByText(/werden 2 Antworten/)).toBeDefined();

      fireEvent.change(screen.getByLabelText('Antworten durchsuchen'), {
        target: { value: 'Anton' },
      });
      openExportMenu();

      // Names both numbers, so „1 von 2" cannot be read as „alles".
      expect(
        screen.getByText(/Die Suche bleibt aktiv: exportiert wird 1 Antwort/),
      ).toBeDefined();
      expect(screen.getByText(/von 2/)).toBeDefined();
    });

    /**
     * **the requirement — three formats, *one* column question.**
     *
     * The question „Angezeigte / Alle" stands at the **export**, not at the format. Putting it into a format branch is the error against which the
     * sentence is written — and from the outside it would look right at first, because
     * every single format would then deliver a correct file. What is measured
     * is therefore the **number**: exactly one selection box, exactly one radio group,
     * exactly one note — and all three formats inside it.
     */
    it('offers three formats under one column question', async () => {
      await renderLoaded();
      openExportMenu();

      // The labels come from the shared contract, not from this
      // test: a format that the route knows and the menu would not offer would
      // otherwise be invisible.
      expect(formatLinks().map((link) => link.textContent.trim())).toEqual(
        FORMAT_LABELS.map((label) => `⭳ ${label}`),
      );

      // **Asked once, not three times.**
      expect(screen.getAllByRole('radiogroup')).toHaveLength(1);
      expect(screen.getAllByRole('radio', { name: /Spalten/ })).toHaveLength(2);
      // …and the three addresses stand under exactly this one question.
      expect(within(exportMenu()).getAllByRole('radiogroup')).toHaveLength(1);
    });

    /**
     * A format is an anchor with an `href`, not a button that fetches: the file
     * name comes out of `Content-Disposition`, which a background fetch would
     * lose — and the address of **every** one of them carries the scope, so a
     * format cannot disagree with the choice above it.
     */
    it('offers each format as a real link, not a button that fetches', async () => {
      await renderLoaded();

      chooseExportScope(/Alle Spalten/);

      for (const [index, format] of exportFormatSchema.options.entries()) {
        const link = formatLinks()[index];
        expect(link?.tagName).toBe('A');
        const href = link?.getAttribute('href') ?? '';
        // The extension **is** the format: a download is saved under
        // the last segment of its URL, so `export.csv?format=xlsx` would land
        // on disk as a workbook called `export.csv`.
        expect(href).toContain(`/api/forms/${FORM_ID}/export.${format}`);
        expect(href).toContain(encodeURIComponent(PHONE_ID));
      }
    });

    /** The same popover contract as the field menu — no second pattern. */
    it('closes the export menu with Escape', async () => {
      await renderLoaded();
      openExportMenu();

      expect(screen.getByRole('radio', { name: /Alle Spalten/ })).toBeDefined();

      fireEvent.keyDown(document, { key: 'Escape' });

      expect(screen.queryByRole('radio', { name: /Alle Spalten/ })).toBeNull();
      expect(
        screen
          .getByRole('button', { name: 'Export' })
          .getAttribute('aria-expanded'),
      ).toBe('false');
    });

    /**
     * The radio group is wired to the sentence about rows, so a screen reader
     * hears it on entering the group instead of only meeting it visually two
     * lines below.
     */
    it('reads the row note out with the choice, not just next to it', async () => {
      await renderLoaded();
      openExportMenu();

      const group = screen.getByRole('radiogroup', { name: 'Welche Spalten?' });
      expect(describedText(group)).toContain(
        'Die Auswahl betrifft nur die Spalten',
      );
    });

    /**
     * **A found error**, and since Konzept no. 80 the half
     * that has remained.
     *
     * The export's *default* no longer leaves anything out — it is „alle Spalten".
     * Whoever chooses „Angezeigte Spalten", however, still gets a file without
     * every question of the form, and nothing on this surface ever said that of
     * its own accord: the two numbers next to the selection buttons are numbers, no
     * statement.
     *
     * *Reproduction:* remove the sentence → this case goes red.
     */
    it('says that „angezeigte Spalten" leaves questions out of the file', async () => {
      await renderLoaded();
      chooseExportScope(/Angezeigte Spalten/);

      // Four of five — the one missing is the retired „Telefon".
      const gap = screen.getByTestId('export-gap');
      expect(gap.textContent).toContain('Auswahl (4 von 5)');
      expect(gap.textContent).toContain('nicht jede Frage');

      // …and a screen reader hears it on entering the group, not only
      // on moving on through the box.
      expect(
        describedText(
          screen.getByRole('radiogroup', { name: 'Welche Spalten?' }),
        ),
      ).toContain('nicht jede Frage');
    });

    /**
     * **the requirement — the note stands with *every* format.**
     *
     * It stands **once**, and that is the assurance: the question and its
     * explanation belong to the export, not to the format. Rendering it in the
     * CSV branch (the error the requirement's reproduction describes)
     * would mean that two of three downloads leave questions out without comment —
     * and that is invisible from the outside, because the box looks right to
     * whoever only pulls CSV.
     *
     * That is why it is counted, not searched for: **one** note, **one** group,
     * **three** addresses, all in the same box.
     */
    it('shows that one sentence for every format, not once per format', async () => {
      await renderLoaded();
      chooseExportScope(/Angezeigte Spalten/);

      const menu = exportMenu();
      const gaps = within(menu).getAllByTestId('export-gap');

      expect(gaps).toHaveLength(1);
      expect(within(menu).getAllByRole('link')).toHaveLength(
        FORMAT_LABELS.length,
      );
      for (const label of FORMAT_LABELS) {
        // Every address stands in the same box as the one note — the
        // note therefore „gilt für" them, instead of standing beside one of three.
        expect(within(menu).getByRole('link', { name: label })).toBeDefined();
      }
      expect(gaps[0]?.textContent).toContain('nicht jede Frage');
    });

    /**
     * And it stands **only** where it applies: „Alle Spalten" — the preselection
     * — leaves nothing out, so the sentence would simply be wrong there. A
     * warning that is always there is one nobody reads.
     */
    it('drops that sentence under the preselection, where nothing is left out', async () => {
      await renderLoaded();
      openExportMenu();

      expect(screen.queryByTestId('export-gap')).toBeNull();
      expect(
        describedText(
          screen.getByRole('radiogroup', { name: 'Welche Spalten?' }),
        ),
      ).toContain('Die Auswahl betrifft nur die Spalten');
    });
  });

  /**
   * Regression: the export control and „Zum Builder" were
   * offered whatever the active membership held, and the server then answered
   * 403 to `…/export.csv` and to `PUT /api/forms/:id`.
   *
   * Two different decisions on one row, on purpose. The export is **explained**
   * — getting the answers out is why most people open this page, and there is
   * nowhere else here the reason could be read. „Zum Builder" is **hidden**,
   * like the identical entry in `FormNav`: it is navigation, and a link into an
   * editor that cannot save is worse than no link.
   *
   * Both are display. The guards answer 403 regardless (`CONTRIBUTING.md`).
   */
  describe('rights of the active Organisation', () => {
    it('offers no export control without can_export, and says why', async () => {
      stubTable();
      renderWithQuery(
        <ResponsesView formId={FORM_ID} canBuild canExport={false} />,
      );
      await waitFor(() => {
        expect(screen.getByRole('heading', { level: 1 })).toBeDefined();
      });

      expect(screen.queryByRole('button', { name: 'Export' })).toBeNull();
      expect(
        screen.getByText(/Export ist der Rolle „Export" vorbehalten/),
      ).toBeDefined();
      // The table itself is untouched — this role may read the answers.
      expect(screen.getByRole('table')).toBeDefined();
    });

    it('offers the export again with can_export', async () => {
      await renderLoaded();

      expect(screen.getByRole('button', { name: 'Export' })).toBeDefined();
      expect(
        screen.queryByText(/Export ist der Rolle „Export" vorbehalten/),
      ).toBeNull();
    });

    it('hides „Zum Builder" without can_build', async () => {
      stubTable();
      renderWithQuery(
        <ResponsesView formId={FORM_ID} canBuild={false} canExport />,
      );
      await waitFor(() => {
        expect(screen.getByRole('heading', { level: 1 })).toBeDefined();
      });

      expect(screen.queryByRole('button', { name: 'Zum Builder' })).toBeNull();
      // …while the export, gated on the other flag, stays.
      expect(screen.getByRole('button', { name: 'Export' })).toBeDefined();
    });

    it('offers „Zum Builder" again with can_build', async () => {
      await renderLoaded();

      expect(screen.getByRole('button', { name: 'Zum Builder' })).toBeDefined();
    });
  });

  /**
   * A viewer without `canViewResponses` is refused by the server, and the
   * table has to say which of the two possible reasons it was — „konnte nicht
   * geladen werden" would send someone reloading a page that will never load.
   */
  it('names a missing permission rather than reporting a broken load', async () => {
    stubFetch().mockImplementation((input) =>
      Promise.resolve(
        // Both answer-facing routes require `canViewResponses`, so a viewer
        // without it is refused by both.
        requestPath(input).includes('/responses')
          ? emptyResponse(403)
          : jsonResponse(200, detail()),
      ),
    );
    renderWithQuery(<ResponsesView formId={FORM_ID} canBuild canExport />);

    await waitFor(() => {
      expect(
        screen.getByText(/darf die Antworten dieses Formulars nicht sehen/),
      ).toBeDefined();
    });
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('reports a broken load as such', async () => {
    stubFetch().mockResolvedValue(emptyResponse(500));
    renderWithQuery(<ResponsesView formId={FORM_ID} canBuild canExport />);

    await waitFor(() => {
      expect(
        screen.getByText(/Antworten konnten nicht geladen werden/),
      ).toBeDefined();
    });
  });

  /**
   * The visible ▲/▼ is only half the answer — a screen reader learns the sort
   * order from `aria-sort` on the header cell, and only the active column may
   * carry anything but „none".
   */
  it('announces which column is sorted, and in which direction', async () => {
    await renderLoaded();

    const name = (): HTMLElement =>
      screen.getByRole('columnheader', { name: /Name/ });

    expect(name().getAttribute('aria-sort')).toBe('none');
    // The default order is the timestamp, newest first.
    expect(
      screen
        .getByRole('columnheader', { name: /Eingereicht am/ })
        .getAttribute('aria-sort'),
    ).toBe('descending');

    fireEvent.click(
      screen.getByRole('button', { name: 'Nach Name sortieren' }),
    );
    expect(name().getAttribute('aria-sort')).toBe('ascending');
    expect(
      screen
        .getByRole('columnheader', { name: /Eingereicht am/ })
        .getAttribute('aria-sort'),
    ).toBe('none');

    fireEvent.click(
      screen.getByRole('button', { name: 'Nach Name sortieren' }),
    );
    expect(name().getAttribute('aria-sort')).toBe('descending');
  });

  /** A way out of a search that produced nothing — the handoff's „Zurücksetzen". */
  it('offers a reset only while a search term is active', async () => {
    await renderLoaded();

    expect(screen.queryByRole('button', { name: 'Zurücksetzen' })).toBeNull();

    const field = screen.getByLabelText('Antworten durchsuchen');
    fireEvent.change(field, { target: { value: 'Zeppelin' } });
    expect(screen.getByText('Keine Antwort passt zur Suche.')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Zurücksetzen' }));

    expect((field as HTMLInputElement).value).toBe('');
    expect(screen.getByText('2 Antworten')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Zurücksetzen' })).toBeNull();
  });

  /**
   * The column menu is a popover. One that only closes through its own button
   * is a trap for anyone who reaches it by keyboard.
   */
  it('closes the column menu with Escape', async () => {
    await renderLoaded();

    fireEvent.click(screen.getByRole('button', { name: '⚙ Felder' }));
    expect(screen.getByRole('checkbox', { name: 'Name' })).toBeDefined();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('checkbox', { name: 'Name' })).toBeNull();
    expect(
      screen
        .getByRole('button', { name: '⚙ Felder' })
        .getAttribute('aria-expanded'),
    ).toBe('false');
  });

  /** The handoff opens the slide-in on a click anywhere in the row. */
  it('opens the detail panel from a click on the row itself', async () => {
    await renderLoaded();

    fireEvent.click(tableRow(1));

    const panel = screen.getByRole('dialog', { name: 'Antwort' });
    expect(within(panel).getByText('Anton Aktiv')).toBeDefined();
  });

  /**
   * Konzept no. 22, the defect it corrects: the columns used to come from
   * the **draft**, so trying something out in the builder changed this page
   * without anyone saving anything. The fixture's draft carries a question no
   * published version ever had, and it must not reach the table or the menu.
   */
  it('takes its columns from the published versions, not from the draft', async () => {
    await renderLoaded();

    expect(screen.queryByText('Nur im Entwurf')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '⚙ Felder' }));
    expect(
      screen.queryByRole('checkbox', { name: 'Nur im Entwurf' }),
    ).toBeNull();
    // The published union is what is offered instead — „Telefon" included,
    // although today's form no longer asks it.
    expect(screen.getByRole('checkbox', { name: 'Telefon' })).toBeDefined();
  });

  /**
   * The heart of no. 22: a question somebody removed keeps its column, and the
   * answers already given to it stay readable. Before the change they were
   * unreachable through the interface — not deleted, just invisible.
   */
  it('keeps the answers to a removed question reachable, in a marked column', async () => {
    await renderLoaded();

    fireEvent.click(screen.getByRole('button', { name: '⚙ Felder' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Telefon' }));
    fireEvent.keyDown(document, { key: 'Escape' });

    const header = screen.getByRole('columnheader', { name: /Telefon/ });
    // Words, not only a muted colour — an empty cell in a newer row otherwise
    // reads as „nicht ausgefüllt" instead of „danach nicht mehr gefragt".
    expect(header.textContent).toContain(RETIRED_COLUMN_NOTE);
    expect(header.className).toContain('responses__th--retired');

    // Switching „Telefon" on puts it where the server ordered it: behind the
    // active questions, in front of the timestamp.
    expect(columnLabels()).toEqual([
      'Name',
      'Gäste',
      'Essen',
      `Telefon${RETIRED_COLUMN_NOTE}`,
      'Eingereicht am (UTC)',
    ]);
    // The answer given while the question still existed is there…
    expect(rowCells(1)[3]).toBe('0160 3884482');
    // …and the row submitted afterwards is empty *in that column*, not wrong.
    // The index matters: `toContain('')` is satisfied by any blank cell at all,
    // which a table full of blanks would also pass.
    expect(rowCells(0)[3]).toBe('');
  });

  /**
   * The rule this asserts is a **structural** one, and it took a mutation to
   * notice that the obvious assertions do not hold it.
   *
   * `ResponsesTable` puts the note outside the sort button because the button
   * carries an `aria-label`, which replaces everything nested inside it — a
   * note in there would be invisible to a screen reader. Neither
   * `header.textContent` (which traverses into the button) nor a
   * `getByRole('columnheader', { name })` assertion can tell the two placements
   * apart: jsdom's accessible name differs by a single space. So the structure
   * itself is what gets asserted, and the browser-level accname check belongs
   * in the Playwright spec.
   */
  it('keeps the retired note out of the sort button, where an aria-label would hide it', async () => {
    await renderLoaded();

    fireEvent.click(screen.getByRole('button', { name: '⚙ Felder' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Telefon' }));
    fireEvent.keyDown(document, { key: 'Escape' });

    const header = screen.getByRole('columnheader', { name: /Telefon/ });
    const sortButton = within(header).getByRole('button');

    expect(sortButton.textContent).not.toContain(RETIRED_COLUMN_NOTE);
    // …and it really is in the header cell, as a child of its own.
    const note = header.querySelector('.responses__retired');
    expect(note?.textContent).toBe(RETIRED_COLUMN_NOTE);
    expect(note?.parentElement).toBe(header);
  });

  /** An active column carries no such note — otherwise the marking says nothing. */
  it('marks only the retired columns', async () => {
    await renderLoaded();

    expect(
      screen.getByRole('columnheader', { name: /Name/ }).textContent,
    ).not.toContain(RETIRED_COLUMN_NOTE);
  });

  /**
   * The retired columns stand in a group of their own in the field menu
   * (client decision): mixed into the list they look like fields somebody
   * forgot to switch on.
   */
  it('offers the retired columns as their own group in the field menu', async () => {
    await renderLoaded();

    fireEvent.click(screen.getByRole('button', { name: '⚙ Felder' }));

    const group = screen.getByRole('group', { name: RETIRED_COLUMN_NOTE });
    expect(
      within(group).getByRole('checkbox', { name: 'Telefon' }),
    ).toBeDefined();
    expect(within(group).queryByRole('checkbox', { name: 'Name' })).toBeNull();
  });

  /**
   * Every row is rendered against **its own** published version (* no. 22). Both rows store the very same option value `fleisch`; only the
   * version each was submitted to knows what that value was called at the
   * time. A view that rendered everything against one definition would show
   * the same word twice — which is the failure this asserts against.
   */
  it('renders each row against the version it was submitted to', async () => {
    await renderLoaded([
      response(
        '019fe700-0000-7000-8000-0000000000f5',
        '2026-07-20T08:00:00.000Z',
        { [NAME_ID]: 'Alt', [MEAL_ID]: { values: ['fleisch'], other: null } },
        1,
      ),
      response(
        '019fe700-0000-7000-8000-0000000000f6',
        '2026-07-21T08:00:00.000Z',
        { [NAME_ID]: 'Neu', [MEAL_ID]: { values: ['fleisch'], other: null } },
        2,
      ),
    ]);

    expect(rowCells(0)).toContain('Fleischgericht');
    expect(rowCells(1)).toContain('Mit Fleisch');
  });

  /**
   * A row naming a version the payload does not carry should not occur — the
   * server sends every version answers point at. It becomes reachable through
   * a damaged snapshot: `responseColumnSet` leaves a version out of `versions`
   * when it no longer parses, and the answers pointing at it then arrive
   * without a definition. It must cost that one row its cells, not the table.
   */
  it('survives a response whose version is missing from the payload', async () => {
    await renderLoaded([ORPHAN, ...RESPONSES]);

    expect(screen.getByText('3 Antworten')).toBeDefined();
    // The other rows are untouched…
    expect(rowCells(0)[0]).toBe('Berta Mitglied');
    // …and the orphan keeps the one cell that needs no schema, so it still
    // sorts and searches by its date instead of behaving as if it had none.
    expect(rowCells(2)).toContain('19.07.2026 08:00');
    expect(rowCells(2)[0]).toBe('');
  });

  /**
   * The same row, opened. The panel cannot list fields it has no schema for,
   * so it says so — an empty slide-in would read as „diese Person hat nichts
   * angegeben", which is a statement about a participant rather than about a
   * missing document.
   */
  it('says so in the detail panel when the row’s version is missing', async () => {
    await renderLoaded([ORPHAN, ...RESPONSES]);

    fireEvent.click(openerOfRow(2));

    const panel = screen.getByRole('dialog', { name: 'Antwort' });
    expect(
      within(panel).getByText(/Die Fassung dieser Antwort liegt nicht vor/),
    ).toBeDefined();
    // And no field list at all, rather than an empty one.
    expect(panel.querySelector('.responses__detail-list')).toBeNull();
    // The header still names the version, which is the one thing that helps
    // whoever has to repair the snapshot.
    expect(within(panel).getByText(/Fassung 99/)).toBeDefined();
  });

  /**
   * „Der Export folgt der sichtbaren Sicht"  holds for the unrenderable
   * row as well: it is on screen, it is in the file, and the count agrees with
   * both.
   *
   * The two sides used to disagree here — the server dropped the row while this
   * table kept it, so the screen said „N Antworten" and the file had N−1 lines.
   * That is repaired on the export side (`buildCsv` writes a schemaless line
   * through the same `renderSchemalessRow` this table uses), and the count is
   * the observable end of it: a number that does not match the file teaches
   * people to distrust the export, and nothing tells them which line is gone.
   *
   * This half of the promise is what a component test can reach. That the file
   * really carries the row is asserted where the file is built —
   * `csv.test.ts`, `buildCsv over a row without a schema`.
   */
  it('counts the unrenderable row on screen, and the export carries it too', async () => {
    await renderLoaded([ORPHAN, ...RESPONSES]);

    expect(screen.getByText('3 Antworten')).toBeDefined();
    expect(screen.getAllByRole('row')).toHaveLength(4); // head + three rows
    // The export is pointed at the same three rows: no filter, so nothing on
    // either side may narrow the set.
    expect(exportHref()).not.toContain('q=');
  });

  /**
   * The search runs over every rendered cell, including the columns that are
   * hidden by default — and since no. 22 the retired ones are always among
   * them. Searching a phone number therefore filters the table down to a row
   * in which the term is nowhere to be seen.
   *
   * Written down because it is surprising, not because it is wrong: the server
   * filters over the same cells, so the file matches the table exactly, and
   * narrowing the search to the visible columns would make a hidden column
   * unsearchable — which is worse. If it is ever changed, both sides move
   * together and this test is what says so.
   */
  it('matches a hidden retired column, so a hit can sit outside the visible cells', async () => {
    await renderLoaded();

    fireEvent.change(screen.getByLabelText('Antworten durchsuchen'), {
      target: { value: '0160 3884482' },
    });

    expect(screen.getByText('1 Antwort')).toBeDefined();
    expect(rowCells(0)[0]).toBe('Anton Aktiv');
    // „Telefon" is retired and therefore not in the default view, so the term
    // that produced this row is not on screen.
    expect(columnLabels()).not.toContain(`Telefon${RETIRED_COLUMN_NOTE}`);
    expect(rowCells(0)).not.toContain('0160 3884482');
    // The export is told the same term, so the file holds the same one row.
    // `URLSearchParams` spells a space `+`, which is why this is not
    // `encodeURIComponent`.
    expect(exportHref()).toContain('q=0160+3884482');
  });

  /**
   * The same question id carrying **different types** across versions — a
   * document from before no. 24 made a type change a new question.
   *
   * `date` in version 1, `text` in version 2, and the stored answer is the very
   * same string: the date version formats it `TT.MM.JJJJ`, the text version
   * shows it as it stands. That difference is the proof; a pairing like
   * `phone`→`number` would render identically and prove nothing.
   */
  it('formats a question whose type changed against each row’s own version', async () => {
    const columnSet = {
      columns: [
        { key: NAME_ID, label: 'Name', retired: false },
        { key: SHIFTY_ID, label: 'Stichtag', retired: false },
        {
          key: SUBMITTED_AT_KEY,
          label: 'Eingereicht am (UTC)',
          retired: false,
        },
      ],
      versions: [
        { version: 1, definition: page([nameQuestion(), dateQuestion()]) },
        { version: 2, definition: page([nameQuestion(), textQuestion()]) },
      ],
    };

    await renderLoaded(
      [
        response(
          '019fe700-0000-7000-8000-0000000000f8',
          '2026-07-20T08:00:00.000Z',
          { [NAME_ID]: 'Alt', [SHIFTY_ID]: '2026-05-15' },
          1,
        ),
        response(
          '019fe700-0000-7000-8000-0000000000f9',
          '2026-07-21T08:00:00.000Z',
          { [NAME_ID]: 'Neu', [SHIFTY_ID]: '2026-05-15' },
          2,
        ),
      ],
      columnSet,
    );

    // Newest first: the `text` version shows the stored string untouched…
    expect(rowCells(0)[1]).toBe('2026-05-15');
    // …the `date` version renders the German notation of the same value.
    expect(rowCells(1)[1]).toBe('15.05.2026');
  });

  /**
   * The detail panel lists the questions **this** participant was asked, from
   * their own version — and marks the ones no longer asked, for the same
   * reason the column header does.
   */
  it('shows a retired question in the detail panel, marked as such', async () => {
    await renderLoaded();

    fireEvent.click(openerOfRow(1));

    const panel = screen.getByRole('dialog', { name: 'Antwort' });
    const term = within(panel).getByText(/^Telefon/);
    expect(term.textContent).toContain(RETIRED_COLUMN_NOTE);
    expect(within(panel).getByText('0160 3884482')).toBeDefined();
  });

  /** A newer answer was never asked the retired question — so it is not listed. */
  it('does not invent a retired question for a newer response', async () => {
    await renderLoaded();

    fireEvent.click(openerOfRow(0));

    const panel = screen.getByRole('dialog', { name: 'Antwort' });
    expect(within(panel).queryByText(/^Telefon/)).toBeNull();
    expect(within(panel).getByText(/Fassung 2/)).toBeDefined();
  });

  /**
   * The panel covers a long list of look-alike rows. Losing the way back to
   * the one you came from is what a keyboard user cannot afford there, so
   * Escape closes it and focus returns to the control that opened it.
   */
  it('closes the detail panel with Escape and hands focus back', async () => {
    await renderLoaded();

    const opener = openerOfRow(1);
    opener.focus();
    fireEvent.click(opener);

    const panel = screen.getByRole('dialog', { name: 'Antwort' });
    expect(panel.getAttribute('aria-modal')).toBe('true');
    // Focus moves into the dialog rather than staying behind it.
    expect(document.activeElement).toBe(panel);

    fireEvent.keyDown(panel, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(openerOfRow(1));
  });

  /**
   * „Löschen" in the detail panel — into the trash,
   * reversibly. `canDelete` is `canBuild` alone: reaching this describe block
   * at all already proves `canViewResponses` on this form, because
   * `renderLoaded` renders the table rather than the 403 branch.
   */
  describe('Löschen (detail panel)', () => {
    // `openerOfRow(1)` opens `RESPONSES[0]` (Anton, „…f1"): the default sort
    // is „neueste zuerst", so Berta's later submission sits at row 0 and
    // Anton's at row 1 — the same ordering `openerOfRow`'s other callers in
    // this file already rely on.
    //
    // An IIFE with an explicit `: string` return, not a bare `const` narrowed
    // by an `if`-throw guard: the narrowing does not reach the nested
    // `mockImplementation` closures below for every linter, and a plain
    // `string` here needs no closure to agree on it.
    const DELETED_ID: string = (() => {
      const id = RESPONSES[0]?.id;
      if (id === undefined) {
        throw new Error('Fixture RESPONSES needs at least one row.');
      }
      return id;
    })();

    /**
     * The same three GETs `stubTable` answers, plus a stateful
     * `DELETE .../responses/:id` that removes the row from the next
     * `GET .../responses` — the same „refetch actually changes what the next
     * read answers" shape `DashboardView.test.tsx`'s `stubDeletableForm` uses.
     */
    function stubTableWithDelete() {
      let deleted = false;
      return stubFetch().mockImplementation((input, init) => {
        const path = requestPath(input);
        const method = init?.method ?? 'GET';
        if (method === 'DELETE' && path.endsWith(`/responses/${DELETED_ID}`)) {
          deleted = true;
          return Promise.resolve(emptyResponse(204));
        }
        if (path.endsWith('/responses/columns')) {
          return Promise.resolve(jsonResponse(200, COLUMN_SET));
        }
        if (path.endsWith('/responses')) {
          const remaining = deleted
            ? RESPONSES.filter((entry) => entry.id !== DELETED_ID)
            : RESPONSES;
          return Promise.resolve(jsonResponse(200, remaining));
        }
        return Promise.resolve(jsonResponse(200, detail()));
      });
    }

    it('asks first, in words that say this is reversible', async () => {
      stubTableWithDelete();
      renderWithQuery(<ResponsesView formId={FORM_ID} canBuild canExport />);
      await waitFor(() => {
        expect(screen.getByRole('heading', { level: 1 })).toBeDefined();
      });

      fireEvent.click(openerOfRow(1));
      fireEvent.click(screen.getByRole('button', { name: 'Löschen' }));

      const panel = screen.getByRole('dialog', { name: 'Antwort' });
      const question = within(panel).getByRole('alert');
      expect(question.textContent).toContain('Papierkorb');
      expect(question.textContent).toContain('30 Tage');
      expect(question.textContent).not.toContain('endgültig');
    });

    it('moves the answer into the Papierkorb and closes the panel', async () => {
      const fetchMock = stubTableWithDelete();
      renderWithQuery(<ResponsesView formId={FORM_ID} canBuild canExport />);
      await waitFor(() => {
        expect(screen.getByRole('heading', { level: 1 })).toBeDefined();
      });

      fireEvent.click(openerOfRow(1));
      fireEvent.click(screen.getByRole('button', { name: 'Löschen' }));
      fireEvent.click(
        screen.getByRole('button', { name: 'In den Papierkorb legen' }),
      );

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          expect.stringContaining(`/responses/${DELETED_ID}`),
          expect.objectContaining({ method: 'DELETE' }),
        );
      });
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });
    });

    /**
     * **The trap named in the work order.** The row (and its opener button)
     * that the panel was launched from is gone once the delete's refetch
     * lands — `useFocusTrap`'s own opener-restore step then has nothing to
     * focus, and `fallbackRef` (`ResponsesView`'s own `<h1>`) is exactly the
     * mechanism built for that: „give it something that survives the close."
     */
    it('moves focus to the page heading once the row is gone, not to <body>', async () => {
      stubTableWithDelete();
      renderWithQuery(<ResponsesView formId={FORM_ID} canBuild canExport />);
      await waitFor(() => {
        expect(screen.getByRole('heading', { level: 1 })).toBeDefined();
      });

      fireEvent.click(openerOfRow(1));
      fireEvent.click(screen.getByRole('button', { name: 'Löschen' }));
      fireEvent.click(
        screen.getByRole('button', { name: 'In den Papierkorb legen' }),
      );

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });
      const heading = screen.getByRole('heading', { level: 1 });
      expect(document.activeElement).toBe(heading);
      expect(document.activeElement).not.toBe(document.body);
    });

    it('shows the server’s own refusal and keeps the panel open', async () => {
      stubFetch().mockImplementation((input, init) => {
        const path = requestPath(input);
        const method = init?.method ?? 'GET';
        if (method === 'DELETE' && path.endsWith(`/responses/${DELETED_ID}`)) {
          return Promise.resolve(
            jsonResponse(403, {
              message: 'Diese Rolle darf diese Antwort nicht löschen.',
            }),
          );
        }
        if (path.endsWith('/responses/columns')) {
          return Promise.resolve(jsonResponse(200, COLUMN_SET));
        }
        return Promise.resolve(
          path.endsWith('/responses')
            ? jsonResponse(200, RESPONSES)
            : jsonResponse(200, detail()),
        );
      });
      renderWithQuery(<ResponsesView formId={FORM_ID} canBuild canExport />);
      await waitFor(() => {
        expect(screen.getByRole('heading', { level: 1 })).toBeDefined();
      });

      fireEvent.click(openerOfRow(1));
      fireEvent.click(screen.getByRole('button', { name: 'Löschen' }));
      fireEvent.click(
        screen.getByRole('button', { name: 'In den Papierkorb legen' }),
      );

      await waitFor(() => {
        expect(screen.getByRole('dialog', { name: 'Antwort' })).toBeDefined();
      });
      expect(screen.getByRole('alert').textContent).toContain('nicht');
    });

    it('is absent without can_build', async () => {
      stubTable();
      renderWithQuery(
        <ResponsesView formId={FORM_ID} canBuild={false} canExport />,
      );
      await waitFor(() => {
        expect(screen.getByRole('heading', { level: 1 })).toBeDefined();
      });

      fireEvent.click(openerOfRow(1));
      expect(screen.queryByRole('button', { name: /Löschen/ })).toBeNull();
    });
  });

  /**
   * **Mehrfachauswahl and action bar.**
   *
   * The expensive mistake this block exists against is named in the requirement:
   * „alle" meaning the *unfiltered* set would delete answers nobody has seen.
   * Every assertion about the selection is therefore either measured on the
   * **rendered** counter or on the **ids the request actually carries** — never
   * on a piece of component state, which is precisely what would stay right
   * while the screen went wrong.
   *
   * The server half (rights per answer, all-or-nothing, and that the rows land
   * in the trash) is in `apps/api/test/trash/bulk-delete.spec.ts`; nothing
   * here can prove any of it.
   */
  describe('Mehrfachauswahl ', () => {
    /** Three rows, so „zwei von drei" is a real distinction. */
    const THREE = [
      ...RESPONSES,
      response(
        '019fe700-0000-7000-8000-0000000000f5',
        '2026-07-22T11:00:00.000Z',
        {
          [NAME_ID]: 'Cäcilia Conkneipant',
          [COUNT_ID]: 1,
          [MEAL_ID]: { values: ['fleisch'], other: null },
        },
      ),
    ];

    /** Ids in the order the table draws them — newest submission first. */
    const ROW_IDS = [
      '019fe700-0000-7000-8000-0000000000f5',
      '019fe700-0000-7000-8000-0000000000f2',
      '019fe700-0000-7000-8000-0000000000f1',
    ];

    /**
     * The three GETs plus a stateful `POST …/responses/delete` that removes the
     * named rows from the next `GET …/responses` — the same „refetch actually
     * changes what the next read answers" shape the single delete uses above.
     *
     * `/responses/delete` is matched **before** `/responses/columns` and
     * `/responses`, because a chain of `endsWith` is only as good as its order.
     */
    function stubTableWithBulkDelete(status = 204, answers = THREE) {
      let removed: string[] = [];
      return stubFetch().mockImplementation((input, init) => {
        const path = requestPath(input);
        const method = init?.method ?? 'GET';
        if (method === 'POST' && path.endsWith('/responses/delete')) {
          if (status !== 204) {
            return Promise.resolve(jsonResponse(status, { message: 'Nein.' }));
          }
          removed = readSentIds(init);
          return Promise.resolve(emptyResponse(204));
        }
        if (path.endsWith('/responses/columns')) {
          return Promise.resolve(jsonResponse(200, COLUMN_SET));
        }
        if (path.endsWith('/responses')) {
          return Promise.resolve(
            jsonResponse(
              200,
              answers.filter((row) => !removed.includes(row.id)),
            ),
          );
        }
        return Promise.resolve(jsonResponse(200, detail()));
      });
    }

    /** The `responseIds` of a `fetch` body, parsed rather than string-matched. */
    function readSentIds(init: RequestInit | undefined): string[] {
      const body = init?.body;
      if (typeof body !== 'string') {
        throw new Error('the bulk delete sent no JSON body');
      }
      const parsed: unknown = JSON.parse(body);
      const ids = (parsed as { responseIds?: unknown }).responseIds;
      if (!Array.isArray(ids)) {
        throw new Error('the bulk delete body carries no responseIds array');
      }
      return ids.map((id) => String(id));
    }

    /** The bulk-delete request of this test, or `undefined` if none was made. */
    function bulkDeleteCall(fetchMock: ReturnType<typeof stubFetch>) {
      return fetchMock.mock.calls.find(
        ([input, init]) =>
          (init?.method ?? 'GET') === 'POST' &&
          requestPath(input).endsWith('/responses/delete'),
      );
    }

    /** The ids the one bulk-delete request of this test carried. */
    function sentIds(fetchMock: ReturnType<typeof stubFetch>): string[] {
      const call = bulkDeleteCall(fetchMock);
      if (call === undefined) {
        throw new Error('no bulk delete was sent');
      }
      return readSentIds(call[1]);
    }

    async function renderThree(status = 204) {
      const fetchMock = stubTableWithBulkDelete(status);
      renderWithQuery(<ResponsesView formId={FORM_ID} canBuild canExport />);
      await waitFor(() => {
        expect(screen.getByRole('heading', { level: 1 })).toBeDefined();
      });
      return fetchMock;
    }

    /** The tick box of one drawn row. */
    function rowBox(index: number): HTMLElement {
      return within(tableRow(index)).getByRole('checkbox');
    }

    /**
     * The header's „alle" box — looked up **inside the `<thead>`**.
     *
     * Scoped rather than page-wide, and that is not tidiness: a role query
     * carrying a `name` computes an accessible name for every checkbox it
     * finds, and the ceiling case below draws a thousand rows. Page-wide the
     * same lookup takes ~14 s there and is instant here.
     */
    function allBox(): HTMLInputElement {
      const table = screen.getByRole('table');
      const head = table instanceof HTMLTableElement ? table.tHead : null;
      if (head === null) {
        throw new Error('the responses table has no header');
      }
      const box = within(head).getByRole('checkbox', {
        name: 'Alle sichtbaren Antworten auswählen',
      });
      if (!(box instanceof HTMLInputElement)) {
        throw new Error('the „alle" control is not a checkbox');
      }
      return box;
    }

    /** The action bar itself — the scope for its own controls, see above. */
    function selectionBar(): HTMLElement {
      return screen.getByRole('group', { name: 'Ausgewählte Antworten' });
    }

    function bulkDeleteButton(): HTMLElement {
      return within(selectionBar()).getByRole('button', {
        name: 'Ausgewählte Antworten löschen',
      });
    }

    function confirmDeleteButton(): HTMLElement {
      return within(selectionBar()).getByRole('button', {
        name: 'In den Papierkorb legen',
      });
    }

    function search(term: string): void {
      fireEvent.change(screen.getByLabelText('Antworten durchsuchen'), {
        target: { value: term },
      });
    }

    /* ---- the evidence: the counter is the rendered number ---------------- */

    it('counts two of three selected rows, in words on screen', async () => {
      await renderThree();

      expect(screen.queryByText(/ausgewählt/)).toBeNull();

      fireEvent.click(rowBox(0));
      expect(screen.getByText('1 Antwort ausgewählt')).toBeDefined();

      fireEvent.click(rowBox(2));
      expect(screen.getByText('2 Antworten ausgewählt')).toBeDefined();
      // The third row is drawn and unticked — otherwise „zwei von drei" would
      // be a statement about a table with two rows in it.
      expect(within(tableRow(1)).getByRole('checkbox')).toHaveProperty(
        'checked',
        false,
      );
    });

    it('says „alle" only when every drawn row is ticked, and half-ticks in between', async () => {
      await renderThree();

      fireEvent.click(rowBox(0));
      expect(allBox().checked).toBe(false);
      // The indeterminate mark is a DOM *property*; React cannot set it from
      // JSX, so this is the assertion that the ref actually writes it.
      expect(allBox().indeterminate).toBe(true);

      fireEvent.click(rowBox(1));
      fireEvent.click(rowBox(2));
      expect(allBox().checked).toBe(true);
      expect(allBox().indeterminate).toBe(false);
    });

    /* ---- the evidence: „alle" means the *visible* rows ------------------- */

    /**
     * **What this one measures is the narrowing, not „alle"** — and saying so
     * is the point, because it read as the proof of the requirement's expensive
     * mistake and is not.
     *
     * `selectedRows` intersects the tick marks with the rendered rows *after*
     * the fact, so it holds the single visible id whether „alle" ticked the
     * filtered rows or the whole table. This case therefore stays green under
     * the very mutation the requirement names. The case that goes red under it is
     * the next one, which clears the search again before deleting; this one
     * pins the second half of the rule (nothing offscreen can be sent even when
     * the marks remember it).
     */
    it('ticks exactly the rows a search left standing, not the whole table', async () => {
      const fetchMock = await renderThree();

      search('Vegetarisch');
      expect(screen.getByText('1 Antwort')).toBeDefined();

      fireEvent.click(allBox());
      expect(screen.getByText('1 Antwort ausgewählt')).toBeDefined();

      fireEvent.click(bulkDeleteButton());
      fireEvent.click(confirmDeleteButton());

      await waitFor(() => {
        expect(sentIds(fetchMock)).toStrictEqual([
          // Anton's row — the only one matching „Vegetarisch".
          '019fe700-0000-7000-8000-0000000000f1',
        ]);
      });
    });

    /**
     * **The most expensive mistake of this stage, on the line that decides it.**
     *
     * The search is **cleared again** before the delete, so the intersection in
     * `selectedRows` no longer hides anything: what „alle" put into the tick
     * marks is what the counter says and what the request carries. Referring
     * „alle" to the unfiltered `rows` therefore turns both assertions red with
     * three ids — two answers nobody has looked at — where every other case in
     * this block stays green.
     */
    it('keeps „alle" on the searched rows when the search is cleared again', async () => {
      const fetchMock = await renderThree();

      search('Vegetarisch');
      fireEvent.click(allBox());

      search('');
      // All three rows are drawn again, and exactly one of them is ticked.
      expect(screen.getByText('1 Antwort ausgewählt')).toBeDefined();

      fireEvent.click(bulkDeleteButton());
      fireEvent.click(confirmDeleteButton());

      await waitFor(() => {
        expect(sentIds(fetchMock)).toStrictEqual([
          '019fe700-0000-7000-8000-0000000000f1',
        ]);
      });
    });

    /**
     * The other direction of the same rule: a row that a search takes off the
     * screen leaves the selection with it. Without that, „alle" while the table
     * showed everything plus a search afterwards would still send three ids —
     * the same damage through the other door.
     */
    it('drops a row out of the selection once a search hides it', async () => {
      const fetchMock = await renderThree();

      fireEvent.click(allBox());
      expect(screen.getByText('3 Antworten ausgewählt')).toBeDefined();

      search('Vegetarisch');
      expect(screen.getByText('1 Antwort ausgewählt')).toBeDefined();

      fireEvent.click(bulkDeleteButton());
      fireEvent.click(confirmDeleteButton());

      await waitFor(() => {
        expect(sentIds(fetchMock)).toStrictEqual([
          '019fe700-0000-7000-8000-0000000000f1',
        ]);
      });
    });

    it('brings the selection back when the search is cleared again', async () => {
      await renderThree();

      fireEvent.click(allBox());
      search('Vegetarisch');
      expect(screen.getByText('1 Antwort ausgewählt')).toBeDefined();

      search('');
      expect(screen.getByText('3 Antworten ausgewählt')).toBeDefined();
    });

    /* ---- the bar's own two controls ------------------------------------ */

    /**
     * **Deliberately asymmetric to „alle" setzen**: ticking refers to the
     * rendered rows, clearing empties the marks *completely* — offscreen ones
     * included. The asymmetry is in the safe direction (nothing can survive a
     * „Auswahl aufheben" and be deleted later by a click somebody has forgotten
     * about), which is why it stays rather than being made symmetrical.
     */
    it('takes the whole selection back with „Auswahl aufheben"', async () => {
      await renderThree();

      fireEvent.click(allBox());
      fireEvent.click(screen.getByRole('button', { name: 'Auswahl aufheben' }));

      expect(screen.queryByText(/ausgewählt/)).toBeNull();
      expect(allBox().checked).toBe(false);
      expect(rowBox(0)).toHaveProperty('checked', false);
    });

    it('asks first, in words that say this is the Papierkorb and reversible', async () => {
      await renderThree();

      fireEvent.click(rowBox(0));
      fireEvent.click(rowBox(1));
      fireEvent.click(bulkDeleteButton());

      const question = screen.getByRole('alert');
      expect(question.textContent).toContain('2 Antworten');
      expect(question.textContent).toContain('Papierkorb');
      expect(question.textContent).toContain('30 Tage');
      expect(question.textContent).not.toContain('endgültig');
    });

    it('sends every selected row and clears the bar afterwards', async () => {
      const fetchMock = await renderThree();

      fireEvent.click(rowBox(0));
      fireEvent.click(rowBox(2));
      fireEvent.click(bulkDeleteButton());
      fireEvent.click(confirmDeleteButton());

      await waitFor(() => {
        expect(new Set(sentIds(fetchMock))).toStrictEqual(
          new Set([ROW_IDS[0], ROW_IDS[2]]),
        );
      });
      // The rows are gone from the refetched table and the bar with them.
      await waitFor(() => {
        expect(screen.queryByText(/ausgewählt/)).toBeNull();
      });
      expect(screen.getByText('1 Antwort')).toBeDefined();
    });

    /**
     * The route is all-or-nothing, so a refusal means nothing was moved — the
     * selection has to survive it, or „nochmal drücken" would be advice with
     * nothing left to press on.
     */
    it('keeps the selection and says why when the server refuses', async () => {
      await renderThree(403);

      fireEvent.click(rowBox(0));
      fireEvent.click(bulkDeleteButton());
      fireEvent.click(confirmDeleteButton());

      await waitFor(() => {
        expect(screen.getByRole('alert').textContent).toContain(
          'nicht in den Papierkorb legen',
        );
      });
      expect(screen.getByText('1 Antwort ausgewählt')).toBeDefined();
    });

    /* ---- the ceiling, before it becomes a status code ----------------- */

    /**
     * One answer more than `RESPONSE_BULK_DELETE_MAX` — the smallest list that
     * reaches the ceiling, and a plausible one: the responses list has no page
     * size yet, so „alle" is a single click over a whole Jahrestagung.
     */
    const OVER_LIMIT = Array.from(
      { length: RESPONSE_BULK_DELETE_MAX + 1 },
      (_, index) =>
        response(
          `019fe700-0000-7000-8000-${String(index).padStart(12, '0')}`,
          new Date(Date.UTC(2026, 6, 22, 0, 0, index)).toISOString(),
          { [NAME_ID]: `Teilnehmer ${String(index)}` },
        ),
    );

    /**
     * **The ceiling is a sentence here, not a status code.**
     *
     * Sending this selection would come back as a 400 („Bitte die markierten
     * Felder prüfen." — on a surface without fields) or, once the body passes
     * `JSON_BODY_LIMIT_BYTES`, as a 413 („bitte erneut versuchen" — advice to
     * repeat what cannot work). Both are measured here by their absence: **no
     * request is made at all**, and what the reader gets instead names both
     * numbers and the way down (the search).
     */
    it('refuses a selection past the payload limit and says how to get under it', async () => {
      const selected = `${String(RESPONSE_BULK_DELETE_MAX + 1)} Antworten ausgewählt`;
      const fetchMock = stubTableWithBulkDelete(204, OVER_LIMIT);
      renderWithQuery(<ResponsesView formId={FORM_ID} canBuild canExport />);
      await waitFor(() => {
        expect(screen.getByRole('heading', { level: 1 })).toBeDefined();
      });

      fireEvent.click(allBox());
      expect(within(selectionBar()).getByText(selected)).toBeDefined();

      fireEvent.click(bulkDeleteButton());
      fireEvent.click(confirmDeleteButton());

      // One turn of the event loop before the assertion: the mutation reaches
      // `fetch` asynchronously, so „nichts ging raus" measured immediately
      // after the click would be a race this assertion always wins — green
      // even for a view that sends the request a microtask later.
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
      // Nothing left the browser — asserted first, because it is the half a
      // sentence cannot make up for.
      expect(bulkDeleteCall(fetchMock)).toBeUndefined();

      const message = within(selectionBar()).getByRole('alert').textContent;
      expect(message).toContain(String(RESPONSE_BULK_DELETE_MAX + 1));
      expect(message).toContain(String(RESPONSE_BULK_DELETE_MAX));
      // The way forward, and the reason this is a sentence rather than a
      // disabled button: „Suche" is what makes the selection smaller.
      expect(message).toContain('Suche');

      // The selection survives, so narrowing it down starts where the reader
      // is rather than from nothing.
      expect(within(selectionBar()).getByText(selected)).toBeDefined();
    }, 30_000);

    /* ---- the right that gates the whole thing  ------------- */

    it('offers neither tick boxes nor a bar without can_build', async () => {
      stubTable(THREE);
      renderWithQuery(
        <ResponsesView formId={FORM_ID} canBuild={false} canExport />,
      );
      await waitFor(() => {
        expect(screen.getByRole('heading', { level: 1 })).toBeDefined();
      });

      // Hidden, not disabled — the only bulk action is a delete this role may
      // not perform, and the guard chain refuses it again on the server.
      expect(screen.queryAllByRole('checkbox')).toStrictEqual([]);
      expect(
        screen.queryByRole('button', { name: 'Ausgewählte Antworten löschen' }),
      ).toBeNull();
    });
  });

  /**
   * **Veranstaltungsfelder as chips in the detail panel.**
   *
   * Measured on the **rendered** list: a panel that printed the folded
   * „Sommerfest: 3" as text has no `listitem` in it, which is what makes the
   * reproduction („die Antwort als Rohwert rendern") turn these red rather than
   * leaving them green on a string that happens to contain the same digits.
   */
  describe('Veranstaltungsfelder als Chips ', () => {
    const EVENT_ID = '019fe700-0000-7000-8000-000000000021';
    const EVENT_FORM_VERSION = 3;

    const EVENT_VERSION = {
      pages: [
        {
          id: PAGE_ID,
          title: 'Seite 1',
          questions: [
            nameQuestion(),
            {
              id: EVENT_ID,
              label: 'Veranstaltungen',
              hint: null,
              required: false,
              width: 'full',
              type: 'event',
              events: [
                {
                  key: 'sommerfest',
                  label: 'Sommerfest',
                  when: 'Fr, 19:00',
                  capacity: 120,
                  showRemaining: true,
                },
                {
                  key: 'stadtfest',
                  label: 'Stadtfest',
                  when: 'Sa, 20:00',
                  capacity: 80,
                  showRemaining: false,
                },
                {
                  key: 'festzug',
                  label: 'Festzug',
                  when: 'So, 11:00',
                  capacity: null,
                  showRemaining: false,
                },
              ],
            },
          ],
        },
      ],
    };

    const EVENT_COLUMNS = {
      columns: [
        { key: NAME_ID, label: 'Name', retired: false },
        { key: EVENT_ID, label: 'Veranstaltungen', retired: false },
        {
          key: SUBMITTED_AT_KEY,
          label: 'Eingereicht am (UTC)',
          retired: false,
        },
      ],
      versions: [{ version: EVENT_FORM_VERSION, definition: EVENT_VERSION }],
    };

    function eventResponse(seats: Record<string, number>) {
      return [
        response(
          '019fe700-0000-7000-8000-0000000000e1',
          '2026-07-20T08:00:00.000Z',
          { [NAME_ID]: 'Anton Aktiv', [EVENT_ID]: { seats } },
          EVENT_FORM_VERSION,
        ),
      ];
    }

    /** The `<dd>` of the Veranstaltungsfrage in the open panel. */
    function eventValue(): HTMLElement {
      const panel = screen.getByRole('dialog', { name: 'Antwort' });
      const term = within(panel).getByText('Veranstaltungen');
      const value = term.parentElement?.querySelector('dd');
      if (!(value instanceof HTMLElement)) {
        throw new Error('the Veranstaltungsfrage has no value cell');
      }
      return value;
    }

    it('draws one chip per Veranstaltung, with its Personenzahl', async () => {
      await renderLoaded(
        eventResponse({ sommerfest: 3, stadtfest: 2 }),
        EVENT_COLUMNS,
      );

      fireEvent.click(openerOfRow(0));

      const chips = within(eventValue()).getAllByRole('listitem');
      expect(chips.map((chip) => chip.textContent)).toStrictEqual([
        'Sommerfest · 3 Personen',
        'Stadtfest · 2 Personen',
      ]);
    });

    /**
     * **Zero seats is no chip** — an empty one would claim a registration
     * of nobody, which is a different statement from „nicht angemeldet".
     */
    it('draws no chip for a Veranstaltung with zero seats', async () => {
      await renderLoaded(
        eventResponse({ sommerfest: 3, stadtfest: 0 }),
        EVENT_COLUMNS,
      );

      fireEvent.click(openerOfRow(0));

      const chips = within(eventValue()).getAllByRole('listitem');
      expect(chips.map((chip) => chip.textContent)).toStrictEqual([
        'Sommerfest · 3 Personen',
      ]);
      expect(within(eventValue()).queryByText(/Stadtfest/)).toBeNull();
    });

    it('says „Person" in the singular for a registration of one', async () => {
      await renderLoaded(eventResponse({ festzug: 1 }), EVENT_COLUMNS);

      fireEvent.click(openerOfRow(0));

      expect(within(eventValue()).getByRole('listitem').textContent).toBe(
        'Festzug · 1 Person',
      );
    });

    /**
     * A field with no registration at all falls back to the em dash every other
     * unanswered field uses — an empty chip list would read as a rendering
     * fault rather than as an answer nobody gave.
     */
    it('falls back to the em dash when nothing was registered for', async () => {
      await renderLoaded(eventResponse({}), EVENT_COLUMNS);

      fireEvent.click(openerOfRow(0));

      expect(within(eventValue()).queryAllByRole('listitem')).toStrictEqual([]);
      expect(eventValue().textContent).toBe('—');
    });
  });
});
