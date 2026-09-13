import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  addQuestion,
  expectDashboard,
  expectLoginView,
  expectNoHorizontalScroll,
  expectSaved,
  newForm,
  openFormSettings,
  saveForm,
  submitLogin,
} from './app-flows';
import { expectNoControlCovered } from './mobile/operable';
import { seedMember, tenantAdminStateFile } from './seed-account';

/**
 * **The notice before publishing, in all its parts** — the hint about this
 * organisation's legal texts (ADR-0028, open item 3), the hint about the
 * privacy notice of *this form* (no. 4), and the narrow layout both of them
 * have to survive.
 *
 * The file is read from the top down; the two blocks added on 2026-08-20 carry
 * their own reasoning where they stand. What follows here is the first
 * subject, which is also the one the file's identities and its residue are
 * shaped by.
 *
 * ---
 *
 * **The hint about this organisation's legal texts, in two stages** (ADR-0028,
 * open item 3) — and the guard that stands between them.
 *
 * 1. *That* something is missing comes out of the publish preview
 *    (`publishPreviewSchema.organisationLegal`), which stands behind
 *    `can_build` — the right that publishes — and therefore reaches
 *    **everybody** who can press the button.
 * 2. *What* is missing comes out of `GET /api/tenant/legal` behind
 *    `can_manage_settings`. Whoever holds the documents anyway gets the two
 *    pages by name; whoever does not gets the sentence without them.
 *
 * ## The gap this file closes
 *
 * `BuilderView.test.tsx` covers both stages against a mocked session and a
 * mocked preview — which is the half that can be mocked. What no case has ever
 * driven is the other half: that the preview really comes over the route, that
 * `TenantLegalController`'s guard really refuses the editor, and that the
 * second query is therefore not even issued for that person. Until now `e2e/`
 * knew the notice only as something to click away (`confirmPublishNotice` in
 * `app-flows.ts`) and never read a word of it.
 *
 * The first case alone would be weak evidence: „kein Seitenname zu sehen" is
 * also true of a hint that has gone missing entirely, or of a run in which the
 * guarded route simply answers nothing to anybody. The second case is
 * therefore its counter-check under the **same** organisation and the same two
 * unfinished pages, and the pair is what makes the assurance one.
 *
 * ## The two identities, and why neither is a parked session
 *
 * The seed's `editor` group is `can_build` **without** `can_manage_settings`
 * (`apps/api/prisma/seed.ts`, `DEFAULT_GROUPS`), and `seedMember` holds it in
 * Musterstadt — the only account of this installation that can publish and may
 * not read the legal texts. Neither parked state can stand in for it: both
 * `authStateFile` and `tenantAdminStateFile` are `admin` groups and hold every
 * permission there is, so under either of them the first case would be green
 * for the wrong reason or not exist at all.
 *
 * That costs the **ninth** of the ten logins per minute the shared bucket
 * holds; the arithmetic is kept in `auth.setup.ts` and names this file. It is
 * one login, not two: the second case takes the parked organisation admin of
 * the very same organisation, who is exactly the reader the first one is
 * measured against.
 *
 * ## Why every case publishes twice
 *
 * The dialog does not exist on a first publication: `BuilderView` asks
 * `form.status` first and posts without fetching a preview at all while a form
 * has never been published. And a republish only unlocks once a saved change
 * stands against the published version (`nothingToPublish`), so each case
 * builds, publishes, adds a question, saves, and only then meets the notice.
 * `buildPublishAndRepublish` is that sequence, and every case starts with it;
 * the case about this form's own notice goes round a second time, because its
 * second state only comes into being between the two.
 *
 * ## Residue
 *
 * **Four forms in Musterstadt** — one per case, each cleared away for good in
 * its own `finally` (`DELETE /api/forms/:id`, then `…/permanent` — the
 * sequence `preview-test-mode.spec.ts` uses), and nothing else. The third case
 * additionally writes the privacy notice **of its own form**
 * (`form.privacy_notice`), which is a column of that one row and goes with it.
 *
 * **`tenant.legal_pages` is deliberately not touched**, neither written nor
 * restored. The row is `NULL` for every seeded organisation — the migration
 * creates it empty, the seed writes nothing into it and no spec saves anything
 * — and that empty state is what three other places measure: the open item on
 * the dashboard (`mobile-targets.spec.ts` counts it in), the notice
 * `confirmPublishNotice` expects on every republish of the suite, and three of
 * the four cases below. A run that filled it in to make its own assertion more
 * comfortable would take the subject away from all three at once.
 *
 * The one state this file therefore cannot reach is `incomplete` for the
 * organisation — it needs an organisation whose two pages are both started and
 * neither finished, and there is exactly one place in the suite that owns such
 * an organisation: `durchlauf-organisationen.spec.ts`, Schritt 2b (4b). The
 * two files divide the three states of one traffic light along the one line
 * that decides it: who may write the row.
 */

/**
 * The titles of the two pages an organisation fills, as literals.
 *
 * Not read from `TENANT_LEGAL_TEMPLATES`: this project deliberately keeps
 * `@formsache/shared` out of `e2e/` (`api-dev.spec.ts` gives the reason), and
 * these are the words on the screen anyway — which is the level every other
 * assertion of this suite works at. `tenant-admin.spec.ts` names the same two
 * cards the same way.
 */
const LEGAL_PAGE_TITLES = ['Anbieterangaben', 'Datenschutzhinweise'] as const;

/** The heading of the hint while **nothing at all** is on file. */
const EMPTY_HEADING = 'Für diese Organisation fehlen Rechtstexte.';

/**
 * The **form's own** privacy notice, in the four strings this file needs
 * (ADR-0028 no. 4).
 *
 * Note the two that differ by one letter, and that the difference is
 * load-bearing rather than a typo: the section inside the dialog is named
 * „Datenschutzhinweis zu diesem Formular" (singular), the card in the form
 * settings that writes it carries the template's title
 * „Datenschutzhinweise zu diesem Formular" (plural). Playwright matches an
 * accessible name as a case-insensitive **substring**, so the singular would
 * happily match the plural — the other way round it cannot, which is why the
 * region below is addressed by the singular and nothing here is left to
 * chance.
 */
const FORM_NOTICE_REGION = 'Datenschutzhinweis zu diesem Formular';
const FORM_NOTICE_CARD = 'Datenschutzhinweise zu diesem Formular';
const FORM_NOTICE_EMPTY =
  'Zu diesem Formular ist kein Datenschutzhinweis hinterlegt.';
const FORM_NOTICE_INCOMPLETE =
  'Der Datenschutzhinweis zu diesem Formular ist unvollständig.';

/**
 * The one field this file fills, and the sentence it fills it with.
 *
 * `ZWECK` is the first slot of `FORM_PRIVACY_TEMPLATE`, and filling it alone
 * is what makes the notice `incomplete`: something is stored, and
 * `RECHTSGRUNDLAGE` and `AUFBEWAHRUNG` are still open. The sentence carries a
 * stamp, so that „steht dieser Text hier?" is a question about *this* run and
 * cannot be answered by a leftover of an earlier one.
 */
const PURPOSE_LABEL = 'Zweck dieses Formulars';
const PURPOSE_TEXT = `Anmeldung zur Jahrestagung, Prüflauf ${Date.now().toString(36)}`;

/** The notice itself — named by its title, not by a class. */
function publishNotice(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Erneut veröffentlichen?' });
}

/**
 * The section about the **organisation's** legal texts inside it.
 *
 * Scoped to the section rather than to the whole dialog, and that is
 * load-bearing for the negative assertions below: the notice of *this form's*
 * privacy statement stands above it and legitimately carries the words
 * „Datenschutzhinweise zu diesem Formular" (ADR-0028 no. 4) — a fresh form has
 * none, so that section is there in both cases. „Kommt der Seitenname vor?" is
 * therefore a question about this region.
 */
function legalHint(page: Page): Locator {
  return publishNotice(page).getByRole('region', {
    name: 'Rechtstexte dieser Organisation',
  });
}

/**
 * The section about the **form's own** privacy notice — the one that stands
 * *above* the organisation's (ADR-0028 no. 4).
 */
function formNoticeHint(page: Page): Locator {
  return publishNotice(page).getByRole('region', { name: FORM_NOTICE_REGION });
}

/** The CSRF header every writing request carries (`apps/web/src/api/http.ts`). */
async function csrfHeader(page: Page): Promise<Record<string, string>> {
  const cookies = await page.context().cookies();
  const token = cookies.find(
    (cookie) =>
      cookie.name === 'formsache_csrf' ||
      cookie.name === '__Host-formsache_csrf',
  )?.value;
  return token === undefined ? {} : { 'X-CSRF-Token': token };
}

/** The form id from the builder's address — where `newForm` leaves the page. */
function formIdOf(page: Page): string | undefined {
  return /\/forms\/([^/?#]+)/u.exec(page.url())?.[1];
}

/**
 * Takes a form out of this organisation for good — two requests, because
 * `DELETE /api/forms/:id/permanent` only takes hold of what is **in** the
 * trash. Both statuses are asserted: a clean-up that fails silently is how the
 * next run inherits a form nobody remembers creating.
 */
async function purgeForm(
  page: Page,
  formId: string | undefined,
): Promise<void> {
  if (formId === undefined) {
    return;
  }
  const headers = await csrfHeader(page);
  const intoTrash = await page.request.delete(`/api/forms/${formId}`, {
    headers,
  });
  expect(
    [204, 404],
    `DELETE /api/forms/${formId} antwortete ${String(intoTrash.status())}`,
  ).toContain(intoTrash.status());

  const purged = await page.request.delete(`/api/forms/${formId}/permanent`, {
    headers,
  });
  expect(purged.status(), `DELETE /api/forms/${formId}/permanent`).toBe(204);
}

/**
 * Records every call the **page** makes to the guarded route.
 *
 * Installed before the first navigation, so it sees the dashboard as well —
 * that is where a client that asked without checking the permission first
 * would give itself away, not only in the builder.
 *
 * `page.request` runs outside the browser context and raises no `request`
 * event, so the probe at the end of the first case cannot pollute this list.
 * It stands last all the same, so that the order alone settles the question.
 */
function watchGuardedRoute(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/tenant/legal') {
      seen.push(`${request.method()} ${request.url()}`);
    }
  });
  return seen;
}

/**
 * The same for **the settings document of a form** — `GET|PUT
 * /api/forms/:id/settings`, the route behind `can_manage_form_settings`.
 *
 * What it is for is the provenance of the hint about this form's privacy
 * notice: the notice is *written* through that route, but it is *reported*
 * through the publish preview behind `can_build` (ADR-0021 keeps the two
 * rights apart, and `publishPreviewSchema.privacyNotice` says in as many words
 * why the traffic light had to move to the lower bar). A builder visit that
 * asked the settings route would mean the hint hangs on the higher one after
 * all — and then it would reach exactly the person it was built for, the one
 * who publishes, not at all.
 */
function watchFormSettingsRoute(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    if (
      /^\/api\/forms\/[^/]+\/settings$/u.test(new URL(request.url()).pathname)
    ) {
      seen.push(`${request.method()} ${request.url()}`);
    }
  });
  return seen;
}

/**
 * Builds a form, publishes it, adds a second question, saves — and presses
 * „Erneut veröffentlichen". Returns the id, so the `finally` can clear it away
 * even when an assertion in between fails.
 */
async function buildPublishAndRepublish(
  page: Page,
  base: string,
): Promise<string | undefined> {
  await newForm(page, base);
  const formId = formIdOf(page);

  await addQuestion(page, 'Text', 'Name');
  await saveForm(page);

  await page
    .getByRole('button', { name: 'Veröffentlichen', exact: true })
    .click();
  await expect(page.getByText('Veröffentlicht (Fassung 1)')).toBeVisible();

  // The change that unlocks the second publication — without it the button
  // stays disabled with „Fassung 1 ist aktuell".
  await addQuestion(page, 'Text', 'Adresse');
  await saveForm(page);

  await page
    .getByRole('button', { name: 'Erneut veröffentlichen', exact: true })
    .click();

  return formId;
}

/**
 * Confirms the notice and waits for the publication to have **landed**.
 *
 * The dialog stays up until the `POST` is through, so its disappearance is the
 * state to wait on — and the version number beside it is the result. Together
 * they are the assurance of ADR-0028 §6: the hint costs a click, it does not
 * lock.
 *
 * The version is a parameter and not the literal `2` it used to be: the case
 * about this form's own privacy notice publishes twice more, and a helper that
 * always looked for „Fassung 2" would have been green for the second of them
 * only as long as it looked at the strip of the *first*.
 */
async function confirmAndExpectVersion(
  page: Page,
  version: number,
): Promise<void> {
  const notice = publishNotice(page);
  await notice
    .getByRole('button', { name: 'Erneut veröffentlichen', exact: true })
    .click();

  await expect(
    notice,
    'Der Hinweis sperrt nicht (ADR-0028 §6) — nach der Bestätigung muss der ' +
      'Dialog schließen. Steht er noch, ist das Veröffentlichen an ihm ' +
      'hängengeblieben, und der Hinweis wäre zur Sperre geworden.',
  ).toHaveCount(0);
  await expect(
    page.getByText(`Veröffentlicht (Fassung ${String(version)})`),
  ).toBeVisible();
}

test.describe('Hinweis auf die Rechtstexte vor dem Veröffentlichen ', () => {
  /**
   * **The gap, in the browser.** An editor with `can_build` and without
   * `can_manage_settings` learns *that* the legal texts are unfinished — and
   * not one page name along with it.
   *
   * Signs in for itself, because what this case needs is an identity neither
   * parked session has; the reasoning and the cost stand at the top of the
   * file.
   */
  test('eine Bearbeiterin ohne Einstellungsrecht erfährt, dass etwas fehlt — ohne dass eine Seite genannt wird', async ({
    page,
  }) => {
    const guardedCalls = watchGuardedRoute(page);
    let formId: string | undefined;

    try {
      await page.goto('/');
      await expectLoginView(page);
      expect(
        await submitLogin(page, seedMember),
        'Die Anmeldung des Mitglieds muss gelingen. Ein 401 heißt meist, dass ' +
          'die Datenbank mit einem anderen SEED_MEMBER_PASSWORD gesät wurde — ' +
          'der Seed setzt ein vorhandenes Passwort absichtlich nicht zurück.',
      ).toBe(200);

      /*
        Two memberships, so the login scopes nothing and the switcher is the
        way in — `tenant-switch.spec.ts` is about that path itself. Musterstadt
        is the organisation in which this account is `editor`; in the
        Dachorganisation it is `viewer` and could not build at all.
      */
      await page.getByRole('button', { name: /Organisations-Auswahl/ }).click();
      await page.getByRole('button', { name: /Musterstadt/ }).click();
      await expectDashboard(page);

      formId = await buildPublishAndRepublish(page, 'Rechtstexte ohne Recht');

      // --- the first stage: that something is missing ---------------------
      const hint = legalHint(page);
      await expect(
        hint,
        'Der Hinweis muss dastehen. Fehlt er, erreicht ADR-0028 Nr. 3 genau ' +
          'die Person nicht, für die er gebaut wurde — die, die ' +
          'veröffentlicht.',
      ).toBeVisible();
      await expect(
        hint.getByRole('heading', { name: EMPTY_HEADING }),
        'Musterstadt hat keine Rechtstexte hinterlegt (`tenant.legal_pages` ' +
          'ist NULL). Eine andere Überschrift heißt: jemand hat angefangen, ' +
          'sie zu speichern — dann misst dieser Fall etwas anderes als er ' +
          'behauptet.',
      ).toBeVisible();

      // --- and the second stage is absent: no page is named ---------------
      for (const title of LEGAL_PAGE_TITLES) {
        await expect(
          hint,
          `„${title}" ist der Titel einer der beiden Seiten. Wer die ` +
            'Einstellungen nicht verwalten darf, bekommt die Dokumente ' +
            'dahinter nicht zu sehen — und darf sie auch aus diesem Dialog ' +
            'nicht erfahren (packages/shared/src/forms.ts, `organisationLegal`).',
        ).not.toContainText(title);
      }
      await expect(
        hint,
        '„Betroffen:" leitet die Aufzählung der Seiten ein. Steht das Wort ' +
          'da, ist die zweite Stufe an der Wache vorbeigekommen.',
      ).not.toContainText('Betroffen');
      /*
        „Anbieterangaben" is checked once more against the **whole** dialog,
        which the region-scoped assertion above cannot do for its neighbour:
        the notice of this form's own privacy statement legitimately says
        „Datenschutzhinweise zu diesem Formular", while the imprint's title
        appears nowhere else in this dialog at all.
      */
      await expect(publishNotice(page)).not.toContainText('Anbieterangaben');

      // The sentence that goes with the reader who cannot remedy it.
      await expect(
        hint.getByText(
          /Nachtragen kann sie, wer in dieser Organisation die Einstellungen verwaltet/u,
        ),
        'Ohne die Seitennamen muss der Hinweis sagen, wer sie nachtragen ' +
          'kann. Sonst nennt er ein Problem und keinen Weg.',
      ).toBeVisible();

      // --- and it does not lock -------------------------------------------
      await confirmAndExpectVersion(page, 2);

      expect(
        guardedCalls,
        'Diese Sitzung darf `GET /api/tenant/legal` gar nicht erst stellen: ' +
          'die Route steht hinter `can_manage_settings`, und eine Anfrage ' +
          'wäre ein 403 je Builder-Besuch über ein Dokument, das diese ' +
          'Person weder lesen noch ändern darf ' +
          '(apps/web/src/views/builder/use-open-legal-page-names.ts).',
      ).toStrictEqual([]);

      /*
        And the guard itself, measured rather than assumed — the premise of
        everything above. Last, so that this request cannot be confused with
        one the page made.
      */
      const refused = await page.request.get('/api/tenant/legal');
      expect(
        refused.status(),
        'Die Wache muss greifen. Antwortet die Route dieser Sitzung, hat der ' +
          'Fall oben nicht bewiesen, dass die Seitennamen zurückgehalten ' +
          'werden — dann waren sie nur zufällig nicht da.',
      ).toBe(403);
    } finally {
      await purgeForm(page, formId);
      /*
        And the session this case opened for itself goes with it — after the
        clean-up, which still needs it. Over the route rather than over the
        „Abmelden" button, because a `finally` runs on the failed run too, and
        a click into whatever view the failure left behind would replace the
        real error with a locator's. `POST /api/auth/logout` answers 204
        whether or not there was anything to revoke.
      */
      await page.request.post('/api/auth/logout', {
        headers: await csrfHeader(page),
      });
    }
  });

  /**
   * **The counter-check**, under the same organisation and the same two
   * unfinished pages: with `can_manage_settings` the very same hint names
   * them.
   *
   * Without it the case above would only show that no page name stands
   * anywhere — which a hint that had quietly lost its second stage would
   * satisfy just as well.
   */
  test.describe('mit Einstellungsrecht ', () => {
    test.use({ storageState: tenantAdminStateFile });

    test('nennt derselbe Hinweis die beiden Seiten', async ({ page }) => {
      const guardedCalls = watchGuardedRoute(page);
      let formId: string | undefined;

      try {
        formId = await buildPublishAndRepublish(page, 'Rechtstexte mit Recht');

        const hint = legalHint(page);
        await expect(hint).toBeVisible();
        await expect(
          hint.getByRole('heading', { name: EMPTY_HEADING }),
          'Dieselbe Organisation und dieselben beiden Seiten wie oben — nur ' +
            'die Leserin ist eine andere. Steht hier eine andere ' +
            'Überschrift, vergleichen die beiden Fälle nicht dasselbe.',
        ).toBeVisible();

        await expect(
          hint,
          'Die zweite Stufe zählt die offenen Seiten auf. Fehlt „Betroffen:", ' +
            'schweigt der Hinweis auch gegenüber jemandem, der die Texte ' +
            'nachtragen kann — und dann belegt der Fall oben nichts.',
        ).toContainText('Betroffen');
        for (const title of LEGAL_PAGE_TITLES) {
          await expect(hint).toContainText(title);
        }
        await expect(
          hint.getByText(
            /Nachtragen kannst du sie unter Verwaltung → Rechtstexte/u,
          ),
          'Wer es beheben kann, wird an die Seiten geschickt — nicht an eine ' +
            'andere Person.',
        ).toBeVisible();

        await confirmAndExpectVersion(page, 2);

        expect(
          guardedCalls.length,
          'Für diese Person antwortet `GET /api/tenant/legal` — die Null im ' +
            'Fall oben ist damit eine Eigenschaft des Rechts und keine des ' +
            'Laufs.',
        ).toBeGreaterThan(0);
      } finally {
        await purgeForm(page, formId);
      }
    });
  });
});

/**
 * **The hint about the privacy notice of *this form*** (ADR-0028 no. 4) — the
 * section that stands one above the organisation's in the same dialog, and
 * about which `e2e/` carried no assurance at all until 2026-08-20.
 *
 * ## What it keeps apart, and why that is the whole subject
 *
 * The document is written behind `can_manage_form_settings`
 * (`FormSettingsController`, `PUT|GET /api/forms/:id/settings`). The right
 * that **publishes** is `can_build`, and ADR-0021 separated the two
 * deliberately. If the hint hung on the writing right, it would miss exactly
 * the person it exists for. It therefore hangs on the preview
 * (`publishPreviewSchema.privacyNotice`), which stands behind `can_build` —
 * and this case measures that provenance rather than assuming it: while the
 * dialog names the shortcoming, the page has issued **no** request to the
 * settings document. The same measurement is its own counter-check a few lines
 * later, where opening the settings page makes the very same list non-empty:
 * a watcher that recorded nothing at all would satisfy the first assertion
 * just as well.
 *
 * ⚠️ **What it does *not* claim.** `privacyNotice` on the preview is data
 * minimisation and expressly **no** protection — the field's own comment in
 * `packages/shared/src/forms.ts` says so, and it says why: the notice stands
 * world-readable on the public fill-in page, and whoever holds `can_build`
 * reaches it through the `publicSlug` anyway. So the two assertions about the
 * text belong together and neither may stand alone: the preview carries the
 * traffic light and **not** the sentence that was typed (minimisation), and a
 * session-less context finds that very sentence on the public page
 * (therefore not secrecy). A case that only made the first would leave behind
 * the impression that something is being hidden here, and the next hand would
 * „fix" the public page.
 *
 * ## Both states, and where they come from
 *
 * `empty` is the state of every fresh form, so the dialog carries the section
 * from the first republish. `incomplete` is produced through the surface —
 * one field of `FORM_PRIVACY_TEMPLATE` filled in, two left open — and it is
 * therefore the **server** that judges it (`legalPageStatus` in
 * `FormsService.publishPreview`), not a mocked payload.
 * `BuilderView.test.tsx` covers both wordings against a stubbed preview, which
 * is the half that can be stubbed; what it cannot show is that a document
 * saved through the settings page really arrives in that preview.
 *
 * ## Why this may write freely
 *
 * The notice belongs to **one form** — `form.privacy_notice`, not a shared
 * organisation row. Unlike `tenant.legal_pages` nothing else in the suite
 * measures it, and the form goes away in the `finally` together with it.
 */
test.describe('Hinweis auf den Datenschutzhinweis dieses Formulars ', () => {
  test.use({ storageState: tenantAdminStateFile });

  /** One field of an answered payload, read without an assertion of type. */
  function fieldOf(source: unknown, key: string): unknown {
    return typeof source === 'object' && source !== null
      ? Object.getOwnPropertyDescriptor(source, key)?.value
      : undefined;
  }

  test('sagt erst, dass keiner hinterlegt ist, dann dass er unvollständig ist — und nennt den Text an keiner Stelle', async ({
    page,
    browser,
  }) => {
    const settingsCalls = watchFormSettingsRoute(page);
    let formId: string | undefined;

    try {
      formId = await buildPublishAndRepublish(
        page,
        'Formular-Datenschutzhinweis',
      );
      const id = formId ?? '';
      expect(
        id,
        'Ohne die Formular-Adresse aus dem Builder kann dieser Fall weder ' +
          'zurück in den Builder noch die Vorschau abfragen.',
      ).not.toBe('');

      // --- state one: nothing on file ------------------------------------
      const hint = formNoticeHint(page);
      await expect(
        hint,
        'Ein frisches Formular hat keinen eigenen Datenschutzhinweis. Fehlt ' +
          'der Abschnitt, erfährt die Person, die gerade veröffentlicht, ' +
          'nichts davon — und Art. 13 Abs. 1 lit. c DSGVO verlangt Zweck und ' +
          'Rechtsgrundlage je Verarbeitung, also je Formular.',
      ).toBeVisible();
      await expect(
        hint.getByRole('heading', { name: FORM_NOTICE_EMPTY }),
      ).toBeVisible();

      /*
        **And it stands above the organisation's** — the order is a decision
        with a reason behind it (ADR-0028 no. 4, and the comment at the place
        itself in `PublishNotice.tsx`): the more specific hint first, because
        the processing being published right now is this form. Measured as the
        dialog's first region, which is exactly where it stands in the
        document.
      */
      await expect(legalHint(page)).toBeVisible();
      await expect(
        publishNotice(page).getByRole('region').first(),
        'Der Hinweis zu diesem Formular gehört an die erste Stelle des ' +
          'Dialogs. Steht der Organisations-Hinweis oben, ist die Reihenfolge ' +
          'aus ADR-0028 Nr. 4 umgekippt — der allgemeinere Text käme vor dem ' +
          'spezielleren.',
      ).toHaveAttribute('aria-label', FORM_NOTICE_REGION);

      // --- and it comes over the preview, not over the settings document ---
      expect(
        settingsCalls,
        'Der Hinweis hängt an der Vorschau hinter `can_build` und nicht am ' +
          'Einstellungs-Dokument hinter `can_manage_form_settings` ' +
          '(ADR-0021 trennt die beiden). Fragt der Builder die ' +
          'Einstellungs-Route, hängt der Hinweis am falschen Recht und ' +
          'erreicht genau die nicht, für die er gebaut ist: die, die ' +
          'veröffentlicht.',
      ).toStrictEqual([]);

      // A hint, not a lock (ADR-0028 §6).
      await confirmAndExpectVersion(page, 2);

      // --- state two: begun, and therefore unvollständig -------------------
      await openFormSettings(page);
      const card = page.getByRole('region', { name: FORM_NOTICE_CARD });
      await expect(card).toBeVisible();
      await expect(
        card.getByText('Nichts hinterlegt', { exact: true }),
        'Die Karte muss beim leeren Dokument beginnen — sonst stellt dieser ' +
          'Fall den Zustand nicht her, den er gleich misst.',
      ).toBeVisible();

      await card
        .getByRole('textbox', { name: PURPOSE_LABEL, exact: true })
        .fill(PURPOSE_TEXT);
      await expect(
        card.getByText('Unvollständig', { exact: true }),
        'Ein Feld ausgefüllt, zwei offen: genau das ist `incomplete`. Sagt ' +
          'die Karte hier „Vollständig", zählt `legalPageStatus` die offenen ' +
          'Platzhalter nicht mit, und der Dialog gleich darauf misst nichts.',
      ).toBeVisible();
      await page
        .getByRole('button', { name: 'Speichern', exact: true })
        .click();
      await expectSaved(page);

      /*
        The counter-check to the empty list above, and it is what makes that
        list evidence: this page really does read the settings document, so a
        watcher that recorded nothing at all would have been noticed here.
      */
      expect(
        settingsCalls.length,
        'Die Einstellungsseite liest das Dokument — bleibt diese Liste auch ' +
          'jetzt leer, misst der Beobachter nichts, und die Null oben war ' +
          'keine Aussage.',
      ).toBeGreaterThan(0);

      await page.goto(`/forms/${id}`);
      await expect(page.getByText('Veröffentlicht (Fassung 2)')).toBeVisible();
      await addQuestion(page, 'Text', 'Ort');
      await saveForm(page);
      await page
        .getByRole('button', { name: 'Erneut veröffentlichen', exact: true })
        .click();

      const started = formNoticeHint(page);
      await expect(
        started.getByRole('heading', { name: FORM_NOTICE_INCOMPLETE }),
        'Eine angefangene Fassung ist etwas anderes als gar keine, und der ' +
          'Dialog hat für beides eigene Worte. Steht hier weiter die ' +
          'Überschrift des leeren Zustands, kommt das gespeicherte Dokument ' +
          'nicht in der Vorschau an.',
      ).toBeVisible();
      await expect(
        started,
        'Der leere Zustand darf jetzt nicht mehr dastehen.',
      ).not.toContainText('kein Datenschutzhinweis hinterlegt');

      /*
        **Data minimisation, measured on the payload itself.** The preview
        answers one question — „how far along is it?" — and does not deliver
        the text with it. That is the hard boundary the comment at
        `publishPreviewSchema.privacyNotice` draws.
      */
      const preview = await page.request.get(
        `/api/forms/${id}/publish-preview`,
      );
      expect(preview.status(), 'GET /publish-preview').toBe(200);
      const payload: unknown = await preview.json();
      expect(
        fieldOf(payload, 'privacyNotice'),
        'Die Vorschau muss den Zustand nennen, den der Server aus dem ' +
          'gespeicherten Dokument errechnet. Steht hier „ready", urteilt ' +
          '`legalPageStatus` anders als die Karte in den Einstellungen.',
      ).toBe('incomplete');
      expect(
        JSON.stringify(payload),
        'Die Vorschau ist eine Ampel und kein Dokument: der eingetippte Satz ' +
          'hat in ihr nichts verloren. Steht er darin, ist aus der Ampel eine ' +
          'zweite Ausgabe des Textes geworden.',
      ).not.toContain(PURPOSE_TEXT);

      await confirmAndExpectVersion(page, 3);

      /*
        **And withholding it protects nothing** — the other half of the same
        assurance, and without it the line above reads like secrecy. The text
        stands publicly under the form as intended; whoever wants to read it
        needs neither a sign-in nor a preview.
      */
      const address = await page
        .getByRole('link', { name: /\/f\//u })
        .getAttribute('href');
      expect(
        address,
        'Ohne die öffentliche Adresse lässt sich die Gegenprobe nicht führen.',
      ).toMatch(/^https?:\/\/[^/]+\/f\/[A-Za-z0-9_-]+$/u);

      /*
        **The empty state is passed in, not left out.** `browser.newContext()`
        inherits the `use` options of the running test — `_setupContextOptions`
        parks `_combinedContextOptions` on the client and
        `Browser._innerNewContext` spreads it under the explicit ones
        (`playwright/lib/index.js`). A bare `newContext()` under this file's
        `test.use` would therefore carry the organisation admin's cookie, and
        „ohne Anmeldung lesbar" would be a sentence about a signed-in reader.
        The empty state is the same one `a11y.spec.ts` names for its public
        views.
      */
      const guestContext = await browser.newContext({
        storageState: { cookies: [], origins: [] },
      });
      try {
        const guest = await guestContext.newPage();
        await guest.goto(new URL(address ?? '').pathname);
        /*
          And that it really is no session is measured rather than assumed —
          the fill-in view has no app shell, so „kein Abmelden-Knopf zu sehen"
          would be true of a signed-in reader as well. `GET /api/auth/me`
          stands behind `SessionGuard` and answers 401 to nobody in
          particular.
        */
        const whoami = await guestContext.request.get('/api/auth/me');
        expect(
          whoami.status(),
          'Der Gast-Kontext darf keine Sitzung tragen. Antwortet die Route ' +
            'mit 200, ist das geparkte Cookie doch mitgekommen, und die ' +
            'Zusicherung darunter wäre eine über eine angemeldete Leserin.',
        ).toBe(401);
        await expect(
          guest.getByRole('heading', { name: FORM_NOTICE_CARD }),
          'Der Datenschutzhinweis dieses Formulars gehört unter die ' +
            'Ausfüllansicht — ohne Anmeldung lesbar. Steht er dort nicht, ' +
            'wäre die Zeile oben („die Vorschau trägt den Text nicht") ' +
            'plötzlich eine Aussage über Geheimhaltung statt über ' +
            'Datensparsamkeit.',
        ).toBeVisible();
        await expect(
          guest.getByText(PURPOSE_TEXT),
          'Derselbe Satz, den die Vorschau nicht trägt, steht hier öffentlich.',
        ).toBeVisible();
      } finally {
        await guestContext.close();
      }
    } finally {
      await purgeForm(page, formId);
    }
  });
});

/**
 * **The same dialog at 360 px** — and the one question that is a statement
 * about width.
 *
 * ## What already stands, and what does not
 *
 * The words are the same at both widths, so no case here repeats them for
 * their own sake. And the dialog is **not** unmeasured on narrow screens:
 * `a11y/overlays.ts` carries it as „Dialog · Erneut veröffentlichen" with
 * `width: 'any'`, so `a11y.spec.ts` opens it in the mobile project, runs axe
 * over it and measures `expectNoHorizontalScroll` plus the 24 px touch
 * targets. What no case reaches is the third measurement of
 * `mobile/operable.ts`: whether the centre of each control still belongs to
 * that control — the dead zone that a stacked decoration produces and that
 * neither axe nor a size measurement can see. The four mobile guards read
 * `A11Y_VIEWS`, that is: **pages**, and `overlays.ts` says in as many words
 * that the overlays are left out of them.
 *
 * That is worth its own case here rather than a fifth entry over there,
 * because it is this dialog that grew two boxes since ADR-0028: the notice for
 * this form and the one for the organisation, stacked above the change list
 * inside a panel that is `max-height: 86vh` and scrolls. `builder-view.css`
 * names 360 px twice in that block („the gutter that keeps the panel off the
 * window edge at 360 px"), so the width is a claim the stylesheet makes and
 * this case reads back.
 *
 * ## Why a block in this file and not an entry in the mobile project
 *
 * The pattern of `builder-drag`, `notifications`, `conditional-logic` and
 * `preview-test-mode`: the file stays in the desktop project, and the one case
 * that *is* about width brings its own viewport, so the reason for the width
 * stands next to the assertion. Claiming the whole file for the mobile project
 * would run its three desktop cases a second time — three more forms in
 * Musterstadt and a second login out of a bucket that is at nine of ten — for
 * evidence the first run already carries.
 */
test.describe('der Hinweis auf 360 px ', () => {
  test.use({
    storageState: tenantAdminStateFile,
    viewport: { width: 360, height: 740 },
    hasTouch: true,
  });

  test('passt ohne Querlauf in die schmale Spalte und lässt seine Bedienelemente frei', async ({
    page,
  }) => {
    const where = 'Veröffentlichen-Dialog mit beiden Hinweisen (360 px)';
    let formId: string | undefined;

    try {
      formId = await buildPublishAndRepublish(page, 'Rechtstexte auf 360 px');

      /*
        Both boxes really are there — otherwise the measurements below would
        run over a dialog that carries neither of them and would be green for
        having nothing to measure.
      */
      await expect(
        formNoticeHint(page).getByRole('heading', { name: FORM_NOTICE_EMPTY }),
      ).toBeVisible();
      await expect(
        legalHint(page).getByRole('heading', { name: EMPTY_HEADING }),
        'Musterstadt hat keine Rechtstexte hinterlegt; auf 360 px steht ' +
          'derselbe Satz wie auf 1280 px. Steht er nicht, misst dieser Fall ' +
          'einen Dialog ohne den Kasten, um den es geht.',
      ).toBeVisible();

      await expectNoHorizontalScroll(page, where);

      /*
        **The measurement this dialog gets nowhere else.** The point at the
        centre of every control has to belong to that control — after
        `scrollIntoView`, because the panel is capped at `86vh` and scrolls
        inside itself. `probeControls` scopes itself to the topmost modal, so
        what is measured is the dialog and not the view behind it.

        `minimum: 2` is the lower bound that makes an empty measurement show
        up: „Abbrechen" and „Erneut veröffentlichen" are the two buttons this
        dialog always carries.
      */
      await expectNoControlCovered(page, where, { minimum: 2 });

      // And it does not lock at this width either (ADR-0028 §6).
      await confirmAndExpectVersion(page, 2);
    } finally {
      await purgeForm(page, formId);
    }
  });
});
