import { expect, test } from '@playwright/test';
import type { A11yFixture } from './a11y/views';
import { A11Y_VIEWS } from './a11y/views';

import { activeTenantName } from './app-flows';

import { buildFixtureForm, purgeFixtureForm } from './mobile/fixture';
import {
  measureSmallTargets,
  TOUCH_TARGET_MIN_PX,
  TOUCH_TARGET_PX,
} from './mobile/operable';
import { authStateFile } from './seed-account';

/**
 * **Touch targets are big enough, and nothing hangs on hover**  — at 360 px,
 * measured per view.
 *
 * ## Which number is assured here, and why not the other one
 *
 * That specification names **44 × 44 px** and says in the same breath that this
 * is WCAG 2.5.5 and thereby **AAA** — „bewusst strenger", and expressly the part
 * that goes beyond the decided goal (specification no. 78: decided is **AA**).
 *
 * Measured on 2026-08-10, with `measureSmallTargets(page, 44)` over all 17
 * signed-in views: **44 × 44 is not reached across the board.** It is not an
 * outlier, but the build height of the application — buttons are 32–40 px high
 * (`.form-card__primary` 108×34, `.responses__button` 116×37,
 * `.app-header__hamburger` 40×40), and on top of that come individual real
 * midgets. To fix a list of these good 130 elements here would mean disguising a
 * product decision („the application is switched over to 44 px") as test
 * administration; to assure them hard would mean handing over a red suite whose
 * red nobody is *supposed* to repair.
 *
 * What is assured is therefore **24 × 24 px — WCAG 2.5.8, the decided AA level**
 * ({@link TOUCH_TARGET_MIN_PX}), and since specification no. 91 **without an
 * exception**: {@link BELOW_AA_PER_VIEW} is empty. The rest — the way from AA to
 * AAA — belongs in a report of its own and in a decision, not in a silent
 * exception list.
 */

test.describe.configure({ mode: 'default' });

/**
 * **Controls below the decided AA level of 24 × 24 px** — and since 2026-08-10
 * there are **none left.**
 *
 * The measurement on 2026-08-06 found four findings in three views, and they are
 * written down here, because an empty list without its history only looks like
 * „war nie ein Thema":
 *
 * 1. **The selection checkboxes of the answers table: 16 × 16 px** — the default
 *    size of an `<input type="checkbox">`, unstyled. They are the control of the
 *    multiple selection and were thereby the youngest element of the list. →
 *    `.responses__select input` now takes `--touch-target-min`.
 * 2. **The sort buttons of the table headers: 17 px high** — the line height of
 *    the header row; horizontally they were wide enough. → `min-height` on
 *    `.responses__sort`.
 * 3. **The stripe buttons of the appearance: 21 × 22 px** (move and remove, per
 *    stripe colour). They were squeezed together because the card around them
 *    was 78 px wide; the card now derives its width from the three buttons
 *    instead of the other way round.
 * 4. **The handle of a question card: 23.9 px wide** — just barely off, and
 *    visible only because this measurement carries one decimal place. It is at
 *    the same time the handle on which the keyboard operation was built in
 *    first, so not the only way to re-sort — on mobile, though, it is.
 *    → `min-width`/`min-height`.
 *
 * ⚠️ **The list stays empty, it is not filled up again.** A new control that is
 * too small turns the case red, and from now on that is its whole task: the
 * 24 px are promised, not negotiated. Whoever enters a name here shifts a
 * promise into an exception.
 */
const BELOW_AA_PER_VIEW: Readonly<Record<string, readonly string[]>> = {};

let fixture: A11yFixture;
let formId: string | undefined;

test.beforeAll(async ({ browser }) => {
  const built = await buildFixtureForm(browser);
  fixture = built.fixture;
  formId = built.formId;
});

test.afterAll(async ({ browser }) => {
  await purgeFixtureForm(browser, formId);
});

test.describe(`360 px – Touch-Ziele ≥ ${String(TOUCH_TARGET_MIN_PX)} px `, () => {
  test.use({ storageState: authStateFile });

  for (const view of A11Y_VIEWS.filter((v) => v.audience === 'signed-in')) {
    test(view.name, async ({ page }) => {
      await view.open(page, fixture);

      const small = await measureSmallTargets(page, TOUCH_TARGET_MIN_PX);
      const known = BELOW_AA_PER_VIEW[view.kind ?? ''] ?? [];

      /*
        What is compared are the **names**, what is reported are the dimensions.

        The dimensions deliberately do not stand in the list: they come from
        `getBoundingClientRect` and carry decimal places (the handle of a
        question card measures 23.9 × 30.3 px) that shift by tenths with the font
        delivery. A list that hangs on that would be red on another computer
        without anything having changed. The numbers nevertheless belong in the
        message — they are what a reader wants to know first —, so they are
        written from the measurement itself into the error message.
      */
      const measured = small
        .map(
          (target) =>
            `${target.control} ${String(target.width)}×${String(target.height)}`,
        )
        .join(' · ');

      expect(
        small.map((target) => target.control),
        `${view.name}: diese Bedienelemente bleiben unter ` +
          `${String(TOUCH_TARGET_MIN_PX)} × ${String(TOUCH_TARGET_MIN_PX)} px ` +
          `(WCAG 2.5.8, das entschiedene AA-Niveau) — gemessen: ${measured}. ` +
          '`BELOW_AA_PER_VIEW` ist leer, seit die vier Befunde vom 2026-08-06 ' +
          'behoben sind — steht hier ein Name, ist ein neues zu ' +
          'kleines Ziel hinzugekommen. Es gehört vergrößert, nicht ' +
          'eingetragen: `--touch-target-min` ist die Zusage.',
      ).toStrictEqual([...known]);
    });
  }
});

/**
 * The ten controls of the dashboard under 44 px, named as
 * `measureSmallTargets` names them (`tag.class „zugänglicher Name"`).
 *
 * **The name of the brand is read, not written down.** It carries the
 * Organisation the session is scoped to („Zum Dashboard von Dachorganisation"),
 * and a constant here would be a second place that has to agree with the seed —
 * the same trade `activeTenantName` in `app-flows.ts` states for itself.
 *
 * Sorted, because the probe returns its findings sorted by name.
 */
function aaaDashboardControls(tenantName: string): readonly string[] {
  return [
    `a.app-header__brand „Zum Dashboard von ${tenantName}"`,
    'button.app-header__hamburger „Menü öffnen"',
    'button.dashboard__create-button „+ Neues Formular"',
    'button.form-card__delete „× Löschen"',
    'button.form-card__duplicate „⧉ Duplizieren"',
    'button.form-card__primary „Bearbeiten"',
    'button.form-card__secondary „Antworten"',
    'button.settings__secondary „Zu den Rechtstexten"',
    'button.settings__secondary „Zum Mailversand"',
    // The search field: no class and no label attribute of its own, so
    // `describe()` has nothing but the tag to report.
    'input',
  ].sort();
}

/**
 * **Controls whose *presence* hangs on the data state of the run** — allowed
 * here, and named, instead of shifting the expected list.
 *
 * The dashboard draws its pager only where `pageCount > 1`, that is from
 * `FORM_PAGE_SIZE_DEFAULT` + 1 = 25 forms of the Organisation upwards
 * (`DashboardView.tsx`). Whether that holds *at this moment* is not decided by
 * this file: `desktop-1280x800` runs beside `mobile-360x740` against the same
 * seeded Organisation, and every `newForm` there adds a card.
 *
 * *Measured on 2026-09-13*, in a `pnpm e2e` over a freshly emptied and seeded
 * database: 76 forms stood in the Dachorganisation while this case ran, and
 * „Weiter" was the eleventh name. **The database was not a residue** — the
 * whole 76 came into being inside those two minutes; `global-setup.ts` empties
 * before every run.
 *
 * ⚠️ **Neither ten nor eleven is the right number**, and that is the whole
 * reason this list exists rather than a bigger count: run this file alone and
 * the Organisation holds a handful of forms, so no pager is drawn; run it in
 * the full suite and it usually is. A count has to be wrong in one of the two
 * cases. Whoever reads this because the case went red again should check
 * whether a *new* name appeared — that is what this case is for.
 *
 * The „Zurück" twin never turns up: on page one it is `disabled`, and
 * `measureSmallTargets` skips `[disabled]`. And 67,5 × 34,3 px is far above the
 * promised 24 px (WCAG 2.5.8), so the AA case one block up stays green — what
 * this button adds is distance to AAA, not a finding.
 */
const AAA_DASHBOARD_WHEN_PAGED: readonly string[] = [
  'button.dashboard__pager-button „Nächste Seite der Formularliste"',
  'button.dashboard__pager-button „Vorherige Seite der Formularliste"',
];

/**
 * **The distance to AAA, as a list of names instead of as a number.**
 *
 * A single case that really drives the 44 measurement and names its result —
 * otherwise only a paragraph of prose in the head of this file would stand for
 * the AAA number, and nobody would know whether anything is moving.
 *
 * What is assured is the **set** of controls the dashboard has under 44 px
 * today ({@link aaaDashboardControls}). If the application becomes more
 * generous, a name drops out — then this case turns red and the name belongs
 * removed. If a new element that is too small is built in, a name comes in, and
 * the case turns red as well.
 *
 * **The list is a frozen state and not a promise** — holding it does not mean
 * approving of it. Exactly for that reason it is *re-measured* and not carried
 * forward: see the re-measurement of 2026-08-18 below.
 *
 * ## Why names and no longer a count (2026-09-13)
 *
 * Up to this day the assertion was `toHaveLength(10)`, and it went red in a
 * full `pnpm e2e` with „Expected 10, received 11". The eleventh was
 * `button.dashboard__pager-button „Nächste Seite der Formularliste"` — a
 * control the count could not name, so the report said nothing about *what* had
 * come along, and the obvious repair („write 11") would have been wrong (see
 * {@link AAA_DASHBOARD_WHEN_PAGED}). A list says which name appeared; a number
 * only says that one did.
 */
test.describe(`360 px – der Abstand zu ${String(TOUCH_TARGET_PX)} px (AAA)`, () => {
  test.use({ storageState: authStateFile });

  /*
    **Newly measured on 2026-08-18**, in the first real CI run with a browser.

    Seven stood here, measured on 2026-08-10. Three have come along since, and
    all three are traced instead of carried forward:

    - `a.app-header__brand` (284×38) — **the brand has been a link** to the
      dashboard since 2026-08-17 (finding 19, commit `94adeb9`). Before that it
      was a `<div>` and thereby no control for `measureSmallTargets`; the
      measurement therefore does not see it because it has shrunk, but because it
      only now exists as a control. Its 38 px are the height of the row in which
      the hamburger with 40×40 also stands.
    - `button.settings__secondary „Zum Mailversand"` (151.3×36.8) — the one open
      item that `TenantOpenItems` shows on the dashboard
      (`views/tenant-setup/open-items.ts`): since ADR-0023 the umbrella
      organisation has no mail server of its own and inherits none. 36.8 px is
      the height of the secondary button of this application.

    **And a tenth one since ADR-0028**, from the same source as the last:

    - `button.settings__secondary „Zu den Rechtstexten"` — the second open item
      that `TenantOpenItems` now shows. The umbrella organisation has no legal
      pages stored (the column `tenant.legal_pages` is `NULL`, the migration
      backfills nothing), so `tenantOpenItems()` carries the item
      „Keine Rechtstexte dieser Organisation hinterlegt" with the same secondary
      button as „Zum Mailversand" — same class, same 36.8 px height, different
      name, therefore an entry of its own in the list (`measureSmallTargets`
      groups by name).

    None of the three is a *new midget*: all lie far above the promised 24 px
    (WCAG 2.5.8), and the case above, which measures that promise, is green on
    the dashboard. What rises here is the distance to AAA — and that is exactly
    the number this case is meant to keep visible.

    ⚠️ **The second and the third hang on a data state, not only on the build
    plan.** If the umbrella organisation enters a mail server of its own, the
    open item disappears and the number falls by one; the same holds for the
    legal pages, as soon as somebody saves them for this organisation. In the
    run this block is written only by
    `durchlauf-organisationen`/`durchlauf-funktionsumfang`, and both are projects
    of their own **after** `mobile-360x740` (`playwright.config.ts`); the two
    `tenant-mail` files work as Musterstadt admin on a different organisation.
    Whoever changes this order makes this case wobbly — then it belongs put onto
    a view without open items, not furnished with a tolerance.
  */
  test('das Dashboard bleibt bei zehn Bedienelementen unter 44 px', async ({
    page,
  }) => {
    /*
      **Opened through `A11Y_VIEWS`, not by hand** — and that is the fix for a
      failure this case had.

      `page.goto('/')` plus a visible `<h1>` is not a settle point for this
      view: it hangs on four independent queries (the form list, and in
      `TenantOpenItems` one each for mail server, groups and legal texts), and
      each of them repaints the page for itself. Measured in the full run on
      2026-08-19 this case counted **five** instead of ten controls — „Zum
      Mailversand" had landed, „Zu den Rechtstexten" had not, and the four card
      buttons were missing entirely, while the database held 112 forms and
      `legal_pages IS NULL` everywhere. Nothing was absent; it had not arrived.
      Repeated on its own the same case ran green — the kind of red that
      `retries: 2` covers up in CI instead of fixing.

      The dashboard entry of `A11Y_VIEWS` already waits at the right point
      (`settled()` plus `networkidle`, with the reasoning written there), and
      the AA loop above uses it. Waiting here a second time, by hand, would
      mean maintaining the same knowledge twice — and this case is the
      evidence of what happens when the two drift apart.
    */
    const dashboard = A11Y_VIEWS.find((view) => view.kind === 'dashboard');
    if (dashboard === undefined) {
      throw new Error(
        'A11Y_VIEWS führt keine Ansicht mit kind „dashboard" mehr — dieser ' +
          'Fall misst das Dashboard und braucht dessen Ladepunkt.',
      );
    }
    await dashboard.open(page, fixture);

    const small = await measureSmallTargets(page, TOUCH_TARGET_PX);

    /*
      The dimensions stay out of the comparison and go into the message, the
      same split the AA loop above makes and for its reason: they come from
      `getBoundingClientRect`, carry decimal places and shift by tenths with the
      font delivery.
    */
    const measured = small
      .map(
        (target) =>
          `${target.control} ${String(target.width)}×${String(target.height)}`,
      )
      .join(' · ');

    const named = small
      .map((target) => target.control)
      .filter((control) => !AAA_DASHBOARD_WHEN_PAGED.includes(control));
    const expected = aaaDashboardControls(await activeTenantName(page));

    expect(
      named,
      'Gemessen am 2026-08-18: die Marke (284×38), der Hamburger (40×40), ' +
        '„+ Neues Formular" (161×32), die vier Kartenknöpfe (34 px hoch), ' +
        '„Zum Mailversand" und „Zu den Rechtstexten" aus den offenen Punkten ' +
        `(je 37 px) und das Suchfeld — gemessen: ${measured}. ` +
        'Das ist die Bauhöhe der Anwendung und keine Nachlässigkeit dieser ' +
        'Ansicht — die Umstellung auf 44 px ist eine Entscheidung, die nicht ' +
        'in dieser Datei fällt. Kommt ein Name hinzu, gehört das Element ' +
        'angesehen, bevor es hier nachgetragen wird: unter 24 px wäre es ein ' +
        'Fehler und kein Eintrag. Die Blätterknöpfe stehen bewusst nicht in ' +
        'dieser Liste, sondern in `AAA_DASHBOARD_WHEN_PAGED` — sie hängen an ' +
        'der Zahl der Formulare, die andere Dateien nebenher anlegen.',
    ).toStrictEqual([...expected]);
  });
});

/**
 * **Nothing hangs on hover** (the evidence).
 *
 * On a phone there is no pointer that *hovers* anywhere. An action that at the
 * desk only appears on mouse-over is simply not there — and because it exists in
 * the screenshot and in the DOM, nobody notices.
 *
 * What is measured is in a context **with** touch and **without** mouse
 * movement: the actions of the form card and the row action of the answers table
 * are visible before anything has touched them. The counter-check below builds
 * in the defect and shows that this assertion sees it.
 */
test.describe('360 px – keine Aktion hängt an Hover ', () => {
  test.use({ storageState: authStateFile });

  test('Kartenaktionen und Zeilenaktion stehen ohne Zeiger da — und die Gegenprobe sieht das Gegenteil', async ({
    page,
  }) => {
    await page.goto('/');
    const card = page.getByRole('article').first();
    await expect(card).toBeVisible();

    for (const label of ['Bearbeiten', 'Duplizieren', 'Löschen']) {
      await expect(
        card.getByRole('button', { name: label }),
        `„${label}" muss ohne Hover sichtbar sein — auf einem Telefon gibt es ` +
          'keinen schwebenden Zeiger, und eine Aktion, die erst beim ' +
          'Überfahren erscheint, ist dort nicht erreichbar.',
      ).toBeVisible();
    }

    /*
      The reproduction, verbatim: „eine Aktion nur in `:hover`
      einblenden → (2) rot". In the DOM instead of in the source text, like the
      counter-checks in `a11y.spec.ts` and `mobile-reachable.spec.ts` and for
      their reason.
    */
    await page.addStyleTag({
      content:
        '.form-card__delete { display: none } ' +
        '.form-card:hover .form-card__delete { display: inline-flex }',
    });

    await expect(
      card.getByRole('button', { name: 'Löschen' }),
      'Nach der eingebauten Hover-Regel muss die Aktion verschwunden sein — ' +
        'sonst misst die Zusicherung darüber nicht, was sie zu messen vorgibt.',
    ).toBeHidden();

    // And the answers table: „Ansehen" per row, likewise without hover.
    await page.goto(`/forms/${fixture.formId}/responses`);
    await expect(
      page.getByRole('button', { name: /Ansehen/u }).first(),
    ).toBeVisible();
  });
});
