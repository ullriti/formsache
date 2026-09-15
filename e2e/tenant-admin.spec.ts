import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  addQuestion,
  expectDashboard,
  expectLoginView,
  expectNoHorizontalScroll,
  expectSaved,
  invitePersonAndSetPassword,
  mailPlainText,
  mailQueueTestTimeout,
  newForm,
  publishAndReadPath,
  redeemInvitation,
  saveForm,
  submitLogin,
  waitForInvitationLink,
} from './app-flows';
import { webBaseUrl } from './env';
import { readInstanceMail } from './instance-mail';
import { CROP_SAMPLE_PNG_BASE64 } from './sample-image';
import {
  authStateFile,
  seedTenantAdmin,
  tenantAdminStateFile,
} from './seed-account';

/**
 * Tenant administration in a real browser: six things only a browser can decide.
 *
 * What is here is deliberately only what a browser can decide. The wire
 * contract, the guard chain and every refusal have integration tests of their
 * own (`apps/api/test/tenant-admin/…`); the six things below have none, and
 * cannot:
 *
 * 1. whether a switch, a pill and a Logo tile really change state when the
 *    **middle** of the control is clicked — the dead zone, in which a
 *    decoration covered 18 of a switch's 42 px and no test had ever clicked
 *    one, because `setChecked()` does not click at all;
 * 2. whether a saved colour actually reaches the header bar and the stripe of
 *    the running application, rather than only the row it was written to;
 * 3. whether the Logo chooser offers **no** file dialog — absent rather than
 *    disabled (a control that does nothing still promises a function);
 * 4. whether a permission taken away in the group editor bites an **already
 *    open** session without a new login (the evidence — the one genuinely new
 *    proof of that behaviour, everything else about the five flags is
 *    regression);
 * 5. whether revoking one person's access to *one* form closes the responses,
 *    the detail **and** the CSV export for them while leaving every other form
 *    alone (the evidence);
 * 6. whether the form then disappears from their list, rather than merely
 *    answering 404 when addressed.
 *
 * **The whole file runs serially and in the desktop project only.** Every case
 * writes shared state of one organisation — its branding row, its groups, its members —
 * and Musterstadt is that organisation throughout: the Dachorganisation is the organisation every other parked
 * session is scoped to, and repainting *its* header mid-run would change what
 * half the suite is looking at. The one thing this file does **not** touch is
 * Musterstadt' `form_defaults`, which belongs to a case in
 * `system-settings.spec.ts`.
 *
 * **What it leaves behind, deliberately:** one `user` row per run. Removing a
 * membership is not deleting a person, and there is
 * no way to delete one at all — so the account this file creates stays, without
 * a membership anywhere and therefore without reach into any Organisation. The
 * *group*, which would otherwise pile up and eventually collide on rank, is
 * removed by the cleanup at the end, and that cleanup asserts rather than
 * checks.
 */

/**
 * Minimal browser globals for the `evaluate` callbacks below — the same reason
 * `app-flows.ts` declares its own: the root `tsconfig.json` that covers `e2e/`
 * deliberately has no DOM lib, and pulling `lib.dom` in would put the browser's
 * `fetch`, `URL` and friends next to the Node ones for every file in this
 * project. Only the members actually used are declared, and only here.
 */
interface ComputedStyle {
  readonly backgroundColor: string;
  readonly backgroundImage: string;
  getPropertyValue: (property: string) => string;
}
declare function getComputedStyle(element: unknown): ComputedStyle;

/** Only what the focus assertion below reads. */
interface MinimalElement {
  closest: (selector: string) => unknown;
}
interface MinimalCanvas {
  width: number;
  height: number;
  getContext: (kind: string) => {
    drawImage: (source: never, x: number, y: number) => void;
    getImageData: (
      x: number,
      y: number,
      w: number,
      h: number,
    ) => { readonly data: readonly number[] };
  } | null;
}
declare const document: {
  readonly activeElement: MinimalElement | null;
  readonly body: unknown;
  createElement: (tag: string) => MinimalCanvas;
};

test.describe.configure({ mode: 'serial' });

const TENANT_APPEARANCE_PATH = '/admin/appearance';
const TENANT_MEMBERS_PATH = '/admin/members';

/** A colour no seed uses, so „it followed" cannot be a coincidence. */
const PROBE_COLOR = '#0b5d1e';

/**
 * The password of the person this file creates for itself.
 *
 * Derived rather than invented, exactly like `wrongPassword` in
 * `seed-account.ts`: a literal here would be a password committed into the
 * repository, and a derived one is long enough to pass `USER_PASSWORD_MIN` on
 * any machine whose seed password already does.
 */
const PERSON_PASSWORD = `${seedTenantAdmin.password}-e2e-person`;

/**
 * **The link into the system in a mail that was really delivered** (ADR-0027).
 *
 * ## The gap this closes
 *
 * `apps/api/src/mail/queued-body-renderer.spec.ts` proves the rule at
 * unit level in four cases — which of the two base addresses hangs on which
 * identity, and that a system mail gets no Organisation details into the
 * shell. What **no** case of the suite did until 2026-08-19: read a
 * body that really went out over SMTP. Between the
 * renderer and the mailbox lie the worker, the transport and the
 * MIME encoding; a footer that got lost there would be visible in no
 * unit test.
 *
 * ## Why exactly here
 *
 * Because at this place a mail is delivered **and already read**
 * anyway: the case waits for the invitation and cuts the link out of it, so
 * the body is already there and costs no second delivery.
 *
 * And because it is a **system mail**, and thereby the sharper half of the
 * rule. The alternative would be an Organisation mail (confirmation, message
 * to the office) — that one goes in this suite over the mail server of the
 * *Organisation*, and neither the Dachorganisation nor Musterstadt has one:
 * after ADR-0023 their post stays lying in the queue and never reaches a
 * catcher. The two acceptance runs do deliver such mails, but they point the
 * instance mail server at **their own** catchers for that and therefore read
 * `systemCatcher.messages` instead of `readInstanceMail()` — there the same
 * assurance would be tied to a run that runs last and alone anyway.
 *
 * ## What is demanded, and why in one piece
 *
 * The two lines stand as **one** string in the expectation, because
 * precisely their connection is the statement:
 *
 * - no name of an Organisation before „Diese E-Mail wurde automatisch
 *   erzeugt." — ADR-0027 §2a expressly takes it away from a system mail, and
 *   an assurance that only checked the link would be green with it too;
 * - the caption „Zu Formsache" and not „Formulare von „…"" — it follows
 *   the address and is no parameter of its own (§4);
 * - the address of the **installation** and not that of an Organisation (§2);
 * - the URL at the end of the line, behind a colon, without punctuation
 *   after it (§4) — the `\n` at the end of the expected string is exactly
 *   that promise.
 *
 * On top of that the HTML half, because „die Textfassung ist die Hälfte, die
 * vergessen wird" (ADR-0026) holds in both directions here: `wrapMailBody`
 * creates both versions at one place, and a case that reads only one does not
 * notice the fall back to two ways.
 *
 * ## Reproduction
 *
 * In `QueuedBodyRenderer.shellFor` swap `installationBaseUrl()` for
 * `resolveBaseUrl(tenantId)` (the rejected alternative from
 * ADR-0027) — or do not set the `link` at all. Both turn this call
 * red; no other case of **this** suite notices it.
 *
 * @param email The address that was delivered to.
 * @param after The count of the inbox **before** the trigger.
 */
function expectSystemMailFooter(email: string, after: number): void {
  const delivered = readInstanceMail()
    .slice(after)
    .filter((message) => message.to.includes(email));
  expect(
    delivered.length,
    `Es liegt keine zugestellte Mail an ${email} vor. Die Wartekante oben hat ` +
      'gerade eine gefunden — kommt hier keine an, lesen die beiden ' +
      'verschiedene Postfächer.',
  ).toBeGreaterThan(0);

  /*
    The **youngest**, for the same reason `waitForInvitationLink` takes it:
    „Einladung erneut senden" creates a second one, and the older then belongs
    to a different operation.

    `\r\n` → `\n`, because the transport canonicalises the line endings
    (RFC 5321) and `mailPlainText` only unpacks the transfer encoding, not the
    line endings. Without this line the expectation measures a property of
    SMTP instead of one of the application.
  */
  const body = mailPlainText(
    delivered[delivered.length - 1]?.data ?? '',
  ).replace(/\r\n/gu, '\n');

  expect(
    body,
    'Die Fußzeile der Klartextfassung stimmt nicht. Erwartet sind zwei ' +
      'Zeilen: der Satz ohne einen Organisationsnamen davor (eine Systemmail ' +
      'trägt keinen, ADR-0027 §2a) und darunter „Zu Formsache: " mit der ' +
      'Basis-Adresse der **Installation** am Zeilenende.',
  ).toContain(
    `\nDiese E-Mail wurde automatisch erzeugt.\nZu Formsache: ${webBaseUrl}\n`,
  );

  expect(
    body,
    'Die HTML-Fassung trägt den Link nicht. `wrapMailBody` legt beide ' +
      'Fassungen an einer Stelle an — steht er nur im Klartext, ist der Weg ' +
      'wieder zweigeteilt.',
  ).toContain(`<a href="${webBaseUrl}"`);
  expect(
    body,
    'Die Aufschrift des Ankers stimmt nicht. Sie folgt der Adresse und ist ' +
      'kein eigener Parameter (ADR-0027 §4): zur Installation heißt sie ' +
      '„Zu Formsache", zu einer Organisation „Formulare von „…"".',
  ).toContain('>Zu Formsache</a>');
}

/** `#rrggbb` as the browser reports it — `getComputedStyle` never gives hex. */
function rgbOf(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const red = (value >> 16) & 0xff;
  const green = (value >> 8) & 0xff;
  const blue = value & 0xff;
  return `rgb(${String(red)}, ${String(green)}, ${String(blue)})`;
}

/** Reads a property off foreign JSON without asserting a shape onto it. */
function property(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

/**
 * The accent colour of the organisation the given session is scoped to, straight from
 * the server.
 *
 * Read rather than written down, like `activeTenantName()` in `app-flows.ts`:
 * a constant here would keep passing after the seed changed its colours, and
 * the whole point of the public case below is a comparison between two organisations
 * that are what the database says they are.
 */
async function activeTenantAccent(page: Page): Promise<string> {
  const response = await page.request.get('/api/auth/me');
  expect(response.status()).toBe(200);
  const body: unknown = await response.json();
  const activeId = property(body, 'activeTenantId');

  const memberships: readonly unknown[] = Array.isArray(
    property(body, 'memberships'),
  )
    ? (property(body, 'memberships') as readonly unknown[])
    : [];

  for (const membership of memberships) {
    const tenant = property(membership, 'tenant');
    if (property(tenant, 'id') !== activeId) {
      continue;
    }
    const accent = property(property(tenant, 'branding'), 'accent');
    if (typeof accent === 'string' && accent !== '') {
      return accent;
    }
  }

  throw new Error(
    '[e2e] GET /api/auth/me carried no accent for the active Organisation.',
  );
}

/** The saving control of a card — every one of them says „Speichern". */
async function save(scope: Locator): Promise<void> {
  await scope.getByRole('button', { name: 'Speichern', exact: true }).click();
  // Not „the button is disabled": that is true while the PUT is in flight, and
  // the test right below then asked the *person's* open session whether the
  // permission was gone before the admin's write had landed — a 200 against a
  // case that demands 403. See `expectSaved` for the measurement.
  await expectSaved(scope);
}

/**
 * The colour half's own save bar.
 *
 * Scoped, because the *Erscheinungsbild*-tab carries **two** documents with two
 * saves: the colours and the OIDC block below them (`TenantAppearanceTab`
 * explains why they are not one form — two controllers, two permissions). An
 * unscoped „Speichern" resolves to both, and *which* of them it finds first
 * depends on whether the OIDC query has answered yet — a race that would show
 * up as an occasional strict-mode failure rather than as anything about the
 * application.
 *
 * The scope is a class, and it has to be: the save bar is a row of controls
 * with no landmark of its own, and the two documents are told apart by which
 * card they sit in rather than by anything a role query can see.
 */
function brandingSave(page: Page): Locator {
  return page.locator('.tenant-admin__tab > .settings__actions');
}

test.describe('Erscheinungsbild & Login', () => {
  test.use({ storageState: tenantAdminStateFile });

  test('eine gespeicherte Farbe erreicht Kopfzeile und Streifen, und das Logo ist eine Auswahl neben dem Upload', async ({
    page,
  }) => {
    await page.goto(TENANT_APPEARANCE_PATH);
    await expect(
      page.getByRole('heading', { name: 'Organisations-Verwaltung', level: 1 }),
    ).toBeVisible();
    await expect(
      page
        .getByRole('navigation', { name: 'Organisations-Verwaltung' })
        .getByRole('button', { name: 'Erscheinungsbild & Login' }),
    ).toHaveAttribute('aria-current', 'page');

    /*
     * **The field is there and operable.** A disabled file field would
     * promise an editor an upload that does not exist — which is why
     * the assurance aims at **present and enabled**, not at absence.
     *
     * The one selector in this file that names no role: „a
     * file dialogue" is a property of the *element type*, and no role
     * names it.
     */
    const picker = page.locator('input[type="file"]');
    await expect(picker).toHaveCount(1);
    await expect(picker).toBeEnabled();

    /*
      --- the Logo tile really takes a click in its middle -------------------

      **The chooser group is called „Logo"** (finding 8): neither its name nor
      that of the tiles or of the button in the crop dialogue presupposes a
      particular kind of Organisation — the application is for every one.
    */
    const logoGroup = page.getByRole('radiogroup', { name: 'Logo' });
    const tiles = logoGroup.getByRole('radio');
    const tileCount = await tiles.count();
    expect(
      tileCount,
      'The chooser must offer „Kein Logo" plus the shipped assets — with ' +
        'one entry there is nothing to choose and nothing to prove. **The ' +
        'upload does not replace this list** : an organisation ' +
        'without its own Logo must not fall into a hole.',
    ).toBeGreaterThan(1);

    const none = logoGroup.getByRole('radio', { name: 'Kein Logo' });
    const chosen = await none.isChecked();
    const other = tiles.nth(tileCount - 1);

    /*
     * `.click()`, never `.check()`/`.setChecked()`: those skip the pointer
     * entirely and stay green when a decoration covers the control — the same
     * defect. Playwright's click targets the centre of the box **and** verifies
     * that the point receives the event, which is exactly the missing half.
     */
    if (chosen) {
      await other.click();
      await expect(other).toBeChecked();
      await none.click();
      await expect(none).toBeChecked();
    } else {
      await none.click();
      await expect(none).toBeChecked();
      await other.click();
      await expect(other).toBeChecked();
    }

    // --- a colour reaches the header bar and the stripe --------------------
    const headerField = page.getByLabel('Kopfzeilen-Hintergrund');
    const originalHeader = await headerField.inputValue();
    const accentField = page.getByLabel('Akzent (Buttons, Fortschritt)');
    const originalAccent = await accentField.inputValue();
    /*
     * The stripe is painted from the **stripe colours**, not from the accent:
     * changing the accent and expecting the band to follow measured the wrong
     * axis, and the stripe dutifully kept the seed's red.
     *
     * **The stripe is maintained directly** (finding 8): filling this
     * field *is* the maintenance, no button copies values out of a second
     * source.
     *
     * The name of the field carries the total along („1 von 3"), because a
     * stripe colour has no identity other than its position. Three is the
     * shipped length (`DEFAULT_TENANT_BRANDING`), and this case does not
     * change it.
     */
    const stripeField = page.getByLabel('Streifenfarbe 1 von 3');
    const originalStripe = await stripeField.inputValue();

    const banner = page.getByRole('banner');
    const backgroundOf = async (): Promise<string> =>
      banner.evaluate((element) => getComputedStyle(element).backgroundColor);

    expect(
      await backgroundOf(),
      'Before anything is changed the header already has to carry *this* ' +
        'Organisation’s colour. If it does not, the tenant axes never reach the ' +
        'semantic tokens and every assertion below would be measuring the ' +
        ':root defaults.',
    ).toBe(rgbOf(originalHeader));

    try {
      await headerField.fill(PROBE_COLOR);
      await accentField.fill(PROBE_COLOR);
      await stripeField.fill(PROBE_COLOR);
      await save(brandingSave(page));

      // The header bar of the running application, not the preview next to the
      // fields: the preview would follow a draft that was never saved.
      await expect
        .poll(backgroundOf, {
          message:
            'The saved Kopfzeilen-Hintergrund must repaint the header bar ' +
            'itself — the session query is invalidated on ' +
            'save precisely so this does not need a reload.',
        })
        .toBe(rgbOf(PROBE_COLOR));

      /*
       * The stripe under the bar. It carries no role — it is a decorative band
       * — so it is addressed by its class, and the assertion reads the gradient
       * the tenant axes produced rather than the class itself.
       */
      const stripe = await page
        .locator('.app-header__stripe')
        .evaluate((element) => getComputedStyle(element).backgroundImage);
      expect(
        stripe,
        'The stripe is painted from `--gradient-stripe`, which the ' +
          'branding save overrides — a stripe that kept the seed colours ' +
          'would mean the axes never reached the shell.',
      ).toContain(rgbOf(PROBE_COLOR));

      await expectNoHorizontalScroll(page, 'Erscheinungsbild & Login');
    } finally {
      // Shared state of the development database: another organisation's colours are
      // nobody's business, but this organisation's are the starting point of every
      // later run.
      await page.goto(TENANT_APPEARANCE_PATH);
      await page.getByLabel('Kopfzeilen-Hintergrund').fill(originalHeader);
      await page
        .getByLabel('Akzent (Buttons, Fortschritt)')
        .fill(originalAccent);
      await page.getByLabel('Streifenfarbe 1 von 3').fill(originalStripe);
      await save(brandingSave(page));
    }
  });

  /**
   * **The proof: upload → public,
   * session-less page → the picture is really there.**
   *
   * Both reviews named the same gap, and it is the kind of
   * gap this project tests against on purpose: the integration measures
   * that the payload carries `{kind:'upload'}` and that the byte route answers
   * 200; a jsdom test measures that *one* such payload produces the right
   * `src` — with a **hand-built** fixture. Between the two lies exactly
   * the seam at which a branding fault of this project once sat.
   *
   * Here the same browser uploads and then fetches the public page in
   * a context **without any session**, and the assurance is `naturalWidth`
   * — the number the browser only knows once it has loaded the bytes and
   * decoded them as an image. An `src` attribute pointing into nothing, a wrong
   * `Content-Type` or a `nosniff` that discards the type are thereby all
   * red instead of green.
   */
  test('ein hochgeladenes Logo wird auf der öffentlichen Seite wirklich geladen', async ({
    page,
    browser,
  }) => {
    const title = await newForm(page, 'Logo öffentlich');
    await addQuestion(page, 'Text', 'Name');
    await saveForm(page);
    const publicPath = await publishAndReadPath(page);
    expect(title).not.toBe('');

    await page.goto(TENANT_APPEARANCE_PATH);
    const picker = page.locator('input[type="file"]');
    await expect(picker).toBeEnabled();

    // 400 × 400, left half red and right half blue. The server decides the
    // type from the content, so a file that only *says* PNG would be refused —
    // which is the point of the allow list and not this case's business.
    await picker.setInputFiles({
      name: 'Logo.png',
      mimeType: 'image/png',
      buffer: Buffer.from(HALVES_PNG_BASE64, 'base64'),
    });

    /*
     * „Ausschnitt wählen"  sits between the pick and the
     * request: nothing goes to the server until the frame is confirmed, and the
     * frame opens around the whole picture, so this is one click and cuts
     * nothing. What travels is therefore the crop's **PNG**, which is why the
     * `naturalWidth` assertion further down still means what it always meant.
     */
    const crop = page.getByRole('dialog', { name: 'Ausschnitt wählen' });
    await expect(crop).toBeVisible();

    /*
     * **The frame is moved onto the blue half**, and that is what turns this
     * case into a proof about pixels: with the whole picture selected, a
     * swapped source rectangle in `render-crop.ts` would deliver the same image.
     *
     * By keystroke rather than by pointer, because the steps are exact: shift +
     * arrow resizes by 2 % of 400 px = 8 px, a plain arrow moves by the same.
     * Twenty-five of each leave a 200 × 400 frame at x = 200 — the blue half,
     * to the pixel, and the readout below says so before anything is uploaded.
     */
    const readout = crop.locator('.logo-crop__readout');
    const frame = crop.getByRole('group', { name: 'Bildausschnitt' });
    await frame.focus();
    for (let step = 0; step < 25; step += 1) {
      await page.keyboard.press('Shift+ArrowLeft');
    }
    for (let step = 0; step < 25; step += 1) {
      await page.keyboard.press('ArrowRight');
    }
    await expect(readout).toHaveText(
      'Ausschnitt 200 × 400 Pixel, linke obere Ecke bei 200, 0.',
    );

    await crop.getByRole('button', { name: 'Logo übernehmen' }).click();
    await expect(crop).toBeHidden();

    // The tile appears once the upload has answered, and it is the chosen one.
    const own = page
      .getByRole('radiogroup', { name: 'Logo' })
      .getByRole('radio', { name: /Eigenes Logo/u });
    await expect(own).toBeChecked({ timeout: 15_000 });

    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);
      // `data-testid`, not a role: the mark carries `alt=""` on purpose — the
      // organisation's name stands next to it, and an alt text would have a screen
      // reader read it twice. A decorative image has no `img` role.
      const crest = guest.getByTestId('public-tenant-logo');
      await expect(crest).toBeVisible();

      // **Loaded, not merely linked.** `naturalWidth` stays 0 as long as the
      // browser has not decoded the bytes as an image.
      await expect
        .poll(async () =>
          crest.evaluate(
            (element) =>
              (element as unknown as { naturalWidth: number }).naturalWidth,
          ),
        )
        .toBeGreaterThan(0);

      /*
       * **And they are the right pixels.** The crop was 200 × 400 of the blue
       * half; the longest edge is under 768, so nothing is scaled up (that is
       * the promise, not an accident) and the delivered image is 200 × 400.
       * Its middle is blue — a swapped source rectangle would deliver red here,
       * and until an earlier review nothing in this project would have noticed.
       *
       * Same origin, so the canvas is not tainted and `getImageData` answers.
       */
      const delivered = await crest.evaluate((element) => {
        const image = element as unknown as {
          naturalWidth: number;
          naturalHeight: number;
        };
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d');
        if (context === null) {
          return null;
        }
        context.drawImage(element as never, 0, 0);
        const middle = context.getImageData(
          Math.floor(image.naturalWidth / 2),
          Math.floor(image.naturalHeight / 2),
          1,
          1,
        ).data;
        return {
          width: image.naturalWidth,
          height: image.naturalHeight,
          red: middle[0] ?? -1,
          blue: middle[2] ?? -1,
        };
      });

      expect(delivered).not.toBeNull();
      expect(delivered?.width).toBe(200);
      expect(delivered?.height).toBe(400);
      expect(
        delivered?.blue,
        'The section chosen was the blue half; a red pixel here means the ' +
          'crop rectangle never reached the canvas.',
      ).toBeGreaterThan(150);
      expect(delivered?.red).toBeLessThan(100);

      const source = await crest.getAttribute('src');
      expect(source).toMatch(/^\/api\/public\/files\/[A-Za-z0-9_-]+$/u);
    } finally {
      await guestContext.close();
      // Shared development database: the next run starts from the shipped
      // choice, exactly as the colour case above puts its axes back.
      await page.goto(TENANT_APPEARANCE_PATH);
      await page
        .getByRole('radiogroup', { name: 'Logo' })
        .getByRole('radio', { name: 'Kein Logo' })
        .click();
      await save(brandingSave(page));
    }
  });

  /**
   * „Ausschnitt wählen" — the frame as a **control** .
   *
   * Two things only a browser decides:
   *
   * 1. **The accessible name.** Testing Library reads an `aria-label` and is
   *    satisfied; the browser concatenates what it finds. In exactly this
   *    package two such names have already been noticed („Nachweis Datei auswählen
   *    Erlaubt: …"), and `toHaveAccessibleName` is the only measurement that
   *    sees it — jsdom does not see it.
   * 2. **The pointer gesture.** It needs a layout: in jsdom every
   *    `getBoundingClientRect()` is zero, so not a single pixel of
   *    displacement is measurable there.
   *
   * This check **saves nothing** — it cancels the dialogue so that in
   * this serial file it leaves no further Logo upload behind.
   */
  test('der Ausschnittsrahmen hat einen Namen und lässt sich mit der Maus ziehen', async ({
    page,
  }) => {
    await page.goto(TENANT_APPEARANCE_PATH);
    const picker = page.locator('input[type="file"]');
    await expect(picker).toBeEnabled();

    // 400 × 400, so the frame has an area in which a drag is measurable.
    await picker.setInputFiles({
      name: 'Zuschnitt.png',
      mimeType: 'image/png',
      buffer: Buffer.from(CROP_SAMPLE_PNG_BASE64, 'base64'),
    });

    const dialog = page.getByRole('dialog', { name: 'Ausschnitt wählen' });
    await expect(dialog).toBeVisible();

    const frame = dialog.getByRole('group', { name: 'Bildausschnitt' });
    await expect(frame).toBeVisible();

    // --- trap 3: the name as the browser builds it -----------------------
    await expect(
      frame,
      'The crop frame is a control. Its accessible name must be exactly ' +
        '„Bildausschnitt" — a browser concatenates every labelling source it ' +
        'finds, and a description leaking into the name is the defect this ' +
        'assertion exists for.',
    ).toHaveAccessibleName('Bildausschnitt');
    await expect(
      dialog.getByRole('button', { name: 'Logo übernehmen' }),
    ).toHaveAccessibleName('Logo übernehmen');
    await expect(
      dialog.getByRole('button', { name: 'Ganzes Bild' }),
    ).toHaveAccessibleName('Ganzes Bild');

    // --- the keyboard operates the same frame -----------------------------
    const readout = dialog.locator('.logo-crop__readout');
    await expect(readout).toHaveText(
      'Ausschnitt 400 × 400 Pixel, linke obere Ecke bei 0, 0.',
    );

    await frame.focus();
    await expect(frame).toBeFocused();
    // Shift + arrow shrinks (step: 2 % of 400 px = 8 px per axis).
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('Shift+ArrowUp');
    await expect(readout).toHaveText(
      'Ausschnitt 392 × 392 Pixel, linke obere Ecke bei 0, 0.',
    );
    // And the arrow alone moves it — which did not work before, because the
    // frame filled the whole picture.
    await page.keyboard.press('ArrowRight');
    await expect(readout).toHaveText(
      'Ausschnitt 392 × 392 Pixel, linke obere Ecke bei 8, 0.',
    );

    // --- and the same gesture with the pointer -----------------------------
    const box = await frame.boundingBox();
    expect(box, 'The crop frame has no layout box.').not.toBeNull();
    if (box !== null) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      // To the upper left beyond the edge: the frame stays inside the picture
      // and keeps its size (`moveCrop` clamps, it does not shrink).
      await page.mouse.move(box.x - 200, box.y - 200, { steps: 8 });
      await page.mouse.up();
    }
    await expect(readout).toHaveText(
      'Ausschnitt 392 × 392 Pixel, linke obere Ecke bei 0, 0.',
    );

    // Nothing saved, nothing uploaded.
    await dialog.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(dialog).toBeHidden();
  });

  /**
   * **The focus is not lost on confirming** (an earlier review).
   *
   * `useFocusTrap` gives the focus back to the element that was focused when
   * the dialogue opened — here the file picker. But confirming starts the
   * upload, and that **disables** it: `focus()` on a disabled control has no
   * effect in the browser, the focus falls to `<body>`, and the next `Tab`
   * starts at the top of the page. **jsdom focuses it all the same**, so no
   * component test can see it — this case is the only place where it is
   * measurable.
   *
   * *Reproduction:* leave `fallbackRef` off the dialogue → the focus lies on
   * `body` and this case is red.
   */
  test('nach dem Bestätigen liegt der Fokus im Logo-Feld, nicht auf body', async ({
    page,
  }) => {
    await page.goto(TENANT_APPEARANCE_PATH);
    const picker = page.locator('input[type="file"]');
    await picker.setInputFiles({
      name: 'Fokus.png',
      mimeType: 'image/png',
      buffer: Buffer.from(CROP_SAMPLE_PNG_BASE64, 'base64'),
    });

    const dialog = page.getByRole('dialog', { name: 'Ausschnitt wählen' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Logo übernehmen' }).click();
    await expect(dialog).toBeHidden();

    // The focus stands in the field carrying the upload state — not nowhere.
    const inField = await page.evaluate(() => {
      const active = document.activeElement;
      return (
        active !== null &&
        active !== document.body &&
        active.closest('.setting__field') !== null
      );
    });
    expect(
      inField,
      'After confirming, focus must stay in the Logo field: the picker it ' +
        'came from is disabled by the upload, and a disabled control refuses ' +
        'focus.',
    ).toBe(true);

    // Clean-up: the Organisation starts with the shipped Logo again.
    await expect(
      page
        .getByRole('radiogroup', { name: 'Logo' })
        .getByRole('radio', { name: /Eigenes Logo/u }),
    ).toBeChecked({ timeout: 15_000 });
    await page
      .getByRole('radiogroup', { name: 'Logo' })
      .getByRole('radio', { name: 'Kein Logo' })
      .click();
    await save(brandingSave(page));
  });
});

/**
 * 400 × 400: the left half red, the right half blue.
 *
 * Two fields rather than one flat colour, because a flat sample cannot tell
 * „the right section arrived" from „any section arrived" — and until an
 * earlier review nothing measured the crop on real pixels at all: the unit
 * test runs against a stubbed canvas, and the case below used to upload a
 * 1 × 1 image, in which a swapped source/destination rectangle or a missing
 * scale-down would both stay green.
 */
const HALVES_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAZAAAAGQCAIAAAAP3aGbAAAF4klEQVR42u3UQQ0A' +
  'AAjEMEScCPzrQQwm4NekFraaBM6lB86VtDAsDAvDAsPCsDAsMCwMC8MCw8KwMCww' +
  'LAwLwwLDwrAwLDAsDAvDAsPCsDAsMCwMC8MCw8KwMCwwLAwLwwLDwrAwLDAsDAvD' +
  'AsPCsDAsMCwMC8MCw8KwMCwwLAwLwwLDwrAwLDAsDAvDwrDUhWFhWBgWGBaGhWGB' +
  'YWFYGBYYFoaFYYFhYVgYFhgWhoVhgWFhWBgWGBaGhWGBYWFYGBYYFoaFYYFhYVgY' +
  'FhgWhoVhgWFhWBgWGBaGhWGBYWFYGBYYFoaFYYFhYVgYFhgWhoVhgWFhWBgWhqUu' +
  'DAvDwrDAsDAsDAsMC8PCsMCwMCwMCwwLw8KwwLAwLAwLDAvDwrDAsDAsDAsMC8PC' +
  'sMCwMCwMCwwLw8KwwLAwLAwLDAvDwrDAsDAsDAsMC8PCsMCwMCwMCwwLw8KwwLAw' +
  'LAwLDAvDwrAwLDAsDAvDAsPCsDAsMCwMC8MCw8KwMCwwLAwLwwLDwrAwLDAsDAvD' +
  'AsPCsDAsMCwMC8MCw8KwMCwwLAwLwwLDwrAwLDAsDAvDAsPCsDAsMCwMC8MCw8Kw' +
  'MCwwLAwLwwLDwrAwLJAWhoVhYVhgWBgWhgWGhWFhWGBYGBaGBYaFYWFYYFgYFoYF' +
  'hoVhYVhgWBgWhgWGhWFhWGBYGBaGBYaFYWFYYFgYFoYFhoVhYVhgWBgWhgWGhWFh' +
  'WGBYGBaGBYaFYWFYYFgYFoYFhoVhYVgYlrowLAwLwwLDwrAwLDAsDAvDAsPCsDAs' +
  'MCwMC8MCw8KwMCwwLAwLwwLDwrAwLDAsDAvDAsPCsDAsMCwMC8MCw8KwMCwwLAwL' +
  'wwLDwrAwLDAsDAvDAsPCsDAsMCwMC8MCw8KwMCwwLAwLw8Kw1IVhYVgYFhgWhoVh' +
  'gWFhWBgWGBaGhWGBYWFYGBYYFoaFYYFhYVgYFhgWhoVhgWFhWBgWGBaGhWGBYWFY' +
  'GBYYFoaFYYFhYVgYFhgWhoVhgWFhWBgWGBaGhWGBYWFYGBYYFoaFYYFhYVgYFoYF' +
  'hoVhYVhgWBgWhgWGhWFhWGBYGBaGBYaFYWFYYFgYFoYFhoVhYVhgWBgWhgWGhWFh' +
  'WGBYGBaGBYaFYWFYYFgYFoYFhoVhYVhgWBgWhgWGhWFhWGBYGBaGBYaFYWFYYFgY' +
  'FoYFhoVhYVgYFhgWhoVhgWFhWBgWGBaGhWGBYWFYGBYYFoaFYYFhYVgYFhgWhoVh' +
  'gWFhWBgWGBaGhWGBYWFYGBYYFoaFYYFhYVgYFhgWhoVhgWFhWBgWGBaGhWGBYWFY' +
  'GBYYFoaFYYFhYVgYFoYlLQwLw8KwwLAwLAwLDAvDwrDAsDAsDAsMC8PCsMCwMCwM' +
  'CwwLw8KwwLAwLAwLDAvDwrDAsDAsDAsMC8PCsMCwMCwMCwwLw8KwwLAwLAwLDAvD' +
  'wrDAsDAsDAsMC8PCsMCwMCwMCwwLw8KwMCx1YVgYFoYFhoVhYVhgWBgWhgWGhWFh' +
  'WGBYGBaGBYaFYWFYYFgYFoYFhoVhYVhgWBgWhgWGhWFhWGBYGBaGBYaFYWFYYFgY' +
  'FoYFhoVhYVhgWBgWhgWGhWFhWGBYGBaGBYaFYWFYYFgYFoaFYakLw8KwMCwwLAwL' +
  'wwLDwrAwLDAsDAvDAsPCsDAsMCwMC8MCw8KwMCwwLAwLwwLDwrAwLDAsDAvDAsPC' +
  'sDAsMCwMC8MCw8KwMCwwLAwLwwLDwrAwLDAsDAvDAsPCsDAsMCwMC8MCw8KwMCwM' +
  'CwwLw8KwwLAwLAwLDAvDwrDAsDAsDAsMC8PCsMCwMCwMCwwLw8KwwLAwLAwLDAvD' +
  'wrDAsDAsDAsMC8PCsMCwMCwMCwwLw8KwwLAwLAwLDAvDwrDAsDAsDAsMC8PCsMCw' +
  'MCwMC6SFYWFYGBYYFoaFYYFhYVgYFhgWhoVhgWFhWBgWGBaGhWGBYWFYGBYYFoaF' +
  'YYFhYVgYFhgWhoVhgWFhWBgWGBaGhWGBYWFYGBYYFoaFYYFhYVgYFhgWhoVhgWFh' +
  'WBgWGBafFqq+VJ5FFFnIAAAAAElFTkSuQmCC';

test.describe('Öffentliche Farben — der Fall, den ein angemeldeter Tester nie sieht', () => {
  test('die öffentliche Ausfüllansicht trägt die Farben der Organisation des Formulars, auch für eine Sitzung einer anderen Organisation', async ({
    browser,
  }) => {
    const tenantContext = await browser.newContext({
      storageState: tenantAdminStateFile,
    });
    const tenantPage = await tenantContext.newPage();
    const foreignContext = await browser.newContext({
      storageState: authStateFile,
    });
    const foreignPage = await foreignContext.newPage();

    try {
      await tenantPage.goto('/');
      await expectDashboard(tenantPage);
      const formAccent = await activeTenantAccent(tenantPage);

      await newForm(tenantPage, 'Farben der Organisation');
      await addQuestion(tenantPage, 'Text', 'Name');
      await saveForm(tenantPage);
      const path = await publishAndReadPath(tenantPage);

      // The positive control: this second session really is scoped to a
      // *different* Organisation. Without it, „the colours were B's" would also hold
      // if both Organisationen happened to share an accent.
      await foreignPage.goto('/');
      await expectDashboard(foreignPage);
      const sessionAccent = await activeTenantAccent(foreignPage);
      expect(
        sessionAccent,
        'The two seeded Organisationen must differ in their accent, or this case ' +
          'cannot tell „aus der Organisation des Formulars" from „aus der Organisation der ' +
          'Sitzung" at all.',
      ).not.toBe(formAccent);

      await foreignPage.goto(path);
      await expect(
        foreignPage.getByRole('heading', { level: 1 }),
      ).toBeVisible();

      // The axis itself…
      const axis = await foreignPage
        .getByRole('main')
        .evaluate((element) =>
          getComputedStyle(element).getPropertyValue('--tenant-accent').trim(),
        );
      expect(
        axis,
        'The fill-in view is themed from the organisation of the **form**, never from ' +
          'the organisation of whoever happens to be signed in.',
      ).toBe(formAccent);
      expect(axis).not.toBe(sessionAccent);

      // …and a colour that is actually painted from it, so the assertion is
      // about the rendered page rather than about a custom property nothing
      // resolves against.
      const submit = await foreignPage
        .getByRole('button', { name: 'Absenden' })
        .evaluate((element) => getComputedStyle(element).backgroundImage);
      expect(submit).toContain(rgbOf(formAccent));
      expect(submit).not.toContain(rgbOf(sessionAccent));
    } finally {
      await tenantContext.close();
      await foreignContext.close();
    }
  });
});

test.describe('Gruppen, Personen und Formularrechte', () => {
  /**
   * One fixture, one chain, one test — on purpose.
   *
   * The group, the person and the two forms only mean anything together: „ein
   * entzogenes Recht wirkt ohne neue Anmeldung" needs a session that is already
   * open when the right goes away, and that session belongs to a person this
   * test creates and removes again. Split across four tests, each would have to
   * rebuild the other three's fixture or depend on their order — and the
   * person's login would be spent four times against a budget of ten a minute.
   */
  test('ein entzogenes Gruppenrecht und ein entzogener Formularzugriff wirken sofort in einer offenen Sitzung', async ({
    browser,
  }) => {
    /*
      **A time budget instead of Playwright's 30 s** — this case waits once
      on the mail queue (`invitePersonAndSetPassword`), and the worker
      runs on a 15-second beat. The arithmetic stands at `mailQueueTestTimeout`.
    */
    test.setTimeout(mailQueueTestTimeout(1));

    const stamp = Date.now().toString(36);
    const groupName = `E2E-Rolle ${stamp}`;
    const personName = `E2E Person ${stamp}`;
    const personEmail = `e2e-person-${stamp}@musterstadt.example`;

    const adminContext = await browser.newContext({
      storageState: tenantAdminStateFile,
    });
    const adminPage = await adminContext.newPage();
    const personContext = await browser.newContext();
    const personPage = await personContext.newPage();

    /** Collected, not thrown — the reasoning stands at the `finally` below. */
    const cleanupErrors: string[] = [];

    /** The card of one group — see the note on the class selector below. */
    const groupCard = (name: string): Locator =>
      adminPage
        .locator('.tenant-admin__group-card')
        .filter({ has: adminPage.getByLabel(`Name der Gruppe ${name}`) });

    try {
      await adminPage.goto(TENANT_MEMBERS_PATH);
      await expect(
        adminPage.getByRole('heading', {
          name: 'Organisations-Verwaltung',
          level: 1,
        }),
      ).toBeVisible();

      // --- „Person hinzufügen" starts at the least powerful role -------
      /*
       * `GET /tenant/groups` answers by rank **descending**, so „the first
       * entry" was `admin`: the one-click path of the surface whose whole
       * subject is who may do what handed out the strongest role in the organisation.
       * The preselection therefore has to be the *last* option, and the check
       * below says both halves — it is the last one, and it is not the first.
       */
      const inviteRole = adminPage
        .getByRole('region', { name: 'Person hinzufügen' })
        .getByLabel('Rolle', { exact: true });
      /*
       * Wait for the options **before** reading them. `evaluateAll` does not
       * auto-wait for children — it answers with whatever is in the DOM at that
       * instant —, and the groups arrive from `GET /tenant/groups` some time
       * after the heading this test waited on. Under the load of the full suite
       * that gap opens far enough to read an empty `<select>`: this is the
       * failure that was seen once in `pnpm e2e` and never alone, reported as
       * „Received: 0" against a message written for „exactly one group".
       * Diagnosed from the preserved trace (2026-08-03) — one of the
       * three unexplained single failures this suite left behind has this shape.
       */
      await expect(inviteRole.locator('option').nth(1)).toBeAttached();
      const roleValues = await inviteRole
        .locator('option')
        .evaluateAll((options) =>
          options.map((option) => (option as { value: string }).value),
        );
      expect(
        roleValues.length,
        'An organisation with one group cannot show which end of the list is picked.',
      ).toBeGreaterThan(1);
      const selectedRole = await inviteRole.inputValue();
      expect(selectedRole).toBe(roleValues[roleValues.length - 1]);
      expect(selectedRole).not.toBe(roleValues[0]);

      // --- a new group, its pills clicked in the middle ----------------
      await adminPage
        .getByRole('button', { name: '+ Gruppe hinzufügen' })
        .click();
      const fresh = groupCard('Neue Gruppe');
      /*
       * `toHaveCount(1)`, not `toBeVisible()`. „+ Gruppe hinzufügen" writes
       * the group to the server at once; a run that broke off between this
       * click and the renaming leaves a card of that name
       * standing. `toBeVisible()` then fails with a strict-mode message
       * that lets nothing of „an earlier run left something lying" be
       * recognised; this assurance says the number and names the reason. Such
       * a remnant is cleared away in the last phase of the clean-up below.
       */
      await expect(
        fresh,
        'Genau eine Karte „Neue Gruppe" — zwei heißt: ein früherer Lauf ist ' +
          'zwischen „+ Gruppe hinzufügen" und dem Umbenennen abgebrochen und ' +
          'hat seine Gruppe im Organisation stehen lassen.',
      ).toHaveCount(1);
      await expect(fresh).toBeVisible();
      await fresh.getByLabel('Name der Gruppe Neue Gruppe').fill(groupName);

      for (const permission of ['Antworten ansehen', 'Export']) {
        const pill = fresh.getByRole('button', {
          name: permission,
          exact: true,
        });
        await expect(pill).toHaveAttribute('aria-pressed', 'false');
        // The middle of the pill, not `aria-pressed` set from the outside.
        await pill.click();
        await expect(
          pill,
          `The permission pill „${permission}" did not toggle on a centred click.`,
        ).toHaveAttribute('aria-pressed', 'true');
      }
      /*
        **„2/6", not „2/5"** (ADR-0021): `canManageSettings` has become two
        rights — *Formular-Einstellungen* for a form and
        *Einstellungen der Organisation* for the Organisation —, so the
        denominator is six. The numerator stays two: the loop above still
        switches on exactly „Antworten ansehen" and „Export".

        The denominator no longer stands in the application as a number but is
        derived from `PERMISSION_LABELS` (`PERMISSION_TOTAL`) — precisely so
        that a sixth right does not slip through as „6/5 Rechte". Here it is
        a number and has to be: an expectation derived from the same source
        would check the derivation against itself.
      */
      await expect(fresh.getByText('2/6 Rechte')).toBeVisible();
      /*
       * Not `save(fresh)`: the card's own locator is keyed on the name the
       * *server* knows, so the moment the save lands the card stops matching
       * „Neue Gruppe" and a „button is disabled now" assertion would be waiting
       * on an element that no longer exists. The renamed card appearing is the
       * better signal anyway — it is the save having been answered.
       */
      await fresh
        .getByRole('button', { name: 'Speichern', exact: true })
        .click();
      await expect(groupCard(groupName)).toBeVisible();

      /*
        --- the person, in that group ------------------------------------

        **Without a typed password** (ADR-0024): the block has no field for
        it any more. `PERSON_PASSWORD` is now what the person sets themselves
        through their invitation link — caught at the mail server of the
        instance, which `auth.setup.ts` enters for the whole run.
      */
      await invitePersonAndSetPassword(adminPage, browser, {
        name: personName,
        email: personEmail,
        password: PERSON_PASSWORD,
        role: groupName,
      });

      // --- two forms of that organisation ------------------------------------------
      const restrictedTitle = await newForm(adminPage, 'B7 entzogen');
      await addQuestion(adminPage, 'Text', 'Name');
      await saveForm(adminPage);
      const restrictedId = formIdOf(adminPage.url());

      const openTitle = await newForm(adminPage, 'B7 Kontrolle');
      await addQuestion(adminPage, 'Text', 'Name');
      await saveForm(adminPage);
      const openId = formIdOf(adminPage.url());

      // --- the person opens a session, and keeps it open --------------------
      await personPage.goto('/');
      await expectLoginView(personPage);
      expect(
        await submitLogin(personPage, {
          email: personEmail,
          password: PERSON_PASSWORD,
        }),
        'The person this test just created must be able to sign in — a 401 ' +
          'here means the invitation link did not actually set the password ' +
          '(ADR-0024); nobody types one into „Person hinzufügen" any more.',
      ).toBe(200);
      await expectDashboard(personPage);

      // Both forms are theirs to see, and both answer.
      await expectFormListed(personPage, restrictedTitle, true);
      await expectFormListed(personPage, openTitle, true);
      expect(
        await status(personPage, `/api/forms/${restrictedId}/responses`),
      ).toBe(200);
      expect(
        await status(personPage, `/api/forms/${restrictedId}/export.csv`),
      ).toBe(200);

      // --- the access to *one* form is revoked -------------------------
      await adminPage.goto(`/forms/${restrictedId}/members`);
      await expect(
        adminPage.getByRole('heading', { name: 'Nutzerrechte', level: 1 }),
      ).toBeVisible();

      const row = adminPage
        .getByRole('listitem')
        .filter({ hasText: personEmail });
      const accessSwitch = row.getByRole('switch', {
        name: `Zugriff für ${personName} auf diesem Formular`,
      });
      await expect(accessSwitch).toBeChecked();
      // Middle of the switch again — this is the control of the requirement that
      // the dead zone would have hidden.
      await accessSwitch.click();
      await expect(accessSwitch).not.toBeChecked();
      await row.getByRole('button', { name: 'Speichern', exact: true }).click();
      await expect(
        row.getByRole('button', { name: 'Speichern', exact: true }),
      ).toHaveCount(0);

      // --- …and the open session feels it, without signing in again --------
      await personPage.reload();
      await expectDashboard(personPage);
      await expectFormListed(personPage, restrictedTitle, false);
      // The positive control: the other form is untouched. Without it, „das
      // Formular ist weg" would also pass if the whole list had broken.
      await expectFormListed(personPage, openTitle, true);

      await personPage.goto(`/forms/${restrictedId}/responses`);
      /*
       * The page refuses. It says „Die Antworten konnten nicht geladen werden."
       * rather than naming the revocation, which is deliberate on the server's
       * side — a revoked form answers 404, byte-identical to an unknown id, so
       * the view has nothing sharper to say without leaking that the form
       * exists. What is asserted here is therefore that the table is **gone**
       * and a refusal stands in its place; the load-bearing half is the status
       * code below.
       */
      await expect(personPage.getByRole('alert')).toBeVisible();
      await expect(personPage.getByRole('table')).toHaveCount(0);

      expect(
        await status(personPage, `/api/forms/${restrictedId}/responses`),
        'A revoked form must answer 404 on the responses route.',
      ).toBe(404);
      expect(
        await status(personPage, `/api/forms/${restrictedId}/export.csv`),
        'The CSV export is the way an earlier version left open once already (' +
          'the evidence) — it has to close with the rest.',
      ).toBe(404);
      expect(await status(personPage, `/api/forms/${openId}/export.csv`)).toBe(
        200,
      );

      // --- the evidence: a permission taken away in the editor ------------
      await adminPage.goto(TENANT_MEMBERS_PATH);
      const card = groupCard(groupName);
      const responsesPill = card.getByRole('button', {
        name: 'Antworten ansehen',
        exact: true,
      });
      await expect(responsesPill).toHaveAttribute('aria-pressed', 'true');
      await responsesPill.click();
      await expect(responsesPill).toHaveAttribute('aria-pressed', 'false');
      await save(card);

      expect(
        await status(personPage, `/api/forms/${openId}/responses`),
        'A permission removed in the group editor must bite the session that ' +
          'is already open — no new login. A 200 ' +
          'here means the permissions were read from the session instead of ' +
          'from the membership.',
      ).toBe(403);
    } finally {
      /*
       * --- the fixture goes away again ------------------------------------
       *
       * Person first: a group with members is not deletable, and both removals take two clicks — the
       * confirmation is part of what is being exercised here.
       *
       * **Asserted, never guarded by `count()`.** The first version wrote
       * `if ((await person.count()) > 0)`, and `count()` does not auto-wait:
       * on a page that had not finished loading it answered 0, the whole
       * cleanup was skipped, and the run reported green while leaving a person
       * and a group behind in the development database. Three runs' worth of
       * them were sitting there before the *fourth* run happened to find the
       * card and failed on „Diese Gruppe hat noch 1 Mitglied". A cleanup that
       * quietly does nothing is the same defect class as a spec that runs zero
       * tests, so this one waits for the page and then insists.
       *
       * **And every phase stands for itself, because a `throw` out of a
       * `finally` replaces the error of the body.** That is no question of
       * style but the explanation of a reported failure: „die angelegte Person
       * stand nicht in der Liste" is exactly what this clean-up says when the
       * *body* broke off before the „Person hinzufügen" — and the
       * JavaScript semantics throw the actual cause away in the process. The
       * report then named the clean-up, not the fault, and that is the
       * kind of red run one takes for noise.
       *
       * Therefore: every phase in its own `try`, the errors collected instead
       * of thrown, and the collection asserted **after** the `finally` — there,
       * where it can no longer cover anything up. Two effects, both wanted: a
       * failed body still reports *its* error, and the phases
       * after it all run all the same, instead of the first taking the second
       * with it (until now the group stayed standing as soon as the person was
       * missing).
       */
      const phases: readonly (readonly [string, () => Promise<void>])[] = [
        [
          'die Person zu entfernen',
          async () => {
            await adminPage.goto(TENANT_MEMBERS_PATH);
            await expect(
              adminPage.getByRole('region', { name: 'Person hinzufügen' }),
            ).toBeVisible();

            const person = adminPage
              .getByRole('listitem')
              .filter({ hasText: personEmail });
            await expect(person).toHaveCount(1);
            await person
              .getByRole('button', { name: `${personName} entfernen` })
              .click();
            /*
             * `exact: true`, and it is load-bearing: `getByRole`'s name filter
             * is a **substring** match by default, and the row's „×" carries
             * the accessible name „<Person> entfernen" — which contains
             * „Entfernen". A non-exact query therefore resolves to the × and
             * the confirmation at once and refuses to click either.
             */
            await person
              .getByRole('button', { name: 'Entfernen', exact: true })
              .click();
            await expect(person).toHaveCount(0);
          },
        ],
        [
          'die Gruppe zu löschen',
          async () => {
            await adminPage.goto(TENANT_MEMBERS_PATH);
            await expect(
              adminPage.getByRole('region', { name: 'Person hinzufügen' }),
            ).toBeVisible();

            const leftover = groupCard(groupName);
            await expect(leftover).toHaveCount(1);
            await leftover
              .getByRole('button', { name: `Gruppe ${groupName} löschen` })
              .click();
            await leftover
              .getByRole('button', { name: 'Gruppe löschen', exact: true })
              .click();
            await expect(
              leftover,
              'The group must be gone. „Diese Gruppe hat noch 1 Mitglied" ' +
                'here means the removal above did not reach the server — the ' +
                'row disappearing from the list is not the same as the ' +
                'membership being deleted.',
            ).toHaveCount(0);
          },
        ],
        [
          'eine übrig gebliebene „Neue Gruppe" abzuräumen',
          async () => {
            /*
             * **The self-amplifier of this file, and the reason for this
             * phase.** „+ Gruppe hinzufügen" creates the group **on the server
             * at once** (`TenantGroupsEditor.tsx`: `create.mutate` in the
             * `onClick`), only afterwards does the body type its name. If a
             * run breaks off in between, a group named „Neue Gruppe" stays
             * standing — and the *next* run finds **two** cards of that name
             * after its click and fails on Playwright's strict mode,
             * at a place two runs away from the cause.
             * A failure that produces the next one is the pattern this
             * clean-up is built against.
             *
             * Trailing and without an assurance on the number: as a rule there
             * is nothing here, and that is the success case. The waiting edge
             * stands in the phase above (the loaded list), so the `count()`
             * decides on a page that has been drawn.
             */
            const stray = groupCard('Neue Gruppe');
            for (let guard = 0; guard < 3; guard += 1) {
              if ((await stray.count()) === 0) {
                return;
              }
              await stray
                .first()
                .getByRole('button', { name: 'Gruppe Neue Gruppe löschen' })
                .click();
              await stray
                .first()
                .getByRole('button', { name: 'Gruppe löschen', exact: true })
                .click();
              await expect(stray).toHaveCount(0);
            }
          },
        ],
        ['die Kontexte zu schließen', () => adminContext.close()],
        ['den Kontext der Person zu schließen', () => personContext.close()],
      ];

      for (const [what, phase] of phases) {
        try {
          await phase();
        } catch (error) {
          cleanupErrors.push(`${what}: ${String(error)}`);
          console.error(
            `[tenant-admin] Aufräumen: ${what} ist gescheitert:`,
            error,
          );
        }
      }
    }

    /*
     * Only reachable when the body ran through — here a clean-up error can no
     * longer cover anything up, and a clean-up that only logs
     * would be the „it looks tidied up" the assurances above stand
     * against.
     */
    expect(
      cleanupErrors,
      'Der Rumpf war grün, das Aufräumen nicht — die Person, die Gruppe oder ' +
        'beide stehen jetzt in der Entwicklungsdatenbank und lassen den ' +
        'nächsten Lauf an einer ganz anderen Stelle scheitern.',
    ).toEqual([]);
  });

  /**
   * **Leaving one's own Organisation — the proof in a
   * browser, and the only E2E that hands out the role `admin`.**
   *
   * Brought here by an earlier review: `durchlauf-organisationen.spec.ts` used to perform
   * exactly this handover in its cleanup — invite a „Nachfolger" with the role
   * `admin`, then leave the organisation oneself — and when `DELETE /admin/tenants/:id`
   * replaced that cleanup, the browser proof went with it. What was left is the
   * case above, in which an admin removes **somebody else**; nobody drove the
   * two things this one does:
   *
   * 1. **the role `admin` is actually assignable** through „Person hinzufügen"
   *    — the surface's own strongest choice, which the preselection assertion
   *    above deliberately keeps *out* of the one-click path;
   * 2. **one leaves an organisation oneself**, which the server allows and refuses by
   *    exactly one rule (`users.service.ts`: the last administrator), with the
   *    prompt („Du trägst dich selbst aus dieser Organisation aus.") that only the own
   *    row shows.
   *
   * Both halves are here, in that order and in one case, because the refusal is
   * only observable **before** the second admin exists and the exit only after:
   * Musterstadt is seeded with a single `admin`, and this test is the thing that
   * changes that. The refusal half runs against the seeded Organisation-Admin and
   * changes nothing — a 409 writes no row — so the parked session it uses stays
   * exactly as the rest of the suite expects it.
   *
   * **And the way the specification becomes visible.** The person created here is a
   * member of this organisation and of no other, so leaving it costs them their
   * account: the login view rather than an unscoped dashboard is what the
   * browser then shows, and that is the difference between „das Konto ist weg"
   * and „nur die Mitgliedschaft ist weg". A surviving account would sit on
   * „Keine Organisation ausgewählt" here — which is why this assertion is worth more
   * than „the row disappeared from the admin's list", which is asserted too.
   */
  test('die letzte Administratorin kommt nicht aus der Organisation heraus — eine zweite schon, und verliert dabei ihr Konto', async ({
    browser,
  }) => {
    /*
      **A time budget instead of Playwright's 30 s** — this case waits once
      on the mail queue (`invitePersonAndSetPassword`), and the worker
      runs on a 15-second beat. The arithmetic stands at `mailQueueTestTimeout`.
    */
    test.setTimeout(mailQueueTestTimeout(1));

    const stamp = Date.now().toString(36);
    const secondName = `E2E Zweitadmin ${stamp}`;
    const secondEmail = `e2e-zweitadmin-${stamp}@musterstadt.example`;

    const adminContext = await browser.newContext({
      storageState: tenantAdminStateFile,
    });
    const adminPage = await adminContext.newPage();
    const personContext = await browser.newContext();
    const personPage = await personContext.newPage();

    try {
      await adminPage.goto(TENANT_MEMBERS_PATH);
      await expect(
        adminPage.getByRole('region', { name: 'Person hinzufügen' }),
      ).toBeVisible();

      // --- the evidence: the only admin of this organisation cannot leave ---------
      const seatedAdmin = adminPage
        .getByRole('listitem')
        .filter({ hasText: seedTenantAdmin.email });
      await expect(
        seatedAdmin,
        'Musterstadt is seeded with exactly one `admin`, and that is the ' +
          'precondition of the refusal below — a second one would make this ' +
          'case measure nothing.',
      ).toHaveCount(1);
      /*
       * `/entfernen$/u`, not „Entfernen": the row's „×" carries the accessible
       * name „<Person> entfernen" and the confirmation button reads
       * „Entfernen", so a substring match would resolve to both. Anchored and
       * lower-case, it can only be the ×.
       */
      await seatedAdmin.getByRole('button', { name: /entfernen$/u }).click();
      await expect(
        seatedAdmin.getByText(
          'Du trägst dich selbst aus dieser Organisation aus.',
        ),
        'The own row must ask its own question — „„…“ wird entfernt" here ' +
          'means the view did not recognise the row as the signed-in person.',
      ).toBeVisible();
      await seatedAdmin
        .getByRole('button', { name: 'Entfernen', exact: true })
        .click();

      /*
       * The server's sentence in full, not „an alert appeared": the row holds
       * **two** `role="alert"` elements at this moment — the confirmation,
       * which stays open because nothing was removed, and the refusal — so a
       * role query alone resolves to both. Spelled out rather than matched
       * loosely, because the generic fallback of `memberActionErrorMessage`
       * („Das ist nicht möglich: der letzte Administrator …") is a *different*
       * sentence, and it is the one that appears when `error.detail` is
       * dropped on the way from the 409 to the row.
       */
      await expect(
        seatedAdmin.getByText(
          'Diese Person ist die letzte Administratorin oder der letzte ' +
            'Administrator dieser Organisation und kann nicht entfernt werden.',
        ),
        'The refusal must name its reason, in the server’s own words ' +
          '(`lastAdminMessage`).',
      ).toBeVisible();
      await expect(
        seatedAdmin,
        'A refused removal must leave the membership standing — this parked ' +
          'session is the one the rest of the suite runs under.',
      ).toHaveCount(1);

      // The prompt is still standing — nothing was removed, so nothing closed
      // it. Taken back through its own „Abbrechen", which leaves the row in
      // the state the rest of this file expects to find it in.
      await seatedAdmin.getByRole('button', { name: 'Abbrechen' }).click();
      await expect(
        seatedAdmin.getByText(
          'Du trägst dich selbst aus dieser Organisation aus.',
        ),
      ).toHaveCount(0);

      // --- the role `admin`, handed out through the surface -----------------
      // Through the invitation again — see the case above.
      await invitePersonAndSetPassword(adminPage, browser, {
        name: secondName,
        email: secondEmail,
        password: PERSON_PASSWORD,
        role: 'admin',
      });

      /*
       * The role as the *server* answered it, read back off the row rather
       * than trusted from the form that was submitted. `option:checked` is a
       * CSS selector where this file otherwise uses roles, and deliberately:
       * a `<select>`'s selected option is what the person sees, and its value
       * is a group id no test may hard-code.
       */
      const secondRow = adminPage
        .getByRole('listitem')
        .filter({ hasText: secondEmail });
      await expect(
        secondRow
          .getByLabel(`Rolle von ${secondName}`)
          .locator('option:checked'),
      ).toHaveText('admin');

      // --- that role really opens the organisation's administration ----------------
      await personPage.goto('/');
      await expectLoginView(personPage);
      expect(
        await submitLogin(personPage, {
          email: secondEmail,
          password: PERSON_PASSWORD,
        }),
        'The second admin this test just created must be able to sign in.',
      ).toBe(200);
      await expectDashboard(personPage);

      await personPage.goto(TENANT_MEMBERS_PATH);
      await expect(
        personPage.getByRole('heading', {
          name: 'Organisations-Verwaltung',
          level: 1,
        }),
        'Reaching the Nutzerrechte tab at all is `can_manage_users`, so this ' +
          'is the behavioural half of „the role `admin` was assigned" — the ' +
          'select above only says what the row is labelled.',
      ).toBeVisible();
      await expect(
        personPage.getByRole('region', { name: 'Person hinzufügen' }),
      ).toBeVisible();

      // --- and now the exit works, because somebody else holds admin --------
      const ownRow = personPage
        .getByRole('listitem')
        .filter({ hasText: secondEmail });
      await expect(ownRow).toHaveCount(1);
      await ownRow.getByRole('button', { name: /entfernen$/u }).click();
      await expect(
        ownRow.getByText('Du trägst dich selbst aus dieser Organisation aus.'),
      ).toBeVisible();
      await ownRow
        .getByRole('button', { name: 'Entfernen', exact: true })
        .click();

      /*
       * the specification: this person was a member of this organisation and of no other, so
       * the membership and the account go in the same transaction, and
       * `session.user` cascades with it. The login view is therefore the
       * assertion — a merely un-scoped session would stand on „Kein Tenant
       * ausgewählt" instead, which is exactly the outcome this distinguishes.
       */
      await personPage.goto('/');
      await expectLoginView(personPage);

      await adminPage.goto(TENANT_MEMBERS_PATH);
      await expect(
        adminPage.getByRole('region', { name: 'Person hinzufügen' }),
      ).toBeVisible();
      await expect(
        adminPage.getByRole('listitem').filter({ hasText: secondEmail }),
        'And the organisation is back to one administrator — otherwise the next run ' +
          'of the refusal above would measure nothing.',
      ).toHaveCount(0);
    } finally {
      await adminContext.close();
      await personContext.close();
    }
  });

  /**
   * **„Einladung erneut senden"** (ADR-0024) — the one repair of a mail
   * that landed in the spam folder or expired.
   *
   * Three statements, and the middle one is the one that draws a security
   * boundary:
   *
   * 1. the second invitation really arrives and carries a **different**
   *    token;
   * 2. the **first** is thereby invalidated — otherwise there would be two
   *    open powers for one account, and the older would lie in a mailbox
   *    somebody has given up;
   * 3. once the account is set up, the **server** refuses. That is no
   *    finishing touch: otherwise the button would be a way to have a
   *    sign-in link sent to somebody else's working account.
   *
   * **And a fourth that is taken along here, because it would occur nowhere
   * else in the browser** (0): the body of the first invitation is read for
   * its **footer** — the link into the system from ADR-0027. A case of its own
   * for it would have to trigger a second mail and wait on the
   * queue once more; here it already lies there. The reasoning in detail
   * stands at {@link expectSystemMailFooter}.
   *
   * ## Why without a single sign-in
   *
   * Because the budget of `POST /api/auth/login` has ten attempts a minute and
   * `auth.setup.ts` plans eight of them. That the password was really set
   * is said here by the **refusal** (3): it hangs on `hasPassword` in
   * `ScopedMembershipDelegate.accountFacts`, i.e. on exactly the column a
   * sign-in would check.
   */
  test('„Einladung erneut senden": der neue Link gilt, der alte nicht mehr — und ein eingerichtetes Konto lehnt der Server ab', async ({
    browser,
  }) => {
    /*
      **Waiting twice, so twice the budget** — and that is exactly what this
      case died of in both CI runs of 2026-08-18: the first invitation
      and the second each come on the 15-second beat of the mail worker, plus
      three browser contexts and six page loads. After the 30 s Playwright
      prescribes it was dead — with „Test timeout of 30000ms exceeded" instead
      of the reason the waiting edge holds ready. The arithmetic stands at
      `mailQueueTestTimeout`.

      **Four other explanations have been checked and ruled out**, so that
      nobody pursues them a second time:

      - *The 429 on the mail-sending routes* not: `ThrottlerGuard`
        counts per handler, creating and resending have their own ten a
        minute. A 429 would moreover have turned the assurance on „✓ … wurde
        hinzugefügt" red after five seconds, with plain text.
      - *`INVITATION_ACCOUNT_SHARED_MESSAGE`* not: the person comes into being
        here freshly and belongs to exactly one Organisation.
      - *The `after` argument of the waiting edge* not: if it did not bite, the
        poll would find the **first** mail again at once — and the assurance
        „ein anderes Merkzeichen" two lines further on would have been red in
        milliseconds, with its own sentence. What was observed is a clock
        running out.
      - *A wrong lane* (post of the Organisation instead of the installation,
        which without a mail server of its own would stay on `withheld`) not:
        `enqueueInvitation` is **one** version for all four enqueueing ways,
        „erneut senden" included, and it writes `trigger: 'system'`.
        The worker log of the second run confirms it — in the ticks
        next to the last attempt stood `1 sent, 0 withheld`.
    */
    test.setTimeout(mailQueueTestTimeout(2));

    const stamp = Date.now().toString(36);
    const person = {
      name: `Einladungsperson ${stamp}`,
      email: `einladung-${stamp}@example.invalid`,
      /** Well above `USER_PASSWORD_MIN` (12). */
      password: `einladungs-passwort-${stamp}`,
    } as const;

    const adminContext = await browser.newContext({
      storageState: tenantAdminStateFile,
    });
    const adminPage = await adminContext.newPage();

    try {
      await adminPage.goto(TENANT_MEMBERS_PATH);
      const invite = adminPage.getByRole('region', {
        name: 'Person hinzufügen',
      });
      await expect(invite).toBeVisible();

      // --- a person whose invitation stays open ---------------------------
      const beforeInvite = readInstanceMail().length;
      await invite.getByRole('button', { name: 'Lokaler Nutzer' }).click();
      await invite.getByLabel('Name', { exact: true }).fill(person.name);
      await invite
        .getByLabel('E-Mail-Adresse', { exact: true })
        .fill(person.email);
      await invite.getByRole('button', { name: 'Hinzufügen' }).click();
      await expect(
        adminPage.getByText(
          `✓ ${person.name} wurde hinzugefügt und hat eine Einladung per Mail bekommen.`,
        ),
      ).toBeVisible();

      const firstLink = await waitForInvitationLink(person.email, {
        after: beforeInvite,
      });

      // --- (0) and this one really delivered mail carries the footer ------
      expectSystemMailFooter(person.email, beforeInvite);

      // --- (1) once more, and a second one arrives -----------------------
      const row = adminPage
        .getByRole('listitem')
        .filter({ hasText: person.email });
      await expect(row).toHaveCount(1);
      await row
        .getByRole('button', { name: `${person.name} bearbeiten` })
        .click();

      const beforeResend = readInstanceMail().length;
      await row
        .getByRole('button', { name: 'Einladung erneut senden' })
        .click();
      await expect(
        row.getByText(`✓ Einladung an ${person.email} verschickt.`),
      ).toBeVisible();

      const secondLink = await waitForInvitationLink(person.email, {
        after: beforeResend,
      });
      expect(
        secondLink,
        'Eine zweite Einladung trägt ein frisch gemünztes Merkzeichen. Wäre ' +
          'es dasselbe, hätte der Server die alte Zeile weiterverwendet — und ' +
          'die Frist liefe nicht neu.',
      ).not.toBe(firstLink);

      // --- (2) and the first one is invalidated ----------------------------
      const staleContext = await browser.newContext();
      const stale = await staleContext.newPage();
      try {
        await stale.goto(firstLink);
        await expect(
          stale.getByRole('heading', { name: 'Willkommen bei Formsache' }),
        ).toBeVisible();
        await stale
          .getByLabel('Dein Passwort', { exact: true })
          .fill(person.password);
        await stale.getByLabel('Passwort wiederholen').fill(person.password);
        await stale.getByRole('button', { name: 'Passwort setzen' }).click();
        await expect(
          stale.getByRole('alert'),
          'Der überholte Link muss abgewiesen werden — und zwar mit dem einen ' +
            'Satz des Servers, der „kenne ich nicht", „abgelaufen" und „schon ' +
            'ersetzt" bewusst nicht unterscheidet.',
        ).toHaveText(
          'Dieser Link ist ungültig oder abgelaufen. Bitte fordere einen neuen an.',
        );
        await expect(
          stale.getByRole('heading', { name: 'Passwort gesetzt' }),
        ).toHaveCount(0);
      } finally {
        await staleContext.close();
      }

      // --- the new one sets the password -----------------------------------
      await redeemInvitation(browser, secondLink, person.password);

      // --- (3) and now the server refuses a third invitation --------------
      await adminPage.reload();
      const settled = adminPage
        .getByRole('listitem')
        .filter({ hasText: person.email });
      await settled
        .getByRole('button', { name: `${person.name} bearbeiten` })
        .click();
      await settled
        .getByRole('button', { name: 'Einladung erneut senden' })
        .click();
      await expect(
        settled.getByRole('alert'),
        'Ein eingerichtetes Konto bekommt keine zweite Vollmacht mehr — sonst ' +
          'wäre dieser Knopf ein Weg, sich einen Zugang zu einem fremden, ' +
          'funktionierenden Konto schicken zu lassen.',
      ).toHaveText(
        'Dieses Konto ist bereits eingerichtet — eine Einladung gibt es dafür ' +
          'nicht mehr. Wer nicht mehr hineinkommt, benutzt „Passwort ' +
          'vergessen"; im Notfall setzt die Verwaltung hier ein neues Passwort.',
      );
    } finally {
      /*
        Clean-up, best effort: what would remain is an account of the weakest
        group with the timestamp of this run. „Person entfernen" takes the
        last membership and with it the account
        (`homeless-account.ts`).
      */
      try {
        await adminPage.goto(TENANT_MEMBERS_PATH);
        const row = adminPage
          .getByRole('listitem')
          .filter({ hasText: person.email });
        await row
          .getByRole('button', { name: `${person.name} entfernen` })
          .click();
        await row
          .getByRole('button', { name: 'Entfernen', exact: true })
          .click();
        await expect(row).toHaveCount(0);
      } catch {
        // See above — deliberately swallowed.
      }
      await adminContext.close();
    }
  });
});

/** The id out of a builder address — `/forms/<id>`. */
function formIdOf(url: string): string {
  const id = new URL(url).pathname.split('/')[2];
  expect(id, `[e2e] not a builder address: ${url}`).toBeTruthy();
  return id ?? '';
}

/** Whether a form card with this title is in the signed-in person's list. */
async function expectFormListed(
  page: Page,
  title: string,
  listed: boolean,
): Promise<void> {
  await page.goto('/');
  await expect(
    page.getByRole('article').filter({ hasText: title }),
    listed
      ? `„${title}" must be in this person's list.`
      : `„${title}" must be gone from this person's list — a restriction that ` +
          'only refuses the address would still have loaded the row.',
  ).toHaveCount(listed ? 1 : 0);
}

/** The status of a bare API call under the page's own session. */
async function status(page: Page, path: string): Promise<number> {
  const response = await page.request.get(path);
  return response.status();
}

/**
 * **The sixth tab: *Rechtstexte*** (ADR-0028).
 *
 * ## Why this stands here and not in a file of its own
 *
 * Because a new spec file only runs once it stands in a
 * `testMatch` alternation of `playwright.config.ts`, and this
 * follow-up work was allowed to touch `e2e/**` only. A file that runs in no
 * project and reports green all the same is the most expensive failure
 * this project has had (`smoke-suite-coverage.spec.ts`). The tab belongs
 * in this file anyway: it is tenant administration.
 *
 * ## What does **not** happen here
 *
 * Nothing is saved. This file runs `serial` and already writes enough
 * shared state of Musterstadt; filling `tenant.legal_pages` would take the
 * subject away from two other cases at once — from the open item on the
 * dashboard (`mobile-targets.spec.ts` counts it in) and from the notice before
 * publishing (`app-flows.ts`, `confirmPublishNotice`). The case about the
 * mode switch therefore checks the **draft** and proves at the end that it has
 * left nothing behind.
 */
test.describe('Rechtstexte der Organisation ', () => {
  test.use({ storageState: tenantAdminStateFile });

  const TENANT_LEGAL_SETTINGS_PATH = '/admin/legal';

  /** The tab bar of the frame — a navigation, not an ARIA tab widget. */
  function tabs(page: Page): Locator {
    return page.getByRole('navigation', { name: 'Organisations-Verwaltung' });
  }

  /** The card of one of the two pages — `<section aria-labelledby>`. */
  function card(page: Page, title: string): Locator {
    return page.getByRole('region', { name: title });
  }

  /**
   * The frame carries **seven** tabs, and *Rechtstexte* is the sixth —
   * *Vorlagen* (ADR-0032, moved here in full from the system administration)
   * is the seventh.
   *
   * The count is the part that can turn red — the same shape
   * `system-settings.spec.ts` runs for the system administration: a loop over
   * known captions never sees an eighth tab.
   */
  test('trägt sieben Reiter, mit Rechtstexte an sechster und Vorlagen an siebter Stelle', async ({
    page,
  }) => {
    await page.goto(TENANT_LEGAL_SETTINGS_PATH);
    await expect(
      page.getByRole('heading', { name: 'Organisations-Verwaltung', level: 1 }),
    ).toBeVisible();

    const labels = [
      'Erscheinungsbild & Login',
      'Formular-Standards',
      'Nutzerrechte',
      'Mailversand',
      'KI',
      'Rechtstexte',
      'Vorlagen',
    ];
    for (const label of labels) {
      await expect(
        tabs(page).getByRole('button', { name: label, exact: true }),
      ).toBeVisible();
    }
    await expect(
      tabs(page).getByRole('button'),
      'Steht hier eine größere Zahl, gibt es einen Reiter, den kein Fall ' +
        'anfährt — genau die Lücke, durch die *Rechtstexte* selbst eingezogen ' +
        'ist.',
    ).toHaveCount(labels.length);

    // The address belongs to this tab, not merely somewhere in the
    // tenant administration.
    await expect(
      tabs(page).getByRole('button', { name: 'Rechtstexte', exact: true }),
    ).toHaveAttribute('aria-current', 'page');

    // And below stand the two pages an Organisation fills.
    await expect(card(page, 'Anbieterangaben')).toBeVisible();
    await expect(card(page, 'Datenschutzhinweise')).toBeVisible();
  });

  /**
   * **The mode switch loses nothing** — the one promise of the data model
   * that is only visible in a browser.
   *
   * `legal.ts` states it as a shape („beide Hälften bleiben erhalten, immer"),
   * and the sentence under the switch promises it to the person operating it.
   * What neither of the two places proves is that the interface keeps it:
   * `LegalPageEditor` draws **either** the fields **or** the text area
   * depending on the mode, and an `onChange` that reset `fills` or `custom`
   * on switching would be silent data loss at exactly the moment in which
   * somebody tries something out.
   *
   * Measured over **two** switches, not one: „there and back" checks
   * the template half, „and there once more" its own. A case with only
   * one switch would be green against a `custom: ''` on switching back.
   */
  test('der Moduswechsel verliert nichts — beide Fassungen stehen nebeneinander', async ({
    page,
  }) => {
    const ORT = 'Musterstadt (Entwurf, ungespeichert)';
    const EIGENER_TEXT =
      'Eigene, anwaltlich geprüfte Fassung — nur im Entwurf dieses Laufs.';

    await page.goto(TENANT_LEGAL_SETTINGS_PATH);
    const imprint = card(page, 'Anbieterangaben');
    await expect(imprint).toBeVisible();

    /*
      **Die Wahl der Fassung steht zugeklappt unter den Feldern**
      (Review-Runde 3 Nr. 16). Sie stand einmal als erstes Bedienelement der
      Karte da und verlangte damit von jedem, der einen Rechtstext hinterlegen
      will, zuerst eine Entscheidung über die Bauform — von genau den
      Menschen, denen die geprüfte Vorlage abgenommen werden soll.

      Das Aufklappen gehört deshalb in diesen Fall hinein und ist keine
      Umständlichkeit: es ist der Weg, den jemand mit einer anwaltlich
      geprüften Fassung geht, und dass er kurz ist, misst dieser Klick mit.

      Er steht **einmal**, ganz am Anfang, und das ist die zweite Zusage
      dieses Falls: einmal aufgeklappt, bleibt der Kasten offen — auch über
      beide Moduswechsel hinweg. Müsste er zwischendurch erneut aufgeklappt
      werden, wäre der Schalter unter der Hand verschwunden, sobald man ihn
      betätigt.
    */
    /*
      ⚠️ **Der Satz hat seit Review-Runde 5 (Nachtrag) einen dritten Weg
      dabei** — „… oder einen Verweis hinterlegen?". `getByText` sucht eine
      Teilzeichenkette, und die alte war keine der neuen: der Klick lief in den
      Timeout und nahm den ganzen Zug mit. Gesucht wird deshalb der Anfang des
      Satzes, der die Frage stellt, und nicht seine Aufzählung.
    */
    const ownTextDisclosure = imprint.getByText('Lieber einen eigenen Text');
    await ownTextDisclosure.click();

    const modes = imprint.getByRole('radiogroup', {
      name: 'Fassung: Anbieterangaben',
    });
    const templateMode = modes.getByRole('radio', {
      name: 'Vorlage ausfüllen',
    });
    const customMode = modes.getByRole('radio', { name: 'Eigener Text' });

    // The seeded state: nothing on file, template selected
    // (`EMPTY_LEGAL_DOCUMENT.mode === 'template'`).
    await expect(templateMode).toBeChecked();
    await expect(
      imprint.getByText('Nichts hinterlegt'),
      'Die Zustandsmarke sagt das Wort und nicht nur die Farbe — wer die ' +
        'Farbe nicht sieht, liest den Zustand.',
    ).toBeVisible();

    /*
       --- template: a placeholder becomes a field and is filled in ----------

       `getByRole('textbox')` and expressly not `getByLabel`: the
       switch carries the caption „Eigener Text" **also** on its
       radio button (`ModeOption` puts a `<label>` around the `<input>`), and a
       `getByLabel('Eigener Text')` would therefore find two elements below and
       die on Playwright's strict mode — with a message about a
       locator that says nothing about Rechtstexte. The role tells the
       two apart cleanly.
    */
    const ortField = imprint.getByRole('textbox', { name: 'Ort', exact: true });
    await ortField.fill(ORT);
    await expect(
      imprint.getByText('Unvollständig'),
      'Eine Angabe reicht nicht: die Seite ist erst dann fertig, wenn kein ' +
        'Platzhalter des geltenden Textes mehr offen ist.',
    ).toBeVisible();

    // --- over to the own text, and write something there -------------------
    await customMode.check();
    await expect(
      imprint.getByRole('textbox', { name: 'Ort', exact: true }),
      'Im Modus „Eigener Text" gelten die Vorlagenfelder nicht — sie stehen ' +
        'dann auch nicht da.',
    ).toHaveCount(0);
    await imprint
      .getByRole('textbox', { name: 'Eigener Text', exact: true })
      .fill(EIGENER_TEXT);

    // --- and back: the filled-in template still stands ---------------------
    // Der Kasten steht offen — der Schalter bleibt, wo er war (siehe oben).
    await templateMode.check();
    await expect(
      imprint.getByRole('textbox', { name: 'Ort', exact: true }),
      'Zurück auf der Vorlage muss die Eingabe wieder da sein. Ist sie weg, ' +
        'hat der Wechsel `fills` geleert — stiller Datenverlust genau dann, ' +
        'wenn jemand die zweite Fassung nur ausprobieren wollte.',
    ).toHaveValue(ORT);

    // --- and there once more: the own text still stands too ----------------
    await customMode.check();
    await expect(
      imprint.getByRole('textbox', { name: 'Eigener Text', exact: true }),
      'Und die andere Richtung: der eigene Text darf beim Ausflug in die ' +
        'Vorlage nicht verlorengehen.',
    ).toHaveValue(EIGENER_TEXT);

    /*
      **And none of it is saved.** The proof belongs to it, because
      this file runs `serial` and `tenant.legal_pages` is a shared row:
      a run that left something behind here would take the subject away from
      the open item on the dashboard and from the notice before publishing,
      without it standing anywhere why the two are suddenly red.
    */
    await page.reload();
    const reloaded = card(page, 'Anbieterangaben');
    await expect(reloaded).toBeVisible();
    await expect(
      reloaded.getByText('Nichts hinterlegt'),
      'Nach dem Neuladen muss wieder „Nichts hinterlegt" dastehen — dieser ' +
        'Fall drückt kein „Speichern" und darf nichts hinterlassen.',
    ).toBeVisible();
    await expect(
      reloaded.getByRole('textbox', { name: 'Ort', exact: true }),
    ).toHaveValue('');
  });
});

/**
 * **The seventh tab: *Vorlagen*** (ADR-0032, moved here in full from the
 * system administration) — the surface to the notification templates of one
 * organisation.
 *
 * The count case above already proves the tab exists and sits at the right
 * place; what is measured here is that it really shows *this* organisation's
 * templates — the ones Musterstadt was seeded with at creation
 * (`AdminRepository.createTenant`), not an empty editor and not the old
 * installation-wide route's content.
 *
 * **Nothing is saved**, for the same reason the *Rechtstexte* block above
 * states: this file runs `serial` over one shared organisation, and a write
 * here would take the subject away from whatever else in this suite reads
 * Musterstadt's own templates.
 */
test.describe('Vorlagen der Organisation', () => {
  test.use({ storageState: tenantAdminStateFile });

  const TENANT_TEMPLATES_PATH = '/admin/templates';

  test('zeigt die Vorlagen dieser Organisation, mit dem Recht zum Ändern', async ({
    page,
  }) => {
    await page.goto(TENANT_TEMPLATES_PATH);
    await expect(
      page.getByRole('heading', { name: 'Organisations-Verwaltung', level: 1 }),
    ).toBeVisible();

    // The marker is the first template card, not the tab label — the same
    // reasoning `settledSystemTab()` gave in `e2e/a11y/views.ts` for the
    // predecessor of this tab.
    await expect(
      page.getByRole('heading', { name: 'Bestätigung an Teilnehmer' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Meldung ans Büro' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Änderungsmeldung' }),
    ).toBeVisible();

    // A field is present and editable — the boundary this file's storage
    // state grants (`can_manage_settings` on Musterstadt's admin group), not
    // merely a read-only display of somebody else's decision.
    await expect(page.getByRole('button', { name: 'Speichern' })).toBeVisible();
  });
});
