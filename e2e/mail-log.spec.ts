import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  addQuestion,
  newForm,
  publishAndReadPath,
  saveForm,
} from './app-flows';
import { authStateFile } from './seed-account';

/**
 * E-Mail-Versandprotokoll in a real browser — the requirement, and the chain
 * that produces the rows it shows (the requirements).
 *
 * The single test below walks the whole way, because the assertions only mean
 * something together: **build → publish → fill in without a cookie → the rows
 * stand in the log → filter → „↻ Erneut"**. A suite that seeded
 * `mail_log` by hand would prove the view and nothing about the seam this
 * file is actually about — that a stranger's submission is what puts a
 * line there.
 *
 * ## Two rows, two states, and why both are reachable here
 *
 * The E2E environment has **no SMTP configuration** , so nothing
 * is delivered and no worker turns a line red. Both states the filter needs are
 * therefore produced by the *submission itself*:
 *
 * - **`queued`** — a notification addressed to a literal address. It waits, and
 *   the mail log says why („ein Grund, der im Versandprotokoll
 *   lesbar ist").
 * - **`failed`** — a notification whose recipient is a question that only
 *   exists in the **draft**. The published version the answer was written
 *   against does not carry it, so the address cannot be read out of the
 *   submission and `submission-mail.ts` writes the line as `failed` with a
 *   reason rather than dropping it silently. That is a real situation, not a
 *   contrivance: it is the gap between draft and version that the requirement
 *   locks at publish time and that this row is the after-image of.
 *
 * ## What is asserted, and what deliberately is not
 *
 * **Rows are counted**. „Die Tabelle ist sichtbar"
 * would stay green with the KPI tiles wired to „alle"; the number of
 * `mail-log-row-…` elements would not.
 *
 * The other half of „↻ Erneut" — *tatsächlich* erneut versucht, measured on the
 * transport counter — is **not** here and cannot be: a browser has no transport
 * to count. It is
 * `apps/api/test/mail-log/retry-really-sends.spec.ts`.
 */

test.use({ storageState: authStateFile });

const NAME_LABEL = 'Name des Mitglieds';
/** Two captions without a common substring, so `getByLabel` cannot confuse them. */
const PUBLISHED_MAIL_LABEL = 'Adresse des Mitglieds';
const DRAFT_ONLY_MAIL_LABEL = 'Postfach der Organisation';

/**
 * Where the office copy goes — **unique per run**, and that is not cosmetic.
 *
 * `.invalid` can never resolve (RFC 2606), so no run of this suite can post to
 * a real mailbox. The suffix is the part that was measured: `mail_log` rows are
 * kept for ninety days and there is no way to delete a form yet, so every
 * `pnpm e2e` leaves its two lines behind. With a fixed address the last
 * assertion of this test — „diese eine Zeile steht auch im Protokoll des ganzen
 * Organisation" — read 1 on the first run and 4 on the fourth. A test that passes only
 * on a fresh database is a test that will be „rerun" instead of read.
 */
function officeAddressFor(run: string): string {
  return `sekretariat-${run}@example.invalid`;
}

const OFFICE_NOTIFICATION = 'Anmeldung an das Sekretariat';
const ORPHANED_NOTIFICATION = 'Kopie an die zweite Adresse';

function formNav(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Aktuelles Formular' });
}

async function openFormNavEntry(page: Page, label: string): Promise<void> {
  await formNav(page).getByRole('button', { name: label, exact: true }).click();
}

function editor(page: Page): Locator {
  return page.getByRole('region', { name: 'Benachrichtigung' });
}

/**
 * One text field of the notification editor, by role and exact name.
 *
 * `getByLabel('Text')` would also find the *Nur Text* radio, and
 * `getByLabel('Name')` every placeholder chip whose question caption contains
 * „Name". Both are correct markup; the lookup has to be the precise one.
 */
function field(page: Page, name: string): Locator {
  return editor(page).getByRole('textbox', { name, exact: true });
}

/** Every row of the table — the thing that gets counted, never the table. */
function rows(page: Page): Locator {
  return page.locator('[data-testid^="mail-log-row-"]');
}

/** The id of the one row matching `recipient`, as its `data-testid` states it. */
async function rowIdOf(page: Page, recipient: string): Promise<string> {
  const row = rows(page).filter({ hasText: recipient });
  await expect(row).toHaveCount(1);
  const testId = await row.getAttribute('data-testid');
  expect(testId).not.toBeNull();
  return (testId ?? '').replace('mail-log-row-', '');
}

/**
 * One KPI tile, value **and** label in one assertion.
 *
 * `toContainText('2')` would also pass on „12", and these four numbers are the
 * whole point of the tiles — they have to be read exactly.
 */
async function expectKpi(
  page: Page,
  key: string,
  value: number,
  label: string,
): Promise<void> {
  await expect(page.getByTestId(`kpi-${key}`)).toHaveText(
    `${String(value)}${label}`,
  );
}

async function questionIdAt(page: Page, index: number): Promise<string> {
  const card = page.locator('[data-question-id]').nth(index);
  await expect(card).toBeVisible();
  const id = await card.getAttribute('data-question-id');
  expect(id, `question ${String(index)} carries no id`).not.toBeNull();
  return id ?? '';
}

/** Creates one notification through the editor and waits for the save. */
async function addNotification(
  page: Page,
  fields: {
    readonly name: string;
    readonly subject: string;
    readonly body: string;
    readonly addresses?: string;
    readonly questionId?: string;
  },
): Promise<void> {
  await page.getByRole('button', { name: '+ Neue Benachrichtigung' }).click();
  await field(page, 'Name').fill(fields.name);
  await field(page, 'Betreff').fill(fields.subject);
  await field(page, 'Text').fill(fields.body);

  if (fields.addresses !== undefined) {
    await editor(page)
      .getByRole('textbox', { name: /Weitere Adressen/u })
      .fill(fields.addresses);
  }
  if (fields.questionId !== undefined) {
    await page.getByTestId(`recipient-question-${fields.questionId}`).click();
  }

  await page.getByRole('button', { name: 'Speichern', exact: true }).click();
  // `exact`, and that is the whole gate rather than a detail of style.
  //
  // The badge has three texts — „Wird gespeichert…", „Nicht gespeichert",
  // „Gespeichert" — and `getByText` matches a **substring, case-insensitively**.
  // Without `exact` this locator matches all three, so the assertion was true
  // the instant the editor rendered and waited for nothing. The next line then
  // clicked „+ Neue Benachrichtigung" while the POST of *this* notification was
  // still in flight; its `onSuccess` pulled the editor back onto the row it had
  // just created and discarded the name typed since. Measured on 2026-07-31:
  // the run wrote **one** notification carrying the first one's name, the
  // second one's subject and both recipients, so the mail log showed
  // two rows with the same subject.
  await expect(
    editor(page).getByText('Gespeichert', { exact: true }),
  ).toBeVisible();
}

test.describe('Versandprotokoll (Rechte- und Mandantengrenze)', () => {
  test('führt eine Absendung ins Protokoll, filtert sie und reiht sie erneut ein', async ({
    page,
    browser,
  }) => {
    // --- build --------------------------------------------------------------
    const title = await newForm(page, 'Versandprotokoll');
    // The same uniqueness `newForm` gives the title, for the same reason: this
    // run's rows have to be tellable from every earlier run's.
    const officeAddress = officeAddressFor(Date.now().toString(36));
    await addQuestion(page, 'Text', NAME_LABEL);
    await addQuestion(page, 'E-Mail', PUBLISHED_MAIL_LABEL);
    await saveForm(page);

    // --- publish ------------------------------------------------------------
    const publicPath = await publishAndReadPath(page);

    // --- the second address question stays in the draft ---------------------
    // Saved but **not** published: this is what makes the second notification's
    // recipient unreadable for the submission below, and therefore the `failed`
    // row the filter and „↻ Erneut" need.
    await addQuestion(page, 'E-Mail', DRAFT_ONLY_MAIL_LABEL);
    await saveForm(page);

    const draftOnlyMailId = await questionIdAt(page, 2);

    // --- two notifications -------------------------------------------------
    await openFormNavEntry(page, 'Benachrichtigungen');

    await addNotification(page, {
      name: OFFICE_NOTIFICATION,
      subject: 'Neue Anmeldung zu {{formular}}',
      body: 'Es ist eine Anmeldung eingegangen.',
      addresses: officeAddress,
    });

    await addNotification(page, {
      name: ORPHANED_NOTIFICATION,
      subject: 'Kopie der Anmeldung',
      body: 'Kopie.',
      questionId: draftOnlyMailId,
    });

    /*
      --- and **no second switch** -------------------------------------------

      Until 2026-08-14 the detour stood here without which the second mail did
      not come into being at all: a notification addressed to a *question* is
      participant delivery, and that hung on „Bestätigung an Teilnehmer senden"
      in the form settings — a second gate whose default was **off**.
      Whoever had set up the notification had thereby sent nothing yet.

      The switch has been dropped without replacement (ADR-0011, continuation;
      finding 24). This file now measures that, instead of merely no longer
      doing it: the detour is **not** taken, and the row in the log has to come
      into being all the same. With that the case is the measurement of the new
      promise — „whoever sets up a notification to the person filling in has
      decided that it is sent" — and not just a test that is missing a row.

      The assertion below it is the counter-check: were the gate to come back in
      any shape, it would stand here — and this case would be red instead of
      quietly needing a detour again.
    */
    await openFormNavEntry(page, 'Formular-Einstellungen');
    await expect(
      page.getByRole('heading', { name: 'Formular-Einstellungen' }),
    ).toBeVisible();
    await expect(
      page.getByRole('switch', { name: /Teilnehmer/u }),
      'Die Teilnehmer-Mail darf hinter keinem zweiten Schalter mehr stehen. ' +
        'Taucht hier wieder einer auf, ist das Tor zurück — und eine ' +
        'eingerichtete Benachrichtigung geht wieder nicht raus.',
    ).toHaveCount(0);

    // --- fill in publicly, in a context without a cookie --------------------
    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);
      await expect(
        guest.getByRole('heading', { level: 1, name: title }),
      ).toBeVisible();
      // No login anywhere on the way in — the claim of the requirement.
      await expect(guest.getByRole('button', { name: 'Anmelden' })).toHaveCount(
        0,
      );

      await guest.getByLabel(new RegExp(NAME_LABEL, 'u')).fill('Anton Aktiv');
      await guest
        .getByLabel(new RegExp(PUBLISHED_MAIL_LABEL, 'u'))
        .fill('anton@example.invalid');
      // The draft-only question is not on the published form — the assertion
      // that the version, not the draft, is what a participant fills in.
      await expect(
        guest.getByLabel(new RegExp(DRAFT_ONLY_MAIL_LABEL, 'u')),
      ).toHaveCount(0);

      await guest.getByRole('button', { name: 'Absenden' }).click();
      await expect(
        guest.getByRole('heading', { level: 1, name: 'Vielen Dank!' }),
      ).toBeVisible();
    } finally {
      await guestContext.close();
    }

    // --- the rows stand in the log -----------------------------------------
    await openFormNavEntry(page, 'E-Mail-Versandprotokoll');
    await expect(
      page.getByRole('heading', { level: 1, name: 'E-Mail-Versandprotokoll' }),
    ).toBeVisible();

    // The prefilter the specification names the form one arrived from.
    await expect(page.getByTestId('form-filter')).toHaveText(
      `Nur Formular: ${title}`,
    );

    await expect(rows(page)).toHaveCount(2);
    await expectKpi(page, 'total', 2, 'Gesamt');
    await expectKpi(page, 'sent', 0, 'Zugestellt');
    await expectKpi(page, 'failed', 1, 'Fehlgeschlagen');
    await expectKpi(page, 'queued', 1, 'In Warteschlange');

    // The waiting line says **why** it waits — the E2E stack has
    // no mail server, and a queue that never moves without a stated reason is
    // exactly the failure this guards against.
    const waiting = rows(page).filter({ hasText: officeAddress });
    await expect(waiting).toContainText('In Warteschlange');
    await expect(waiting).toContainText(OFFICE_NOTIFICATION);
    await expect(waiting).toContainText(`Neue Anmeldung zu ${title}`);

    const broken = rows(page).filter({ hasText: ORPHANED_NOTIFICATION });
    await expect(broken).toContainText('Fehlgeschlagen');
    await expect(broken).toContainText(
      'Der Empfänger konnte aus dieser Antwort nicht gelesen werden',
    );

    // --- the KPI tiles are filters, and rows are counted ---------------
    await page.getByTestId('kpi-failed').click();
    // The **row count** first, and deliberately so: it is the assertion that
    // actually proves the filter worked. A tile wired to „alle" would still
    // light up, so `aria-pressed` alone proves the button and not the filter.
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('Fehlgeschlagen');
    await expect(page.getByTestId('kpi-failed')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // Clicking a tile must not zero the other three — they describe the organisation,
    // not the filtered table.
    await expectKpi(page, 'total', 2, 'Gesamt');
    await expectKpi(page, 'queued', 1, 'In Warteschlange');

    await page.getByTestId('kpi-queued').click();
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText(officeAddress);

    await page.getByTestId('kpi-sent').click();
    await expect(rows(page)).toHaveCount(0);
    await expect(page.getByText('Keine Einträge')).toBeVisible();

    // A second click on the active tile clears the filter — „Gesamt" is the
    // absence of a status, not a fourth one.
    await page.getByTestId('kpi-sent').click();
    await expect(rows(page)).toHaveCount(2);

    // --- „↻ Erneut" ---------------------------------------------------------
    const brokenId = await rowIdOf(page, ORPHANED_NOTIFICATION);
    // Only the failed line is offered the button.
    const waitingId = await rowIdOf(page, officeAddress);
    await expect(page.getByTestId(`retry-${waitingId}`)).toHaveCount(0);

    await page.getByTestId(`retry-${brokenId}`).click();

    await expect(page.getByTestId(`mail-log-row-${brokenId}`)).toContainText(
      'In Warteschlange',
    );
    await expect(page.getByTestId(`retry-${brokenId}`)).toHaveCount(0);
    await expectKpi(page, 'failed', 0, 'Fehlgeschlagen');
    await expectKpi(page, 'queued', 2, 'In Warteschlange');
    // Still two lines: a retry is another attempt at the same delivery, never a
    // second row.
    await expect(rows(page)).toHaveCount(2);

    // --- view the rendered mail ---------------------
    // The waiting line: its rendered body is what the office would eventually
    // receive, and the notification's format defaults to `html`, so this is
    // also the HTML half of the frame — the text half is
    // `MailLogView.test.tsx`'s job, a browser adds nothing to that assertion.
    await page.getByTestId(`view-${waitingId}`).click();
    const detailDialog = page.getByRole('dialog', { name: 'E-Mail ansehen' });
    await expect(detailDialog).toBeVisible();
    await expect(detailDialog).toContainText(officeAddress);
    await expect(detailDialog).toContainText(`Neue Anmeldung zu ${title}`);
    await expect(detailDialog).toContainText('In Warteschlange');
    await expect(detailDialog).toContainText('Beim Absenden');

    // The load-bearing property of `SandboxedHtmlFrame`: an empty sandbox.
    // Neither `allow-scripts` nor `allow-same-origin` may appear, or the
    // mail's own markup could reach back into this application — the same
    // assertion `NotificationPreview.test.tsx` and `MailLogView.test.tsx` make
    // without a real browser behind them.
    const bodyFrame = page.getByTestId('mail-log-body-frame');
    await expect(bodyFrame).toHaveAttribute('sandbox', '');
    // …and the content really did render, inside that frame's own document —
    // a real browser is what can tell `srcdoc` was executed at all.
    await expect(
      bodyFrame.contentFrame().getByText('Es ist eine Anmeldung eingegangen.'),
    ).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(detailDialog).toHaveCount(0);

    // --- clear the prefilter and back --------------------------------------
    await page.getByRole('button', { name: 'Filter aufheben' }).click();
    await expect(page).toHaveURL(/\/mail-log$/u);
    await expect(page.getByTestId('form-filter')).toHaveCount(0);
    // The organisation's whole log carries at least this form's two lines; earlier runs
    // of the suite leave theirs behind, so this is a lower bound on purpose.
    await expect(rows(page)).not.toHaveCount(0);
    await expect(rows(page).filter({ hasText: officeAddress })).toHaveCount(1);
  });
});
