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
 * „Bearbeiten nach Absenden" from end to end.
 *
 * The server's half is proven in `apps/api/test/public/response-edit.spec.ts`,
 * including every refusal. What only a browser can show is the part
 * promised to a participant: **the link is on the
 * confirmation page**, following it opens *their* answer with the values
 * already in the fields, and saving replaces that answer instead of adding a
 * second one.
 *
 * Two things about the setup, both deliberate:
 *
 * **The participant runs in a session-less second context.** A page that
 * inherited the editor's cookie would prove nothing about what a stranger sees —
 * and a stranger is exactly who follows this link (keine
 * Teilnehmer-Konten).
 *
 * **Desktop only** (`playwright.config.ts`), for the reason `core-flow` runs
 * there alone: each case writes a form, a published version and a response into
 * the shared development database, and nothing asserted here is a measurement
 * of width.
 */

test.use({ storageState: authStateFile });

const NAME_LABEL = 'Name des Mitglieds';

function sectionCard(page: Page, heading: string): Locator {
  return page.getByRole('region', { name: heading });
}

/** Opens the settings page of the form the builder currently shows. */
async function openSettings(page: Page): Promise<void> {
  const heading = page.getByRole('heading', { name: 'Formular-Einstellungen' });

  /*
    Idempotent on purpose. `publishedEditableForm` leaves the editor **on** the
    settings page, so a second call would look for the „Einstellungen" button
    the builder has and this page does not — and wait for it until the test
    times out, thirty seconds later, with no action to blame it on. That is
    what happened on the first real run of this file, and it cost longer to
    diagnose than it took to build.
  */
  if (await heading.isVisible()) {
    return;
  }

  await openFormSettings(page);
}

/**
 * Publishes a one-question form and switches „Bearbeiten nach Absenden" to the
 * given state.
 *
 * `setChecked(true)` on a switch whose system default is **off** really does
 * press it, which matters here for the reason recorded once before: the middle 18 of
 * 42 px of every toggle used to be a dead zone, and it survived because no test
 * had ever clicked one — `setChecked` does nothing when the value already
 * matches. The `false` case below therefore does *not* press, and it is not the
 * one this note is about.
 */
async function publishedEditableForm(
  page: Page,
  base: string,
  allowEdit: boolean,
): Promise<{ title: string; publicPath: string }> {
  const title = await newForm(page, base);
  await addQuestion(page, 'Text', NAME_LABEL);
  await page.getByLabel('Pflichtfeld').check();
  await saveForm(page);
  const publicPath = await publishAndReadPath(page);

  await openSettings(page);
  const access = sectionCard(page, 'Zugriff & Sicherheit');
  await access.getByRole('radio', { name: 'Angepasst' }).check();
  await access
    .getByRole('switch', { name: 'Bearbeiten nach Absenden' })
    .setChecked(allowEdit);

  await page.getByRole('button', { name: 'Speichern', exact: true }).click();
  // Not the disabled button: it is disabled while the request is in flight too.
  await expectSaved(page);

  return { title, publicPath };
}

test.describe('Bearbeiten nach Absenden', () => {
  test('hands out a link that opens the participant’s own answer, pre-filled', async ({
    page,
    browser,
  }) => {
    const { publicPath } = await publishedEditableForm(
      page,
      'Bearbeitbar',
      true,
    );

    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);
      await guest.getByLabel(new RegExp(NAME_LABEL, 'u')).fill('Anton Aktiv');
      await guest.getByRole('button', { name: 'Absenden' }).click();

      // The confirmation carries the address (first sentence).
      const block = guest.getByTestId('public-edit-link');
      await expect(block).toBeVisible();

      const link = block.getByRole('link');
      const editUrl = await link.getAttribute('href');
      // Absolute and **built by the server** — a path assembled in the browser
      // would be a second answer to where this installation lives, and the same
      // string goes into the confirmation mail.
      expect(editUrl).toMatch(/^https?:\/\/[^/]+\/a\/[A-Za-z0-9_-]+$/u);
      // Display text and href are the same string, so „Linkadresse kopieren"
      // yields what is on screen.
      await expect(link).toHaveText(editUrl ?? '');

      // Following it opens the answer, with the value already in the field.
      await guest.goto(new URL(editUrl ?? '').pathname);
      await expect(guest.getByTestId('response-edit')).toBeVisible();
      await expect(guest.getByLabel(new RegExp(NAME_LABEL, 'u'))).toHaveValue(
        'Anton Aktiv',
      );
      // …and it says what this screen is, rather than looking like a fresh
      // registration with somebody else's data in it.
      await expect(guest.getByTestId('response-edit-note')).toContainText(
        'bereits abgesendete Antwort',
      );
    } finally {
      await guestContext.close();
    }
  });

  test('replaces the answer instead of adding a second one', async ({
    page,
    browser,
  }) => {
    const { title, publicPath } = await publishedEditableForm(
      page,
      'Ersetzen',
      true,
    );

    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);
      await guest.getByLabel(new RegExp(NAME_LABEL, 'u')).fill('Bertram Bunt');
      await guest.getByRole('button', { name: 'Absenden' }).click();

      const editUrl = await guest
        .getByTestId('public-edit-link')
        .getByRole('link')
        .getAttribute('href');
      const editPath = new URL(editUrl ?? '').pathname;

      await guest.goto(editPath);
      await guest
        .getByLabel(new RegExp(NAME_LABEL, 'u'))
        .fill('Bertram Bunt der Ältere');
      await guest.getByRole('button', { name: 'Änderungen speichern' }).click();
      await expect(guest.getByRole('heading', { level: 1 })).toBeVisible();

      // The change is what the edit address shows on the next visit.
      await guest.goto(editPath);
      await expect(guest.getByLabel(new RegExp(NAME_LABEL, 'u'))).toHaveValue(
        'Bertram Bunt der Ältere',
      );
    } finally {
      await guestContext.close();
    }

    // …and the editor's answers table holds **one** row for this form, not two.
    // The count is the whole point of „keine zweite Zeile"; the browser is the
    // only place where the participant's round trip and the editor's view meet.
    await page.goto('/');
    await page
      .getByRole('article')
      .filter({ hasText: title })
      .getByRole('button', { name: 'Antworten' })
      .click();
    await expect(
      page.getByRole('heading', { level: 1, name: `Antworten · ${title}` }),
    ).toBeVisible();
    // Singular — „1 Antwort", not „2 Antworten". The edit replaced the row.
    await expect(page.getByText('1 Antwort')).toBeVisible();
    await expect(
      page.getByRole('cell', { name: 'Bertram Bunt der Ältere' }),
    ).toBeVisible();
    await expect(
      page.getByRole('cell', { name: 'Bertram Bunt', exact: true }),
    ).toHaveCount(0);
  });

  /**
   * **The setting is evaluated on every access, not at issuing time.**
   *
   * The link is handed out while the switch is on and the switch is turned off
   * afterwards; the same address then refuses. A run that only checked the
   * setting before the link was minted would show the opposite of what
   * should hold.
   */
  test('stops working once the editor switches editing off', async ({
    page,
    browser,
  }) => {
    const { publicPath } = await publishedEditableForm(
      page,
      'Abgeschaltet',
      true,
    );

    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);
      await guest.getByLabel(new RegExp(NAME_LABEL, 'u')).fill('Cäsar Clar');
      await guest.getByRole('button', { name: 'Absenden' }).click();

      const editUrl = await guest
        .getByTestId('public-edit-link')
        .getByRole('link')
        .getAttribute('href');
      const editPath = new URL(editUrl ?? '').pathname;

      // It works — so the refusal below is about the switch and not about a
      // link that never worked.
      await guest.goto(editPath);
      await expect(guest.getByTestId('response-edit')).toBeVisible();

      await openSettings(page);
      await sectionCard(page, 'Zugriff & Sicherheit')
        .getByRole('switch', { name: 'Bearbeiten nach Absenden' })
        .setChecked(false);
      await page
        .getByRole('button', { name: 'Speichern', exact: true })
        .click();
      // Not the disabled button: it is disabled while the request is in flight
      // too, so the guest below would reload before the switch has landed and
      // would rightly still be offered the editor.
      await expectSaved(page);

      await guest.goto(editPath);
      await expect(
        guest.getByTestId('response-edit-unavailable'),
      ).toBeVisible();
      await expect(
        guest.getByTestId('response-edit-unavailable'),
      ).toContainText('Bearbeiten nach dem Absenden ausgeschaltet');
      await expect(guest.getByTestId('response-edit')).toHaveCount(0);
    } finally {
      await guestContext.close();
    }
  });

  /** No link on the receipt for a form that does not offer editing. */
  test('offers no link when the form does not allow editing', async ({
    page,
    browser,
  }) => {
    const { publicPath } = await publishedEditableForm(
      page,
      'Ohne Link',
      false,
    );

    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);
      await guest.getByLabel(new RegExp(NAME_LABEL, 'u')).fill('Dieter Dicht');
      await guest.getByRole('button', { name: 'Absenden' }).click();

      await expect(guest.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(guest.getByTestId('public-edit-link')).toHaveCount(0);
    } finally {
      await guestContext.close();
    }
  });

  /**
   * A guessed address is the one 404 of the public routes — and what the
   * browser must show for it is „nichts, das hier steht", not a hint that
   * something was almost right.
   */
  test('says nothing useful about a token that leads nowhere', async ({
    browser,
  }) => {
    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await guest.goto('/a/AAAAAAAAAAAAAAAAAAAAAA');
      await expect(
        guest.getByTestId('response-edit-unavailable'),
      ).toBeVisible();
      await expect(guest.getByTestId('response-edit')).toHaveCount(0);
    } finally {
      await guestContext.close();
    }
  });
  /**
   * Turning the access word **on** revokes the edit links already handed out.
   *
   * This is the case the review gate found and the only one in which the
   * revocation earns its keep: the usual reason an organisation sets a word is that the
   * link leaked. A token minted *before* that carried an unprotected `GET` that
   * served the full field definition — precisely what no unauthenticated
   * `GET` may do. The server's half is proven four times over in
   * `apps/api/test/public/response-edit.spec.ts`; what only a browser shows is
   * that the participant's link really stops working, rather than the row
   * merely changing in the database.
   */
  test('stops an issued link once the organisation switches the access word on', async ({
    page,
    browser,
  }) => {
    const { publicPath } = await publishedEditableForm(page, 'Widerruf', true);

    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);
      await guest.getByLabel(new RegExp(NAME_LABEL, 'u')).fill('Dietrich Dorn');
      await guest.getByRole('button', { name: 'Absenden' }).click();

      const editUrl = await guest
        .getByTestId('public-edit-link')
        .getByRole('link')
        .getAttribute('href');
      const editPath = new URL(editUrl ?? '').pathname;

      // It opens — so the refusal below is about the revocation and not about
      // a link that never worked.
      await guest.goto(editPath);
      await expect(guest.getByTestId('response-edit')).toBeVisible();

      await openSettings(page);
      const access = sectionCard(page, 'Zugriff & Sicherheit');
      const toggle = access.getByRole('switch', { name: 'Passwortschutz' });
      await expect(toggle).not.toBeChecked();
      await toggle.click();
      await access.getByLabel('Zugangspasswort').fill('Jahrestreffen2026');
      await page
        .getByRole('button', { name: 'Speichern', exact: true })
        .click();
      // Not the disabled button — see the case above.
      await expectSaved(page);

      // Dead, and indistinguishable from an address that never existed — the
      // same 404 the case above gets.
      await guest.goto(editPath);
      await expect(
        guest.getByTestId('response-edit-unavailable'),
      ).toBeVisible();
      await expect(guest.getByTestId('response-edit')).toHaveCount(0);
    } finally {
      await guestContext.close();
    }
  });
});
