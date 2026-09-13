import { expect, test } from '@playwright/test';

import {
  addQuestion,
  expectNoHorizontalScroll,
  newForm,
  saveForm,
} from './app-flows';
import { authStateFile, seedMember } from './seed-account';

/**
 * Nutzerrechte je Formular at 360 px — the mobile half of the requirement.
 *
 * **Its own file, not `form-members.spec.ts` itself added to the
 * `mobile-360x740` project.** That file's one case is specifically about an
 * **in-app** route change (`page.goto()` would reload the document and pass
 * with no key at all, per its own docblock) — its evidence is a `formId` key
 * surviving a mount, not a viewport. Duplicating it here would prove the same
 * key twice and nothing about 360 px. What *is* a genuine gap is whether the
 * page is reachable and operable at all below the breakpoint, on a form that
 * is this file's own and touches nobody else's fixture.
 *
 * **The tragende Aktion is the same switch the desktop file exercises** — a
 * centred click on the access toggle for `seedMember`, this time saved and
 * read back after a reload, so the round trip through the real API is part of
 * what „bedienbar" means here.
 */

test.use({ storageState: authStateFile });
test.use({ viewport: { width: 360, height: 740 }, hasTouch: true });

/** Reused from `form-members.spec.ts`: viewer in the Dachorganisation, restrictable at all. */
const RESTRICTABLE_EMAIL = seedMember.email;

test.describe('Nutzerrechte je Formular (360 px)', () => {
  test('der Zugriffs-Schalter reagiert auf einen Klick in seine Mitte und übersteht ein Neuladen', async ({
    page,
  }) => {
    await newForm(page, 'Nutzerrechte mobil');
    await addQuestion(page, 'Text', 'Name');
    await saveForm(page);
    const formPath = new URL(page.url()).pathname;

    await page.goto(`${formPath}/members`);
    await expect(
      page.getByRole('heading', { name: 'Nutzerrechte', level: 1 }),
    ).toBeVisible();

    const row = page
      .getByRole('listitem')
      .filter({ hasText: RESTRICTABLE_EMAIL });
    await expect(
      row,
      `„${RESTRICTABLE_EMAIL}" must be a member of this organisation and not an ` +
        'administrator — an admin row carries no controls to click.',
    ).toHaveCount(1);

    const accessSwitch = row.getByRole('switch');
    await expect(accessSwitch).toBeChecked();

    // The middle of the switch, not `.check()`/`.setChecked()` — the
    // dead zone this project has paid for once already.
    await accessSwitch.click();
    await expect(accessSwitch).not.toBeChecked();
    await row.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(
      row.getByRole('button', { name: 'Speichern', exact: true }),
    ).toHaveCount(0);

    await page.reload();
    const reloadedRow = page
      .getByRole('listitem')
      .filter({ hasText: RESTRICTABLE_EMAIL });
    await expect(
      reloadedRow.getByRole('switch'),
      'A click that only updated the draft would snap back on reload.',
    ).not.toBeChecked();

    await expectNoHorizontalScroll(page, 'Nutzerrechte je Formular');
  });
});
