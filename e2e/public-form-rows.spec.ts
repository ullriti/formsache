import { expect, test, type Browser, type Page } from '@playwright/test';

import {
  addQuestion,
  expectNoHorizontalScroll,
  newForm,
  publishAndReadPath,
  saveForm,
} from './app-flows';
import { authStateFile } from './seed-account';

/**
 * **Halbe Breite beim Ausfüllen** (die Spezifikation).
 *
 * The unit tests prove the grouping (`packages/shared/src/question-rows.test.ts`)
 * and that the view asks for it (`PublicFormView.test.tsx`). Neither can prove
 * the part that only a browser has: that two half-width fields really do end
 * up on **one line** at desktop width, and really do **stack** on a phone
 * instead of pushing the card into a horizontal scrollbar. jsdom applies no
 * CSS, so without this spec the media query is a string nobody evaluates.
 *
 * The form is built once, signed in; both measurements happen in
 * **session-less** contexts of their own, whose viewport is therefore
 * independent of the project this spec runs in. Two tests rather than one, for
 * the reason `playwright.config.ts` gives for having viewport projects at all:
 * the report has to say which width proved what — and a failing desktop
 * assertion must not stop the phone from being measured.
 */

test.use({ storageState: authStateFile });

const FIRST_LABEL = 'Vorname';
const SECOND_LABEL = 'Nachname';

const GUEST_DESKTOP = { width: 1280, height: 800 } as const;
/** The narrowest width the handoff names, as in `shell-mobile.spec.ts`. */
const GUEST_MOBILE = { width: 360, height: 740 } as const;

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

async function boxOf(locator: {
  boundingBox: () => Promise<Box | null>;
}): Promise<Box> {
  const box = await locator.boundingBox();
  if (box === null) {
    throw new Error('[e2e] element has no box — it is not laid out');
  }
  return box;
}

/** Opens the public address without a session, at the given viewport. */
async function guestPage(
  browser: Browser,
  viewport: { width: number; height: number },
  path: string,
): Promise<Page> {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.goto(path);
  await expect(page.getByLabel(FIRST_LABEL)).toBeVisible();
  return page;
}

/**
 * The row the two fields sit in.
 *
 * Addressed by `data-testid`, against the rule of this suite — and the reason
 * is that a row is a pure layout box: it has no role and no accessible name
 * *on purpose*, because announcing a grouping that exists only for the eye
 * would be worse than announcing nothing. There is no user-visible handle, so
 * the explicit test hook is the honest way in.
 */
function rowBox(page: Page): Promise<Box> {
  return boxOf(page.getByTestId('public-row').first());
}

/** Whether two boxes share a line — their vertical spans overlap. */
function overlapVertically(one: Box, other: Box): boolean {
  return one.y < other.y + other.height && other.y < one.y + one.height;
}

test.describe('Öffentliches Formular: halbe Breite', () => {
  let publicPath = '';

  /**
   * One published form for both measurements, in a context of its own —
   * `beforeAll` has no `page` fixture, and building the same form twice would
   * leave twice the residue in the development database for no more evidence.
   */
  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({
      storageState: authStateFile,
      viewport: GUEST_DESKTOP,
    });
    const editor = await context.newPage();

    try {
      await newForm(editor, 'Halbe Breite');
      await addQuestion(editor, 'Text', FIRST_LABEL);
      await addQuestion(editor, 'Text', SECOND_LABEL);

      // Half width is a pair, so setting the second question docks the first
      // with it — the store's rule. What this spec measures is that the
      // published document comes back out as one row.
      await editor.getByLabel('Breite').selectOption('half');

      await saveForm(editor);
      publicPath = await publishAndReadPath(editor);
    } finally {
      await context.close();
    }
  });

  test('zeigt zwei halbe Fragen nebeneinander (1280 px)', async ({
    browser,
  }) => {
    const guest = await guestPage(browser, GUEST_DESKTOP, publicPath);

    try {
      const first = await boxOf(guest.getByLabel(FIRST_LABEL));
      const second = await boxOf(guest.getByLabel(SECOND_LABEL));

      // Overlapping vertical spans, not equal `y`: a label that wraps to two
      // lines pushes its input down without breaking the row, and an equality
      // check would fail on a layout that is perfectly correct.
      expect(overlapVertically(first, second)).toBe(true);
      expect(second.x).toBeGreaterThan(first.x);

      // Two equal columns, each roughly half the row — "side by side" with one
      // field twice the other would satisfy the coordinates above.
      const row = await rowBox(guest);
      expect(Math.abs(first.width - second.width)).toBeLessThanOrEqual(1);
      expect(first.width).toBeGreaterThan(row.width * 0.35);
      expect(first.width + second.width).toBeLessThan(row.width);

      await expectNoHorizontalScroll(guest, 'Öffentliches Formular (1280 px)');
    } finally {
      await guest.context().close();
    }
  });

  test('stellt sie mobil untereinander (360 px)', async ({ browser }) => {
    const guest = await guestPage(browser, GUEST_MOBILE, publicPath);

    try {
      const first = await boxOf(guest.getByLabel(FIRST_LABEL));
      const second = await boxOf(guest.getByLabel(SECOND_LABEL));

      // Stacked: separate lines, same column. Two inputs side by side on a
      // 360 px screen are unusable — and the document keeps its `half`, only
      // the presentation changes.
      expect(overlapVertically(first, second)).toBe(false);
      expect(second.y).toBeGreaterThan(first.y);
      expect(Math.abs(first.x - second.x)).toBeLessThanOrEqual(1);

      // …and each field takes the *whole* line it was given. Position alone
      // would not have caught this: a stacking rule that forgets the cross
      // axis leaves the fields in one column at the right coordinates and a
      // third of the width, which no assertion above can see.
      const row = await rowBox(guest);
      for (const field of [first, second]) {
        expect(field.width).toBeGreaterThan(row.width * 0.9);
      }

      await expectNoHorizontalScroll(guest, 'Öffentliches Formular (360 px)');
    } finally {
      await guest.context().close();
    }
  });
});
