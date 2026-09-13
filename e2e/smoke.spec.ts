import { expect, test } from '@playwright/test';

/**
 * Smoke test: the web app is served and renders. The real
 * "Login → empty dashboard" flow is proven in `auth-flow.spec.ts`.
 */
test('the web app answers and renders its title', async ({ page }) => {
  const response = await page.goto('/');

  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Formsache' })).toBeVisible();
});
