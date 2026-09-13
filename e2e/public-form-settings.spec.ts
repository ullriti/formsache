import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  addQuestion,
  expectSaved,
  newForm,
  publishAndReadPath,
  saveForm,
  openFormSettings,
} from './app-flows';
import { webBaseUrl } from './env';
import { authStateFile } from './seed-account';

/**
 * What the settings **do** on the public form (the requirements).
 *
 * `form-settings.spec.ts` next door covers the editor's side: that a section
 * can be taken over, that a locked field stores nothing, that a deadline
 * survives a reload. None of that says whether a participant ever sees the
 * result — and for a while they did not: the server sent the
 * *Darstellung* flags, the shared wire schema did not carry them, and the
 * client's parser dropped what it did not know. The settings were saved
 * correctly and changed nothing on screen.
 *
 * So every case below spans both sides in one run: the editor sets a switch,
 * and a **session-less second browser context** opens the public address and
 * looks. That second context is not decoration — a participant has no account
 * , and a page that inherited the editor's cookie would prove
 * nothing about what a stranger sees.
 *
 * **Desktop only** (`playwright.config.ts`), for the reason `core-flow` runs
 * there alone: each case writes a form, a published version and — in the
 * confirmation cases — a response into the shared database, and nothing
 * asserted here is a measurement of width. The mobile half of this view is
 * covered by `public-form-rows.spec.ts`.
 */

test.use({ storageState: authStateFile });

const NAME_LABEL = 'Name des Mitglieds';

/**
 * A published two-page form, and the public path it can be filled in at.
 *
 * Two pages, because that is the precondition of the progress block at all: a
 * one-page form reports no progress, whatever the flags say, and a fixture with
 * one page would make every progress-display case below pass for the wrong
 * reason.
 */
async function publishedTwoPageForm(page: Page, base: string): Promise<string> {
  await newForm(page, base);

  await addQuestion(page, 'Text', NAME_LABEL);
  await page.getByLabel('Pflichtfeld').check();

  await page.getByRole('button', { name: '+ Seite hinzufügen' }).click();
  await addQuestion(page, 'Text', 'Bemerkung');

  await saveForm(page);
  return publishAndReadPath(page);
}

/** A published one-page form — enough for the confirmation cases. */
async function publishedForm(page: Page, base: string): Promise<string> {
  await newForm(page, base);
  await addQuestion(page, 'Text', NAME_LABEL);
  await page.getByLabel('Pflichtfeld').check();
  await saveForm(page);
  return publishAndReadPath(page);
}

/**
 * Opens the settings page of the form the builder currently shows.
 *
 * Via `openFormSettings` and no longer via the button in the builder bar: that
 * one is gone since review finding 18, and the way there now depends on the
 * layout (subheader or off-canvas menu).
 */
async function openSettings(page: Page): Promise<void> {
  await openFormSettings(page);
}

function sectionCard(page: Page, heading: string): Locator {
  return page.getByRole('region', { name: heading });
}

/** Takes a section over, which is what unlocks its controls. */
async function customise(page: Page, heading: string): Promise<void> {
  await sectionCard(page, heading)
    .getByRole('radio', { name: 'Angepasst' })
    .check();
}

async function save(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Speichern', exact: true }).click();
  // Not the disabled button: it is disabled while the request is in flight too.
  await expectSaved(page);
}

/**
 * Sets the three *Darstellung* switches and saves.
 *
 * All three every time, explicitly: a case that only touched the switch it is
 * about would inherit the other two from the organisation's standard, and an organisation
 * standard somebody changes later would silently move what these tests assert.
 */
async function setDisplay(
  page: Page,
  flags: {
    progress: boolean;
    pageNumbers: boolean;
    requiredHint: boolean;
  },
): Promise<void> {
  await openSettings(page);
  await customise(page, 'Darstellung');

  const display = sectionCard(page, 'Darstellung');
  const switches: [string, boolean][] = [
    ['Fortschrittsbalken anzeigen', flags.progress],
    ['Seitennummern anzeigen', flags.pageNumbers],
    ['Hinweis auf Pflichtfelder', flags.requiredHint],
  ];
  for (const [name, on] of switches) {
    await display.getByRole('switch', { name }).setChecked(on);
  }

  await save(page);
}

test.describe('Darstellung wirkt beim Ausfüllen', () => {
  test('shows the page numbers without the bar when only the bar is off', async ({
    page,
    browser,
  }) => {
    const publicPath = await publishedTwoPageForm(page, 'Nur Nummern');
    await setDisplay(page, {
      progress: false,
      pageNumbers: true,
      requiredHint: true,
    });

    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);
      await expect(guest.getByText('Seite 1 von 2')).toBeVisible();
      // The two flags are independent; one switch may not carry the other.
      await expect(guest.getByRole('progressbar')).toHaveCount(0);
    } finally {
      await guestContext.close();
    }
  });

  test('shows the bar without the page numbers when only the numbers are off', async ({
    page,
    browser,
  }) => {
    const publicPath = await publishedTwoPageForm(page, 'Nur Balken');
    await setDisplay(page, {
      progress: true,
      pageNumbers: false,
      requiredHint: true,
    });

    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);
      await expect(guest.getByRole('progressbar')).toBeVisible();
      await expect(guest.getByText('Seite 1 von 2')).toHaveCount(0);
      // Gone from the page, still in the accessible tree — otherwise a screen
      // reader is left with „1 von 2" and no subject.
      await expect(guest.getByRole('progressbar')).toHaveAttribute(
        'aria-valuetext',
        /^Seite 1 von 2/u,
      );
    } finally {
      await guestContext.close();
    }
  });

  test('hides both halves when the editor turned both off', async ({
    page,
    browser,
  }) => {
    const publicPath = await publishedTwoPageForm(page, 'Ohne Fortschritt');
    await setDisplay(page, {
      progress: false,
      pageNumbers: false,
      requiredHint: false,
    });

    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);
      await expect(guest.getByRole('progressbar')).toHaveCount(0);
      await expect(guest.getByText('Seite 1 von 2')).toHaveCount(0);
      // The third flag, off in the same run.
      await expect(guest.getByRole('note')).toHaveCount(0);
      // …and the form is still a form: hiding the legend does not stop the
      // field from being required.
      await guest.getByRole('button', { name: 'Weiter' }).click();
      await expect(guest.getByText('Pflichtfeld.')).toBeVisible();
    } finally {
      await guestContext.close();
    }
  });

  test('shows the required-field hint when it is switched on', async ({
    page,
    browser,
  }) => {
    const publicPath = await publishedTwoPageForm(page, 'Mit Pflichthinweis');
    await setDisplay(page, {
      progress: true,
      pageNumbers: true,
      requiredHint: true,
    });

    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);
      // The wording is the handoff's — „Zeigt ‚* Pflichtfeld' oben im
      // Formular" — star included.
      await expect(guest.getByRole('note')).toHaveText('* Pflichtfeld');
    } finally {
      await guestContext.close();
    }
  });
});

/**
 * **The deadline line above the form** (finding 32).
 *
 * The server sends `closesAt` along as long as a form is open — „so a
 * participant sees the deadline they are working against" —, and in the filling
 * path nobody redeemed that for years. Since finding 32 a muted line stands
 * below the title (`data-testid="public-deadline"`).
 *
 * **Two cases, and the second is the one that can go red.** A form *without* a
 * deadline must not carry the line: a line that stands on every page and never
 * says anything is not information. Without that counter-case a line that is
 * always there would be just as green here.
 *
 * **What is not run here**, and deliberately so: the *expiry* of the deadline
 * while filling in. That needs a set clock, and it has one — with fake timers
 * in `FormDeadline.test.tsx`, where a deadline can be reached to the second. An
 * E2E case would have to either wait for it (which this suite does not do) or
 * put a deadline seconds into the future, which would amount to „depends on the
 * clock of the run".
 *
 * The point in time is therefore **fixed and far away from today** — the same
 * test quantity as in `form-settings.spec.ts`, for the same reason and with the
 * same justification for August: in the winter half-year the zone would read
 * MEZ and the assertion would no longer hold.
 */
test.describe('Frist und Zeitlimit beim Ausfüllen', () => {
  const CLOSE_LOCAL = '2030-08-15T18:00';
  const CLOSE_SHOWN = '15.08.2030, 18:00 Uhr MESZ';

  /** The line itself — it carries no role, it is a paragraph with a marker. */
  function deadlineLine(page: Page): Locator {
    return page.getByTestId('public-deadline');
  }

  test('ein Formular ohne Frist und ohne Zeitlimit zeigt keine Zeile', async ({
    page,
    browser,
  }) => {
    const publicPath = await publishedForm(page, 'Ohne Frist');

    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);
      /*
        The positive control first, and it is no decoration here: „no element
        with this marker" is true of a page that is still loading and of one
        that rendered nothing at all. Only once the field is there does the
        absence below it say anything about *this* form.
      */
      await expect(guest.getByLabel(new RegExp(NAME_LABEL, 'u'))).toBeVisible();
      await expect(
        deadlineLine(guest),
        'Ein Formular ohne Frist und ohne Zeitlimit hat über den Feldern ' +
          'nichts zu sagen. Eine Zeile, die trotzdem steht, wäre auf fast ' +
          'jedem Formular dieser Anwendung eine leere Unterbrechung.',
      ).toHaveCount(0);
    } finally {
      await guestContext.close();
    }
  });

  test('ein Formular mit Frist und Zeitlimit nennt beide über den Feldern', async ({
    page,
    browser,
  }) => {
    const publicPath = await publishedForm(page, 'Mit Frist');

    await openSettings(page);
    /*
      Without `customise`: *Verfügbarkeit* is the only section without an
      inheritance switch — a deadline belongs to the form, and no organisation
      can prescribe it (`form-settings.spec.ts` measures exactly that).
    */
    const availability = sectionCard(page, 'Verfügbarkeit');
    await availability
      .getByRole('switch', { name: 'Anmeldefrist festlegen' })
      .check();
    await availability.getByLabel('Schließt am').fill(CLOSE_LOCAL);
    await availability
      .getByRole('switch', { name: 'Zeitlimit pro Ausfüllung' })
      .check();
    /*
      `getByRole('spinbutton', …)` and not `getByLabel('Zeitlimit')`: the
      switch above it is called „Zeitlimit pro Ausfüllung", and `getByLabel`
      compares as a substring — both controls would be hit.

      **45 and not 30.** The field already stands at 30 when it is switched on,
      and an assertion on „30 Minuten" would be green even if this case had
      never set the value.
    */
    await availability
      .getByRole('spinbutton', { name: 'Zeitlimit' })
      .fill('45');
    await save(page);

    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);
      const line = deadlineLine(guest);
      await expect(line).toBeVisible();

      /*
        The exact wording, not merely „something is there": the line is a
        piece of information, and one that names the wrong point in time would
        be worse than none. The zone is part of the text because a time whose
        zone has to be guessed becomes contentious between two organisations.
      */
      await expect(line).toContainText(
        `Dieses Formular kann noch bis ${CLOSE_SHOWN} ausgefüllt und abgesendet werden.`,
      );
      await expect(
        line,
        'Beide Grenzen stehen in **einer** Zeile — es ist eine einzige ' +
          'Auskunft („wie lange habe ich"), und zwei Absätze übereinander ' +
          'wären zweimal dieselbe Unterbrechung über den Feldern.',
      ).toContainText(
        'Für das Ausfüllen stehen ab dem Öffnen dieser Seite 45 Minuten zur Verfügung.',
      );

      // And the form is open: the line says what one is working against, it
      // is not the refusal shown for a closed form.
      await expect(guest.getByLabel(new RegExp(NAME_LABEL, 'u'))).toBeVisible();
      await expect(
        guest.getByRole('button', { name: 'Absenden' }),
      ).toBeVisible();
    } finally {
      await guestContext.close();
    }
  });
});

test.describe('Bestätigung und Weiterleitung (effektive Einstellungen)', () => {
  const TITLE = 'Danke, Mitglied';
  const MESSAGE = 'Die Anmeldung ist beim Sekretariat eingegangen.';

  /** Sets the confirmation texts, and optionally a redirect, then saves. */
  async function setConfirmation(
    page: Page,
    redirect: { url: string; delaySec: number } | null,
  ): Promise<void> {
    await openSettings(page);
    await customise(page, 'Nach dem Absenden');

    const confirm = sectionCard(page, 'Nach dem Absenden');
    await confirm.getByLabel('Titel der Bestätigungsseite').fill(TITLE);
    await confirm.getByLabel('Nachricht').fill(MESSAGE);

    await confirm
      .getByRole('switch', { name: 'Nach Absenden weiterleiten' })
      .setChecked(redirect !== null);
    if (redirect !== null) {
      await confirm.getByLabel('Ziel-URL').fill(redirect.url);
      await confirm.getByLabel('Verzögerung').fill(String(redirect.delaySec));
    }

    await save(page);
  }

  test('shows the configured texts and stays put without a redirect', async ({
    page,
    browser,
  }) => {
    const publicPath = await publishedForm(page, 'Bestätigung ohne Ziel');
    await setConfirmation(page, null);

    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);
      await guest.getByLabel(new RegExp(NAME_LABEL, 'u')).fill('Anton Aktiv');
      await guest.getByRole('button', { name: 'Absenden' }).click();

      // The configured title, not the original fixed „Vielen Dank!".
      await expect(
        guest.getByRole('heading', { level: 1, name: TITLE }),
      ).toBeVisible();
      await expect(guest.getByText(MESSAGE)).toBeVisible();
      await expect(guest.getByText(/Weiterleitung in/u)).toHaveCount(0);

      // Still on the form's own address a moment later — „no redirect" is a
      // claim about what does *not* happen, so it needs a moment to not happen.
      await guest.waitForTimeout(1_500);
      expect(new URL(guest.url()).pathname).toBe(publicPath);
    } finally {
      await guestContext.close();
    }
  });

  test('counts down and then leaves for the configured target', async ({
    page,
    browser,
  }) => {
    const publicPath = await publishedForm(page, 'Bestätigung mit Ziel');
    // The application's own origin as the target: a real external address
    // would make this case depend on somebody else's server being up, and the
    // assertion is about *leaving*, not about where to.
    const target = new URL('/', webBaseUrl).href;
    await setConfirmation(page, { url: target, delaySec: 3 });

    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);
      await guest.getByLabel(new RegExp(NAME_LABEL, 'u')).fill('Anton Aktiv');
      await guest.getByRole('button', { name: 'Absenden' }).click();

      // The receipt first — the answer is stored, and leaving before it is
      // readable would take the acknowledgement off the screen.
      await expect(
        guest.getByRole('heading', { level: 1, name: TITLE }),
      ).toBeVisible();
      await expect(
        guest.getByText(/^Weiterleitung in \d+ Sekunden? …$/u),
      ).toBeVisible();

      await guest.waitForURL(target, { timeout: 15_000 });
      expect(guest.url()).toBe(target);
    } finally {
      await guestContext.close();
    }
  });
});

/**
 * **The legal footer and the pages it points to** (ADR-0028).
 *
 * ## Why this stands here and not in a file of its own
 *
 * It belonged in a `legal-pages.spec.ts`. In this suite, though, a new file
 * only becomes a test case once it stands in a `testMatch` alternation of
 * `playwright.config.ts` — `smoke-suite-coverage.spec.ts` next door tells
 * what it cost to forget that once. This rework was allowed to touch
 * `e2e/**` only; creating a file that runs in no project and still reports
 * green would be exactly the mistake that guard is built against. It therefore
 * stands where the question is asked anyway: **what a stranger sees on a
 * published page**.
 *
 * ## What is shown here
 *
 * 1. The footer stands below the filling view **and** below the confirmation
 *    page, with **two labelled** groups. The labelling is the achievement and
 *    not the link: „Impressum | Impressum"
 *    side by side told nobody who a request for information goes to
 *    (Art. 13 Abs. 1 lit. a DSGVO).
 * 2. `/imprint` answers **without a session**. § 18 Abs. 1 MStV demands
 *    „ständig verfügbar"; a login mask in front of it would be no imprint.
 * 3. A page without stored text **says so**. That is the actual assertion of
 *    this block: silence would be the one wrong answer, an invented substitute
 *    text the other and a left-over `[[…]]` the
 *    third.
 *
 * **The test database is in exactly this state**, and without any doing: the
 * migration `20260819090000_legal_pages` creates `system_setting.legal_pages`
 * and `tenant.legal_pages` as `NULL` and backfills nothing, the seed writes
 * nothing into them. The empty state here is therefore the seeded one and is
 * not produced on purpose — which also means that these cases write nothing.
 */
test.describe('Rechtliche Fußzeile und Rechtstextseiten ', () => {
  /** The footer, by its name — it is navigation, not a landmark. */
  function legalFooter(guest: Page): Locator {
    return guest.getByRole('navigation', { name: 'Rechtliche Angaben' });
  }

  /**
   * The two labelled groups and their links, in one place.
   *
   * As a function and not typed out three times: the footer stands below three
   * views, and three copies would be three occasions to forget one half on the
   * fourth — exactly the construction that `PublicLegalFooter` justifies for
   * itself.
   */
  async function expectLabelledFooter(
    guest: Page,
    where: string,
    options: { readonly organisationNamed?: boolean } = {},
  ): Promise<void> {
    const footer = legalFooter(guest);
    await expect(footer, `${where}: die Fußzeile fehlt.`).toBeVisible();

    /*
      The organisation first — it is the controller for the data that is about
      to be collected.

      **With the name where the view knows it, and without it where it does
      not.** The filling view gets it from the form response and passes it
      through; the legal page of an organisation knows only the short name from
      the address, and `PublicLegalFooter` then deliberately lets the label
      stand alone — „guessing the name" would not be true. This
      distinction is **demanded** here and not left out: an assertion that never
      requires the name would be green even if it were missing
      everywhere, and it is precisely the name that is the information from
      Art. 13 Abs. 1 lit. a DSGVO.

      Which name stands there is not written down — the seed decides that.
      Required is „there and not empty".
    */
    /*
      **Ohne Doppelpunkt seit Review-Runde 3 Nr. 8.** Der Name stand mit
      Doppelpunkt an der Beschriftung und passte damit auf keiner Breite in
      dieselbe Zeile versal gesetzten Kleindrucks; er steht jetzt als eigener
      Block darunter, und der zugängliche Name der Überschrift ist die
      Verkettung beider — mit einem Leerzeichen dazwischen.
    */
    await expect(
      footer.getByRole('heading', {
        name:
          options.organisationNamed === false
            ? /^Verantwortlich für dieses Formular$/u
            : /^Verantwortlich für dieses Formular\s+\S/u,
      }),
      `${where}: die Beschriftung der Organisationsgruppe stimmt nicht. ` +
        'Erwartet war „Verantwortlich für dieses Formular"' +
        (options.organisationNamed === false
          ? ' ohne Namen — diese Ansicht kennt nur den Kurznamen aus der Adresse.'
          : ' mit dem Namen der Organisation dahinter; ohne ihn weiß eine ' +
            'teilnehmende Person nicht, an wen sie sich mit einem ' +
            'Auskunftsersuchen wendet.'),
    ).toBeVisible();
    await expect(
      footer.getByRole('heading', { name: 'Betrieb dieser Plattform' }),
      `${where}: die Gruppe des Betriebs fehlt. Eine Organisation kann unter ` +
        'eigener Adresse laufen und ist dann selbst Diensteanbieterin — nur ' +
        'das beschriftete Paar stimmt unter beiden Adressen.',
    ).toBeVisible();

    /*
      The links **stand** even though nothing is stored. That is the explicit
      decision from `docs/legal/README.md` 5.4: a missing imprint is a
      violation with or without a link, only with a link is it remediable. A
      case that required the links only after the texts had been filled in
      would leave exactly the state unchecked in which it matters.
    */
    for (const name of [
      'Anbieterangaben',
      'Datenschutzhinweise',
      'Impressum',
      'Datenschutz',
      'Lizenzen',
    ]) {
      await expect(
        footer.getByRole('link', { name, exact: true }),
        `${where}: der Link „${name}" fehlt. Er steht auch dann, wenn die ` +
          'Seite dahinter leer ist — ein fehlender Link macht den Mangel ' +
          'unsichtbar.',
      ).toHaveCount(1);
    }
  }

  /**
   * No trace of a login on the page.
   *
   * The same construction as in `core-flow.spec.ts` („No login anywhere on the
   * way in"), and for the same reason: „the page loads" would be true even if
   * the login mask had loaded.
   */
  async function expectNoLogin(guest: Page, where: string): Promise<void> {
    await expect(
      guest.getByLabel('E-Mail-Adresse'),
      `${where}: hier steht ein Anmeldefeld.`,
    ).toHaveCount(0);
    await expect(
      guest.getByRole('button', { name: 'Anmelden' }),
      `${where}: hier steht ein Anmeldeknopf.`,
    ).toHaveCount(0);
  }

  /**
   * **No `[[PLATZHALTER]]` leaves the renderer** — on none of the pages.
   *
   * Measured against the text of the whole page and not against one element:
   * the defect this stands against is a placeholder *somewhere* in the running
   * text, and that is exactly what an assertion on a particular element would
   * overlook.
   */
  async function expectNoRawPlaceholder(
    guest: Page,
    where: string,
  ): Promise<void> {
    const text = (await guest.locator('main').innerText()).trim();
    expect(text.length, `${where}: die Seite ist leer.`).toBeGreaterThan(0);
    expect(
      text,
      `${where}: auf der Seite steht ein roher Platzhalter. Ein „[[…]]" darf ` +
        'die Anwendung nie verlassen — eine fehlende Angabe gehört benannt ' +
        'und markiert, nicht in Klammern durchgereicht.',
    ).not.toMatch(/\[\[[A-Z0-9_]+\]\]/u);
  }

  test('steht unter der Ausfüllansicht und unter der Bestätigungsseite, mit zwei beschrifteten Gruppen', async ({
    page,
    browser,
  }) => {
    const publicPath = await publishedForm(page, 'Fußzeile beim Ausfüllen');

    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);
      await expect(guest.getByLabel(new RegExp(NAME_LABEL, 'u'))).toBeVisible();

      await expectLabelledFooter(guest, 'Ausfüllansicht');
      await expectNoLogin(guest, 'Ausfüllansicht');

      // …and after submitting. „Below **every** public view" expressly means
      // the confirmation page too: that is where somebody looks for the
      // address a withdrawal goes to.
      await guest.getByLabel(new RegExp(NAME_LABEL, 'u')).fill('Anton Aktiv');
      await guest.getByRole('button', { name: 'Absenden' }).click();
      // The shipped default title (`SYSTEM_FORM_SETTINGS.confirmTitle`) —
      // this form changes none of it.
      await expect(
        guest.getByRole('heading', { level: 1, name: 'Vielen Dank!' }),
      ).toBeVisible();

      await expectLabelledFooter(guest, 'Bestätigungsseite');
    } finally {
      await guestContext.close();
    }
  });

  test('/imprint ist ohne Anmeldung erreichbar und sagt, dass nichts hinterlegt ist', async ({
    browser,
  }) => {
    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await guest.goto('/imprint');

      await expect(
        guest.getByRole('heading', { level: 1, name: 'Impressum' }),
        'Ohne Sitzung muss unter /imprint das Impressum stehen und nicht ' +
          'die Anmeldemaske — § 18 Abs. 1 MStV verlangt „ständig verfügbar".',
      ).toBeVisible();
      await expectNoLogin(guest, '/imprint');

      /*
        **The empty page says so.** Not „some text is there": the sentence is
        the difference between a page that stays silent and one that names the
        shortcoming — and it names along with it who is responsible for the
        contents of the forms.
      */
      await expect(
        guest.getByText(
          'Für dieses Angebot sind bislang keine Anbieterangaben hinterlegt.',
        ),
      ).toBeVisible();
      await expectNoRawPlaceholder(guest, '/imprint');

      // And the footer stands below the empty page too — from here somebody
      // finds the details of the organisation they are looking for.
      await expect(
        legalFooter(guest).getByRole('heading', {
          name: 'Betrieb dieser Plattform',
        }),
      ).toBeVisible();
    } finally {
      await guestContext.close();
    }
  });

  test('die Rechtstextseite der Organisation nennt den Mangel, statt einen Ersatztext zu behaupten', async ({
    page,
    browser,
  }) => {
    const publicPath = await publishedForm(page, 'Fußzeile zur Organisation');

    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);

      /*
        Clicked through the link and not through a typed address: the short
        name of the organisation stands in the footer, and that **this** link
        leads to **its** page is the assertion. A
        `/o/DACH/imprint` in the test code would be a second truth about the
        seed and would drift apart with the next `prisma/seed.ts`.
      */
      await legalFooter(guest)
        .getByRole('link', { name: 'Anbieterangaben', exact: true })
        .click();

      await expect(
        guest.getByRole('heading', { level: 1, name: 'Anbieterangaben' }),
      ).toBeVisible();
      await expect(
        guest,
        'Die Rechtstexte einer Organisation liegen unter ihrem Kurznamen ' +
          '(`/o/<kurzname>/…`) und ausdrücklich nicht unter dem Slug eines ' +
          'Formulars: ein Slug ist ein Zugangsmerkmal aus dem CSPRNG, und ein ' +
          'Rechtsdokument unter einer nicht erratbaren Adresse widerspricht ' +
          '„leicht zugänglich" (Art. 12 Abs. 1 DSGVO).',
      ).toHaveURL(/\/o\/[^/]+\/imprint$/u);

      await expectNoLogin(guest, 'Anbieterangaben der Organisation');
      await expect(
        guest.getByText(
          'Für dieses Formular sind bislang keine Anbieterangaben hinterlegt.',
        ),
      ).toBeVisible();
      await expectNoRawPlaceholder(guest, 'Anbieterangaben der Organisation');

      /*
        And the footer carries **both** groups here: the page belongs to an
        organisation, so its label stands up here too — only without the
        name, because this view knows nothing but the short name from the
        address (`LegalPageView` passes `{ shortName }` through without `name`).
      */
      await expectLabelledFooter(guest, 'Anbieterangaben der Organisation', {
        organisationNamed: false,
      });
    } finally {
      await guestContext.close();
    }
  });
});

/**
 * **The four legal pages no browser has visited up to this point**
 * (ADR-0028).
 *
 * ## The gap this block closes
 *
 * Of the addresses in the footer, up to 2026-08-19 exactly **one** was
 * backed by a Playwright case: `/imprint`, and via the link there
 * `/o/<kurzname>/imprint`. The three others — `/privacy`,
 * `/o/<kurzname>/privacy` and `/licences` — stood
 * alone in `apps/api/test/legal/legal-pages.spec.ts`, that is, on the level
 * that measures the *renderer* and not the delivery.
 *
 * „It is the same components with a different template" is exactly the
 * **assumption** this case stands against. It holds for two of the three and
 * expressly not for the third: `/licences` is not a document out of a
 * column but `LicencesView` with two `?raw` imports. A case that only visits
 * `/imprint` would never have seen either the one or the other.
 *
 * ## What is required per page — and why the fourth line is the load-bearing one
 *
 * 1. **the address** (on `/o/<kurzname>/…` as a pattern, because the short name
 *    belongs to the seed and not to this test code),
 * 2. **the heading** — it is the title of the respective template and thus
 *    what a mis-wired route gives away at once: the same component
 *    with the wrong template otherwise looks healthy,
 * 3. **the attribution in the head of the card** — „Betrieb dieser Plattform"
 *    against „Verantwortlich für dieses Formular". That is the information from
 *    Art. 13 Abs. 1 lit. a DSGVO and the only difference that a
 *    mixed-up origin shows at all,
 * 4. **the page's own sentence**: each of the two empty pages names a
 *    **different** shortcoming, and `/licences` names none at all, because
 *    something stands there. This is exactly where this case breaks when two
 *    routes point at the same template — the three other lines would still be
 *    green then.
 *
 * On top of that, for each: no login mask (§ 18 Abs. 1 MStV, „ständig
 * verfügbar") and no raw `[[PLATZHALTER]]`.
 *
 * ## Reproduction
 *
 * Let `systemLegalPageOf` in `@formsache/shared` point from `imprint` to
 * `privacy` — then `/imprint` carries the heading and the sentence of the
 * privacy statement, and this case goes red while every existing one stays
 * green. Or swap the `?raw` import in `LicencesView` for a typed-out line:
 * the line from `LICENSE` is then missing.
 *
 * ## Why here and not in a file of its own
 *
 * For the reason the block above this one writes out: a spec file that stands
 * in no `testMatch` alternation of `playwright.config.ts` does not run
 * and still reports green — the failure
 * `smoke-suite-coverage.spec.ts` is built against.
 */
test.describe('Die übrigen Rechtstextseiten ', () => {
  /**
   * What has to stand on each of the three pages.
   *
   * As a table and not as three typed-out cases: the point is precisely that
   * three addresses yield **three different** pages, and three copies of the
   * same sequence would be three occasions to forget a line on the fourth.
   */
  const PAGES = [
    {
      /** What the link in the footer is called — clicked, not typed. */
      link: 'Datenschutzhinweise',
      address: /\/o\/[^/]+\/privacy$/u,
      heading: 'Datenschutzhinweise',
      /*
        **With a colon and one character behind it.** The head of an
        organisation page names its name (`owner.name` is the `tenant` row
        there and never `null`); which name that is the seed decides
        (`apps/api/prisma/seed.ts`), and a literal here would be the second
        truth about it. Required is „there and not empty" — the same
        distinction that `expectLabelledFooter` above makes for the footer.
      */
      /*
        ⚠️ **Hier weiterhin mit Doppelpunkt.** Der Umbruch aus Review-Runde 3
        Nr. 8 betrifft die **Fußzeile**, wo die Beschriftung versal gesetzter
        Kleindruck ist und ein angehängter Name auf keiner Breite hineinpasst.
        Der Kopf einer Rechtstextseite (`legal__owner`) ist eine gewöhnliche
        Zeile in Laufschrift und behält seine Form.
      */
      owner: /Verantwortlich für dieses Formular\s*:\s*\S/u,
      says: /hat für ihre Formulare noch keine eigenen Datenschutzhinweise hinterlegt\./u,
    },
    {
      link: 'Datenschutz',
      address: '/privacy',
      heading: 'Datenschutzerklärung',
      owner: 'Betrieb dieser Plattform',
      says: 'Für den Betrieb dieser Installation sind bislang keine Datenschutzangaben hinterlegt.',
    },
    {
      link: 'Lizenzen',
      address: '/licences',
      heading: 'Lizenzen und Urheberrecht',
      owner: 'Betrieb dieser Plattform',
      /*
        **The only one of the six pages that says something instead of naming
        a shortcoming** — and the sentence is line 1 of the file `LICENSE` at
        the root of the repository, imported via `?raw`. If it is not there,
        the import has turned into a typed-out copy (ADR-0028 §10: „es *gibt*
        keine zweite Fassung") or `vite build` no longer collected the
        file — exactly the gap this page was meant to close.
      */
      says: 'MIT License',
    },
  ] as const;

  /** The footer, by its name — the same one as in the block above. */
  function legalFooter(guest: Page): Locator {
    return guest.getByRole('navigation', { name: 'Rechtliche Angaben' });
  }

  test('sind ohne Anmeldung erreichbar und sagen jede ihr eigenes', async ({
    page,
    browser,
  }) => {
    const publicPath = await publishedForm(page, 'Fußzeile, alle Seiten');

    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      for (const entry of PAGES) {
        /*
          Back to the form before every pass, because only **its**
          footer carries both groups: a system page belongs to no
          organisation, and `PublicLegalFooter` deliberately leaves that block
          out there. From `/privacy` the link
          „Datenschutzhinweise" would therefore not be there at all any more.
        */
        await guest.goto(publicPath);
        /*
          Jede Seite wird **über die Fußzeile** erreicht, ohne Ausnahme. Die
          eine, die es nicht wurde — die Erklärung zur Barrierefreiheit, deren
          Verweis erst bei hinterlegtem Text erschien —, ist seit
          Review-Runde 4 Nr. 4 ersatzlos gestrichen; mit ihr fiel die
          Fallunterscheidung weg, die hier stand.
        */
        await legalFooter(guest)
          .getByRole('link', { name: entry.link, exact: true })
          .click();

        const where = `„${entry.link}"`;
        await expect(
          guest,
          `${where}: der Link führt woandershin als zugesagt.`,
        ).toHaveURL(
          typeof entry.address === 'string'
            ? new URL(entry.address, webBaseUrl).toString()
            : entry.address,
        );

        await expect(
          guest.getByRole('heading', { level: 1, name: entry.heading }),
          `${where}: die Überschrift stimmt nicht. Sie ist der Titel der ` +
            'Vorlage — steht hier eine andere, zeigt die Route auf die ' +
            'falsche, und das sieht man sonst nirgends.',
        ).toBeVisible();

        /*
          Both assertions **on the card** and not on the page:
          „Betrieb dieser Plattform" stands in the footer too, and an
          unbound assertion would have gone green there while the head of the
          card names the wrong origin.

          `toContainText` on the box and not `getByText` on the element: the
          sentence of an empty page stands in a `<strong>` inside a
          `<p>`, and an assertion on „the element with this text" would depend
          on which of the two Playwright considers the smaller — a
          markup question this case does not want to say anything about.
        */
        const card = guest.getByRole('article');
        await expect(
          card,
          `${where}: der Kopf der Karte schreibt die Seite der falschen ` +
            'Herkunft zu. Wer ein Auskunftsersuchen stellt, liest genau hier, ' +
            'an wen es geht (Art. 13 Abs. 1 lit. a DSGVO).',
        ).toContainText(entry.owner);

        await expect(
          card,
          `${where}: der eigene Satz dieser Seite fehlt. Zeigen zwei Adressen ` +
            'auf dieselbe Vorlage, ist das die Zeile, die es merkt.',
        ).toContainText(entry.says);

        // No trace of a login — the same check as above, and for the
        // same reason: „the page loads" would be true even if the
        // login mask had loaded.
        await expect(
          guest.getByLabel('E-Mail-Adresse'),
          `${where}: hier steht ein Anmeldefeld.`,
        ).toHaveCount(0);
        await expect(
          guest.getByRole('button', { name: 'Anmelden' }),
          `${where}: hier steht ein Anmeldeknopf.`,
        ).toHaveCount(0);

        const text = (await guest.locator('main').innerText()).trim();
        expect(text.length, `${where}: die Seite ist leer.`).toBeGreaterThan(0);
        expect(
          text,
          `${where}: auf der Seite steht ein roher Platzhalter. Ein „[[…]]" ` +
            'darf die Anwendung nie verlassen.',
        ).not.toMatch(/\[\[[A-Z0-9_]+\]\]/u);

        // And the footer stands below this page too — from here somebody
        // finds the remaining five.
        await expect(
          legalFooter(guest).getByRole('heading', {
            name: 'Betrieb dieser Plattform',
          }),
          `${where}: die Fußzeile fehlt. Auf einer Rechtstextseite ist sie der ` +
            'Weg zu den anderen — und der ist es, der den Mangel behebbar macht.',
        ).toBeVisible();
      }
    } finally {
      await guestContext.close();
    }
  });
});
