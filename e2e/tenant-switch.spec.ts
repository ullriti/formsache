import { expect, test } from '@playwright/test';

import {
  expectLoginView,
  expectNoHorizontalScroll,
  logOut,
  submitLogin,
} from './app-flows';
import { seedMember } from './seed-account';

/**
 * The requirement — the tenant switcher, end to end.
 *
 * This is the one flow that cannot be shown with the administrator: the seed's
 * admin belongs to a single Organisation, so the login scopes it unambiguously and
 * there is nothing to switch. The narrow member exists precisely for this —
 * two memberships, so `resolveActiveTenantId` returns **null** and the session
 * starts with no scope at all.
 *
 * That starting state is the point of the test, not a detail of it: before
 * this was fixed, such an account reached a dashboard it could not use and had no way
 * out of the application. The flow below is the way out.
 *
 * The spec signs in for itself rather than reusing the parked admin state,
 * because the *login* is half of what is under test: an account with two
 * memberships must arrive without a scope. A stored session would skip exactly
 * that. It logs out at the end so the shared login budget is not spent on a
 * session nobody else uses.
 */
test.describe('tenant switcher ', () => {
  test('a member of two organisations arrives unscoped, chooses, and switches again', async ({
    page,
  }) => {
    await page.goto('/');
    await expectLoginView(page);

    const status = await submitLogin(page, seedMember);
    expect(
      status,
      'Login with the seeded member must succeed. A 401 here usually means the ' +
        'database was seeded earlier with a different SEED_MEMBER_PASSWORD — the ' +
        'seed deliberately does not reset an existing password.',
    ).toBe(200);

    // The state this is about: no tenant, and the app says so instead
    // of showing an empty dashboard that looks like "nothing here yet".
    //
    // Scoped to the header, because the dashboard says the same thing a second
    // time — deliberately, since the two answer different questions ("which
    // Organisation am I in?" and "why is this empty?"). An unscoped locator matches
    // both and fails on strict mode rather than on the application.
    const header = page.getByRole('banner');
    await expect(
      header.getByText('Keine Organisation ausgewählt'),
    ).toBeVisible();
    await expect(
      page
        .getByRole('main')
        .getByText(/Bitte oben im Kopf eine Organisation auswählen/),
    ).toBeVisible();

    const switcher = page.getByRole('button', {
      name: /Organisations-Auswahl/,
    });
    await switcher.click();

    const dachorganisation = page.getByRole('button', {
      name: /Dachorganisation/,
    });
    const musterstadt = page.getByRole('button', { name: /Musterstadt/ });
    await expect(dachorganisation).toBeEnabled();
    await expect(musterstadt).toBeEnabled();

    await dachorganisation.click();

    // Asserted on the **dashboard**, not on the header, and that is the
    // stronger claim: the header would also change if the client had merely
    // patched its cached user. The view's subtitle is rendered from the
    // session the invalidation re-fetched, so it only reads this once the
    // whole query cache has actually been re-scoped.
    //
    // (The header carries the same name, but so does the open popover behind
    // it — one locator would match both.)
    const main = page.getByRole('main');
    await expect(
      main.getByText('Alle Formulare von Dachorganisation'),
    ).toBeVisible();
    await expect(header.getByText('Keine Organisation ausgewählt')).toHaveCount(
      0,
    );

    // And back again, because a switcher that only works once is a switcher
    // that was never re-scoped — it merely rendered the first choice.
    await switcher.click();
    await page.getByRole('button', { name: /Musterstadt/ }).click();
    await expect(
      main.getByText('Alle Formulare von Ortsgruppe Musterstadt'),
    ).toBeVisible();

    await expectNoHorizontalScroll(page, 'Dashboard nach Tenant-Wechsel');

    // Frees the session rather than leaving it parked; see the note above.
    await logOut(page);
    await expectLoginView(page);
  });
});
