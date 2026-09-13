import { expect, test } from '@playwright/test';

import { authStateFile } from './seed-account';

/**
 * „Gelöschte Organisationen" and „Löschen" on a live row (the specification) — the section and the confirmation
 * `SuperadminView.test.tsx` cannot speak for: real browser accessible-name
 * computation once an icon sits next to a label, and `toBeFocused()`.
 *
 * **Zero residue, by construction — `page.route` throughout.** The only row
 * this file can safely press „Löschen" on is the seeded Dachorganisation tenant that
 * powers the rest of this suite, so every mutating request is intercepted
 * and answered by this file, never by the real API: a real `DELETE` here
 * would take the whole suite down with it. This is the same shape
 * `trash-mobile.spec.ts` and `superadmin-overview-mobile.spec.ts` settled on
 * for the identical reason, applied to a row this file cannot afford to be
 * wrong about even once.
 */

test.use({ storageState: authStateFile });

/**
 * The *Organisationen* tab of the system administration — until finding 16 the
 * page `/admin/superadmin` of its own.
 */
const SUPERADMIN_PATH = '/admin/system';
const UMBRELLA_NAME = 'Dachorganisation';

test.describe('Gelöschte Organisationen ', () => {
  test('listet eine gelöschte Organisation, ohne ein kaputtes Logo zu rendern, und stellt sie wieder her', async ({
    page,
  }) => {
    const deletedTenantId = '00000000-0000-4000-8000-00000000dead';
    // Mutable, and read by every `GET` — the restore handler below flips it
    // *before* answering, so the refetch `useRestoreTenant` triggers on
    // success (`TENANT_OVERVIEW_QUERY_KEY`, a prefix of this route's key
    // too) sees the state the server would actually be in by then. Without
    // this the mock kept answering the same single-tenant list forever, and
    // „Wiederherstellen" looked like it did nothing.
    let restored = false;

    await page.route('**/api/admin/tenants/deleted', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          tenants: restored
            ? []
            : [
                {
                  tenant: {
                    id: deletedTenantId,
                    shortName: 'Geloescht',
                    name: 'Gelöschte Testorganisation',
                    // An `upload` reference — the shape whose public address
                    // 404s for a deleted tenant (security review finding).
                    // The assertion below is that this section
                    // never turns it into an `<img>` in the first place.
                    logoRef: { kind: 'upload', ref: 'a'.repeat(22) },
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
              ],
        }),
      });
    });
    await page.route(
      `**/api/admin/tenants/${deletedTenantId}/restore`,
      async (route) => {
        restored = true;
        await route.fulfill({ status: 204 });
      },
    );

    await page.goto(SUPERADMIN_PATH);
    // The `<h1>` is called „Systemverwaltung" on all four tabs; which one is
    // open is said by this tab's `<h2>`.
    await expect(
      page.getByRole('heading', {
        name: 'Organisationen dieser Installation',
        level: 2,
      }),
    ).toBeVisible();

    const row = page.getByTestId('superadmin-deleted-tenant');
    await expect(row).toHaveCount(1);
    await expect(row.getByText('Gelöschte Testorganisation')).toBeVisible();
    // No broken Logo in **the row of a deleted tenant** — scoped to it,
    // not the whole page: the header's own Logo and every *live* row's
    // `TenantMark` are real `<img>` elements too, and a page-wide count
    // found three of them, none of which was the thing under test. The
    // accessible-name and rendering half of the security review finding is
    // still only a real browser's to speak for (a jsdom `<img>` never
    // actually requests anything, so it cannot show a broken-image icon
    // either) — this just measures the right element.
    await expect(row.locator('img')).toHaveCount(0);

    await row.getByRole('button', { name: 'Wiederherstellen' }).click();
    await expect(row).toHaveCount(0);
    await expect(
      page.getByText('Keine gelöschten Organisationen.'),
    ).toBeVisible();

    // The trap named in the work order: the row (and the section's list) is
    // gone, and focus has to land on the section's own heading, real
    // `focus()` behaviour a jsdom assertion cannot speak for.
    await expect(
      page.getByRole('heading', { name: 'Gelöschte Organisationen' }),
    ).toBeFocused();
    await expect(page.locator('body')).not.toBeFocused();
  });

  test('verlangt den abgetippten Namen, und der Vergleich ist der des Servers', async ({
    page,
  }) => {
    let deleteRequests = 0;
    let lastBody: unknown;
    let umbrellaDeleted = false;

    await page.route('**/api/admin/tenants/deleted', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ tenants: [] }),
      });
    });
    // The real list, `**/api/admin/tenants` exactly — mirrored back with Dachorganisation
    // filtered out once the mocked delete below has „succeeded", so the
    // row's disappearance is genuinely observed rather than assumed. This
    // reads the real API and only ever rewrites the response; the mutating
    // half below never reaches it.
    await page.route('**/api/admin/tenants', async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as {
        tenants: readonly { tenant: { name: string } }[];
      };
      await route.fulfill({
        response,
        json: {
          ...body,
          tenants: umbrellaDeleted
            ? body.tenants.filter((row) => row.tenant.name !== UMBRELLA_NAME)
            : body.tenants,
        },
      });
    });
    // Intercepts **only** the Dachorganisation row's own address — every other
    // `DELETE /api/admin/tenants/:id` (there is only this one row in a fresh
    // installation) still has to go through this route, so nothing here can
    // accidentally let a real delete through for a different id.
    await page.route(/\/api\/admin\/tenants\/[^/]+$/u, async (route) => {
      if (route.request().method() !== 'DELETE') {
        await route.fallback();
        return;
      }
      deleteRequests += 1;
      lastBody = route.request().postDataJSON();
      const confirmName =
        typeof lastBody === 'object' &&
        lastBody !== null &&
        'confirmName' in lastBody
          ? lastBody.confirmName
          : undefined;
      if (confirmName === UMBRELLA_NAME) {
        umbrellaDeleted = true;
        await route.fulfill({ status: 204 });
        return;
      }
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          message:
            'Der eingegebene Name stimmt nicht mit dem Namen dieser Organisation überein.',
        }),
      });
    });

    await page.goto(SUPERADMIN_PATH);
    // The `<h1>` is called „Systemverwaltung" on all four tabs; which one is
    // open is said by this tab's `<h2>`.
    await expect(
      page.getByRole('heading', {
        name: 'Organisationen dieser Installation',
        level: 2,
      }),
    ).toBeVisible();

    // Scoped to the row carrying the „Löschen" trigger, not merely to the
    // text — once the confirmation is open, its own `<tr>` (the typed name
    // from the confirmation, quoted) contains UMBRELLA_NAME too, and a locator keyed on text
    // alone then matches both and every later assertion on `row` throws a
    // strict-mode violation instead of measuring anything.
    //
    // `exact: true` is load-bearing, not decoration: an accessible-name match
    // is substring **and** case-insensitive by default, and the confirmation's
    // own button is „Organisation löschen" — which contains „löschen" and so matched
    // „Löschen" too, defeating this very filter the first time it was written
    // without `exact`.
    const row = page
      .getByRole('row')
      .filter({ hasText: UMBRELLA_NAME })
      .filter({
        has: page.getByRole('button', { name: 'Löschen', exact: true }),
      });
    await row.getByRole('button', { name: 'Löschen' }).click();

    const nameField = page.getByLabel('Name der Organisation zur Bestätigung');
    await expect(nameField).toBeVisible();
    const confirmButton = page.getByRole('button', {
      name: 'Organisation löschen',
    });
    // No smaller confirmation — the trap named in the work order: the button
    // stays disabled on an empty field rather than acting as a click-through.
    await expect(confirmButton).toBeDisabled();

    await nameField.fill('Falscher Name');
    await expect(confirmButton).toBeEnabled();
    await confirmButton.click();

    await expect(page.getByText(/stimmt nicht mit dem Namen/)).toBeVisible();
    // Still in the table — a refusal removed nothing.
    await expect(row).toBeVisible();

    // Now the matching name — the mocked route answers 204, never the real
    // API, so Dachorganisation itself is never actually touched.
    await nameField.fill(UMBRELLA_NAME);
    await confirmButton.click();
    await expect(row).toHaveCount(0);

    /*
      The second vanishing control here with only a jsdom proof
      (review finding 6). „Organisation löschen" removes the row that held the button
      *and* the confirmation the button lives in — nothing at the point of
      interaction survives the click, so focus falls to `<body>` unless the
      view puts it somewhere. `SuperadminView` aims at its own heading —
      since finding 16 the tab's `<h2>`, because the `<h1>` belongs to the
      frame and survives the tab switch; whether `focus()` on a `tabIndex={-1}`
      heading takes is a question only a real browser answers, and jsdom reports
      green either way.
    */
    await expect(
      page.getByRole('heading', {
        name: 'Organisationen dieser Installation',
        level: 2,
      }),
    ).toBeFocused();
    await expect(page.locator('body')).not.toBeFocused();
    // The typed-name confirmation is gone with the row, not left standing.
    await expect(
      page.getByLabel('Name der Organisation zur Bestätigung'),
    ).toHaveCount(0);

    expect(deleteRequests).toBe(2);
    expect(lastBody).toEqual({ confirmName: UMBRELLA_NAME });
  });
});
