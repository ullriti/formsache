import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { expectSaved, saveState } from './app-flows';
import { authStateFile } from './seed-account';

/**
 * **The core flow can be operated without a mouse** .
 *
 * Building → publishing → filling in publicly → evaluating → exporting,
 * exclusively via `page.keyboard.press` — including reordering by grip
 * , opening and closing the mobile sheets and modals, and the
 * format choice in the export.
 *
 * ## What this file does **not** use, and why an assertion watches over that
 *
 * No `click()`, no `tap()`, no `fill()`, no `check()`, no
 * `selectOption()`, no `hover()` — and **no `locator.press()` and no
 * `locator.focus()` either**. The last two are the point at which a
 * keyboard assertion unnoticeably defeats itself: both put the focus
 * *directly* on an element instead of **tabbing** it there. A button that
 * stands in no tab order — `tabindex="-1"`, `display: none`, behind a
 * broken focus trap — is just as operable with `locator.press('Enter')`
 * as a proper one, and the case would stay green while nobody without a mouse
 * gets there.
 *
 * The route to every control therefore goes through {@link tabTo}: press Tab
 * until the focus stands there. That makes **reachability itself** the
 * assertion, and not only the effect of the key press.
 *
 * The one permitted exception is `page.keyboard.type()` for text. It is a
 * sequence of key presses on the element that **already has** the focus — the
 * alternative would be `press` per character, which does the same and proves nothing.
 * `fill()`, by contrast, writes the value past the focus and is therefore barred.
 *
 * This is watched over by `verbotene Griffe` below, an assertion about the
 * **source text of this file** — modelled on `mobile-click-guard`.
 *
 * ## What is measured: where the focus stands
 *
 * What this is about: „die Zusicherung misst deshalb **wo der Fokus
 * steht**, nicht nur, dass die Aktion geschah." Every step here therefore ends
 * with a statement about `:focus` — on the grip it has just
 * operated; inside the modal it has opened; back on the button
 * that had opened it.
 */

test.describe.configure({ mode: 'default' });
test.use({ storageState: authStateFile });

/* --- Keyboard tooling ---------------------------------------------------- */

/** Only the members the `evaluate` callbacks below really use. */
interface FocusProbe {
  matches: (selector: string) => boolean;
}

/**
 * Presses Tab (or Shift+Tab) until the focus stands on `target`.
 *
 * **The core of this file.** It replaces every `locator.focus()` and turns
 * „das Element reagiert auf Enter" into the stronger statement „man kommt ohne
 * Maus hin *und* es reagiert".
 *
 * At the end of the document Chromium leads the focus back to the beginning
 * via `<body>` (measured, not assumed: a tab-order probe on
 * 2026-08-10 ran through the same list twice), so the loop finds its
 * target even when the focus stands behind it. It waits on **state** —
 * the visibility of the target — and never on time.
 *
 * @returns how many tabs it cost; useful in the error message.
 */
async function tabTo(
  page: Page,
  target: Locator,
  where: string,
  options: { readonly backwards?: boolean; readonly max?: number } = {},
): Promise<number> {
  const key = options.backwards === true ? 'Shift+Tab' : 'Tab';
  const max = options.max ?? 60;

  await expect(
    target,
    `${where}: das Ziel muss genau einmal auf der Seite stehen, bevor der ` +
      'Fokus es suchen kann.',
  ).toHaveCount(1);
  await expect(target).toBeVisible();

  for (let pressed = 0; pressed <= max; pressed += 1) {
    const focused = await target.evaluate((element: FocusProbe) =>
      element.matches(':focus'),
    );
    if (focused) {
      return pressed;
    }
    await page.keyboard.press(key);
  }

  throw new Error(
    `${where}: nach ${String(max)} × ${key} steht der Fokus immer noch nicht ` +
      'auf diesem Element. Es ist über die Tastatur nicht erreichbar — ' +
      'entweder steht es in keiner Tabreihenfolge (tabindex="-1", ein ' +
      'nicht-fokussierbares Element mit Klick-Handler) oder ein Fokus-Käfig ' +
      'lässt den Fokus nicht bis dorthin.',
  );
}

/** Only the members {@link focusIsInside} uses. */
interface ContainerProbe {
  contains: (node: unknown) => boolean;
  readonly ownerDocument: { readonly activeElement: unknown };
}

/**
 * Does the focus stand **inside** this panel — the panel itself included?
 *
 * `panel.locator(':focus')` would be the obvious route and is the wrong one: it
 * looks for **descendants**. But at exactly the most interesting moment the
 * panel *itself* carries the focus — on opening, `useFocusTrap` calls
 * `panelRef.current?.focus()` on the element with `tabIndex={-1}` —, and the
 * count then comes out as 0. Measured on 2026-08-10: the first version of this
 * file reported „der Fokus hat das Modal verlassen" for a modal that had
 * trapped the focus exemplarily.
 *
 * `contains()` includes the element itself, and that is exactly what is asked.
 */
async function focusIsInside(panel: Locator): Promise<boolean> {
  return panel.evaluate((element: ContainerProbe) =>
    element.contains(element.ownerDocument.activeElement),
  );
}

/** Asserts that the focus now stands in the panel — with retrying. */
async function expectFocusInside(panel: Locator, where: string): Promise<void> {
  await expect
    .poll(async () => focusIsInside(panel), {
      message:
        `${where}: der Fokus steht nicht im Panel. Beim Öffnen muss er ` +
        'hineinwandern — bleibt er dahinter, tippt der Nutzer in eine Seite, ' +
        'die für ihn gar nicht mehr da ist.',
    })
    .toBe(true);
}

/**
 * On tabbing onwards the focus stays **in the panel** — the trap measurement.
 *
 * It reproduces exactly that, verbatim: „einen Fokus-Fang im
 * Modal entfernen → der Fall verlässt das Modal mit Tab und findet den nächsten
 * Knopf nicht". It is measured after **every** tab, not only at the end: a trap
 * that fails once and happens to bring the focus back on the press after next
 * would otherwise be green.
 *
 * The number of presses is deliberately larger than the number of controls in the
 * panel — it has to run over the edge at least once, because that is exactly where
 * the trap takes hold.
 */
async function expectFocusStaysInside(
  page: Page,
  panel: Locator,
  presses: number,
  where: string,
): Promise<void> {
  for (let step = 1; step <= presses; step += 1) {
    await page.keyboard.press('Tab');
    expect(
      await focusIsInside(panel),
      `${where}: nach ${String(step)} × Tab hat der Fokus das Modal ` +
        'verlassen. Wer es nicht sieht, tippt ab hier in die Seite dahinter, ' +
        'die für ihn gar nicht mehr da ist.',
    ).toBe(true);
  }
}

/** Clears away a form of this run again — delete, then permanently. */
async function purgeForm(
  page: Page,
  formId: string | undefined,
): Promise<void> {
  if (formId === undefined) {
    return;
  }
  await page.request.delete(`/api/forms/${formId}`);
  await page.request.delete(`/api/forms/${formId}/permanent`);
}

/* --- The guard over this file's own source ------------------------------- */

test.describe('Die Regel dieser Datei ', () => {
  /**
   * **No handle that skips the focus** — checked against the source text.
   *
   * Modelled on `mobile-click-guard.spec.ts`: an assertion
   * about the *build shape* of the cases, not about their result. Without it a
   * single `locator.click()` that somebody later puts in „nur eben schnell" is
   * invisible from outside — the case would stay green and still be called
   * „ausschließlich Tastatur".
   */
  test('benutzt keinen Griff, der den Fokus überspringt', () => {
    const source = readFileSync(
      fileURLToPath(new URL('keyboard-flow.spec.ts', import.meta.url)),
      'utf8',
    );

    /*
      Only the executable part — comments **and string literals** taken out.

      Both are measured and not precautionary: the documentation above *names* the
      forbidden handles, and the error messages below name them as well.
      A guard that trips over its own reasoning reports twelve
      violations and finds not a single real one — which is exactly what the first
      version did, twice in a row.
    */
    const code = source
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .replace(/^\s*\/\/.*$/gmu, '')
      .replace(/'(?:\\.|[^'\\])*'/gu, "''")
      .replace(/"(?:\\.|[^"\\])*"/gu, '""')
      .replace(/`(?:\\.|[^`\\])*`/gu, '``');

    /*
      **The names stand there without a dot and without a bracket, and that is necessary.**
      The first version listed `'.click('` verbatim — and thereby found
      itself: the guard tripped over its own list and reported all
      twelve violations at once. The search string is therefore only assembled
      at run time; the source text holds nothing but the bare word.
    */
    const call = (verb: string): string => `.${verb}(`;
    const forbidden = [
      'click',
      'dblclick',
      'tap',
      'hover',
      'fill',
      'check',
      'uncheck',
      'setChecked',
      'selectOption',
      'focus',
      'selectText',
      'dragTo',
    ].map(call);

    const found = forbidden.filter((verb) => code.includes(verb));
    expect(
      found,
      'Diese Datei belegt „ohne Maus". Jeder dieser Griffe bedient ein ' +
        'Element, ohne dass der Fokus je dorthin getabbt wäre — der Fall ' +
        'bliebe grün, während das Element für Tastaturnutzer unerreichbar ' +
        'ist. Der Weg ist `tabTo(...)` plus `page.keyboard.press(...)`.',
    ).toStrictEqual([]);

    /*
      The handle on the locator that *looks* like keyboard, separately: it
      focuses the element and only then presses. The only permitted route is the
      one via `page.keyboard`.

      The pattern is assembled at run time, for the same reason as the
      list above: a regex literal is not a string literal and survives the
      striking-out above, so the guard would find itself here too.
    */
    const escapedPress = call('press').replace(/[.(]/gu, (char) => `\\${char}`);
    const locatorPress = new RegExp(`(?<!keyboard)${escapedPress}`, 'u').test(
      code,
    );
    expect(
      locatorPress,
      '`locator.press()` setzt den Fokus selbst — genau die Abkürzung, die ' +
        'diese Datei nicht nehmen darf. Nur `page.keyboard.press` ist erlaubt.',
    ).toBe(false);
  });
});

/* --- The core flow ------------------------------------------------------- */

test.describe('Der Kern-Flow ohne Maus ', () => {
  /**
   * **One case, the whole chain**, step by step throughout.
   *
   * It is long, and that is deliberate: the statement is that the *route*
   * works without a mouse all the way through. Five short cases that each start
   * at their own station via `goto` would prove five times that a view
   * is operable — and never that one gets from one to the next.
   */
  test('bauen, umsortieren, veröffentlichen, ausfüllen, auswerten, exportieren', async ({
    page,
    browser,
  }) => {
    const title = `Tastatur-Flow ${Date.now().toString(36)}`;

    /* 1 — Creating, from the dashboard. */
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'Dashboard', level: 1 }),
    ).toBeVisible();

    await tabTo(
      page,
      page.getByLabel('Name des neuen Formulars'),
      'Namensfeld',
    );
    await page.keyboard.type(title);
    await tabTo(
      page,
      page.getByRole('button', { name: '+ Neues Formular' }),
      '„+ Neues Formular"',
    );
    await page.keyboard.press('Enter');

    await expect(page.getByLabel('Formularname')).toHaveValue(title);
    await expect(page).toHaveURL(/\/forms\//u);
    const formId = /\/forms\/([^/?#]+)/u.exec(page.url())?.[1];
    expect(formId, 'Formular-Id aus der Adresse').toBeDefined();

    try {
      /* 2 — Two questions, via the type list. */
      await tabTo(
        page,
        page.getByRole('button', { name: 'Text', exact: true }),
        'Fragetyp „Text"',
      );
      await page.keyboard.press('Enter');
      await tabTo(
        page,
        page.getByLabel('Fragetext'),
        'Fragetext der ersten Frage',
      );
      await page.keyboard.type('Name des Mitglieds');

      // Mandatory field — with the space bar, the way a checkbox is operated.
      await tabTo(page, page.getByLabel('Pflichtfeld'), '„Pflichtfeld"');
      await page.keyboard.press('Space');
      await expect(page.getByLabel('Pflichtfeld')).toBeChecked();

      await tabTo(
        page,
        page.getByRole('button', { name: '+ Weitere Frage' }),
        '„+ Weitere Frage"',
      );
      await page.keyboard.press('Enter');
      await tabTo(
        page,
        page.getByRole('button', { name: 'Text', exact: true }),
        'Fragetyp „Text" für die zweite Frage',
      );
      await page.keyboard.press('Enter');
      await tabTo(
        page,
        page.getByLabel('Fragetext'),
        'Fragetext der zweiten Frage',
      );
      await page.keyboard.type('Bemerkung');

      const cards = page.getByTestId('question-card');
      await expect(cards).toHaveCount(2);
      await expect(cards.first()).toContainText('Name des Mitglieds');

      /* 3 — Reordering by grip, without a single pointer gesture. */
      const grip = page.getByRole('button', { name: 'Frage 2 verschieben' });
      await tabTo(page, grip, 'Griff der zweiten Frage');

      // Lifting. The grip announces it — and **keeps the focus**, otherwise the
      // arrow keys would afterwards go to the page instead of the lifted element.
      await page.keyboard.press('Space');
      await expect(
        page.getByRole('status').filter({ hasText: /Frage 2 angehoben/u }),
      ).toHaveCount(1);
      await expect(
        grip,
        'Nach dem Anheben muss der Fokus auf dem Griff bleiben: die ' +
          'Pfeiltasten gehören ab hier dem angehobenen Element.',
      ).toBeFocused();

      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('Enter');

      await expect(
        page.getByRole('status').filter({ hasText: /abgelegt an Position 1/u }),
        'Das Ablegen wird angesagt, mit der Position — sonst weiß niemand ' +
          'ohne Blick auf den Schirm, wo die Frage gelandet ist.',
      ).toHaveCount(1);
      await expect(
        cards.first(),
        'Und die Reihenfolge hat sich wirklich geändert. Eine Zusicherung nur ' +
          'auf die Ansage bliebe grün, wenn nichts umsortiert würde.',
      ).toContainText('Bemerkung');

      /* 4 — Saving and publishing. */
      await tabTo(
        page,
        page.getByRole('button', { name: 'Speichern', exact: true }),
        '„Speichern"',
      );
      await page.keyboard.press('Enter');
      await expectSaved(page);

      const publish = page.getByRole('button', { name: 'Veröffentlichen' });
      await tabTo(page, publish, '„Veröffentlichen"');
      await page.keyboard.press('Enter');
      await expect(
        page.getByText(/Veröffentlicht \(Fassung 1\)/u),
      ).toBeVisible();

      const address = await page
        .getByRole('link', { name: /\/f\//u })
        .getAttribute('href');
      expect(address).toMatch(/^https?:\/\/[^/]+\/f\/[A-Za-z0-9_-]+$/u);
      const publicPath = new URL(address ?? '').pathname;

      /* 5 — Filling in publicly, without a session and without a mouse. */
      const guestContext = await browser.newContext();
      const guest = await guestContext.newPage();
      try {
        await guest.goto(publicPath);
        await expect(
          guest.getByRole('heading', { level: 1, name: title }),
        ).toBeVisible();

        await tabTo(
          guest,
          guest.getByLabel(/Name des Mitglieds/u),
          'Pflichtfeld der Ausfüllansicht',
        );
        await guest.keyboard.type('Anton Aktiv');
        await tabTo(
          guest,
          guest.getByLabel(/^Bemerkung/u),
          'zweites Feld der Ausfüllansicht',
        );
        await guest.keyboard.type('Kommt mit dem Zug.');

        await tabTo(
          guest,
          guest.getByRole('button', { name: 'Absenden' }),
          '„Absenden"',
        );
        await guest.keyboard.press('Enter');
        await expect(
          guest.getByRole('heading', { level: 1, name: 'Vielen Dank!' }),
        ).toBeVisible();
      } finally {
        await guestContext.close();
      }

      /* 6 — The modal: the focus stays inside, Escape gives it back.

         The notice appears on **re-**publishing, when answers
         exist and the questions have changed (`needsPublishNotice`) —
         that is, exactly here, after the submission above and a deleted
         question. That is no detour for the test: it is the place where the
         application opens a modal of its own accord.

         ⚠️ Since ADR-0028 there is a **second** reason for the same modal:
         incomplete legal texts of the organisation. The setup above stays
         standing all the same — it is the reason meant here, and the
         assertion „Es liegt bereits 1 Antwort vor." below would otherwise hang on
         nothing. The first publication in step 4 still does not hit the
         modal: `onPublishRequested` sends it out without a preview
         as long as `form.status !== 'active'`. */
      await page.reload();
      await tabTo(
        page,
        page.getByRole('button', { name: 'Frage 2 löschen' }),
        'Löschknopf der zweiten Frage',
      );
      await page.keyboard.press('Enter');
      await expect(cards).toHaveCount(1);

      await tabTo(
        page,
        page.getByRole('button', { name: 'Speichern', exact: true }),
        '„Speichern" nach dem Löschen',
      );
      await page.keyboard.press('Enter');
      await expectSaved(page);

      const republish = page.getByRole('button', {
        name: 'Erneut veröffentlichen',
      });
      await tabTo(page, republish, '„Erneut veröffentlichen"');
      await page.keyboard.press('Enter');

      const notice = page.getByRole('dialog');
      await expect(
        notice,
        'Ein zweites Veröffentlichen über eine vorhandene Antwort hinweg ' +
          'fragt nach — das ist das Modal dieses Nachweises.',
      ).toBeVisible();
      await expect(notice).toContainText('Es liegt bereits 1 Antwort vor.');

      // The focus is **in** the modal, right on opening.
      await expectFocusInside(notice, 'Veröffentlichen-Hinweis beim Öffnen');

      // …and it stays inside, even beyond the edge.
      await expectFocusStaysInside(page, notice, 6, 'Veröffentlichen-Hinweis');

      // Escape closes, and the focus comes back to the button that opened it
      // — not to `<body>`, where the next tab would begin from the start.
      await page.keyboard.press('Escape');
      await expect(notice).toHaveCount(0);
      await expect(
        republish,
        'Nach dem Schließen gehört der Fokus dem Knopf, der das Modal ' +
          'geöffnet hat.',
      ).toBeFocused();

      // And once more, this time to the end: confirming, with the keyboard.
      await page.keyboard.press('Enter');
      await expect(notice).toBeVisible();
      await tabTo(
        page,
        notice.getByRole('button', { name: 'Erneut veröffentlichen' }),
        'Bestätigen im Modal',
      );
      await page.keyboard.press('Enter');
      await expect(notice).toHaveCount(0);
      await expect(
        page.getByText(/Veröffentlicht \(Fassung 2\)/u),
      ).toBeVisible();

      /* 7 — Evaluating: via the navigation, not via an address. */
      await tabTo(
        page,
        // The accessible name is „Antworten" alone: the character in front of it
        // is `aria-hidden` (`FormNav`), so it stands in the visible text and not
        // in the name. `exact`, because Playwright matches names as a
        // substring — „Antworten gesamt" of the dashboard tile is called
        // something else, but the next caption with this word would be one again.
        page.getByRole('button', { name: 'Antworten', exact: true }),
        '„Antworten" in der Unterleiste',
      );
      await page.keyboard.press('Enter');
      await expect(
        page.getByRole('heading', { level: 1, name: /Antworten/u }),
      ).toBeVisible();
      await expect(
        page.getByRole('cell', { name: 'Anton Aktiv' }),
      ).toBeVisible();

      /* 8 — Exporting, including the format choice. */
      const exportButton = page.getByRole('button', { name: /Export/u });
      await tabTo(page, exportButton, '„Export"');
      await page.keyboard.press('Enter');

      const menu = page.getByRole('group', { name: 'Export' });
      await expect(menu).toBeVisible();
      await expect(exportButton).toHaveAttribute('aria-expanded', 'true');

      /*
        The column choice — with the arrow keys, the way a radio group is
        operated. The default is „Alle Spalten" , so the press that
        changes something is the one upwards.
      */
      const allColumns = menu.getByRole('radio', { name: /Alle Spalten/u });
      const shownColumns = menu.getByRole('radio', {
        name: /Angezeigte Spalten/u,
      });
      await expect(allColumns).toBeChecked();

      await tabTo(page, allColumns, 'Radiogruppe der Spaltenwahl');
      await page.keyboard.press('ArrowUp');
      await expect(
        shownColumns,
        'Die Pfeiltaste muss die Wahl umstellen — das ist die Bedienung ' +
          'einer Radiogruppe ohne Maus.',
      ).toBeChecked();
      await expect(shownColumns).toBeFocused();

      await page.keyboard.press('ArrowDown');
      await expect(allColumns).toBeChecked();

      // And the format: what is measured is the **file**, not the entry.
      const excel = menu.getByRole('link', { name: /Excel/u });
      await tabTo(page, excel, '„Excel" im Export-Menü');
      const started = page.waitForEvent('download');
      await page.keyboard.press('Enter');
      const download = await started;
      expect(
        download.suggestedFilename(),
        'Der mit der Tastatur gewählte Eintrag muss eine Excel-Datei ' +
          'liefern — der Dateiname ist das, was ankommt.',
      ).toMatch(/\.xlsx$/u);
    } finally {
      await purgeForm(page, formId);
    }
  });

  /**
   * **A *saved* question can be opened without a mouse** — review finding,
   * WCAG 2.1.1 Level A.
   *
   * ⚠️ **Why the cases above did not see this for four runs:**
   * they create their questions within the same case, and `addQuestion` selects
   * the new question **itself** — the properties stand open afterwards without
   * anybody having had to touch the card. The route an editor takes the
   * day after (open form, edit an existing question) occurred in
   * no case at all. That is why this one reloads the form **anew** before it
   * looks for the question: that is the difference between „angelegt" and
   * „gespeichert", and it is the whole case.
   *
   * Until 2026-08-12 `selectQuestion` hung solely on the `onClick` of a
   * role-less `<li>`; caption, options, mandatory flag and conditional
   * display were unreachable without a mouse.
   */
  test('eine gespeicherte Frage geht ohne Maus auf', async ({ page }) => {
    const title = `Tastatur-Auswahl ${Date.now().toString(36)}`;

    await page.goto('/');
    await tabTo(
      page,
      page.getByLabel('Name des neuen Formulars'),
      'Namensfeld',
    );
    await page.keyboard.type(title);
    await tabTo(
      page,
      page.getByRole('button', { name: '+ Neues Formular' }),
      '„+ Neues Formular"',
    );
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Formularname')).toHaveValue(title);
    const formId = /\/forms\/([^/?#]+)/u.exec(page.url())?.[1];

    try {
      // Create a question and **save** it — from here on it is „vorhanden".
      await tabTo(
        page,
        page.getByRole('button', { name: 'Text', exact: true }),
        'Fragetyp „Text"',
      );
      await page.keyboard.press('Enter');
      await tabTo(page, page.getByLabel('Fragetext'), 'Fragetext');
      await page.keyboard.type('Name des Mitglieds');
      await tabTo(
        page,
        page.getByRole('button', { name: 'Speichern', exact: true }),
        '„Speichern"',
      );
      await page.keyboard.press('Enter');
      await expectSaved(page);

      // **Reload.** Afterwards nothing is selected, the properties are
      // closed — the state in which an editor finds a form.
      await page.reload();
      await expect(page.getByTestId('question-card')).toHaveCount(1);
      await expect(
        page.getByLabel('Fragetext'),
        'Nach dem Neuladen darf keine Frage ausgewählt sein — sonst misst ' +
          'dieser Fall dieselbe Bequemlichkeit wie die Fälle darüber.',
      ).toHaveCount(0);

      const opener = page.getByRole('button', { name: /bearbeiten$/ });
      await tabTo(page, opener, 'der Auswahl-Knopf der Fragekarte');
      await page.keyboard.press('Enter');

      // And now what was previously unreachable without a mouse stands open.
      await expect(
        page.getByLabel('Fragetext'),
        'Ohne Maus muss die gespeicherte Frage aufgehen (WCAG 2.1.1).',
      ).toHaveValue('Name des Mitglieds');
    } finally {
      await purgeForm(page, formId);
    }
  });
});

/* --- The mobile sheets --------------------------------------------------- */

test.describe('Mobil-Sheets ohne Maus ', () => {
  /**
   * **360 px, set in the file** — as `builder-drag` and `notifications`
   * do it. Below 1180 px the desktop's sub-bar does not exist;
   * what exists instead are two sheets, and both are modals in
   * this sense. The width stands here because the reasoning for it stands
   * here.
   */
  test.use({ viewport: { width: 360, height: 740 }, hasTouch: true });

  test('das Off-Canvas-Menü öffnet, hält den Fokus und gibt ihn zurück', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'Dashboard', level: 1 }),
    ).toBeVisible();

    const hamburger = page.getByRole('button', { name: 'Menü öffnen' });
    await tabTo(page, hamburger, '„Menü öffnen"');
    await page.keyboard.press('Enter');

    const sheet = page.getByRole('dialog', { name: 'Menü' });
    await expect(sheet).toBeVisible();
    await expectFocusInside(sheet, 'Off-Canvas-Menü beim Öffnen');

    await expectFocusStaysInside(page, sheet, 12, 'Off-Canvas-Menü');

    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(
      hamburger,
      'Nach dem Schließen gehört der Fokus dem Knopf, der geöffnet hat.',
    ).toBeFocused();
  });

  test('das Eigenschaften-Sheet des Builders ist mit der Tastatur zu öffnen und zu schließen', async ({
    page,
  }) => {
    const title = `Tastatur-Sheet ${Date.now().toString(36)}`;

    await page.goto('/');
    await tabTo(
      page,
      page.getByLabel('Name des neuen Formulars'),
      'Namensfeld',
    );
    await page.keyboard.type(title);
    await tabTo(
      page,
      page.getByRole('button', { name: '+ Neues Formular' }),
      '„+ Neues Formular"',
    );
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Formularname')).toHaveValue(title);
    const formId = /\/forms\/([^/?#]+)/u.exec(page.url())?.[1];

    try {
      const trigger = page.getByRole('button', { name: 'Eigenschaften' });
      await tabTo(page, trigger, '„Eigenschaften"');
      await page.keyboard.press('Enter');

      const sheet = page.getByRole('dialog', { name: 'Eigenschaften' });
      await expect(
        sheet,
        'Unterhalb von 1180 px ist die Eigenschaften-Spalte ein Sheet ' +
          ' — und es muss über die Tastatur aufgehen.',
      ).toBeVisible();

      // Create a question, without a mouse, out of the sheet.
      await tabTo(
        page,
        sheet.getByRole('button', { name: 'Text', exact: true }),
        'Fragetyp „Text" im Sheet',
      );
      await page.keyboard.press('Enter');
      await tabTo(page, page.getByLabel('Fragetext'), 'Fragetext im Sheet');
      await page.keyboard.type('Name des Mitglieds');

      const close = page.getByRole('button', { name: 'Schließen' });
      await tabTo(page, close, '„Schließen" des Sheets');
      await page.keyboard.press('Enter');
      await expect(sheet).toHaveCount(0);

      await expect(page.getByTestId('question-card')).toHaveCount(1);
      await expect(saveState(page)).toHaveText('Nicht gespeichert');
    } finally {
      await purgeForm(page, formId);
    }
  });

  /**
   * **The trap of this sheet — added afterwards, because the case above stayed
   * green without it.**
   *
   * The builder's sheet was the **only** one of this application's eight overlays
   * without `useFocusTrap`: Tab ran out of it into the page
   * behind, and Escape did not close it. The case above did not
   * see that, because it only demands „Öffnen und Schließen" and both went via the
   * button — what found it was the **comparison** with the seven others,
   * not a red test. This assertion is the red test.
   *
   * Both of the things that make up a trap are measured, and both at the **place of
   * the focus**: that it does not leave the sheet after any number of tabs, and
   * that Escape closes it **and** gives the focus back to the trigger. An
   * assertion that only checks „das Sheet ist zu" would stay green while the
   * focus stands in nothing.
   */
  test('das Sheet des Builders hält den Fokus und schließt mit Escape', async ({
    page,
  }) => {
    const title = `Tastatur-Kaefig ${Date.now().toString(36)}`;

    await page.goto('/');
    await tabTo(
      page,
      page.getByLabel('Name des neuen Formulars'),
      'Namensfeld',
    );
    await page.keyboard.type(title);
    await tabTo(
      page,
      page.getByRole('button', { name: '+ Neues Formular' }),
      '„+ Neues Formular"',
    );
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Formularname')).toHaveValue(title);
    const formId = /\/forms\/([^/?#]+)/u.exec(page.url())?.[1];

    try {
      const trigger = page.getByRole('button', { name: 'Seiten' });
      await tabTo(page, trigger, '„Seiten"');
      await page.keyboard.press('Enter');

      const sheet = page.getByRole('dialog', { name: 'Seiten' });
      await expect(sheet).toBeVisible();

      // **Twenty tabs.** The sheet carries far fewer focusable
      // elements, so the focus wraps around several times — and that is exactly the
      // statement: without a trap it would long since be in the page behind.
      for (let step = 0; step < 20; step += 1) {
        await page.keyboard.press('Tab');
        // `focusIsInside` and no second helper beside it: it includes the
        // panel **itself**, and that is exactly the interesting case here
        // (see its reasoning — `panel.locator(':focus')` only looks for
        // descendants and once reported „verlassen" for an exemplarily
        // trapped modal).
        expect(
          await focusIsInside(sheet),
          `Nach ${String(step + 1)} × Tab hat der Fokus das Sheet verlassen.`,
        ).toBe(true);
      }

      await page.keyboard.press('Escape');
      await expect(
        sheet,
        'Escape schließt das Sheet — der einzige Weg hinaus war einmal der ' +
          'Knopf „Schließen".',
      ).toHaveCount(0);
      // And the focus stands again where it came from: a closed sheet
      // that leaves the focus in nothing is, for keyboard operation,
      // the same as a sheet that does not close.
      await expect(trigger).toBeFocused();
    } finally {
      await purgeForm(page, formId);
    }
  });
});
