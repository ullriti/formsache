import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  addQuestion,
  expectNoHorizontalScroll,
  newForm,
  publishAndReadPath,
  saveForm,
} from './app-flows';
import { authStateFile } from './seed-account';

/**
 * The mobile half of the five new question types — the touch
 * gesture, and the one claim that only exists at 360 px: both grids scroll
 * inside their own container (`.field__scroll` in the fill-in view,
 * `.q-preview__scroll` in the builder's card preview) instead of taking the
 * page with them.
 *
 * `expectNoHorizontalScroll` is what actually measures that claim — its third
 * measurement deliberately does **not** flag `overflow-x: auto` boxes (see its
 * doc comment), so a grid that genuinely scrolls in its own lane passes clean
 * and only a regression that widens `<main>` or the document goes red. Every
 * case below therefore builds a matrix wide enough (4 scale columns) and a
 * table wide enough (4 Zelltyp columns) to actually overflow a 360 px screen —
 * the default 2-column table would not exercise the scroll box at all.
 *
 * Filled with `.tap()`, not `.check()`/`.click()`: `hasTouch: true` on this
 * project makes Chromium accept CDP touch input, and `.tap()` is Playwright's
 * touch-specific action — the same distinction `builder-drag.spec.ts` draws
 * for the drag gesture, here for the simpler tap-a-radio one.
 */

test.use({ storageState: authStateFile });

/** The `.props__options` block whose caption is exactly this text. */
function propsGroup(page: Page, caption: string): Locator {
  return page
    .locator('.props__options')
    .filter({ has: page.getByText(caption, { exact: true }) });
}

/** Adds a Matrix question and a Tabelle question wide enough to overflow. */
async function addWideMatrixAndTable(page: Page): Promise<void> {
  await addQuestion(page, 'Matrix', 'Matrix Mobil');
  // The default four scale columns (Sehr gut/Gut/Neutral/Schlecht) already
  // overflow 360 px next to the row headers — nothing to widen further.

  await addQuestion(page, 'Tabelle', 'Tabelle Mobil');
  // `addQuestion` already closed the sheet after naming the question — the
  // Spalten editor needs it open again, the same reopening the Matrix
  // toggle below does.
  await page.getByRole('button', { name: 'Eigenschaften' }).click();
  const columns = propsGroup(page, 'Spalten');
  await columns
    .locator('.props__table-column')
    .nth(0)
    .getByLabel('Spalte 1', { exact: true })
    .fill('Text');
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
  await page.getByRole('button', { name: 'Schließen' }).click();
}

test.describe('Builder-Vorschau von Matrix und Tabelle auf 360 px', () => {
  test('the grids scroll inside `.q-preview__scroll`, not the page', async ({
    page,
  }) => {
    await newForm(page, 'Raster Vorschau Mobil');
    await addWideMatrixAndTable(page);

    // Both cards are on screen at once (the canvas stays a plain list on
    // mobile — only the two side panels move behind sheets).
    await expect(page.locator('.q-preview__scroll')).toHaveCount(2);
    await expectNoHorizontalScroll(page, 'Builder mit Matrix/Tabelle, 360 px');
  });
});

test.describe('Matrix mit dem Finger ausfüllen', () => {
  test('one selection per row by default, several with „Mehrfachauswahl je Zeile"', async ({
    page,
    browser,
  }) => {
    const title = await newForm(page, 'Matrix Finger');

    await addQuestion(page, 'Matrix', 'Matrix Einzel');
    await addQuestion(page, 'Matrix', 'Matrix Mehrfach');
    // A real tap on the checkbox — mobile still reaches the properties sheet
    // through the same „Eigenschaften" trigger `addQuestion` already used.
    await page.getByRole('button', { name: 'Eigenschaften' }).click();
    await page.getByLabel('Mehrfachauswahl je Zeile').tap();
    await page.getByRole('button', { name: 'Schließen' }).click();

    await saveForm(page);
    const publicPath = await publishAndReadPath(page);

    const guestContext = await browser.newContext({
      viewport: { width: 360, height: 740 },
      hasTouch: true,
    });
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);
      await expectNoHorizontalScroll(guest, 'Matrix-Formular (360 px)');

      const single = guest.getByRole('group', { name: 'Matrix Einzel' });
      await single.getByLabel('Organisation: Sehr gut').tap();
      await single.getByLabel('Organisation: Gut').tap();
      await expect(single.getByLabel('Organisation: Gut')).toBeChecked();
      await expect(
        single.getByLabel('Organisation: Sehr gut'),
      ).not.toBeChecked();

      const multi = guest.getByRole('group', { name: 'Matrix Mehrfach' });
      await multi.getByLabel('Organisation: Sehr gut').tap();
      await multi.getByLabel('Organisation: Gut').tap();
      await expect(multi.getByLabel('Organisation: Sehr gut')).toBeChecked();
      await expect(multi.getByLabel('Organisation: Gut')).toBeChecked();

      await guest.getByRole('button', { name: 'Absenden' }).tap();
      await expect(
        guest.getByRole('heading', { level: 1, name: 'Vielen Dank!' }),
      ).toBeVisible();
    } finally {
      await guestContext.close();
    }

    await page.goto('/');
    await page
      .getByRole('article')
      .filter({ hasText: title })
      .getByRole('button', { name: 'Antworten' })
      .click();
    await expect(
      page.getByRole('cell', { name: 'Organisation: Gut' }),
    ).toBeVisible();
    await expect(
      page.getByRole('cell', { name: 'Organisation: Sehr gut, Gut' }),
    ).toBeVisible();
  });
});

test.describe('Tabelle mit dem Finger ausfüllen', () => {
  test('all four Zelltypen, and the page does not scroll sideways', async ({
    page,
    browser,
  }) => {
    const title = await newForm(page, 'Tabelle Finger');
    await addQuestion(page, 'Tabelle', 'Tabelle Finger');
    // `addQuestion` closed the sheet after naming the question.
    await page.getByRole('button', { name: 'Eigenschaften' }).click();

    const columns = propsGroup(page, 'Spalten');
    await columns
      .locator('.props__table-column')
      .nth(0)
      .getByLabel('Spalte 1', { exact: true })
      .fill('Text');
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
    await page.getByRole('button', { name: 'Schließen' }).click();

    await saveForm(page);
    const publicPath = await publishAndReadPath(page);

    const guestContext = await browser.newContext({
      viewport: { width: 360, height: 740 },
      hasTouch: true,
    });
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);
      await expectNoHorizontalScroll(guest, 'Tabelle-Formular (360 px)');

      // The grid's own container scrolls sideways to reach later columns —
      // exactly the „eigener Container" claim; the cells stay reachable by
      // touch through it.
      await guest.getByLabel('Text, Zeile 1').tap();
      await guest.getByLabel('Text, Zeile 1').fill('Hallo Welt');
      await guest.getByLabel('Zahl, Zeile 1').tap();
      await guest.getByLabel('Zahl, Zeile 1').fill('42');
      await guest
        .getByLabel('Liste, Zeile 1')
        .selectOption({ label: 'Option 2' });
      await guest.getByLabel('Haken, Zeile 1').tap();

      await guest.getByRole('button', { name: 'Absenden' }).tap();
      await expect(
        guest.getByRole('heading', { level: 1, name: 'Vielen Dank!' }),
      ).toBeVisible();
    } finally {
      await guestContext.close();
    }

    await page.goto('/');
    await page
      .getByRole('article')
      .filter({ hasText: title })
      .getByRole('button', { name: 'Antworten' })
      .click();
    await expect(
      page.getByRole('cell', {
        name: 'Text: Hallo Welt, Zahl: 42, Liste: Option 2, Haken: Ja',
      }),
    ).toBeVisible();
  });
});

/* --- The Veranstaltung with the finger, at 360 px ------------- */

test.describe('Veranstaltung mobil', () => {
  /**
   * The Kachel is a **wrapping** row, not a scrolling one: name, badge and
   * number box drop under each other at 360 px rather than taking the page with
   * them. That is the claim `expectNoHorizontalScroll` measures — and it is
   * measured on both surfaces, because the tile exists twice (the editor's
   * preview card and the participant's field).
   *
   * The editor half is the reason this is not only a fill-in case: the
   * properties sheet holds seven controls per Veranstaltung in a 300-px panel,
   * which is exactly the shape that ran 18 px over the viewport.
   */
  test('the tile wraps instead of widening the page — editor and participant', async ({
    page,
    browser,
  }) => {
    await newForm(page, 'Veranstaltung Mobil');
    await addQuestion(page, 'Veranstaltung', 'Veranstaltungen');

    await page.getByRole('button', { name: 'Eigenschaften' }).click();
    await page
      .getByLabel('Veranstaltung 1', { exact: true })
      .fill('Galaabend mit langem Namen');
    await page.getByLabel('Veranstaltung 1: Termin').fill('Fr, 19:00 Uhr');
    await page.getByLabel('Veranstaltung 1: Obergrenze').fill('120');
    await page.getByLabel('Veranstaltung 1: Restplätze anzeigen').tap();
    await expectNoHorizontalScroll(page, 'Veranstaltungs-Panel (360 px)');
    await page.getByRole('button', { name: 'Schließen' }).click();

    await expectNoHorizontalScroll(page, 'Builder mit Veranstaltung, 360 px');

    await saveForm(page);
    const publicPath = await publishAndReadPath(page);

    const guestContext = await browser.newContext({
      viewport: { width: 360, height: 740 },
      hasTouch: true,
    });
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);
      await expectNoHorizontalScroll(guest, 'Veranstaltungs-Formular (360 px)');

      // The badge is readable next to the name at this width, and the box
      // takes a Personenzahl from a finger like any other number field.
      await expect(guest.getByText('120 frei')).toBeVisible();
      const box = guest.getByLabel(
        'Galaabend mit langem Namen: Anzahl Personen',
      );
      await box.tap();
      await box.fill('3');

      await guest.getByRole('button', { name: 'Absenden' }).tap();
      await expect(
        guest.getByRole('heading', { level: 1, name: 'Vielen Dank!' }),
      ).toBeVisible();
    } finally {
      await guestContext.close();
    }
  });
});
