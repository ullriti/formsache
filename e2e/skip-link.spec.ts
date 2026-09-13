import { expect, test } from '@playwright/test';

import { authStateFile } from './seed-account';

/**
 * Die Adresse des Papierkorbs, einmal buchstabiert.
 *
 * Beide Fälle unten fahren sie an, und sie standen bis Review-Runde 4
 * verschieden da — einmal richtig, einmal als `/papierkorb`, das es nie gab.
 * Zwei Schreibweisen einer Adresse in einer Datei sind genau die Gelegenheit,
 * bei der eine davon stehen bleibt.
 */
const TRASH_PATH = '/admin/trash';

/**
 * **Skip link, route announcement and the focus after Escape** (a review finding).
 *
 * All three are promises a mechanical checker does **not** report:
 *
 * * axe's `bypass` rule is green as soon as there is a `<main>` — that there are
 *   about fourteen tab jumps in front of it is something it does not see.
 * * A route change without a page load is no event for axe.
 * * Where the focus goes after Escape is not a rule but a
 *   question of operability (WCAG 2.4.3).
 *
 * That is why they stand here as cases that are run rather than as a paragraph in the handoff.
 */
test.describe('Tastaturwege durch die Anwendung', () => {
  test.use({ storageState: authStateFile });

  test('der erste Tabulatorsprung führt zum Inhalt', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    // The skip link is invisible until it has the focus — that is exactly the
    // shape WCAG 2.4.1 means.
    const skip = page.getByRole('link', { name: 'Zum Inhalt springen' });
    await expect(skip).toBeAttached();

    await page.keyboard.press('Tab');
    await expect(skip).toBeFocused();

    await page.keyboard.press('Enter');
    // Afterwards the content is next in line: the next jump does **not** land
    // in the header again.
    const main = page.locator('main#inhalt');
    await expect(main).toBeVisible();
    expect(new URL(page.url()).hash).toBe('#inhalt');
  });

  test('ein Routenwechsel sagt an, setzt den Titel und nimmt den Fokus mit', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page).toHaveTitle(/Dashboard/u);

    await page.goto(TRASH_PATH);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    // 1. The tab title — what the browser announces on the change and what is
    //    in the history list.
    await expect(page).toHaveTitle(/Papierkorb/u);
  });

  /**
   * The change **within** the application — the case a `goto` does not
   * measure: no page load, so nothing happens by itself.
   *
   * ⚠️ **Der Start ist der Papierkorb und war es nie.** Hier stand
   * `/papierkorb` — eine Adresse, die diese Anwendung nie bedient hat; die
   * Ansicht lag unter `/verwaltung/papierkorb` und liegt heute unter
   * `/admin/trash`. Der Fall lief also von der 404-Seite los und blieb grün,
   * weil auch sie in der Schale steht und eine Navigation hat. Gemessen war
   * damit der Fokuswechsel aus einer Fehlerseite heraus, nicht der aus einer
   * Ansicht — und die Zusage dieses Falls ist die zweite (Review-Runde 4,
   * Nachtrag).
   */
  test('ein Wechsel über die Navigation verschiebt den Fokus in den Inhalt', async ({
    page,
  }) => {
    await page.goto(TRASH_PATH);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    const toDashboard = page
      .getByRole('button', { name: /Dashboard/u })
      .first();
    await toDashboard.click();

    await expect(
      page.getByRole('heading', { name: 'Dashboard' }),
    ).toBeVisible();
    // The focus is on the landing place, no longer on the clicked
    // entry — so the next tab key starts in the content.
    await expect(page.locator('main#inhalt')).toBeFocused();
    // And the announcement is there, for the screen reader.
    await expect(
      page.getByRole('status').filter({ hasText: 'Dashboard' }),
    ).toHaveCount(1);
  });

  test('Escape gibt den Fokus an den Auslöser zurück', async ({ page }) => {
    await page.goto('/');
    const trigger = page.getByRole('button', {
      name: /Organisations-Auswahl/u,
    });
    // The switcher exists only at the desktop width; at 360 px the
    // list is in the off-canvas menu.
    test.skip(
      (await trigger.count()) === 0,
      'Der Tenant-Umschalter ist eine Desktop-Überlagerung.',
    );

    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');

    await page.keyboard.press('Escape');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    // Without giving it back the focus would now be at the start of the document, and the
    // next tab key would start the whole header from the beginning.
    await expect(trigger).toBeFocused();
  });
});
