import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  addQuestion,
  confirmPublishNotice,
  expectNoHorizontalScroll,
  newForm,
  saveForm,
} from './app-flows';
import { authStateFile } from './seed-account';

/**
 * **Reordering and docking questions by drag, in a real browser** — the half
 * the component tests cannot reach.
 *
 * `builder-store.test.ts` proves the *rules* of reordering and docking, and it
 * does so in milliseconds. What only a browser can show is that a **gesture**
 * reaches those rules: that a pointer pressed on the grip and dragged onto the
 * left third of another card ends with two half-width cards, with the mouse
 * and with a finger alike.
 *
 * Each test builds its own form, because the suite runs in parallel and a
 * shared one would make one test's reorder another test's flake.
 */

test.use({ storageState: authStateFile });

/**
 * The browser members the `evaluate` callbacks below use.
 *
 * The `e2e` project deliberately has no DOM lib (`app-flows.ts` explains why:
 * pulling `lib.dom` in would put the browser's `fetch` and `URL` next to
 * Node's for every file here). Declaring only what is used keeps the blast
 * radius at this module; at run time the callbacks execute in the real page.
 */
interface MeasuredElement {
  readonly clientWidth: number;
}
declare function getComputedStyle(element: object): {
  readonly touchAction: string;
};

/** The question cards, in document order. */
function cards(page: Page): Locator {
  return page.locator('[data-question-id]');
}

/** The type pill of each card — what the order is read from. */
async function typeOrder(page: Page): Promise<string[]> {
  return cards(page).locator('.q-card__type').allTextContents();
}

/**
 * Vertical aim of a drag, as a fraction of the target card's height.
 *
 * The height is not decoration, it selects the behaviour. A drop above the
 * target's middle lands before it, below it after it, and only *level* with
 * the middle does a side third dock two cards to half width — docking is a
 * sideways gesture, and without that band a drag straight down the grip column
 * (23 px from the left edge, four percent of a card) would dock every time.
 *
 * `0.15` and `0.85` rather than the quarters: a quarter sits exactly on the
 * edge of the docking band, and half-pixel card heights would decide which
 * side of it a run lands on.
 */
const ABOVE_BAND = 0.15;
const BELOW_BAND = 0.85;
const LEVEL_WITH_MIDDLE = 0.5;

/**
 * Drags a card's grip onto a fraction of another card's width, with the mouse.
 *
 * The intermediate move is not decoration: a single jump from press to release
 * produces one `pointermove`, and the drop target is computed from moves. Two
 * moves are what a real drag looks like to the handler.
 */
async function mouseDragOnto(
  page: Page,
  fromIndex: number,
  toIndex: number,
  fraction: number,
  verticalFraction: number = ABOVE_BAND,
): Promise<void> {
  const grip = cards(page)
    .nth(fromIndex)
    .getByRole('button', { name: /verschieben/u });
  const target = cards(page).nth(toIndex);

  const start = await grip.boundingBox();
  const box = await target.boundingBox();
  expect(
    start,
    'the grip has to be laid out before it can be dragged',
  ).not.toBeNull();
  expect(box).not.toBeNull();
  if (start === null || box === null) {
    return;
  }

  const x = box.x + box.width * fraction;
  const y = box.y + box.height * verticalFraction;

  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 8 });
  await page.mouse.move(x, y);
  await page.mouse.up();
}

/**
 * The same gesture with a **finger**.
 *
 * Playwright's `touchscreen` can only tap, so the events come from the
 * Chrome DevTools Protocol — which is what makes them real touch input rather
 * than JavaScript-dispatched objects. That distinction is the whole point of
 * the requirement: HTML5 drag-and-drop would pass a synthetic test and fail on a
 * phone, and so would a hand-written drag that never sees `pointerType:
 * 'touch'` or a browser that claims the gesture for scrolling.
 */
async function touchDragOnto(
  page: Page,
  fromIndex: number,
  toIndex: number,
  fraction: number,
  verticalFraction: number = ABOVE_BAND,
): Promise<void> {
  await touchDragGrip(
    page,
    cards(page)
      .nth(fromIndex)
      .getByRole('button', { name: /verschieben/u }),
    cards(page).nth(toIndex),
    fraction,
    verticalFraction,
  );
}

/**
 * The gesture itself, for **any** grip onto any target box.
 *
 * Split out of {@link touchDragOnto} when the page list got its own touch
 * case: the two lists differ in what they drag and in nothing
 * else, and a second copy of the CDP sequence would be the place where one of
 * them quietly stops sending `touchMove` twice.
 */
async function touchDragGrip(
  page: Page,
  grip: Locator,
  target: Locator,
  fraction: number,
  verticalFraction: number,
): Promise<void> {
  const start = await grip.boundingBox();
  const box = await target.boundingBox();
  if (start === null || box === null) {
    throw new Error('[e2e] the cards were not laid out');
  }

  const from = { x: start.x + start.width / 2, y: start.y + start.height / 2 };
  const to = {
    x: box.x + box.width * fraction,
    y: box.y + box.height * verticalFraction,
  };

  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: from.x, y: from.y }],
    });
    // Two moves, for the same reason the mouse drag makes two.
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }],
    });
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: to.x, y: to.y }],
    });
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
  } finally {
    await session.detach();
  }
}

/** Saves and reloads — the only way to tell a document change from a DOM one. */
async function saveAndReload(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(page.getByText('Gespeichert', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Formularname')).toBeVisible();
}

test.describe('builder drag and drop ', () => {
  test('reorders with the mouse, and the order survives a reload', async ({
    page,
  }) => {
    await newForm(page, 'Maus-Umsortierung');
    await addQuestion(page, 'Text');
    await addQuestion(page, 'Zahl');
    expect(await typeOrder(page)).toStrictEqual(['Text', 'Zahl']);

    // Middle of the first card: reorder, no docking.
    await mouseDragOnto(page, 1, 0, 0.5);
    expect(await typeOrder(page)).toStrictEqual(['Zahl', 'Text']);

    // The assertion that matters: the *document* changed, not the DOM. A
    // sortable that only rearranges nodes looks identical until a reload.
    await saveAndReload(page);
    expect(await typeOrder(page)).toStrictEqual(['Zahl', 'Text']);
  });

  /**
   * The direction the bug report was about: „geht nur nach oben".
   *
   * Every other drag in this file goes from card 1 to card 0, which is exactly
   * the direction that always worked — the broken one had no browser test at
   * all. This one drags the *first* card down onto the lower part of the
   * second, along the grip's own x, which is how a person does it.
   */
  test('reorders downwards, along the grip column', async ({ page }) => {
    await newForm(page, 'Maus-Abwaerts');
    await addQuestion(page, 'Text');
    await addQuestion(page, 'Zahl');
    expect(await typeOrder(page)).toStrictEqual(['Text', 'Zahl']);

    // The grip sits at four percent of the card's width; a straight-down drag
    // never leaves that column, and must not be read as "dock to the left".
    await mouseDragOnto(page, 0, 1, 0.04, BELOW_BAND);

    expect(await typeOrder(page)).toStrictEqual(['Zahl', 'Text']);
    await expect(cards(page).nth(0)).toHaveClass(/q-card--full/u);
    await expect(cards(page).nth(1)).toHaveClass(/q-card--full/u);

    await saveAndReload(page);
    expect(await typeOrder(page)).toStrictEqual(['Zahl', 'Text']);
  });

  test('reorders downwards with a finger too', async ({ page }) => {
    await newForm(page, 'Touch-Abwaerts');
    await addQuestion(page, 'Text');
    await addQuestion(page, 'Zahl');

    await touchDragOnto(page, 0, 1, 0.04, BELOW_BAND);

    expect(await typeOrder(page)).toStrictEqual(['Zahl', 'Text']);
    await expect(cards(page).nth(0)).toHaveClass(/q-card--full/u);
  });

  test('docks two cards to half width on a side drop', async ({ page }) => {
    await newForm(page, 'Andocken');
    await addQuestion(page, 'Text');
    await addQuestion(page, 'Zahl');

    // Left tenth of the first card, level with its middle — a sideways aim,
    // which is the only thing that docks.
    await mouseDragOnto(page, 1, 0, 0.1, LEVEL_WITH_MIDDLE);

    await expect(cards(page).nth(0)).toHaveClass(/q-card--half/u);
    await expect(cards(page).nth(1)).toHaveClass(/q-card--half/u);
    expect(await typeOrder(page)).toStrictEqual(['Zahl', 'Text']);

    await saveAndReload(page);
    await expect(cards(page).nth(0)).toHaveClass(/q-card--half/u);
    await expect(cards(page).nth(1)).toHaveClass(/q-card--half/u);
  });

  test('keeps full-width cards full on a middle drop', async ({ page }) => {
    await newForm(page, 'Nur umsortieren');
    await addQuestion(page, 'Text');
    await addQuestion(page, 'Zahl');

    await mouseDragOnto(page, 1, 0, 0.5);

    await expect(cards(page).nth(0)).toHaveClass(/q-card--full/u);
    await expect(cards(page).nth(1)).toHaveClass(/q-card--full/u);
  });

  /**
   * The way **out** of a docked row, reported as „bei zwei Feldern die
   * nebeneinander sind, kommt man nicht mehr zurück zu beide volle Breite".
   *
   * A middle drop no longer only *leaves* widths alone — it is the reverse
   * gesture: the dragged card asked for a place of its own, so it becomes full
   * width again, and the partner it leaves behind cannot stay half on its own.
   * This is why the test above was renamed: it only ever proved that two
   * already-full cards stayed full.
   */
  test('gives both cards their full width back when one is dragged out', async ({
    page,
  }) => {
    await newForm(page, 'Andocken rueckgaengig');
    await addQuestion(page, 'Text');
    await addQuestion(page, 'Zahl');
    await addQuestion(page, 'Datum');

    // Dock the first two — the dragged card lands on the left, so the order
    // is „Zahl | Text", Datum below — then pull the right one of the pair down
    // past Datum.
    await mouseDragOnto(page, 1, 0, 0.1, LEVEL_WITH_MIDDLE);
    await expect(cards(page).nth(0)).toHaveClass(/q-card--half/u);
    await expect(cards(page).nth(1)).toHaveClass(/q-card--half/u);

    await mouseDragOnto(page, 1, 2, 0.5, BELOW_BAND);

    expect(await typeOrder(page)).toStrictEqual(['Zahl', 'Datum', 'Text']);
    await expect(cards(page).nth(0)).toHaveClass(/q-card--full/u);
    await expect(cards(page).nth(1)).toHaveClass(/q-card--full/u);
    await expect(cards(page).nth(2)).toHaveClass(/q-card--full/u);

    // And it is the *document* that changed, not just the class list.
    await saveAndReload(page);
    await expect(cards(page).nth(0)).toHaveClass(/q-card--full/u);
    await expect(cards(page).nth(2)).toHaveClass(/q-card--full/u);
  });

  test('gives the full width back with a finger too', async ({ page }) => {
    await newForm(page, 'Touch-Andocken rueckgaengig');
    await addQuestion(page, 'Text');
    await addQuestion(page, 'Zahl');
    await addQuestion(page, 'Datum');

    await touchDragOnto(page, 1, 0, 0.1, LEVEL_WITH_MIDDLE);
    await expect(cards(page).nth(0)).toHaveClass(/q-card--half/u);

    await touchDragOnto(page, 1, 2, 0.5, BELOW_BAND);

    await expect(cards(page).nth(0)).toHaveClass(/q-card--full/u);
    await expect(cards(page).nth(1)).toHaveClass(/q-card--full/u);
    await expect(cards(page).nth(2)).toHaveClass(/q-card--full/u);
  });

  test('reorders with a finger exactly as with the mouse', async ({ page }) => {
    await newForm(page, 'Touch-Umsortierung');
    await addQuestion(page, 'Text');
    await addQuestion(page, 'Zahl');

    await touchDragOnto(page, 1, 0, 0.5);

    expect(await typeOrder(page)).toStrictEqual(['Zahl', 'Text']);
    await saveAndReload(page);
    expect(await typeOrder(page)).toStrictEqual(['Zahl', 'Text']);
  });

  test('docks with a finger too', async ({ page }) => {
    await newForm(page, 'Touch-Andocken');
    await addQuestion(page, 'Text');
    await addQuestion(page, 'Zahl');

    await touchDragOnto(page, 1, 0, 0.1, LEVEL_WITH_MIDDLE);

    await expect(cards(page).nth(0)).toHaveClass(/q-card--half/u);
    await expect(cards(page).nth(1)).toHaveClass(/q-card--half/u);
  });

  /**
   * The mechanical half of the requirement: no HTML5 drag-and-drop anywhere, and
   * no ▲/▼ buttons (decision the specification no. 9). Asserted against the rendered page so
   * it also covers markup a component test might not render.
   */
  test('uses no HTML5 drag-and-drop and offers no ▲/▼ buttons', async ({
    page,
  }) => {
    await newForm(page, 'Keine Alt-Technik');
    await addQuestion(page, 'Text');

    expect(await page.locator('[draggable="true"]').count()).toBe(0);
    for (const glyph of ['▲', '▼']) {
      expect(
        await page.getByRole('button', { name: glyph }).count(),
        `no ${glyph} button may exist — the grip is the only way to reorder`,
      ).toBe(0);
    }
    // The grip must not claim the gesture back to the browser's scroller.
    const touchAction: string = await page
      .getByRole('button', { name: /verschieben/u })
      .first()
      .evaluate((element: object) => getComputedStyle(element).touchAction);
    expect(touchAction).toBe('none');
  });
});

/**
 * The page list, reported as „Seitenwechsel funktioniert nur durch den Klick
 * auf den Seitentitel, dadurch wechselt das Feld aber immer gleich in den
 * Editiermodus".
 *
 * This belongs in a browser and nowhere else: the row switches pages through
 * an overlay (`.page-row__select::after`) that covers the whole row, and both
 * the hit area over the empty space and the layering against grip and delete
 * button are pure layout. jsdom has none, so a component test can only click
 * the elements it already knows about — exactly the parts that were never
 * broken.
 */
test.describe('the page list of the builder ', () => {
  /** The page being edited, read from the canvas heading's label. */
  function pageTitleField(page: Page, number: number): Locator {
    return page.getByLabel(`Titel von Seite ${String(number)}`);
  }

  test('switches pages on a click beside the title, without renaming', async ({
    page,
  }) => {
    await newForm(page, 'Seitenwechsel');
    await page.getByRole('button', { name: '+ Seite hinzufügen' }).click();
    // Adding a page lands on it — so page 1 is the one to switch back to.
    await expect(pageTitleField(page, 2)).toBeVisible();

    const firstRow = page.locator('[data-page-index="0"]');
    const box = await firstRow.boundingBox();
    expect(box, 'the page rows have to be laid out').not.toBeNull();
    if (box === null) {
      return;
    }
    // Empty space between the title and the × — no control of its own sits
    // here, and before the overlay nothing here reacted at all.
    await firstRow.click({
      position: { x: box.width - 56, y: box.height / 2 },
    });

    await expect(pageTitleField(page, 1)).toBeVisible();
    // …and the click started no rename: the list holds no field at all.
    expect(await page.locator('.page-list__rows input').count()).toBe(0);

    // The delete button keeps its own effect through the same overlay: it
    // deletes, and it does not switch to the row it was pressed on.
    await page.getByRole('button', { name: 'Seite 2 löschen' }).click();
    await expect(page.locator('[data-page-index]')).toHaveCount(1);
    await expect(pageTitleField(page, 1)).toBeVisible();
  });

  test('renames the page from the canvas heading', async ({ page }) => {
    await newForm(page, 'Umbenennen');

    await pageTitleField(page, 1).fill('Stammdaten');
    await saveAndReload(page);

    await expect(pageTitleField(page, 1)).toHaveValue('Stammdaten');
    // The list shows the new name, and still switches rather than edits.
    await expect(
      page.getByRole('button', { name: /Stammdaten, Seite 1 von 1/u }),
    ).toBeVisible();
  });
});

test.describe('the form name in the toolbar', () => {
  /**
   * The complaint this heading was rebuilt for was that it looked like a
   * "verirrtes Formularfeld" — a very wide box next to the buttons. What makes
   * it read as a heading instead is that it is only as wide as its text, so
   * the hover/focus underline stops where the name does.
   *
   * That is a *layout* claim: jsdom has none, so a component test can assert
   * the mechanism (a mirror of the value) and still be green while the box
   * stays at the input's ~20-character default. Only a browser can say whether
   * the field actually fits its text, which is why the assertion lives here.
   */
  test('is exactly as wide as the name it holds', async ({ page }) => {
    await newForm(page, 'Breite');

    const field = page.getByLabel('Formularname');
    const widthFor = async (name: string): Promise<number> => {
      await field.fill(name);
      const box = await field.boundingBox();
      return box?.width ?? 0;
    };

    // The same glyph, ten and twenty times: if the box follows the text,
    // twice the text is twice the width, give or take the few pixels of caret
    // room the sizer adds. No font metrics needed — the *proportion* is the
    // claim, and it is one no font substitution can fake.
    const ten = await widthFor('M'.repeat(10));
    const twenty = await widthFor('M'.repeat(20));

    expect(twenty / ten).toBeGreaterThan(1.8);
    expect(twenty / ten).toBeLessThan(2.2);

    // The regression this guards: without `size={1}` the input keeps its own
    // ~20-character default width, so both of the above measure the same box
    // and the ratio collapses towards 1 — which is what made the title look
    // like a stray form field filling half the bar.
  });
});

test.describe('publishing ', () => {
  test('switches the form to active and shows its public address', async ({
    page,
  }) => {
    const title = await newForm(page, 'Veröffentlichung');
    await addQuestion(page, 'Text');
    await page.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(page.getByText('Gespeichert', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Veröffentlichen' }).click();

    await expect(page.getByText(/Veröffentlicht \(Fassung 1\)/u)).toBeVisible();
    // A real anchor, not a button: this address is copied into an e-mail to a
    // whole organisation, so „Linkadresse kopieren" has to work on it (ADR-0010).
    // Absolute, not site-relative: a path is worthless once it leaves the app.
    const address = page.getByRole('link', { name: /\/f\//u });
    await expect(address).toHaveAttribute('href', /^https?:\/\/.+\/f\/.+/u);
    await expect(
      page.getByRole('button', { name: 'Erneut veröffentlichen' }),
    ).toBeVisible();

    // And the dashboard says so too — the status badge of the handoff.
    await page.goto('/');
    const card = page.locator('.form-card').filter({ hasText: title });
    await expect(card).toHaveCount(1);
    await expect(card.getByText('Aktiv')).toBeVisible();
  });

  test('refuses to publish a draft that is not saved', async ({ page }) => {
    await newForm(page, 'Ungespeichert');
    await addQuestion(page, 'Text');

    // Publishing now would publish the *stored* document, not this one.
    await expect(
      page.getByRole('button', { name: 'Veröffentlichen' }),
    ).toBeDisabled();
  });

  /**
   * „Knopf sperren + Erfolgsmeldung" (the specification no. 29), through the
   * whole stack.
   *
   * Two reports, one flow, and they only make sense together: the rising
   * version number was the sole sign that publishing had happened, so removing
   * the pointless increments without a message would have left the most
   * consequential control in the builder silent.
   *
   * The label change in the middle is the load-bearing part. `publishDiff` —
   * the comparison this rule could plausibly have been built on — reports
   * nothing for a reworded question, so a gate built on it would leave this
   * form stuck at version 1 with a locked button.
   */
  test('says which Fassung it published and locks the button until something changes', async ({
    page,
  }) => {
    await newForm(page, 'Fassungen');
    await addQuestion(page, 'Text', 'Name');
    await saveForm(page);

    await page.getByRole('button', { name: 'Veröffentlichen' }).click();

    // The success the second report asked for — visible, and naming the number.
    await expect(page.getByText('Fassung 1 veröffentlicht')).toBeVisible();

    // …and immediately afterwards the button says why it is unavailable,
    // instead of standing ready to mint an identical version 2.
    const republish = page.getByRole('button', {
      name: 'Erneut veröffentlichen',
    });
    await expect(republish).toBeDisabled();

    /*
      Not „Fassung 1 ist aktuell" here, and the reason is worth keeping: the
      state line is one element, and directly after a publish it carries the
      success message. „ist aktuell" is what it says on a form opened later,
      with nothing published in this session. Asserting both in a row asked one
      span to hold two mutually exclusive strings — the case could never have
      gone green, and it took an actual run to notice, because a spec that is
      only listed is a spec that has never been executed.
    */

    // A reworded label: a real change, and one the publish diff cannot see.
    await page.getByLabel('Fragetext').fill('Vor- und Zuname');

    // The other locked state, and it must not read like the first one: there
    // is something to publish, it merely has to be saved first.
    await expect(republish).toBeDisabled();
    await expect(
      page.getByText('Erst speichern, dann veröffentlichen'),
    ).toBeVisible();
    // And the success message is gone rather than describing a version the
    // draft has already moved past.
    await expect(page.getByText('Fassung 1 veröffentlicht')).toBeHidden();

    await saveForm(page);
    await expect(republish).toBeEnabled();

    await republish.click();
    /*
      **The notice dialogue stands in between, since ADR-0028.** It is not part
      of what this case measures (the version message and the lock after it) —
      but leaving it out would mean overlooking it: since 2026-08-18 a repeated
      publication goes through this confirmation as long as the organisation's
      legal texts are missing. The first publication above does not meet it;
      why, stands at `confirmPublishNotice`.
    */
    await confirmPublishNotice(page);
    await expect(page.getByText('Fassung 2 veröffentlicht')).toBeVisible();
    await expect(page.getByText(/Veröffentlicht \(Fassung 2\)/u)).toBeVisible();
    await expect(republish).toBeDisabled();
  });
});

test.describe('the builder on a small screen ', () => {
  test.use({ viewport: { width: 360, height: 740 }, hasTouch: true });

  test('offers pages and properties as sheets and does not scroll sideways', async ({
    page,
  }) => {
    await newForm(page, 'Mobil');

    // The three columns are gone; both panels are behind their own trigger.
    await expect(page.getByRole('button', { name: 'Seiten' })).toBeVisible();
    await page.getByRole('button', { name: 'Eigenschaften' }).click();
    await expect(
      page.getByRole('dialog', { name: 'Eigenschaften' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Schließen' }).click();

    await page.getByRole('button', { name: 'Seiten' }).click();
    const sheet = page.getByRole('dialog', { name: 'Seiten' });
    await expect(sheet).toBeVisible();
    await expect(
      sheet.getByRole('button', { name: '+ Seite hinzufügen' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Schließen' }).click();

    await expectNoHorizontalScroll(page, 'Builder auf 360 px');
  });

  /**
   * The requirement's mobile half: below the breakpoint every card is full width,
   * **and the document is untouched** — the width the editor chose comes back
   * on a wide screen. A layout rule, not a data change.
   */
  test('renders half-width cards full width without changing the document', async ({
    page,
  }) => {
    await newForm(page, 'Mobile Breite');
    await addQuestion(page, 'Text');
    await addQuestion(page, 'Zahl');

    // Set the width through the panel — the docking gesture needs the two
    // columns a small screen does not have, which is exactly why the property
    // exists as a control as well (see `QuestionProperties`).
    await cards(page).nth(1).click();
    await page.getByRole('button', { name: 'Eigenschaften' }).click();
    await page.getByLabel('Breite').selectOption('half');
    await page.getByRole('button', { name: 'Schließen' }).click();

    // Still `--half` in the class list; the CSS makes it full width.
    await expect(cards(page).nth(1)).toHaveClass(/q-card--half/u);
    const width: number = await cards(page)
      .nth(1)
      .evaluate((element: MeasuredElement) => element.clientWidth);
    const canvas: number = await page
      .locator('.canvas')
      .evaluate((element: MeasuredElement) => element.clientWidth);
    // Full width means "as wide as the canvas allows", not exactly equal —
    // padding is between the two.
    expect(width).toBeGreaterThan(canvas * 0.7);

    await expectNoHorizontalScroll(
      page,
      'Builder mit halber Breite auf 360 px',
    );
  });
});

/**
 * **The page list with a finger**  — at 360 px, in the sheet.
 *
 * The place is the statement. Below the breakpoint the page list is no longer
 * a column panel but the content of the sheet „Seiten" — and there dragging by
 * the grip is **the only** way to reorder: there are no ▲/▼ buttons anywhere
 * (the case below measures their absence), and the keyboard variant of the
 * grip presupposes a keyboard a phone does not have.
 *
 * What is measured is a **position**, not the gesture: the titles of the pages
 * in document order, before and after. A case that only claims „the gesture
 * ran through" would stay green while the list stands there unchanged — and
 * that is exactly what it would do if somebody introduced HTML5 DnD or
 * `touch-action` fell from `none` to `auto`: the browser would then take the
 * gesture for scrolling.
 *
 * The titles are the **default titles** („Seite 1", „Seite 2", „Seite 3") and
 * stay what they are when a row moves — the number in the badge is the
 * position, the title is data. After the drag „Seite 3" therefore stands in
 * first place, and that is no oddity of the test but exactly the difference a
 * reordering makes.
 */
test.describe('die Seitenliste mit dem Finger ', () => {
  test.use({ viewport: { width: 360, height: 740 }, hasTouch: true });

  /** The titles of the page rows, in document order. */
  async function pageTitles(page: Page): Promise<string[]> {
    return page.locator('.page-row__title').allTextContents();
  }

  test('zieht die dritte Seite mit dem Finger nach oben, und die Reihenfolge misst es', async ({
    page,
  }) => {
    await newForm(page, 'Seiten ziehen mobil');

    await page.getByRole('button', { name: 'Seiten' }).click();
    const sheet = page.getByRole('dialog', { name: 'Seiten' });
    await expect(sheet).toBeVisible();

    const add = sheet.getByRole('button', { name: '+ Seite hinzufügen' });
    await add.tap();
    await add.tap();
    await expect(page.locator('[data-page-index]')).toHaveCount(3);
    expect(await pageTitles(page)).toStrictEqual([
      'Seite 1',
      'Seite 2',
      'Seite 3',
    ]);

    /*
      The grip of the third row onto the **upper** half of the first: above the
      middle the dragged one lands in front of it, below it behind — the same
      rule as with the question cards, only without docking, because a page
      knows no half width. `0.5` horizontally: the row is narrow, and the
      middle is the point a thumb hits.
    */
    const rows = page.locator('[data-page-index]');
    await touchDragGrip(
      page,
      rows.nth(2).getByRole('button', { name: /verschieben/u }),
      rows.nth(0),
      0.5,
      ABOVE_BAND,
    );

    expect(
      await pageTitles(page),
      'Nach dem Ziehen muss „Seite 3" vorne stehen. Steht die alte Reihenfolge ' +
        'da, hat der Finger die Liste nicht bewegt — dann ist Umsortieren auf ' +
        'einem Telefon nicht möglich, denn ▲/▼ gibt es hier nicht.',
    ).toStrictEqual(['Seite 3', 'Seite 1', 'Seite 2']);

    // And it is a change to the document, not only to the display.
    await saveAndReload(page);
    await page.getByRole('button', { name: 'Seiten' }).click();
    await expect(page.getByRole('dialog', { name: 'Seiten' })).toBeVisible();
    expect(await pageTitles(page)).toStrictEqual([
      'Seite 3',
      'Seite 1',
      'Seite 2',
    ]);
  });

  test('die Seitenliste bietet keine ▲/▼-Knöpfe und gibt die Geste nicht ans Scrollen ab', async ({
    page,
  }) => {
    await newForm(page, 'Seiten ohne Pfeile');
    await page.getByRole('button', { name: 'Seiten' }).click();
    const sheet = page.getByRole('dialog', { name: 'Seiten' });
    await expect(sheet).toBeVisible();

    for (const glyph of ['▲', '▼']) {
      expect(
        await sheet.getByRole('button', { name: glyph }).count(),
        `kein ${glyph}-Knopf: der Griff ist der einzige Weg, die Seiten zu ` +
          'sortieren („Mobile Seitenliste ist reines Drag")',
      ).toBe(0);
    }
    expect(await sheet.locator('[draggable="true"]').count()).toBe(0);

    const touchAction: string = await sheet
      .getByRole('button', { name: /Seite 1 verschieben/u })
      .evaluate((element: object) => getComputedStyle(element).touchAction);
    expect(
      touchAction,
      '`touch-action: none` ist das, was den Browser die Geste **nicht** für ' +
        'das Scrollen beanspruchen lässt. Ohne diese Zeile scrollt die Seite, ' +
        'statt die Zeile zu ziehen.',
    ).toBe('none');
  });
});
