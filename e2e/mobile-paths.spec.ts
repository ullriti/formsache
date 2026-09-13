import { expect, test, type Locator, type Page } from '@playwright/test';
import type { A11yFixture } from './a11y/views';

import {
  addQuestion,
  expectNoHorizontalScroll,
  newForm,
  openMobileMenu,
  publishAndReadPath,
  saveForm,
} from './app-flows';
import {
  buildFixtureForm,
  purgeFixtureForm,
  RESPONSES_STICKY_SHADOW,
} from './mobile/fixture';
import { expectNoControlCovered } from './mobile/operable';
import { authStateFile } from './seed-account';

/**
 * **The new operating paths of this project are reachable and operable on mobile**
 *  — one 360 px case each, via the **navigation** through to the
 * operation.
 *
 * By name, in the order of the cases below: „+ Zeile" while filling in,
 * the format choice in the export, the multi-selection bar, the
 * pager of the dashboard, the AI button of the dashboard together with dialog
 * and preview, and the reply-to address in the dispatch log.
 *
 * ## "Via the navigation" means: no address out of the test file
 *
 * Rule 3 ("built is not reachable") left a whole package standing on 404,
 * because every case drove to its view with `page.goto`. Here
 * no case drives to an in-app address directly: the start is at `/`, and
 * from there it goes via the cards of the dashboard and the off-canvas sheet.
 * The one exception is the **public** fill-in address — that one is by
 * construction an address somebody is given; it comes from the
 * publish view of the application (`publishAndReadPath`) and not from
 * this file.
 *
 * ## Where the dummies stand, and where their payload comes from
 *
 * Two cases need a state that this run cannot produce: 25
 * forms for the second dashboard page and an installation **with**
 * an AI key. Both answers are not written by hand, but derived from
 * the **real** answer of the server and changed at one place.
 *
 * That is the lesson from `mail-log-mobile.spec.ts`: its hand-written
 * dummy fell through silently for four runs, because a field was added to the
 * schema. This project deliberately keeps `@formsache/shared` out of `e2e/`
 * (`api-dev.spec.ts` says why), so nothing here can be parsed against a Zod
 * schema — a derived payload, by contrast, **is** by construction
 * schema-valid, because the server produced it. That is the stronger version
 * of the same intention.
 */

test.describe.configure({ mode: 'default' });
test.use({ storageState: authStateFile });

let fixture: A11yFixture;
let formId: string | undefined;
/** The title of the test form — the card that is searched for in the dashboard. */
let formTitle: string;

test.beforeAll(async ({ browser }) => {
  const built = await buildFixtureForm(browser);
  fixture = built.fixture;
  formId = built.formId;

  const context = await browser.newContext({ storageState: authStateFile });
  const page = await context.newPage();
  try {
    const response = await page.request.get(`/api/forms/${built.formId}`);
    expect(response.status(), 'Das Prüfformular muss lesbar sein').toBe(200);
    const body: unknown = await response.json();
    const title =
      typeof body === 'object' && body !== null && 'title' in body
        ? (body as { readonly title: unknown }).title
        : undefined;
    expect(typeof title).toBe('string');
    formTitle = String(title);
  } finally {
    await context.close();
  }
});

test.afterAll(async ({ browser }) => {
  await purgeFixtureForm(browser, formId);
});

/** The card of a form in the dashboard grid. */
function card(page: Page, title: string): Locator {
  return page.getByRole('article').filter({ hasText: title });
}

/**
 * Drives to a view **via the off-canvas sheet** — the only path there
 * is below 1180 px (the desktop's „Aktuelles Formular" sub-bar
 * is not rendered there).
 */
async function openViaSheet(page: Page, label: string): Promise<void> {
  const { sheet } = await openMobileMenu(page);
  await sheet.getByRole('button', { name: label, exact: true }).click();
  await expect(sheet).toHaveCount(0);
}

/* --- „+ Zeile" while filling in (at the same time the proof) ------------- */

test.describe('„+ Zeile" mit dem Finger (der Nachweis)', () => {
  /**
   * What stayed open until now: **hit area and gesture on a real
   * device.** jsdom can imitate `tap()`, but neither `touch-action` nor
   * a table that scrolls sideways nor a button underneath — "In
   * `e2e/` the ‚+ Zeile' of the fill-in view appears **nowhere**" therefore
   * stood as an open gap.
   *
   * What is measured is the **result**: the values of the rows left over in
   * the responses table after the middle one was removed. An
   * assertion "the gesture went through" would be green even when the wrong
   * row disappears.
   */
  test('fügt Zeilen hinzu, entfernt die mittlere, und die übrigen Werte stehen unverschoben in der Auswertung', async ({
    page,
    browser,
  }) => {
    const title = await newForm(page, 'Tabelle wächst mobil');
    const rowFormId = /\/forms\/([^/?#]+)/u.exec(page.url())?.[1];
    expect(rowFormId, 'Formular-Id aus der Adresse').toBeDefined();

    await addQuestion(page, 'Tabelle', 'Teilnehmer');
    await page.getByRole('button', { name: 'Eigenschaften' }).click();
    // The switch that makes „+ Zeile" come about at all —
    // tapped, not `check()`: that is the operation this is about.
    await page.getByLabel('Zeilen ergänzbar').tap();
    await expect(page.getByLabel('Obergrenze')).toBeVisible();
    await page.getByRole('button', { name: 'Schließen' }).click();

    await saveForm(page);
    // The public address comes from the publish view of the
    // application, not from this file.
    const publicPath = await publishAndReadPath(page);

    const guestContext = await browser.newContext({
      viewport: { width: 360, height: 740 },
      hasTouch: true,
    });
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);
      const addRow = guest.getByRole('button', { name: '+ Zeile' });
      await expect(addRow).toBeVisible();

      // Nothing lies over the controls of this view — the same measurement as
      // in `mobile-reachable.spec.ts`, here for the state "table with
      // row buttons", which does not exist there.
      await expectNoControlCovered(guest, 'Ausfüllansicht mit „+ Zeile"');

      const cell = (row: number): Locator =>
        guest.getByLabel(`Spalte 1, Zeile ${String(row)}`);
      const firstColumn = guest.getByLabel(/^Spalte 1, Zeile /u);

      // The starting rows of a fresh table are **two** (`question-defaults`
      // — „the handoff's own starting Tabelle"). Counted instead of assumed: the
      // number decides which row is the middle one later.
      await expect(firstColumn).toHaveCount(2);
      await cell(1).fill('Erste');
      await cell(2).fill('Zweite');

      await addRow.tap();
      await expect(firstColumn).toHaveCount(3);
      await cell(3).fill('Dritte');

      // The **middle** row, with the finger.
      await guest.getByRole('button', { name: 'Entfernen: Zeile 2' }).tap();

      // And the values do not slide up: row 2 now carries „Dritte".
      await expect(firstColumn).toHaveCount(2);
      await expect(cell(1)).toHaveValue('Erste');
      await expect(cell(2)).toHaveValue('Dritte');

      await expectNoHorizontalScroll(guest, 'Ausfüllansicht, Tabelle (360 px)');

      await guest.getByRole('button', { name: 'Absenden' }).tap();
      await expect(
        guest.getByRole('heading', { level: 1, name: 'Vielen Dank!' }),
      ).toBeVisible();
    } finally {
      await guestContext.close();
    }

    // And the result in the evaluation — via the navigation, like every path
    // in this file.
    await page.goto('/');
    await card(page, title).getByRole('button', { name: 'Antworten' }).click();
    await expect(
      page.getByRole('cell', { name: 'Spalte 1: Erste' }),
      'Die Antwort trägt zwei Zeilen mit „Erste" und „Dritte" — die entfernte ' +
        'mittlere darf in der Auswertung nicht auftauchen, und die dritte darf ' +
        'nicht an ihre Stelle gerutscht sein.',
    ).toBeVisible();
    await expect(page.getByRole('cell', { name: /Zweite/u })).toHaveCount(0);

    await purgeFixtureForm(browser, rowFormId);
  });
});

/* --- Export format choice and multi-selection  -------------------- */

test.describe('Antworten-Ansicht mobil', () => {
  /**
   * The format choice is not the list, but the **file**: what is measured is
   * what the browser downloads after the finger has tapped „Excel". An
   * assertion "three entries are visible" would stay green if each of them
   * delivered the same CSV.
   */
  test('Export: die Formatwahl steht bereit, und „Excel" lädt eine .xlsx', async ({
    page,
  }) => {
    await page.goto('/');
    await card(page, formTitle)
      .getByRole('button', { name: 'Antworten' })
      .click();
    await expect(
      page.getByRole('heading', { level: 1, name: /Antworten/u }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Export' }).tap();

    /*
      **The menu lies inside the picture** — and this line is the find of this case.

      Measured on 2026-08-10, before the repair: the menu is 300 px wide and
      hung on its own button with `right: 0`; at 360 px this button
      moves to the middle of the row on wrapping, and the menu stuck out of the
      picture on the **left** — `x = -51`. The three format links lay partly outside, a
      tap on „Excel" ran into the timeout, and
      `expectNoHorizontalScroll` saw nothing of it: content sticking out to the left
      does not enlarge `scrollWidth`, it is simply gone.
    */
    const width = page.viewportSize()?.width ?? 0;
    const box = await page.getByRole('group', { name: 'Export' }).boundingBox();
    expect(
      box,
      'Das geöffnete Export-Menü muss gelayoutet sein',
    ).not.toBeNull();
    const left = Math.round(box?.x ?? -1);
    const right = Math.round((box?.x ?? 0) + (box?.width ?? 0));

    expect(
      left,
      `Der linke Rand des Export-Menüs liegt bei ${String(left)} px. Alles ` +
        'unter 0 ist links aus dem Bild geschoben und mit dem Finger nicht ' +
        'erreichbar.',
    ).toBeGreaterThanOrEqual(0);
    expect(
      right,
      `Der rechte Rand des Export-Menüs liegt bei ${String(right)} px, der ` +
        `Schirm ist ${String(width)} px breit.`,
    ).toBeLessThanOrEqual(width);

    /*
      The column choice — **both** possibilities, with the finger, and
      the value before against the value after. The default is „Alle Spalten"
      (`ResponsesView`: `useState<ExportScope>('all')`), so the tap that
      changes something is the one on „Angezeigte Spalten".
    */
    const allColumns = page.getByRole('radio', { name: /Alle Spalten/u });
    const shownColumns = page.getByRole('radio', {
      name: /Angezeigte Spalten/u,
    });
    await expect(allColumns).toBeChecked();

    await shownColumns.tap();
    await expect(shownColumns).toBeChecked();
    await expect(allColumns).not.toBeChecked();

    await allColumns.tap();
    await expect(allColumns).toBeChecked();

    for (const label of ['CSV', 'Excel', 'HTML']) {
      await expect(
        page.getByRole('link', { name: new RegExp(label, 'u') }),
      ).toBeVisible();
    }

    await expectNoHorizontalScroll(page, 'Antworten mit offenem Export-Menü');

    const started = page.waitForEvent('download');
    await page.getByRole('link', { name: /Excel/u }).tap();
    const download = await started;
    expect(
      download.suggestedFilename(),
      'Der „Excel"-Eintrag muss eine Excel-Datei liefern — der Dateiname ist ' +
        'das, was beim Ausfüllenden ankommt.',
    ).toMatch(/\.xlsx$/u);
  });

  /**
   * The multi-selection bar appears only with a selection, and
   * it counts the **rendered** rows. What is tapped is the row's checkbox,
   * what is measured is the text of the bar — "the bar is visible" would be
   * green even if it said „0 Antworten".
   */
  test('Mehrfachauswahl: das Kästchen der Zeile öffnet die Leiste, „Auswahl aufheben" schließt sie', async ({
    page,
  }) => {
    await page.goto('/');
    await card(page, formTitle)
      .getByRole('button', { name: 'Antworten' })
      .click();

    const bar = page.getByRole('group', { name: 'Ausgewählte Antworten' });
    await expect(bar).toHaveCount(0);

    const box = page.getByRole('checkbox', { name: /Antwort von|auswählen/u });
    await expect(box.first()).toBeVisible();
    await box.first().tap();

    await expect(bar).toBeVisible();
    await expect(bar).toContainText('1 Antwort');
    await expectNoHorizontalScroll(page, 'Antworten mit Auswahl-Leiste');
    await expectNoControlCovered(page, 'Antworten mit Auswahl-Leiste', {
      // The same one finding as in the tour, and **only** this one: the
      // selection bar itself lies over nothing.
      knownStickyShadow: RESPONSES_STICKY_SHADOW,
    });

    await bar.getByRole('button', { name: 'Auswahl aufheben' }).tap();
    await expect(bar).toHaveCount(0);
  });
});

/* --- Pager of the dashboard  ----------------------------- */

test.describe('Blätterbedienung des Dashboards', () => {
  /**
   * **The list is a dummy, and a derived one at that.** Creating 25 forms
   * would be the other way; it costs 25 real rows in the database
   * of this organization that nobody clears away again, for a statement about two
   * buttons. Instead the **real** answer of `GET /api/forms` is fetched
   * and its `items` field is lengthened to 26 entries by duplicating the first entry
   * with a new id and a new title: field names, types and
   * every field added since therefore come from the server.
   */
  test('„Weiter" blättert auf Seite 2, und die Seitenzahl sagt es', async ({
    page,
  }) => {
    const real = await page.request.get('/api/forms?limit=24&offset=0');
    expect(real.status()).toBe(200);
    const body: unknown = await real.json();
    const items =
      typeof body === 'object' && body !== null && 'items' in body
        ? (body as { readonly items: unknown }).items
        : undefined;
    expect(
      Array.isArray(items) && items.length > 0,
      'Für die Attrappe braucht es mindestens ein echtes Formular als Vorlage ' +
        '— das Prüfformular dieser Datei ist eines.',
    ).toBe(true);
    const template = (items as readonly unknown[])[0] as Record<
      string,
      unknown
    >;

    const total = 26;
    // Two digits from „01" on: „Attrappe 1" would as search text also be contained
    // in „Attrappe 12", and the card filter searches substrings — measured on the
    // first run, eleven hits on a locator that meant one.
    const all = Array.from({ length: total }, (_unused, index) => ({
      ...template,
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      title: `Attrappe ${String(index + 1).padStart(2, '0')}`,
    }));

    await page.route('**/api/forms?*', async (route) => {
      const url = new URL(route.request().url());
      const limit = Number(url.searchParams.get('limit') ?? '24');
      const offset = Number(url.searchParams.get('offset') ?? '0');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...(body as Record<string, unknown>),
          items: all.slice(offset, offset + limit),
          total,
          limit,
          offset,
        }),
      });
    });

    // Via the navigation: the dashboard out of the sheet, not by address.
    await page.goto('/');
    await openViaSheet(page, 'Dashboard');

    const pager = page.getByRole('navigation', {
      name: 'Seiten der Formularliste',
    });
    await expect(pager).toBeVisible();
    await expect(pager).toContainText('Seite 1 von 2');
    await expect(card(page, 'Attrappe 01')).toBeVisible();
    await expect(card(page, 'Attrappe 25')).toHaveCount(0);

    await expectNoHorizontalScroll(page, 'Dashboard mit Blätterbedienung');
    await expectNoControlCovered(page, 'Dashboard mit Blätterbedienung');

    await pager.getByRole('button', { name: /Nächste Seite/u }).tap();

    await expect(pager).toContainText('Seite 2 von 2');
    await expect(card(page, 'Attrappe 25')).toBeVisible();
    await expect(card(page, 'Attrappe 01')).toHaveCount(0);

    await pager.getByRole('button', { name: /Vorherige Seite/u }).tap();
    await expect(pager).toContainText('Seite 1 von 2');
  });
});

/* --- AI dialog together with preview  ------------------------------------- */

test.describe('KI-Formular auf dem Dashboard', () => {
  /**
   * **Without a key the button is missing — and that is the state of this
   * environment.**
   *
   * The `.env` of this run has `AI_PROVIDER` empty, so the session reports
   * `aiFormsAvailable: false` and the button is **absent**, not
   * greyed out. This case measures exactly that, so that the case below is not
   * misunderstood as "the button is missing": it is missing because it is supposed to be.
   *
   * **Measured on the dashboard, not in the sheet** (finding 18). Until then
   * „✦ KI-Formular" stood in the head navigation and thereby in the off-canvas sheet;
   * this case looked for it there. Since the button stands next to „+ Neues Formular",
   * "not in the sheet" would be trivially true — green without ever having measured anything.
   *
   * The positive control next to it is therefore mandatory: „+ Neues Formular" must
   * stand there. Without it the absence would be green even if the whole
   * box had not rendered (it hangs on `canBuild` and on an
   * organization).
   */
  test('ohne Schlüssel steht „✦ KI-Formular" nicht auf dem Dashboard', async ({
    page,
  }) => {
    const me = await page.request.get('/api/auth/me');
    expect(me.status()).toBe(200);
    const body: unknown = await me.json();
    expect(
      (body as { readonly aiFormsAvailable?: unknown }).aiFormsAvailable,
      'Diese Umgebung hat keinen KI-Schlüssel; der Fall darunter stellt die ' +
        'andere Lage her, indem er genau dieses Feld umschreibt.',
    ).toBe(false);

    await page.goto('/');
    await expect(
      page.getByRole('button', { name: '+ Neues Formular' }),
      'Die Positivkontrolle: ohne den Anlegen-Kasten wäre die Abwesenheit ' +
        'darunter eine Aussage über eine Seite, die gar nicht da ist.',
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: /KI-Formular/u }),
    ).toHaveCount(0);
  });

  /**
   * **With a key: button on the dashboard → dialog → preview**, all with
   * the finger.
   *
   * Two derived dummies and no invented one:
   * - `GET /api/auth/me` is fetched and **one field** in it rewritten
   *   (`aiFormsAvailable`). Everything else is the server's answer.
   * - The answer to `POST /api/ai/forms` carries as `definition` the
   *   **real** definition of the test form from `GET /api/forms/:id`. That way
   *   the hardest part of the payload is schema-valid by construction — exactly
   *   the sort of dummy on which `mail-log-mobile` silently fell through.
   *
   * It ends with *Verwerfen*: this case creates no form.
   */
  test('mit Schlüssel führt der Dashboard-Knopf bis in die Vorschau', async ({
    page,
  }) => {
    const me = await page.request.get('/api/auth/me');
    const session = (await me.json()) as Record<string, unknown>;
    const detail = await page.request.get(`/api/forms/${fixture.formId}`);
    expect(detail.status()).toBe(200);
    const form = (await detail.json()) as Record<string, unknown>;

    await page.route('**/api/auth/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...session, aiFormsAvailable: true }),
      });
    });
    await page.route('**/api/ai/quota', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ used: 2, limit: 50 }),
      });
    });
    await page.route('**/api/ai/forms', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          title: 'Bestandsmeldung',
          definition: form.definition,
          quota: { used: 3, limit: 50 },
        }),
      });
    });

    await page.goto('/');

    /*
      **And here "not in the sheet" is a measurement** (finding 18). The case
      above cannot evidence that: without a key the button exists
      nowhere. Here the session reports `aiFormsAvailable: true`, so the button is
      there — and the off-canvas sheet nevertheless does not carry it, because it has
      changed floor and not merely gained one.
    */
    const { sheet } = await openMobileMenu(page);
    await expect(sheet.getByText('Allgemein', { exact: true })).toBeVisible();
    await expect(
      sheet.getByRole('button', { name: /KI-Formular/u }),
      '„✦ KI-Formular" steht seit Befund 18 auf dem Dashboard. Im ' +
        'Off-Canvas-Sheet wäre es ein zweiter Weg zum selben Dialog — und der ' +
        'einzige Eintrag dort, der keine Adresse ist.',
    ).toHaveCount(0);
    await sheet.getByRole('button', { name: 'Menü schließen' }).tap();
    await expect(sheet).toHaveCount(0);

    const entry = page.getByRole('button', { name: /KI-Formular/u });
    await expect(entry).toBeVisible();
    await entry.tap();

    const dialog = page.getByRole('dialog', {
      name: 'Formular mit KI erstellen',
    });
    await expect(dialog).toBeVisible();
    await expectNoHorizontalScroll(page, 'KI-Dialog (360 px)');
    await expectNoControlCovered(page, 'KI-Dialog (360 px)', { minimum: 3 });

    await dialog
      .getByLabel('Beschreibung des Formulars')
      .fill('Eine Bestandsmeldung mit Name und Anschrift.');
    await dialog.getByRole('button', { name: /Formular generieren/u }).tap();

    // The preview — and it shows what the answer carried, not just anything.
    await expect(dialog).toContainText('Vorschau – noch ist nichts angelegt');
    await expect(dialog.getByLabel('Name des neuen Formulars')).toHaveValue(
      'Bestandsmeldung',
    );
    await expect(dialog).toContainText('Name des Mitglieds');
    await expect(dialog).toContainText(
      'KI-Kontingent dieser Organisation: 3 von 50 Aufrufen verbraucht, 47 übrig.',
    );
    await expectNoHorizontalScroll(page, 'KI-Dialog mit Vorschau (360 px)');

    // *Verwerfen* sends nothing and creates nothing.
    await dialog.getByRole('button', { name: 'Verwerfen' }).tap();
    await expect(dialog).toHaveCount(0);
  });
});

/* --- Reply-to address in the dispatch log ------------------------- */

test.describe('Antwortadresse im Versandprotokoll', () => {
  /**
   * **Without a dummy.** The row comes about as it comes about in operation: a
   * form with a notification, published, filled in by a stranger
   * without a session. This environment has no mail server, so the row stays `queued` — and that is exactly not what this is
   * about: what is measured is what the detail panel shows under **Antwortadresse**.
   *
   * The log is reached via the off-canvas sheet, section
   * „Aktuelles Formular" — the desktop's sub-bar does not exist at 360 px.
   */
  test('das Detail-Panel nennt die wirksame Antwortadresse', async ({
    page,
    browser,
  }) => {
    const title = await newForm(page, 'Antwortadresse mobil');
    const mailFormId = /\/forms\/([^/?#]+)/u.exec(page.url())?.[1];
    await addQuestion(page, 'Text', 'Name des Mitglieds');
    await saveForm(page);
    const publicPath = await publishAndReadPath(page);

    // Unique per run: `mail_log` is kept for 90 days, and two runs
    // must not count each other's row away (`mail-log.spec.ts`).
    const office = `sekretariat-${Date.now().toString(36)}@example.invalid`;
    const subject = `Anmeldung ${Date.now().toString(36)}`;

    await openViaSheet(page, 'Benachrichtigungen');
    await page.getByRole('button', { name: '+ Neue Benachrichtigung' }).click();
    const editor = page.getByRole('region', { name: 'Benachrichtigung' });
    await editor
      .getByRole('textbox', { name: 'Name', exact: true })
      .fill('Büro');
    await editor
      .getByRole('textbox', { name: 'Betreff', exact: true })
      .fill(subject);
    await editor
      .getByRole('textbox', { name: 'Text', exact: true })
      .fill('Es ist eine Anmeldung eingegangen.');
    await editor
      .getByRole('textbox', { name: /Weitere Adressen/u })
      .fill(office);
    await page.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(
      editor.getByText('Gespeichert', { exact: true }),
    ).toBeVisible();

    const guestContext = await browser.newContext({
      viewport: { width: 360, height: 740 },
      hasTouch: true,
    });
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);
      await guest.getByLabel(/Name des Mitglieds/u).fill('Carl Corps');
      await guest.getByRole('button', { name: 'Absenden' }).tap();
      await expect(
        guest.getByRole('heading', { level: 1, name: 'Vielen Dank!' }),
      ).toBeVisible();
    } finally {
      await guestContext.close();
    }

    await openViaSheet(page, 'E-Mail-Versandprotokoll');
    await expect(
      page.getByRole('heading', { level: 1, name: 'E-Mail-Versandprotokoll' }),
    ).toBeVisible();

    const row = page
      .locator('[data-testid^="mail-log-row-"]')
      .filter({ hasText: office });
    await expect(row).toHaveCount(1);
    await row.getByRole('button', { name: subject }).tap();

    // The row „Antwortadresse" — the value that `reply_to`
    // got on enqueueing. Without a default of its own that is the statement
    // „Antworten gehen an die Absenderadresse", and **this** row is the one
    // that was so far nowhere to be seen in the product.
    const replyTo = page.getByTestId('mail-log-reply-to');
    await expect(replyTo).toBeVisible();
    await expect(replyTo).not.toBeEmpty();

    await expectNoHorizontalScroll(page, 'Versandprotokoll-Detail (360 px)');

    await purgeFixtureForm(browser, mailFormId);
    expect(title).not.toBe('');
  });
});
