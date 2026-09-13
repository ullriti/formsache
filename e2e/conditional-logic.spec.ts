import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  addQuestion,
  expectNoHorizontalScroll,
  newForm,
  saveForm,
} from './app-flows';
import { authStateFile } from './seed-account';

/**
 * *Bedingte Anzeige* in the browser — the requirement.
 *
 * `packages/shared/src/condition.test.ts` proves the evaluation,
 * `apps/api/test/public/conditional-logic.spec.ts` proves the server discards
 * a hidden answer, and
 * `ConditionEditor.test.tsx` proves the panel's rules in jsdom milliseconds.
 * None of them can show that a pointer switching the toggle, a select firing
 * `onChange` and a real publish request reach each other — or that the
 * canvas, the fill-in view and the responses table agree on what „sichtbar"
 * means once a stranger's browser is the one deciding it. That seam, and the
 * three states the frontend package named as ordinary mid-edit moves it
 * deliberately allows (an unfinished value, a deleted source, a reordered
 * one), is what this file measures.
 *
 * Every case builds its own form — the suite runs in parallel and a shared
 * one would make one test's toggle another test's flake.
 */

/**
 * Minimal DOM ambient types for the two `page.evaluate` callbacks below — the
 * `e2e` project deliberately has no DOM lib (`app-flows.ts` explains why:
 * pulling `lib.dom` in would put the browser's `document` next to Node's
 * globals for every file here). Only the handful of members the two
 * reproductions touch are declared; at run time they execute in the real
 * browser.
 */
interface MutableElement {
  id: string;
  readonly style: { cssText: string };
  remove: () => void;
  appendChild: (child: MutableElement) => void;
}
declare const document: {
  querySelector: (selector: string) => MutableElement | null;
  getElementById: (id: string) => MutableElement | null;
  createElement: (tag: string) => MutableElement;
};

test.use({ storageState: authStateFile });

/** The question cards, in document order — same locator `builder-drag.spec.ts` uses. */
function cards(page: Page): Locator {
  return page.locator('[data-question-id]');
}

function badgeOf(card: Locator): Locator {
  return card.getByTestId('question-condition-badge');
}

/**
 * Two questions — a source and a dependant — with *Bedingte Anzeige* switched
 * on for the second. Only one earlier, eligible question exists at that
 * point, so the toggle picks it as the source on its own (`firstSource` in
 * `QuestionProperties.tsx`) with the operator „ist ausgefüllt", which needs no
 * value — the minimal condition a case can build on before customising it
 * further.
 */
async function addConditionalPair(
  page: Page,
  sourceLabel: string,
  dependentLabel: string,
): Promise<void> {
  await addQuestion(page, 'Text', sourceLabel);
  await addQuestion(page, 'Text', dependentLabel);
  await page.getByRole('switch', { name: 'Bedingte Anzeige' }).click();
}

/**
 * Drags the grip of the card at `fromIndex` onto the lower half of the card
 * at `toIndex`, along the grip's own column — the same downward reorder
 * `builder-drag.spec.ts` drives, reproduced here rather than imported: that
 * module keeps its helpers file-local, and duplicating the one gesture this
 * file needs is cheaper than exporting a drag API two files would have to
 * agree on.
 */
async function dragBelow(
  page: Page,
  fromIndex: number,
  toIndex: number,
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

  // Four percent of the card's width — the grip column — and 85 % of its
  // height, well below the docking band, so this reorders and never docks.
  const x = box.x + box.width * 0.04;
  const y = box.y + box.height * 0.85;

  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 8 });
  await page.mouse.move(x, y);
  await page.mouse.up();
}

test.describe('Rundlauf: bauen → Kennzeichnung → veröffentlichen → ausfüllen → Antworten ', () => {
  const SOURCE_LABEL = 'Verpflegung';
  const DEPENDENT_LABEL = 'Sonderwunsch';
  const MATCH_VALUE = 'Vegetarisch';
  const OTHER_VALUE = 'Mit Fleisch';
  const HIDDEN_TEXT = 'Geheimwunsch, den niemand sehen darf';

  test('eine sichtbar gemachte Antwort verschwindet wieder mit der Bedingung, und die Tabelle zeigt sie nie', async ({
    page,
    browser,
  }) => {
    // --- building: source question, dependent question, condition ----------
    const title = await newForm(page, 'Bedingung Rundlauf');

    await addQuestion(page, 'Einfachauswahl', SOURCE_LABEL);
    await page.getByRole('textbox', { name: 'Option 1' }).fill(OTHER_VALUE);
    await page.getByRole('textbox', { name: 'Option 2' }).fill(MATCH_VALUE);
    await page.getByLabel('Pflichtfeld').check();

    await addQuestion(page, 'Text', DEPENDENT_LABEL);
    await page.getByRole('switch', { name: 'Bedingte Anzeige' }).click();
    // Choose source, operator and value expressly — not just leave the default
    // standing that the toggle already sets by itself.
    await page
      .getByRole('combobox', { name: 'Frage', exact: true })
      .selectOption({ label: SOURCE_LABEL });
    await page
      .getByRole('combobox', { name: 'Bedingung', exact: true })
      .selectOption({ label: 'ist gleich' });
    await page
      .getByRole('combobox', { name: 'Vergleichswert', exact: true })
      .selectOption({ label: MATCH_VALUE });

    // --- the card carries the marking ---------------------------------------
    const dependentCard = cards(page).filter({ hasText: DEPENDENT_LABEL });
    const badge = badgeOf(dependentCard);
    await expect(badge).toHaveText('Bedingt');
    await expect(badge).toHaveAttribute('role', 'note');
    // The accessible name names the source question — not just „Bedingt". The
    // comparison value itself is deliberately not part of this regex: a
    // choice question compares against the option's internal `value` (here
    // „option-2"), not against its label „Vegetarisch" — that is the
    // existing semantics of `valueOf()`/`OPERATOR_PHRASES` in
    // `condition-status.ts` and not a claim this test makes.
    await expect(badge).toHaveAccessibleName(
      new RegExp(`zeigt nur, wenn.*${SOURCE_LABEL}.*gleich`, 'u'),
    );

    // Reproduction: remove the marking → the case turns red. Without
    // touching source code outside e2e/ (see the report) this happens here
    // as a DOM intervention at run time — it shows that the assertion above would not
    // be vacuously green if the card never rendered the marking.
    await page.evaluate(() => {
      document
        .querySelector('[data-testid="question-condition-badge"]')
        ?.remove();
    });
    await expect(badge).toHaveCount(0);
    // No reload: nothing was saved yet at this point, and the questions built
    // above live only in the client store — a reload would discard them. The
    // DOM node stays removed (React does not reconcile a subtree nothing else
    // invalidates), which is harmless: nothing below reads the badge again.

    // --- publishing ----------------------------------------------------------
    await saveForm(page);
    await page.getByRole('button', { name: 'Veröffentlichen' }).click();
    await expect(page.getByText(/Veröffentlicht \(Fassung 1\)/u)).toBeVisible();
    const address = await page
      .getByRole('link', { name: /\/f\//u })
      .getAttribute('href');
    expect(address).toMatch(/^https?:\/\/[^/]+\/f\/[A-Za-z0-9_-]+$/u);
    const publicPath = new URL(address ?? '').pathname;

    // --- filling in publicly: appears, disappears again ---------------------
    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);
      await expect(
        guest.getByRole('heading', { name: title, level: 1 }),
      ).toBeVisible();

      // Not there before the source question is answered to match.
      await expect(guest.getByLabel(DEPENDENT_LABEL)).toHaveCount(0);

      await guest.getByLabel(MATCH_VALUE).check();
      const dependentField = guest.getByLabel(DEPENDENT_LABEL);
      await expect(dependentField).toBeVisible();
      await dependentField.fill(HIDDEN_TEXT);

      // Switched over — it disappears, taking the typed value with it.
      await guest.getByLabel(OTHER_VALUE).check();
      await expect(guest.getByLabel(DEPENDENT_LABEL)).toHaveCount(0);

      await guest.getByRole('button', { name: 'Absenden' }).click();
      await expect(
        guest.getByRole('heading', { level: 1, name: 'Vielen Dank!' }),
      ).toBeVisible();
    } finally {
      await guestContext.close();
    }

    // --- responses view: no value for a question never seen -----------------
    await page.goto('/');
    await page
      .getByRole('article')
      .filter({ hasText: title })
      .getByRole('button', { name: 'Antworten' })
      .click();
    await expect(page.getByText('1 Antwort')).toBeVisible();
    await expect(page.getByRole('cell', { name: OTHER_VALUE })).toBeVisible();
    // The text the participant only saw while the question was visible
    // appears nowhere in the table — neither as a value of its own nor
    // hidden in another column.
    await expect(page.getByText(HIDDEN_TEXT)).toHaveCount(0);
  });
});

test.describe('Drei kaputte Zustände, die nur der Browser zeigt ', () => {
  test('(a) Bedingung ohne Vergleichswert schreibt nichts — das Formular bleibt veröffentlichbar', async ({
    page,
  }) => {
    await addConditionalPairAndPublishSetup(page, 'Ankunftszeit', 'Zusatzinfo');

    // Switched over to a free-text source without typing a value: the editor
    // sees „ist gleich" with an empty field, the document keeps the last
    // valid condition (an earlier finding — the same trap as the
    // whitespace placeholder that `ConditionEditor.test.tsx` documents).
    await page
      .getByLabel('Bedingung', { exact: true })
      .selectOption({ label: 'ist gleich' });
    await expect(
      page.getByText(
        'Die Bedingung wird erst gespeichert, wenn hier ein Vergleichswert steht.',
      ),
    ).toBeVisible();
    await expect(
      page.getByLabel('Vergleichswert', { exact: true }),
    ).toHaveValue('');

    // Saving and publishing happen without objection, because the
    // document still carries only the complete „ist ausgefüllt" condition
    // — the half-typed „ist gleich" exists nowhere outside
    // these two fields.
    await saveForm(page);
    const publish = page.getByRole('button', { name: 'Veröffentlichen' });
    await expect(publish).toBeEnabled();

    // Reproduction: „bleibt veröffentlichbar" is no triviality — the
    // button is not permanently active. A real, unsaved change
    // does block it, in direct contrast to the „enabled"
    // just now — that shows that the check above was not green merely
    // because „Veröffentlichen" could never be disabled anyway.
    await page.getByLabel('Fragetext').fill('Ankunftszeit (bearbeitet)');
    await expect(publish).toBeDisabled();
    await saveForm(page);
    await expect(publish).toBeEnabled();

    await publish.click();
    await expect(page.getByText(/Veröffentlicht \(Fassung 1\)/u)).toBeVisible();
    // And the comparison-value box that was left empty got no
    // placeholder in the meantime — the panel's local draft stayed unchanged.
    await expect(
      page.getByLabel('Vergleichswert', { exact: true }),
    ).toHaveValue('');
  });

  test('(b) Quellfrage löschen: die Karte zeigt „Bedingt (Fehler)“, und das Panel nennt denselben Satz wie das spätere 422', async ({
    page,
  }) => {
    await newForm(page, 'Bedingung Quelle geloescht');
    await addConditionalPair(page, 'Quellfrage', 'Abhängige Frage');

    // Delete the source question (card 1) — an ordinary editing step the
    // builder expressly allows in mid-flow.
    await cards(page)
      .nth(0)
      .getByRole('button', { name: 'Frage 1 löschen' })
      .click();

    const dependentCard = cards(page).filter({ hasText: 'Abhängige Frage' });
    const badge = badgeOf(dependentCard);
    await expect(badge).toHaveText('Bedingt (Fehler)');
    await expect(badge).toHaveAttribute('role', 'note');

    // The panel of the dependent question is still open (it was selected,
    // not the deleted source) and names the reason as role="alert".
    const panelAlert = page.locator('.props').getByRole('alert');
    await expect(panelAlert).toBeVisible();
    const panelText = (await panelAlert.textContent())?.trim() ?? '';
    expect(panelText.length).toBeGreaterThan(0);

    await saveForm(page);

    // First publication of this form: no confirmation dialog, the
    // click triggers the POST directly — and that is refused with a 422.
    const publishResponded = page.waitForResponse(
      (response) =>
        /\/api\/forms\/[^/]+\/publish$/u.test(response.url()) &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Veröffentlichen' }).click();
    const publishResponse = await publishResponded;
    expect(publishResponse.status()).toBe(422);

    const publishAlert = page.locator('.builder__alert');
    await expect(publishAlert).toBeVisible();
    const publishText = (await publishAlert.textContent())?.trim() ?? '';

    // The same sentence — not just „auch eine Fehlermeldung", but exactly the one
    // `unresolvableConditionMessage` delivers to both sides (see
    // `condition-status.ts`'s documentation).
    expect(publishText).toBe(panelText);
    expect(publishText).toContain('Veröffentlichen nicht möglich');
  });

  test('(c) Quellfrage per Drag hinter die abhängige Frage: dieselbe Kennzeichnung', async ({
    page,
  }) => {
    await newForm(page, 'Bedingung Quelle verschoben');
    await addConditionalPair(page, 'Zuerst', 'Danach');

    // Before: a healthy condition.
    const dependentCardBefore = cards(page).filter({ hasText: 'Danach' });
    await expect(badgeOf(dependentCardBefore)).toHaveText('Bedingt');

    // Drag the source question (card 0) behind the dependent question (card 1)
    // — the same mouse gesture as `builder-drag.spec.ts`'s „downwards" case.
    await dragBelow(page, 0, 1);

    const cardTexts = await cards(page).allTextContents();
    expect(
      cardTexts.findIndex((text) => text.includes('Danach')),
      'die abhängige Frage muss jetzt vor der Quellfrage stehen',
    ).toBeLessThan(cardTexts.findIndex((text) => text.includes('Zuerst')));

    const dependentCardAfter = cards(page).filter({ hasText: 'Danach' });
    const badge = badgeOf(dependentCardAfter);
    await expect(badge).toHaveText('Bedingt (Fehler)');
    await expect(badge).toHaveAttribute('role', 'note');
    await expect(badge).toHaveAccessibleName(/steht erst nach dieser Frage/u);
  });
});

/**
 * Builds the pair for case (a) and leaves the dependent question's panel
 * open, condition already on with the default „ist ausgefüllt" — the state
 * every case in this describe block starts from before its own edit.
 */
async function addConditionalPairAndPublishSetup(
  page: Page,
  sourceLabel: string,
  dependentLabel: string,
): Promise<void> {
  await newForm(page, 'Bedingung ohne Wert');
  await addConditionalPair(page, sourceLabel, dependentLabel);
}

test.describe('Mobil bei 360 px ', () => {
  test.use({ viewport: { width: 360, height: 740 }, hasTouch: true });

  test('Eigenschaften-Sheet: Umschalter bedienen, kein horizontaler Überhang', async ({
    page,
  }) => {
    await newForm(page, 'Bedingung Mobil');
    await addQuestion(page, 'Text', 'Quelle');
    await addQuestion(page, 'Text', 'Abhängig');

    await page.getByRole('button', { name: 'Eigenschaften' }).click();
    const sheet = page.getByRole('dialog', { name: 'Eigenschaften' });
    await expect(sheet).toBeVisible();

    const toggle = sheet.getByRole('switch', { name: 'Bedingte Anzeige' });
    await toggle.click();
    await expect(toggle).toBeChecked();

    await expectNoHorizontalScroll(
      page,
      'Eigenschaften-Sheet mit Bedingte Anzeige, 360 px',
    );

    // Reproduction, without touching source code outside e2e/: an intentionally
    // over-wide element shows at run time that `expectNoHorizontalScroll`
    // really does turn a genuine overhang red instead of merely „keinen Fehler
    // zu werfen".
    await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.id = 'e2e-overflow-probe';
      probe.style.cssText = 'width:900px;height:1px;';
      document.querySelector('main')?.appendChild(probe);
    });
    let caught = false;
    try {
      await expectNoHorizontalScroll(
        page,
        'Absichtlich verbreitert (Nachstellung)',
      );
    } catch {
      caught = true;
    }
    expect(
      caught,
      'expectNoHorizontalScroll muss ein 900px-Element im DOM erkennen',
    ).toBe(true);
    await page.evaluate(() => {
      document.getElementById('e2e-overflow-probe')?.remove();
    });

    await page.getByRole('button', { name: 'Schließen' }).click();

    const badge = badgeOf(cards(page).filter({ hasText: 'Abhängig' }));
    await expect(badge).toHaveText('Bedingt');

    await expectNoHorizontalScroll(
      page,
      'Builder-Leinwand mit Kennzeichnung, 360 px',
    );
  });
});
