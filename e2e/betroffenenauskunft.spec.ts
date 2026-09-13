import { readFile } from 'node:fs/promises';

import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  addQuestion,
  newForm,
  publishAndReadPath,
  saveForm,
} from './app-flows';
import { authStateFile } from './seed-account';

/**
 * **Information and erasure for a data subject, driven through the
 * surface** .
 *
 * Participants have **no account** (data minimisation). That is the
 * strength of the design and at the same time the reason why „alle Daten zu Person X"
 * is not a query but a **route**: search → read the detail → export
 * (information) or delete → trash → delete permanently (erasure, physical).
 * This case walks it once in full, with a person that exists only in this run.
 *
 * ## Why something is put in first, and expressly so
 *
 * **This very assertion was once green, because nothing was ever put into the
 * trash.** A „nach dem Löschen ist nichts mehr da" over
 * an empty table is not a measurement but a tautology. Every
 * remnant the case looks for at the end is therefore **seen** beforehand: the
 * answer in the table, the attachment as delivered bytes, the row in the
 * mail log with the person's address — and the row in the trash,
 * before „Endgültig löschen" is pressed.
 *
 * ## The three remnants that are checked afterwards
 *
 * 1. **the answer** — it no longer stands in the table, and the trash
 *    does not know it any more either,
 * 2. **the attachment** — the protected retrieval address answers `404`; it gave
 *    `200` and the right bytes before. That is the byte step at which a
 *    permanent deletion that takes only the row fails,
 * 3. **the `mail_log` row** — it **stays** (operational record: „wie ging es
 *    aus und über welchen Mailserver"), but no longer carries the person's address,
 *    carrying „(endgültig gelöscht)" instead.
 *
 * ## What this case cannot do
 *
 * A mail that has already been **sent** lies outside the application and cannot be
 * recalled. The E2E environment has no SMTP access, so the row
 * waits in the queue — which suffices for this proof, because
 * what is checked is the **column**, not the dispatch. The boundary itself belongs in
 * the guide (`docs/kb/09-betrieb.md`) and in
 * [`10-datenschutz.md`](../docs/kb/10-datenschutz.md) section 2.3.
 */

test.use({ storageState: authStateFile });

const TRASH_PATH = '/admin/trash';

/**
 * Three question texts **without a common substring**.
 *
 * Playwright looks for an accessible name as a substring, and the lesson
 * drawn from that stands written out in `trash-purge.spec.ts`: as soon as a name
 * carries user data, it collides with every loose pattern. Here the three
 * part company in the very first word.
 */
const NAME_LABEL = 'Vollständiger Name';
const MAIL_LABEL = 'Adresse für die Bestätigung';
const FILE_LABEL = 'Nachweis zur Person';

const ATTACHMENT_NAME = 'Bescheinigung.pdf';
/** A **real** PDF signature: the server checks offset 0 (ADR-0014 no. 5). */
const ATTACHMENT_BYTES = Buffer.from('%PDF-1.7\nBescheinigung Widerruf\n');

/** Every row of the mail log — counted, never the table. */
function mailRows(page: Page): Locator {
  return page.locator('[data-testid^="mail-log-row-"]');
}

function formNav(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Aktuelles Formular' });
}

async function openFormNavEntry(page: Page, label: string): Promise<void> {
  await formNav(page).getByRole('button', { name: label, exact: true }).click();
}

/** One text field of the notification editor, by role and exact name. */
function notificationField(page: Page, name: string): Locator {
  return page
    .getByRole('region', { name: 'Benachrichtigung' })
    .getByRole('textbox', { name, exact: true });
}

/** The question id of the card at this position in the builder. */
async function questionIdAt(page: Page, index: number): Promise<string> {
  const card = page.locator('[data-question-id]').nth(index);
  await expect(card).toBeVisible();
  const id = await card.getAttribute('data-question-id');
  expect(id, `Frage ${String(index)} trägt keine Kennung`).not.toBeNull();
  return id ?? '';
}

/** The exported CSV as rows of fields — `;`-separated, without BOM/CRLF. */
function parseCsv(raw: string): string[][] {
  const withoutBom = raw.startsWith('﻿') ? raw.slice(1) : raw;
  return withoutBom
    .split('\r\n')
    .filter((line) => line !== '')
    .map((line) => line.split(';'));
}

/** Downloads the CSV of the visible view — the **information**. */
async function downloadCsv(page: Page): Promise<string[][]> {
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export' }).click();
  await page.getByRole('link', { name: 'CSV' }).click();
  const download = await downloading;
  return parseCsv(await readFile(await download.path(), 'utf8'));
}

test.describe('Auskunft und Löschung einer betroffenen Person ', () => {
  test('findet die Person, gibt Auskunft, löscht endgültig — und danach hält weder Antwort noch Anlage noch Protokollzeile ihren Inhalt', async ({
    page,
    browser,
  }) => {
    // One run through the builder, public filling in, evaluation, trash
    // and mail log — the default 30 s do not suffice for that.
    test.setTimeout(240_000);

    const run = Date.now().toString(36);
    /**
     * The data subject — **unique per run**, for the same reason
     * `newForm` makes its title unique: the search and the
     * mail log have to be able to tell this row apart from that of every earlier
     * run. `.invalid` can never resolve (RFC 2606).
     */
    const person = `Wilhelmine Widerruf ${run}`;
    const personAddress = `widerruf-${run}@example.invalid`;

    // --- building ------------------------------------------------------------
    const title = await newForm(page, 'Betroffenenauskunft');
    const formId = /\/forms\/([^/]+)/u.exec(page.url())?.[1];
    if (formId === undefined) {
      throw new Error(`Aus ${page.url()} war keine Formular-Kennung zu lesen.`);
    }

    await addQuestion(page, 'Text', NAME_LABEL);
    await addQuestion(page, 'E-Mail', MAIL_LABEL);
    await addQuestion(page, 'Datei-Upload', FILE_LABEL);
    await saveForm(page);

    // Read before leaving the builder — the id of the address question is
    // what the notification is about to point at.
    const mailQuestionId = await questionIdAt(page, 1);

    const publicPath = await publishAndReadPath(page);

    // --- the confirmation that produces the `mail_log` row --------------------
    // Addressed to a **question**, not to a fixed address: only that way does
    // the log row carry a personal datum **out of the answer**
    //  — and it is exactly this datum that has to have vanished
    // at the end.
    await openFormNavEntry(page, 'Benachrichtigungen');
    await page.getByRole('button', { name: '+ Neue Benachrichtigung' }).click();
    await notificationField(page, 'Name').fill('Bestätigung an die Person');
    await notificationField(page, 'Betreff').fill(
      `Ihre Meldung zu ${title} ist angekommen`,
    );
    await notificationField(page, 'Text').fill(
      'Vielen Dank, Ihre Meldung liegt vor.',
    );
    await page.getByTestId(`recipient-question-${mailQuestionId}`).click();
    await page.getByRole('button', { name: 'Speichern', exact: true }).click();
    // `exact`, and that is the whole gate: the state has three texts, and
    // `getByText` matches a substring — without `exact` the assertion would be
    // true as soon as the editor has rendered (measured on 2026-07-31,
    // `mail-log.spec.ts`).
    await expect(
      page
        .getByRole('region', { name: 'Benachrichtigung' })
        .getByText('Gespeichert', { exact: true }),
    ).toBeVisible();

    /*
      --- no second switch any more ------------------------------------------

      The configured notification alone triggers the dispatch —
      „Bestätigung an Teilnehmer senden" as an additional switch does not
      exist (ADR-0011).

      For this file that is more than a struck-out preparation: the
      confirmation mail is the personal-data processing this is
      about. That it comes into being **without** an additional manual step is exactly the
      state the information further down has to depict.
    */

    // --- putting in: filling in publicly, without a cookie --------------------
    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);
      await expect(
        guest.getByRole('heading', { level: 1, name: title }),
      ).toBeVisible();

      await guest.getByLabel(new RegExp(NAME_LABEL, 'u')).fill(person);
      await guest.getByLabel(new RegExp(MAIL_LABEL, 'u')).fill(personAddress);
      await guest.getByLabel(new RegExp(FILE_LABEL, 'u')).setInputFiles({
        name: ATTACHMENT_NAME,
        mimeType: 'application/pdf',
        buffer: ATTACHMENT_BYTES,
      });
      await expect(guest.getByText(ATTACHMENT_NAME)).toBeVisible();

      await guest.getByRole('button', { name: 'Absenden' }).click();
      await expect(
        guest.getByRole('heading', { level: 1, name: 'Vielen Dank!' }),
      ).toBeVisible();
    } finally {
      await guestContext.close();
    }

    // --- searching: the first step of an information request ------------------
    await page.goto(`/forms/${formId}/responses`);
    await expect(
      page.getByRole('heading', { level: 1, name: `Antworten · ${title}` }),
    ).toBeVisible();

    await page
      .getByRole('searchbox', { name: 'Antworten durchsuchen' })
      .fill(person);
    // The toolbar's count, not `getByRole('status')`: the counter
    // is one live region among several on this page, and „1 Antwort"
    // is exactly the statement an information request needs.
    await expect(
      page.locator('.responses__count'),
      'Die Suche über den Namen findet genau die eine Antwort dieser Person — ' +
        'das ist der Handgriff, den eine Auskunft wirklich braucht, weil es ' +
        'kein Teilnehmerkonto gibt, das man abfragen könnte.',
    ).toHaveText('1 Antwort');
    await expect(page.getByRole('cell', { name: person })).toBeVisible();

    // --- reading the detail, and **really** fetching the attachment -----------
    await page
      .getByRole('row')
      .filter({ hasText: person })
      .getByRole('button', { name: 'Ansehen' })
      .click();
    const detail = page.getByRole('dialog', { name: 'Antwort' });
    await expect(detail).toBeVisible();
    await expect(detail.getByText(person)).toBeVisible();
    const fileHref = await detail
      .getByRole('link', { name: ATTACHMENT_NAME })
      .getAttribute('href');
    await detail.getByRole('button', { name: 'Schließen' }).click();
    expect(fileHref).toMatch(/^\/api\/responses\/files\/[A-Za-z0-9_-]+$/u);

    const before = await page.request.get(fileHref ?? '');
    expect(before.status(), 'Die Anlage ist vor dem Löschen abrufbar').toBe(
      200,
    );
    expect(
      (await before.body()).equals(ATTACHMENT_BYTES),
      'Und es sind **ihre** Bytes — sonst prüfte der 404 am Ende das ' +
        'Verschwinden von irgendetwas.',
    ).toBe(true);

    // --- exporting: the information -------------------------------------------
    const rows = await downloadCsv(page);
    const flat = rows.flat().join(';');
    expect(
      flat,
      'Der Export der gefilterten Sicht ist die Auskunft, die hinausgeht.',
    ).toContain(person);
    expect(flat).toContain(personAddress);
    expect(
      flat,
      'Der Name der Anlage gehört hinein, die Abrufadresse nicht  ' +
        '— ein Export liegt am Ende auf Netzlaufwerken.',
    ).toContain(ATTACHMENT_NAME);
    expect(flat).not.toContain('/api/responses/files/');

    // --- the log row, **before** anything is deleted ---------------------------
    await page.goto(`/mail-log/${formId}`);
    await expect(
      page.getByRole('heading', { level: 1, name: 'E-Mail-Versandprotokoll' }),
    ).toBeVisible();
    await expect(
      mailRows(page).filter({ hasText: personAddress }),
      'Eine Zeile trägt die Adresse der Person — die Bestätigung geht an die ' +
        'Adresse aus der Antwort selbst. Ohne diese Zusicherung ' +
        'wäre das „(endgültig gelöscht)" am Ende die Beschreibung einer ' +
        'Tabelle, in der nie etwas stand.',
    ).toHaveCount(1);

    // --- deleting: into the trash ---------------------------------------------
    await page.goto(`/forms/${formId}/responses`);
    await page
      .getByRole('row')
      .filter({ hasText: person })
      .getByRole('button', { name: 'Ansehen' })
      .click();
    await page.getByTestId('responses-detail-delete').click();
    await page.getByRole('button', { name: 'In den Papierkorb legen' }).click();
    await expect(page.getByRole('cell', { name: person })).toHaveCount(0);

    // --- and there it lies too, demonstrably ----------------------------------
    await page.goto(TRASH_PATH);
    const trashRow = page
      .getByTestId('trash-deleted-response')
      .filter({ hasText: title });
    await expect(
      trashRow,
      'Der Papierkorb hält die Antwort 30 Tage — **und dass sie darin liegt, ' +
        'ist der Teil, den eine frühere Fassung übersprungen hatte.**',
    ).toHaveCount(1);

    // --- deleting permanently --------------------------------------------------
    await trashRow.getByRole('button', { name: 'Endgültig löschen' }).click();
    // Scoped to the confirmation prompt, not to the row: the trigger shares its
    // name with the confirming button, and as soon as both are on the screen,
    // a search by name alone matches two elements
    // (`trash-purge.spec.ts` describes the same case).
    await trashRow
      .locator('.trash-row__confirm')
      .getByRole('button', { name: 'Endgültig löschen' })
      .click();
    await expect(trashRow).toHaveCount(0);

    // --- afterwards: remnant 1, the answer -------------------------------------
    await page.goto(`/forms/${formId}/responses`);
    await expect(page.getByRole('cell', { name: person })).toHaveCount(0);
    await expect(
      page.getByText('Für dieses Formular gibt es noch keine Antworten.'),
    ).toBeVisible();

    // --- remnant 2, the attachment — the byte step ------------------------------
    const after = await page.request.get(fileHref ?? '');
    expect(
      after.status(),
      'Die Anlage ist physisch fort. **Diese Zusicherung ist die, die rot ' +
        'wird, wenn das endgültige Löschen nur die Zeile nimmt und die Bytes ' +
        'stehen lässt** — dieselbe Adresse gab eben noch 200 und den richtigen ' +
        'Inhalt.',
    ).toBe(404);

    // --- remnant 3, the log row ------------------------------------------------
    await page.goto(`/mail-log/${formId}`);
    await expect(
      page.getByRole('heading', { level: 1, name: 'E-Mail-Versandprotokoll' }),
    ).toBeVisible();
    await expect(
      mailRows(page).filter({ hasText: personAddress }),
      'Nach dem endgültigen Löschen steht die Adresse der Person nirgends ' +
        'mehr im Protokoll.',
    ).toHaveCount(0);
    await expect(
      mailRows(page).filter({ hasText: '(endgültig gelöscht)' }),
      'Die Zeile selbst bleibt — „wie ging es aus und über welchen Mailserver" ' +
        'ist der Betriebsnachweis, den das endgültige Löschen ausdrücklich stehen lässt. Geleert ' +
        'wird die Spalte, nicht die Zeile.',
    ).toHaveCount(1);
  });
});
