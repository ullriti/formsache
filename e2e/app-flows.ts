import {
  expect,
  type Browser,
  type Locator,
  type Page,
} from '@playwright/test';

import { readInstanceMail } from './instance-mail';
import type { CaughtMessage } from './smtp-catcher';
import { seedAdmin } from './seed-account';

/**
 * How the specs drive and read the application: the login form, the two
 * original views, the off-canvas menu and the overflow measurement of the requirement.
 *
 * Everything here addresses the app the way a user does — by role, label and
 * visible text — so a refactor of the markup does not break the suite while a
 * broken control still does. The few places that had to reach for something
 * else say why on the spot.
 */

/**
 * Minimal browser globals for the `page.evaluate` callbacks below.
 *
 * The root `tsconfig.json` that covers `e2e/` deliberately has no DOM lib
 * (`lib: ["ES2023"]`, `types: ["node"]`) — pulling `lib.dom` in would put the
 * browser's `fetch`, `URL` and friends next to the Node ones for every file in
 * this project. Declaring only the members that are actually used keeps the
 * blast radius at this module. The declarations are ambient and module-scoped;
 * at run time the callbacks execute in the real browser.
 */
interface MeasurableElement {
  readonly scrollWidth: number;
  readonly clientWidth: number;
  /** The rest is read by the third measurement of the overflow assertion. */
  readonly tagName: string;
  readonly id: string;
  readonly classList: Iterable<string>;
  querySelectorAll: (selector: string) => Iterable<MeasurableElement>;
}

declare const document: {
  readonly documentElement: MeasurableElement;
  readonly fonts: { readonly ready: Promise<unknown> };
  querySelector: (selector: string) => MeasurableElement | null;
};
declare const window: {
  matchMedia: (query: string) => { readonly matches: boolean };
  /** Read by {@link expectSideScrollerReachable} — see the note there. */
  readonly scrollX: number;
};
declare const getComputedStyle: (element: MeasurableElement) => {
  readonly overflowX: string;
  readonly textOverflow: string;
};

/** The one message a failed login may produce (`LoginView`). */
export const CREDENTIALS_MESSAGE = 'E-Mail-Adresse oder Passwort ist falsch.';

/** Desktop breakpoint of the handoff — `apps/web/src/styles/breakpoints.ts`. */
export const DESKTOP_BREAKPOINT_PX = 1180;

const RATE_LIMIT_MESSAGE =
  'POST /api/auth/login answered 429. The endpoint allows ten attempts per ' +
  'minute and IP (apps/api/src/auth/login-rate-limit.ts) and every project of ' +
  'this suite calls it from the same loopback address, so this is a budget ' +
  'problem of the run — not a defect of the application, and not a reason to ' +
  'raise the limit. The suite spends four attempts per run; a third `pnpm e2e` ' +
  'started inside the same minute exceeds the bucket. Wait a minute and rerun.';

/**
 * Fills the login form and submits it, returning the status of the login
 * request itself.
 *
 * The response is awaited rather than inferred from the view that follows: a
 * 429 and a 401 both leave the user on the login page, and only one of them
 * says something about the application. Every login of the suite goes through
 * here, which is also what makes the attempt budget countable.
 */
export async function submitLogin(
  page: Page,
  credentials: { readonly email: string; readonly password: string },
): Promise<number> {
  await page.getByLabel('E-Mail-Adresse').fill(credentials.email);
  await page.getByLabel('Passwort').fill(credentials.password);

  const responded = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/auth/login') &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Anmelden' }).click();
  const response = await responded;

  if (response.status() === 429) {
    throw new Error(RATE_LIMIT_MESSAGE);
  }
  return response.status();
}

/** Signs in as the seeded administrator and waits for the dashboard. */
export async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await expectLoginView(page);

  const status = await submitLogin(page, seedAdmin);
  expect(
    status,
    'Login with the seeded credentials must succeed. A 401 here usually means ' +
      'the database was seeded earlier with a different SEED_ADMIN_PASSWORD — ' +
      'the seed deliberately does not reset an existing password.',
  ).toBe(200);

  await expectDashboard(page);
}

export async function expectLoginView(page: Page): Promise<void> {
  await expect(
    page.getByRole('heading', {
      name: 'Formsache',
      level: 1,
    }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Anmelden' })).toBeVisible();
}

/**
 * The dashboard of the requirement — the four KPI tiles and the card grid.
 *
 * **The zeros are no longer asserted, and that is a deliberate loosening.**
 * Until recently the dashboard could only ever be empty, so "Formulare 0"
 * was the claim worth making. Now the builder creates forms in the same
 * database, the suite runs its projects in parallel, and a hard zero here
 * would make one spec's success another spec's failure — a flake that says
 * nothing about the application.
 *
 * What is still asserted is everything that is *always* true: the heading, all
 * four tiles present and each carrying a number. `expectEmptyDashboard` below
 * keeps the stricter check for the one place it still holds.
 */
export async function expectDashboard(page: Page): Promise<void> {
  const main = page.getByRole('main');

  await expect(
    page.getByRole('heading', { name: 'Dashboard', level: 1 }),
  ).toBeVisible();

  for (const label of [
    'Formulare',
    'Aktiv',
    'Antworten gesamt',
    'Organisationen',
  ]) {
    await expectKpiIsANumber(main, label);
  }
}

/**
 * The tile carries a number — not which number.
 *
 * The pairing of label and value is what is being checked, and it is the part
 * that broke once already: `toHaveText('0Formulare')` only held because `<dd>`
 * came before `<dt>`, which is not the order HTML prescribes.
 */
async function expectKpiIsANumber(
  scope: Locator,
  label: string,
): Promise<void> {
  const tile = scope
    .getByRole('term')
    .filter({ hasText: new RegExp(`^${label}$`) })
    .locator('xpath=..');

  await expect(tile.getByRole('definition')).toHaveText(/^\d+$/);
}

export interface MobileMenu {
  readonly hamburger: Locator;
  readonly sheet: Locator;
}

/** Locators of the compact header's menu, without opening anything. */
export function mobileMenu(page: Page): MobileMenu {
  return {
    hamburger: page.getByRole('button', { name: 'Menü öffnen' }),
    sheet: page.getByRole('dialog', { name: 'Menü' }),
  };
}

/** Opens the off-canvas sheet and waits for it to be there. */
export async function openMobileMenu(page: Page): Promise<MobileMenu> {
  const menu = mobileMenu(page);
  await menu.hamburger.click();
  await expect(menu.sheet).toBeVisible();
  return menu;
}

/**
 * Signs out through whichever control the current layout offers.
 *
 * Two different buttons, not one rendered twice: above the breakpoint logout
 * sits in the header, below it inside the off-canvas sheet. A flow test that
 * only ever clicked the header one would leave the compact layout's logout
 * unexercised.
 */
export async function logOut(page: Page): Promise<void> {
  const width = page.viewportSize()?.width ?? DESKTOP_BREAKPOINT_PX;

  if (width >= DESKTOP_BREAKPOINT_PX) {
    await page.getByRole('button', { name: 'Abmelden' }).click();
    return;
  }

  const { sheet } = await openMobileMenu(page);
  await sheet.getByRole('button', { name: 'Abmelden' }).click();
}

/**
 * One box inside `<main>` that hides its own horizontal overflow, and by how
 * many pixels. `px: 0` with an empty `element` is the "nothing overflows" case,
 * so the assertion below can compare against a single literal and still name
 * the culprit when it fails.
 */
interface ClippedOverflow {
  readonly px: number;
  readonly element: string;
}

/** No box inside `<main>` hides anything — the only value that passes. */
const NO_CLIPPED_OVERFLOW: ClippedOverflow = { px: 0, element: '' };

/**
 * The requirement's own assertion: nothing is wider than the viewport.
 *
 * Three measurements, in this order — the root element, which is what the
 * browser would actually give a scrollbar for; then `<main>`, which is where
 * the shell clips its own overflow; and then every box **inside** `<main>` that
 * clips on its own (see the note further down). `expect.poll` rather
 * than a single read: layout settles after the web fonts arrive, and waiting
 * for a state is the only legitimate way to wait (`CONTRIBUTING.md` — no
 * `waitForTimeout`).
 *
 * All three apply to **every** view this is called on; the presence of `<main>`
 * is asserted rather than tolerated. The earlier version returned `0` when
 * there was no `<main>`, and the signed-out app had none — so on the login view
 * the second measurement reported "fits" without measuring anything, for as
 * long as it existed. A helper that quietly measures nothing is worse than one
 * measurement fewer, because the suite still reports the coverage.
 */
export async function expectNoHorizontalScroll(
  page: Page,
  where: string,
): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });

  const width = page.viewportSize()?.width ?? 0;

  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        ),
      {
        message:
          `${where} (viewport ${String(width)} px) must not scroll horizontally: ` +
          'documentElement.scrollWidth exceeds clientWidth by the pixels below.',
      },
    )
    .toBeLessThanOrEqual(0);

  // Second measurement, because the first one alone has a blind spot that was
  // measured, not assumed: `.app-shell__main` carries `overflow-x: hidden`, so
  // anything too wide inside it is clipped and never reaches the root's scroll
  // width. A 700 px block placed in the dashboard left the assertion above
  // green — the content was simply cut off, which is not better than a
  // scrollbar, only quieter. `<main>` is therefore measured on its own.
  await expect(
    page.locator('main'),
    `${where}: the overflow measurement below reads <main>, so the view has to ` +
      'have exactly one — which every view owes its keyboard and screen-reader ' +
      'users anyway. A missing landmark is reported here instead of being ' +
      'treated as "nothing overflows".',
  ).toHaveCount(1);

  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const main = document.querySelector('main');
          // Unreachable after the assertion above. `Infinity` rather than `0`
          // so a `<main>` that vanishes between the two reads fails the check
          // instead of passing it by absence.
          return main === null
            ? Number.POSITIVE_INFINITY
            : main.scrollWidth - main.clientWidth;
        }),
      {
        message:
          `${where} (viewport ${String(width)} px): the content of <main> is wider ` +
          'than its box. `overflow-x: hidden` hides that from the document, so it ' +
          'is checked here — the overflow in pixels is below.',
      },
    )
    .toBeLessThanOrEqual(0);

  /*
   * Third measurement, because the first two together still had a blind spot
   * that was measured rather than assumed — and it covered most of what this
   * helper is called on.
   *
   * `.settings-card` carries `overflow: hidden`, and it is the outer box of the
   * organisation administration, the mail tab and the system settings. Forcing 900 px
   * onto the host field of the mail tab produced `scrollWidth 920 / clientWidth
   * 322` on that card — 598 px swallowed — while `documentElement` and `<main>`
   * both read **0**. Three of the five views of the requirement therefore
   * stayed green under this specific reproduction; the one that
   * turned red in the original commit happened to overflow in a box *outside*
   * the clip. An assertion that cannot go red is not an assertion.
   *
   * So: every descendant of `<main>` that **clips** horizontally is asked how
   * much of its content it is holding back, and the worst one has to be zero.
   *
   * `hidden`/`clip` only — `auto` and `scroll` are deliberately **not**
   * measured, and that was decided by running it rather than by taste. With
   * them included, `system-settings.spec.ts:551` went red on
   * `nav.segmented.segmented--tabs`, 40 px. That box is the *fix* for the 18 px
   * tab bar cited here: `settings-view.css:380` chose "scrolling
   * rather than wrapping, because a pill that breaks into two rows stops
   * reading as one control", and names this very assertion while doing it. A
   * side-scroller hands its content to the user; its border box still fits the
   * column, so nothing sticks out over the viewport. Silent clipping hands
   * over nothing, and that is the whole difference this measurement is
   * drawing.
   */
  await expect
    .poll(
      async () =>
        page.evaluate((): ClippedOverflow => {
          const main = document.querySelector('main');
          if (main === null) {
            // Unreachable after the assertion above; reported rather than
            // passed by absence, exactly like the measurement before it.
            return { px: Number.POSITIVE_INFINITY, element: '<main> is gone' };
          }

          const name = (element: MeasurableElement): string => {
            const id = element.id === '' ? '' : `#${element.id}`;
            const classes = [...element.classList]
              .map((value) => `.${value}`)
              .join('');
            return `${element.tagName.toLowerCase()}${id}${classes}`;
          };

          /*
           * Three kinds of box are skipped. All three were found by running
           * this measurement against the existing suite rather than reasoned
           * out in advance, and each is named with what it measured, because a
           * silent exclusion is a blind spot with better manners.
           *
           * 1. **Form controls.** They clip by UA stylesheet and scroll their
           *    *value* with the caret: the OIDC redirect URI in a 360 px field
           *    reported 75 px, the filled „Neue Organisation" dialog 2 px. That is a
           *    text field holding text, not a layout box cutting off a child.
           * 2. **Boxes one pixel wide.** `.visually-hidden` is 1×1 px with
           *    `overflow: hidden` and `clip-path: inset(50%)` — the
           *    screen-reader label pattern, which "hid" 331 px of its own text
           *    on the settings form. Keyed on the measured width, not on the
           *    class name.
           * 3. **`text-overflow: ellipsis`.** A deliberate and *visible*
           *    truncation: the app shortens long form titles and Organisation names to
           *    one line and shows the „…" that says so. What this measurement
           *    is about is the silent kind.
           *
           * None of the three can hide a genuine defect: a box that is itself
           * too wide still reaches its parent, `<main>` and the document, which
           * the two measurements above already read.
           */
          const FORM_CONTROLS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

          let worst = 0;
          let culprit = '';
          for (const element of main.querySelectorAll('*')) {
            if (FORM_CONTROLS.has(element.tagName)) {
              continue;
            }
            const style = getComputedStyle(element);
            if (style.overflowX !== 'hidden' && style.overflowX !== 'clip') {
              continue;
            }
            if (element.clientWidth <= 1 || style.textOverflow !== 'clip') {
              continue;
            }
            const hidden = element.scrollWidth - element.clientWidth;
            if (hidden > worst) {
              worst = hidden;
              culprit = name(element);
            }
          }
          return { px: worst, element: culprit };
        }),
      {
        message:
          `${where} (viewport ${String(width)} px): a box inside <main> clips ` +
          'horizontal overflow of its own (`overflow-x: hidden`/`clip`), so the ' +
          'content is cut off without a scrollbar and neither of the two ' +
          'measurements above sees it. The box and the pixels are below.',
      },
    )
    .toEqual(NO_CLIPPED_OVERFLOW);
}

/**
 * The second half of the mobile assertion, **for boxes that scroll inside
 * themselves**.
 *
 * ## Why {@link expectNoHorizontalScroll} is not enough here
 *
 * The helper above this line measures three things, and all three are
 * **structurally green** for a box with `overflow: auto`:
 *
 * 1. `documentElement` does not scroll — it does not, the box keeps the
 *    overhang to itself;
 * 2. `<main>` does not scroll — the same;
 * 3. every box that *clips* holds nothing back — and this is exactly where the
 *    comment of the third measurement says that `auto` and `scroll` are
 *    **deliberately not** measured ("a side-scroller hands its content out").
 *
 * For the responses table (`.responses__table-card`, `overflow: auto`) and the
 * mail log (`.mail-log__table-scroll`, `overflow-x: auto`) that means:
 * `expectNoHorizontalScroll` says something about the **frame** of the view —
 * header, KPI tiles, filter bar, toolbar —, but about the table itself it
 * cannot go red. "The page does not scroll" would be green there, while the
 * content is cut off and unreachable.
 *
 * This assertion therefore measures what is the precondition of the exception:
 * that the box **really does hand the content out**.
 *
 * @param scrollBox the box that is supposed to scroll.
 * @param farEdge   an element at its right end — the last column.
 */
export async function expectSideScrollerReachable(
  page: Page,
  scrollBox: Locator,
  farEdge: Locator,
  where: string,
): Promise<void> {
  await expect(
    scrollBox,
    `${where}: der scrollende Kasten muss genau einmal da sein.`,
  ).toHaveCount(1);

  /*
   * **First there has to be something to scroll.** Without this line
   * everything that follows would also be green for a table that fits into
   * 360 px on its own — an assertion that only measures when the test bench
   * happens to be wide enough is none. The calling case therefore deliberately
   * builds a wide table, and this says that it must have done so.
   */
  const overflow = await scrollBox.evaluate(
    (element: MeasurableElement) => element.scrollWidth - element.clientWidth,
  );
  expect(
    overflow,
    `${where}: diese Tabelle passt in die Breite, also misst „sie scrollt in ` +
      'sich" hier nichts. Der Fall muss eine Tabelle bauen, die breiter ist ' +
      'als der Viewport — sonst ist die Zusicherung eine Tautologie.',
  ).toBeGreaterThan(0);

  /*
   * And now the claim: the right end is reachable. If the box clipped instead
   * of scrolling, `scrollIntoViewIfNeeded` would not bring the cell into view
   * and `toBeInViewport` would be red — that is the difference the trash
   * uncovered on 2026-08-03 (`flex-wrap` on `flex: none` wraps nothing) and
   * which the three measurements above cannot see.
   */
  await farEdge.scrollIntoViewIfNeeded();
  await expect(
    farEdge,
    `${where}: die letzte Spalte ist auch nach dem Scrollen nicht im Bild — ` +
      'der Kasten schneidet ab, statt seinen Inhalt herauszureichen.',
  ).toBeInViewport();

  /*
   * …and the page did **not** move along with it. That is the promise
   * "scrolls inside itself, not the page", and it is measured after the
   * scrolling: before it, it is true for every view, including one that
   * shifts the whole page as soon as the table is touched.
   */
  const pageScrollX: number = await page.evaluate(() => window.scrollX);
  expect(
    pageScrollX,
    `${where}: das Scrollen in der Tabelle hat die ganze Seite verschoben.`,
  ).toBe(0);
}

/** What the CSS itself thinks of the current width — the breakpoint, verbatim. */
export async function matchesDesktopMediaQuery(page: Page): Promise<boolean> {
  return page.evaluate(
    (px: number) => window.matchMedia(`(min-width: ${String(px)}px)`).matches,
    DESKTOP_BREAKPOINT_PX,
  );
}

/**
 * Name of the tenant the session is scoped to, straight from the server.
 *
 * Read rather than written down, so the header assertion compares the view
 * against what the API reported instead of against a constant that both could
 * drift away from. Parsed by hand: the E2E project has no dependency on
 * `@formsache/shared` (see `api-dev.spec.ts`), and adding one to read a single
 * string would be the wrong trade.
 */
export async function activeTenantName(page: Page): Promise<string> {
  const response = await page.request.get('/api/auth/me');
  expect(response.status()).toBe(200);

  const body: unknown = await response.json();
  const activeId = property(body, 'activeTenantId');

  for (const membership of asArray(property(body, 'memberships'))) {
    const tenant = property(membership, 'tenant');
    if (property(tenant, 'id') !== activeId) {
      continue;
    }
    const name = property(tenant, 'name');
    if (typeof name === 'string' && name !== '') {
      return name;
    }
  }

  throw new Error(
    '[e2e] GET /api/auth/me reported no membership for the active tenant.',
  );
}

/** Reads a property off foreign data without asserting a shape onto it. */
function property(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function asArray(value: unknown): readonly unknown[] {
  // `Array.isArray` narrows `unknown` to `any[]`; the assertion only replaces
  // that `any` with `unknown` and widens nothing.
  return Array.isArray(value) ? (value as readonly unknown[]) : [];
}

/* --- the builder, as the specs drive it ---------------------------------- */

/**
 * Creates a form and opens it in the builder. Returns the title it used.
 *
 * The title carries a unique suffix, and that is not cosmetic: there is no way
 * to delete a form yet, so every run of the suite leaves its forms in
 * the development database. A test that looked its form up by a fixed title
 * would match this run's *and* every earlier one's — and would start failing
 * on the second `pnpm e2e` for a reason that has nothing to do with the
 * application.
 */
export async function newForm(page: Page, base: string): Promise<string> {
  const title = `${base} ${Date.now().toString(36)}`;

  await page.goto('/');
  await page.getByLabel('Name des neuen Formulars').fill(title);
  await page.getByRole('button', { name: '+ Neues Formular' }).click();

  await expect(page.getByLabel('Formularname')).toHaveValue(title);
  // The URL is the builder's — bookmarkable, and the reason routing is real
  // rather than a `view` variable.
  await expect(page).toHaveURL(/\/forms\//u);
  return title;
}

/**
 * Adds a question of the given type and, when a label is given, names it.
 *
 * Two things have to be handled, and both are behaviour rather than test
 * plumbing: inserting a question selects it, so the panel shows properties and
 * the type library needs to be reopened; and below the breakpoint the panel is
 * a sheet, so it has to be opened at all — which is also where
 * the label field lives.
 */
export async function addQuestion(
  page: Page,
  type: string,
  label?: string,
): Promise<void> {
  const sheetTrigger = page.getByRole('button', { name: 'Eigenschaften' });
  const onSmallScreen = (await sheetTrigger.count()) > 0;
  if (onSmallScreen) {
    await sheetTrigger.click();
  }

  const back = page.getByRole('button', { name: '+ Weitere Frage' });
  if ((await back.count()) > 0) {
    await back.click();
  }
  await page.getByRole('button', { name: type, exact: true }).click();

  if (label !== undefined) {
    await page.getByLabel('Fragetext').fill(label);
  }

  if (onSmallScreen) {
    await page.getByRole('button', { name: 'Schließen' }).click();
  }
}

/**
 * The save-state line of every save bar — „Gespeichert" / „Nicht gespeichert" /
 * „Wird gespeichert…". Anchored, so it matches the line and nothing containing
 * it.
 */
export function saveState(scope: Page | Locator): Locator {
  return scope.getByText(
    /^(Gespeichert|Nicht gespeichert|Wird gespeichert…)$/u,
  );
}

/**
 * Waits for a save to have **finished** — not merely to have started.
 *
 * The two obvious gates both resolve while the request is still in flight, and
 * that is the whole reason this helper exists:
 *
 * - **„der Knopf ist disabled"** is `save.isPending || !dirty` in every save bar
 *   of this app (`SettingsSaveBar`, `BuilderView`, `TenantGroupsEditor`), so it
 *   is true the instant the request *starts* and stays true after it lands. It
 *   cannot tell the two apart.
 * - **`getByText('Gespeichert')`** without `exact` matches a substring,
 *   case-insensitively — and therefore also „Wird gespeichert…" and „Nicht
 *   gespeichert". It waits for nothing at all.
 *
 * Both were measured, not guessed. `form-settings.spec.ts` recorded the first
 * („flaked roughly one run in four") for its own file and the fix stayed
 * there; on 2026-07-31 the second put a wrong row into the mail log
 * (`mail-log.spec.ts`) and the first let `tenant-admin.spec.ts:397` read a
 * permission the admin page had already revoked — a 200 where the correct
 * answer is 403. Under two workers the write is slow enough to lose the race; run
 * alone it wins, which is what made all three look like flakiness.
 *
 * `toHaveText` compares the **whole** string, so „Gespeichert" here means the
 * answer has landed and the draft is clean.
 */
export async function expectSaved(scope: Page | Locator): Promise<void> {
  await expect(saveState(scope)).toHaveText('Gespeichert');
}

/**
 * Saves the open form and waits until the save has actually landed.
 *
 * **Waits for „Nicht gespeichert" first**, and that half is as load-bearing as
 * the one after the click. The builder's edits reach its store through React
 * state, so right after typing there is a window in which the draft is still
 * clean; a click landing inside it saves the *previous* draft, the pending
 * keystroke arrives afterwards, and the badge goes back to „Nicht gespeichert".
 *
 * Measured on 2026-07-31, and only visible once the assertion below stopped
 * accepting a disabled button: `public-form-settings.spec.ts` failed in one run
 * out of two with „Nicht gespeichert" *after* a successful-looking save — the
 * form it then published was a draft short of what the case had built. The old
 * gate could not see it, because the button is disabled while nothing is dirty
 * just as much as while the request is in flight.
 */
/**
 * **`exact: true`, and it is not decoration.** Playwright matches an accessible
 * name as a *substring*, without regard to case — so „Speichern" also names
 * „Seite als Vorlage speichern", „Formular als Vorlage speichern" and „Als
 * Vorlage speichern". A later change added those three, and this one locator turned
 * **54 cases** across sixteen files red at once, none of which had anything to
 * do with templates.
 *
 * It is the same mechanism that cost the trash package a run („Löschen"
 * matched „Organisation löschen", 2026-08-03) — which is why the fix here is the whole
 * file set rather than the four cases that happened to fail first: any button
 * whose label is a *word* is one feature away from being a prefix of another.
 */
export async function saveForm(page: Page): Promise<void> {
  await expect(saveState(page)).toHaveText('Nicht gespeichert');
  await page.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expectSaved(page);
}

/**
 * Opens the **form settings** of the open form — on both layouts.
 *
 * Until review finding 18 there was a third way: a button „⚙ Einstellungen" in
 * the builder's toolbar, right next to „Speichern". It is gone, and that is why
 * this function is here instead of the same line in six files: the way now
 * hangs off the layout, and a test case that solves that for itself is one that
 * silently checks nothing any more on the other layout.
 *
 * Above the breakpoint the subheader „Aktuelles Formular" carries the entry
 * (`shell/FormNav.tsx`), below it the off-canvas menu — out of the same
 * `formNavEntries()`, which is the whole reason both ways show the same entry.
 * Both need `can_manage_form_settings`; without the permission there is neither
 * of the two, and then this function fails instead of claiming a form without
 * settings.
 */
export async function openFormSettings(page: Page): Promise<void> {
  const width = page.viewportSize()?.width ?? DESKTOP_BREAKPOINT_PX;

  if (width >= DESKTOP_BREAKPOINT_PX) {
    await page
      .getByRole('navigation', { name: 'Aktuelles Formular' })
      .getByRole('button', { name: 'Formular-Einstellungen', exact: true })
      .click();
  } else {
    const { sheet } = await openMobileMenu(page);
    await sheet
      .getByRole('button', { name: 'Formular-Einstellungen', exact: true })
      .click();
  }

  await expect(
    page.getByRole('heading', { name: 'Formular-Einstellungen' }),
  ).toBeVisible();
}

/**
 * Publishes the open form and returns the **path** of its public address.
 *
 * The address is asserted before it is parsed. A missing link would otherwise
 * reach `new URL` as an empty string, and „Invalid URL" says nothing about the
 * control that was not there. Absolute, because a site-relative path is
 * worthless in the circular mail this address ends up in.
 */
export async function publishAndReadPath(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Veröffentlichen' }).click();
  await expect(page.getByText(/Veröffentlicht \(Fassung \d+\)/u)).toBeVisible();

  const address = await page
    .getByRole('link', { name: /\/f\//u })
    .getAttribute('href');

  expect(address).toMatch(/^https?:\/\/[^/]+\/f\/[A-Za-z0-9_-]+$/u);
  return new URL(address ?? '').pathname;
}

/**
 * **Confirms the publish dialog** — the one that since ADR-0028 the missing
 * legal texts open as well.
 *
 * ## When it comes and when it does not
 *
 * `BuilderView.onPublishRequested` asks `form.status` first: on a **first**
 * publication (`status !== 'active'`) the `POST` goes out without a query —
 * there is no version anything could differ from, and no answer a change could
 * reach. Only when publishing **again** is the preview fetched, and there
 * `needsPublishNotice` decides. Since ADR-0028 it additionally says yes as long
 * as the legal texts of this organisation are incomplete — and in this test
 * database they are so throughout: the migration `20260819090000_legal_pages`
 * creates `tenant.legal_pages` as `NULL` and fills nothing back in, the seed
 * writes nothing into it, and no spec saves anything.
 *
 * That is why {@link publishAndReadPath} is **not** affected: every one of its
 * call sites publishes a freshly created form for the first time. Whoever
 * publishes again calls this helper.
 *
 * ## Why confirm and not fill the texts
 *
 * Because `tenant.legal_pages` is a **shared** row, just like the mail
 * configuration. Filling it in to get rid of a dialog would at the same time
 * take away the open item on the dashboard that `mobile-targets.spec.ts`
 * counts, and the notice that there is to be seen here — softening one
 * assertion so that another becomes more comfortable. The additional click is
 * exactly what ADR-0028 promises („Er kostet einen zusätzlichen Klick je
 * Veröffentlichung, solange die Texte fehlen"), so it gets clicked.
 *
 * The notice is **named** while doing so and not merely clicked away: a helper
 * that blindly presses „Erneut veröffentlichen" would also be satisfied if the
 * dialog opened for an entirely different reason.
 */
export async function confirmPublishNotice(page: Page): Promise<void> {
  const notice = page.getByRole('dialog', { name: 'Erneut veröffentlichen?' });
  await expect(
    notice,
    'Nach dem erneuten Veröffentlichen muss der Hinweis-Dialog dastehen — ' +
      'die Rechtstexte dieser Organisation sind nicht hinterlegt (ADR-0028), ' +
      'und `needsPublishNotice` hält deshalb an. Steht er nicht da, hat ' +
      'entweder jemand die Rechtstexte gespeichert (dann gehört diese ' +
      'Erwartung nachgezogen) oder der Hinweis ist verlorengegangen.',
  ).toBeVisible();

  await expect(
    notice.getByTestId('publish-legal-hint'),
    'Der Dialog steht, aber nicht wegen der Rechtstexte. Dann misst dieser ' +
      'Helfer etwas anderes als er behauptet.',
  ).toBeVisible();

  await notice
    .getByRole('button', { name: 'Erneut veröffentlichen', exact: true })
    .click();

  // Waited on **state**, not on time: the dialog stays up until the `POST` is
  // through (`onSettled` only then sets `idle`), so its disappearance is the
  // sign that the publication really did go out.
  await expect(notice).toHaveCount(0);
}

/* --- invitations: create person, catch mail, set password ---------------- */

/**
 * **The invitation path, written down once** (ADR-0024).
 *
 * Since 2026-08-18 nobody enters another person's password any more. Whoever
 * creates a person triggers a **mail**; the person opens the link in it and
 * sets their password themselves. For a run that wants to sign in as this
 * person afterwards that means: the typed password is gone without
 * replacement, and the detour through the inbox takes its place.
 *
 * The inbox is real — `e2e/smtp-catcher.ts`, started by `global-setup.ts` for
 * the whole run and entered by `auth.setup.ts` (`e2e/instance-mail.ts` gives
 * the reason why one and not one per file). So nothing is simulated: the mail
 * really does go out over SMTP, and the link in it is the one a human would
 * get.
 */

/**
 * The plain text of a caught message — **MIME unpacked**.
 *
 * Why not the raw `DATA` payload: the invitation link is long, and the mail is
 * German. Nodemailer encodes such a body as `quoted-printable`, breaks it at
 * 76 characters with a soft `=` break and writes every special character as
 * `=XX`. A `data.includes('/invitation/')` would then find the link sometimes
 * and sometimes not — depending on where the break fell. Exactly the kind of
 * flicker this suite must not have.
 *
 * Every MIME part is unpacked on its own, because `Content-Transfer-Encoding`
 * applies per part: `text/plain` can be `quoted-printable` and `text/html`
 * `base64`.
 */
export function mailPlainText(raw: string): string {
  const boundary = /boundary="?([^";\r\n]+)"?/iu.exec(raw)?.[1];
  /*
   * Split on the **string** and not on a built regular expression: a
   * Nodemailer boundary contains `-` and `_`, and an escaped `\-` is a
   * *syntax error* in a `u` expression outside a character class — the call
   * would have blown up at run time, and only at the very moment an invitation
   * is supposed to be read.
   *
   * The first section is the body **before** the first boundary (the outer
   * headers together with the preamble). It carries no transfer encoding of
   * its own and therefore passes through unchanged — noise, no harm.
   */
  const parts = boundary === undefined ? [raw] : raw.split(`--${boundary}`);
  return parts.map(decodeMimePart).join('\n');
}

function decodeMimePart(part: string): string {
  const split = /\r?\n\r?\n/u.exec(part);
  const headers = split === null ? '' : part.slice(0, split.index);
  const body =
    split === null ? part : part.slice(split.index + split[0].length);
  const encoding = /content-transfer-encoding:\s*([\w-]+)/iu
    .exec(headers)?.[1]
    ?.toLowerCase();

  if (encoding === 'base64') {
    return Buffer.from(body.replace(/\r?\n/gu, ''), 'base64').toString('utf8');
  }
  if (encoding === 'quoted-printable') {
    // The soft break disappears **before** the escapes: a `=3D` that fell
    // apart across two lines is otherwise no `=XX` any more.
    const unfolded = body.replace(/=\r?\n/gu, '');

    /*
     * **Collect bytes, read them as UTF-8 once** — and not one
     * `String.fromCharCode` per `=XX`.
     *
     * Quoted-printable encodes **octets**, not characters: an „ä" stands there
     * as `=C3=A4`, that is as the two UTF-8 bytes. A `fromCharCode` per escape
     * made two characters out of that (U+00C3, U+00A4) — that is „Ã¤", the
     * Latin-1 reading of the same bytes. For the link search that had no
     * consequences (a URL is ASCII), for any assertion about the **text** of a
     * mail it would be plainly wrong — and the function is called "The plain
     * text".
     *
     * The pieces between the escapes are ASCII throughout in valid
     * quoted-printable; `latin1` therefore reads them byte for byte unchanged.
     */
    const chunks: Buffer[] = [];
    const escapes = /=([0-9A-Fa-f]{2})/gu;
    let position = 0;
    for (
      let match = escapes.exec(unfolded);
      match !== null;
      match = escapes.exec(unfolded)
    ) {
      chunks.push(Buffer.from(unfolded.slice(position, match.index), 'latin1'));
      chunks.push(Buffer.from([Number.parseInt(match[1] ?? '', 16)]));
      position = match.index + match[0].length;
    }
    chunks.push(Buffer.from(unfolded.slice(position), 'latin1'));

    return Buffer.concat(chunks).toString('utf8');
  }
  return body;
}

/**
 * **How long an invitation mail may keep one waiting** — the budget of the
 * poll in {@link waitForInvitationLink}.
 *
 * Exported, because it has two sides: the waiting edge below and the time
 * budget of the *case* that calls it ({@link mailQueueTestTimeout}). Two
 * numbers for the same waiting time were exactly the contradiction the first
 * real CI run got stuck on.
 */
export const INVITATION_MAIL_POLL_TIMEOUT_MS = 120_000;

/**
 * **The time budget of a case that waits on the mail queue.**
 *
 * ⚠️ **Playwright's default — 30 s — is not enough for that**, and that is no
 * estimate: the mail worker runs at its own beat
 * (`MAIL_WORKER_INTERVAL_MS`, **15 s** in the development state), so *one*
 * invitation alone already costs up to 15 s of pure waiting time — and
 * {@link waitForInvitationLink} grants the poll 120 s, four times the whole
 * budget of the case.
 *
 * That struck in the first real CI run (2026-08-18):
 * `tenant-admin.spec.ts` → „Einladung erneut senden" waits **twice** on the
 * queue, drives three browser contexts and was dead after 30 s — with the
 * meaningless message „Test timeout of 30000ms exceeded" instead of the reason
 * the poll has ready.
 *
 * The cases that wait only *once* got through — three of them with the 30 s
 * and thus a few seconds short of the same edge
 * (`tenant-admin.spec.ts` twice, `login-rejection.spec.ts` once); the fourth
 * (`durchlauf-organisationen.spec.ts`, step 3) had long had a budget of its
 * own. All three now carry one.
 *
 * A time budget is an **upper bound and not a runtime** — a case that is
 * through in 40 s consumes nothing of it. Generously measured therefore does
 * not mean "slower" here, but: the failure reports its reason instead of dying
 * at the clock.
 *
 * @param waits How often the case calls {@link waitForInvitationLink}.
 */
export function mailQueueTestTimeout(waits: number): number {
  // The rest — contexts, page loads, forms — generously capped.
  return waits * INVITATION_MAIL_POLL_TIMEOUT_MS + 60_000;
}

/**
 * Waits for the invitation mail to this address and returns its link.
 *
 * **A poll on a state, no `waitForTimeout`.** The queue runs at its own beat
 * (`MAIL_WORKER_INTERVAL_MS`, 15 s in the development state), so it waits until
 * the file carries the line — and not a second longer.
 *
 * The **most recent** matching message wins: „Einladung erneut senden" creates
 * a second one, and the first is invalidated afterwards
 * (`password-reset-invalidation.ts`). Whoever took the old one would check a
 * link that rightly no longer works.
 */
export async function waitForInvitationLink(
  email: string,
  options: {
    readonly after?: number;
    /**
     * **Which inbox is read** — the default is the shared channel of the run
     * (`e2e/instance-mail.ts`).
     *
     * That is the right answer for every file that leaves the installation's
     * mail server the way `auth.setup.ts` entered it — so for almost all of
     * them. The two acceptance runs are the exception: they **point the
     * instance mail server at a catcher of their own** and measure precisely
     * by that which server got what (`instance-mail.ts` says so explicitly).
     * For them the shared channel is not merely unnecessary but wrong — it
     * stays empty while the mail sits at their own catcher.
     *
     * *Measured on 2026-08-18:* `durchlauf-organisationen` waited here 120 s
     * for an invitation that had long been delivered — `mail_log` listed it
     * as `sent` with `sender_identity: system` and one attempt. The channel
     * report said „6 Nachrichten insgesamt, 0 seit Index 6": exactly the
     * picture of a reader standing at the wrong mailbox.
     */
    readonly inbox?: () => readonly CaughtMessage[];
  } = {},
): Promise<string> {
  const after = options.after ?? 0;
  const inbox = options.inbox ?? readInstanceMail;

  /*
   * **The poll callback sets nothing** — it returns what it reads, and the
   * value is fetched once more afterwards.
   *
   * There used to be a `let link` here that the callback filled on the side.
   * That was exactly the side effect the comment on `newestInvitationLink()`
   * below rules out: the query was supposed to deliver a pure value, and three
   * lines higher an assignment target hung off it. The second read costs one
   * file access and can only be *more current* — the channel only grows, and
   * the most recent matching message is the wanted one anyway.
   */
  try {
    await expect
      .poll(() => newestInvitationLink(inbox(), email, after), {
        message:
          `Es kam keine Einladung mit einem /invitation/-Link an ${email} an. ` +
          'Kommt hier nichts, ist entweder der Mailserver der Instanz nicht ' +
          'eingetragen (dann hätte das Anlegen schon 422 gesagt), oder die ' +
          'Warteschlange bewegt sich nicht — MAIL_WORKER_INTERVAL_MS in .env ' +
          'muss größer als 0 sein.',
        timeout: INVITATION_MAIL_POLL_TIMEOUT_MS,
        intervals: [500, 1000, 2000, 3000],
      })
      .not.toBe('');
  } catch (error: unknown) {
    // The poll only says "stayed empty". Which of the three places it was is
    // only told by the state of the channel — see `describeMailChannel`.
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n\n` +
        describeMailChannel(inbox(), email, after),
      // The original rejection stays attached: it carries the time course of
      // the poll, which this summary does not replace.
      { cause: error },
    );
  }

  return newestInvitationLink(inbox(), email, after);
}

/**
 * **What is in the channel when no invitation arrived** — the diagnosis the
 * poll alone does not deliver.
 *
 * ⚠️ The occasion is in the CI log of 2026-08-18: „Einladung erneut senden"
 * ran into a failure twice, and both times there was nothing there but a clock
 * time. From "stayed empty" alone **three** different causes cannot be told
 * apart, and each one leads somewhere else:
 *
 * | What is here | Where the fault sits |
 * |---|---|
 * | 0 messages since `after` | the queue — nothing was delivered (`withheld`? worker off? wrong lane?) |
 * | messages since `after`, but none to this address | the recipient — the server sent to somebody else |
 * | messages to this address, but no link found | the MIME unpacking (`decodeMimePart`) or the address pattern |
 *
 * And a fourth one that is just as important: if a number **smaller** than
 * `after` is here, the channel was emptied in the middle of the run — then
 * every `after` index points into the void.
 *
 * The recipients of the last messages are given along with it, because they
 * separate the second and third row of the table immediately. Addresses of
 * this run are made-up `@example.invalid` marks, not real mailboxes.
 */
function describeMailChannel(
  all: readonly CaughtMessage[],
  email: string,
  after: number,
): string {
  const since = all.slice(after);
  const mine = since.filter((message) => message.to.includes(email));
  const recipients = all
    .slice(-5)
    .map((message) => message.to.join(', '))
    .join(' | ');

  return (
    `Posteingang: ${String(all.length)} Nachrichten ` +
    `insgesamt, ${String(since.length)} seit Index ${String(after)}, davon ` +
    `${String(mine.length)} an ${email}. Empfänger der letzten fünf: ` +
    `${recipients === '' ? '—' : recipients}.\n` +
    'Null seit dem Index heißt: die Mail wurde nie zugestellt — dann liegt es ' +
    'an der Warteschlange und nicht an dieser Datei. Nachrichten ohne eine an ' +
    'diese Adresse heißen: der Server hat woandershin geschickt. Nachrichten ' +
    'an diese Adresse ohne Link heißen: die MIME-Auspackung findet ihn nicht.'
  );
}

/**
 * The link of the **most recent** invitation to this address, or `''`.
 *
 * Separated from the waiting edge above, so that the query delivers a pure
 * value and does not set something on the side — and because `''` here means
 * "nothing there yet" and nowhere else. The poll's callback keeps to that as
 * well; why that was not a matter of course is said there.
 */
function newestInvitationLink(
  inbox: readonly CaughtMessage[],
  email: string,
  after: number,
): string {
  const candidates = inbox
    .slice(after)
    .filter((message) => message.to.includes(email));
  for (const message of [...candidates].reverse()) {
    /*
     * Up to the next whitespace or quotation mark — **no** enumeration of the
     * allowed characters: the token is a base64url signature and contains `-`
     * **and** `_`, and a class that forgets one of them cuts the link off in
     * the middle and delivers a value that looks like a link and is none. The
     * token stands alone on a line in the text version and inside an `href` in
     * the HTML version; both ends are unambiguous with that.
     */
    const found = /https?:\/\/[^\s"<>]*\/invitation\/[^\s"<>]+/u.exec(
      mailPlainText(message.data),
    );
    if (found !== null) {
      return found[0];
    }
  }
  return '';
}

/**
 * Redeems an invitation link: set the password, in a context of its **own**.
 *
 * A context of its own, because that is the point — the invited person has no
 * session, and the page stands deliberately next to the application
 * (`PasswordResetView`). A call on the superadmin's page would be a
 * measurement with a cookie that never lies there.
 *
 * It does **not** sign in: redeeming issues no session (ADR-0020), and that
 * the freshly set credentials work is the claim of the caller and not of this
 * function.
 */
export async function redeemInvitation(
  browser: Browser,
  link: string,
  password: string,
): Promise<void> {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(link);
    await expect(
      page.getByRole('heading', { name: 'Willkommen bei Formsache' }),
      'Der Einladungslink führt auf die Willkommensseite — „Neues Passwort ' +
        'vergeben" wäre der Wortlaut der Rücksetzung und hieße, die Adresse ' +
        'trägt das falsche Segment.',
    ).toBeVisible();

    await page.getByLabel('Dein Passwort', { exact: true }).fill(password);
    await page.getByLabel('Passwort wiederholen').fill(password);
    await page.getByRole('button', { name: 'Passwort setzen' }).click();

    await expect(
      page.getByRole('heading', { name: 'Passwort gesetzt' }),
      'Das Einlösen muss bestätigt werden. Bleibt die Maske stehen, hat der ' +
        'Server den Link abgelehnt — abgelaufen, schon benutzt oder von einer ' +
        'zweiten Einladung entwertet.',
    ).toBeVisible();
  } finally {
    await context.close();
  }
}

/** Whom „Person hinzufügen" is supposed to create. */
export interface InvitedPerson {
  readonly name: string;
  readonly email: string;
  /** The password **the person themselves** sets via the link. */
  readonly password: string;
  /** The group as it stands in the „Rolle" select field. */
  readonly role: string;
}

/**
 * **Create person → catch invitation → open link → set password.**
 *
 * The replacement for the password field that no longer exists in the *Person
 * hinzufügen* block. Afterwards the person can sign in with `person.password` —
 * exactly as before, only the way there is now the real one.
 *
 * `adminPage` has to be on `/admin/members` of the organisation that
 * is being invited into; the caller decides which one that is.
 *
 * The counter reading of the inbox is taken **before** the click: an older
 * invitation to the same address (from an earlier case of the same file, say)
 * must not be read as this one.
 */
export async function invitePersonAndSetPassword(
  adminPage: Page,
  browser: Browser,
  person: InvitedPerson,
): Promise<void> {
  const before = readInstanceMail().length;

  const invite = adminPage.getByRole('region', { name: 'Person hinzufügen' });
  await expect(invite).toBeVisible();
  await invite.getByRole('button', { name: 'Lokaler Nutzer' }).click();
  await invite.getByLabel('Name', { exact: true }).fill(person.name);
  await invite.getByLabel('E-Mail-Adresse', { exact: true }).fill(person.email);
  await invite
    .getByLabel('Rolle', { exact: true })
    .selectOption({ label: person.role });
  await invite.getByRole('button', { name: 'Hinzufügen' }).click();

  await expect(
    adminPage.getByText(
      `✓ ${person.name} wurde hinzugefügt und hat eine Einladung per Mail bekommen.`,
    ),
    'Die Bestätigung nennt seit ADR-0024 die Einladung. Steht hier der alte ' +
      'Satz, ist die Oberfläche älter als dieser Lauf; steht eine Absage da, ' +
      'fehlt der Installation der Mailserver — dann entsteht bewusst kein Konto.',
  ).toBeVisible();

  const link = await waitForInvitationLink(person.email, { after: before });
  await redeemInvitation(browser, link, person.password);
}

/**
 * The sender address of this run's catcher.
 *
 * `.invalid` is not resolvable per RFC 2606 — nothing leaves this machine,
 * even if the catcher does not answer for once.
 *
 * Stands here and not in `auth.setup.ts`, because two places need it: the
 * entering at the start of the run and the restoring at the end of
 * `durchlauf-organisationen.spec.ts`. Two literals would be two versions of the
 * same state — and the second one the one that goes wrong next time.
 */
export const INSTANCE_MAIL_FROM = 'installation@e2e.example.invalid';

/**
 * Enters the mail server of the instance — through the interface, like a human.
 *
 * Two callers: `auth.setup.ts` enters it at the start, and
 * `durchlauf-organisationen.spec.ts` restores it at the end **with the same
 * function**. That used to be a second copy of host, port, sender address and
 * TLS switch — exactly the place where the port would drift apart next time.
 *
 * `durchlauf-funktionsumfang.spec.ts` still does not use this here: it sets up
 * a catcher of its **own** and measures explicitly which server got a mail.
 *
 * `page` has to carry a signed-in superadmin session.
 */
export async function configureInstanceMailServer(
  page: Page,
  options: { readonly port: number; readonly from: string },
): Promise<void> {
  await page.goto('/admin/system/mail');
  await expect(
    page.getByRole('heading', { name: 'Mailserver', exact: true }),
  ).toBeVisible();

  const toggle = page.getByRole('switch', {
    name: 'Mailserver eingerichtet',
    exact: true,
  });
  // The middle of the switch, never `setChecked` — the dead zone this project
  // has already paid for once (`mobile-switches.spec.ts`).
  if (!(await toggle.isChecked())) {
    await toggle.click();
  }
  await expect(toggle).toBeChecked();

  await page.getByLabel('Host').fill('127.0.0.1');
  await page.getByLabel('Port').fill(String(options.port));
  await page.getByLabel('Absenderadresse').fill(options.from);

  /*
   * „Implizites TLS" is **on** in a fresh block — right for a mail server on
   * the network, wrong for a recipient on loopback. It is switched off through
   * its own switch, not bypassed.
   */
  const tls = page.getByRole('switch', {
    name: 'Implizites TLS (smtps)',
    exact: true,
  });
  if (await tls.isChecked()) {
    await tls.click();
  }
  await expect(tls).not.toBeChecked();

  await page.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expectSaved(page);

  // The round trip over the real route, not the typed draft.
  await page.reload();
  await expect(page.getByLabel('Port')).toHaveValue(String(options.port));
}
