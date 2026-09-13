import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  expectDashboard,
  expectLoginView,
  expectNoHorizontalScroll,
  logOut,
  openMobileMenu,
  submitLogin,
} from './app-flows';
import { authStateFile, seedTenantAdmin } from './seed-account';

/**
 * The **system administration**, in a real browser.
 *
 * ## What this file has measured since 2026-08-15 — and what it did before
 *
 * It was once named after the „Systemeinstellungen" and measured one of
 * **three** separate superadmin areas: `/verwaltung/superadmin`
 * (organisations), `/verwaltung/betrieb` und `/verwaltung/systemeinstellungen`
 * with two tabs of its own. Since finding 16 those are tabs of **one** place
 * under `/admin/system`. Die fünf alten Adressen wurden weitergeleitet; seit
 * dem harten Schnitt auf englische Pfade (ADR-0030) gibt es sie nicht mehr.
 *
 * Before that it was also the measurement of the **third inheritance level**: an
 * editable system row with form defaults of its own. That level no longer exists
 * (ADR-0011, amendment 2026-08-14; finding 9), and the cases that drove its
 * controls went with it — not because they had become inconvenient. Where the
 * one measurement went that must *not* be lost in the process (inheritance
 * organisation → form) is written in `durchlauf-organisationen.spec.ts` step 6
 * and in `tenant-form-defaults.spec.ts`.
 *
 * ## What stands here
 *
 * The frame with its seven tabs and their tab bar, the **redirects** of the five
 * old addresses, the start page of a superadmin without an organisation, the
 * proof that the removed form-defaults route is really gone, the way through the
 * off-canvas menu and the refusal to an organisation admin.
 *
 * ## Why still only in the desktop project
 *
 * The original reason — this file wrote the installation-wide `system_setting`
 * row — has become weaker: **none of the cases below saves anything any more.**
 * The assignment in `playwright.config.ts` stays nevertheless, because the one
 * writing neighbour (`tenant-mail`, `system-mail-settings-mobile`) touches that
 * same row and the split is justified there. The own mobile cases set their
 * 360 px in the file, where the reason for the width stands next to the
 * assertion.
 */

/**
 * The four addresses of the system administration, in the order of the tab bar.
 *
 * As literals and not imported from `apps/web/src/router/routes.ts`: what is
 * checked here is the *address* that stands in bookmarks and links. An import
 * would make every rename of the constant value silently green.
 */
const SYSTEM_PATH = '/admin/system';
const SYSTEM_MONITORING_PATH = '/admin/system/monitoring';
const SYSTEM_MAIL_PATH = '/admin/system/mail';
const SYSTEM_TEMPLATES_PATH = '/admin/system/templates';
const SYSTEM_AI_PATH = '/admin/system/ai';
const SYSTEM_SUPERADMINS_PATH = '/admin/system/superadmins';
const SYSTEM_LEGAL_SETTINGS_PATH = '/admin/system/legal';

/**
 * Tab label → address, in the order in which they stand there.
 *
 * ⚠️ **„KI" is a short word, and Playwright matches names as a substring.**
 * Every access to it is therefore narrowed to the tab bar ({@link tabs}) —
 * unnarrowed, `getByRole('button', { name: 'KI' })` would also find
 * „✦ KI-Formular" on the dashboard.
 */
const TABS = [
  ['Organisationen', SYSTEM_PATH],
  ['Überwachung', SYSTEM_MONITORING_PATH],
  ['Mailserver', SYSTEM_MAIL_PATH],
  // *Vorlagen* since ADR-0022 (amendment 2026-08-18): the column
  // `notification_templates` was read up to then and written by nothing, so
  // there was nothing to show either. Without this line the count below would
  // stand at four against five — and the tab bar would have an entry that no
  // case visits.
  ['Vorlagen', SYSTEM_TEMPLATES_PATH],
  ['KI', SYSTEM_AI_PATH],
  /*
    *Rechtstexte* since ADR-0028 — imprint and privacy policy
    statement **of the installation**. Appended and not inserted
    (`SystemAdminView.tsx` says why), so none of the five lines above it
    shifts.

    Without this line the count below would stand at five against six — the same
    gap through which *Vorlagen* had moved in.
  */
  ['Rechtstexte', SYSTEM_LEGAL_SETTINGS_PATH],
  /*
    *Superadmins* since ADR-0029 — the way to the **second** superadministrator.
    Until then that only worked through the database, and the one superadmin was
    a single point of failure: if they lose their access, nobody reaches the system
    administration any more.

    Appended again and not inserted, for the same reason as with the
    Rechtstexte — none of the six lines above it shifts.
  */
  ['Superadmins', SYSTEM_SUPERADMINS_PATH],
] as const;

/**
 * Minimal browser globals for the `evaluate` callback further down — the same
 * reasoning that `app-flows.ts` and `tenant-admin.spec.ts` give for their own:
 * the root `tsconfig.json`, which covers `e2e/`, deliberately has no DOM
 * library. Declared is only what is really used; at runtime the callback runs
 * in the real browser.
 *
 * Hier standen einmal mehr: ein `MutationObserver`, der festhielt, ob die
 * 404-Ansicht auf dem Weg durch eine **alte** Adresse je im Dokument stand.
 * Weiterleitungen gibt es seit Review-Runde 4 Nr. 8 nicht mehr
 * ([ADR-0030](../docs/architecture/0030-englische-url-pfade.md)), und ohne
 * Weiterleitung gibt es auch kein Aufblitzen zu messen.
 */
declare const window: {
  /** Read by the tab-bar measurement at 360 px. */
  readonly scrollX: number;
};

/**
 * A path as a regex ending — otherwise `toHaveURL` is handed the run's base
 * address along with it, which differs between CI and local.
 */
function pathAtEnd(path: string): RegExp {
  return new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'u');
}

/**
 * The start page — and **only** it.
 *
 * ⚠️ `pathAtEnd('/')` would be the obvious and the wrong choice here: the regex
 * is then `/\/$/` and hits every address with a slash at the end,
 * `/admin/` just as well as `/`. Of all things the assertion whose whole
 * content is „here there was *no* redirect" then measures nothing any more.
 *
 * A predicate instead of a regex, because the question hangs on the path and not
 * on the text: `toHaveURL` is handed the full address including the base, which
 * differs between CI and local, and `URL.pathname` is exactly the part this case
 * means.
 */
function isStartPath(url: URL): boolean {
  return url.pathname === '/';
}

/** The frame's tab navigation — not an ARIA tab widget, but addresses. */
function tabs(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Systemverwaltung' });
}

test.describe('Systemverwaltung — Superadmin', () => {
  test.use({ storageState: authStateFile });

  /**
   * The frame, all tabs — and the **absence** of the tab of the old system
   * settings.
   *
   * The absence is the actual statement, and it needs the positive control next
   * to it: „no tab «Formular-Standards»" would also be true if the page had not
   * loaded at all. That is why all tabs are first named **and counted**.
   *
   * ⚠️ **This name too no longer names a number** (2026-08-19). It was called
   * „trägt sechs Reiter", and that was the third number in this spot: four
   * before *Vorlagen*, five before the *Rechtstexte*, six before the
   * *Superadmins* (ADR-0029). The case below has already drawn this lesson —
   * here it was still outstanding. Counted is against `TABS.length`, and `TABS`
   * is the one place that has to be touched for the next tab.
   */
  test('trägt jeden Reiter der Reiterleiste — und keinen für Formular-Standards', async ({
    page,
  }) => {
    await page.goto(SYSTEM_PATH);
    await expect(
      page.getByRole('heading', { name: 'Systemverwaltung', level: 1 }),
    ).toBeVisible();

    // The first tab additionally carries its own heading — otherwise „the
    // address shows the system administration" would be the same for all tabs.
    await expect(
      page.getByRole('heading', {
        name: 'Organisationen dieser Installation',
        level: 2,
      }),
    ).toBeVisible();

    // The red badge of the draft: what stands here applies to the whole
    // installation and not to the organisation someone is currently working in.
    await expect(page.getByText('Alle Organisationen')).toBeVisible();

    for (const [label] of TABS) {
      await expect(
        tabs(page).getByRole('button', { name: label, exact: true }),
      ).toBeVisible();
    }
    // The count catches the tab that the loop above does not know — exactly
    // the gap through which *Vorlagen* moved in without any case ever having
    // visited it.
    await expect(tabs(page).getByRole('button')).toHaveCount(TABS.length);

    await expect(
      page.getByRole('button', { name: 'Formular-Standards' }),
      'Die Systemebene trägt keine Formular-Standards mehr (ADR-0011, ' +
        'Fortschreibung 2026-08-14). Ein Reiter dafür wäre eine dritte ' +
        'Vererbungsebene, die es nicht mehr gibt.',
    ).toHaveCount(0);

    /*
      And no settings cards of the form system — checked against the five
      headings that the form defaults had, not against „no region": the tabs do
      have regions, only different ones.
    */
    for (const heading of [
      'Verfügbarkeit',
      'Zugriff & Sicherheit',
      'Nach dem Absenden',
      'Darstellung',
      'Versandbudget',
    ]) {
      await expect(
        page.getByRole('region', { name: heading }),
        `„${heading}" gehört einer Organisation oder einem Formular — nie der Installation.`,
      ).toHaveCount(0);
    }
  });

  /**
   * **The tab bar is a navigation, and `aria-current` moves along with it.**
   *
   * One click per entry from {@link TABS}, and after each one exactly **one** of
   * the buttons carries `aria-current="page"` — the clicked one. The count is
   * the part that can turn red: „the clicked one carries it" would also be green
   * if all of them carried it, and that is the mistake a tab widget without a
   * state change makes.
   *
   * ⚠️ **The name no longer names a number.** It was called „führt zu vier
   * Adressen", while the loop had long been running over five (*Vorlagen*,
   * ADR-0022) and since ADR-0028 over six — a number in a test name that nobody
   * keeps up to date tells the report something other than the run does. Counted
   * is below, against `TABS.length`.
   *
   * Additionally measured is the **address bar**, because that is exactly what
   * distinguishes these tabs from a `useState`: a bookmark on the third tab must
   * open the third tab.
   */
  test('jeder Reiter hat seine eigene Adresse, und aria-current wandert mit', async ({
    page,
  }) => {
    await page.goto(SYSTEM_PATH);
    await expect(
      page.getByRole('heading', { name: 'Systemverwaltung', level: 1 }),
    ).toBeVisible();

    for (const [label, path] of TABS) {
      await tabs(page)
        .getByRole('button', { name: label, exact: true })
        .click();

      await expect(
        page,
        `Der Reiter „${label}" muss die Adresse ${path} tragen — sonst ist er ` +
          'ein Zustand und kein Ort, und ein Lesezeichen darauf zeigt woanders hin.',
      ).toHaveURL(pathAtEnd(path));

      await expect(
        tabs(page).getByRole('button', { name: label, exact: true }),
      ).toHaveAttribute('aria-current', 'page');
      await expect(
        tabs(page).locator('[aria-current="page"]'),
        `Nach dem Klick auf „${label}" muss genau ein Reiter als aktuell ` +
          'ausgezeichnet sein. Sind es mehrere, wandert die Auszeichnung nicht ' +
          'mit, sondern sammelt sich an.',
      ).toHaveCount(1);

      await expect(
        page.getByRole('heading', { name: 'Systemverwaltung', level: 1 }),
      ).toBeVisible();
    }
  });

  /*
    Hier stand ein Fall je alter Adresse der Systemverwaltung: dass
    `/verwaltung/superadmin` und ihre vier Nachbarn auf ihren Reiter führten,
    dass die Adresszeile danach das Ziel trug und dass die 404-Ansicht dabei
    nie im Dokument stand.

    Sie sind mit ihrem Gegenstand fort. Review-Runde 4 Nr. 8 hat alle Pfade auf
    Englisch gezogen und dafür den harten Schnitt gewählt — es gibt keine
    Weiterleitungstabelle mehr, und damit nichts, was diese Fälle noch messen
    könnten. Die Begründung steht in
    [ADR-0030](../docs/architecture/0030-englische-url-pfade.md).

    Mit ihnen sind die beiden Helfer gefallen, die es nur für sie gab: der
    `MutationObserver` auf die 404-Ansicht und sein Auslesen.
  */

  /**
   * **The route is really gone, not just the tab.**
   *
   * A removed surface in front of an endpoint that still exists is not a removed
   * function — it is an unlabelled one. What is measured is therefore the
   * server, with the session that is allowed the most: **if even a superadmin
   * finds nothing here any more, nobody finds anything.**
   *
   * `404`, not `403`: the route does not exist, it is not merely locked. Exactly
   * this difference is the statement.
   */
  test('die entfernten Endpunkte der Formular-Standards antworten nicht mehr', async ({
    page,
  }) => {
    for (const method of ['get', 'put'] as const) {
      const response = await page.request[method](
        '/api/admin/system-settings/form-defaults',
        method === 'put' ? { data: {} } : undefined,
      );
      expect(
        response.status(),
        `${method.toUpperCase()} /api/admin/system-settings/form-defaults ` +
          'muss 404 sein. Antwortet die Route noch, ist die dritte ' +
          'Vererbungsebene nur unsichtbar geworden statt entfernt.',
      ).toBe(404);
    }
  });

  /**
   * **Where a superadmin without a membership lands** (findings 15 and 26).
   *
   * For everyone the dashboard — except for them: the dashboard is the form list
   * of *one* organisation, and they are in none. In practice they landed on a page
   * that says „Keine Organisation ausgewählt" and shows nothing else.
   *
   * ## Why a stub stands here, and what it costs
   *
   * **This situation cannot be produced for real in this run.** The seeded
   * superadmin *does* have a membership, there is no route that makes someone a
   * superadmin (`scripts/create-superadmin.sh` does that, a command-line tool),
   * and the membership could only be dissolved via „Person entfernen", which
   * deletes the account along with it — and namely the account this whole suite
   * works with.
   *
   * So **one** response is rewritten, after the pattern of
   * `mobile-paths.spec.ts`: `GET /api/auth/me` is fetched for real and
   * `memberships` emptied (together with `activeTenantId`, because a session
   * without a membership cannot be pointed at any organisation — a payload that
   * would never exist like that would check nothing).
   *
   * **What that proves and what it does not.** The switch itself is pure client
   * logic and measured as a unit (`router/routes.test.ts` → `startPath`,
   * `shell/AppShell.test.tsx`). What is added here is the way there in the real
   * browser: that the shell throws the switch at all while building up and that
   * the address bar carries the target afterwards. The **counter-check** below
   * is the part that turns „lands somewhere" into a statement: with a membership
   * it stays the dashboard.
   */
  test('ein Superadmin ohne Mitgliedschaft startet in der Systemverwaltung — mit Mitgliedschaft im Dashboard', async ({
    page,
  }) => {
    const me = await page.request.get('/api/auth/me');
    expect(me.status()).toBe(200);
    const session = (await me.json()) as { readonly isSuperadmin?: unknown };
    expect(
      session.isSuperadmin,
      'Diese Sitzung muss die Superadmin-Eigenschaft tragen — sonst misst der ' +
        'Fall unten die andere Hälfte der Bedingung.',
    ).toBe(true);

    // The counter-check first, **without** a stub: the way this session really
    // is — superadmin *with* a membership — „/" stays the dashboard.
    await page.goto('/');
    await expectDashboard(page);
    await expect(page).toHaveURL(isStartPath);

    await page.route('**/api/auth/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...session,
          memberships: [],
          activeTenantId: null,
        }),
      });
    });

    await page.goto('/');
    await expect(
      page,
      'Ohne Mitgliedschaft ist die Systemverwaltung die Startseite. Bleibt die ' +
        'Adresse auf „/", landet er auf einer Formularliste ohne Organisation ' +
        'und findet seine Arbeitsseiten nur über die Kopfnavigation.',
    ).toHaveURL(pathAtEnd(SYSTEM_PATH));
    await expect(
      page.getByRole('heading', { name: 'Systemverwaltung', level: 1 }),
    ).toBeVisible();
  });
});

test.describe('Mobile-Navigation zur Systemverwaltung', () => {
  test.use({ storageState: authStateFile });
  test.use({ viewport: { width: 360, height: 740 }, hasTouch: true });

  test('bietet „Systemverwaltung" im Off-Canvas-Menü unter „Verwaltung" an', async ({
    page,
  }) => {
    await page.goto('/');
    await expectDashboard(page);

    const { sheet } = await openMobileMenu(page);
    await expect(sheet.getByText('Verwaltung', { exact: true })).toBeVisible();

    /*
      **One entry instead of three** (finding 16). The sheet carried
      „Superadmin-Übersicht", „Betrieb" and „Systemeinstellungen" next to one
      another; the three names have become one. The count below is the part that
      turns red if one of the old ones comes back.
    */
    await expect(
      sheet.getByRole('button', { name: 'Systemverwaltung', exact: true }),
    ).toHaveCount(1);
    for (const gone of [
      'Superadmin-Übersicht',
      'Betrieb',
      'Systemeinstellungen',
    ]) {
      await expect(
        sheet.getByRole('button', { name: gone, exact: true }),
        `„${gone}" ist in der Systemverwaltung aufgegangen und darf im ` +
          'Off-Canvas-Menü nicht wieder als eigener Weg auftauchen.',
      ).toHaveCount(0);
    }

    await sheet
      .getByRole('button', { name: 'Systemverwaltung', exact: true })
      .click();

    await expect(
      page.getByRole('heading', { name: 'Systemverwaltung', level: 1 }),
    ).toBeVisible();
    await expectNoHorizontalScroll(page, 'Systemverwaltung (360 px)');
  });

  /**
   * **The tab bar at 360 px: no horizontal run, and the last one reachable.**
   *
   * Six tabs next to one another are wider than the column at 360 px. The answer
   * to that is `overflow-x: auto` (`settings-view.css`, „scrolling rather than
   * wrapping, because a pill that breaks into two rows stops reading as one
   * control") — and it costs exactly the assurance that
   * {@link expectNoHorizontalScroll} can give: its third measurement expressly
   * excludes scrolling boxes.
   *
   * That is why both are measured. First, that the **page** does not run
   * horizontally — the box keeps its overhang to itself. Then, that it **hands
   * it out**: the last tab is in view after scrolling, and the page has not
   * moved along in doing so. Without the second half a box that cuts off instead
   * of scrolling would be green here.
   *
   * ⚠️ **„The last one" is read from {@link TABS} and not written down.** „KI"
   * stood here, and that was the last tab when the case was written. Since
   * ADR-0028 *Rechtstexte* stands behind it — the case would have stayed green
   * and would have handed out the second-to-last tab, while the last one, which
   * is what it is about, would have stood unchecked in the cut-off part. Exactly
   * the kind of silent shift that the count above is built against.
   *
   * `expectSideScrollerReachable` would be the helper for it, and it does not
   * fit here: it demands that the box *overflows*, and thereby turns a tab bar
   * that one day fits into 360 px into a red case without a defect.
   */
  test('die Reiterleiste läuft nicht quer und reicht den letzten Reiter heraus', async ({
    page,
  }) => {
    await page.goto(SYSTEM_PATH);
    await expect(
      page.getByRole('heading', { name: 'Systemverwaltung', level: 1 }),
    ).toBeVisible();

    await expectNoHorizontalScroll(page, 'Systemverwaltung · Reiterleiste');

    const bar = tabs(page);
    await expect(bar).toHaveCount(1);

    // `at(-1)` instead of a literal — the reasoning stands in the head of the
    // case. The fallback is unreachable (`TABS` is a non-empty constant) and
    // stands only because `noUncheckedIndexedAccess` makes every access
    // `| undefined`; a `?? ''` would run into a locator without a name and thus
    // into a message that explains nothing.
    const [lastLabel, lastPath] =
      TABS.at(-1) ?? (['KI', SYSTEM_AI_PATH] as const);

    const last = bar.getByRole('button', { name: lastLabel, exact: true });
    await last.scrollIntoViewIfNeeded();
    await expect(
      last,
      `Der letzte Reiter („${lastLabel}") ist auch nach dem Scrollen nicht im ` +
        'Bild — die Reiterleiste schneidet ab, statt ihren Inhalt ' +
        'herauszureichen.',
    ).toBeInViewport();

    const pageScrollX: number = await page.evaluate(() => window.scrollX);
    expect(
      pageScrollX,
      'Das Scrollen in der Reiterleiste hat die ganze Seite verschoben.',
    ).toBe(0);

    // And it is operable too, not just visible.
    await last.tap();
    await expect(page).toHaveURL(pathAtEnd(lastPath));
  });
});

test.describe('Systemverwaltung — ein Organisationsadmin ist kein Superadmin', () => {
  /**
   * Signs in for itself rather than reusing the parked superadmin session:
   * the whole point is a *different* identity — `admin` of an organisation, every
   * group permission there is, and explicitly not the superadmin flag
   * (`apps/api/prisma/seed.ts`, `seedTenantAdmin`). Logs out at the end so the
   * shared login budget is not spent on a session nobody else uses (see
   * `tenant-switch.spec.ts`).
   */
  test('der Navigationseintrag fehlt, und die direkt gerufene Adresse liefert die 403-Meldung', async ({
    page,
  }) => {
    await page.goto('/');
    await expectLoginView(page);

    const status = await submitLogin(page, seedTenantAdmin);
    expect(
      status,
      'Login with the seeded Organisation-Admin must succeed. A 401 here usually ' +
        'means the database was seeded earlier with a different ' +
        'SEED_TENANT_ADMIN_PASSWORD.',
    ).toBe(200);
    await expectDashboard(page);

    /*
     * The positive control: this account genuinely holds `canManageSettings`
     * (the „admin" group of its organisation), so „Organisations-Verwaltung" is visible.
     * Its absence would only show that some guard fires — the same fixture
     * trap the API-level test (`permissions.spec.ts`) names by header.
     *
     * The entry is called „⚙ Organisations-Verwaltung" since the navigation was wired
     * up and opens the first of that view's tabs (`AppHeader`).
     */
    await expect(
      page.getByRole('button', {
        name: 'Organisations-Verwaltung',
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Systemverwaltung', exact: true }),
    ).toHaveCount(0);

    // Absent *and* locked: the address is reachable by hand, and the
    // boundary the missing nav entry only hints at is the one that actually
    // holds (`CONTRIBUTING.md`).
    await page.goto(SYSTEM_PATH);
    await expect(
      page.getByText('Diese Ansicht ist Superadmins vorbehalten.'),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Organisationen dieser Installation' }),
      'Der erste Reiter darf einem Organisationsadmin keine Liste zeigen — auch ' +
        'keine leere.',
    ).toHaveCount(0);

    /*
      And the same bolt on the mail-server tab, which carries the secrets.
      What „verschlossen" has to mean is that none of the settings arrived and
      nothing here can write one — asserted on the tab's own content and the
      save button rather than on the page title.

      **The frame is worth a second look, and it is not this file's to make.**
      Drawing „Systemverwaltung · Alle Organisationen" plus a tab bar whose other
      tabs refuse just as well is chrome for a page the visitor does not get; the
      honest shape would be the refusal alone. That needs the tab's 403 to
      reach the shell that draws the frame, which is a change to
      `SystemAdminView`, not to a locator.
    */
    await page.goto(SYSTEM_MAIL_PATH);
    await expect(
      page.getByText('Diese Ansicht ist Superadmins vorbehalten.'),
    ).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Basis-Adresse' }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('switch', {
        name: 'Mailserver eingerichtet',
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Speichern', exact: true }),
    ).toHaveCount(0);

    await logOut(page);
    await expectLoginView(page);
  });
});
