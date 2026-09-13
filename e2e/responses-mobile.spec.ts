import { expect, test } from '@playwright/test';

import {
  addQuestion,
  expectNoHorizontalScroll,
  expectSideScrollerReachable,
  newForm,
  publishAndReadPath,
  saveForm,
} from './app-flows';
import { authStateFile } from './seed-account';

/**
 * Responses table at 360 px — the mobile half of the requirement
 * that was named as a gap: „**the responses table
 * and the mail log have no 360 px assurance** — both clip
 * (`overflow: auto`), and their specs do not call the helper."
 *
 * ## The finding that came out of catching up
 *
 * The helper alone would **not** have closed the gap.
 * `expectNoHorizontalScroll` measures the root, `<main>` and every box that
 * *clips* — boxes with `overflow: auto`/`scroll` it excludes explicitly (see the
 * comment at its third measurement: „a side scroller hands its content
 * out"). `.responses__table-card` is exactly such a box, in **both** axes
 * even, because the head carries `position: sticky` (`responses-view.css`). For
 * the table itself the helper therefore cannot turn red: „the page does not
 * scroll" would be green even if the last column were cut off and
 * unreachable.
 *
 * It stays here and measures the **frame**: heading, „Zum Builder", the
 * export menu, the toolbar with search and column selection — everything outside
 * the scrolling box, and all of them things that have to wrap at 360 px
 * instead of sticking out. What it cannot do is said by {@link expectSideScrollerReachable}.
 *
 * ## And a real layout fault fell out of it
 *
 * On the first run the **first** measurement was red: `documentElement.scrollWidth`
 * 1367 px against a 360 px viewport, `window.scrollX` reached 1007 — the whole
 * page could be pushed sideways, although the card scrolled correctly within
 * itself and `<main>` clipped in addition. The cause was the
 * screen-reader label „Ansehen" in the opener button: `.visually-hidden` is
 * `position: absolute`, and without a positioned ancestor its containing
 * block was the viewport — a box that no `overflow` of the card trims and
 * that stretches the scroll area of the document up to its position.
 * Repaired with one line in `responses-view.css` (`.responses__open {
 * position: relative }`), justified and recomputed there.
 *
 * That is exactly the gap that was named before: the
 * assurance was missing — it was not that the application was sound.
 *
 * ## Why this case builds a real form
 *
 * Because otherwise the measurement measures nothing. „The right end is
 * reachable" is an assurance only if there is a right end outside the picture —
 * and how wide the responses table is, is decided by the form. Five questions
 * with spelled-out labels plus the timestamp column and the opener column
 * are certainly too wide at 360 px; three might be. That is the same
 * reason for which `question-types-mobile.spec.ts` gives its table four columns
 * instead of the preset two.
 *
 * **Residue:** one form, one version and one response per run — the
 * ordinary `newForm` kind that `core-flow`, `mail-log` and `question-types`
 * leave behind as well. The trash of this Organisation does not belong to this run
 * alone (`trash-purge.spec.ts` explains why its „leeren" is intercepted),
 * so this case clears nothing away for good.
 */

test.use({ storageState: authStateFile });

/** Spelled out, because the column width is the measured quantity here. */
const QUESTIONS: readonly string[] = [
  'Name des Mitglieds',
  'E-Mail-Adresse für Rückfragen',
  'Organisation und Ort der Zugehörigkeit',
  'Anreise und voraussichtliche Ankunft',
  'Anmerkungen zur Unterbringung',
];

test.describe('Antworten-Tabelle (360 px)', () => {
  test('passt bei 360 px, und die Tabelle reicht ihre letzte Spalte heraus statt sie abzuschneiden', async ({
    page,
    browser,
  }) => {
    const title = await newForm(page, 'Antworten mobil');
    for (const caption of QUESTIONS) {
      await addQuestion(page, 'Text', caption);
    }
    await saveForm(page);
    const publicPath = await publishAndReadPath(page);

    // --- one response, without a session and at the same width -----------
    const guestContext = await browser.newContext({
      viewport: { width: 360, height: 740 },
      hasTouch: true,
    });
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);
      await expect(
        guest.getByRole('heading', { level: 1, name: title }),
      ).toBeVisible();
      for (const caption of QUESTIONS) {
        // Long values, for the same reason as the long labels: the
        // width of the table is the test bench here and not chance.
        await guest
          .getByLabel(new RegExp(caption, 'u'))
          .fill(`Angabe zu „${caption}" — ausgeschrieben, wie eine echte`);
      }
      await guest.getByRole('button', { name: 'Absenden' }).tap();
      await expect(
        guest.getByRole('heading', { level: 1, name: 'Vielen Dank!' }),
      ).toBeVisible();
    } finally {
      await guestContext.close();
    }

    // --- and now the evaluation, at 360 px --------------------------------
    await page.goto('/');
    await page
      .getByRole('article')
      .filter({ hasText: title })
      .getByRole('button', { name: 'Antworten' })
      .click();
    await expect(
      page.getByRole('heading', { level: 1, name: `Antworten · ${title}` }),
    ).toBeVisible();
    // The row is there — without it the table has no width and the measurement
    // below has no subject.
    await expect(page.getByRole('row')).not.toHaveCount(1);

    await expectNoHorizontalScroll(page, 'Antworten-Tabelle (360 px, geladen)');

    /*
     * The last column is the **opener column** — the `<th>` without a visible
     * label, whose accessible name is „Einzelne Antwort"
     * (`ResponsesTable.tsx`). It is the right check point: behind it sits
     * the chevron with which a single response is opened, and if the
     * box cuts off instead of scrolling, exactly this control is
     * unreachable at 360 px.
     */
    await expectSideScrollerReachable(
      page,
      page.locator('.responses__table-card'),
      page.getByRole('columnheader', { name: 'Einzelne Antwort' }),
      'Antworten-Tabelle (360 px)',
    );

    /*
     * …and the control behind it really does work. Reachable here does not
     * mean „in the picture", but „clickable": the detail view is what
     * the column is there for.
     */
    await page.getByRole('row').last().click();
    await expect(
      page.getByRole('heading', { name: 'Antwort', level: 2 }),
    ).toBeVisible();
    await expectNoHorizontalScroll(
      page,
      'Antworten-Tabelle (360 px, Detailansicht offen)',
    );
  });
});
