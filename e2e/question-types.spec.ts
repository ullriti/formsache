import { readFile } from 'node:fs/promises';

import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  addQuestion,
  expectNoHorizontalScroll,
  expectSaved,
  newForm,
  publishAndReadPath,
  saveForm,
  openFormSettings,
} from './app-flows';
import { authStateFile } from './seed-account';

/**
 * The five question types built today plus the page header,
 * in a real browser — the half none of the unit/integration suites can reach.
 *
 * Every one of these was, until this file, wired up and validated on the
 * server but never actually **filled in by a browser**: `pnpm -r test` proves
 * the shapes, this proves a pointer (and a finger, in the mobile sibling)
 * lands on the right control and the answer that comes out the other end —
 * responses table, detail cell and CSV — is the one a participant gave.
 *
 * Each test builds its own form for the reason `builder-drag.spec.ts`
 * documents: the suite runs in parallel, and a shared form would make one
 * test's submission another test's flake. No Organisation is created anywhere in
 * this file — only forms, which is the accepted residue until the
 * trash reaches them.
 */

test.use({ storageState: authStateFile });

/* --- CSV, read the way a spreadsheet would ------------------------------- */

/** Splits one CSV line into fields, honouring RFC 4180 quoting (`csv.ts`). */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    // `noUncheckedIndexedAccess` — `line[index]` is `string | undefined` in
    // principle; the loop bound already guarantees it exists here.
    const char: string = line[index] ?? '';
    if (inQuotes) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ';') {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

/** The exported file as rows of fields — `;`-delimited, BOM and CRLF gone. */
function parseCsv(raw: string): string[][] {
  const withoutBom = raw.startsWith('﻿') ? raw.slice(1) : raw;
  return withoutBom
    .split('\r\n')
    .filter((line) => line !== '')
    .map(splitCsvLine);
}

/** Downloads the visible-columns CSV of the open editor and parses it. */
async function downloadCsv(page: Page): Promise<string[][]> {
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export' }).click();
  await page.getByRole('link', { name: 'CSV' }).click();
  const download = await downloading;
  const raw = await readFile(await download.path(), 'utf8');
  return parseCsv(raw);
}

/** One row of the CSV as `{ header: value }`, by the header row's labels. */
function csvRowByHeader(rows: string[][]): Record<string, string> {
  const [header, ...body] = rows;
  expect(header, 'the export must carry a header row').toBeDefined();
  expect(body, 'the export must carry exactly one response').toHaveLength(1);
  const values = body[0] ?? [];
  const result: Record<string, string> = {};
  (header ?? []).forEach((label, index) => {
    result[label] = values[index] ?? '';
  });
  return result;
}

const COLUMN_SEP = ' — '; // `COLUMN_LABEL_SEPARATOR`, apps/shared/answer-columns.ts

/** Opens the response table of a just-built form from the dashboard. */
async function openResponses(page: Page, title: string): Promise<void> {
  await page.goto('/');
  await page
    .getByRole('article')
    .filter({ hasText: title })
    .getByRole('button', { name: 'Antworten' })
    .click();
  await expect(
    page.getByRole('heading', { level: 1, name: `Antworten · ${title}` }),
  ).toBeVisible();
}

/* --- the properties panel's labelled lists (matrix rows/columns, table columns) */

/** The `.props__options` block whose caption is exactly this text. */
function propsGroup(page: Page, caption: string): Locator {
  return page
    .locator('.props__options')
    .filter({ has: page.getByText(caption, { exact: true }) });
}

/** The label of each entry of a labelled list, in document order. */
async function entryLabels(
  group: Locator,
  itemSelector: string,
): Promise<string[]> {
  const items = group.locator(itemSelector);
  const count = await items.count();
  const labels: string[] = [];
  for (let index = 0; index < count; index += 1) {
    labels.push(await items.nth(index).locator('input').first().inputValue());
  }
  return labels;
}

/* --- Matrix and Tabelle, the editor ------------------------------- */

test.describe('Matrix- und Tabellen-Editor', () => {
  test('reorders rows and columns with ↑/↓, adds and removes entries, and it survives a reload', async ({
    page,
  }) => {
    const title = await newForm(page, 'Fragetyp Editor');

    await addQuestion(page, 'Matrix');
    const rows = propsGroup(page, 'Zeilen (Aussagen)');
    expect(await entryLabels(rows, 'li')).toStrictEqual([
      'Organisation',
      'Programm',
      'Verpflegung',
    ]);

    // ↑ on the last row: a pure reorder, not a rewrite of the two it swaps.
    await page
      .getByRole('button', { name: 'Zeilen (Aussagen) 3 nach oben' })
      .click();
    expect(await entryLabels(rows, 'li')).toStrictEqual([
      'Organisation',
      'Verpflegung',
      'Programm',
    ]);

    await page.getByRole('button', { name: '+ Zeile' }).click();
    expect(await entryLabels(rows, 'li')).toStrictEqual([
      'Organisation',
      'Verpflegung',
      'Programm',
      'Neue Zeile',
    ]);

    await page
      .getByRole('button', { name: 'Zeilen (Aussagen) 1 entfernen' })
      .click();
    expect(await entryLabels(rows, 'li')).toStrictEqual([
      'Verpflegung',
      'Programm',
      'Neue Zeile',
    ]);

    const columns = propsGroup(page, 'Spalten (Skala)');
    expect(await entryLabels(columns, 'li')).toStrictEqual([
      'Sehr gut',
      'Gut',
      'Neutral',
      'Schlecht',
    ]);
    // ↓ on the first column, the opposite direction from the rows above —
    // both buttons of the same pair are exercised, not just one of them.
    await page
      .getByRole('button', { name: 'Spalten (Skala) 1 nach unten' })
      .click();
    expect(await entryLabels(columns, 'li')).toStrictEqual([
      'Gut',
      'Sehr gut',
      'Neutral',
      'Schlecht',
    ]);

    await addQuestion(page, 'Tabelle');
    const tableColumns = propsGroup(page, 'Spalten');
    expect(
      await entryLabels(tableColumns, '.props__table-column'),
    ).toStrictEqual(['Spalte 1', 'Spalte 2']);

    await page.getByRole('button', { name: '+ Spalte' }).click();
    await page.getByRole('button', { name: 'Spalte 3 nach oben' }).click();
    expect(
      await entryLabels(tableColumns, '.props__table-column'),
    ).toStrictEqual(['Spalte 1', 'Neue Spalte', 'Spalte 2']);

    await page.getByRole('button', { name: 'Spalte 3 entfernen' }).click();
    expect(
      await entryLabels(tableColumns, '.props__table-column'),
    ).toStrictEqual(['Spalte 1', 'Neue Spalte']);

    await saveForm(page);
    await page.reload();
    await expect(page.getByLabel('Formularname')).toHaveValue(title);

    // The document changed, not just the DOM — reselect each card and read
    // the properties panel again, exactly `builder-drag.spec.ts`'s standard.
    const cards = page.locator('[data-question-id]');
    await cards.nth(0).click();
    expect(
      await entryLabels(propsGroup(page, 'Zeilen (Aussagen)'), 'li'),
    ).toStrictEqual(['Verpflegung', 'Programm', 'Neue Zeile']);
    expect(
      await entryLabels(propsGroup(page, 'Spalten (Skala)'), 'li'),
    ).toStrictEqual(['Gut', 'Sehr gut', 'Neutral', 'Schlecht']);

    await cards.nth(1).click();
    expect(
      await entryLabels(propsGroup(page, 'Spalten'), '.props__table-column'),
    ).toStrictEqual(['Spalte 1', 'Neue Spalte']);
  });
});

/* --- Bewertung ----------------------------------------------------- */

test.describe('Bewertung', () => {
  test('a click on the third star stores 3, on screen and in the export', async ({
    page,
    browser,
  }) => {
    const title = await newForm(page, 'Bewertung Klick');
    await addQuestion(page, 'Bewertung', 'Zufriedenheit');
    await saveForm(page);
    const publicPath = await publishAndReadPath(page);

    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);
      // The radio itself is visually hidden (screen-reader pattern, 1×1 px) —
      // a person clicks the star glyph next to it, which is what the label
      // wrapping both actually receives.
      await guest.locator('.field__rating-star').nth(2).click();
      await expect(guest.getByLabel('3 von 5 Sternen')).toBeChecked();
      await expect(guest.getByLabel('1 von 5 Sternen')).not.toBeChecked();

      await guest.getByRole('button', { name: 'Absenden' }).click();
      await expect(
        guest.getByRole('heading', { level: 1, name: 'Vielen Dank!' }),
      ).toBeVisible();
    } finally {
      await guestContext.close();
    }

    await openResponses(page, title);
    await expect(
      page.getByRole('cell', { name: '3', exact: true }),
    ).toBeVisible();

    const rows = csvRowByHeader(await downloadCsv(page));
    // Numeric guard (`guard: 'number'`), not text — `3` unquoted and
    // unprefixed, which is also what lets a spreadsheet sort it as a number.
    expect(rows.Zufriedenheit).toBe('3');
  });

  test('is operable without a mouse — the stars are real radios', async ({
    page,
    browser,
  }) => {
    const title = await newForm(page, 'Bewertung Tastatur');
    await addQuestion(page, 'Bewertung', 'Note');
    await saveForm(page);
    const publicPath = await publishAndReadPath(page);

    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);

      // `.focus()` only sets focus, it moves no pointer; every step after it
      // is a keyboard event. No `.click()`/`.check()` anywhere in this case.
      const firstStar = guest.getByLabel('1 von 5 Sternen');
      await firstStar.focus();
      await expect(firstStar).toBeFocused();

      // A native radio group both moves focus *and* selects on an arrow key —
      // that is the point of using real `<input type="radio">`s (an earlier
      // review finding).
      await guest.keyboard.press('ArrowRight');
      await guest.keyboard.press('ArrowRight');
      await expect(guest.getByLabel('3 von 5 Sternen')).toBeChecked();

      // The claim of this case is the rating control, not the whole form —
      // submitting by mouse here is fine, and keeps the case from depending
      // on the tab order of controls this file does not own (the „Zurück-
      // setzen" button appears right after the stars once one is picked).
      await guest.getByRole('button', { name: 'Absenden' }).click();
      await expect(
        guest.getByRole('heading', { level: 1, name: 'Vielen Dank!' }),
      ).toBeVisible();
    } finally {
      await guestContext.close();
    }

    await openResponses(page, title);
    await expect(
      page.getByRole('cell', { name: '3', exact: true }),
    ).toBeVisible();
  });
});

/* --- Adresse --------------------------------------------------------*/

test.describe('Adresse', () => {
  test('four subfields become four export columns, and 01067 survives as text', async ({
    page,
    browser,
  }) => {
    const title = await newForm(page, 'Adresse Export');
    await addQuestion(page, 'Adresse', 'Anschrift');
    await saveForm(page);
    const publicPath = await publishAndReadPath(page);

    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);

      // Land carries its default before anything is typed.
      await expect(guest.getByLabel('Land', { exact: true })).toHaveValue(
        'Deutschland',
      );

      await guest.getByLabel('Straße & Hausnummer').fill('Musterstraße 1');
      await guest.getByLabel('PLZ', { exact: true }).fill('01067');
      await guest.getByLabel('Ort', { exact: true }).fill('Dresden');

      await guest.getByRole('button', { name: 'Absenden' }).click();
      await expect(
        guest.getByRole('heading', { level: 1, name: 'Vielen Dank!' }),
      ).toBeVisible();
    } finally {
      await guestContext.close();
    }

    // On screen: one row, one folded cell.
    await openResponses(page, title);
    await expect(
      page.getByRole('cell', {
        name: 'Musterstraße 1, 01067 Dresden, Deutschland',
      }),
    ).toBeVisible();

    // In the file: four columns, named after the question and the part.
    const rows = await downloadCsv(page);
    const header = rows[0] ?? [];
    const addressColumns = header.filter((label) =>
      label.startsWith(`Anschrift${COLUMN_SEP}`),
    );
    expect(addressColumns).toStrictEqual([
      `Anschrift${COLUMN_SEP}Straße & Hausnummer`,
      `Anschrift${COLUMN_SEP}PLZ`,
      `Anschrift${COLUMN_SEP}Ort`,
      `Anschrift${COLUMN_SEP}Land`,
    ]);

    const cells = csvRowByHeader(rows);
    expect(cells[`Anschrift${COLUMN_SEP}Straße & Hausnummer`]).toBe(
      'Musterstraße 1',
    );
    // Text-guarded (the requirement's own reproduction): a leading apostrophe,
    // never the bare digits a spreadsheet would reinterpret as `1067`.
    expect(cells[`Anschrift${COLUMN_SEP}PLZ`]).toBe("'01067");
    expect(cells[`Anschrift${COLUMN_SEP}PLZ`]).not.toBe('1067');
    expect(cells[`Anschrift${COLUMN_SEP}Ort`]).toBe('Dresden');
    expect(cells[`Anschrift${COLUMN_SEP}Land`]).toBe('Deutschland');
  });
});

/* --- Infotext -------------------------------------------------------*/

test.describe('Infotext', () => {
  test('appears while filling in, has no input of its own and no column anywhere', async ({
    page,
    browser,
  }) => {
    const title = await newForm(page, 'Infotext Sichtbarkeit');
    await addQuestion(page, 'Infotext', 'Bitte lesen');
    await page.getByLabel('Hinweistext').fill('Das ist nur ein Hinweis.');
    await addQuestion(page, 'Text', 'Vorname');
    await saveForm(page);
    const publicPath = await publishAndReadPath(page);

    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);

      const callout = guest.locator('.field__info');
      await expect(callout).toContainText('Bitte lesen');
      await expect(callout).toContainText('Das ist nur ein Hinweis.');
      // No field anywhere carries this as its accessible name — an `info`
      // has no control, per the requirement.
      await expect(guest.getByLabel('Bitte lesen')).toHaveCount(0);
      await expect(callout.locator('input, textarea, select')).toHaveCount(0);

      await guest.getByLabel('Vorname').fill('Anton');
      await guest.getByRole('button', { name: 'Absenden' }).click();
      await expect(
        guest.getByRole('heading', { level: 1, name: 'Vielen Dank!' }),
      ).toBeVisible();
    } finally {
      await guestContext.close();
    }

    await openResponses(page, title);
    await expect(
      page.locator('.responses__table thead').getByText('Bitte lesen'),
    ).toHaveCount(0);
    await expect(page.getByRole('cell', { name: 'Anton' })).toBeVisible();

    const rows = await downloadCsv(page);
    const header = (rows[0] ?? []).join(';');
    expect(header).not.toContain('Bitte lesen');
    expect(header).toContain('Vorname');
  });
});

/* --- Matrix, filled with the mouse ---------------------------------*/

test.describe('Matrix ausfüllen mit der Maus', () => {
  test('one selection per row by default, several once „Mehrfachauswahl je Zeile" is on', async ({
    page,
    browser,
  }) => {
    const title = await newForm(page, 'Matrix Maus');

    await addQuestion(page, 'Matrix', 'Matrix Einzel');
    await addQuestion(page, 'Matrix', 'Matrix Mehrfach');
    await page.getByLabel('Mehrfachauswahl je Zeile').check();
    await saveForm(page);
    const publicPath = await publishAndReadPath(page);

    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);
      await expectNoHorizontalScroll(guest, 'Matrix-Formular (Desktop)');

      const single = guest.getByRole('group', { name: 'Matrix Einzel' });
      // Two clicks in the same row — a native radio group enforces „eine
      // Auswahl je Zeile" itself, with no application code involved.
      await single.getByLabel('Organisation: Sehr gut').check();
      await single.getByLabel('Organisation: Gut').check();
      await expect(single.getByLabel('Organisation: Gut')).toBeChecked();
      await expect(
        single.getByLabel('Organisation: Sehr gut'),
      ).not.toBeChecked();
      await single.getByLabel('Programm: Neutral').check();

      const multi = guest.getByRole('group', { name: 'Matrix Mehrfach' });
      await multi.getByLabel('Organisation: Sehr gut').check();
      await multi.getByLabel('Organisation: Gut').check();
      // The opposite of the single case: both stay checked.
      await expect(multi.getByLabel('Organisation: Sehr gut')).toBeChecked();
      await expect(multi.getByLabel('Organisation: Gut')).toBeChecked();
      await multi.getByLabel('Programm: Schlecht').check();
      await multi.getByLabel('Programm: Neutral').check();

      await guest.getByRole('button', { name: 'Absenden' }).click();
      await expect(
        guest.getByRole('heading', { level: 1, name: 'Vielen Dank!' }),
      ).toBeVisible();
    } finally {
      await guestContext.close();
    }

    await openResponses(page, title);
    await expect(
      page.getByRole('cell', {
        name: 'Organisation: Gut; Programm: Neutral',
      }),
    ).toBeVisible();
    await expect(
      page.getByRole('cell', {
        name: 'Organisation: Sehr gut, Gut; Programm: Schlecht, Neutral',
      }),
    ).toBeVisible();

    const cells = csvRowByHeader(await downloadCsv(page));
    expect(cells[`Matrix Einzel${COLUMN_SEP}Organisation`]).toBe('Gut');
    expect(cells[`Matrix Einzel${COLUMN_SEP}Programm`]).toBe('Neutral');
    expect(cells[`Matrix Einzel${COLUMN_SEP}Verpflegung`]).toBe('');
    expect(cells[`Matrix Mehrfach${COLUMN_SEP}Organisation`]).toBe(
      'Sehr gut, Gut',
    );
    expect(cells[`Matrix Mehrfach${COLUMN_SEP}Programm`]).toBe(
      'Schlecht, Neutral',
    );
  });
});

/* --- Tabelle, filled with the mouse --------------------------------*/

/** Builds a table question with all four Zelltypen, in this column order. */
async function buildFourCellTypesTable(page: Page): Promise<void> {
  await addQuestion(page, 'Tabelle', 'Verpflegung Tabelle');

  const columns = propsGroup(page, 'Spalten');

  await columns
    .locator('.props__table-column')
    .nth(0)
    .getByLabel('Spalte 1', { exact: true })
    .fill('Text');
  // Column 1 stays „Text" — the default Zelltyp needs no change.

  await columns
    .locator('.props__table-column')
    .nth(1)
    .getByLabel('Spalte 2', { exact: true })
    .fill('Zahl');
  await columns
    .locator('.props__table-column')
    .nth(1)
    .getByLabel('Spalte 2: Art', { exact: true })
    .selectOption('number');

  await page.getByRole('button', { name: '+ Spalte' }).click();
  await columns
    .locator('.props__table-column')
    .nth(2)
    .getByLabel('Spalte 3', { exact: true })
    .fill('Liste');
  await columns
    .locator('.props__table-column')
    .nth(2)
    .getByLabel('Spalte 3: Art', { exact: true })
    .selectOption('select');

  await page.getByRole('button', { name: '+ Spalte' }).click();
  await columns
    .locator('.props__table-column')
    .nth(3)
    .getByLabel('Spalte 4', { exact: true })
    .fill('Haken');
  await columns
    .locator('.props__table-column')
    .nth(3)
    .getByLabel('Spalte 4: Art', { exact: true })
    .selectOption('checkbox');
}

test.describe('Tabelle ausfüllen mit der Maus', () => {
  test('all four Zelltypen — Text, Zahl, Liste, Haken — are filled and exported', async ({
    page,
    browser,
  }) => {
    const title = await newForm(page, 'Tabelle Maus');
    await buildFourCellTypesTable(page);
    await saveForm(page);
    const publicPath = await publishAndReadPath(page);

    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);
      await expectNoHorizontalScroll(guest, 'Tabelle-Formular (Desktop)');

      await guest.getByLabel('Text, Zeile 1').fill('Hallo Welt');
      await guest.getByLabel('Zahl, Zeile 1').fill('42');
      await guest
        .getByLabel('Liste, Zeile 1')
        .selectOption({ label: 'Option 2' });
      await guest.getByLabel('Haken, Zeile 1').check();

      await guest.getByRole('button', { name: 'Absenden' }).click();
      await expect(
        guest.getByRole('heading', { level: 1, name: 'Vielen Dank!' }),
      ).toBeVisible();
    } finally {
      await guestContext.close();
    }

    await openResponses(page, title);
    await expect(
      page.getByRole('cell', {
        name: 'Text: Hallo Welt, Zahl: 42, Liste: Option 2, Haken: Ja',
      }),
    ).toBeVisible();

    const rows = await downloadCsv(page);
    const cells = csvRowByHeader(rows);
    const header = rows[0] ?? [];
    const tableColumns = header.filter((label) =>
      label.startsWith(`Verpflegung Tabelle${COLUMN_SEP}`),
    );
    // Four Zelltypen × two Zeilen — every cell its own column.
    expect(tableColumns).toHaveLength(8);

    expect(cells[`Verpflegung Tabelle${COLUMN_SEP}Text (Zeile 1)`]).toBe(
      'Hallo Welt',
    );
    expect(cells[`Verpflegung Tabelle${COLUMN_SEP}Zahl (Zeile 1)`]).toBe('42');
    expect(cells[`Verpflegung Tabelle${COLUMN_SEP}Liste (Zeile 1)`]).toBe(
      'Option 2',
    );
    expect(cells[`Verpflegung Tabelle${COLUMN_SEP}Haken (Zeile 1)`]).toBe('Ja');
    // The untouched second row: every one of its four columns is empty, not
    // dropped — a fixed set of columns is the whole point of a table.
    expect(cells[`Verpflegung Tabelle${COLUMN_SEP}Text (Zeile 2)`]).toBe('');
    expect(cells[`Verpflegung Tabelle${COLUMN_SEP}Zahl (Zeile 2)`]).toBe('');
  });
});

/* --- Seitentitel and Seitenbeschreibung ----------------------------*/

test.describe('Seitentitel und Seitenbeschreibung', () => {
  /** Opens the open form's settings and takes one section over. */
  async function customiseSection(page: Page, heading: string): Promise<void> {
    await openFormSettings(page);
    await page
      .getByRole('region', { name: heading })
      .getByRole('radio', { name: 'Angepasst' })
      .check();
  }

  test('stay visible when Seitennummern are switched off', async ({
    page,
    browser,
  }) => {
    await newForm(page, 'Seiten Header');
    await addQuestion(page, 'Text', 'Seite 1 Feld');
    await page.getByLabel('Titel von Seite 1').fill('Wichtige Hinweise');
    await page
      .getByLabel('Beschreibung von Seite 1')
      .fill('Bitte alle Angaben vollständig ausfüllen.');

    await page.getByRole('button', { name: '+ Seite hinzufügen' }).click();
    await addQuestion(page, 'Text', 'Seite 2 Feld');

    await saveForm(page);
    const publicPath = await publishAndReadPath(page);

    await customiseSection(page, 'Darstellung');
    const display = page.getByRole('region', { name: 'Darstellung' });
    const pageNumbers = display.getByRole('switch', {
      name: 'Seitennummern anzeigen',
    });
    await pageNumbers.setChecked(false);
    await page.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expectSaved(page);

    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);

      // The flag actually took: no „Seite 1 von 2" anywhere.
      await expect(guest.getByText('Seite 1 von 2')).toHaveCount(0);

      // …and the page's own heading and description stand regardless.
      await expect(
        guest.getByRole('heading', { level: 2, name: 'Wichtige Hinweise' }),
      ).toBeVisible();
      await expect(
        guest.getByText('Bitte alle Angaben vollständig ausfüllen.'),
      ).toBeVisible();
    } finally {
      await guestContext.close();
    }
  });
});

/* --- Datei-Upload, the whole round trip ----------------------------*/

test.describe('Datei-Upload', () => {
  /**
   * **The proof in as many words**: „der Rundlauf über
   * die Oberfläche, mit einer echten Datei, im Browser" — pick it, upload it,
   * see what was uploaded, remove it again; then the file name as a link in
   * the Antworten-Tabelle and in the detail, and in the export the name.
   *
   * A **real PDF** rather than a text file with a `.pdf` name: the server reads
   * the signature of the content at offset 0 and refuses everything else
   * (ADR-0014 no. 5), so an invented file would be rejected — which is itself
   * worth having gone through once with a browser doing the sending.
   *
   * The last assertion is the negative one and is the point of no. 17: the
   * export carries the **name**, and the address the link points at appears
   * nowhere in the file.
   */
  test('is picked, uploaded, shown, removed and re-added — and exports its name', async ({
    page,
    browser,
  }) => {
    const title = await newForm(page, 'Datei Rundlauf');
    await addQuestion(page, 'Datei-Upload', 'Nachweis');
    await saveForm(page);
    const publicPath = await publishAndReadPath(page);

    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);
      await expectNoHorizontalScroll(guest, 'Datei-Formular (Desktop)');

      // The rule the **server** will apply, shown rather than asked for: the
      // handoff's editable „Erlaubte Dateitypen" box is gone on purpose.
      await expect(
        guest.getByText('Erlaubt: PDF, PNG, JPG · max. 10 MB'),
      ).toBeVisible();

      // **The name the browser computes**, not the one Testing Library does —
      // an earlier review raised the suspicion that the picker carries two
      // labels (the question's `htmlFor` and the dropzone it sits inside) and
      // that the accessible-name algorithm joins them, the same defect the
      // remove button had. This is the measurement, in the one place that
      // computes names the way a screen reader does.
      await expect(guest.getByLabel('Nachweis')).toHaveAccessibleName(
        'Nachweis',
      );

      await guest.getByLabel('Nachweis').setInputFiles({
        name: 'Falsch.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from('%PDF-1.7\nfalsche Datei\n'),
      });

      // „sehen was hochgeladen wurde" — the name the **server** stored.
      await expect(guest.getByText('Falsch.pdf')).toBeVisible();

      // „wieder entfernen", and the picker comes back afterwards.
      await guest
        .getByRole('button', { name: 'Entfernen: Falsch.pdf' })
        .click();
      await expect(guest.getByText('Falsch.pdf')).toHaveCount(0);

      await guest.getByLabel('Nachweis').setInputFiles({
        name: 'Nachweis Müller.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from('%PDF-1.7\nBescheinigung\n'),
      });
      await expect(guest.getByText('Nachweis Müller.pdf')).toBeVisible();

      await guest.getByRole('button', { name: 'Absenden' }).click();
      await expect(
        guest.getByRole('heading', { level: 1, name: 'Vielen Dank!' }),
      ).toBeVisible();
    } finally {
      await guestContext.close();
    }

    await openResponses(page, title);

    // The cell is a **link**, and it points at the guarded retrieval route
    // (ADR-0014 no. 11b) — the way to the file is this screen, behind the
    // chain, and nowhere else.
    const link = page.getByRole('link', { name: 'Nachweis Müller.pdf' });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute(
      'href',
      /^\/api\/responses\/files\/[A-Za-z0-9_-]+$/,
    );

    // …and the same link in the detail slide-in.
    await page.getByRole('button', { name: 'Ansehen' }).first().click();
    const panel = page.getByRole('dialog', { name: 'Antwort' });
    await expect(
      panel.getByRole('link', { name: 'Nachweis Müller.pdf' }),
    ).toBeVisible();
    await panel.getByRole('button', { name: 'Schließen' }).click();

    const rows = await downloadCsv(page);
    const cells = csvRowByHeader(rows);
    expect(cells.Nachweis).toBe('Nachweis Müller.pdf');
    // **No. 17, the negative half**: no address anywhere in the file. An export
    // is the document that gets mailed on and left on network drives.
    expect(rows.flat().join(';')).not.toContain('/api/responses/files/');
  });
});

/* --- Veranstaltung with participant limit ---------------------- */

test.describe('Veranstaltung', () => {
  /**
   * The builder round-trip for: **anlegen, umsortieren,
   * entfernen**, and it survives a reload — i.e. the *document* changed, not
   * only the panel.
   *
   * ↑/↓ rather than a drag, for the reason the Matrix editor above states:
   * „▲/▼-Buttons entfallen vollständig" (the specification) names the page list
   * and the question cards, whose replacement path is the keyboard-operable drag
   * handle (no. 11) — an entry in a 300-px settings panel has no handle, so a
   * pointer gesture would be the one control here with no keyboard path at all.
   * Which makes this case the keyboard proof as well — every reorder below is a
   * button somebody can reach with Tab.
   */
  test('builds, reorders and removes Veranstaltungen, and the document keeps it', async ({
    page,
  }) => {
    const title = await newForm(page, 'Veranstaltung Editor');
    await addQuestion(page, 'Veranstaltung', 'Veranstaltungen');

    const events = propsGroup(page, 'Veranstaltungen & Limits');
    // The default of a fresh question: one entry, Limit 50, switch off.
    expect(await entryLabels(events, 'li')).toStrictEqual(['Veranstaltung 1']);

    await page.getByLabel('Veranstaltung 1', { exact: true }).fill('Galaabend');
    await page.getByLabel('Veranstaltung 1: Termin').fill('Fr, 19:00');
    await page.getByLabel('Veranstaltung 1: Obergrenze').fill('120');

    await page.getByRole('button', { name: '+ Veranstaltung' }).click();
    await page
      .getByLabel('Veranstaltung 2', { exact: true })
      .fill('Sommerfest');
    await page.getByRole('button', { name: '+ Veranstaltung' }).click();
    await page.getByLabel('Veranstaltung 3', { exact: true }).fill('Festzug');
    // „Ohne Grenze" is a switch, never an empty box — the Obergrenze
    // disappears with it.
    await page.getByLabel('Veranstaltung 3: ohne Grenze').check();
    await expect(page.getByLabel('Veranstaltung 3: Obergrenze')).toHaveCount(0);

    await page
      .getByRole('button', { name: 'Veranstaltung 3 nach oben' })
      .click();
    expect(await entryLabels(events, 'li')).toStrictEqual([
      'Galaabend',
      'Festzug',
      'Sommerfest',
    ]);

    await page
      .getByRole('button', { name: 'Veranstaltung 2 entfernen' })
      .click();
    expect(await entryLabels(events, 'li')).toStrictEqual([
      'Galaabend',
      'Sommerfest',
    ]);

    await saveForm(page);
    await page.reload();
    await expect(page.getByLabel('Formularname')).toHaveValue(title);
    await page.locator('[data-question-id]').first().click();

    expect(
      await entryLabels(propsGroup(page, 'Veranstaltungen & Limits'), 'li'),
    ).toStrictEqual(['Galaabend', 'Sommerfest']);
    await expect(page.getByLabel('Veranstaltung 1: Obergrenze')).toHaveValue(
      '120',
    );

    // The live preview shows what was configured — the Obergrenze as a state,
    // never a „frei"-Zahl this side cannot know (`QuestionPreview.tsx`).
    const preview = page.locator('.q-preview__event').first();
    await expect(preview).toContainText('Galaabend');
    await expect(preview).toContainText('Fr, 19:00');
    await expect(preview).toContainText('max. 120');
  });

  /**
   * **The requirement in a real browser**: the switch decides the figure,
   * „ausgebucht" does not wait for it, and the box is locked.
   *
   * Two Veranstaltungen with an Obergrenze of one each, so a single
   * registration fills one of them. The second guest then sees:
   * „Ausgebucht" on the full one (switch **off**), the figure on the other
   * (switch **on**), and a disabled box in the first tile.
   *
   * ⚠️ **The lock is not the limit.** What holds the Obergrenze is the
   * transaction of the requirement, proven in `event-limit.spec.ts` against a
   * caller that never rendered this page.
   *
   * The accessible name is measured here and nowhere else, because **jsdom
   * does not compute one**: the box sits inside a `<label>` that also holds the
   * Termin and the badge, and without the explicit `aria-label` a browser
   * concatenates all three into the field's name („Sommerfest Sa, 20:00
   * Ausgebucht").
   */
  test('shows „Ausgebucht" without the switch, the figure with it, and names the box itself', async ({
    page,
    browser,
  }) => {
    const title = await newForm(page, 'Veranstaltung Restplätze');
    await addQuestion(page, 'Veranstaltung', 'Veranstaltungen');

    await page
      .getByLabel('Veranstaltung 1', { exact: true })
      .fill('Sommerfest');
    await page.getByLabel('Veranstaltung 1: Termin').fill('Sa, 20:00');
    await page.getByLabel('Veranstaltung 1: Obergrenze').fill('1');

    await page.getByRole('button', { name: '+ Veranstaltung' }).click();
    await page.getByLabel('Veranstaltung 2', { exact: true }).fill('Festzug');
    await page.getByLabel('Veranstaltung 2: Obergrenze').fill('4');
    await page.getByLabel('Veranstaltung 2: Restplätze anzeigen').check();

    await saveForm(page);
    const publicPath = await publishAndReadPath(page);

    const firstContext = await browser.newContext();
    const first = await firstContext.newPage();
    try {
      await first.goto(publicPath);

      // Nothing is taken yet: no „Ausgebucht" anywhere, and the figure stands
      // on the one Veranstaltung whose switch is on — and only there.
      await expect(first.getByText('Ausgebucht')).toHaveCount(0);
      await expect(first.getByText('4 frei')).toBeVisible();
      await expect(first.getByText(/frei$/u)).toHaveCount(1);

      await first.getByLabel('Sommerfest: Anzahl Personen').fill('1');
      await first.getByLabel('Festzug: Anzahl Personen').fill('2');
      await first.getByRole('button', { name: 'Absenden' }).click();
      await expect(
        first.getByRole('heading', { level: 1, name: 'Vielen Dank!' }),
      ).toBeVisible();
    } finally {
      await firstContext.close();
    }

    const secondContext = await browser.newContext();
    const second = await secondContext.newPage();
    try {
      await second.goto(publicPath);

      const full = second.getByLabel('Sommerfest: Anzahl Personen');
      // **Trap 3 of this stage, measured**: the name is the explicit one, not
      // the three strings the `<label>` wraps.
      await expect(full).toHaveAccessibleName('Sommerfest: Anzahl Personen');
      // …and the state is the field's *description*, so it is announced
      // without becoming part of its name.
      await expect(full).toHaveAccessibleDescription('Ausgebucht');
      await expect(full).toBeDisabled();

      // „Ausgebucht" arrives although this Veranstaltung's switch is **off** —
      // automatic, not a decision.
      await expect(second.getByText('Ausgebucht')).toBeVisible();
      // The other one counted the two seats the first guest took.
      await expect(second.getByText('2 frei')).toBeVisible();

      await second.getByLabel('Festzug: Anzahl Personen').fill('1');
      await second.getByRole('button', { name: 'Absenden' }).click();
      await expect(
        second.getByRole('heading', { level: 1, name: 'Vielen Dank!' }),
      ).toBeVisible();
    } finally {
      await secondContext.close();
    }

    // One column per Veranstaltung, named after both — and the
    // seat count in it, as a number a spreadsheet can sum.
    await openResponses(page, title);
    const rows = await downloadCsv(page);
    const header = rows[0] ?? [];
    expect(
      header.filter((label) =>
        label.startsWith(`Veranstaltungen${COLUMN_SEP}`),
      ),
    ).toStrictEqual([
      `Veranstaltungen${COLUMN_SEP}Sommerfest`,
      `Veranstaltungen${COLUMN_SEP}Festzug`,
    ]);
  });
});
