import { expect, test } from '@playwright/test';

import {
  activeTenantName,
  expectDashboard,
  expectLoginView,
  expectNoHorizontalScroll,
  mobileMenu,
  openMobileMenu,
} from './app-flows';
import { authStateFile } from './seed-account';

/**
 * The requirement below the breakpoint, at the narrowest width the handoff names
 * (360 px): the compact header with its hamburger, the off-canvas sheet with
 * *Allgemein* and the tenant selection — and no horizontal scrollbar anywhere.
 */

test.describe('Angemeldet', () => {
  test.use({ storageState: authStateFile });

  test('der Hamburger öffnet das Off-Canvas-Sheet mit Allgemein und Organisations-Auswahl', async ({
    page,
  }) => {
    await page.goto('/');
    await expectDashboard(page);

    const { hamburger } = mobileMenu(page);
    await expect(hamburger).toBeVisible();
    await expect(hamburger).toHaveAttribute('aria-expanded', 'false');

    const { sheet } = await openMobileMenu(page);
    await expect(hamburger).toHaveAttribute('aria-expanded', 'true');

    // `aria-controls` has to point at the sheet that actually opened —
    // otherwise it is a pair of attributes that merely look correct.
    const controls = await hamburger.getAttribute('aria-controls');
    expect(controls).not.toBeNull();
    const controlled = page.locator(`[id="${controls ?? ''}"]`);
    await expect(controlled).toHaveAttribute('role', 'dialog');
    await expect(controlled).toHaveAttribute('aria-modal', 'true');

    // Section *Allgemein* with the dashboard entry (handoff §Navigation).
    await expect(sheet.getByText('Allgemein', { exact: true })).toBeVisible();
    await expect(
      sheet.getByRole('button', { name: 'Dashboard' }),
    ).toBeVisible();

    // Tenant selection, showing the tenant the server scoped the session to.
    await expect(
      sheet.getByText('Organisation', { exact: true }),
    ).toBeVisible();
    await expect(
      sheet
        .getByRole('listitem')
        .filter({ hasText: await activeTenantName(page) }),
    ).toBeVisible();
  });

  test('Escape schließt das Sheet und gibt den Fokus zurück', async ({
    page,
  }) => {
    await page.goto('/');
    await expectDashboard(page);

    const { hamburger, sheet } = await openMobileMenu(page);

    await sheet.press('Escape');

    await expect(sheet).toHaveCount(0);
    await expect(hamburger).toHaveAttribute('aria-expanded', 'false');
    await expect(hamburger).toBeFocused();
  });

  test('kein horizontaler Scrollbalken auf dem Dashboard', async ({ page }) => {
    await page.goto('/');
    await expectDashboard(page);

    await expectNoHorizontalScroll(page, 'Dashboard');
  });

  test('kein horizontaler Scrollbalken bei geöffnetem Sheet', async ({
    page,
  }) => {
    await page.goto('/');
    await expectDashboard(page);
    await openMobileMenu(page);

    await expectNoHorizontalScroll(page, 'Dashboard mit geöffnetem Sheet');
  });
});

test.describe('Abgemeldet', () => {
  test('kein horizontaler Scrollbalken auf der Login-Ansicht', async ({
    page,
  }) => {
    await page.goto('/');
    await expectLoginView(page);

    await expectNoHorizontalScroll(page, 'Login-Ansicht');
  });
});
