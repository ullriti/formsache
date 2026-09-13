import { expect, type Page } from '@playwright/test';

import { addQuestion, openMobileMenu, saveForm } from '../app-flows';
import { CROP_SAMPLE_PNG_BASE64 } from '../sample-image';
import type { A11yAudience, A11yFixture } from './views';

/**
 * **What the axe run visits that has no address** (a review finding, 2026-08-12).
 *
 * `views.ts` next door is complete against the router — and was nevertheless
 * half the check list. Nine dialogs, three popovers and two states of the
 * fill-out mask were never scanned, because none of them has a URL and the
 * count against `parseRoute` therefore could not miss them. A guard that
 * only counts what it can count reports completeness and is not complete.
 *
 * That weighs more heavily than the number suggests: a dialog is the form in
 * which this application shows its consequential steps — publishing,
 * deleting permanently, creating a template, choosing an image crop. And it
 * is the form in which accessibility breaks most readily: focus, roles,
 * labels and the question of what is still reachable *behind* the dialog.
 *
 * **The guard for it lives in `overlay-sources.ts`**: it reads `role="dialog"`
 * from the source text and counts it against the `source` entries here — the same
 * construction as `router-kinds.ts` for the addresses. Popovers and page states
 * do not fall under it and are expressly marked here as `source: null`;
 * for them there is no mechanical lower bound, and this
 * sentence is the only place where that is written down.
 *
 * **What is *not* measured here:** touch targets and the horizontal
 * scrollbar. The four mobile guards read `A11Y_VIEWS`, not this list —
 * deliberately, because they measure properties of the *page* and an open dialog
 * is a different question. It stands as a review finding and is not fixed.
 */

/** The width at which an overlay exists at all. */
export type A11yWidth =
  /** Present in both projects. */
  | 'any'
  /** Only from 1180 px up — the sheets replace them below that. */
  | 'desktop'
  /** Only below that — off-canvas instead of a column. */
  | 'mobile';

/**
 * What the overlays need in addition to the form.
 *
 * Separate from {@link A11yFixture}, because `mobile/fixture.ts` does not build
 * this part: the four mobile guards only run through the views. A shared
 * interface would force them to create a password-protected form that
 * they never look at.
 */
export interface A11yOverlayFixture extends A11yFixture {
  /** `/f/<Adresse>` of a **password-protected** form. */
  readonly passwordPath: string;
  /** The subject of the mail that is sitting in the queue. */
  readonly mailSubject: string;
  /** The label of the first question — the one that gets filled in. */
  readonly firstQuestionLabel: string;
}

export interface A11yOverlay {
  /** Appears like this in the test name and in the report. */
  readonly name: string;
  readonly audience: A11yAudience;
  readonly width: A11yWidth;
  /**
   * The component file relative to `apps/web/src`, if the overlay is a
   * `role="dialog"` — otherwise `null`.
   *
   * Only the non-`null` entries are counted against the source text
   * (`overlay-sources.ts`). A dialog without an entry here turns the guard red;
   * a popover it cannot miss, and that is written down like this instead of
   * being tacitly accepted.
   */
  readonly source: string | null;
  /** Opens the overlay and waits until it is really there. */
  readonly open: (page: Page, fixture: A11yOverlayFixture) => Promise<void>;
}

/**
 * Clicks a button of the **pages column** — and opens it beforehand if it
 * currently is an off-canvas sheet.
 *
 * The decision is made on the presence of the button, not on a width: the
 * breakpoints live in the CSS, and a number that stands here a second time
 * is one that drifts apart at the next rebuild.
 */
async function inPagesArea(page: Page, name: string): Promise<void> {
  const target = page.getByRole('button', { name });
  if ((await target.count()) === 0) {
    await page.getByRole('button', { name: 'Seiten' }).click();
  }
  await target.click();
}

/**
 * The same for the shell: the header actions sit below the
 * breakpoint in the menu sheet.
 */
async function inShell(page: Page, name: RegExp): Promise<void> {
  const target = page.getByRole('button', { name });
  if ((await target.count()) === 0) {
    await openMobileMenu(page);
  }
  await target.click();
}

/** The builder of the check form, loaded. */
async function openBuilder(
  page: Page,
  fixture: A11yOverlayFixture,
): Promise<void> {
  await page.goto(`/forms/${fixture.formId}`);
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
}

/** The responses table of the check form, with at least one row. */
async function openResponses(
  page: Page,
  fixture: A11yOverlayFixture,
): Promise<void> {
  await page.goto(`/forms/${fixture.formId}/responses`);
  await expect(
    page.getByRole('button', { name: 'Ansehen' }).first(),
  ).toBeVisible();
}

export const A11Y_OVERLAYS: readonly A11yOverlay[] = [
  // --- Dialogs in the builder -----------------------------------------------
  {
    name: 'Dialog · Vorlagen & Blöcke',
    audience: 'signed-in',
    width: 'any',
    source: 'views/builder/TemplateDrawer.tsx',
    open: async (page, fixture) => {
      await openBuilder(page, fixture);
      await inPagesArea(page, 'Vorlagen & Blöcke');
      const drawer = page.getByRole('dialog', { name: 'Vorlagen & Blöcke' });
      await expect(drawer).toBeVisible();
      // The loading state is a different view from the loaded list — and
      // the one with markedly fewer controls. The same reasoning as
      // `settled()` in `views.ts`.
      await expect(drawer.getByText('Vorlagen werden geladen…')).toHaveCount(0);
    },
  },
  {
    name: 'Dialog · Formular als Vorlage speichern',
    audience: 'signed-in',
    width: 'any',
    source: 'views/builder/TemplateSavePrompt.tsx',
    open: async (page, fixture) => {
      await openBuilder(page, fixture);
      // **„Formular als Vorlage speichern", not „Als Vorlage speichern".**
      // The latter lives in the properties panel and exists only while a
      // question is selected — after loading a saved form none
      // is selected. The button of the pages column is the one
      // that always exists.
      await inPagesArea(page, 'Formular als Vorlage speichern');
      await expect(
        page.getByRole('dialog', { name: 'Formular als Vorlage speichern' }),
      ).toBeVisible();
    },
  },
  {
    /*
     * **The dialog when publishing again.** `needsPublishNotice` does not ask
     * „wurde schon einmal veröffentlicht" but „gibt es Antworten
     * *und* haben sich Fragen geändert" — which is why this entry creates a
     * question and saves it. Nothing is confirmed; the dialog stays
     * open, so that axe measures it in the open state.
     *
     * ⚠️ Since ADR-0028 there is a **second** reason, and on its own it would
     * already be enough here: incomplete legal texts of the organisation. The
     * setup stays nevertheless, because it shows the dialog in its *full* shape
     * — legal-text hint, response count and change list
     * on top of each other. Exactly that is the object of the scan; a dialog with only
     * one section would have less to check.
     *
     * What does **not** apply here: the first publication of a form
     * goes out without any confirmation (`form.status !== 'active'` in
     * `BuilderView.onPublishRequested`). The check form of the preparation is
     * already published, so this click is the repeat one.
     */
    name: 'Dialog · Erneut veröffentlichen',
    audience: 'signed-in',
    width: 'any',
    source: 'views/builder/PublishNotice.tsx',
    open: async (page, fixture) => {
      await openBuilder(page, fixture);
      await addQuestion(page, 'Text');
      await saveForm(page);
      await page.getByRole('button', { name: 'Veröffentlichen' }).click();
      await expect(
        page.getByRole('dialog', { name: /veröffentlichen/iu }),
      ).toBeVisible();
    },
  },
  {
    /*
      **Ungespeicherte Änderungen** — the confirmation before leaving the
      builder (review finding 21a).

      ⚠️ **Why this list knows the dialog.** The guard in
      `a11y-view-list.spec.ts` stays red as long as a dialog like this one
      is missing.

      **A navigation entry, expressly not `page.goBack()`.** The
      back button would be the more elegant trigger — the dialog handles
      `popstate` specially —, but only *within* one document: the block
      hangs on `setNavigationBlocker` in `use-route.ts`, and that only sees what
      the same page does. Two `page.goto` in a row are two
      document loads, and the step back between them is a
      document change that the running application does not notice. Written
      exactly like that, this entry came first, and it ran into a
      locator timeout in both widths — measured, not assumed.

      The question is created and **not** saved: „ungespeichert" is the
      whole condition. The check form on the server stays untouched by it.
    */
    name: 'Dialog · Ungespeicherte Änderungen',
    audience: 'signed-in',
    width: 'any',
    source: 'builder/DraftGuardDialog.tsx',
    open: async (page, fixture) => {
      await openBuilder(page, fixture);
      await addQuestion(page, 'Text', 'Noch nicht gespeichert');

      /*
        The entries live in the column from 1180 px up and below that in the
        off-canvas sheet. The decision is made on the presence of the button, not
        on a width — the same reasoning as in `inPagesArea` above: the
        breakpoints live in the CSS, and a number that stood here a second
        time would drift apart at the next rebuild.

        **Searched page-wide, not within `navigation[name="Aktuelles Formular"]`.**
        The two widths build this group differently: the column is
        a `<nav aria-label="Aktuelles Formular">` (`FormNav.tsx`), in the sheet
        „Aktuelles Formular" is only a heading above the buttons. Restricted to
        `navigation`, the query found nothing in the sheet and ran into
        a timeout — measured.

        `exact: true` is load-bearing here: the toolbar of the builder carries
        a button of its own, „⚙ Einstellungen", whose accessible name
        is „Einstellungen" and which a substring search caught along with it.
      */
      const entry = page.getByRole('button', {
        name: 'Formular-Einstellungen',
        exact: true,
      });
      if ((await entry.count()) === 0) {
        await openMobileMenu(page);
      }
      await entry.click();

      await expect(
        page.getByRole('dialog', { name: 'Ungespeicherte Änderungen' }),
      ).toBeVisible();
    },
  },
  {
    /*
      **Änderungen verwerfen** — the builder's second confirmation, and the
      only one that destroys work without anybody leaving the view.

      It is a component of its own (`DiscardChangesDialog`), but lives in
      `views/BuilderView.tsx` instead of in a file of its name — and thus
      the `source` here carries a *view* file. It is the only one of the
      application that itself opens a `role="dialog"`; that is exactly where the
      guard in `a11y-view-list.spec.ts` got stuck when the confirmation
      was added (the first real CI run, 2026-08-18).

      **The same condition as with the entry above and for the same reason:**
      the button „Änderungen verwerfen" is `disabled` as long as nothing is
      unsaved (`!isDirty`) — the question is created and
      **not** saved. The check form on the server stays untouched;
      nothing is confirmed, the dialog stays open.

      The button lives in the toolbar of the builder, which exists in both
      widths (the same bar in which `saveForm` finds „Speichern") —
      hence `width: 'any'` and no detour via the off-canvas menu.
    */
    name: 'Dialog · Änderungen verwerfen',
    audience: 'signed-in',
    width: 'any',
    source: 'views/BuilderView.tsx',
    open: async (page, fixture) => {
      await openBuilder(page, fixture);
      await addQuestion(page, 'Text', 'Wird gleich verworfen');

      // `exact: true`: the dialog that is about to open carries „Änderungen
      // verwerfen" as its heading and would be a second hit for a
      // substring search.
      await page
        .getByRole('button', { name: 'Änderungen verwerfen', exact: true })
        .click();

      await expect(
        page.getByRole('dialog', { name: 'Änderungen verwerfen' }),
      ).toBeVisible();
    },
  },
  {
    name: 'Dialog · Eigenschaften (Off-Canvas)',
    audience: 'signed-in',
    width: 'mobile',
    source: 'views/builder/BuilderSheet.tsx',
    open: async (page, fixture) => {
      await openBuilder(page, fixture);
      await page.getByRole('button', { name: 'Eigenschaften' }).click();
      await expect(
        page.getByRole('dialog', { name: 'Eigenschaften' }),
      ).toBeVisible();
    },
  },
  {
    name: 'Dialog · Seiten (Off-Canvas)',
    audience: 'signed-in',
    width: 'mobile',
    // The same component as „Eigenschaften" next door — `BuilderSheet` carries
    // both shapes and distinguishes them only by the `aria-label`. The entry
    // needs the real source, not `source: null`: a `role="dialog"`
    // would otherwise contradict the contract of `source`, and the lower bound of the
    // non-dialogs would soften. The `covered` set is a set,
    // so naming the same file twice does not hurt.
    source: 'views/builder/BuilderSheet.tsx',
    open: async (page, fixture) => {
      await openBuilder(page, fixture);
      await page.getByRole('button', { name: 'Seiten' }).click();
      await expect(page.getByRole('dialog', { name: 'Seiten' })).toBeVisible();
    },
  },

  // --- Dialogs in the lists --------------------------------------------------
  {
    name: 'Dialog · Antwort ansehen',
    audience: 'signed-in',
    width: 'any',
    source: 'views/responses/ResponseDetailPanel.tsx',
    open: async (page, fixture) => {
      await openResponses(page, fixture);
      await page.getByRole('button', { name: 'Ansehen' }).first().click();
      await expect(page.getByRole('dialog', { name: 'Antwort' })).toBeVisible();
    },
  },
  {
    name: 'Dialog · E-Mail ansehen',
    audience: 'signed-in',
    width: 'any',
    source: 'views/MailLogView.tsx',
    open: async (page, fixture) => {
      await page.goto('/mail-log');
      // The row of the notification that `a11y.spec.ts` created: its
      // subject *is* the button. An arbitrary first row would be a case that
      // checks nothing against an empty log and would still report green.
      // `.first()`: the subject is the same per notification, and there is
      // one row per submitted response. Which one is opened is irrelevant for the
      // check of the dialog — that **one** of them was produced by this
      // preparation is the point.
      await page
        .getByRole('button', { name: fixture.mailSubject })
        .first()
        .click();
      await expect(
        page.getByRole('dialog', { name: 'E-Mail ansehen' }),
      ).toBeVisible();
    },
  },
  {
    name: 'Dialog · Ausschnitt wählen',
    audience: 'signed-in',
    width: 'any',
    source: 'views/tenant-admin/LogoCropDialog.tsx',
    open: async (page) => {
      await page.goto('/admin/appearance');
      const picker = page.locator('input[type="file"]');
      await expect(picker).toBeEnabled();
      await picker.setInputFiles({
        name: 'Logo.png',
        mimeType: 'image/png',
        buffer: Buffer.from(CROP_SAMPLE_PNG_BASE64, 'base64'),
      });
      await expect(
        page.getByRole('dialog', { name: 'Ausschnitt wählen' }),
      ).toBeVisible();
    },
  },

  // --- The shell -------------------------------------------------------------
  {
    name: 'Dialog · Menü (Off-Canvas)',
    audience: 'signed-in',
    width: 'mobile',
    source: 'shell/MobileMenuSheet.tsx',
    open: async (page) => {
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await openMobileMenu(page);
    },
  },
  {
    /*
     * **The only entry that fakes responses** — two of them, in fact, because the
     * button is not there without both: `aiFormsAvailable` decides whether it
     * is offered, and the quota stands in the dialog. The AI feature is
     * shipped, but switched off without a provider, so without this
     * interception there would be no way to see the dialog at all — and the
     * axe run would pass by the only view that displays an AI
     * text. The same interception as in `announcements.spec.ts`.
     */
    name: 'Dialog · Formular mit KI erstellen',
    audience: 'signed-in',
    width: 'any',
    source: 'shell/AiFormDialog.tsx',
    open: async (page) => {
      await page.route('**/api/auth/me', async (route) => {
        const response = await route.fetch();
        const session = (await response.json()) as Record<string, unknown>;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ...session, aiFormsAvailable: true }),
        });
      });
      await page.route('**/api/ai/quota', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ used: 2, limit: 50 }),
        });
      });

      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await inShell(page, /KI-Formular/u);
      await expect(
        page.getByRole('dialog', { name: 'Formular mit KI erstellen' }),
      ).toBeVisible();
    },
  },
  {
    name: 'Popover · Organisations-Auswahl',
    audience: 'signed-in',
    width: 'desktop',
    source: null,
    open: async (page) => {
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const trigger = page.getByRole('button', {
        name: /Organisations-Auswahl/u,
      });
      await trigger.click();
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
      /*
        **And that the list really stands inside it.** `aria-expanded` alone would
        be too little here: `TenantList` shows an account without a membership only
        one sentence („Diesem Konto ist noch kein Tenant zugeordnet."). That case
        would be green and would have said nothing about the rows of the switcher —
        buttons, `aria-current`, waiting state. With „Felder" and
        „Export" next door the content hangs on the same `isOpen` and cannot be
        empty; here it can be.
      */
      await expect(
        page.getByRole('button', {
          name: /Dachorganisation/u,
        }),
      ).toBeVisible();
    },
  },

  // --- The popovers of the responses table -----------------------------------
  {
    name: 'Popover · Angezeigte Spalten',
    audience: 'signed-in',
    width: 'any',
    source: null,
    open: async (page, fixture) => {
      await openResponses(page, fixture);
      const trigger = page.getByRole('button', { name: /Felder/u });
      await trigger.click();
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
      await expect(page.getByText(/^Angezeigte Spalten/u)).toBeVisible();
    },
  },
  {
    name: 'Popover · Export',
    audience: 'signed-in',
    width: 'any',
    source: null,
    open: async (page, fixture) => {
      await openResponses(page, fixture);
      const trigger = page.getByRole('button', { name: /Export/u });
      await trigger.click();
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
      // The format links are exactly the elements on which the
      // `color-contrast` violation hung — a case that does not see them would
      // not have found it.
      await expect(page.getByRole('link', { name: /CSV/u })).toBeVisible();
    },
  },

  // --- States of the fill-out mask, without signing in -----------------------
  {
    /*
     * The password screen is not a route: the same address `/f/<…>` shows it
     * *instead of* the questions as long as the access word is missing. Exactly
     * for that reason the count against `parseRoute` could not miss it — and exactly
     * for that reason it is the first page a participant of a protected form
     * gets to see at all.
     */
    name: 'Ausfüllen · Passwortschirm',
    audience: 'public',
    width: 'any',
    source: null,
    open: async (page, fixture) => {
      await page.goto(fixture.passwordPath);
      await expect(page.getByLabel('Zugangswort')).toBeVisible();
    },
  },
  {
    /*
     * And the last one: the confirmation after submitting. It replaces the
     * questions at the same address and is thus likewise not a route — for
     * the largest part of the users of this application it is the last page
     * they ever see.
     */
    name: 'Ausfüllen · Bestätigung nach dem Absenden',
    audience: 'public',
    width: 'any',
    source: null,
    open: async (page, fixture) => {
      await page.goto(fixture.publicPath);
      await page
        .getByLabel(new RegExp(fixture.firstQuestionLabel, 'u'))
        .fill('Clara Cordial');
      await page.getByRole('button', { name: 'Absenden' }).click();
      await expect(page.getByTestId('public-edit-link')).toBeVisible();
    },
  },
];
