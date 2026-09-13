import { expect, test } from '@playwright/test';

import { expectNoHorizontalScroll, openMobileMenu } from './app-flows';
import { authStateFile } from './seed-account';

/**
 * Trash at 360 px — the mobile half of the requirement's „läuft mobil"
 * (`CONTRIBUTING.md`, Lehre 4: every new view that must be operable at 360 px
 * gets a mobile case).
 *
 * **Its own file, zero residue, deliberately** — the same shape
 * `superadmin-overview-mobile.spec.ts` settled on and explains in full: a
 * second desktop-style write here would double whatever the desktop file
 * already leaves behind, for no additional evidence about *width*. This file
 * creates and deletes nothing real; `page.route` serves the trash with one
 * row of each kind, which is the widest state the view gets (icon, title,
 * meta, two action buttons, on one line) — exactly the state worth measuring
 * for overflow, and reachable without a live database.
 */

test.use({ storageState: authStateFile });
test.use({ viewport: { width: 360, height: 740 }, hasTouch: true });

const TRASH_PATH = '/admin/trash';

test.describe('Papierkorb (360 px)', () => {
  test('ist über das Menü erreichbar, passt bei 360 px, und „Wiederherstellen" ist per Touch bedienbar', async ({
    page,
  }) => {
    let restoreCalls = 0;

    await page.route('**/api/trash', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          forms: [
            {
              id: '00000000-0000-4000-8000-000000000f01',
              title:
                'Ein sehr langer Formulartitel, der auf 360 px umbrechen können muss',
              responseCount: 12,
              deletedAt: '2026-07-20T10:00:00.000Z',
            },
          ],
          responses:
            restoreCalls === 0
              ? [
                  {
                    id: '00000000-0000-4000-8000-000000000a01',
                    formId: '00000000-0000-4000-8000-000000000f02',
                    formTitle: 'Jahrestreffen-Anmeldung',
                    submittedAt: '2026-07-01T08:00:00.000Z',
                    deletedAt: '2026-07-21T09:00:00.000Z',
                  },
                ]
              : [],
        }),
      });
    });
    await page.route('**/api/forms/*/responses/*/restore', async (route) => {
      restoreCalls += 1;
      await route.fulfill({ status: 204 });
    });

    await page.goto('/');
    const { sheet } = await openMobileMenu(page);
    await sheet.getByRole('button', { name: 'Papierkorb' }).click();

    await expect(page).toHaveURL(new RegExp(`${TRASH_PATH}$`, 'u'));
    await expect(
      page.getByRole('heading', { name: 'Papierkorb', level: 1 }),
    ).toBeVisible();
    // The navigation closes the sheet — `MobileMenuSheet.tsx` calls
    // `onClose()` alongside `navigate()`, same as every other entry in it.
    await expect(sheet).toHaveCount(0);

    await expectNoHorizontalScroll(page, 'Papierkorb (360 px, geladen)');

    const responseRow = page
      .getByTestId('trash-deleted-response')
      .filter({ hasText: 'Jahrestreffen-Anmeldung' });
    await expect(responseRow).toHaveCount(1);

    // Touch, not a mouse click — the same pointer path a phone drives
    // (`hasTouch: true` above), which is the property this file exists to
    // measure and `trash.spec.ts` cannot: that file runs Desktop Chrome.
    await responseRow.getByRole('button', { name: 'Wiederherstellen' }).tap();
    await expect.poll(() => restoreCalls).toBe(1);
    await expect(responseRow).toHaveCount(0);

    await expectNoHorizontalScroll(
      page,
      'Papierkorb (360 px, eine Antwort wiederhergestellt)',
    );
  });
});
