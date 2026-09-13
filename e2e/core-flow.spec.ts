import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import {
  addQuestion,
  expectNoHorizontalScroll,
  newForm,
  publishAndReadPath,
  saveForm,
} from './app-flows';
import { authStateFile } from './seed-account';

/**
 * The Kern-Flow, end to end:
 * **bauen → veröffentlichen → öffentlich ausfüllen → Antwort → Export.**
 *
 * Every step of this chain is already covered on its own — the store's rules
 * in `builder-store.test.ts`, the fill-in view in `PublicFormView.test.tsx`,
 * the CSV in `csv.test.ts`, the endpoints in `apps/api/test/`. What none of
 * them can show is that the pieces are **wired to each other**: that the slug
 * the builder prints is the one the public route serves, that the answer a
 * stranger typed arrives in the editor's table, and that the file the export
 * link produces contains it. Each of those seams has broken silently at least
 * once in this project's history, and each is invisible to a unit test.
 *
 * The fill-in half runs in a **second browser context with no session**, which
 * is the only way to prove "ohne Login" rather than assume it: a participant
 * who inherited the editor's cookie would fill the form in as the editor.
 */

test.use({ storageState: authStateFile });

/** Question labels, so the fill-in and the export assert against one source. */
const NAME_LABEL = 'Name des Mitglieds';
const MEAL_LABEL = 'Verpflegung';

/**
 * The „Sonstiges" free text, carried through the same chain.
 *
 * It has its own labels because it is the one answer that exists **only** as
 * something a participant typed: the two questions above are chosen from lists
 * the builder wrote, so a broken seam between builder, fill-in view and export
 * still shows something plausible. Here a lost value is an empty cell — which
 * is exactly what a manual test pass once found and what no unit test saw,
 * because every half of that chain worked on its own.
 *
 * On a **Mehrfachauswahl**, deliberately: that is the branch that carries the
 * free text along while ticks come and go, and the one the suite never reached.
 */
const TRAVEL_LABEL = 'Anreise';
const TRAVEL_OTHER_LABEL = 'Andere Anreise';
const TRAVEL_OTHER_VALUE = 'Fahrgemeinschaft mit Bbr. Bertram';

test.describe('Kern-Flow: bauen → veröffentlichen → ausfüllen → Export', () => {
  test('carries one answer from a stranger’s browser into the editor’s CSV', async ({
    page,
    browser,
  }) => {
    // --- bauen ------------------------------------------------------------
    const title = await newForm(page, 'Kern-Flow');

    await addQuestion(page, 'Text', NAME_LABEL);
    await page.getByLabel('Pflichtfeld').check();

    await addQuestion(page, 'Einfachauswahl', MEAL_LABEL);
    // By role: „Option 1" is also the accessible name of the remove button
    // next to the field, and a bare label lookup matches both.
    await page.getByRole('textbox', { name: 'Option 1' }).fill('Mit Fleisch');
    await page.getByRole('textbox', { name: 'Option 2' }).fill('Vegetarisch');

    await addQuestion(page, 'Mehrfachauswahl', TRAVEL_LABEL);
    await page.getByRole('textbox', { name: 'Option 1' }).fill('Bahn');
    await page.getByRole('textbox', { name: 'Option 2' }).fill('Auto');
    await page.getByRole('checkbox', { name: /Freitext anbieten/u }).check();
    await page
      .getByRole('textbox', { name: /Beschriftung für/u })
      .fill(TRAVEL_OTHER_LABEL);

    await saveForm(page);

    // --- veröffentlichen --------------------------------------------------
    // The address the editor is shown is the address that gets handed out; a
    // slug that only *looks* like one would fail the fill-in below with a 404
    // and nowhere else. `publishAndReadPath` asserts its shape.
    const publicPath = await publishAndReadPath(page);

    // --- öffentlich ausfüllen ---------------------------------------------
    // A fresh context: no cookies, no session, nothing inherited from the
    // editor. This is the requirement's actual claim.
    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();

    try {
      await guest.goto(publicPath);

      await expect(
        guest.getByRole('heading', { name: title, level: 1 }),
      ).toBeVisible();
      // No login anywhere on the way in — the point of the whole route.
      await expect(guest.getByLabel('E-Mail-Adresse')).toHaveCount(0);
      await expect(guest.getByRole('button', { name: 'Anmelden' })).toHaveCount(
        0,
      );

      // The required question is enforced before anything is sent.
      await guest.getByRole('button', { name: 'Absenden' }).click();
      await expect(guest.getByText('Pflichtfeld.')).toBeVisible();

      await guest.getByLabel(new RegExp(NAME_LABEL, 'u')).fill('Anton Aktiv');
      await guest.getByLabel('Vegetarisch').check();

      // „Sonstiges": the box appears only once the entry is ticked, and what is
      // typed into it has to survive the tick that follows it — the builder
      // promised a place for an answer that is not on the list.
      await expect(
        guest.getByLabel(`${TRAVEL_OTHER_LABEL}: Freitext`),
      ).toHaveCount(0);
      await guest.getByLabel(TRAVEL_OTHER_LABEL, { exact: true }).check();
      await guest
        .getByLabel(`${TRAVEL_OTHER_LABEL}: Freitext`)
        .fill(TRAVEL_OTHER_VALUE);
      await guest.getByLabel('Bahn').check();

      await expectNoHorizontalScroll(guest, 'Öffentliches Formular');

      await guest.getByRole('button', { name: 'Absenden' }).click();
      await expect(
        guest.getByRole('heading', { level: 1, name: 'Vielen Dank!' }),
      ).toBeVisible();
    } finally {
      await guestContext.close();
    }

    // --- Antwort ----------------------------------------------------------
    await page.goto('/');
    await page
      .getByRole('article')
      .filter({ hasText: title })
      .getByRole('button', { name: 'Antworten' })
      .click();

    await expect(
      page.getByRole('heading', { level: 1, name: `Antworten · ${title}` }),
    ).toBeVisible();
    await expect(page.getByText('1 Antwort')).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Anton Aktiv' })).toBeVisible();
    // The **label**, not the stored option value — what a reader recognises.
    await expect(page.getByRole('cell', { name: 'Vegetarisch' })).toBeVisible();
    // The free text, next to the option ticked after it, under the caption the
    // builder gave the entry.
    await expect(
      page.getByRole('cell', {
        name: `Bahn, ${TRAVEL_OTHER_LABEL}: ${TRAVEL_OTHER_VALUE}`,
      }),
    ).toBeVisible();

    // --- Export -----------------------------------------------------------
    const downloading = page.waitForEvent('download');
    // Two steps since a change to the spec: the export first asks which columns it
    // should carry. The default is the visible view, which is what this flow
    // asserts below — but the file still has to come from a real navigation,
    // so what the menu opens is an anchor, not a button.
    await page.getByRole('button', { name: 'Export' }).click();
    await page.getByRole('link', { name: 'CSV' }).click();
    const download = await downloading;

    // The filename comes from `Content-Disposition`, which only a real
    // navigation honours — building the file in JavaScript would not have one.
    expect(download.suggestedFilename()).toMatch(/\.csv$/u);

    const csv = await readFile(await download.path(), 'utf8');

    // The BOM, without which every umlaut in this file arrives broken in a
    // German Excel.
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain(NAME_LABEL);
    expect(csv).toContain('Anton Aktiv');
    expect(csv).toContain('Vegetarisch');
    // The typed answer reaches the file — the step a manual test pass once
    // found missing.
    expect(csv).toContain(`${TRAVEL_OTHER_LABEL}: ${TRAVEL_OTHER_VALUE}`);
    expect(csv).toContain('\r\n');
  });
});
