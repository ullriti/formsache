import {
  expect,
  type Browser,
  type Locator,
  type Page,
} from '@playwright/test';

import type { A11yFixture } from '../a11y/views';
import {
  addQuestion,
  expectSaved,
  newForm,
  publishAndReadPath,
  saveForm,
} from '../app-flows';
import { authStateFile } from '../seed-account';

/**
 * What the view tour needs from the requirement in order to be looked at: a
 * form, its public address, a cached draft and
 * a submitted answer.
 *
 * **Why a file of its own and not the one from `a11y/`.** The view list
 * (`a11y/views.ts`) is read here and is the truth about *which* views there
 * are — it comes from the router and is counted against it by
 * `a11y-view-list.spec.ts`. The *preparation*, on the other hand, stands in
 * `a11y.spec.ts` in its `beforeAll` and cannot be called from there without
 * touching that file. Two tours, two preparations, one directory of the views:
 * the list cannot drift apart, the build-up is
 * doubled.
 *
 * **The residue is the same as there and is cleared away just the same**: a
 * form together with answer and draft, which {@link purgeFixtureForm} deletes
 * physically at the end.
 */

/** Width the preparation runs at — independent of the project. */
const SETUP_VIEWPORT = { width: 1280, height: 800 } as const;

/**
 * **Known findings of the answers table at 360 px — at present none.**
 *
 * The identity column stays put while the rest scrolls sideways
 * (`responses-view.css`: `position: sticky`, `z-index: 3` on the header cell),
 * and together with the selection column occupies around 244 of the 360 px. As
 * long as the test form's table is only a little wider than the screen, that is
 * a close race: measured on 2026-08-10 there was **no** scroll position in
 * which the middle of the sort button of „Eingereicht am (UTC)" lay free — it
 * could only be hit at its right edge. With today's
 * {@link FIXTURE_QUESTION_LABEL} the column is narrow enough for it to lie
 * free.
 *
 * The list is **conclusive**: empty means „kein Bedienelement liegt an jeder
 * Scrollposition unter einer klebenden Ebene", and one entry more makes the
 * cases red. If the finding comes back because a column gets wider, it belongs
 * in here by name instead of in a softer assurance — and what follows from it
 * is a layout decision (cap the width of the sticky column? not stick below the
 * breakpoint?) and belongs to `frontend`, not in a test file.
 */
export const RESPONSES_STICKY_SHADOW: readonly string[] = [];

/**
 * The one question of the test form, written out: `getByLabel` searches as a
 * substring, and sooner or later one word hits a second field.
 */
export const FIXTURE_QUESTION_LABEL = 'Name des Mitglieds';

/** The CSRF header of every writing request (`apps/web/src/api/http.ts`). */
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
 * Switches a switch **on** and checks that it is on afterwards.
 *
 * Deliberately not `setChecked`: this file takes exactly that out of the mobile
 * cases, and a helper that reintroduced it here would be the back door to it.
 * Here, however, it is **preparation**, not an assurance — that is why an
 * `expect` stands after it that proves the state, instead of relying on the
 * gesture.
 */
async function switchOn(control: Locator): Promise<void> {
  if (!(await control.isChecked())) {
    await control.click();
  }
  await expect(control).toBeChecked();
}

/**
 * Builds the test form up and returns the four addresses.
 *
 * The two public tokens (`/e/…`, `/a/…`) come into being only by somebody
 * really using the form — the server builds both addresses.
 *
 * **Two separate guest contexts**, for the reason `a11y.spec.ts` measured: the
 * submitting clears away the draft of the same participant, and then
 * `/e/<token>` shows „Entwurf verworfen" instead of the view that is to be
 * checked.
 */
export async function buildFixtureForm(browser: Browser): Promise<{
  readonly fixture: A11yFixture;
  readonly formId: string;
}> {
  const context = await browser.newContext({
    storageState: authStateFile,
    viewport: SETUP_VIEWPORT,
  });
  const page = await context.newPage();

  try {
    await newForm(page, 'Mobil-Rundfahrt');
    const formId = /\/forms\/([^/?#]+)/u.exec(page.url())?.[1];
    if (formId === undefined) {
      throw new Error(`Keine Formular-Id in ${page.url()}.`);
    }

    await addQuestion(page, 'Text', FIXTURE_QUESTION_LABEL);
    await saveForm(page);
    const publicPath = await publishAndReadPath(page);

    await page.goto(`/forms/${formId}/settings`);
    const access = page.getByRole('region', { name: 'Zugriff & Sicherheit' });
    await access.getByRole('radio', { name: 'Angepasst' }).check();
    await switchOn(
      access.getByRole('switch', { name: 'Zwischenspeichern erlauben' }),
    );
    await switchOn(
      access.getByRole('switch', { name: 'Bearbeiten nach Absenden' }),
    );
    await page.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expectSaved(page);

    const draftContext = await browser.newContext({ viewport: SETUP_VIEWPORT });
    const draftGuest = await draftContext.newPage();
    let draftUrl: string | null;
    try {
      await draftGuest.goto(publicPath);
      await draftGuest
        .getByLabel(new RegExp(FIXTURE_QUESTION_LABEL, 'u'))
        .fill('Anna Aufmerksam');
      await draftGuest
        .getByRole('button', { name: 'Zwischenspeichern' })
        .click();
      draftUrl = await draftGuest
        .getByTestId('public-draft-link')
        .getByRole('link')
        .getAttribute('href');
      expect(draftUrl, 'Adresse des Entwurfs').toMatch(
        /^https?:\/\/[^/]+\/e\/[A-Za-z0-9_-]+$/u,
      );
    } finally {
      await draftContext.close();
    }

    const sendContext = await browser.newContext({ viewport: SETUP_VIEWPORT });
    const sendGuest = await sendContext.newPage();
    try {
      await sendGuest.goto(publicPath);
      await sendGuest
        .getByLabel(new RegExp(FIXTURE_QUESTION_LABEL, 'u'))
        .fill('Bert Bedacht');
      await sendGuest.getByRole('button', { name: 'Absenden' }).click();
      const editUrl = await sendGuest
        .getByTestId('public-edit-link')
        .getByRole('link')
        .getAttribute('href');
      expect(editUrl, 'Adresse zum Bearbeiten').toMatch(
        /^https?:\/\/[^/]+\/a\/[A-Za-z0-9_-]+$/u,
      );

      return {
        formId,
        fixture: {
          formId,
          publicPath,
          draftPath: new URL(draftUrl ?? '').pathname,
          editPath: new URL(editUrl ?? '').pathname,
        },
      };
    } finally {
      await sendContext.close();
    }
  } finally {
    await context.close();
  }
}

/**
 * Takes the test form out of the organisation again — two requests, because
 * `DELETE /api/forms/:id/permanent` only takes what lies **in** the
 * wastebasket. The same order as in `a11y.spec.ts` and
 * `preview-test-mode.spec.ts`.
 */
export async function purgeFixtureForm(
  browser: Browser,
  formId: string | undefined,
): Promise<void> {
  if (formId === undefined) {
    return;
  }
  const context = await browser.newContext({ storageState: authStateFile });
  const page = await context.newPage();
  try {
    await page.goto('/');
    const headers = await csrfHeader(page);
    await page.request.delete(`/api/forms/${formId}`, { headers });
    await page.request.delete(`/api/forms/${formId}/permanent`, { headers });
  } finally {
    await context.close();
  }
}
