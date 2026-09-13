import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  addQuestion,
  expectSaved,
  newForm,
  publishAndReadPath,
  saveForm,
  openFormSettings,
} from './app-flows';
import { authStateFile } from './seed-account';

/**
 * **The password protection while filling in.**
 *
 * What this file can prove, and what it deliberately leaves to
 * `apps/api/test/public/password-gate.spec.ts`:
 *
 * - The **protection** is the server's, and it is tested there — against the
 *   endpoints, past any browser — the whole point being „der
 *   Schutz muss halten, wenn niemand die Oberfläche benutzt". Nothing in a
 *   Playwright run can establish that.
 * - What *is* only visible here is the chain end to end: an editor sets a word
 *   in the settings page, a **stranger** opens the public address in a
 *   session-less context, meets a gate instead of the questions, types the word
 *   and fills the form in. Every seam in that chain — the settings write, the
 *   locked payload, the header on the reload, the header on the submission —
 *   is a place where the pieces can be individually correct and still not fit.
 *
 * The guest context is not decoration: a participant has no account
 * , and a page that inherited the editor's cookie would prove
 * nothing about what a stranger sees.
 *
 * **Desktop only** (`playwright.config.ts`), for the reason `core-flow` and
 * `public-form-settings` run there alone: each case writes a form and a
 * published version into the shared database, and nothing asserted here is a
 * measurement of width.
 */

test.use({ storageState: authStateFile });

const NAME_LABEL = 'Name des Mitglieds';
const WORD = 'Jahrestreffen2026';

/** A published one-page form and the public path it can be filled in at. */
async function publishedForm(page: Page, base: string): Promise<string> {
  await newForm(page, base);
  await addQuestion(page, 'Text', NAME_LABEL);
  await page.getByLabel('Pflichtfeld').check();
  await saveForm(page);
  return publishAndReadPath(page);
}

async function openSettings(page: Page): Promise<void> {
  // Since review finding 18 the way leads over the subheader or the
  // menu — the button in the builder bar is gone.
  await openFormSettings(page);
}

function sectionCard(page: Page, heading: string): Locator {
  return page.getByRole('region', { name: heading });
}

/**
 * Sets the access word through the real settings page.
 *
 * The switch is **clicked**, not `setChecked`-ed into place: `setChecked` does
 * nothing when the value already matches, and that is exactly how the dead zone
 * in the middle of every switch survived six green E2E cases in
 * `public-form-settings.spec.ts`. A test that never presses the control it is
 * about is not testing the control.
 */
async function protectWith(page: Page, word: string): Promise<void> {
  await openSettings(page);
  const access = sectionCard(page, 'Zugriff & Sicherheit');
  await access.getByRole('radio', { name: 'Angepasst' }).check();

  const toggle = access.getByRole('switch', { name: 'Passwortschutz' });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();

  await access.getByLabel('Zugangspasswort').fill(word);

  await page.getByRole('button', { name: 'Speichern', exact: true }).click();
  // Not the disabled button: it is disabled while the request is in flight too,
  // and every caller goes on to open the public address the gate belongs to.
  await expectSaved(page);
}

test.describe('Passwortschutz beim Ausfüllen', () => {
  /**
   * The whole chain in one run — and the assertion that carries the whole case
   * is the **negative** one in the middle: while the gate is up, the question
   * is not on the page. „Shows a gate" alone would also be true of a page that
   * showed both and hid one with CSS.
   */
  test('asks for the word before it shows the questions', async ({
    page,
    browser,
  }) => {
    const publicPath = await publishedForm(page, 'Mit Zugangswort');
    await protectWith(page, WORD);

    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);

      // The gate: title and Organisation are there, the questions are not.
      await expect(
        guest.getByRole('heading', { level: 1, name: /Mit Zugangswort/u }),
      ).toBeVisible();
      await expect(guest.getByText(/passwortgeschützt/u)).toBeVisible();
      await expect(guest.getByLabel(NAME_LABEL)).toHaveCount(0);
      await expect(guest.getByRole('button', { name: 'Absenden' })).toHaveCount(
        0,
      );

      // …and the word is asked for in a masked field.
      await expect(guest.getByLabel('Zugangswort')).toHaveAttribute(
        'type',
        'password',
      );

      await guest.getByLabel('Zugangswort').fill(WORD);
      await guest.getByRole('button', { name: 'Weiter' }).click();

      // Past the gate: the question arrives, the gate is gone.
      await expect(guest.getByLabel(NAME_LABEL)).toBeVisible();
      await expect(guest.getByLabel('Zugangswort')).toHaveCount(0);
    } finally {
      await guestContext.close();
    }
  });

  /**
   * The wrong word keeps the gate up and says so — and the sentence is the
   * client's, not the server's. The API answers a wrong word byte-identically
   * to an unknown address („Dieses Formular gibt es nicht."), which would be
   * baffling to somebody looking at the form. Asserting the *absence* of that
   * wording is what keeps the two apart.
   */
  test('refuses a wrong word without sending the participant away', async ({
    page,
    browser,
  }) => {
    const publicPath = await publishedForm(page, 'Falsches Wort');
    await protectWith(page, WORD);

    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);
      await guest.getByLabel('Zugangswort').fill('Semesterrueckmeldung');
      await guest.getByRole('button', { name: 'Weiter' }).click();

      const alert = guest.getByRole('alert');
      await expect(alert).toHaveText(/Zugangswort stimmt nicht/u);
      await expect(alert).not.toHaveText(/gibt es nicht/u);

      await expect(guest.getByLabel('Zugangswort')).toBeVisible();
      await expect(guest.getByLabel(NAME_LABEL)).toHaveCount(0);
    } finally {
      await guestContext.close();
    }
  });

  /**
   * **Bullet 6, watched from outside the application.** Every request the page
   * makes is recorded, and none of their URLs contains the word.
   *
   * A network assertion rather than a code review: it covers the form submit
   * the gate is built on (`preventDefault` plus `fetch`), which is the one way a
   * word ends up in a query string without anybody writing it there. A native
   * `<form>` submission would put `?password=…` in the address bar, in the
   * access log and in the browser's history — and this test would see it.
   */
  test('never puts the word into a URL', async ({ page, browser }) => {
    const publicPath = await publishedForm(page, 'Wort nie in der URL');
    await protectWith(page, WORD);

    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    const urls: string[] = [];
    guest.on('request', (requested) => {
      urls.push(requested.url());
    });

    try {
      await guest.goto(publicPath);
      await guest.getByLabel('Zugangswort').fill(WORD);
      await guest.getByRole('button', { name: 'Weiter' }).click();
      await expect(guest.getByLabel(NAME_LABEL)).toBeVisible();

      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) {
        expect(url).not.toContain(WORD);
      }
      // The address bar too — a native submit would have rewritten it.
      expect(guest.url()).not.toContain(WORD);
    } finally {
      await guestContext.close();
    }
  });

  /**
   * The proof reaches the **submission** as well, which is the request the
   * server refuses without it. A client that attached it only to the read would
   * pass every case above and fail at the one moment that costs a participant
   * the page of answers they just typed.
   */
  test('carries the proof through to a stored answer', async ({
    page,
    browser,
  }) => {
    const publicPath = await publishedForm(page, 'Antwort hinter dem Wort');
    await protectWith(page, WORD);

    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);
      await guest.getByLabel('Zugangswort').fill(WORD);
      await guest.getByRole('button', { name: 'Weiter' }).click();

      await guest.getByLabel(NAME_LABEL).fill('Anton Auerswald');
      await guest.getByRole('button', { name: 'Absenden' }).click();

      await expect(
        guest.getByRole('heading', { level: 1, name: 'Vielen Dank!' }),
      ).toBeVisible();
    } finally {
      await guestContext.close();
    }
  });

  /**
   * **Reloading loses the proof, and that is the decision, not an oversight.**
   *
   * A public form is filled in on borrowed devices — an organisation's office machine, a
   * phone passed around at a Mitgliederversammlung — so the proof lives in the tab and
   * nowhere a next visitor could find it. The cost is one re-entry of a word
   * the participant has in front of them.
   *
   * Written as a test because the opposite behaviour is the tempting one: the
   * first person who finds the re-entry annoying will reach for `localStorage`,
   * and this is what will be red when they do.
   */
  test('asks again after a reload instead of remembering the word', async ({
    page,
    browser,
  }) => {
    const publicPath = await publishedForm(page, 'Nach dem Neuladen');
    await protectWith(page, WORD);

    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);
      await guest.getByLabel('Zugangswort').fill(WORD);
      await guest.getByRole('button', { name: 'Weiter' }).click();
      await expect(guest.getByLabel(NAME_LABEL)).toBeVisible();

      await guest.reload();

      await expect(guest.getByLabel('Zugangswort')).toBeVisible();
      await expect(guest.getByLabel(NAME_LABEL)).toHaveCount(0);
    } finally {
      await guestContext.close();
    }
  });
});
