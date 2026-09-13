import { expect, test, type Page } from '@playwright/test';

import { newForm } from './app-flows';
import { authStateFile } from './seed-account';

/**
 * „Endgültig löschen" and „🗑 Papierkorb leeren" — the two controls `trash.spec.ts` only proves are *reachable*
 * on the row it creates. This file presses them.
 *
 * **Case 1 is real, and its blast radius is exactly one form this test
 * created.** `DELETE /forms/:id/permanent` is genuinely destructive, so
 * nothing here targets a row this test does not own.
 *
 * **Case 2, „Papierkorb leeren", is `page.route`-mocked, deliberately.** The
 * real route empties the **whole active organisation's** trash in one call —
 * every other spec's form or answer that happens to be sitting there at that
 * moment, `dashboard-delete.spec.ts`'s and `trash.spec.ts`'s included, since
 * `fullyParallel` runs them in the same project against the same seeded
 * tenant. A real call here would not be a test of this file, it would be
 * a landmine for every other one. `page.route` reaches the same client code
 * without touching the shared installation at all — the same reasoning
 * `trash.spec.ts`'s own 409 case gives for the identical technique.
 */

test.use({ storageState: authStateFile });

const TRASH_PATH = '/admin/trash';

async function csrfHeader(page: Page): Promise<Record<string, string>> {
  const cookies = await page.context().cookies();
  const token = cookies.find(
    (cookie) =>
      cookie.name === 'formsache_csrf' ||
      cookie.name === '__Host-formsache_csrf',
  )?.value;
  return token === undefined ? {} : { 'X-CSRF-Token': token };
}

test.describe('Endgültig löschen und Papierkorb leeren', () => {
  test('löscht ein eigenes Formular endgültig, mit Bestätigung, und der Papierkorb kennt es danach nicht mehr', async ({
    page,
  }) => {
    const title = await newForm(page, 'Endgültig löschen');
    const formId = /\/forms\/([^/]+)/u.exec(page.url())?.[1];
    if (formId === undefined) {
      throw new Error(`Could not read the form id from ${page.url()}.`);
    }
    const response = await page.request.delete(`/api/forms/${formId}`, {
      headers: await csrfHeader(page),
    });
    expect(response.status(), 'DELETE /api/forms/:id').toBe(204);

    await page.goto(TRASH_PATH);
    const row = page
      .getByTestId('trash-deleted-form')
      .filter({ hasText: title });
    await expect(row).toHaveCount(1);

    await row.getByRole('button', { name: 'Endgültig löschen' }).click();

    // A confirmation, in words that say what is lost — not a click-through.
    const question = row.getByRole('alert');
    await expect(question).toContainText(title);
    await expect(question).toContainText('nicht rückgängig machen');

    // Scoped to the confirmation, not the row: the trigger button shares its
    // accessible name with `ConfirmPrompt`'s own confirming button, and once
    // both are on screen a name-only lookup matches two elements — the
    // trigger is also `disabled` by then, which is a second, unrelated
    // reason `.click()` on it would not have been the one intended anyway.
    await row
      .locator('.trash-row__confirm')
      .getByRole('button', { name: 'Endgültig löschen' })
      .click();
    await expect(row).toHaveCount(0);

    // A known trap: focus lands on the view's own heading, real `focus()`
    // behaviour a jsdom assertion cannot speak for.
    await expect(
      page.getByRole('heading', { name: 'Papierkorb', level: 1 }),
    ).toBeFocused();
    await expect(page.locator('body')).not.toBeFocused();

    // Genuinely gone — a restore now answers 404, not 204.
    const restoreAttempt = await page.request.post(
      `/api/forms/${formId}/restore`,
      { headers: await csrfHeader(page) },
    );
    expect(restoreAttempt.status()).toBe(404);
  });

  test('fragt vor „Papierkorb leeren" und sagt, wenn Elemente übrig bleiben', async ({
    page,
  }) => {
    let emptyRequests = 0;

    // The `GET` is mocked too, deliberately — a real, possibly-empty
    // trash would make „🗑 Papierkorb leeren" absent (`TrashView.tsx`
    // hides it with nothing left to empty), and this case is about pressing
    // the button, not about first hoping some other spec left a row behind.
    await page.route('**/api/trash', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            forms: [
              {
                id: '00000000-0000-4000-8000-0000000e2e01',
                title: 'Gemockt für Papierkorb leeren',
                responseCount: 0,
                deletedAt: '2026-07-20T10:00:00.000Z',
              },
            ],
            responses: [],
          }),
        });
        return;
      }
      if (route.request().method() !== 'DELETE') {
        await route.fallback();
        return;
      }
      emptyRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          forms: 1,
          responses: 0,
          failed: 1,
          remaining: 2,
        }),
      });
    });

    await page.goto(TRASH_PATH);
    await expect(
      page.getByRole('heading', { name: 'Papierkorb', level: 1 }),
    ).toBeVisible();
    await expect(page.getByText('Gemockt für Papierkorb leeren')).toBeVisible();

    // **Anchored, ever since the row buttons carry the title in their name**
    // : the trigger of this case is called „🗑 Papierkorb
    // leeren", but the form filed here is called „Gemockt für Papierkorb
    // leeren" — and Playwright searches for a **substring** by default.
    // An unanchored `/Papierkorb leeren/` has matched both ever since. The
    // waste-bin sign is **not** part of the name — it stands in an
    // `aria-hidden` span, like the `✕` on the row button.
    //
    // The lesson is more general than this case: as soon as an accessible name
    // contains user data — and it should, otherwise seven rows are called
    // the same —, it collides with every loose name pattern. Whoever searches
    // here anchors.
    await page
      .getByRole('button', { name: 'Papierkorb leeren', exact: true })
      .click();
    const question = page.getByRole('alert');
    await expect(question).toContainText('nicht mehr rückgängig machen');
    expect(emptyRequests).toBe(0);

    await page
      .getByRole('button', { name: 'Papierkorb leeren', exact: true })
      .click();

    await expect(page.getByTestId('trash-empty-failed')).toContainText('1');
    await expect(page.getByTestId('trash-empty-remaining')).toContainText('2');
    expect(emptyRequests).toBe(1);
    // The button is still there — `remaining > 0` offers a second run rather
    // than disappearing (a review finding — the trap known as „der Fall, den
    // man beim Bauen vergisst").
    await expect(
      page.getByRole('button', { name: 'Papierkorb leeren', exact: true }),
    ).toBeVisible();
  });

  /**
   * The vanishing-control case „Papierkorb leeren" had only a jsdom proof of
   * (review finding 6): a run that clears **everything**.
   *
   * It is the shape no other case reaches. The whole `trash__sections` block
   * unmounts — both section headings with it — and the button that was just
   * pressed is removed too, because there is nothing left to empty. Every
   * element a browser could plausibly restore focus to is gone, which is
   * exactly the situation in which focus falls to `<body>` and the next Tab
   * starts at the top of the page. `TrashView.tsx` aims at the `<h1>` for that
   * reason; only a real browser can say whether `focus()` on a `tabIndex={-1}`
   * heading took, and this organisation's real trash is shared with three other
   * specs, so the state is reached with `page.route` (the same reasoning case 2
   * above gives at length).
   */
  test('leert den Papierkorb vollständig und lässt den Fokus nicht auf body fallen', async ({
    page,
  }) => {
    let emptied = false;

    await page.route('**/api/trash', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(
            emptied
              ? { forms: [], responses: [] }
              : {
                  forms: [
                    {
                      id: '00000000-0000-4000-8000-0000000e2e02',
                      title: 'Gemockt für vollständiges Leeren',
                      responseCount: 0,
                      deletedAt: '2026-07-20T10:00:00.000Z',
                    },
                  ],
                  responses: [],
                },
          ),
        });
        return;
      }
      if (route.request().method() !== 'DELETE') {
        await route.fallback();
        return;
      }
      emptied = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          forms: 1,
          responses: 0,
          failed: 0,
          remaining: 0,
        }),
      });
    });

    await page.goto(TRASH_PATH);
    await expect(
      page.getByText('Gemockt für vollständiges Leeren'),
    ).toBeVisible();

    // Both anchored, for the reason set out at length at the first place in this
    // case: a row button carries the title of its
    // form in its name, and Playwright searches for substrings.
    await page
      .getByRole('button', { name: 'Papierkorb leeren', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Papierkorb leeren', exact: true })
      .click();

    // Everything the click stood in is gone: the row, both section headings
    // and the control itself.
    await expect(page.getByText('Papierkorb ist leer')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Gelöschte Formulare' }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: /Papierkorb leeren/ }),
    ).toHaveCount(0);
    // …and no „bitte erneut drücken" next to a trash that is empty.
    await expect(page.getByTestId('trash-empty-remaining')).toHaveCount(0);

    await expect(
      page.getByRole('heading', { name: 'Papierkorb', level: 1 }),
    ).toBeFocused();
    await expect(page.locator('body')).not.toBeFocused();
  });
});
