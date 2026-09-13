import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  addQuestion,
  expectDashboard,
  newForm,
  publishAndReadPath,
  saveForm,
} from './app-flows';
import { authStateFile } from './seed-account';

/**
 * The half of the requirement that was missing before now: a way
 * *into* the trash from the surface, not only the API
 * (`e2e/trash.spec.ts` had to move a form there through `page.request`
 * because no button existed). This file is the genuine round trip the two
 * halves promise together — „× Löschen" on the Dashboard, the row shows up
 * in the trash, „Wiederherstellen" there, and it is back — driven
 * entirely through the UI, in one real browser, against the real API.
 *
 * **Both reversible delete controls live here**, the Dashboard card's and the
 * answer detail's: they are the same act — one thing into
 * the trash, restorable for 30 days — and the second block below is the
 * browser evidence the answer-detail path had none of, including the only
 * `useFocusTrap` `fallbackRef` in the application (whose own docblock says
 * „jsdom focuses it anyway, so no component test can see this").
 *
 * The traps named in the work order, each with its own evidence:
 *
 * 1. **Reversible, said as such.** The confirmation names the trash and
 *    the 30-day window, never „endgültig" — asserted on the confirmation's
 *    own text, not only on the route it calls. And it *looks* reversible:
 *    {@link readConfirmTone} measures the rendered box and button against the
 *    endgültig one in the trash, because the difference used to live in
 *    the sentence alone (review finding 2).
 * 2. **Focus after the card leaves the grid**, measured with `toBeFocused()`
 *    in a real browser rather than claimed in jsdom (`DashboardView.test.tsx`
 *    covers the same shape there; this is what a browser adds on top).
 * 3. **The round trip itself** — the form is on the Dashboard, gone after
 *    „× Löschen", present in the trash, and back on the Dashboard after
 *    „Wiederherstellen", with zero residue left in this organisation at the end.
 *
 * **Zero residue is now kept rather than claimed** (review finding 7). Both
 * cases used to end with their form still in the organisation — case 1 active again,
 * case 2 in the trash — and `newForm` stamps a timestamp into every
 * title, so each run grew this organisation by two forms. That is the same
 * accumulation that got `durchlauf-organisationen` taken out of the default run, in the file
 * whose whole subject is the machinery against it. Both cases now close with
 * {@link purgeForm}.
 */

test.use({ storageState: authStateFile });

const TRASH_PATH = '/admin/trash';

/**
 * The CSRF header every mutating request needs (`apps/web/src/api/http.ts`).
 * `page.request` shares the browser context's cookie jar, so only the header —
 * the second half of the double-submit — is this helper's job.
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

/** The form id out of the builder's address — `newForm` leaves the page there. */
function formIdOf(page: Page): string {
  const id = /\/forms\/([^/?#]+)/u.exec(page.url())?.[1];
  if (id === undefined) {
    throw new Error(`Could not read the form id from ${page.url()}.`);
  }
  return id;
}

/**
 * Removes a form from this organisation for good — the cleanup this file owes the
 * shared installation.
 *
 * Two requests, because `DELETE /api/forms/:id/permanent` only matches a form
 * that is **in** the trash (`ScopedFormDelegate.purgeForm`,
 * `deletedAt: { not: null }`): whatever state the case left it in, it goes
 * through the trash first. The trash delete therefore tolerates a 404 —
 * the case may have put it there already — while the permanent one does not.
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

/** What a `ConfirmPrompt` actually renders — not which class it carries. */
interface ConfirmTone {
  readonly boxBackground: string;
  readonly buttonBackground: string;
  readonly buttonColor: string;
  readonly buttonWeight: string;
}

/**
 * Measures an open confirmation, box and confirming button (review finding 2).
 *
 * `getComputedStyle` in the page, deliberately: the finding is about what a
 * person sees, and a class name is not that. The same measurement said the
 * reversible „× Löschen" and the irreversible „Endgültig löschen" were
 * pixel-for-pixel the same box, the same full red button and the same bold
 * weight — the difference lived in the sentence alone.
 */
async function readConfirmTone(
  box: Locator,
  confirmLabel: string,
): Promise<ConfirmTone> {
  const boxBackground = await box.evaluate(
    (element: object) => getComputedStyle(element).backgroundColor,
  );
  const button = box.getByRole('button', { name: confirmLabel });
  const buttonStyle = await button.evaluate((element: object) => {
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      color: style.color,
      weight: style.fontWeight,
    };
  });
  return {
    boxBackground,
    buttonBackground: buttonStyle.background,
    buttonColor: buttonStyle.color,
    buttonWeight: buttonStyle.weight,
  };
}

/**
 * Minimal browser globals for the `evaluate` callbacks above — the root
 * `tsconfig.json` covering `e2e/` has no DOM lib on purpose (`app-flows.ts`
 * says why). Declared ambiently and module-scoped; at run time these execute
 * in the real browser.
 */
declare function getComputedStyle(element: object): {
  readonly backgroundColor: string;
  readonly color: string;
  readonly fontWeight: string;
};

/** `--color-danger-strong`, as `getComputedStyle` reports it — never hex. */
const DANGER_STRONG = 'rgb(157, 28, 31)';

test.describe('Dashboard „× Löschen" ', () => {
  test('legt ein Formular reversibel in den Papierkorb, und von dort zurück auf das Dashboard', async ({
    page,
  }) => {
    const title = await newForm(page, 'Dashboard Löschen');
    const formId = formIdOf(page);

    // Back on the Dashboard through the SPA router — the card is real.
    await page.goto('/');
    await expectDashboard(page);
    const card = page.locator('.form-card').filter({ hasText: title });
    await expect(card).toHaveCount(1);

    await card.getByRole('button', { name: 'Löschen' }).click();

    // Trap 1: reversible, in words — not „endgültig".
    const question = card.getByRole('alert');
    await expect(question).toContainText('Papierkorb');
    await expect(question).toContainText('30 Tage');
    await expect(question).not.toContainText('endgültig');

    // …and reversible to the eye, measured (review finding 2). Kept for the
    // comparison against the endgültig confirmation further down.
    const reversibleTone = await readConfirmTone(
      question,
      'In den Papierkorb legen',
    );
    expect(reversibleTone.buttonBackground).not.toBe(DANGER_STRONG);

    await card.getByRole('button', { name: 'In den Papierkorb legen' }).click();

    // The card leaves the grid…
    await expect(card).toHaveCount(0);
    // …and trap 2: focus lands on the page's own heading, not on `<body>`.
    await expect(
      page.getByRole('heading', { name: 'Dashboard', level: 1 }),
    ).toBeFocused();
    await expect(page.locator('body')).not.toBeFocused();

    // Trap 3: the other half of the promise — it is genuinely in the
    // trash, reached over the navigation, not by address.
    await page.getByRole('button', { name: 'Papierkorb' }).click();
    await expect(page).toHaveURL(new RegExp(`${TRASH_PATH}$`, 'u'));
    const row = page
      .getByTestId('trash-deleted-form')
      .filter({ hasText: title });
    await expect(row).toHaveCount(1);

    /*
      The other half of the tone measurement, on this row's own „Endgültig
      löschen" — the act that genuinely cannot be taken back. Every one of the
      four properties has to differ from the reversible one above: box, fill,
      foreground and weight were all identical before, so an assertion on one
      of them alone would go green again the moment the next refactor unifies
      the other three.
    */
    await row.getByRole('button', { name: 'Endgültig löschen' }).click();
    const destructiveTone = await readConfirmTone(
      row.locator('.trash-row__confirm').getByRole('alert'),
      'Endgültig löschen',
    );
    expect(destructiveTone.buttonBackground).toBe(DANGER_STRONG);
    expect(destructiveTone.boxBackground).not.toBe(
      reversibleTone.boxBackground,
    );
    expect(destructiveTone.buttonColor).not.toBe(reversibleTone.buttonColor);
    expect(destructiveTone.buttonWeight).not.toBe(reversibleTone.buttonWeight);
    // The bold one is the irreversible one, not the other way round.
    expect(Number(destructiveTone.buttonWeight)).toBeGreaterThan(
      Number(reversibleTone.buttonWeight),
    );
    await row.getByRole('button', { name: 'Abbrechen' }).click();

    await row.getByRole('button', { name: 'Wiederherstellen' }).click();
    await expect(row).toHaveCount(0);

    /*
      Back on the Dashboard, the form is active again — the round trip closed.

      **`exact: true`, and that is not decoration** (measured 2026-09-13): the
      name matches by substring, and the Papierkorb this click starts from shows
      one „endgültig löschen" button per row whose accessible name carries the
      form's title (`TrashView.tsx`: `„${form.title}" endgültig löschen`). The
      case below in this very file creates a form called „Dashboard Abbrechen …"
      and puts it in the trash — in a parallel run its row stands here, and the
      unanchored name hit two elements at once („strict mode violation:
      resolved to 2 elements"). Exact, only the navigation entry of the header
      is called „Dashboard", the same anchoring `form-members.spec.ts` uses.
    */
    await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
    await expectDashboard(page);
    await expect(
      page.locator('.form-card').filter({ hasText: title }),
    ).toHaveCount(1);

    // Zero residue: and now it leaves this organisation for good.
    await purgeForm(page, formId);
    await page.goto('/');
    await expectDashboard(page);
    await expect(
      page.locator('.form-card').filter({ hasText: title }),
    ).toHaveCount(0);
  });

  test('ein Abbrechen lässt die Karte unangetastet', async ({ page }) => {
    const title = await newForm(page, 'Dashboard Abbrechen');
    const formId = formIdOf(page);

    await page.goto('/');
    await expectDashboard(page);
    const card = page.locator('.form-card').filter({ hasText: title });

    await card.getByRole('button', { name: 'Löschen' }).click();
    await card.getByRole('button', { name: 'Abbrechen' }).click();

    await expect(card).toHaveCount(1);
    await expect(card.getByRole('alert')).toHaveCount(0);

    // Cleanup: through the UI first, so the case still exercises the control
    // it is about, then for good — the trash is no longer an accepted
    // resting place for this suite's own leftovers (review finding 7).
    await card.getByRole('button', { name: 'Löschen' }).click();
    await card.getByRole('button', { name: 'In den Papierkorb legen' }).click();
    await expect(card).toHaveCount(0);
    await purgeForm(page, formId);
  });
});

/**
 * „Löschen" in the response detail view — the reversible
 * sibling of the case above, and the one control here with **no**
 * browser evidence at all (review finding 6).
 *
 * The reason it needs a browser rather than another jsdom case is written into
 * `useFocusTrap`'s `fallbackRef`: closing the panel first tries to give focus
 * back to the row button that opened it, and that button is gone by then —
 * the table has refetched without the deleted answer. A real browser refuses
 * `focus()` on a detached element and leaves focus on `<body>`; **jsdom
 * focuses it anyway**, which is the hook's own recorded finding and the reason
 * `ResponseDetailPanel`'s tests cannot speak for this line.
 */
test.describe('Antwort-Detail „Löschen" ', () => {
  const NAME_LABEL = 'Name des Mitglieds';

  test('legt eine Antwort in den Papierkorb und lässt den Fokus nicht ins Nichts fallen', async ({
    page,
    browser,
  }) => {
    const title = await newForm(page, 'Antwort Löschen');
    const formId = formIdOf(page);
    await addQuestion(page, 'Text', NAME_LABEL);
    await saveForm(page);
    const publicPath = await publishAndReadPath(page);

    // The answer comes from a stranger's browser, without a session — the only
    // honest way to produce one (no participant accounts).
    const guestContext = await browser.newContext();
    try {
      const guest = await guestContext.newPage();
      await guest.goto(publicPath);
      await guest.getByLabel(new RegExp(NAME_LABEL, 'u')).fill('Anton Aktiv');
      await guest.getByRole('button', { name: 'Absenden' }).click();
      await expect(
        guest.getByRole('heading', { level: 1, name: 'Vielen Dank!' }),
      ).toBeVisible();
    } finally {
      await guestContext.close();
    }

    await page.goto('/');
    await page
      .getByRole('article')
      .filter({ hasText: title })
      .getByRole('button', { name: 'Antworten' })
      .click();
    await expect(
      page.getByRole('heading', { level: 1, name: `Antworten · ${title}` }),
    ).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Anton Aktiv' })).toBeVisible();

    await page.getByRole('button', { name: 'Ansehen' }).first().click();
    const panel = page.getByRole('dialog', { name: 'Antwort' });
    await expect(panel).toBeVisible();

    await panel.getByRole('button', { name: 'Löschen' }).click();
    // Reversible, said as such — the same promise the Dashboard card makes.
    const question = panel.getByRole('alert');
    await expect(question).toContainText('Papierkorb');
    await expect(question).toContainText('30 Tage');
    await expect(question).not.toContainText('endgültig');

    await panel
      .getByRole('button', { name: 'In den Papierkorb legen' })
      .click();

    // The panel closes and the row is gone from the table…
    await expect(panel).toHaveCount(0);
    await expect(page.getByRole('cell', { name: 'Anton Aktiv' })).toHaveCount(
      0,
    );
    // …and the focus the opener could not take back landed on the view's own
    // `<h1>` instead of on `<body>` — the `fallbackRef` line itself.
    await expect(
      page.getByRole('heading', { level: 1, name: `Antworten · ${title}` }),
    ).toBeFocused();
    await expect(page.locator('body')).not.toBeFocused();

    // It really is in the trash, not merely off the table.
    await page.goto(TRASH_PATH);
    await expect(
      page.getByTestId('trash-deleted-response').filter({ hasText: title }),
    ).toHaveCount(1);

    // Zero residue: the form takes its answer with it.
    await purgeForm(page, formId);
  });
});
