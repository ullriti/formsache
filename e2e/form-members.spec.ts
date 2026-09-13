import { expect, test, type Locator } from '@playwright/test';

import { addQuestion, newForm, saveForm } from './app-flows';
import { authStateFile, seedMember } from './seed-account';

/**
 * Nutzerrechte je Formular — the half of the requirement that is about the
 * **page**, not about the guard chain behind it.
 *
 * The refusals (404 on responses, detail and CSV for a revoked person) are
 * proven end to end in `tenant-admin.spec.ts`, with a session that is already
 * open when the access goes away. What is left here is the one thing a unit
 * test cannot see and an integration test has no notion of: an **unsaved draft
 * must not travel from one form to another**.
 *
 * That is not a hypothetical. The rows of this page are keyed by user id, so
 * moving from `/forms/A/members` to `/forms/B/members` keeps
 * the row component mounted whenever the second list is already cached — and
 * „Speichern" then wrote the entries typed for A onto B. `useServerDraft` is
 * keyed on `${formId}:${userId}` because of it; this case is what would go red
 * if the form half of that key were ever dropped again.
 *
 * **The route change has to happen inside the application.** A `page.goto()`
 * reloads the document, unmounts everything and would pass with no key at all —
 * it would be a test of the browser. `page.goBack()` fires `popstate`, which is
 * exactly what this application's hand-written router listens to (`use-route.ts`),
 * so the component stays mounted and only its `formId` changes. That is the
 * transition the defect lived in.
 */

/**
 * Minimal browser global for the one `page.evaluate` below — the same reason
 * `app-flows.ts` declares its own: the root `tsconfig.json` that covers `e2e/`
 * deliberately has no DOM lib, and only the member actually used is declared
 * here rather than pulling `lib.dom` in for the whole project.
 */
declare const history: { go: (delta: number) => void };

test.use({ storageState: authStateFile });

/**
 * The one member of the Dachorganisation who is **not** an administrator.
 *
 * `seedMember` is `viewer` there (`apps/api/prisma/seed.ts`), which is what
 * makes them restrictable at all: an administrator gets „Sieht immer alles"
 * and no controls, so a case built on the signed-in superadmin's own row would
 * have nothing to toggle. Read from the environment like every other seeded
 * credential, never written down here.
 */
const RESTRICTABLE_EMAIL = seedMember.email;

test.describe('Nutzerrechte je Formular ', () => {
  test('ein ungespeicherter Entwurf wandert nicht mit, wenn das Formular wechselt', async ({
    page,
  }) => {
    // Two forms, both fresh, so nothing in this case depends on a restriction
    // an earlier run left behind.
    await newForm(page, 'Entwurf A');
    await addQuestion(page, 'Text', 'Name');
    await saveForm(page);
    const first = new URL(page.url()).pathname;

    const secondTitle = await newForm(page, 'Entwurf B');
    await addQuestion(page, 'Text', 'Name');
    await saveForm(page);
    const second = new URL(page.url()).pathname;

    const membersHeading = page.getByRole('heading', {
      name: 'Nutzerrechte',
      level: 1,
    });

    /*
     * From here on **one document**, and that is the whole apparatus of this
     * case. Everything below is either a click the application handles with
     * `navigate()` (`history.pushState`) or a history move — so the page is
     * never reloaded, the query cache survives, and `FormMembersView` stays
     * mounted across the change of `formId`. Two `page.goto()`s would look the
     * same in the report and prove nothing at all: a reload throws the draft
     * away by itself, so that version stays green with no key whatsoever.
     */
    await page.goto(`${first}/members`);
    await expect(membersHeading).toBeVisible();

    const rowOf = (): Locator =>
      page.getByRole('listitem').filter({ hasText: RESTRICTABLE_EMAIL });
    const switchOf = (): Locator => rowOf().getByRole('switch');

    await expect(
      rowOf(),
      `„${RESTRICTABLE_EMAIL}" must be a member of this organisation and not an ` +
        'administrator — an admin row carries „Sieht immer alles" and no ' +
        'controls, and this case would have nothing to toggle.',
    ).toHaveCount(1);

    // Both forms start unrestricted for this person — the baseline the
    // assertion at the end compares against.
    await expect(switchOf()).toBeChecked();

    // …to form B's page, the way a user gets there: dashboard, the card, the
    // form's own sub-navigation. Three `pushState` entries in this document.
    await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
    await page
      .getByRole('article')
      .filter({ hasText: secondTitle })
      .getByRole('button', { name: 'Bearbeiten' })
      .click();
    await expect(page).toHaveURL(new RegExp(`${second}$`, 'u'));
    await page
      .getByRole('navigation', { name: 'Aktuelles Formular' })
      .getByRole('button', { name: 'Nutzerrechte' })
      .click();
    await expect(page).toHaveURL(new RegExp(`${second}/members$`, 'u'));
    await expect(membersHeading).toBeVisible();
    await expect(switchOf()).toBeChecked();

    // The draft: typed for form B, never saved. „Speichern" appears because
    // the row is dirty, which is also the marker used below.
    await switchOf().click();
    await expect(switchOf()).not.toBeChecked();
    await expect(
      rowOf().getByRole('button', { name: 'Speichern', exact: true }),
    ).toBeVisible();

    /*
     * Back to form A in **one** step — the browser's own history, three entries
     * at once, which is what a long press on the back button offers. One step
     * at a time would pass through the builder and the dashboard and unmount
     * the view on the way, and an unmounted component loses its draft for a
     * reason that has nothing to do with the key. This jump is the only
     * transition in which the component survives a change of `formId`, and it
     * is therefore the only one that can tell the two keys apart.
     */
    await page.evaluate(() => {
      history.go(-3);
    });
    await page.waitForURL(new RegExp(`${first}/members$`, 'u'));
    await expect(membersHeading).toBeVisible();

    await expect(
      switchOf(),
      'The draft belonged to the other form. Carried along, „Speichern" here ' +
        'would write a revocation nobody asked for onto this form.',
    ).toBeChecked();
    await expect(
      rowOf().getByRole('button', { name: 'Speichern', exact: true }),
      'A row that is not dirty offers no save — a „Speichern" here would be ' +
        'the foreign draft still sitting in state.',
    ).toHaveCount(0);
  });
});
