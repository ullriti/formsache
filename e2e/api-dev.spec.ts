import { expect, test } from '@playwright/test';

import { apiBaseUrl } from './env';

/**
 * Smoke request against the API **dev server** (and the guard
 * for the dev/build transformer split).
 *
 * A dependency-injected route is the point: with a transformer that cannot
 * emit `design:paramtypes`, NestJS boots happily, logs a green start line and
 * then answers every such route with 500. Booting is not evidence — a real
 * response is.
 *
 * The shared Zod schema is deliberately not imported here: the E2E project has
 * no dependency on `@formsache/shared`, and the contract is already checked from
 * source in `apps/api`.
 */
test('the API dev server answers /api/health from its injected service', async ({
  request,
}) => {
  const response = await request.get(`${apiBaseUrl}/api/health`);

  expect(response.status()).toBe(200);

  const body: unknown = await response.json();
  expect(body).toMatchObject({ status: 'ok' });
  expect(body).toHaveProperty('version', expect.any(String));
  expect(body).toHaveProperty('uptimeSeconds', expect.any(Number));
});
