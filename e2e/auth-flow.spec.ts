import { expect, request as apiRequest, test } from '@playwright/test';

import {
  expectDashboard,
  expectLoginView,
  logOut,
  submitLogin,
} from './app-flows';
import { webBaseUrl } from './env';
import { seedAdmin } from './seed-account';

/**
 * The acceptance run — *„App startet, Login, leeres Dashboard"* — as a
 * flow, in both viewports.
 *
 * The logout half is what makes this more than a screenshot. Two things are
 * asked of it, and each needs its own kind of evidence:
 *
 * 1. the browser no longer holds an authenticated session — asked through the
 *    context's own cookie jar;
 * 2. the token itself is worthless, even when presented again. That cannot be
 *    seen from the browser: after the logout the jar is empty, so a 401 there
 *    is equally consistent with "cookie cleared, session still live". The
 *    cookies are therefore copied *before* the logout and replayed afterwards
 *    from a separate request context — which is the requirement in the terms a
 *    stolen cookie would use.
 */
test('meldet an, zeigt das leere Dashboard und beendet die Sitzung serverseitig', async ({
  page,
}) => {
  await page.goto('/');
  await expectLoginView(page);

  expect(await submitLogin(page, seedAdmin)).toBe(200);
  await expectDashboard(page);

  // Asserted *before* the logout as well: a 401 afterwards proves nothing if
  // the session was never valid to begin with.
  const beforeLogout = await page.request.get('/api/auth/me');
  expect(beforeLogout.status()).toBe(200);

  // Copied by name and value, whatever they are — the suite has no business
  // knowing what the session cookie is called.
  const jar = await page.context().cookies();
  expect(jar.length).toBeGreaterThan(0);
  const replayHeader = jar
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');

  await logOut(page);
  await expectLoginView(page);

  const afterLogout = await page.request.get('/api/auth/me');
  expect(
    afterLogout.status(),
    'After the logout the browser must no longer hold an authenticated ' +
      'session.',
  ).toBe(401);

  const replay = await apiRequest.newContext({
    baseURL: webBaseUrl,
    extraHTTPHeaders: { cookie: replayHeader },
  });
  try {
    const replayed = await replay.get('/api/auth/me');
    expect(
      replayed.status(),
      'Replaying the cookie from before the logout must fail: a logout that ' +
        'only clears the cookie leaves a live token in the hands of whoever ' +
        'copied it.',
    ).toBe(401);
  } finally {
    await replay.dispose();
  }
});
