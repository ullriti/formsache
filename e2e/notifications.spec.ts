import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  addQuestion,
  expectNoHorizontalScroll,
  newForm,
  openMobileMenu,
  publishAndReadPath,
  saveForm,
} from './app-flows';
import { authStateFile } from './seed-account';

/**
 * Benachrichtigungen in a real browser — the requirements.
 *
 * `NotificationsView.test.tsx` and `NotificationEditor.test.tsx` already prove
 * the view's rules in jsdom, and they do it in milliseconds. Three things are
 * left over that only a browser can say, and they are what this file is for:
 *
 * 1. **The chain through the server**: create, edit and delete really reach the
 *    API and come back — a mocked query client proves the component, not the
 *    wiring.
 * 2. **A placeholder inserted at a real caret position.** jsdom reports
 *    `selectionStart = 0` for an `<input>` whose value React owns, so the
 *    component tests deliberately claim nothing about *where* a chip lands
 *    . Here the caret is put in the middle of the text
 *    with the keyboard, and the assertion is the resulting string — plus the
 *    one after it, which is the harder half: typing straight after the click
 *    has to land **after** the inserted token, which is only true if
 *    `setSelectionRange` survived the re-render.
 * 3. **The publish lock of C1a as the editor meets it** (dialog title, the
 *    named notification, the dead confirm button) — the server half is
 *    `apps/api/test/notifications/publish-lock.spec.ts`.
 *
 * Every test builds its own form: the suite runs in parallel and there is no
 * way to delete a form yet, so a shared fixture would make one run's
 * leftovers another run's flake.
 */

test.use({ storageState: authStateFile });

const NAME_LABEL = 'Name des Mitglieds';
const EMAIL_LABEL = 'E-Mail-Adresse';

/** What `sample-context.ts` fills an e-mail question with in the preview. */
const SAMPLE_ADDRESS = 'max.mustermann@example.de';

/**
 * The id of the n-th question card on the canvas.
 *
 * Read off the DOM rather than out of an API response, because it is the same
 * attribute `builder-drag.spec.ts` drags by — and because the ids are what the
 * chips of the requirement are keyed on (`recipient-question-…`,
 * `placeholder-chip-question-…`), so the test addresses the page the way the
 * application labels it.
 */
async function questionIdAt(page: Page, index: number): Promise<string> {
  const card = page.locator('[data-question-id]').nth(index);
  await expect(card).toBeVisible();
  const id = await card.getAttribute('data-question-id');
  expect(id, `question ${String(index)} carries no id`).not.toBeNull();
  return id ?? '';
}

/** The form-context subheader — one place, so no test spells the label twice. */
function formNav(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Aktuelles Formular' });
}

async function openFormNavEntry(page: Page, label: string): Promise<void> {
  await formNav(page).getByRole('button', { name: label, exact: true }).click();
}

/** The editor pane on the right — scoped, so „Name" is not the form's name. */
function editor(page: Page): Locator {
  return page.getByRole('region', { name: 'Benachrichtigung' });
}

/**
 * One text field of the editor, addressed by role and exact accessible name.
 *
 * `getByLabel('Name')` is not enough and the reason is worth stating: the
 * placeholder chips live inside the same region and carry names like
 * „Platzhalter für die Frage „Name des Mitglieds" einfügen", and „Text"
 * is also the label of the *Nur Text* radio. Both are correct markup; the
 * lookup has to be the precise one.
 */
function field(page: Page, name: string): Locator {
  return editor(page).getByRole('textbox', { name, exact: true });
}

test.describe('Benachrichtigungen', () => {
  /**
   * Anlegen, Bearbeiten, Löschen — the requirement asks for them by name,
   * plus the two statements this makes about the recipient.
   *
   * **The assertion in the middle**: the view has
   * to *name the chosen question*, not merely put a box on screen. It is
   * therefore the chip's own text that is compared against the caption typed in
   * the builder — a hint box would satisfy a presence check and say nothing
   * about which question the mail goes to.
   */
  test('legt eine Benachrichtigung an, bearbeitet und löscht sie', async ({
    page,
  }) => {
    const title = await newForm(page, 'Benachrichtigungen');

    // Deliberately *without* an address question first: the promise is // that the participant copy „ist nicht aktivierbar und die Oberfläche nennt
    // den Grund".
    await addQuestion(page, 'Text', NAME_LABEL);
    await saveForm(page);

    await openFormNavEntry(page, 'Benachrichtigungen');
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: `Benachrichtigungen · ${title}`,
      }),
    ).toBeVisible();

    await page.getByRole('button', { name: '+ Neue Benachrichtigung' }).click();

    // „Bei Zwischenspeichern" is absent, not disabled (an explicit exclusion) — only
    // the two boxes the API accepts are on screen, and a new draft starts
    // with „Bei Absendung" checked and „Bei Bearbeitung" not.
    await expect(page.getByTestId('trigger')).not.toContainText(
      'Zwischenspeichern',
    );
    await expect(page.getByTestId('trigger-submit')).toBeChecked();
    await expect(page.getByTestId('trigger-edit')).not.toBeChecked();

    // No box to disable any more — without an address
    // question, there is no chip row at all, only the hint explaining why.
    await expect(page.getByTestId('no-address-question')).toBeVisible();

    // --- an address question arrives ---------------------------------------
    await openFormNavEntry(page, 'Bearbeiten');
    await addQuestion(page, 'E-Mail', EMAIL_LABEL);
    await saveForm(page);

    const nameId = await questionIdAt(page, 0);
    const emailId = await questionIdAt(page, 1);

    await openFormNavEntry(page, 'Benachrichtigungen');
    await page.getByRole('button', { name: '+ Neue Benachrichtigung' }).click();

    await expect(page.getByTestId('no-address-question')).toHaveCount(0);

    // Only a question that can supply an address is offered — the text
    // question is absent rather than greyed out.
    await expect(page.getByTestId(`recipient-question-${nameId}`)).toHaveCount(
      0,
    );

    const recipientChip = page.getByTestId(`recipient-question-${emailId}`);
    // The chip carries the question's caption, which is how the editor
    // knows *which* question the mail is addressed from.
    await expect(recipientChip).toHaveText(EMAIL_LABEL);
    await expect(recipientChip).toHaveAttribute('aria-pressed', 'false');

    await recipientChip.click();
    await expect(recipientChip).toHaveAttribute('aria-pressed', 'true');

    // The preview resolves that question against the example answer, so the
    // choice is visible as an address as well as as a caption.
    //
    // `toContainText` rather than `toHaveText`: choosing a question as the
    // recipient *is* participant delivery, so the preview says so alongside
    // the address. Pinning the whole string here would make this case fail
    // on a wording change that has nothing to do with what it checks.
    await expect(page.getByTestId('preview-recipients')).toContainText(
      SAMPLE_ADDRESS,
    );

    await field(page, 'Name').fill('Anmeldung bestätigt');
    await field(page, 'Betreff').fill('Deine Anmeldung');
    await field(page, 'Text').fill('Danke für die Anmeldung.');

    await page.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(
      editor(page).getByText('Gespeichert', { exact: true }),
    ).toBeVisible();

    // The saved row appears in the list on the left, which is the only proof
    // the server kept it.
    const list = page.getByRole('listitem');
    await expect(list.filter({ hasText: 'Anmeldung bestätigt' })).toHaveCount(
      1,
    );

    // --- bearbeiten --------------------------------------------------------
    await field(page, 'Name').fill('Bestätigung an Teilnehmer');
    await expect(editor(page).getByText('Nicht gespeichert')).toBeVisible();
    await page.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(
      editor(page).getByText('Gespeichert', { exact: true }),
    ).toBeVisible();

    await expect(
      list.filter({ hasText: 'Bestätigung an Teilnehmer' }),
    ).toHaveCount(1);
    await expect(list.filter({ hasText: 'Anmeldung bestätigt' })).toHaveCount(
      0,
    );

    // A reload rather than trusting the cache: „gespeichert" has to mean the
    // server said so.
    await page.reload();
    await expect(
      page
        .getByRole('listitem')
        .filter({ hasText: 'Bestätigung an Teilnehmer' }),
    ).toHaveCount(1);

    // --- löschen -----------------------------------------------------------
    await page.getByRole('button', { name: '🗑 Löschen' }).click();

    await expect(
      page.getByText(
        'Links eine Benachrichtigung wählen oder eine neue anlegen.',
      ),
    ).toBeVisible();
    await expect(
      page.getByText(
        'Noch keine Benachrichtigung. Ohne eine solche verschickt dieses Formular keine E-Mail.',
      ),
    ).toBeVisible();

    await page.reload();
    await expect(
      page
        .getByRole('listitem')
        .filter({ hasText: 'Bestätigung an Teilnehmer' }),
    ).toHaveCount(0);
  });

  /**
   * The work item „Oberfläche für die Auslöser-Menge": both boxes as real
   * controls in the running application, not only as jsdom checkboxes —
   * clicked, never `setChecked`. `setChecked` is a no-op the moment a
   * checkbox's value already matches the target, which is exactly the trap
   * an earlier review found: six e2e cases were written and never run, and three of them
   * failed on first run because the middle of every switch turned out to be
   * that dead zone.
   */
  test('schaltet beide Auslöser-Kästchen und speichert das Ergebnis', async ({
    page,
  }) => {
    await newForm(page, 'Auslöser-Menge');
    await addQuestion(page, 'E-Mail', EMAIL_LABEL);
    await saveForm(page);

    const emailId = await questionIdAt(page, 0);

    await openFormNavEntry(page, 'Benachrichtigungen');
    await page.getByRole('button', { name: '+ Neue Benachrichtigung' }).click();

    const submitBox = page.getByTestId('trigger-submit');
    const editBox = page.getByTestId('trigger-edit');
    await expect(submitBox).toBeChecked();
    await expect(editBox).not.toBeChecked();

    // Choosing a question recipient defaults „Bei Bearbeitung" on — the edit
    // link is an owner capability (module note 1a, `NotificationEditor`).
    await page.getByTestId(`recipient-question-${emailId}`).click();
    await expect(editBox).toBeChecked();

    // The default is not a lock: it unchecks like any other box.
    await editBox.click();
    await expect(editBox).not.toBeChecked();

    // Unchecking the only remaining trigger blocks the save with a reason.
    await submitBox.click();
    await expect(submitBox).not.toBeChecked();
    await expect(page.getByText(/mindestens einen Auslöser/)).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Speichern', exact: true }),
    ).toBeDisabled();

    // Re-checking both is what actually lets the draft be saved.
    await submitBox.click();
    await editBox.click();
    await expect(submitBox).toBeChecked();
    await expect(editBox).toBeChecked();

    await field(page, 'Name').fill('Beide Auslöser');
    await field(page, 'Betreff').fill('Test');

    await page.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(
      editor(page).getByText('Gespeichert', { exact: true }),
    ).toBeVisible();

    // A reload, not just React state — both boxes came back from the server.
    await page.reload();
    await expect(page.getByTestId('trigger-submit')).toBeChecked();
    await expect(page.getByTestId('trigger-edit')).toBeChecked();
  });

  /**
   * The chip inserts **at the caret**, and the caret survives the re-render.
   *
   * This is the case handed over from `NotificationsView.test.tsx` with the
   * note that jsdom cannot hold it: there `selectionStart` is `0` on a
   * controlled input, so a component test can only ever observe „the token is
   * somewhere in the value".
   * Both halves are measured here:
   *
   * - the value after the click, which pins the **position**;
   * - what typing immediately afterwards produces, which pins the **caret**.
   *   Without the effect in `NotificationEditor` that reapplies
   *   `setSelectionRange` after React has rewritten the node, the character
   *   would land at the end of the field.
   */
  test('fügt einen Platzhalter an der Cursorposition ein', async ({ page }) => {
    const title = await newForm(page, 'Platzhalter');
    await addQuestion(page, 'Text', NAME_LABEL);
    await saveForm(page);

    const nameId = await questionIdAt(page, 0);

    await openFormNavEntry(page, 'Benachrichtigungen');
    await page.getByRole('button', { name: '+ Neue Benachrichtigung' }).click();

    const subject = field(page, 'Betreff');
    await subject.fill('Hallo ENDE');
    await subject.press('End');
    for (let step = 0; step < 4; step += 1) {
      await subject.press('ArrowLeft');
    }

    await page.getByTestId('placeholder-chip-formular').click();
    await expect(subject).toHaveValue('Hallo {{formular}}ENDE');

    // The caret is where the token ended, not at the end of the field.
    await page.keyboard.type('X');
    await expect(subject).toHaveValue('Hallo {{formular}}XENDE');

    // The same for the body, and with a **question** chip: the field shows
    // the caption the chip reads too — `{{frage:${nameId}}}` is what gets
    // *saved*, never what is on screen.
    const body = field(page, 'Text');
    await body.fill('oben unten');
    await body.press('End');
    for (let step = 0; step < 5; step += 1) {
      await body.press('ArrowLeft');
    }

    await page.getByTestId(`placeholder-chip-question-${nameId}`).click();
    await expect(body).toHaveValue(`oben {{frage:${NAME_LABEL}}}unten`);

    // The preview renders both against the example data — the form's own title
    // for `{{formular}}`, the sample answer for the question.
    await expect(page.getByTestId('preview-subject')).toHaveText(
      `Hallo ${title}XENDE`,
    );
    // **Read through the frame, not off the page.** Since then the
    // HTML preview is a sandboxed `<iframe srcdoc>` rather than a `<pre>` of
    // its own source, so its text is not part of the surrounding document —
    // asserting on the region would now pass over an empty frame without
    // noticing. This is the assertion the change earns: the mail is *rendered*,
    // and the browser is the only place that can be seen.
    await expect(
      page.frameLocator('[data-testid="preview-body-frame"]').locator('body'),
    ).toContainText('Beispieltext');
  });

  /**
   * The requirement in the browser: publishing is **refused before the press**,
   * and the dialog says which notification and which placeholder.
   *
   * The server refuses the same publish with a 422 (`publish-lock.spec.ts`);
   * what is proven here is that the editor is told beforehand rather than
   * afterwards, which is the whole decision of the specification.
   */
  test('sperrt das Veröffentlichen, wenn ein Platzhalter ins Leere zeigt', async ({
    page,
  }) => {
    await newForm(page, 'Platzhalter-Sperre');
    await addQuestion(page, 'Text', 'Anlass');
    await addQuestion(page, 'E-Mail', EMAIL_LABEL);
    await saveForm(page);

    // A version has to be in force: the first publication has nothing to warn
    // about and never opens the dialog.
    await publishAndReadPath(page);

    const emailId = await questionIdAt(page, 1);

    await openFormNavEntry(page, 'Benachrichtigungen');
    await page.getByRole('button', { name: '+ Neue Benachrichtigung' }).click();
    await field(page, 'Name').fill('Bestätigung');
    await field(page, 'Betreff').fill('Deine Anmeldung');
    await page.getByTestId(`recipient-question-${emailId}`).click();
    await page.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(
      editor(page).getByText('Gespeichert', { exact: true }),
    ).toBeVisible();

    // --- the question the notification points at disappears ----------------
    await openFormNavEntry(page, 'Bearbeiten');
    await page.getByRole('button', { name: 'Frage 2 löschen' }).click();
    await saveForm(page);

    await page.getByRole('button', { name: 'Erneut veröffentlichen' }).click();

    const dialog = page.getByRole('dialog', {
      name: 'Veröffentlichen nicht möglich',
    });
    await expect(dialog).toBeVisible();

    const blocked = page.getByTestId('publish-blocked');
    await expect(blocked).toBeVisible();
    // Both names, as required — otherwise the editor searches n
    // texts by hand.
    await expect(blocked).toContainText('Bestätigung');
    await expect(blocked).toContainText('Empfängerliste');
    await expect(blocked).toContainText(`{{frage:${emailId}}}`);

    // Offering a button that cannot succeed is how a refusal reads as a bug.
    await expect(
      dialog.getByRole('button', { name: 'Erneut veröffentlichen' }),
    ).toBeDisabled();

    await dialog.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(dialog).toHaveCount(0);
  });
});

/**
 * The compact layout below 1180 px (and the „Aktuelles
 * Formular" section the handoff's navigation asks for).
 *
 * In this file rather than in the mobile project, for the reason
 * `builder-drag.spec.ts` states next to its own mobile block: the rest of these
 * cases is not a measurement of width, and running the whole spec twice would
 * double the slowest half of it for no additional evidence.
 */
test.describe('Mobile-Navigation zu den Benachrichtigungen', () => {
  test.use({ viewport: { width: 360, height: 740 }, hasTouch: true });

  test('bietet „Aktuelles Formular" im Off-Canvas-Menü an', async ({
    page,
  }) => {
    const title = await newForm(page, 'Mobile Navigation');

    // The desktop subheader is gone at this width; the entries live in the
    // sheet and nowhere else.
    await expect(formNav(page)).toHaveCount(0);

    const { sheet } = await openMobileMenu(page);
    await expect(
      sheet.getByText('Aktuelles Formular', { exact: true }),
    ).toBeVisible();

    await sheet
      .getByRole('button', { name: 'Benachrichtigungen', exact: true })
      .click();

    await expect(
      page.getByRole('heading', {
        level: 1,
        name: `Benachrichtigungen · ${title}`,
      }),
    ).toBeVisible();
    await expectNoHorizontalScroll(page, 'Benachrichtigungen (360 px)');

    // Reopened, the entry marks itself as the current page — the state the
    // handoff's navigation owes a user who has lost track of where they are.
    const reopened = await openMobileMenu(page);
    await expect(
      reopened.sheet.getByRole('button', {
        name: 'Benachrichtigungen',
        exact: true,
      }),
    ).toHaveAttribute('aria-current', 'page');
  });
});
