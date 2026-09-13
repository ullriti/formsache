import { expect, test, type Page } from '@playwright/test';

import {
  A11Y_OVERLAYS,
  type A11yOverlayFixture,
  type A11yWidth,
} from './a11y/overlays';
import {
  FIRST_QUESTION_TYPE,
  FURTHER_QUESTION_TYPES,
} from './a11y/question-types';
import { A11Y_VIEWS, type A11yFixture } from './a11y/views';
import { expectNoSeriousViolations, scan } from './a11y/scan';
import {
  addQuestion,
  DESKTOP_BREAKPOINT_PX,
  expectNoHorizontalScroll,
  expectSaved,
  newForm,
  publishAndReadPath,
  saveForm,
} from './app-flows';
import { measureSmallTargets, TOUCH_TARGET_MIN_PX } from './mobile/operable';
import { authStateFile } from './seed-account';

/**
 * **A mechanical checker runs over every view, desktop and 360 px, and
 * finds nothing** .
 *
 * This file runs in **both** width projects. The width therefore stands
 * in the report name — „mobile-360x740 › Dashboard" is evidence, a green
 * run of a project named `chromium` is not. The same consideration that
 * `playwright.config.ts` makes for the two viewports as a whole.
 *
 * **Which views** is not decided by this file: `a11y/views.ts` carries
 * the way to each one, and `a11y-view-list.spec.ts` counts these ways against
 * the addresses that `parseRoute` can produce. If one is missing, it is counted
 * instead of passed over in silence.
 *
 * **`mode: 'default'` instead of the global `fullyParallel`**, and that is a
 * leftover-data decision: `beforeAll` builds a form, publishes it,
 * submits a response and saves a draft in between. Under
 * `fullyParallel` this `beforeAll` would run once **per worker**, that is up to
 * four times per project — four forms, four responses, four drafts per run,
 * for a check that writes nothing. This way it is one per project, and
 * `afterAll` clears that away again too.
 */

test.describe.configure({ mode: 'default' });

/**
 * The browser globals that the `page.evaluate` callback of the counter-check
 * needs.
 *
 * The root `tsconfig.json` above `e2e/` deliberately has no DOM lib
 * (`lib: ["ES2023"]`, `types: ["node"]`); `app-flows.ts` explains why, and
 * for the same reason declares only what it uses. Ambient and
 * module-wide — at runtime the callback runs in the real browser.
 */
interface StrippableButton {
  readonly textContent: string | null;
  replaceChildren: () => void;
  removeAttribute: (name: string) => void;
}
declare const document: {
  querySelectorAll: (selector: string) => Iterable<StrippableButton>;
};

/** Width in which the preparation runs — independent of the project. */
const SETUP_VIEWPORT = { width: 1280, height: 800 } as const;

/**
 * The first question of the test form — the one that is filled in and submitted.
 *
 * Written out instead of „Name": `getByLabel` searches as a substring, and one
 * word hits a second field sooner or later — the same trap that cost the
 * suite 54 cases with „Speichern" (`app-flows.ts`, `saveForm`).
 */
const QUESTION_LABEL = 'Name des Mitglieds';

/**
 * What the views need in order to be looked at, built once.
 *
 * `let` with assignment in `beforeAll`, because the values only come into
 * being at runtime — Playwright collects the tests beforehand, so the table in
 * `views.ts` cannot contain them. They arrive as an argument in `open()`.
 */
let fixture: A11yFixture;
let overlayFixture: A11yOverlayFixture;
let formId: string | undefined;
let guardedFormId: string | undefined;

/**
 * The subject of the notification that the preparation creates — and thereby the
 * **accessible name** of the button that opens the mail dialog
 * (`MailLogView.tsx`: the subject line *is* the button).
 */
const MAIL_SUBJECT = 'Prüfzeile für den axe-Lauf';

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

test.beforeAll(async ({ browser }) => {
  /*
    **The preparation needs more than the 30 seconds of a test case**, ever since
    it creates sixteen questions, one notification and a second,
    password-protected form (a review finding). Without this line
    it breaks off midway — and on the first run on 2026-08-12 that looked
    like a bug in the dashboard case, because Playwright attributes the abort of a
    `beforeAll` to the first case that waits for it.
  */
  test.setTimeout(180_000);

  const context = await browser.newContext({
    storageState: authStateFile,
    viewport: SETUP_VIEWPORT,
  });
  const page = await context.newPage();

  try {
    await newForm(page, 'Barrierefreiheit');
    const id = /\/forms\/([^/?#]+)/u.exec(page.url())?.[1];
    if (id === undefined) {
      throw new Error(`Keine Formular-Id in ${page.url()}.`);
    }
    formId = id;

    await addQuestion(page, FIRST_QUESTION_TYPE, QUESTION_LABEL);
    for (const type of FURTHER_QUESTION_TYPES) {
      await addQuestion(page, type);
    }
    await saveForm(page);
    const publicPath = await publishAndReadPath(page);

    // *Zwischenspeichern* and *Bearbeiten nach Absenden* unlock the two
    // public addresses that would otherwise not exist at all — without them
    // `/e/…` and `/a/…` are not views, but 404.
    await page.goto(`/forms/${formId}/settings`);
    const access = page.getByRole('region', { name: 'Zugriff & Sicherheit' });
    await access.getByRole('radio', { name: 'Angepasst' }).check();
    await access
      .getByRole('switch', { name: 'Zwischenspeichern erlauben' })
      .setChecked(true);
    await access
      .getByRole('switch', { name: 'Bearbeiten nach Absenden' })
      .setChecked(true);
    await page.getByRole('button', { name: 'Speichern', exact: true }).click();
    // Not the disabled button: that one is disabled while the
    // request is still on its way, too (`app-flows.ts`, `expectSaved`).
    await expectSaved(page);

    /*
      **A notification, so that there is a mail to open.**

      The dialog „E-Mail ansehen" is the only one that does not open without a
      real row in the mail log. Opening it on an *arbitrary* first row
      would be the case that this file rules out in three other places:
      on an empty log it would find nothing, would run over nothing and would
      report green. That is why the preparation creates the row itself — the
      subject is the button that the entry looks for later.
    */
    await page.goto(`/forms/${formId}/notifications`);
    await page.getByRole('button', { name: '+ Neue Benachrichtigung' }).click();
    // The name stays the default: `getByLabel('Name')` here also hits the
    // placeholder chip of the question „Name des Mitglieds" — exactly the
    // substring trap that the explanation of `QUESTION_LABEL` warns about.
    await page
      .getByLabel('Weitere Adressen (mit Komma getrennt)')
      .fill('pruefung@example.org');
    await page.getByLabel('Betreff').fill(MAIL_SUBJECT);
    await page.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expectSaved(page);

    /*
      The two tokens only come into being by someone **really** using the
      form — the server builds both addresses, not the test.

      **Two separate guest contexts, and that is no gesture of diligence.** On
      the first run on 2026-08-10 both did it in the same context: first
      save in between, then submit. `/e/<Merkzeichen>` then showed
      „Entwurf **verworfen**" instead of „Entwurf fortsetzen" — submitting clears
      away the draft of the same participant, which is right in substance and
      destroys the view that is to be checked here. The case only came to light
      because `settled()` waits for the heading of the *expected* view;
      a "wait for any `<h1>`" would have let axe run over the wrong page
      and report green.
    */
    const draftContext = await browser.newContext({ viewport: SETUP_VIEWPORT });
    const draftGuest = await draftContext.newPage();
    let draftUrl: string | null;
    try {
      await draftGuest.goto(publicPath);
      await draftGuest
        .getByLabel(new RegExp(QUESTION_LABEL, 'u'))
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
        .getByLabel(new RegExp(QUESTION_LABEL, 'u'))
        .fill('Bert Bedacht');
      await sendGuest.getByRole('button', { name: 'Absenden' }).click();
      const editUrl = await sendGuest
        .getByTestId('public-edit-link')
        .getByRole('link')
        .getAttribute('href');
      expect(editUrl, 'Adresse zum Bearbeiten').toMatch(
        /^https?:\/\/[^/]+\/a\/[A-Za-z0-9_-]+$/u,
      );

      /*
        **The second form: password-protected.**

        It has to be one of its own. An access word on the test form would hit
        every public view of it — `/f/…`, `/a/…` and `/e/…` would then show
        the password screen, and the axe run would check the same mask
        three times instead of the three views it is there for.
      */
      await page.goto('/');
      await newForm(page, 'Barrierefreiheit · geschützt');
      const guardedId = /\/forms\/([^/?#]+)/u.exec(page.url())?.[1];
      if (guardedId === undefined) {
        throw new Error(`Keine Formular-Id in ${page.url()}.`);
      }
      guardedFormId = guardedId;
      await addQuestion(page, FIRST_QUESTION_TYPE, QUESTION_LABEL);
      await saveForm(page);

      await page.goto(`/forms/${guardedId}/settings`);
      const guard = page.getByRole('region', { name: 'Zugriff & Sicherheit' });
      await guard.getByRole('radio', { name: 'Angepasst' }).check();
      await guard
        .getByRole('switch', { name: 'Passwortschutz' })
        .setChecked(true);
      // „Zugangs**passwort**" here, „Zugangswort" on the screen that the
      // participant sees — two words for the same thing, and `getByLabel`
      // searches as a substring, so it does not hit the one via the other.
      await guard.getByLabel('Zugangspasswort').fill('Zugangswort2026x');
      await page
        .getByRole('button', { name: 'Speichern', exact: true })
        .click();
      await expectSaved(page);
      await page.goto(`/forms/${guardedId}`);
      const passwordPath = await publishAndReadPath(page);

      fixture = {
        formId,
        publicPath,
        draftPath: new URL(draftUrl ?? '').pathname,
        editPath: new URL(editUrl ?? '').pathname,
      };
      overlayFixture = {
        ...fixture,
        passwordPath,
        mailSubject: MAIL_SUBJECT,
        firstQuestionLabel: QUESTION_LABEL,
      };
    } finally {
      await sendContext.close();
    }
  } finally {
    await context.close();
  }
});

/**
 * Takes the test form out of the organisation again — two requests, because
 * `DELETE /api/forms/:id/permanent` only takes hold of what lies **in** the
 * wastebasket. The same order as in `preview-test-mode.spec.ts`.
 */
test.afterAll(async ({ browser }) => {
  if (formId === undefined) {
    return;
  }
  const context = await browser.newContext({ storageState: authStateFile });
  const page = await context.newPage();
  try {
    await page.goto('/');
    const headers = await csrfHeader(page);
    for (const id of [formId, guardedFormId]) {
      if (id === undefined) {
        continue;
      }
      await page.request.delete(`/api/forms/${id}`, { headers });
      await page.request.delete(`/api/forms/${id}/permanent`, { headers });
    }
  } finally {
    await context.close();
  }
});

test.describe('Barrierefreiheit – angemeldet ', () => {
  test.use({ storageState: authStateFile });

  for (const view of A11Y_VIEWS.filter((v) => v.audience === 'signed-in')) {
    test(view.name, async ({ page }) => {
      await view.open(page, fixture);
      await expectNoSeriousViolations(page, view.name);
    });
  }
});

test.describe('Barrierefreiheit – ohne Anmeldung ', () => {
  // Explicitly empty instead of "not set": without this line the
  // context would inherit nothing, but the intention would stand nowhere. The
  // public views are exactly those that must be reachable **without** a session.
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const view of A11Y_VIEWS.filter((v) => v.audience === 'public')) {
    test(view.name, async ({ page }) => {
      await view.open(page, fixture);
      await expectNoSeriousViolations(page, view.name);
    });
  }
});

/**
 * **And the overlays** (a review finding, 2026-08-12).
 *
 * Why they are a list of their own and what that says about the old one stands in
 * `a11y/overlays.ts`. Here stands only how the width is decided: the
 * off-canvas sheets exist below 1180 px *instead* of the columns, the
 * tenant switcher only above it. An entry that runs in the wrong width
 * would wait for a button that does not exist there — and the case would be red for
 * a reason that has nothing to do with accessibility.
 *
 * `test.skip` instead of a filter over `A11Y_OVERLAYS`: the skipped case
 * then stands in the report together with its width. A filtered-out entry cannot
 * be distinguished from a forgotten one.
 */
function skipForeignWidth(page: Page, width: A11yWidth): void {
  if (width === 'any') {
    return;
  }
  // The number stands in `app-flows.ts` and only there — `overlays.ts` gives
  // the reason two screens further on why `inPagesArea` knows no width at all.
  const isMobile = (page.viewportSize()?.width ?? 0) < DESKTOP_BREAKPOINT_PX;
  test.skip(
    width === 'mobile' ? !isMobile : isMobile,
    `Diese Überlagerung gibt es nur in der Breite „${width}".`,
  );
}

test.describe('Barrierefreiheit – Dialoge und Popover', () => {
  test.use({ storageState: authStateFile });

  for (const overlay of A11Y_OVERLAYS.filter(
    (o) => o.audience === 'signed-in',
  )) {
    test(overlay.name, async ({ page }) => {
      skipForeignWidth(page, overlay.width);
      await overlay.open(page, overlayFixture);
      await expectNoSeriousViolations(page, overlay.name);
    });
  }
});

test.describe('Barrierefreiheit – Überlagerungen ohne Anmeldung', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const overlay of A11Y_OVERLAYS.filter((o) => o.audience === 'public')) {
    test(overlay.name, async ({ page }) => {
      skipForeignWidth(page, overlay.width);
      await overlay.open(page, overlayFixture);
      await expectNoSeriousViolations(page, overlay.name);
    });
  }
});

/**
 * **Touch targets and horizontal scrollbar of an *open* overlay**
 * (a review finding, second half).
 *
 * The four mobile guards read `A11Y_VIEWS` — that is, **pages**. What a dialog
 * does at 360 px, none of them saw: neither whether its buttons keep the 24 px
 * nor whether it makes the page scroll horizontally. Both are more likely with a
 * dialog than on a page, because it brings a fixed width
 * along and its control bar is set narrowly.
 *
 * The case runs here and not in `mobile-targets.spec.ts`, because the
 * overlays need a preparation that exists **only here** (sixteen
 * questions, one notification, one protected form). Copying it over there
 * would be the second truth about the same test form.
 *
 * ⚠️ **The width comes from the project, not from `test.use`.** In
 * `playwright.config.ts` this file is claimed by *both* view projects; an
 * own 360 px viewport here would let every case below run **twice** —
 * once in the mobile project and once in the desktop project, which would then
 * force it to 360 px. The same measurement run twice is not a double statement, but
 * double the time: the CI's e2e run hit its 20-minute limit on exactly
 * this. In the desktop project it is therefore skipped, visibly in the report.
 */
test.describe(`360 px – Überlagerungen: Touch-Ziele ≥ ${String(
  TOUCH_TARGET_MIN_PX,
)} px und kein Querscrollen`, () => {
  test.use({ storageState: authStateFile });

  for (const overlay of A11Y_OVERLAYS.filter(
    (o) => o.audience === 'signed-in',
  )) {
    test(overlay.name, async ({ page }) => {
      test.skip(
        (page.viewportSize()?.width ?? 0) >= DESKTOP_BREAKPOINT_PX,
        'Diese Messung gilt der schmalen Breite; im Mobil-Projekt läuft sie.',
      );
      skipForeignWidth(page, overlay.width);
      await overlay.open(page, overlayFixture);

      await expectNoHorizontalScroll(page, `${overlay.name} (360 px)`);

      const small = await measureSmallTargets(page, TOUCH_TARGET_MIN_PX);
      const measured = small
        .map(
          (target) =>
            `${target.control} ${String(target.width)}×${String(target.height)}`,
        )
        .join(' · ');

      expect(
        small.map((target) => target.control),
        `${overlay.name}: diese Bedienelemente bleiben unter ` +
          `${String(TOUCH_TARGET_MIN_PX)} × ${String(TOUCH_TARGET_MIN_PX)} px ` +
          `— gemessen: ${measured}. Sie gehören vergrößert, nicht ` +
          'eingetragen: `--touch-target-min` ist die Zusage.',
      ).toStrictEqual([]);
    });
  }
});

/**
 * **The counter-check, run permanently** — the second reproduction of this
 * behaviour.
 *
 * "Zero violations" can only be distinguished from "the checker ran over nothing"
 * if someone shows that the checker *would* have something to report if there
 * is something to report. This probe has to run once; here it stands
 * permanently in the run, because a probe run once says nothing about whether
 * the gate is still sharp in half a year (for instance after someone has drawn
 * the rule sets in `scan.ts` tighter).
 *
 * The defect is produced in the **real** view and is exactly the
 * expected one: a button whose accessible name disappears — icon without
 * text, without `aria-label`. In the DOM instead of in the source, and that is on
 * purpose: breaking a button in the source would mean changing a foreign file and
 * trusting that it is turned back. The result is
 * the same DOM.
 */
test.describe('Gegenprobe: das Gate wird rot ', () => {
  test.use({ storageState: authStateFile });

  test('ein Knopf ohne zugänglichen Namen meldet serious', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    /*
      Beforehand **without this finding** — not "beforehand flawless".

      The first version demanded an all-round clean dashboard and failed
      on a contrast shortfall that has nothing to do with button names (measured
      on 2026-08-10: `.dashboard__subtitle` and the four KPI labels).
      That would be a counter-check that only runs again once somebody else
      repairs something — that is, one that stays silent exactly when the gate
      ought to be checked.

      What is measured is therefore the difference that *this* defect makes:
      `button-name` is missing beforehand and stands there afterwards. That is the whole
      claim, and it is independent of everything else that is still open.
    */
    const before = await scan(page);
    expect(
      before.blocking.map((violation) => violation.id),
      'Vor dem eingebauten Defekt darf `button-name` nicht unter den Funden ' +
        'sein — sonst misst der Fall nicht, was er zu messen vorgibt.',
    ).not.toContain('button-name');

    const stripped = await page.evaluate(() => {
      for (const button of document.querySelectorAll('button')) {
        if ((button.textContent ?? '').trim() === '') {
          continue;
        }
        // Icon without text, without `aria-label` — literally the reproduction.
        button.replaceChildren();
        button.removeAttribute('aria-label');
        button.removeAttribute('aria-labelledby');
        button.removeAttribute('title');
        return 1;
      }
      return 0;
    });

    expect(
      stripped,
      'Auf dem Dashboard muss es einen beschrifteten Knopf geben, dem der ' +
        'Name genommen werden kann — sonst prüft diese Gegenprobe nichts.',
    ).toBe(1);

    const after = await scan(page);
    const names = after.blocking.map((violation) => violation.id);
    expect(
      names,
      'axe muss den Knopf ohne zugänglichen Namen als serious melden. Tut es ' +
        'das nicht, ist das Gate stumpf und jedes grüne „null Verstöße" ' +
        'darüber wertlos.',
    ).toContain('button-name');

    // And at which level — expected is *serious*, axe classifies
    // `button-name` as *critical*. Both are blocking; the assertion
    // therefore names the set and not the single value, so that a sharper
    // classification by axe does not make this case red.
    const found = after.blocking.find(
      (violation) => violation.id === 'button-name',
    );
    expect(['serious', 'critical']).toContain(found?.impact);
  });
});
