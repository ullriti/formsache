import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  expectNoHorizontalScroll,
  expectSaved,
  newForm,
  openFormSettings,
} from './app-flows';
import { authStateFile } from './seed-account';

/**
 * Formular-Standards of the organisation.
 *
 * The inheritance is a unit-tested pure function; what this file measures
 * is that it is **observable in the running application**: change the
 * organisation's standard, and a form that follows it shows the new value while a form
 * that has taken the section over shows the old. That chain runs through two
 * pages, two documents and a query cache, and none of those are in the unit
 * test.
 *
 * **What changed, and why this file changed with it** (ADR-0011, continuation
 * 2026-08-14; findings 9, 10 and the second finding 10 of 2026-08-17). The
 * inheritance once had three layers, and this page sat in the middle: the
 * switch was called „Systemvorgabe ↔ Angepasst" and pointed at a system row
 * somebody could open. The row is gone, and with it — one step later — the
 * switch itself: below an organisation there are only the values this
 * application is shipped with. They now stand prefilled in the fields, the
 * organisation changes them, and **nothing on this page is locked any more**.
 * The second case below measures exactly that.
 *
 * The second change is a card that is **not** here any more: *Verfügbarkeit*.
 * An opening period, eine Frist and a participant limit belong to one form and
 * to no other; prescribed organisation-wide they would close registrations
 * nobody has looked at. The third case below is the measurement of that — it is
 * the only place in the suite that asserts the absence rather than assuming it.
 *
 * That absence is why the file no longer speaks of five sections anywhere: the
 * four that remain (`SECTION_DEFINITIONS` in `SettingsSectionFields.tsx`) are
 * the four that inherit.
 *
 * **Desktop project only, and that is correctness rather than budget.** This
 * file writes to the organisation's shared `form_defaults` row and puts the original
 * state back afterwards. With `fullyParallel` and two projects, two workers
 * would edit the same row: one takes the 409 of the optimistic lock, and the
 * restore writes back an „original" that never was. The layout half of the
 * mobile evidence lives in `form-settings.spec.ts`, which runs in both.
 *
 * **The organisation here is the Dachorganisation**, the one every parked session is scoped to.
 */

test.use({ storageState: authStateFile });

/** The one address of the middle tab — spelled in `router/routes.ts`. */
const TENANT_FORM_DEFAULTS_PATH = '/admin/form-defaults';

/**
 * The four sections, in the order the page renders them.
 *
 * *Verfügbarkeit* is deliberately **not** among them — see the third case, which
 * measures that rather than leaving it to this list to imply.
 */
const SECTION_HEADINGS = [
  'Zugriff & Sicherheit',
  'Nach dem Absenden',
  'Darstellung',
  'Versandbudget',
] as const;

/** Serial, so the two tests of this file cannot overlap on the shared row. */
test.describe.configure({ mode: 'serial' });

function sectionCard(page: Page, heading: string): Locator {
  return page.getByRole('region', { name: heading });
}

/**
 * Puts a section of a **form** on „Angepasst" and reports whether it already
 * was.
 *
 * Only for the form page any more: since 2026-08-17 the standards of the
 * organisation no longer have a switch (review finding 10); at the form it is
 * still right — below it lies the organisation.
 *
 * `click()`, never `check()`/`setChecked()`: those do nothing when the value
 * already matches, so a decoration painted over the control's middle would
 * leave them green — the dead zone, in which no test had ever clicked a
 * switch. The state is asserted afterwards either way.
 */
async function takeSectionOver(card: Locator): Promise<boolean> {
  const custom = card.getByRole('radio', { name: 'Angepasst' });
  const wasCustom = await custom.isChecked();
  if (!wasCustom) {
    await custom.click();
  }
  await expect(custom).toBeChecked();
  return wasCustom;
}

async function newFormSettings(page: Page, base: string): Promise<void> {
  await newForm(page, base);
  await openFormSettings(page);
}

async function save(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Speichern', exact: true }).click();
  // Not the disabled button: it is disabled while the request is in flight too.
  await expectSaved(page);
}

test.describe('Formular-Standards', () => {
  test('a changed standard reaches the form that follows it and not the one that does not', async ({
    page,
  }) => {
    // --- a form that keeps „Nach dem Absenden" on Tenant-Standard ----------
    await newFormSettings(page, 'Erbt');
    const inheritingUrl = page.url();

    // --- a form that takes the section over, before the standard changes ---
    await newFormSettings(page, 'Angepasst');
    const customisedUrl = page.url();
    await takeSectionOver(sectionCard(page, 'Nach dem Absenden'));
    const ownTitle = `Eigener Titel ${Date.now().toString(36)}`;
    await sectionCard(page, 'Nach dem Absenden')
      .getByLabel('Titel der Bestätigungsseite')
      .fill(ownTitle);
    await save(page);

    // --- change the organisation's standard, through the banner an editor uses -----
    await page.getByRole('button', { name: 'Tenant-Standards öffnen' }).click();
    await expect(
      page.getByRole('heading', { name: 'Formular-Standards' }),
    ).toBeVisible();

    /*
     * Nothing to take over, nothing to unlock (review finding 10): the field is
     * there, carries the value in force and can be written to. The old value is
     * remembered so that the restore below leaves the shared row as it was
     * found.
     */
    const tenantCard = sectionCard(page, 'Nach dem Absenden');
    const titleField = tenantCard.getByLabel('Titel der Bestätigungsseite');
    await expect(titleField).toBeEnabled();
    const originalTitle = await titleField.inputValue();
    const newTitle = `Organisationsstandard ${Date.now().toString(36)}`;

    try {
      await titleField.fill(newTitle);
      await save(page);

      // The form that follows the organisation shows the **new** value…
      await page.goto(inheritingUrl);
      await expect(
        sectionCard(page, 'Nach dem Absenden').getByLabel(
          'Titel der Bestätigungsseite',
        ),
      ).toHaveValue(newTitle);

      // …and the one that took the section over shows the **old** one.
      await page.goto(customisedUrl);
      await expect(
        sectionCard(page, 'Nach dem Absenden').getByLabel(
          'Titel der Bestätigungsseite',
        ),
      ).toHaveValue(ownTitle);
    } finally {
      // The standard is shared state of the development database: leaving this
      // run's title behind would make it the starting point of every later one.
      await page.goto(TENANT_FORM_DEFAULTS_PATH);
      await sectionCard(page, 'Nach dem Absenden')
        .getByLabel('Titel der Bestätigungsseite')
        .fill(originalTitle);
      await save(page);
    }
  });

  /**
   * **No inheritance switch, no locked section** (review finding 10).
   *
   * The counter-check to the page that existed until 2026-08-17: there every
   * section carried a „Vorgabe ⇄ Angepasst" toggle, and a section that had not
   * been taken over was a `fieldset disabled` — locked in exactly the state in
   * which an organisation admin wanted to change something.
   *
   * Nothing here is saved: this case is about what the page *offers*, and the
   * row it would write into is shared by all forms of the organisation.
   */
  test('trägt keinen Vererbungsschalter und keinen gesperrten Abschnitt', async ({
    page,
  }) => {
    await page.goto(TENANT_FORM_DEFAULTS_PATH);
    await expect(
      page.getByRole('heading', { name: 'Formular-Standards' }),
    ).toBeVisible();

    // The three sibling tabs of the handoff — and this one marked as the page
    // being shown. They are a navigation, not an ARIA tab widget, and the
    // markup says so: `aria-current="page"` on a `<button>`.
    const tabs = page.getByRole('navigation', {
      name: 'Organisations-Verwaltung',
    });
    for (const label of [
      'Erscheinungsbild & Login',
      'Formular-Standards',
      'Nutzerrechte',
    ]) {
      await expect(tabs.getByRole('button', { name: label })).toBeVisible();
    }
    await expect(
      tabs.getByRole('button', { name: 'Formular-Standards' }),
    ).toHaveAttribute('aria-current', 'page');

    /*
     * Exactly four cards, and the count is the load-bearing half: a fifth one
     * that reappeared — *Verfügbarkeit*, say — would pass every assertion in the
     * loop below in silence, because the loop only ever looks at the four it
     * already knows.
     */
    await expect(page.getByRole('region')).toHaveCount(SECTION_HEADINGS.length);

    // And not a single toggle, in none of the four cards.
    await expect(page.getByRole('radiogroup')).toHaveCount(0);
    await expect(page.getByRole('radio', { name: 'Angepasst' })).toHaveCount(0);

    /*
     * No lock, measured instead of looked at: the fields really are `enabled`,
     * which a `fieldset disabled` would not be — and they carry the values that
     * apply to the forms of this organisation.
     */
    for (const heading of SECTION_HEADINGS) {
      await expect(
        sectionCard(page, heading).locator('fieldset'),
      ).toBeEnabled();
    }

    const field = sectionCard(page, 'Nach dem Absenden').getByLabel(
      'Titel der Bestätigungsseite',
    );
    await expect(field).toBeEnabled();
    await expect(field).not.toHaveValue('');

    await expectNoHorizontalScroll(page, 'Formular-Standards');
  });
});
