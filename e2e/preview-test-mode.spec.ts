import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  addQuestion,
  expectNoHorizontalScroll,
  newForm,
  openMobileMenu,
  publishAndReadPath,
  saveForm,
  saveState,
} from './app-flows';
import { authStateFile } from './seed-account';

/**
 * The **way into the Testmodus** — the proof of the requirement: „Die Ansicht
 * ist über die Navigation erreichbar und läuft mobil."
 *
 * The mechanism was covered, the way in was not: `sample-answers.test.ts`
 * checks the values, `PreviewView.test.tsx` checks that the test run calls no
 * route, `FormNav.test.tsx` checks the entry and `routes.test.ts` the address —
 * but **no** case has ever rendered the view through the shell, and `e2e/`
 * did not know `/preview` at all. This very seam is the one at which a whole
 * package once answered 404 although it had been built.
 *
 * That is why it is **clicked rather than addressed** here: `page.goto('…/preview')`
 * would never have found the finding — it bypasses both the navigation entry and
 * the render branch that the shell has to have for `route.kind === 'preview'`
 * in the first place. Both ways are measured: the subheader at 1280 px, the
 * off-canvas sheet at 360 px.
 *
 * ## The counter-check, and why it is not tautological here
 *
 * „Ein Testlauf erzeugt keine `response`- und keine `mail_log`-Zeile" would be,
 * on a fresh form, the statement „0 stays 0" — green even when the
 * answers table shows nothing at all and the mail log stayed empty.
 * The case therefore **first produces a real row**: the form is
 * published, a notification is created and really submitted in a session-less
 * context. Afterwards the table says *1 Antwort* and the
 * protocol *1 Gesamt* — both counters have proved that they can count.
 * Only then does the test run run, and only then does „still 1" mean something.
 *
 * Counting happens over the **interface** (answers table, mail log),
 * never over the database — the same rule by which the overall run measures its
 * residue.
 *
 * ## Residue
 *
 * Every case clears its form away for good ({@link purgeForm}) and then
 * **measures** that it is gone: no card of this title on the dashboard, and a
 * restore answers 404. What stays standing is the one
 * `mail_log` row of the real sending, with an emptied recipient address — the same
 * rule keeps the operational record and takes the person out; `mail-log.spec.ts`
 * leaves two behind for the same reason.
 */

test.use({ storageState: authStateFile });

const NAME_LABEL = 'Name des Mitglieds';
const MAIL_LABEL = 'Adresse des Mitglieds';
const NOTIFICATION_NAME = 'Anmeldung an das Sekretariat';
const GUEST_NAME = 'Anton Aktiv';

const TEST_MODE_MARK = '● Testmodus';
const TEST_MODE_TEXT = 'Eingaben werden nicht gespeichert oder versendet.';

/**
 * Where the office copy would go — **different per run**, for the reason
 * `mail-log.spec.ts` has written out: `.invalid` can never resolve
 * (RFC 2606), and `mail_log` rows stay standing for ninety days, so no
 * assertion of this case may count the row of an earlier run.
 */
function officeAddressFor(run: string): string {
  return `sekretariat-vorschau-${run}@example.invalid`;
}

/** The subheader in the form context — one place for the name. */
function formNav(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Aktuelles Formular' });
}

/**
 * An entry of the subheader, **clicked**.
 *
 * `exact: true`, and that is not cosmetics: Playwright compares an
 * accessible name as a **substring regardless of upper/lower case**
 * — „Vorschau" would be one button „Vorschau zurücksetzen" away from having two
 * matches. A later change turned 54 cases in sixteen files red at once
 * in exactly this way, with three buttons „… als Vorlage speichern".
 */
async function openFormNavEntry(page: Page, label: string): Promise<void> {
  await formNav(page).getByRole('button', { name: label, exact: true }).click();
}

/** The editor of a notification — `Name` is not the form name there. */
function editor(page: Page): Locator {
  return page.getByRole('region', { name: 'Benachrichtigung' });
}

/** A text field of the editor, by role and exact name (`mail-log.spec.ts`). */
function editorField(page: Page, name: string): Locator {
  return editor(page).getByRole('textbox', { name, exact: true });
}

/**
 * The CSRF header of every writing request (`apps/web/src/api/http.ts`).
 * `page.request` shares the cookie jar of the context, so only the
 * second half of the double submit is missing.
 */
async function csrfHeader(page: Page): Promise<Record<string, string>> {
  const cookies = await page.context().cookies();
  const token = cookies.find(
    (cookie) =>
      cookie.name === 'formsache_csrf' ||
      cookie.name === '__Host-formsache_csrf',
  )?.value;
  return token === undefined ? {} : { 'X-CSRF-Token': token };
}

/** The form id from the builder's address — that is where `newForm` leaves the page. */
function formIdOf(page: Page): string {
  const id = /\/forms\/([^/?#]+)/u.exec(page.url())?.[1];
  if (id === undefined) {
    throw new Error(`Could not read the form id from ${page.url()}.`);
  }
  return id;
}

/**
 * Takes a form out of this organisation for good — two requests, because
 * `DELETE /api/forms/:id/permanent` only takes hold of what is **in** the trash
 * (`ScopedFormDelegate.purgeForm`). The same order as in
 * `dashboard-delete.spec.ts`.
 */
async function purgeForm(page: Page, formId: string): Promise<void> {
  const headers = await csrfHeader(page);
  const intoTrash = await page.request.delete(`/api/forms/${formId}`, {
    headers,
  });
  expect(
    [204, 404],
    `DELETE /api/forms/${formId} answered ${String(intoTrash.status())}`,
  ).toContain(intoTrash.status());

  const purged = await page.request.delete(`/api/forms/${formId}/permanent`, {
    headers,
  });
  expect(purged.status(), `DELETE /api/forms/${formId}/permanent`).toBe(204);
}

/**
 * The proof that the clean-up really cleared — **counted**, not
 * claimed, and in two independent places: the dashboard knows no card
 * of this title any more, and a restore answers 404 instead of 204. The
 * second measurement is the sharper one: a card can also be missing because a
 * list has just not loaded.
 */
async function expectFormIsGone(
  page: Page,
  formId: string,
  title: string,
): Promise<void> {
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Dashboard', level: 1 }),
  ).toBeVisible();
  await expect(
    page.locator('.form-card').filter({ hasText: title }),
  ).toHaveCount(0);

  const restoreAttempt = await page.request.post(
    `/api/forms/${formId}/restore`,
    { headers: await csrfHeader(page) },
  );
  expect(
    restoreAttempt.status(),
    'Ein endgültig gelöschtes Formular lässt sich nicht wiederherstellen — ' +
      'ein 204 hier hieße, dieser Lauf hat seinen Rückstand nur in den ' +
      'Papierkorb geschoben.',
  ).toBe(404);
}

/**
 * The bar of the handoff, word for word, and the visibility of the view.
 *
 * Two separate assertions instead of one over the whole paragraph: the mark and
 * the sentence live in two elements, and a contracted comparison would be a
 * statement about their whitespace rather than about the text.
 */
async function expectTestModeBar(page: Page): Promise<void> {
  const bar = page.getByTestId('test-mode-bar');
  await expect(bar).toBeVisible();
  await expect(bar).toContainText(TEST_MODE_MARK);
  await expect(bar).toContainText(TEST_MODE_TEXT);
}

/**
 * „Beispielwerte eintragen" pressed — and afterwards there **really is
 * something** in the fields. Returns the generated name value, so that the test
 * run can be checked against it.
 *
 * The empty initial state is measured first: without it a filled
 * field would prove nothing about the button. `inputValue()` does not wait, which is why the
 * waiting assertion stands before it and the read-out after it.
 */
async function fillWithSampleValues(page: Page): Promise<string> {
  const nameField = page.getByLabel(new RegExp(NAME_LABEL, 'u'));
  await expect(nameField).toHaveValue('');

  await page.getByRole('button', { name: 'Beispielwerte eintragen' }).click();

  await expect(
    nameField,
    'Nach „Beispielwerte eintragen" muss in dem Feld etwas stehen — ein ' +
      'Generator, der nichts einträgt, ist genau der Fall, den dieser Knopf ' +
      'verspricht abzudecken.',
  ).toHaveValue(/\S/u);
  return nameField.inputValue();
}

test.describe('Testmodus über die Navigation', () => {
  test('ist im Subheader erreichbar, füllt Beispielwerte, und der Testlauf schreibt weder Antwort noch Mail', async ({
    page,
    browser,
  }) => {
    // --- build --------------------------------------------------------------
    const title = await newForm(page, 'Testmodus');
    const formId = formIdOf(page);
    const officeAddress = officeAddressFor(Date.now().toString(36));

    await addQuestion(page, 'Text', NAME_LABEL);
    /*
      A mandatory field, and that carries an assertion: were the sample values
      empty or invalid, the test run below would not even get as far as the
      panel — `FillIn`'s page check would stop it. Addressed by **role**,
      not by `getByLabel`: as soon as a question is mandatory, its card in the
      preview itself carries an `aria-label="Pflichtfeld"` (a finding from
      `durchlauf-funktionsumfang.spec.ts`).
    */
    await page
      .getByRole('checkbox', { name: 'Pflichtfeld', exact: true })
      .check();
    await addQuestion(page, 'E-Mail', MAIL_LABEL);
    await saveForm(page);

    const nameQuestionId = await page
      .locator('[data-question-id]')
      .first()
      .getAttribute('data-question-id');
    expect(nameQuestionId, 'Die erste Frage trägt keine Id.').not.toBeNull();

    // --- publish ------------------------------------------------------------
    const publicPath = await publishAndReadPath(page);

    // --- a notification, so that there is a mail row to count ---------------
    await openFormNavEntry(page, 'Benachrichtigungen');
    await page.getByRole('button', { name: '+ Neue Benachrichtigung' }).click();
    await editorField(page, 'Name').fill(NOTIFICATION_NAME);
    await editorField(page, 'Text').fill('Es ist eine Anmeldung eingegangen.');
    await editor(page)
      .getByRole('textbox', { name: /Weitere Adressen/u })
      .fill(officeAddress);
    /*
      The subject last, and then the placeholder chip: the editor inserts at
      the caret of the **last focused** field
      (`NotificationEditor`, `setTarget` on `onFocus`). It is the placeholder in
      the subject that binds the mail preview of the test run below to the
      sample values — without it the preview would show a fixed sentence and stay
      green, whatever the generator produces.
    */
    await editorField(page, 'Betreff').fill('Anmeldung von ');
    await page
      .getByTestId(`placeholder-chip-question-${nameQuestionId ?? ''}`)
      .click();
    await page.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(
      editor(page).getByText('Gespeichert', { exact: true }),
    ).toBeVisible();

    // --- a real submission, without a session -------------------------------
    // It is the positive evidence for the two counters further down: only once
    // they each show 1 does „still 1" after the test run say anything.
    const guestContext = await browser.newContext();
    try {
      const guest = await guestContext.newPage();
      await guest.goto(publicPath);
      await expect(
        guest.getByRole('heading', { level: 1, name: title }),
      ).toBeVisible();
      await guest.getByLabel(new RegExp(NAME_LABEL, 'u')).fill(GUEST_NAME);
      await guest
        .getByLabel(new RegExp(MAIL_LABEL, 'u'))
        .fill('anton@example.invalid');
      await guest.getByRole('button', { name: 'Absenden' }).click();
      await expect(
        guest.getByRole('heading', { level: 1, name: 'Vielen Dank!' }),
      ).toBeVisible();
    } finally {
      await guestContext.close();
    }

    // --- the counters, beforehand -------------------------------------------
    // `Antwort(en)?`, not `Antworten?` — the second one demands „Antworte" and
    // precisely misses the singular „1 Antwort". The expression is anchored, so
    // that it does not take the line of the export menu („… wird 1 Antwort …") along.
    const responseCount = page.getByText(/^\d+ Antwort(en)?$/u);
    const mailTotal = page.getByTestId('kpi-total');

    await openFormNavEntry(page, 'Antworten');
    await expect(
      page.getByRole('heading', { level: 1, name: `Antworten · ${title}` }),
    ).toBeVisible();
    await expect(responseCount).toHaveText('1 Antwort');
    await expect(page.getByRole('cell', { name: GUEST_NAME })).toBeVisible();

    await openFormNavEntry(page, 'E-Mail-Versandprotokoll');
    await expect(page.getByTestId('form-filter')).toHaveText(
      `Nur Formular: ${title}`,
    );
    await expect(mailTotal).toHaveText('1Gesamt');
    await expect(
      page.locator('[data-testid^="mail-log-row-"]').filter({
        hasText: officeAddress,
      }),
    ).toHaveCount(1);

    // --- the way in: the switch of the handoff ------------------------------
    // Over the address bar this case would never have found the finding — that
    // is exactly why it clicks.
    await openFormNavEntry(page, 'Bearbeiten');
    await expect(page).toHaveURL(/\/forms\/[^/]+$/u);
    await openFormNavEntry(page, 'Vorschau');

    await expect(page).toHaveURL(/\/forms\/[^/]+\/preview$/u);
    await expect(
      formNav(page).getByRole('button', { name: 'Vorschau', exact: true }),
      'Der Eintrag markiert sich als aktuelle Seite — sonst ist die Ansicht ' +
        'zwar gerendert, aber die Navigation weiß es nicht.',
    ).toHaveAttribute('aria-current', 'page');

    // --- the bar ------------------------------------------------------------
    await expectTestModeBar(page);

    // --- the sample values --------------------------------------------------
    const sampleName = await fillWithSampleValues(page);
    await expect(
      page.getByLabel(new RegExp(MAIL_LABEL, 'u')),
      'Der Beispielwert einer E-Mail-Frage muss eine Adresse sein — sonst ' +
        'käme der Testlauf an der Schema-Prüfung von `FillIn` nicht vorbei.',
    ).toHaveValue(/^[^@\s]+@[^@\s]+$/u);
    expect(
      sampleName,
      'Der Beispielwert darf nicht die echte Antwort von oben sein — er kommt ' +
        'aus dem Generator, nicht aus der Datenbank.',
    ).not.toBe(GUEST_NAME);

    // --- the test run -------------------------------------------------------
    await page.getByRole('button', { name: 'Testlauf starten' }).click();

    const runPanel = page.getByRole('region', { name: 'Testlauf' });
    await expect(runPanel).toBeVisible();
    await expect(page.getByTestId('run-nothing')).toContainText(
      'Es wurde nichts gespeichert und nichts versendet',
    );
    await expect(runPanel.getByRole('heading', { level: 3 })).toContainText([
      NOTIFICATION_NAME,
      'E-Mail-Vorschau',
    ]);
    await expect(page.getByTestId('preview-recipients')).toContainText(
      officeAddress,
    );
    /*
      The line that binds the test run to the sample values: the subject is
      rendered with **this** run. If a different name stood here, the
      trial run would not have used the values that were in the fields a
      second before.
    */
    await expect(page.getByTestId('preview-subject')).toHaveText(
      `Anmeldung von ${sampleName}`,
    );

    // --- the counter-check: nothing has been added --------------------------
    await openFormNavEntry(page, 'Antworten');
    await expect(
      page.getByRole('heading', { level: 1, name: `Antworten · ${title}` }),
    ).toBeVisible();
    await expect(
      responseCount,
      'Ein Testlauf darf keine `response`-Zeile erzeugen — „2 Antworten" ' +
        'hier wäre der Befund, für den es diesen Fall gibt.',
    ).toHaveText('1 Antwort');

    await openFormNavEntry(page, 'E-Mail-Versandprotokoll');
    await expect(page.getByTestId('form-filter')).toHaveText(
      `Nur Formular: ${title}`,
    );
    await expect(
      mailTotal,
      'Ein Testlauf darf keine `mail_log`-Zeile erzeugen — er zeigt, was ' +
        'hinausginge, und schickt nichts.',
    ).toHaveText('1Gesamt');

    // --- free of residue ----------------------------------------------------
    await purgeForm(page, formId);
    await expectFormIsGone(page, formId, title);
  });
});

/**
 * The same way at 360 px — and there it is a **different** way: below
 * 1180 px the shell does not render the subheader at all, the entries live alone
 * in the off-canvas sheet. „Läuft mobil" therefore means first of all: getting in
 * through this sheet at all.
 *
 * A block of its own with its own `test.use` instead of a second file in the
 * mobile project, following the pattern of `builder-drag`, `notifications` and
 * `conditional-logic`: the case writes a form, and a second run of
 * the same file would double that residue without proving anything the
 * block here does not show.
 */
test.describe('Testmodus über das mobile Menü (360 px)', () => {
  test.use({ viewport: { width: 360, height: 740 }, hasTouch: true });

  test('ist über das Off-Canvas-Sheet erreichbar und ohne horizontalen Überhang bedienbar', async ({
    page,
  }) => {
    const title = await newForm(page, 'Testmodus mobil');
    const formId = formIdOf(page);

    await addQuestion(page, 'Text', NAME_LABEL);
    await saveForm(page);

    // The subheader does not exist at this width — the way in cannot be
    // any other one here than the sheet.
    await expect(formNav(page)).toHaveCount(0);

    const { sheet } = await openMobileMenu(page);
    await expect(
      sheet.getByText('Aktuelles Formular', { exact: true }),
    ).toBeVisible();
    await sheet.getByRole('button', { name: 'Vorschau', exact: true }).click();

    await expect(page).toHaveURL(/\/forms\/[^/]+\/preview$/u);
    await expectTestModeBar(page);

    const sampleName = await fillWithSampleValues(page);

    await page.getByRole('button', { name: 'Testlauf starten' }).click();
    await expect(page.getByRole('region', { name: 'Testlauf' })).toBeVisible();
    await expect(page.getByTestId('run-nothing')).toContainText(
      'Es wurde nichts gespeichert und nichts versendet',
    );
    /*
      This form has no notification, and the test run says so
      instead of keeping quiet — the statement „bei einer echten Absendung ginge
      keine E-Mail hinaus" is the half of the mail preview that can be made at all
      on a form without recipients.
    */
    await expect(
      page.getByText('Bei einer echten Absendung ginge keine E-Mail hinaus', {
        exact: false,
      }),
    ).toBeVisible();
    expect(sampleName.length).toBeGreaterThan(0);

    await expectNoHorizontalScroll(page, 'Testmodus (360 px)');

    await purgeForm(page, formId);
    await expectFormIsGone(page, formId, title);
  });
});

/**
 * **The unsaved state — review finding 21.**
 *
 * Before this work the tab „Vorschau" was a silent loss of data: the
 * builder emptied its store on leaving, the preview read the
 * *saved* draft from the server, and there was no navigation block anywhere in
 * the frontend that would have asked beforehand. Whoever renamed a question and
 * wanted to look at how it appears got the old name to see — and
 * had lost the new one in doing so.
 *
 * The case walks the way as a whole, because only the chain covers the finding:
 * edit → **unasked** into the preview (nothing is lost there, so
 * there is nothing to ask) → back into the builder, where the change is still
 * standing → and then on to a tab that *would lose* it, where the dialog comes.
 *
 * A block of its own in this file instead of a spec file of its own: the file is
 * already registered in the desktop project, and the way this case walks
 * is the same „Bearbeiten ↔ Vorschau" switch this file is about
 * anyway. A new file would need an entry in `playwright.config.ts`.
 */
test.describe('Vorschau mit ungespeichertem Stand', () => {
  test('zeigt die ungespeicherte Änderung, und der Weg zu einem anderen Reiter fragt vorher', async ({
    page,
  }) => {
    const title = await newForm(page, 'Ungespeicherter Entwurf');
    const formId = formIdOf(page);

    await addQuestion(page, 'Text', NAME_LABEL);
    await saveForm(page);

    // The one change this is about — typed and **not** saved.
    const changedLabel = 'Mitgliedsnummer';
    await page.getByLabel('Fragetext').fill(changedLabel);
    await expect(saveState(page)).toHaveText('Nicht gespeichert');

    // --- Bearbeiten → Vorschau: unasked, and the new state is visible -------
    await openFormNavEntry(page, 'Vorschau');

    await expect(page).toHaveURL(/\/forms\/[^/]+\/preview$/u);
    await expect(
      page.getByRole('dialog', { name: 'Ungespeicherte Änderungen' }),
      'Der Weg in die Vorschau verliert nichts mehr, also fragt er auch nicht.',
    ).toHaveCount(0);
    await expectTestModeBar(page);

    // The unsaved question text is in the form …
    await expect(page.getByLabel(new RegExp(changedLabel, 'u'))).toBeVisible();
    // … the saved one is not any more …
    await expect(page.getByLabel(new RegExp(NAME_LABEL, 'u'))).toHaveCount(0);
    // … and the view says that it shows an unsaved state.
    await expect(page.getByTestId('preview-draft-note')).toContainText(
      'ungespeicherten',
    );

    // --- and back: the change is still there --------------------------------
    await openFormNavEntry(page, 'Bearbeiten');
    await expect(page.getByLabel('Fragetext')).toHaveValue(changedLabel);
    await expect(saveState(page)).toHaveText('Nicht gespeichert');

    // --- a tab that would lose it: the confirmation first --------------------
    await openFormNavEntry(page, 'Antworten');

    const dialog = page.getByRole('dialog', {
      name: 'Ungespeicherte Änderungen',
    });
    await expect(dialog).toBeVisible();
    // The address has not moved: the question is asked over the page one
    // wanted to leave.
    await expect(page).toHaveURL(new RegExp(`/forms/${formId}$`, 'u'));

    // „Abbrechen" stays.
    await dialog.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByLabel('Fragetext')).toHaveValue(changedLabel);

    // „Verwerfen" carries on and throws away.
    await openFormNavEntry(page, 'Antworten');
    await page
      .getByRole('dialog', { name: 'Ungespeicherte Änderungen' })
      .getByRole('button', { name: 'Verwerfen' })
      .click();
    await expect(page).toHaveURL(/\/forms\/[^/]+\/responses$/u);

    // And what was discarded is really gone: the builder shows the state that
    // was saved again.
    await openFormNavEntry(page, 'Bearbeiten');
    await expect(saveState(page)).toHaveText('Gespeichert');

    // Discarding reloads the form, and a freshly loaded form
    // has **no** selected question — `keyboard-flow.spec.ts` records exactly
    // that. So the card has to open first before the question text is there.
    await expect(page.getByLabel('Fragetext')).toHaveCount(0);
    await page.getByRole('button', { name: /bearbeiten$/u }).click();
    await expect(page.getByLabel('Fragetext')).toHaveValue(NAME_LABEL);

    await purgeForm(page, formId);
    await expectFormIsGone(page, formId, title);
  });
});
