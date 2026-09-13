import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  addQuestion,
  expectSaved,
  newForm,
  publishAndReadPath,
  saveForm,
} from './app-flows';
import { authStateFile } from './seed-account';

/**
 * **The honeypot while filling in.**
 *
 * ⚠️ **A honeypot never proves that it works — only that it does no harm.**
 * Every case in this file is therefore negative, and that is the honest thing
 * to say about the measure rather than a gap in the evidence: it must not lose
 * a registration and it must not disturb anybody's assistive technology.
 *
 * **The third negative promise is not here, and where it went is part of the
 * evidence.** „Die Antwort an den Absender ist byte-gleich zum Erfolgsfall, in
 * Status und Rumpf" is a statement about the response the *server* builds, and
 * `apps/api/test/public/honeypot-suppression.spec.ts` builds both the call
 * site and that proof. It stayed out of this file for a reason that outlived
 * an earlier version's („it would be green with nothing suppressed"): a
 * browser never sees the bytes, it sees a rendered page, so a
 * Playwright case could only ever assert that both submissions *look* the same.
 * The last case below asserts exactly that much, which is what a browser can
 * honestly say; the byte comparison lives where the bytes exist.
 *
 * **This file exists because jsdom cannot see any of it.** Visibility, focus
 * order and overlap are not computed there, so
 * `apps/web/src/fill/HoneypotField.test.tsx` can only assert attributes — and
 * an attribute test that claimed to prove „unsichtbar" would be the same
 * mistake as the dead zone in the middle of every settings switch: six
 * green cases, and not one of them had ever clicked the control. The rule
 * („was heißt ausgefüllt?") is a unit test in
 * `apps/api/src/public/honeypot.spec.ts`; what is only measurable in a real
 * browser is here.
 *
 * **Desktop only** (`playwright.config.ts`), for the reason `core-flow` and
 * `public-form-password` run there alone: each case writes a form and a
 * published version into the shared database, and nothing asserted here is a
 * measurement of width.
 */

test.use({ storageState: authStateFile });

const NAME_LABEL = 'Name des Mitglieds';

/** The value an automated filler would leave behind — a plausible one. */
const BAIT = 'https://spam.example';

const DECOY_TEST_ID = 'public-honeypot';

/**
 * Minimal browser globals for the `evaluate` callbacks below — the same reason
 * `app-flows.ts`, `tenant-admin.spec.ts` and `system-settings.spec.ts` declare
 * their own: the root `tsconfig.json` that covers `e2e/` deliberately has no
 * DOM lib, and pulling `lib.dom` in would put the browser's `fetch`, `URL` and
 * friends next to the Node ones for every file in this project. Only the
 * members actually used are declared, and only here.
 */
interface FocusableElement {
  getAttribute: (name: string) => string | null;
  readonly textContent: string | null;
  readonly tagName: string;
}
interface DecoyInput {
  value: string;
  dispatchEvent: (event: unknown) => void;
}
declare const document: {
  readonly activeElement: FocusableElement | null;
  readonly body: { focus: () => void };
  querySelector: (selector: string) => DecoyInput | null;
};
declare const window: {
  readonly HTMLInputElement: { readonly prototype: object };
};
declare const Event: new (
  type: string,
  init?: { bubbles?: boolean },
) => unknown;
declare function getComputedStyle(element: unknown): {
  readonly display: string;
  readonly visibility: string;
};

/** A published one-page form with a single required question. */
async function publishedForm(page: Page, base: string): Promise<string> {
  await newForm(page, base);
  await addQuestion(page, 'Text', NAME_LABEL);
  await page.getByLabel('Pflichtfeld').check();
  await saveForm(page);
  return publishAndReadPath(page);
}

/**
 * **Takes „Zwischenspeichern erlauben" out of the open form** — and
 * with it the one button that otherwise stands between the last question and
 * „Absenden".
 *
 * Why this stands here and not in `publishedForm`: only the case about the
 * tab order measures the *neighbourhood* of the decoy. The three others
 * may see the form a human creates.
 *
 * **And why it is necessary at all.** `SYSTEM_FORM_SETTINGS.allowSaveDraft`
 * has stood **at `true`** since commit `0e6d654` (review finding 16) — before that
 * `false`. A freshly created form inherits that, `FillIn` then draws
 * „Zwischenspeichern" as the first button of the action bar, and the tab
 * from the last question lands there instead of on „Absenden". That is exactly what
 * this case failed on in the first real CI run (2026-08-18): **no fault
 * in the decoy**, but an assertion that had pinned down an inherited
 * side matter.
 *
 * The decoy lies unchanged between the questions and the action bar
 * (`fill/FillIn.tsx`) — the counter-check in the head of the case („`tabIndex={-1}`
 * wegnehmen, und der Tabulator landet im namenlosen Kasten") thereby stays
 * the same. Only what comes *after* it is switched off.
 *
 * Set expressly rather than inherited: the organisation's defaults are a
 * shared row, and a case whose statement hangs on it measures something
 * else as soon as somebody changes it.
 */
async function withoutDraftButton(page: Page): Promise<void> {
  const formId = /\/forms\/([^/?#]+)/u.exec(page.url())?.[1];
  expect(
    formId,
    'Nach `publishedForm` steht die Seite im Builder, und dessen Adresse ' +
      'trägt die Kennung des Formulars. Fehlt sie, wurde der Ablauf davor ' +
      'umgebaut — dann greift diese Vorbereitung ins Leere.',
  ).toBeDefined();

  await page.goto(`/forms/${formId ?? ''}/settings`);
  const access = page.getByRole('region', { name: 'Zugriff & Sicherheit' });
  // Without the takeover the section is the tenant default and the switch
  // writes nothing — the same order as in `a11y.spec.ts`.
  await access.getByRole('radio', { name: 'Angepasst' }).check();
  await access
    .getByRole('switch', { name: 'Zwischenspeichern erlauben' })
    .setChecked(false);
  await page.getByRole('button', { name: 'Speichern', exact: true }).click();
  // Not the disabled button: that is disabled while the
  // request is still on its way too (`app-flows.ts`, `expectSaved`).
  await expectSaved(page);
}

function decoy(guest: Page): Locator {
  return guest.getByTestId(DECOY_TEST_ID);
}

/**
 * Writes into the decoy the way a script does — through the native value
 * setter plus an `input` event.
 *
 * `locator.fill()` cannot be used and that is the point: Playwright refuses to
 * type into an element it considers hidden, which is the same judgement the
 * first case asserts. A bot does not type; it assigns. React only notices the
 * assignment when the event is dispatched, which is exactly the sequence every
 * form-filling script performs.
 */
async function fillDecoy(guest: Page, value: string): Promise<void> {
  await guest.evaluate(
    ({ testId, text }: { testId: string; text: string }) => {
      const element = document.querySelector(`[data-testid="${testId}"]`);
      if (element === null) {
        throw new Error('Der Köder war nicht im Dokument.');
      }
      // Annotated rather than taken as `PropertyDescriptor`: the standard type
      // declares `set` as a *method*, and a method pulled off its object is
      // exactly what `@typescript-eslint/unbound-method` exists to catch. Here
      // it is deliberate — the point is to reach past React's own `value`
      // setter to the native one — so the type says „function-valued property"
      // and the intent is written down instead of silenced.
      const descriptor:
        { set?: (this: unknown, value: string) => void } | undefined =
        Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value',
        );
      descriptor?.set?.call(element, text);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    },
    { testId: DECOY_TEST_ID, text: value },
  );
  await expect(decoy(guest)).toHaveValue(value);
}

/** Which element currently has focus, by its `data-testid` or its tag. */
async function focused(guest: Page): Promise<string> {
  return guest.evaluate(() => {
    const element = document.activeElement;
    if (element === null) {
      return 'none';
    }
    return (
      element.getAttribute('data-testid') ??
      `${element.tagName.toLowerCase()}:${element.textContent?.trim() ?? ''}`
    );
  });
}

test.describe('Honeypot beim Ausfüllen', () => {
  /**
   * Not visible — measured, not claimed.
   *
   * The second half is the one that would otherwise go unnoticed: the hiding
   * must **not** be `display: none`. That is the one form of hiding an
   * automated filler is likely to check for, and a decoy that announces itself
   * catches nothing. So the element is hidden *and* still laid out, which is
   * a combination no attribute in jsdom can express.
   */
  test('ist unsichtbar, aber nicht per display:none versteckt', async ({
    page,
    browser,
  }) => {
    const publicPath = await publishedForm(page, 'Honeypot unsichtbar');

    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);
      await expect(guest.getByLabel(new RegExp(NAME_LABEL, 'u'))).toBeVisible();

      await expect(decoy(guest)).toBeHidden();

      const box = await decoy(guest).boundingBox();
      expect(box?.width ?? 0).toBe(0);
      expect(box?.height ?? 0).toBe(0);

      const hiding = await decoy(guest).evaluate((element) => {
        const style = getComputedStyle(element);
        return { display: style.display, visibility: style.visibility };
      });
      expect(hiding.display).not.toBe('none');
      expect(hiding.visibility).not.toBe('hidden');
    } finally {
      await guestContext.close();
    }
  });

  /**
   * The reversal this case exists for: **leave the field focusable.** Drop
   * `tabIndex={-1}` and the tab from the last question lands in a nameless box
   * instead of on the button — the exact experience a keyboard or screen-reader
   * user would report and nobody else would ever see.
   *
   * Both directions are walked. Forwards from the question, because that is the
   * step somebody actually takes; and a full sweep of twenty tabs, because a
   * decoy that is skipped on one particular step but reachable from elsewhere
   * on the page is not skipped at all.
   */
  test('die Tab-Reihenfolge überspringt ihn', async ({ page, browser }) => {
    const publicPath = await publishedForm(page, 'Honeypot Tabfolge');
    // So that „nichts dazwischen" means what it says — the reasoning stands
    // at the function.
    await withoutDraftButton(page);

    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);
      const question = guest.getByLabel(new RegExp(NAME_LABEL, 'u'));
      await expect(question).toBeVisible();

      await question.focus();
      await guest.keyboard.press('Tab');
      // Straight from the last question to the button — nothing in between.
      // What „nichts" presupposes here is set up by `withoutDraftButton`.
      await expect(
        guest.getByRole('button', { name: 'Absenden' }),
      ).toBeFocused();

      /*
        **And what comes *after* „Absenden"** — since ADR-0028 the
        legal footer with its seven links stands there.

        The step is new and measures the kind of consequence that has already
        hit this case once: „Zwischenspeichern" had grown in between the last question
        and „Absenden" without anybody having intended it, and
        the case only went red in the first real CI run. The footer is the
        next candidate for that — it is rendered **behind** `FillIn` in
        `PublicFormView`, and that is exactly what is pinned down here. Were it
        in front, its first link would stand between the field and the button, the
        assertion above would be red, and this step says where it
        belongs instead.

        The **organisation's** link and not the installation's: the
        footer puts the organisation first, because it is the controller
        for the data that is currently being collected.
      */
      await guest.keyboard.press('Tab');
      await expect(
        guest.getByRole('link', { name: 'Anbieterangaben', exact: true }),
        'Nach „Absenden" gehört der erste Link der rechtlichen Fußzeile — ' +
          'sie steht unter dem Formular und nicht darüber. Steht hier etwas ' +
          'anderes, ist zwischen Aktionsleiste und Fußzeile etwas ' +
          'dazugekommen, oder die Fußzeile ist gewandert.',
      ).toBeFocused();

      // …and nowhere else on the page either.
      const visited: string[] = [];
      await guest.evaluate(() => {
        document.body.focus();
      });
      for (let step = 0; step < 20; step += 1) {
        await guest.keyboard.press('Tab');
        visited.push(await focused(guest));
      }
      expect(visited).not.toContain(DECOY_TEST_ID);
    } finally {
      await guestContext.close();
    }
  });

  /**
   * For assistive technology the field does not exist at all: the page offers
   * exactly the one text box the form has questions for.
   *
   * Counting rather than asserting `aria-hidden` — the attribute is already
   * covered by the web test, and what matters here is the *consequence*: a
   * screen reader announcing „Eingabefeld" with no name, in the middle of a
   * registration form, is the failure this measure must not cause.
   */
  test('für Bedienhilfen existiert er nicht', async ({ page, browser }) => {
    const publicPath = await publishedForm(page, 'Honeypot ohne Namen');

    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);
      await expect(guest.getByLabel(new RegExp(NAME_LABEL, 'u'))).toBeVisible();

      await expect(guest.getByRole('textbox')).toHaveCount(1);
      await expect(decoy(guest)).toHaveAttribute('aria-hidden', 'true');
    } finally {
      await guestContext.close();
    }
  });

  /**
   * **The one that matters most, and it is about what does *not* happen.**
   *
   * A password manager filling a hidden field is a real case. If the decoy ever
   * became a reason to discard the submission, this participant would see a
   * failure — or worse, a confirmation with nothing behind it. What they see
   * instead is the ordinary receipt, and what the organisation loses is a mail, not a
   * registration.
   */
  test('eine gefüllte Falle kostet die Anmeldung nicht', async ({
    page,
    browser,
  }) => {
    const publicPath = await publishedForm(page, 'Honeypot gefüllt');

    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);
      await guest.getByLabel(new RegExp(NAME_LABEL, 'u')).fill('Anton Aktiv');
      await fillDecoy(guest, BAIT);

      await guest.getByRole('button', { name: 'Absenden' }).click();

      await expect(
        guest.getByRole('heading', { level: 1, name: 'Vielen Dank!' }),
      ).toBeVisible();
    } finally {
      await guestContext.close();
    }
  });
});
