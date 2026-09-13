import { expect, test } from '@playwright/test';

import { expectNoHorizontalScroll, openMobileMenu } from './app-flows';
import { authStateFile } from './seed-account';

/**
 * „Gelöschte Organisationen" at 360 px — the mobile half of the requirement
 * (`CONTRIBUTING.md`, Lehre 4: a new section that must be operable at 360 px
 * gets a mobile case; Lehre 3: reached through the navigation, not
 * `page.goto`).
 *
 * **Its own file, zero residue** — the same split
 * `superadmin-overview-mobile.spec.ts` and `trash-mobile.spec.ts` settled on
 * and explain in full: `page.route` serves the section's own list, nothing
 * here writes to the real installation, and the widest state (an icon, a
 * long name, one action button) is the one worth measuring for overflow.
 */

test.use({ storageState: authStateFile });
test.use({ viewport: { width: 360, height: 740 }, hasTouch: true });

/**
 * The *Organisationen* tab of the system administration — until finding 16 the page
 * `/admin/superadmin` of its own.
 */
const SUPERADMIN_PATH = '/admin/system';

test.describe('Gelöschte Organisationen (360 px)', () => {
  test('ist über das Menü erreichbar, passt bei 360 px, und „Wiederherstellen" ist per Touch bedienbar', async ({
    page,
  }) => {
    let restoreCalls = 0;

    await page.route('**/api/admin/tenants/deleted', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          tenants:
            restoreCalls === 0
              ? [
                  {
                    tenant: {
                      id: '00000000-0000-4000-8000-00000000dead',
                      shortName: 'Geloescht',
                      name: 'Ein sehr langer Organisationsname, der auf 360 px umbrechen können muss',
                      logoRef: null,
                      branding: {
                        accent: '#7c0800',
                        headerBg: '#212226',
                        canvasBg: '#e9e6df',
                        stripe: ['#212226', '#7c0800', '#cea967'],
                        wideLogo: false,
                      },
                    },
                    deletedAt: '2026-07-01T10:00:00.000Z',
                  },
                ]
              : [],
        }),
      });
    });
    await page.route('**/api/admin/tenants/*/restore', async (route) => {
      restoreCalls += 1;
      await route.fulfill({ status: 204 });
    });

    await page.goto('/');
    const { sheet } = await openMobileMenu(page);
    // One entry for the four tabs (finding 16) — „Superadmin-Übersicht",
    // „Betrieb" and „Systemeinstellungen" once stood here side by side.
    await sheet
      .getByRole('button', { name: 'Systemverwaltung', exact: true })
      .click();

    await expect(page).toHaveURL(new RegExp(`${SUPERADMIN_PATH}$`, 'u'));
    await expect(
      page.getByRole('heading', {
        name: 'Organisationen dieser Installation',
        level: 2,
      }),
    ).toBeVisible();
    // The navigation closes the sheet — the same convention every other
    // entry follows.
    await expect(sheet).toHaveCount(0);

    const row = page.getByTestId('superadmin-deleted-tenant');
    await expect(row).toHaveCount(1);

    await expectNoHorizontalScroll(
      page,
      'Gelöschte Organisationen (360 px, geladen)',
    );

    // Touch, not a mouse click — the property this file exists to measure
    // and the desktop file cannot (Desktop Chrome, no `hasTouch`).
    await row.getByRole('button', { name: 'Wiederherstellen' }).tap();
    await expect.poll(() => restoreCalls).toBe(1);
    await expect(row).toHaveCount(0);

    await expectNoHorizontalScroll(
      page,
      'Gelöschte Organisationen (360 px, wiederhergestellt)',
    );
  });
});
