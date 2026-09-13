import { expect, test, type Page } from '@playwright/test';

import { expectDashboard, newForm } from './app-flows';
import { authStateFile } from './seed-account';

/**
 * Trash (handoff, Screens/Views) — the desktop half.
 *
 * The three traps named in the work order, each with its own case:
 *
 * 1. **Reachable over the navigation**, not merely by its address — Lehre 3
 *    (`CONTRIBUTING.md`). Case 1 clicks „🗑 Papierkorb" in the header; it does not
 *    `page.goto` the address directly.
 * 2. **The accessible name and the focus**, measured by a real browser rather
 *    than jsdom (the trap named explicitly in the work order): „Wiederherstellen"
 *    carries an icon span next to its text and only a browser resolves what
 *    `aria-hidden` actually removes from the name — and only a browser can say
 *    whether `focus()` on the view's `tabIndex={-1}` heading took, once the row
 *    that held the pressed button is gone.
 * 3. **A restore can be refused** . Reaching that state for
 *    real needs a full Antwortlimit or Veranstaltung — server-side coverage
 *    an earlier review already credits to `apps/api/test` — so case 3 isolates the
 *    **client's** handling of the 409 with `page.route`, the same technique
 *    the rest of this suite uses to reach states a fresh database cannot
 *    reliably produce on demand. It is not a substitute for that server
 *    coverage; it is what a browser adds on top: the sentence rendering
 *    correctly, the row staying, and the accessible name of the alert.
 *
 * Deliberately **not** a Testcontainers-only concern: the write route this
 * spec exercises (`POST /forms/:id/restore`) is genuine, and case 1 leaves the
 * form it created **active again** at the end — the same zero-residue shape
 * `newForm`'s own callers rely on elsewhere, now closed by an actual restore
 * instead of accepted as permanent (as an earlier docblock put it: the trash is
 * what lets the acceptance run stop leaving residue behind, and this is that promise
 * kept for a single form).
 */

test.use({ storageState: authStateFile });

const TRASH_PATH = '/admin/trash';

/**
 * The CSRF header every mutating request needs (`apps/web/src/api/http.ts`).
 * `page.request` shares the browser context's cookie jar automatically, so
 * only the header — the second half of the double-submit — is this helper's
 * job.
 */
async function csrfHeader(page: Page): Promise<Record<string, string>> {
  const cookies = await page.context().cookies();
  const token = cookies.find(
    (cookie) =>
      cookie.name === 'formsache_csrf' ||
      cookie.name === '__Host-formsache_csrf',
  )?.value;
  return token === undefined ? {} : { 'X-CSRF-Token': token };
}

/**
 * Moves a form into the trash the way a colleague's click would —
 * `DELETE /api/forms/:id`, without going through „× Löschen" on the Dashboard.
 * That control exists now (`e2e/dashboard-delete.spec.ts` covers it and the
 * round trip back out); this file is about the trash the deletion lands
 * in, not about where the deletion is requested from, so it keeps reaching
 * the same state the fast way.
 */
async function deleteFormViaApi(page: Page, formId: string): Promise<void> {
  const response = await page.request.delete(`/api/forms/${formId}`, {
    headers: await csrfHeader(page),
  });
  expect(response.status(), 'DELETE /api/forms/:id').toBe(204);
}

test.describe('Papierkorb ', () => {
  test('erreicht den Papierkorb über die Navigation, listet ein gelöschtes Formular und stellt es wieder her', async ({
    page,
  }) => {
    const title = await newForm(page, 'Papierkorb Formular');
    const formId = /\/forms\/([^/]+)/u.exec(page.url())?.[1];
    if (formId === undefined) {
      throw new Error(`Could not read the form id from ${page.url()}.`);
    }

    await deleteFormViaApi(page, formId);

    // Reachability over the navigation (Lehre 3) — not `page.goto`.
    await page.goto('/');
    await expectDashboard(page);
    await expect(page.getByRole('heading', { name: title })).toHaveCount(0);

    await page.getByRole('button', { name: 'Papierkorb' }).click();
    await expect(page).toHaveURL(new RegExp(`${TRASH_PATH}$`, 'u'));
    await expect(
      page.getByRole('heading', { name: 'Papierkorb', level: 1 }),
    ).toBeVisible();

    const row = page
      .getByTestId('trash-deleted-form')
      .filter({ hasText: title });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('0 Antworten');
    // Not asserted as an exact global count any more: `dashboard-delete.spec.ts`
    // now runs „× Löschen" against forms of this same organisation too (in the same
    // parallel project), so the badge can transiently read more than „1" while
    // that spec's own row is passing through. What stays true regardless is
    // that it is never „0" while this row is on screen.
    await expect(page.getByTestId('trash-forms-count')).not.toHaveText('0');

    // The accessible name of a new control, measured by a real browser
    // (trap #2) — the icon span next to the label must not leak into it.
    await expect(
      row.getByRole('button', { name: 'Wiederherstellen' }),
    ).toBeVisible();
    // The seeded superadmin holds every permission, so `canPurge` is true and
    // the row's own „Endgültig löschen" is offered too —
    // `endgueltig-loeschen.spec.ts` exercises pressing it; this case only
    // proves it is reachable at all, on the row this test itself created.
    await expect(
      row.getByRole('button', { name: 'Endgültig löschen' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: /Papierkorb leeren/ }),
    ).toBeVisible();

    await row.getByRole('button', { name: 'Wiederherstellen' }).click();
    await expect(row).toHaveCount(0);

    /*
      **Focus after the restore, in a real browser** — the half jsdom cannot
      answer, and the claim the first version of this commit made in prose with
      nothing asserting it anywhere.

      The target is the view's `<h1>`, not the section heading: whether that
      heading survives a restore depends on what else happens to be in this
      organisation's trash — and this file no longer assumes it is the only spec
      putting a row there (`dashboard-delete.spec.ts`, `trash-purge.spec.ts`
      run in the same parallel project against the same organisation), so it does not
      assert the section is empty, only that *this* row (already checked
      above) is gone. The fully-emptied case — where the section itself
      unmounts and focus would otherwise fall to `<body>` — is pinned
      deterministically in `TrashView.test.tsx`, which controls every row in
      its fixture and can promise „the last one". What a browser adds here is
      that `focus()` on a `tabIndex={-1}` heading actually takes, which jsdom
      would report green either way.
    */
    await expect(
      page.getByRole('heading', { name: 'Papierkorb', level: 1 }),
    ).toBeFocused();
    await expect(page.locator('body')).not.toBeFocused();

    // Back on the Dashboard through the SPA router, not a reload — proving
    // `FORMS_QUERY_KEY` was actually invalidated (`api/trash.ts`) rather than
    // merely surviving a fresh page load.
    //
    // `exact: true` for the reason `dashboard-delete.spec.ts` writes out in
    // full at the same click: this starts on the Papierkorb, and every row
    // there carries a button named „„<Titel>" endgültig löschen". A form whose
    // title begins with „Dashboard" — `dashboard-delete.spec.ts` creates one —
    // makes the unanchored name match twice.
    await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
    await expectDashboard(page);
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
  });

  /**
   * The trap named in the work order, isolated on the client. `page.route`
   * serves a trash with one deleted answer and answers its restore with a
   * 409 in the shape `TrashService.restoreResponse` sends
   * (`ConflictException(outcome.refusal)`, the requirement) — reaching that
   * state for real needs a filled Antwortlimit or Veranstaltung, coverage an
   * earlier review credits to `apps/api/test`.
   *
   * **The shape is `{ message, reason, position: { questionId, eventKey } }`**,
   * per `restoreRefusalSchema`. This project deliberately keeps `@formsache/shared`
   * out of the E2E project (`api-dev.spec.ts` says why), so nothing here can
   * parse the fixture against that schema — the guard against it drifting again
   * lives in `apps/web/src/views/TrashView.test.tsx`, which does exactly that
   * with the same body. An earlier version of both sent `{ pageIndex,
   * questionId }`, a shape the server cannot produce, under a comment claiming
   * it was what the server sends.
   */
  test('eine abgelehnte Wiederherstellung einer Antwort bleibt im Papierkorb, zeigt den Grund, und lädt die Liste neu', async ({
    page,
  }) => {
    const refusalMessage =
      'Eine Veranstaltung dieser Antwort ist inzwischen ausgebucht. Die Antwort bleibt im Papierkorb.';
    let trashRequests = 0;

    await page.route('**/api/trash', async (route) => {
      trashRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          forms: [],
          responses: [
            {
              id: '00000000-0000-4000-8000-000000000abc',
              formId: '00000000-0000-4000-8000-000000000def',
              formTitle: 'Jahrestreffen-Anmeldung',
              submittedAt: '2026-07-01T08:00:00.000Z',
              deletedAt: '2026-07-21T09:00:00.000Z',
            },
          ],
        }),
      });
    });
    await page.route('**/api/forms/*/responses/*/restore', async (route) => {
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          message: refusalMessage,
          reason: 'event_full',
          position: { questionId: 'q-anreise', eventKey: 'freitag-abend' },
        }),
      });
    });

    await page.goto(TRASH_PATH);
    await expect(
      page.getByRole('heading', { name: 'Papierkorb', level: 1 }),
    ).toBeVisible();

    const row = page
      .getByTestId('trash-deleted-response')
      .filter({ hasText: 'Jahrestreffen-Anmeldung' });
    await expect(row).toHaveCount(1);
    const requestsBeforeClick = trashRequests;

    await row.getByRole('button', { name: 'Wiederherstellen' }).click();

    // The server's own sentence, on an accessible alert — real browser
    // accname computation, not jsdom.
    await expect(row.getByRole('alert')).toHaveText(refusalMessage);
    // The row is still here — a refusal is not a removal.
    await expect(row).toHaveCount(1);
    // …and the list was read again regardless of the refusal, so the counter
    // cannot end up trusting a moment that already passed.
    await expect.poll(() => trashRequests).toBeGreaterThan(requestsBeforeClick);
  });
});
