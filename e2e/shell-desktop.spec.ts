import { expect, test, type Page } from '@playwright/test';

import {
  activeTenantName,
  DESKTOP_BREAKPOINT_PX,
  expectDashboard,
  matchesDesktopMediaQuery,
  mobileMenu,
} from './app-flows';
import { authStateFile, tenantAdminStateFile } from './seed-account';

/** The address of the trash — `apps/web/src/router/routes.ts`. */
const TRASH_PATH = '/admin/trash';

/**
 * The two measurements that are read in the browser — as a declaration of
 * their own instead of through `lib: dom`, for the same reason as in
 * `app-flows.ts`: switching the DOM types on globally would put `fetch`, `URL`
 * and relatives next to those of Node for every file of this project. At run
 * time the callback runs in the real browser.
 */
interface MeasurableElement {
  readonly scrollWidth: number;
  readonly clientWidth: number;
}

/**
 * The requirement, seen from above the breakpoint: no hamburger, and the header
 * carries the tenant's mark and name.
 *
 * The session comes from the `setup` project rather than from a login here —
 * see `auth.setup.ts` for why the suite spends its login attempts sparingly.
 */
test.use({ storageState: authStateFile });

test('ab 1180 px zeigt der Header Tenant-Logo und -Name, ohne Hamburger', async ({
  page,
}) => {
  await page.goto('/');
  await expectDashboard(page);

  const banner = page.getByRole('banner');

  // Compared against what the server reports, not against a name written down
  // here — a constant would keep passing after the seed changed.
  await expect(banner.getByText(await activeTenantName(page))).toBeVisible();

  // The one selector in this suite that is not a role or a visible text. It
  // cannot be: the mark is `alt=""` by design, because the tenant name sits
  // right next to it and a screen reader should not hear it twice. The
  // `data-testid` already exists in `TenantMark`.
  await expect(banner.getByTestId('tenant-logo')).toBeVisible();

  await expect(mobileMenu(page).hamburger).toHaveCount(0);
});

/**
 * The breakpoint checked *at* the breakpoint.
 *
 * 360 against 1440 would pass with the switch anywhere in between and would
 * therefore say nothing about 1180. Both sides are asserted twice: what the
 * CSS media query resolves to, and what the header actually renders — the
 * second is what a user sees, the first is what would silently drift if
 * `tokens.css` and `breakpoints.ts` ever disagreed.
 */
test('der Breakpoint greift bei genau 1180 px', async ({ page }) => {
  await page.goto('/');
  await expectDashboard(page);

  const { hamburger } = mobileMenu(page);
  const switcher = page.getByRole('button', { name: 'Organisations-Auswahl' });

  await page.setViewportSize({ width: DESKTOP_BREAKPOINT_PX, height: 900 });
  expect(await matchesDesktopMediaQuery(page)).toBe(true);
  await expect(switcher).toBeVisible();
  await expect(hamburger).toHaveCount(0);

  await page.setViewportSize({ width: DESKTOP_BREAKPOINT_PX - 1, height: 900 });
  expect(await matchesDesktopMediaQuery(page)).toBe(false);
  await expect(hamburger).toBeVisible();
  await expect(switcher).toHaveCount(0);
});

/**
 * **The header keeps every caption whole — at five widths** (finding 12).
 *
 * The finding read: from about 1300 px on, not everything fitted into the bar
 * any more for the organisation admin, for the superadmin with an organisation
 * already from about 1500 px. That became visible not as an overflow but as
 * „Tenant-Verwal…" — `text-overflow: ellipsis` cut the names off, and a cut
 * off name is a target one has to guess.
 *
 * Three things are therefore measured, because each of the three measurements
 * alone would be cheatable:
 *
 * 1. **The bar does not overflow** (`scrollWidth <= clientWidth` at the
 *    `<nav>`). That number says anything at all only since the entries no
 *    longer carry `overflow: hidden` — with hidden overflow the two values are
 *    equal by construction, and the measurement would be green without looking.
 * 2. **No single entry is cut off** (`scrollWidth <= clientWidth` at the
 *    button itself). That is the counter-check to 1: a bar that simply draws
 *    its entries narrower would be in order according to 1.
 * 3. **The mark stays standing.** The kicker „Formsache" and the name of the
 *    organisation are what a multi-tenant application must not lose in its
 *    header — and the most convenient place a navigation that is too wide
 *    could take for itself.
 *
 * Two sessions, because the number of entries is the role: the superadmin of
 * the umbrella organisation sees four („Dashboard", „Organisations-Verwaltung",
 * „Papierkorb", „Systemverwaltung"), the organisation admin of Musterstadt
 * three. The narrower cases — a member without rights, a superadmin without an
 * organisation — are subsets of those: what fits with four entries fits all
 * the more with one, and their captioning logic is covered by
 * `apps/web/src/shell/AppHeader.test.tsx` at all five widths.
 */
const HEADER_WIDTHS = [DESKTOP_BREAKPOINT_PX, 1300, 1440, 1500, 1920] as const;

async function expectHeaderFits(page: Page, expectedEntries: number) {
  const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
  const entries = nav.getByRole('button');
  await expect(entries).toHaveCount(expectedEntries);

  const tenantName = await activeTenantName(page);

  for (const width of HEADER_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    // The reflow hangs on a media query; without this wait the first pass
    // measures the state of the previous width.
    await expect(nav).toBeVisible();

    const overflow = await nav.evaluate(
      (element: MeasurableElement) => element.scrollWidth - element.clientWidth,
    );
    expect(
      overflow,
      `Die Navigation läuft bei ${String(width)} px über`,
    ).toBeLessThanOrEqual(0);

    for (const entry of await entries.all()) {
      const name = (await entry.textContent()) ?? '';
      const cut = await entry.evaluate(
        (element: MeasurableElement) =>
          element.scrollWidth - element.clientWidth,
      );
      expect(
        cut,
        `„${name.trim()}" ist bei ${String(width)} px beschnitten`,
      ).toBeLessThanOrEqual(0);
    }

    const banner = page.getByRole('banner');
    await expect(banner.getByText('Formsache')).toBeVisible();
    await expect(banner.getByText(tenantName)).toBeVisible();
  }
}

test.describe('Kopfzeile — Superadmin mit Organisation (vier Einträge)', () => {
  test('schneidet an keiner der fünf Breiten eine Beschriftung ab', async ({
    page,
  }) => {
    await page.goto('/');
    await expectDashboard(page);

    await expectHeaderFits(page, 4);
  });
});

test.describe('Kopfzeile — Organisations-Admin (drei Einträge)', () => {
  test.use({ storageState: tenantAdminStateFile });

  test('schneidet an keiner der fünf Breiten eine Beschriftung ab', async ({
    page,
  }) => {
    await page.goto('/');
    await expectDashboard(page);

    await expectHeaderFits(page, 3);
  });
});

/**
 * **The mark leads to the dashboard** (finding 19).
 *
 * Logo, kicker and organisation name were `<span>`s: the place everybody
 * clicks first when they want to get back to the beginning, and the only place
 * of the header at which nothing happened. Measured here and not only in the
 * component test, because only the real browser shows that the click stays
 * **in the same tab** instead of reloading the document.
 */
test('ein Klick auf die Marke führt vom Papierkorb aufs Dashboard', async ({
  page,
}) => {
  await page.goto(TRASH_PATH);
  await expect(
    page.getByRole('heading', { name: 'Papierkorb', level: 1 }),
  ).toBeVisible();

  await page
    .getByRole('banner')
    .getByRole('link', { name: /Zum Dashboard/ })
    .click();

  await expectDashboard(page);
  // And the entry „▦ Dashboard" still stands next to it: the mark is a
  // habit, not a substitute for a named target.
  await expect(
    page
      .getByRole('navigation', { name: 'Hauptnavigation' })
      .getByRole('button', { name: 'Dashboard' }),
  ).toBeVisible();
});
